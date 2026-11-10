//! 定期清理（docs/design/server-slim.md 第 5 节）和后台迁移 `backfill-asset-check-v1`（11.4）的集成测试。
//!
//! 清理的各步用传入的"现在"模拟时间：过期上传和草稿、引用和删除交错的栅栏、用量成对减回、补打
//! `publishedAt`、两个进程抢锁、已下线种类的排队任务每轮被收掉、`heldAssets` 和 `bundleRef` 引用的
//! 资源不被删；迁移中途停止后从游标继续，检查不过的写 `checkError`。

mod ingest_support;
mod runner_support;

use metaverse_api::runner::cleanup::{run_round, RETIRED_MESSAGE};
use metaverse_api::runner::migrations::{
    backfill_batch, BackfillStep, BACKFILL_BATCH, BACKFILL_CHECK,
};
use metaverse_api::runner::Outcome;
use metaverse_core::Timestamp;
use mongodb::bson::{doc, DateTime, Document};
use runner_support::*;

use ingest_support::*;

fn now() -> Timestamp {
    metaverse_api::now().unwrap()
}

fn days(n: i64) -> i64 {
    n * 24 * 3600
}

/// 把资源的上传时间改到 `days` 天前，去掉 `touchedAt`。
async fn age(app: &TestApp, hash: &str, days: i64) {
    let then = DateTime::from_millis(DateTime::now().timestamp_millis() - days * 86_400_000);
    app.collection("assets.files")
        .update_one(
            doc! {"filename": hash},
            doc! {"$set": {"uploadDate": then}, "$unset": {"metadata.touchedAt": ""}},
        )
        .await
        .unwrap();
}

/// 核对通过、计过用量的一份资源（经接口上传、执行器核对）。
async fn verified(app: &TestApp, space: &str, data: &[u8]) -> (String, String) {
    let (upload_id, _) = upload(app, space, "scan", "drc", data).await;
    assert_eq!(
        runner(app, "verifier").run_until_idle().await,
        [Outcome::Done]
    );
    (upload_id, sha256_hex(data))
}

#[tokio::test]
async fn cleanup_retires_jobs_settles_uploads_and_expires_drafts() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let runner = runner(&app, "cleaner-a");
    // 已下线种类：排队中、运行中的标记失败，已完成的不动。
    for (id, kind, status) in [
        ("job_scan", "scan_import", "queued"),
        ("job_voxel", "voxelize", "running"),
        ("job_done", "rebuild", "done"),
    ] {
        app.collection("jobs")
            .insert_one(doc! {
                "_id": id, "spaceId": SPACE, "owner": {"kind": "org", "id": ORG}, "kind": kind,
                "params": {}, "status": status, "attempt": 0, "maxAttempts": 3,
                "createdAt": "2026-01-01T00:00:00.000Z",
            })
            .await
            .unwrap();
    }
    // 租约过期、尝试次数用完的核对任务：标记失败，上传接着收尾。
    let (stuck_upload, stuck_job) = upload(&app, SPACE, "scan", "drc", &draco(2000, 1)).await;
    app.collection("jobs")
        .update_one(
            doc! {"_id": &stuck_job},
            doc! {"$set": {"status": "running", "attempt": 3, "leaseOwner": "gone",
            "leaseUntil": "2000-01-01T00:00:00.000Z",
            "lastError": {"class": "fetch", "message": "超时", "at": "2026-01-01T00:00:00.000Z"}}},
        )
        .await
        .unwrap();
    // 超过 24 小时还 open 的上传、failed 的上传。
    let created = app
        .call(
            who(ORG),
            axum::http::Method::POST,
            &format!("{BASE}/uploads/script"),
            Some(serde_json::json!({"size": 10, "sha256": "c".repeat(64), "partSize": KIB256, "format": "text"})),
        )
        .await;
    let open_upload = created.body["uploadId"].as_str().unwrap().to_owned();
    app.put_bytes(
        who(ORG),
        &format!("{BASE}/uploads/script/{open_upload}/parts/0"),
        b"abcdefghij".to_vec(),
    )
    .await;
    assert_eq!(chunk_count(&app, &open_upload).await, 1);
    // 过期草稿（连同预览令牌、草稿区块）。
    for (id, expires) in [
        ("draft_old", "2000-01-01T00:00:00.000Z"),
        ("draft_new", "2999-01-01T00:00:00.000Z"),
    ] {
        app.collection("drafts")
            .insert_one(doc! {"_id": id, "spaceId": SPACE, "owner": {"kind": "org", "id": ORG}, "expiresAt": expires})
            .await
            .unwrap();
        app.collection("previews")
            .insert_one(doc! {"_id": format!("p_{id}"), "spaceId": SPACE, "draftId": id, "expiresAt": expires})
            .await
            .unwrap();
        app.collection("draftChunks")
            .insert_one(doc! {"_id": format!("c_{id}"), "spaceId": SPACE, "draftId": id, "expiresAt": expires})
            .await
            .unwrap();
    }

    let report = run_round(&runner, "cleaner-a", now().saturating_add_seconds(days(2)))
        .await
        .unwrap();
    assert!(!report.skipped);
    assert_eq!(report.retired_jobs, 2);
    assert_eq!(report.exhausted_jobs, 1);
    assert_eq!(
        (report.drafts, report.previews, report.draft_chunks),
        (1, 1, 1)
    );
    for id in ["job_scan", "job_voxel"] {
        let retired = job(&app, id).await;
        assert_eq!(retired.get_str("status").unwrap(), "failed");
        let error = retired.get_document("lastError").unwrap();
        assert_eq!(error.get_str("class").unwrap(), "content");
        assert_eq!(error.get_str("message").unwrap(), RETIRED_MESSAGE);
    }
    assert_eq!(
        job(&app, "job_done").await.get_str("status").unwrap(),
        "done"
    );
    let reaped = job(&app, &stuck_job).await;
    assert_eq!(reaped.get_str("status").unwrap(), "failed");
    assert_eq!(error_class(&reaped), "fetch", "保留最后一次的类别");
    // 上传先收尾成 failed，同一轮里又因为超过 24 小时连同数据块删掉了。
    assert!(app
        .collection("uploads")
        .find_one(doc! {"_id": &stuck_upload})
        .await
        .unwrap()
        .is_none());
    assert_eq!(chunk_count(&app, &stuck_upload).await, 0);
    // open 的上传过期后连同数据块删除。
    assert!(app
        .collection("uploads")
        .find_one(doc! {"_id": &open_upload})
        .await
        .unwrap()
        .is_none());
    assert_eq!(chunk_count(&app, &open_upload).await, 0);
    assert!(app
        .collection("drafts")
        .find_one(doc! {"_id": "draft_new"})
        .await
        .unwrap()
        .is_some());
    assert!(app
        .collection("previews")
        .find_one(doc! {"_id": "p_draft_old"})
        .await
        .unwrap()
        .is_none());

    // 每轮都收：回滚期间旧接口新建的已下线种类任务，升回来以后也会被收掉。
    app.collection("jobs")
        .insert_one(doc! {
            "_id": "job_model", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "kind": "model_import", "params": {}, "status": "queued", "attempt": 0, "maxAttempts": 3,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    let report = run_round(&runner, "cleaner-a", now()).await.unwrap();
    assert_eq!(report.retired_jobs, 1);
}

#[tokio::test]
async fn unreferenced_assets_are_removed_and_storage_released() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let runner = runner(&app, "cleaner-a");
    let data = draco(3000, 2);
    let (upload_id, hash) = verified(&app, SPACE, &data).await;
    assert_eq!(storage_used(&app, SPACE).await, data.len() as i64);
    // 草稿持有、重建包清单引用的资源都不删。
    let held = draco(1000, 3);
    let (_, held_hash) = verified(&app, SPACE, &held).await;
    let bundle = draco(1000, 4);
    let (_, bundle_hash) = verified(&app, SPACE, &bundle).await;
    let committed = draco(1000, 5);
    let (_, commit_hash) = verified(&app, SPACE, &committed).await;
    app.collection("drafts")
        .insert_one(doc! {"_id": "draft_held", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "heldAssets": [&held_hash], "bundleRef": &bundle_hash, "expiresAt": "2999-01-01T00:00:00.000Z"})
        .await
        .unwrap();
    app.collection("commits")
        .insert_one(
            doc! {"_id": "c_bundle", "spaceId": SPACE, "seq": 99, "bundleRef": &commit_hash,
            "at": "2026-01-01T00:00:00.000Z"},
        )
        .await
        .unwrap();
    for hash in [&hash, &held_hash, &bundle_hash, &commit_hash] {
        age(&app, hash, 8).await;
    }
    // 栅栏：清理查完引用、删除之前被别人刷新了 touchedAt（例如复用上传），就删不掉。
    let grant = app
        .state
        .authorizer
        .system_space(
            SPACE,
            &metaverse_core::model::Owner::org(ORG),
            "test",
            "fence",
        )
        .await
        .unwrap();
    assert!(app.state.repo.touch_asset(&grant, &hash).await.unwrap());
    let report = run_round(&runner, "cleaner-a", now()).await.unwrap();
    assert_eq!(report.assets, 0);
    assert!(files_doc(&app, &hash).await.is_some());
    // 过了宽限期、没人引用：删 files 文档和数据块，用量成对减回（只减一次）。
    age(&app, &hash, 8).await;
    let report = run_round(&runner, "cleaner-a", now()).await.unwrap();
    assert_eq!(report.assets, 1);
    assert_eq!(report.released, 1);
    assert!(files_doc(&app, &hash).await.is_none());
    assert_eq!(chunk_count(&app, &upload_id).await, 0);
    assert!(upload_doc(&app, &upload_id)
        .await
        .get_str("storageReleasedAt")
        .is_ok());
    let remaining = (held.len() + bundle.len() + committed.len()) as i64;
    assert_eq!(storage_used(&app, SPACE).await, remaining);
    let report = run_round(&runner, "cleaner-a", now()).await.unwrap();
    assert_eq!(report.released, 0);
    assert_eq!(storage_used(&app, SPACE).await, remaining);
    for kept in [&held_hash, &bundle_hash, &commit_hash] {
        assert!(files_doc(&app, kept).await.is_some(), "{kept}");
    }
}

#[tokio::test]
async fn only_one_process_cleans_and_published_at_is_backfilled() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let a = runner(&app, "cleaner-a");
    let b = runner(&app, "cleaner-b");
    let at = now();
    app.collection("chunks")
        .insert_one(doc! {"_id": "h".repeat(64), "data": "x"})
        .await
        .unwrap();
    app.collection("commits")
        .insert_one(
            doc! {"_id": "c_recent", "spaceId": SPACE, "seq": 50, "at": at.to_rfc3339(),
            "changedChunks": [{"layer": "ext", "cx": 0, "cy": 0, "cz": 0, "hash": "h".repeat(64)}]},
        )
        .await
        .unwrap();
    let report = run_round(&a, "cleaner-a", at).await.unwrap();
    assert_eq!(report.published_chunks, 1);
    let chunk = app
        .collection("chunks")
        .find_one(doc! {"_id": "h".repeat(64)})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(chunk.get_str("publishedAt").unwrap(), at.to_rfc3339());
    // 另一个进程这时抢不到锁；锁过期以后能抢到。
    let report = run_round(&b, "cleaner-b", at.saturating_add_seconds(60))
        .await
        .unwrap();
    assert!(report.skipped);
    let report = run_round(&b, "cleaner-b", at.saturating_add_seconds(16 * 60))
        .await
        .unwrap();
    assert!(!report.skipped);
    let lock: Document = app
        .collection("migrations")
        .find_one(doc! {"_id": "lock:cleanup"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lock.get_str("owner").unwrap(), "cleaner-b");
}

/// 后台迁移：给旧资源补核对记录；中途停止后从游标继续；检查不过的写 checkError；做完以后跳过。
#[tokio::test]
async fn backfill_resumes_from_its_cursor() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let runner = runner(&app, "migrator-a");
    let total = BACKFILL_BATCH as usize + 5;
    let mut hashes = Vec::new();
    for n in 0..total {
        let bytes = draco(500 + n, n as u8);
        hashes.push(
            app.put_asset(&bytes, doc! {"kind": "scan", "spaceId": SPACE})
                .await,
        );
    }
    // 一份坏的旧网页用模型、一份合格的旧物件模型、一份不在范围里的操作文件。
    let broken = app
        .put_asset(
            b"glTF broken web model",
            doc! {"kind": "web_model", "spaceId": SPACE},
        )
        .await;
    let model = app
        .put_asset(
            &model_glb(0.8),
            doc! {"kind": "model", "sourceHash": "e".repeat(64)},
        )
        .await;
    let ops = app.put_asset(b"{\"op\":1}\n", doc! {"kind": "ops"}).await;
    let step = backfill_batch(&runner, "migrator-a", now()).await.unwrap();
    assert!(matches!(step, BackfillStep::Progress { .. }), "{step:?}");
    let record = app
        .collection("migrations")
        .find_one(doc! {"_id": BACKFILL_CHECK})
        .await
        .unwrap()
        .unwrap();
    let cursor = record.get_str("cursor").unwrap().to_owned();
    // 另一个进程这时抢不到；锁过期以后从游标接着做。
    let other = runner_support::runner(&app, "migrator-b");
    assert_eq!(
        backfill_batch(&other, "migrator-b", now()).await.unwrap(),
        BackfillStep::Skipped
    );
    let later = now().saturating_add_seconds(16 * 60);
    let mut finished = false;
    for _ in 0..5 {
        if backfill_batch(&other, "migrator-b", later).await.unwrap() == BackfillStep::Finished {
            finished = true;
            break;
        }
    }
    assert!(finished);
    let record = app
        .collection("migrations")
        .find_one(doc! {"_id": BACKFILL_CHECK})
        .await
        .unwrap()
        .unwrap();
    assert!(record.get_str("finishedAt").is_ok());
    assert!(record.get_str("cursor").unwrap() > cursor.as_str());
    for hash in &hashes {
        let files = files_doc(&app, hash).await.unwrap();
        let check = files
            .get_document("metadata")
            .unwrap()
            .get_document("check")
            .unwrap();
        assert_eq!(check.get_str("format").unwrap(), "drc");
    }
    let model_check = files_doc(&app, &model).await.unwrap();
    let check = model_check
        .get_document("metadata")
        .unwrap()
        .get_document("check")
        .unwrap();
    assert_eq!(number(check, "triangles"), 1);
    let broken_doc = files_doc(&app, &broken).await.unwrap();
    let metadata = broken_doc.get_document("metadata").unwrap();
    assert!(metadata.get("check").is_none());
    assert!(metadata
        .get_document("checkError")
        .unwrap()
        .get_str("reason")
        .unwrap()
        .contains("glb"));
    let ops_doc = files_doc(&app, &ops).await.unwrap();
    assert!(ops_doc
        .get_document("metadata")
        .unwrap()
        .get("check")
        .is_none());
    // 做完以后直接跳过。
    assert_eq!(
        backfill_batch(&other, "migrator-b", later).await.unwrap(),
        BackfillStep::Finished
    );
}

/// 第 1 步：核对任务已失败、上传还停在 complete 的，按核对的规则收尾；空间换了主人的也标记失败。
#[tokio::test]
async fn stuck_complete_uploads_are_settled() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    front_hall(&app, "back-office").await;
    let runner = runner(&app, "cleaner-a");
    let (stuck, stuck_job) = upload(&app, SPACE, "scan", "drc", &draco(2000, 21)).await;
    let (orphan, orphan_job) = upload(&app, "back-office", "scan", "drc", &draco(2000, 22)).await;
    for job_id in [&stuck_job, &orphan_job] {
        app.collection("jobs")
            .update_one(doc! {"_id": job_id}, doc! {"$set": {"status": "failed"}})
            .await
            .unwrap();
    }
    // 第二个上传所在的空间换了主人（签发不出系统范围）。
    app.collection("spaces")
        .update_one(
            doc! {"_id": "back-office"},
            doc! {"$set": {"owner.id": OTHER_ORG}},
        )
        .await
        .unwrap();
    let report = run_round(&runner, "cleaner-a", now()).await.unwrap();
    assert_eq!(report.stuck_uploads, 2);
    for id in [&stuck, &orphan] {
        let stored = upload_doc(&app, id).await;
        assert_eq!(stored.get_str("status").unwrap(), "failed", "{id}");
        assert_eq!(chunk_count(&app, id).await, 0, "{id}");
    }
}
