//! 分片上传、任务查询和已下线接口的集成测试（真实 MongoDB + 模拟 NyxID）。

mod ingest_support;

use axum::http::{Method, StatusCode};
use futures_util::TryStreamExt;
use ingest_support::*;
use mongodb::bson::{doc, Bson, Document};
use serde_json::{json, Value};

const KIB256: usize = 256 * 1024;

/// 一个 Draco 扫描文件：`DRACO` 开头，大小 = 256KiB + 100。
fn draco_bytes() -> Vec<u8> {
    let mut bytes = b"DRACO\x02\x02".to_vec();
    bytes.extend((0..KIB256 + 100 - 7).map(|i| (i % 251) as u8));
    bytes
}

async fn front_hall(app: &TestApp) -> String {
    let token = app
        .create_space(who(ORG), "front-hall", "org", ORG, "unlisted")
        .await;
    app.set_layout(
        "front-hall",
        json!([
            {"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 100, 60, 100]]},
            {"id": "garden", "kind": "virtual", "boxes": [[100, 0, 0, 200, 60, 100]]}
        ]),
        json!([{"id": "p1", "regionId": "garden", "boxes": [[100, 0, 0, 120, 20, 20]]}]),
    )
    .await;
    token
}

async fn create_upload(
    app: &TestApp,
    caller: Who<'_>,
    base: &str,
    purpose: &str,
    body: Value,
) -> Reply {
    app.call(
        caller,
        Method::POST,
        &format!("{base}/uploads/{purpose}"),
        Some(body),
    )
    .await
}

async fn chunks_of(app: &TestApp, upload_id: &str) -> Vec<Document> {
    app.collection("assets.chunks")
        .find(doc! {"files_id": upload_id})
        .sort(doc! {"n": 1})
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap()
}

#[tokio::test]
async fn chunked_upload_writes_gridfs_chunks_and_queues_verification() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app).await;
    let data = draco_bytes();
    let sha = sha256_hex(&data);
    // 扫描只经重建路径上传（要重建权限）。
    let base = "/api/v1/spaces/front-hall/rebuild";
    let created = create_upload(
        &app,
        rebuilder(ORG),
        base,
        "scan",
        json!({"totalSize": data.len(), "sha256": sha, "partSize": KIB256, "format": "drc"}),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    let upload_id = created.body["uploadId"].as_str().unwrap().to_owned();
    assert_eq!(created.body["status"], "open");
    assert_eq!(created.body["partCount"], 2);
    assert_eq!(created.body["missingParts"], json!([0, 1]));
    assert_eq!(created.body["declaredFormat"], "drc");
    assert_eq!(created.body["size"], data.len());
    assert_eq!(
        created.headers.get("location").unwrap(),
        &format!("{base}/uploads/scan/{upload_id}")
    );
    let part = |n: u64| format!("{base}/uploads/scan/{upload_id}/parts/{n}");

    // 先传最后一片；这时完成会被拒（还缺第 0 片）。
    let reply = app
        .put_bytes(rebuilder(ORG), &part(1), data[KIB256..].to_vec())
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["size"], 100);
    assert_eq!(reply.body["sha256"], sha256_hex(&data[KIB256..]));
    let complete = format!("{base}/uploads/scan/{upload_id}/complete");
    let reply = app
        .call(rebuilder(ORG), Method::POST, &complete, None)
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.body["code"], "upload_incomplete");

    // 片号越界、长度不对、超过声明的大小、文件头不符。
    let reply = app.put_bytes(rebuilder(ORG), &part(2), vec![0; 10]).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "invalid_part_number");
    let reply = app.put_bytes(rebuilder(ORG), &part(0), vec![0; 10]).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "part_size_mismatch");
    let reply = app.put_bytes(rebuilder(ORG), &part(1), vec![0; 101]).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    let reply = app
        .put_bytes(rebuilder(ORG), &part(0), vec![b'x'; KIB256])
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "format_mismatch");

    // 第 0 片传两次（重传幂等）。
    for _ in 0..2 {
        let reply = app
            .put_bytes(rebuilder(ORG), &part(0), data[..KIB256].to_vec())
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    // 数据块布局与处理服务 write_upload_part 一致：files_id = 上传编号，256KiB 一块，序号按片号推算。
    let chunks = chunks_of(&app, &upload_id).await;
    assert_eq!(chunks.len(), 2);
    let mut joined = Vec::new();
    for (n, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.get_i32("n").unwrap(), n as i32);
        assert_eq!(chunk.get_str("files_id").unwrap(), upload_id);
        let Some(Bson::Binary(binary)) = chunk.get("data") else {
            panic!("data 不是二进制");
        };
        joined.extend_from_slice(&binary.bytes);
    }
    assert_eq!(joined.len(), data.len());
    assert_eq!(sha256_hex(&joined), sha);

    // 完成：202 + upload_verify 任务。
    let reply = app
        .call(rebuilder(ORG), Method::POST, &complete, None)
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    let job_id = reply.body["jobId"].as_str().unwrap().to_owned();
    assert_eq!(reply.body["status"], "complete");
    // 重复完成返回同一个任务。
    let again = app
        .call(rebuilder(ORG), Method::POST, &complete, None)
        .await;
    assert_eq!(again.status, StatusCode::ACCEPTED);
    assert_eq!(again.body["jobId"], job_id.as_str());
    // 完成之后不再接收分片。
    let reply = app
        .put_bytes(rebuilder(ORG), &part(1), data[KIB256..].to_vec())
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);

    // 任务文档（处理服务按这些字段领取）。
    let job = app
        .collection("jobs")
        .find_one(doc! {"_id": &job_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.get_str("kind").unwrap(), "upload_verify");
    assert_eq!(job.get_str("status").unwrap(), "queued");
    assert_eq!(job.get_str("spaceId").unwrap(), "front-hall");
    assert_eq!(
        job.get_document("params").unwrap(),
        &doc! {"uploadId": &upload_id}
    );
    assert_eq!(
        job.get_document("owner").unwrap(),
        &doc! {"kind": "org", "id": ORG}
    );
    assert_eq!(
        job.get_document("actor").unwrap(),
        &doc! {"sub": ORG, "nyxServiceId": SERVICE}
    );
    assert_eq!(job.get_str("scope").unwrap(), "rebuild");
    assert!(job.get_str("createdAt").unwrap().ends_with('Z'));
    assert!(matches!(
        job.get("attempt"),
        Some(Bson::Int64(0) | Bson::Int32(0))
    ));
    assert!(matches!(
        job.get("maxAttempts"),
        Some(Bson::Int64(3) | Bson::Int32(3))
    ));
    // 上传文档。
    let upload = app
        .collection("uploads")
        .find_one(doc! {"_id": &upload_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(upload.get_str("status").unwrap(), "complete");
    assert_eq!(upload.get_str("jobId").unwrap(), job_id);
    assert_eq!(upload.get_str("purpose").unwrap(), "scan");
    assert_eq!(upload.get_str("declaredFormat").unwrap(), "drc");
    assert_eq!(upload.get_str("sha256").unwrap(), sha);
    // 处理服务读的是 size（声明的总字节数）。
    assert_eq!(upload.get_i64("size").unwrap(), data.len() as i64);
    assert!(upload.get("totalSize").is_none());

    // 查询任务和上传状态。
    let reply = app
        .call(
            rebuilder(ORG),
            Method::GET,
            &format!("{base}/jobs/{job_id}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["kind"], "upload_verify");
    assert_eq!(reply.body["status"], "queued");
    let reply = app
        .call(
            rebuilder(ORG),
            Method::GET,
            &format!("{base}/uploads/scan/{upload_id}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["status"], "complete");
    assert_eq!(reply.body["receivedBytes"], data.len());

    // 处理服务校验通过后，查询能看到它写回的格式；同一哈希再上传就直接复用。
    app.finish_upload(&upload_id, &sha, data.len() as i64).await;
    let reply = app
        .call(
            rebuilder(ORG),
            Method::GET,
            &format!("{base}/uploads/scan/{upload_id}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["status"], "done");
    assert_eq!(reply.body["assetHash"], sha.as_str());
    assert_eq!(reply.body["format"], "draco");
    assert_eq!(reply.body["contentType"], "application/x-draco");
    let reused = create_upload(
        &app,
        rebuilder(ORG),
        base,
        "scan",
        json!({"size": data.len(), "sha256": sha, "partSize": KIB256, "format": "drc"}),
    )
    .await;
    assert_eq!(reused.status, StatusCode::CREATED, "{:?}", reused.body);
    assert_eq!(reused.body["status"], "done");
    assert_eq!(reused.body["reused"], true);
    assert_eq!(reused.body["assetHash"], sha.as_str());
    // 复用时刷新了资源的 touchedAt（处理服务清理时据此计算宽限期）。
    let file = app
        .collection("assets.files")
        .find_one(doc! {"filename": &sha})
        .await
        .unwrap()
        .unwrap();
    assert!(file
        .get_document("metadata")
        .unwrap()
        .get_datetime("touchedAt")
        .is_ok());
    // 大小对不上的复用被拒。
    let reply = create_upload(
        &app,
        rebuilder(ORG),
        base,
        "scan",
        json!({"size": 5, "sha256": sha, "partSize": KIB256, "format": "drc"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn upload_rules_scope_and_access() {
    let Some(app) = TestApp::start(&[("UPLOAD_MAX_OPEN_PER_SPACE", "3")]).await else {
        return;
    };
    front_hall(&app).await;
    let base = "/api/v1/spaces/front-hall";
    let sha = sha256_hex(b"something");
    let body = |size: u64, part: u64, format: &str| json!({"size": size, "sha256": sha, "partSize": part, "format": format});
    // 实体区、地块路径不能上传扫描（改经重建路径，422）；地块路径可以上传物件模型；不存在的地块 404。
    for path in [base.to_owned(), format!("{base}/plots/p1")] {
        let reply = create_upload(&app, who(ORG), &path, "scan", body(10, 262144, "glb")).await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{path}: {:?}",
            reply.body
        );
        assert_eq!(reply.body["code"], "purpose_not_allowed");
        assert!(reply.body["detail"]
            .as_str()
            .unwrap()
            .contains("/rebuild/uploads/scan"));
    }
    let reply = create_upload(
        &app,
        who(ORG),
        &format!("{base}/plots/p1"),
        "model",
        body(10, 262144, "glb"),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["scope"], "plot:p1");
    let plot_upload = reply.body["uploadId"].as_str().unwrap().to_owned();
    let reply = create_upload(
        &app,
        who(ORG),
        &format!("{base}/plots/p9"),
        "model",
        body(10, 262144, "glb"),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // 经实体区路径看不到地块路径创建的上传。
    let reply = app
        .call(
            who(ORG),
            Method::GET,
            &format!("{base}/uploads/model/{plot_upload}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app
        .call(
            who(ORG),
            Method::GET,
            &format!("{base}/plots/p1/uploads/model/{plot_upload}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    // glb 第 0 片：文件头里的总长度必须等于声明的大小。
    let mut glb = b"glTF".to_vec();
    glb.extend_from_slice(&2u32.to_le_bytes());
    glb.extend_from_slice(&11u32.to_le_bytes());
    let reply = app
        .put_bytes(
            who(ORG),
            &format!("{base}/plots/p1/uploads/model/{plot_upload}/parts/0"),
            {
                let mut wrong = glb.clone();
                wrong.truncate(10);
                wrong
            },
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);

    // 参数校验：未知用途、格式不允许、分片大小不对、超过大小上限。
    let reply = create_upload(&app, who(ORG), base, "exe", body(10, 262144, "glb")).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = create_upload(&app, who(ORG), base, "texture", body(10, 262144, "glb")).await;
    assert_eq!(reply.body["code"], "unsupported_format");
    let reply = create_upload(&app, who(ORG), base, "model", body(10, 1000, "glb")).await;
    assert_eq!(reply.body["code"], "invalid_part_size");
    let reply = create_upload(&app, who(ORG), base, "model", body(10, 64 << 20, "glb")).await;
    assert_eq!(reply.body["code"], "invalid_part_size");
    let reply = create_upload(
        &app,
        who(ORG),
        base,
        "model",
        body(51 << 20, 8 << 20, "glb"),
    )
    .await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.body["code"], "upload_too_large");
    // ops 的上传上限等于接口服务应用操作时整份读入的上限（64MiB）：65MiB 在创建时就 413，
    // 不会等到 ops-from-upload 的后台任务才失败；正好 64MiB 可以。
    let reply = create_upload(&app, who(ORG), base, "ops", body(65 << 20, 8 << 20, "gzip")).await;
    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{:?}",
        reply.body
    );
    assert_eq!(reply.body["code"], "upload_too_large");
    let reply = create_upload(
        &app,
        who(ORG),
        base,
        "ops",
        json!({"size": 64 << 20, "sha256": sha256_hex(b"ops at the limit"),
               "partSize": 8 << 20, "format": "gzip"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    // 不占后面"进行中的上传"的名额。
    app.collection("uploads")
        .delete_one(doc! {"_id": reply.body["uploadId"].as_str().unwrap()})
        .await
        .unwrap();
    let reply = create_upload(
        &app,
        who(ORG),
        base,
        "model",
        json!({"size": 10, "sha256": "ABC", "partSize": 262144, "format": "glb"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);

    // 进行中的上传太多：429（上限调成 3，地块路径已有 1 个）。
    for _ in 0..2 {
        let reply = create_upload(&app, who(ORG), base, "script", body(10, 262144, "text")).await;
        assert_eq!(reply.status, StatusCode::CREATED);
    }
    let reply = create_upload(&app, who(ORG), base, "script", body(10, 262144, "text")).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(reply.body["code"], "too_many_uploads");

    // 空间存储上限：413。
    app.collection("spaces")
        .update_one(
            doc! {"_id": "front-hall"},
            doc! {"$set": {"storageLimitBytes": 100_i64}},
        )
        .await
        .unwrap();
    app.collection("uploads")
        .delete_many(doc! {"scope": "physical"})
        .await
        .unwrap();
    let reply = create_upload(&app, who(ORG), base, "script", body(1000, 262144, "text")).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.body["code"], "storage_limit_exceeded");

    // 越权：组织 member 只读（写 403，能查状态），陌生人 404。
    let reply = create_upload(
        &app,
        who_with("bob", "member-token"),
        base,
        "script",
        body(10, 262144, "text"),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app
        .call(
            who_with("bob", "member-token"),
            Method::GET,
            &format!("{base}/plots/p1/uploads/model/{plot_upload}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // 没有转发凭据时查不到组织角色：写操作 503（设计 9.2）；带了凭据但不是成员：404。
    let reply = create_upload(&app, who("eve"), base, "script", body(10, 262144, "text")).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    let stranger = who_with("eve", "stranger-token");
    let reply = create_upload(&app, stranger, base, "script", body(10, 262144, "text")).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app
        .put_bytes(
            stranger,
            &format!("{base}/plots/p1/uploads/model/{plot_upload}/parts/0"),
            glb,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

/// 已下线的接口（docs/design/server-slim.md 2.1）：扫描导入、重新对齐、重建、体素化、物件模型重新
/// 导出一律 410 `endpoint_retired`；AI 物件集上传三组路径都是 410；任务查询照旧，旧种类的记录照样能查。
#[tokio::test]
async fn retired_endpoints_are_gone() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app).await;
    let base = "/api/v1/spaces/front-hall";
    let scan = "a".repeat(64);
    let identity = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    for (path, body) in [
        (format!("{base}/scans"), json!({"assetHash": scan})),
        (
            format!("{base}/scans/{scan}/alignment"),
            json!({"transform": identity}),
        ),
        (format!("{base}/scans/{scan}/rebuild"), json!({})),
        (format!("{base}/scans/{scan}/voxelize"), json!({})),
        (format!("{base}/models"), json!({"assetHash": scan})),
        (
            format!("{base}/plots/p1/models"),
            json!({"assetHash": scan}),
        ),
    ] {
        for caller in [who(ORG), rebuilder(ORG)] {
            let reply = app
                .call(caller, Method::POST, &path, Some(body.clone()))
                .await;
            assert_eq!(reply.status, StatusCode::GONE, "{path}: {:?}", reply.body);
            assert_eq!(reply.body["code"], "endpoint_retired");
            assert!(reply.body["detail"].as_str().unwrap().contains("/rebuild/"));
        }
    }
    assert_eq!(count_jobs(&app).await, 0, "旧接口不再建任务");
    // AI 物件集上传：三组路径的创建、传片、完成、查询都是 410。
    let body = json!({"size": 10, "sha256": scan, "partSize": KIB256, "format": "json"});
    for (caller, prefix) in [
        (who(ORG), base.to_owned()),
        (who(ORG), format!("{base}/plots/p1")),
        (rebuilder(ORG), format!("{base}/rebuild")),
    ] {
        let reply = create_upload(&app, caller, &prefix, "authored", body.clone()).await;
        assert_eq!(reply.status, StatusCode::GONE, "{prefix}: {:?}", reply.body);
        assert_eq!(reply.body["code"], "endpoint_retired");
        let reply = app
            .call(
                caller,
                Method::GET,
                &format!("{prefix}/uploads/authored/up_x"),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::GONE, "{prefix}");
        let reply = app
            .put_bytes(
                caller,
                &format!("{prefix}/uploads/authored/up_x/parts/0"),
                b"{}".to_vec(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::GONE, "{prefix}");
    }
    // 旧接口不在注册给 NyxID 的文档里。
    let document = app.public("/api/openapi.json", None, &[]).await;
    assert_eq!(document.status, StatusCode::OK);
    let text = document.body.to_string();
    for gone in [
        "import_scan",
        "align_scan",
        "rebuild_scan",
        "voxelize_scan",
        "import_model",
    ] {
        assert!(!text.contains(gone), "{gone}");
    }
    assert!(!text.contains("authoredAsset"));

    // 任务查询照旧：处理服务下线前的旧任务记录照样能查。
    app.collection("jobs")
        .insert_one(doc! {
            "_id": "job_old_scan_import", "spaceId": "front-hall",
            "owner": {"kind": "org", "id": ORG}, "kind": "scan_import",
            "params": {"assetHash": &scan, "rebuild": true}, "status": "done",
            "attempt": 1, "maxAttempts": 3, "createdAt": ago(3600), "scope": "physical",
            "lastError": "旧的处理服务写的一段文字",
        })
        .await
        .unwrap();
    let reply = app
        .call(
            who(ORG),
            Method::GET,
            &format!("{base}/jobs/job_old_scan_import"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["kind"], "scan_import");
    assert_eq!(reply.body["lastError"], "旧的处理服务写的一段文字");
    assert!(reply.body.get("errorClass").is_none());
    let reply = app
        .call(who(ORG), Method::GET, &format!("{base}/jobs"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["items"][0]["id"], "job_old_scan_import");
}

async fn count_jobs(app: &TestApp) -> u64 {
    app.collection("jobs")
        .count_documents(doc! {})
        .await
        .unwrap()
}

#[tokio::test]
async fn pending_job_limit_is_429() {
    let Some(app) = TestApp::start(&[("JOB_MAX_PENDING_PER_SPACE", "2")]).await else {
        return;
    };
    front_hall(&app).await;
    let base = "/api/v1/spaces/front-hall";
    // 三个脚本上传：传完数据，前两个完成就占满了任务名额，第三个完成时 429。
    let mut uploads = Vec::new();
    for text in [&b"one"[..], b"two", b"three"] {
        let created = create_upload(
            &app,
            who(ORG),
            base,
            "script",
            json!({"size": text.len(), "sha256": sha256_hex(text), "partSize": KIB256, "format": "text"}),
        )
        .await;
        assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
        let id = created.body["uploadId"].as_str().unwrap().to_owned();
        let reply = app
            .put_bytes(
                who(ORG),
                &format!("{base}/uploads/script/{id}/parts/0"),
                text.to_vec(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        uploads.push(format!("{base}/uploads/script/{id}/complete"));
    }
    for complete in &uploads[..2] {
        let reply = app.call(who(ORG), Method::POST, complete, None).await;
        assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    }
    let reply = app.call(who(ORG), Method::POST, &uploads[2], None).await;
    assert_eq!(
        reply.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{:?}",
        reply.body
    );
    assert_eq!(reply.body["code"], "too_many_jobs");
    // 后台执行器做完以后可以继续。
    app.collection("jobs")
        .update_many(
            doc! {"kind": "upload_verify"},
            doc! {"$set": {"status": "done"}},
        )
        .await
        .unwrap();
    let reply = app.call(who(ORG), Method::POST, &uploads[2], None).await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
}

/// 只凭哈希和大小不能把别的主人的资源变成自己的：别的空间请求"复用"时照常要求上传完整
/// 数据（201、status=open），既拿不到资源，也看不出全系统里有没有这个文件。
#[tokio::test]
async fn reuse_by_hash_requires_owning_the_asset() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app).await;
    // 别的主人的个人空间。
    app.create_space(who("bob"), "bob-space", "person", "bob", "unlisted")
        .await;
    let secret = draco_bytes();
    let sha = sha256_hex(&secret);
    // 扫描只经重建路径上传（要重建权限）。
    let base = "/api/v1/spaces/front-hall/rebuild";
    let reply = create_upload(
        &app,
        rebuilder(ORG),
        base,
        "scan",
        json!({"size": secret.len(), "sha256": sha, "partSize": KIB256, "format": "drc"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let upload_id = reply.body["uploadId"].as_str().unwrap().to_owned();
    for (n, part) in secret.chunks(KIB256).enumerate() {
        let reply = app
            .put_bytes(
                rebuilder(ORG),
                &format!("{base}/uploads/scan/{upload_id}/parts/{n}"),
                part.to_vec(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    let reply = app
        .call(
            rebuilder(ORG),
            Method::POST,
            &format!("{base}/uploads/scan/{upload_id}/complete"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    app.finish_upload(&upload_id, &sha, secret.len() as i64)
        .await;

    // bob 声明同一哈希和大小（任何用途）：不复用，照常要求上传数据；响应与全新文件相同。
    let bob = "/api/v1/spaces/bob-space";
    let unknown = sha256_hex(b"nobody has this");
    for (purpose, format, hash) in [
        ("texture", "png", sha.as_str()),
        ("scan", "drc", sha.as_str()),
        ("scan", "drc", unknown.as_str()),
    ] {
        let (caller, path) = if purpose == "scan" {
            (rebuilder("bob"), format!("{bob}/rebuild"))
        } else {
            (who("bob"), bob.to_owned())
        };
        let reply = create_upload(
            &app,
            caller,
            &path,
            purpose,
            json!({"size": secret.len(), "sha256": hash, "partSize": KIB256, "format": format}),
        )
        .await;
        assert_eq!(
            reply.status,
            StatusCode::CREATED,
            "{purpose}: {:?}",
            reply.body
        );
        assert_eq!(reply.body["status"], "open", "{purpose}");
        assert_eq!(reply.body["reused"], false, "{purpose}");
    }
    // 拿不到资源。
    let reply = app
        .call(
            who("bob"),
            Method::GET,
            &format!("{bob}/assets/{sha}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{:?}", reply.body);

    // 旧版本按哈希复用留下的上传（status=done、reused=true）同样不算。
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_legacy_reuse", "spaceId": "bob-space",
            "owner": {"kind": "person", "id": "bob"}, "scope": "physical",
            "purpose": "scan", "status": "done", "sha256": &sha, "assetHash": &sha,
            "reused": true, "size": secret.len() as i64, "createdAt": ago(0),
        })
        .await
        .unwrap();
    let reply = app
        .call(
            who("bob"),
            Method::GET,
            &format!("{bob}/assets/{sha}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{:?}", reply.body);

    // 主人自己照常复用（201、status=done）并能下载。
    let reply = create_upload(
        &app,
        rebuilder(ORG),
        base,
        "scan",
        json!({"size": secret.len(), "sha256": sha, "partSize": KIB256, "format": "drc"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["reused"], true);
    // 用途不同（本空间的扫描当贴图）不直接复用。
    let reply = create_upload(
        &app,
        who(ORG),
        "/api/v1/spaces/front-hall",
        "texture",
        json!({"size": secret.len(), "sha256": sha, "partSize": KIB256, "format": "png"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["reused"], false);
}

/// 删除空间先记墓碑：清理完之前编号仍被占着、谁都拿不到这个空间；清理中途失败时主人可以
/// 重试。删除后用同一个编号重建的空间不继承旧空间的资源（按 `metadata.spaceId` 或残留的
/// `assetRefs`）。
#[tokio::test]
async fn space_deletion_uses_a_tombstone_and_recreated_ids_do_not_inherit_assets() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app).await;
    let secret = b"front-hall private scan".to_vec();
    let hash = app
        .put_asset(&secret, doc! {"kind": "scan", "spaceId": "front-hall"})
        .await;
    let base = "/api/v1/spaces/front-hall";
    let reply = app
        .call(
            who(ORG),
            Method::GET,
            &format!("{base}/assets/{hash}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);

    // 模拟上次删除清理到一半失败：空间文档上只有墓碑。
    app.collection("spaces")
        .update_one(
            doc! {"_id": "front-hall"},
            doc! {"$set": {"deletingAt": ago(0)}},
        )
        .await
        .unwrap();
    assert_eq!(
        app.call(who(ORG), Method::GET, base, None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.public("/api/public/spaces/front-hall/head", None, &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // 编号还被占着：别人不能现在就用它新建空间（否则清理会删掉新空间的数据）。
    let reply = app
        .call(
            who("bob"),
            Method::POST,
            "/api/v1/admin/spaces",
            Some(
                json!({"id": "front-hall", "name": "x", "visibility": "unlisted",
                        "owner": {"kind": "person", "id": "bob"}}),
            ),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    // 别人不能替主人"重试删除"。
    let reply = app
        .call(
            who_with("bob", "stranger-token"),
            Method::DELETE,
            "/api/v1/admin/spaces/front-hall?confirm=front-hall",
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // 主人重试：接着清理，最后释放编号。
    let reply = app
        .call(
            who(ORG),
            Method::DELETE,
            "/api/v1/admin/spaces/front-hall?confirm=front-hall",
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{:?}", reply.body);
    for collection in ["spaces", "commits", "palettes", "anchors"] {
        let filter = if collection == "spaces" {
            doc! {"_id": "front-hall"}
        } else {
            doc! {"spaceId": "front-hall"}
        };
        assert_eq!(
            app.collection(collection)
                .count_documents(filter)
                .await
                .unwrap(),
            0,
            "{collection}"
        );
    }

    // 旧主人在这个编号下留下的资源引用（例如清理失败的旧数据）。
    app.collection("assetRefs")
        .insert_one(doc! {"hash": &hash, "spaceId": "front-hall",
        "owner": {"kind": "org", "id": ORG}, "createdAt": ago(0)})
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    app.create_space(who("bob"), "front-hall", "person", "bob", "unlisted")
        .await;
    let reply = app
        .call(
            who("bob"),
            Method::GET,
            &format!("{base}/assets/{hash}"),
            None,
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::NOT_FOUND,
        "旧空间的资源不归同编号的新空间：{:?}",
        reply.body
    );
    // 新空间自己登记的资源照常算它的。
    let own = app
        .put_asset(
            b"bob's own scan",
            doc! {"kind": "scan", "spaceId": "front-hall"},
        )
        .await;
    let reply = app
        .call(
            who("bob"),
            Method::GET,
            &format!("{base}/assets/{own}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
}

/// 已完成的会话里，分片请求不能再改写数据块：校验和登记都在读这些块，资源按哈希全局去重，
/// 改写会让"文件名是一个哈希、内容却是另一份"。复现：分片请求过了状态检查、卡在读请求体时，
/// 同一上传者调用 complete、处理服务校验并登记；之后再放行请求体。
#[tokio::test]
async fn late_part_write_cannot_rewrite_a_completed_upload() {
    use tower::ServiceExt as _;
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app).await;
    let data = draco_bytes();
    let sha = sha256_hex(&data);
    // 扫描只经重建路径上传（要重建权限）。
    let base = "/api/v1/spaces/front-hall/rebuild";
    let reply = create_upload(
        &app,
        rebuilder(ORG),
        base,
        "scan",
        json!({"size": data.len(), "sha256": sha, "partSize": KIB256, "format": "drc"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let upload_id = reply.body["uploadId"].as_str().unwrap().to_owned();
    let part = |n: usize| format!("{base}/uploads/scan/{upload_id}/parts/{n}");
    for (n, bytes) in data.chunks(KIB256).enumerate() {
        let reply = app
            .put_bytes(rebuilder(ORG), &part(n), bytes.to_vec())
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    // 第 1 片的重传：过了状态检查，等信号才给出请求体。
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let evil = vec![0xEE_u8; data.len() - KIB256];
    let stream = futures_util::stream::once(async move {
        let _ = wait.await;
        Ok::<_, std::io::Error>(axum::body::Bytes::from(evil))
    });
    let request = axum::http::Request::builder()
        .method(Method::PUT)
        .uri(part(1))
        .header(
            "x-nyxid-identity-token",
            identity_with(ORG, &[REBUILD_PERMISSION]),
        )
        .header("content-type", "application/octet-stream")
        .header("content-length", (data.len() - KIB256).to_string())
        .body(axum::body::Body::from_stream(stream))
        .unwrap();
    let router = metaverse_api::app(app.state.clone());
    let late = tokio::spawn(async move { router.oneshot(request).await.unwrap().status() });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let reply = app
        .call(
            rebuilder(ORG),
            Method::POST,
            &format!("{base}/uploads/scan/{upload_id}/complete"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    app.finish_upload(&upload_id, &sha, data.len() as i64).await;
    release.send(()).unwrap();
    assert_eq!(late.await.unwrap(), StatusCode::CONFLICT);
    // 数据块没有被改写：内容仍然是登记的哈希。
    let stored: Vec<u8> = chunks_of(&app, &upload_id)
        .await
        .iter()
        .flat_map(|chunk| match chunk.get("data") {
            Some(Bson::Binary(binary)) => binary.bytes.clone(),
            other => panic!("数据块格式不对：{other:?}"),
        })
        .collect();
    assert_eq!(sha256_hex(&stored), sha);
    let upload = app
        .collection("uploads")
        .find_one(doc! {"_id": &upload_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(upload.get_i32("writing").unwrap_or(0), 0);
}

/// 有分片正在写入时不能完成上传（409 parts_in_progress）；写入方中途退出、租期过了之后可以。
#[tokio::test]
async fn complete_waits_for_parts_in_flight() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app).await;
    let data = draco_bytes();
    let sha = sha256_hex(&data);
    // 扫描只经重建路径上传（要重建权限）。
    let base = "/api/v1/spaces/front-hall/rebuild";
    let reply = create_upload(
        &app,
        rebuilder(ORG),
        base,
        "scan",
        json!({"size": data.len(), "sha256": sha, "partSize": KIB256, "format": "drc"}),
    )
    .await;
    let upload_id = reply.body["uploadId"].as_str().unwrap().to_owned();
    for (n, bytes) in data.chunks(KIB256).enumerate() {
        let reply = app
            .put_bytes(
                rebuilder(ORG),
                &format!("{base}/uploads/scan/{upload_id}/parts/{n}"),
                bytes.to_vec(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    let complete = format!("{base}/uploads/scan/{upload_id}/complete");
    // 模拟另一个分片请求正在写数据块。
    app.collection("uploads")
        .update_one(
            doc! {"_id": &upload_id},
            doc! {"$set": {"writing": 1_i32, "writeLeaseUntil": "2999-01-01T00:00:00.000Z"}},
        )
        .await
        .unwrap();
    let reply = app
        .call(rebuilder(ORG), Method::POST, &complete, None)
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(reply.body["code"], "parts_in_progress");
    assert_eq!(reply.headers.get("retry-after").unwrap(), "2");
    // 写入方进程退出、没来得及释放：租期过了照常完成。
    app.collection("uploads")
        .update_one(
            doc! {"_id": &upload_id},
            doc! {"$set": {"writeLeaseUntil": "2000-01-01T00:00:00.000Z"}},
        )
        .await
        .unwrap();
    let reply = app
        .call(rebuilder(ORG), Method::POST, &complete, None)
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
}
