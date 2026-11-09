//! 后台执行器（docs/design/server-slim.md 4.2–4.10）的集成测试：真实 MongoDB + 模拟 NyxID。
//!
//! 从处理服务移植的场景：哈希不符、缺片、块大小不对、复用已有资源、并发上传同一内容、空间删了又建、
//! 任务失败后收尾、租约丢失后不写回、两个执行器抢同一个任务只有一个写回、停止时退回队列；另加僵尸
//! 执行器、名额、每个空间同时一个、重试分类、核对期间健康检查的响应时间。

mod ingest_support;
mod runner_support;

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use ingest_support::*;
use metaverse_api::repo::JobDraftSave;
use metaverse_api::runner::{JobFailure, Outcome, SlotClass};
use metaverse_core::model::ErrorClass;
use metaverse_core::Timestamp;
use mongodb::bson::doc;
use runner_support::*;
use serde_json::json;

fn now() -> Timestamp {
    metaverse_api::now().unwrap()
}

fn vector(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../metaverse-core/tests/vectors/check")
            .join(name),
    )
    .unwrap()
}

#[tokio::test]
async fn verification_registers_the_asset_with_its_check() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let glb = model_glb(1.0);
    let sha = sha256_hex(&glb);
    let (upload_id, job_id) = upload(&app, SPACE, "model", "glb", &glb).await;
    assert_eq!(
        job(&app, &job_id).await.get_str("status").unwrap(),
        "queued"
    );
    let outcomes = runner(&app, "runner-a").run_until_idle().await;
    assert_eq!(outcomes, [Outcome::Done]);

    let stored = upload_doc(&app, &upload_id).await;
    assert_eq!(stored.get_str("status").unwrap(), "done");
    assert_eq!(stored.get_str("assetHash").unwrap(), sha);
    assert_eq!(stored.get_str("format").unwrap(), "glb");
    assert_eq!(number(&stored, "storageBytes"), glb.len() as i64);
    let files = files_doc(&app, &sha).await.unwrap();
    assert_eq!(files.get_str("_id").unwrap(), upload_id);
    let check = files
        .get_document("metadata")
        .unwrap()
        .get_document("check")
        .unwrap();
    assert_eq!(check.get_str("format").unwrap(), "glb");
    assert_eq!(number(check, "triangles"), 1);
    assert_eq!(storage_used(&app, SPACE).await, glb.len() as i64);
    let finished = job(&app, &job_id).await;
    assert_eq!(finished.get_str("status").unwrap(), "done");
    assert_eq!(finished.get_str("leaseOwner").unwrap(), "runner-a");
    assert_eq!(
        finished
            .get_document("result")
            .unwrap()
            .get_str("assetHash")
            .unwrap(),
        sha
    );
    // 本空间已经拥有、核对记录合乎用途：再创建同一哈希的上传直接复用。
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{BASE}/uploads/model"),
            Some(json!({"size": glb.len(), "sha256": sha, "partSize": KIB256, "format": "glb"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["reused"], true);
    // 用途不合（物件模型的核对记录不是贴图）：照常要求完整上传。
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{BASE}/uploads/script"),
            Some(json!({"size": glb.len(), "sha256": sha, "partSize": KIB256, "format": "text"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["reused"], false);
    // 任务视图带错误类别字段（成功时没有）。
    let reply = app
        .call(
            who(ORG),
            Method::GET,
            &format!("{BASE}/jobs/{job_id}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["status"], "done");
    assert!(reply.body.get("errorClass").is_none());
}

/// 内容不合格：上传 failed、数据块删除、任务失败（content，不重试），用量不变。
#[tokio::test]
async fn bad_content_fails_the_upload_without_retry() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let runner = runner(&app, "runner-a");
    let check_failed = |code: &'static str| {
        let app = &app;
        let runner = runner.clone();
        move |upload_id: String, job_id: String| async move {
            let outcomes = runner.run_until_idle().await;
            assert_eq!(outcomes, [Outcome::Failed(ErrorClass::Content)], "{code}");
            let stored = upload_doc(app, &upload_id).await;
            assert_eq!(stored.get_str("status").unwrap(), "failed", "{code}");
            assert!(
                stored.get_str("error").unwrap().contains(code),
                "{code}: {stored:?}"
            );
            assert_eq!(chunk_count(app, &upload_id).await, 0, "{code}");
            let failed = job(app, &job_id).await;
            assert_eq!(failed.get_str("status").unwrap(), "failed");
            assert_eq!(error_class(&failed), "content");
            assert_eq!(number(&failed, "attempt"), 1);
        }
    };
    // 哈希不符。
    let data = draco(KIB256 + 10, 1);
    let (id, job_id) = upload_declared(&app, SPACE, "scan", "drc", &data, &"a".repeat(64)).await;
    check_failed("hash_mismatch")(id, job_id).await;
    // 声明的包围盒与数据不符。
    let (id, job_id) = upload(
        &app,
        SPACE,
        "model",
        "glb",
        &vector("glb_bounds_mismatch.glb"),
    )
    .await;
    check_failed("glb_bounds_mismatch")(id, job_id).await;
    // 缺片：完成以后数据块少了一块。
    let data = draco(KIB256 * 2 + 10, 2);
    let (id, job_id) = upload(&app, SPACE, "scan", "drc", &data).await;
    app.collection("assets.chunks")
        .delete_one(doc! {"files_id": &id, "n": 1})
        .await
        .unwrap();
    check_failed("chunk_layout")(id, job_id).await;
    // 块大小不对。
    let data = draco(KIB256 * 2 + 10, 3);
    let (id, job_id) = upload(&app, SPACE, "scan", "drc", &data).await;
    app.collection("assets.chunks")
        .update_one(
            doc! {"files_id": &id, "n": 0},
            doc! {"$set": {"data": mongodb::bson::Binary {
            subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![1, 2, 3] }}},
        )
        .await
        .unwrap();
    check_failed("chunk_layout")(id, job_id).await;
    // 宽高在第 0 片之后的 JPEG：第 0 片放行，后台核对按上限拒绝。
    let mut jpeg = vec![0xff, 0xd8];
    for _ in 0..5 {
        jpeg.extend_from_slice(&[0xff, 0xe1, 0xff, 0xff]);
        jpeg.extend(std::iter::repeat_n(0u8, 65533));
    }
    jpeg.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08, 0x1f, 0x40, 0x1f, 0x40]);
    jpeg.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    let (id, job_id) = upload(&app, SPACE, "texture", "jpeg", &jpeg).await;
    check_failed("over_limit")(id, job_id).await;
    assert_eq!(storage_used(&app, SPACE).await, 0);
}

/// 同一内容在两个空间、同一空间并发上传：都完成，第一份登记、其余复用（删掉自己的数据块），
/// 用量各自计入。
#[tokio::test]
async fn identical_content_is_reused_across_uploads() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    front_hall(&app, "back-office").await;
    let data = draco(KIB256 * 3, 7);
    let sha = sha256_hex(&data);
    let (first, _) = upload(&app, SPACE, "scan", "drc", &data).await;
    let (second, _) = upload(&app, "back-office", "scan", "drc", &data).await;
    // 同一空间的两个上传会话在核对之前都完成了。
    let (third, _) = upload(&app, SPACE, "scan", "drc", &data).await;
    let outcomes = runner(&app, "runner-a").run_until_idle().await;
    assert_eq!(outcomes, [Outcome::Done; 3]);
    for id in [&first, &second, &third] {
        assert_eq!(
            upload_doc(&app, id).await.get_str("status").unwrap(),
            "done"
        );
    }
    let files = files_doc(&app, &sha).await.unwrap();
    assert_eq!(files.get_str("_id").unwrap(), first);
    assert_eq!(chunk_count(&app, &first).await, 3);
    assert_eq!(chunk_count(&app, &second).await, 0);
    assert_eq!(chunk_count(&app, &third).await, 0);
    assert_eq!(storage_used(&app, SPACE).await, 2 * data.len() as i64);
    assert_eq!(storage_used(&app, "back-office").await, data.len() as i64);
}

/// 上传之后空间被删除又用同一个编号重建：不登记、不计用量，上传 failed。
#[tokio::test]
async fn recreated_space_does_not_receive_old_uploads() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let data = draco(1000, 4);
    let (id, job_id) = upload(&app, SPACE, "scan", "drc", &data).await;
    app.collection("spaces")
        .update_one(
            doc! {"_id": SPACE},
            doc! {"$set": {"createdAt": "2999-01-01T00:00:00.000Z"}},
        )
        .await
        .unwrap();
    let outcomes = runner(&app, "runner-a").run_until_idle().await;
    assert_eq!(outcomes, [Outcome::Failed(ErrorClass::Content)]);
    assert_eq!(
        upload_doc(&app, &id).await.get_str("status").unwrap(),
        "failed"
    );
    assert!(files_doc(&app, &sha256_hex(&data)).await.is_none());
    assert_eq!(chunk_count(&app, &id).await, 0);
    assert_eq!(error_class(&job(&app, &job_id).await), "content");
    assert_eq!(storage_used(&app, SPACE).await, 0);
}

/// 重试分类：transient、fetch 按退避退回队列；用完以后失败并收尾上传；content 直接失败。
#[tokio::test]
async fn retries_back_off_and_exhausted_jobs_settle_the_upload() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let runner = runner(&app, "runner-a");
    let data = draco(1000, 5);
    let (upload_id, job_id) = upload(&app, SPACE, "scan", "drc", &data).await;
    let start = now();
    let lease = runner
        .claim(SlotClass::Verify, start)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.job.attempt, 1);
    let outcome = runner
        .settle(&lease, Err(JobFailure::Transient("数据库抖动".into())))
        .await;
    assert_eq!(outcome, Outcome::Retrying(ErrorClass::Transient));
    let queued = job(&app, &job_id).await;
    assert_eq!(queued.get_str("status").unwrap(), "queued");
    assert_eq!(error_class(&queued), "transient");
    let not_before = Timestamp::parse_rfc3339(queued.get_str("notBefore").unwrap()).unwrap();
    assert!(
        (not_before.millis_since(start) - 30_000).abs() < 5_000,
        "{queued:?}"
    );
    // 退避时间没到：领不到。
    assert!(runner
        .claim(SlotClass::Verify, now())
        .await
        .unwrap()
        .is_none());
    let later = start.saturating_add_seconds(31);
    let lease = runner
        .claim(SlotClass::Verify, later)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.job.attempt, 2);
    let outcome = runner
        .settle(&lease, Err(JobFailure::Fetch("下载 429".into())))
        .await;
    assert_eq!(outcome, Outcome::Retrying(ErrorClass::Fetch));
    let queued = job(&app, &job_id).await;
    let not_before = Timestamp::parse_rfc3339(queued.get_str("notBefore").unwrap()).unwrap();
    assert!(not_before.millis_since(now()) > 50_000, "第二次退避 60 秒");
    let lease = runner
        .claim(SlotClass::Verify, start.saturating_add_seconds(200))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.job.attempt, 3);
    // 第三次（最后一次）还失败：标记失败，上传离开 complete、数据块删除。
    let outcome = runner
        .settle(&lease, Err(JobFailure::Transient("数据库抖动".into())))
        .await;
    assert_eq!(outcome, Outcome::Failed(ErrorClass::Transient));
    let failed = job(&app, &job_id).await;
    assert_eq!(failed.get_str("status").unwrap(), "failed");
    assert_eq!(error_class(&failed), "transient");
    let stored = upload_doc(&app, &upload_id).await;
    assert_eq!(stored.get_str("status").unwrap(), "failed");
    assert_eq!(chunk_count(&app, &upload_id).await, 0);

    // 内容类错误不重试。
    let (_, job_id) = upload(&app, SPACE, "scan", "drc", &draco(1000, 6)).await;
    let lease = runner
        .claim(SlotClass::Verify, now())
        .await
        .unwrap()
        .unwrap();
    let outcome = runner
        .settle(&lease, Err(JobFailure::Content("参数不对".into())))
        .await;
    assert_eq!(outcome, Outcome::Failed(ErrorClass::Content));
    assert_eq!(
        job(&app, &job_id).await.get_str("status").unwrap(),
        "failed"
    );
}

/// 任务最终失败时，内容已核对通过、资源也在的上传补做完成（复用已有资源）。
#[tokio::test]
async fn failed_job_with_verified_content_finishes_the_upload() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    front_hall(&app, "back-office").await;
    let runner = runner(&app, "runner-a");
    let data = draco(5000, 8);
    // 别的空间先登记了同一内容（本空间不拥有它，照常完整上传）。
    let (_, _) = upload(&app, "back-office", "scan", "drc", &data).await;
    assert_eq!(runner.run_until_idle().await, [Outcome::Done]);
    // 本空间上传同一内容：内容已核对通过（verifiedSha256），任务随后失败。
    let (second, _) = upload(&app, SPACE, "scan", "drc", &data).await;
    app.collection("uploads")
        .update_one(
            doc! {"_id": &second},
            doc! {"$set": {"verifiedSha256": sha256_hex(&data)}},
        )
        .await
        .unwrap();
    let mut lease = runner
        .claim(SlotClass::Verify, now())
        .await
        .unwrap()
        .unwrap();
    lease.job.max_attempts = 1;
    let outcome = runner
        .settle(&lease, Err(JobFailure::Transient("进程退出".into())))
        .await;
    assert_eq!(outcome, Outcome::Failed(ErrorClass::Transient));
    let stored = upload_doc(&app, &second).await;
    assert_eq!(stored.get_str("status").unwrap(), "done");
    assert_eq!(chunk_count(&app, &second).await, 0);
    assert_eq!(storage_used(&app, SPACE).await, data.len() as i64);
}

/// 两个执行器抢同一个任务只有一个领到；租约过期后被别人领走，原来的执行器什么都写不进去。
#[tokio::test]
async fn lost_lease_writes_nothing() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let a = runner(&app, "runner-a");
    let b = runner(&app, "runner-b");
    let data = draco(KIB256 + 3, 9);
    let (upload_id, job_id) = upload(&app, SPACE, "scan", "drc", &data).await;
    let lease_a = a.claim(SlotClass::Verify, now()).await.unwrap().unwrap();
    assert!(b.claim(SlotClass::Verify, now()).await.unwrap().is_none());
    expire_lease(&app, &job_id).await;
    let lease_b = b.claim(SlotClass::Verify, now()).await.unwrap().unwrap();
    assert_eq!(lease_b.job.attempt, 2);
    // A 照样做完了核对，但写不进去。
    assert_eq!(a.execute(lease_a).await, Outcome::LeaseLost);
    let stored = upload_doc(&app, &upload_id).await;
    assert_eq!(stored.get_str("status").unwrap(), "complete");
    assert!(stored.get("verifiedSha256").is_none());
    assert!(files_doc(&app, &sha256_hex(&data)).await.is_none());
    assert_eq!(b.execute(lease_b).await, Outcome::Done);
    let finished = job(&app, &job_id).await;
    assert_eq!(finished.get_str("status").unwrap(), "done");
    assert_eq!(finished.get_str("leaseOwner").unwrap(), "runner-b");
    assert_eq!(storage_used(&app, SPACE).await, data.len() as i64);
}

/// 停止时手上没做完的任务退回队列，退还这一次的尝试次数。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_requeues_unfinished_jobs() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let runner = runner(&app, "runner-a");
    let data = draco(24 << 20, 10);
    let (upload_id, job_id) = upload(&app, SPACE, "scan", "drc", &data).await;
    let lease = runner
        .claim(SlotClass::Verify, now())
        .await
        .unwrap()
        .unwrap();
    let task = tokio::spawn({
        let runner = runner.clone();
        async move { runner.execute(lease).await }
    });
    while runner.running_jobs() == 0 {
        tokio::task::yield_now().await;
    }
    runner.drain(Duration::ZERO).await;
    assert_eq!(task.await.unwrap(), Outcome::Stopped);
    let queued = job(&app, &job_id).await;
    assert_eq!(queued.get_str("status").unwrap(), "queued");
    assert_eq!(number(&queued, "attempt"), 0);
    assert!(queued.get("leaseOwner").is_none());
    assert_eq!(
        upload_doc(&app, &upload_id)
            .await
            .get_str("status")
            .unwrap(),
        "complete"
    );
    // 别的执行器接着做完。
    assert_eq!(super_runner(&app).run_until_idle().await, [Outcome::Done]);
}

fn super_runner(app: &TestApp) -> std::sync::Arc<metaverse_api::runner::Runner> {
    runner(app, "runner-b")
}

/// 每个空间同时一个任务；两类名额分开领，重任务排着队时核对照样能领到。
#[tokio::test]
async fn one_job_per_space_and_separate_slots() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    front_hall(&app, "back-office").await;
    let runner = runner(&app, "runner-a");
    // 两个重任务先排上队（别的空间）。
    for n in 0..2 {
        app.collection("jobs")
            .insert_one(doc! {
                "_id": format!("job_heavy_{n}"), "spaceId": "back-office",
                "owner": {"kind": "org", "id": ORG}, "kind": "ops_from_upload",
                "params": {"draftId": "missing", "assetHash": "a".repeat(64)},
                "status": "queued", "attempt": 0, "maxAttempts": 2,
                "createdAt": "2020-01-01T00:00:00.000Z",
            })
            .await
            .unwrap();
    }
    let (_, first) = upload(&app, SPACE, "scan", "drc", &draco(1000, 11)).await;
    let (_, second) = upload(&app, SPACE, "scan", "drc", &draco(1000, 12)).await;
    let lease = runner
        .claim(SlotClass::Verify, now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.job.id, first);
    // 同一空间的第二个任务等第一个做完。
    assert!(runner
        .claim(SlotClass::Verify, now())
        .await
        .unwrap()
        .is_none());
    assert_eq!(runner.execute(lease).await, Outcome::Done);
    let lease = runner
        .claim(SlotClass::Verify, now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.job.id, second);
    assert_eq!(runner.execute(lease).await, Outcome::Done);
    // 重任务按自己的类别领。
    let heavy = runner
        .claim(SlotClass::Heavy, now())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(heavy.job.id, "job_heavy_0");
    assert!(
        runner
            .claim(SlotClass::Heavy, now())
            .await
            .unwrap()
            .is_none(),
        "同一空间"
    );
}

/// 僵尸执行器：A 的租约过期后 B 领取，A 再写草稿和完成任务都写不进去、草稿不变；B 正常完成；
/// 任务被再次领取时按草稿里的任务编号认出已经做过，不会追加两次。
#[tokio::test]
async fn zombie_ops_job_cannot_write_the_draft() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let ops = format!(
        "{}\n{}\n",
        json!({"op": "fill", "box": [0, 0, 0, 2, 1, 2], "block": 2}),
        json!({"op": "fill", "box": [4, 0, 4, 5, 1, 5], "block": 3}),
    );
    let (ops_upload, _) = upload(&app, SPACE, "ops", "ndjson", ops.as_bytes()).await;
    assert_eq!(
        runner(&app, "verifier").run_until_idle().await,
        [Outcome::Done]
    );
    let reply = app
        .call(who(ORG), Method::POST, &format!("{BASE}/drafts"), None)
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let draft_id = reply.body["id"].as_str().unwrap().to_owned();
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{BASE}/drafts/{draft_id}/ops-from-upload"),
            Some(json!({"uploadId": ops_upload})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    assert_eq!(reply.body["status"], "queued");
    let job_id = reply.body["jobId"].as_str().unwrap().to_owned();

    let a = runner(&app, "runner-a");
    let b = runner(&app, "runner-b");
    let lease_a = a.claim(SlotClass::Heavy, now()).await.unwrap().unwrap();
    expire_lease(&app, &job_id).await;
    let lease_b = b.claim(SlotClass::Heavy, now()).await.unwrap().unwrap();
    // A 直接拿算好的草稿去保存：事务中止，草稿不变。
    let grant = app
        .state
        .authorizer
        .system_space(SPACE, &lease_a.job.owner, "test", &job_id)
        .await
        .unwrap();
    let draft = app
        .state
        .repo
        .draft(&grant, &draft_id)
        .await
        .unwrap()
        .unwrap();
    let prepared = metaverse_api::timeline::drafts::prepare_append(
        &app.state.repo,
        &grant,
        draft,
        vec![serde_json::from_value(
            json!({"op": "fill", "box": [9, 0, 9, 10, 1, 10], "block": 2}),
        )
        .unwrap()],
        metaverse_api::timeline::drafts::OpsSource::Upload {
            asset_hash: sha256_hex(ops.as_bytes()),
            job_id: job_id.clone(),
        },
        now(),
    )
    .await
    .unwrap();
    let saved = app
        .state
        .repo
        .save_draft_for_job(
            &grant,
            &prepared.draft,
            prepared.expected_rev,
            &lease_a.fence,
            &json!({}),
            now(),
        )
        .await
        .unwrap();
    assert_eq!(saved, JobDraftSave::LeaseLost);
    // A 照常执行也写不进去。
    assert_eq!(a.execute(lease_a).await, Outcome::LeaseLost);
    let draft = app
        .state
        .repo
        .draft(&grant, &draft_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.rev, 0);
    assert!(draft.ops_refs.is_empty());
    // B 正常完成。
    assert_eq!(b.execute(lease_b).await, Outcome::Done);
    let draft = app
        .state
        .repo
        .draft(&grant, &draft_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.rev, 1);
    assert_eq!(draft.ops_refs.len(), 1);
    assert_eq!(draft.ops_refs[0].job_id.as_deref(), Some(job_id.as_str()));
    let done = job(&app, &job_id).await;
    assert_eq!(done.get_str("status").unwrap(), "done");
    let progress = done.get_document("progress").unwrap();
    assert_eq!(
        (number(progress, "opsApplied"), number(progress, "opsTotal")),
        (2, 2)
    );
    // 再被领取一次（例如写完以后还没来得及确认就退出了）：认出已经做过。
    app.collection("jobs")
        .update_one(
            doc! {"_id": &job_id},
            doc! {"$set": {"status": "running", "attempt": 1, "leaseOwner": "gone",
            "leaseUntil": "2000-01-01T00:00:00.000Z"}},
        )
        .await
        .unwrap();
    assert_eq!(
        runner(&app, "runner-c").run_until_idle().await,
        [Outcome::Done]
    );
    let draft = app
        .state
        .repo
        .draft(&grant, &draft_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.rev, 1);
    assert_eq!(draft.ops_refs.len(), 1);
}

/// 核对期间 `/api/healthz` 照样很快（计算都在阻塞线程池里）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_stays_fast_while_verifying() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let data = draco(32 << 20, 13);
    let (upload_id, _) = upload(&app, SPACE, "scan", "drc", &data).await;
    let runner = runner(&app, "runner-a");
    let task = tokio::spawn({
        let runner = runner.clone();
        async move { runner.run_until_idle().await }
    });
    let mut slowest = Duration::ZERO;
    let mut probes = 0;
    while !task.is_finished() {
        let started = Instant::now();
        let reply = app.public("/api/healthz", None, &[]).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.body, json!({"status": "ok"}));
        slowest = slowest.max(started.elapsed());
        probes += 1;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(task.await.unwrap(), [Outcome::Done]);
    assert_eq!(
        upload_doc(&app, &upload_id)
            .await
            .get_str("status")
            .unwrap(),
        "done"
    );
    eprintln!("核对 32 MiB 期间健康检查 {probes} 次，最慢 {slowest:?}");
    assert!(
        probes > 0 && slowest < Duration::from_secs(1),
        "{slowest:?}"
    );
}
