//! 清理的栅栏（与处理服务 `jobs/cleanup.py`、`assets.touch_asset` 的约定）：接口服务新引用一个
//! 已登记的资源之前，先按文件名刷新 `metadata.touchedAt` 并确认匹配到；匹配不到说明资源刚被
//! 清理删掉，让调用方重新上传，不写下悬空的引用。
//!
//! 清理先查引用、再按"上传时间和 touchedAt 都早于 7 天前"的条件删除，两步之间没有锁。
//! `TestApp::cleanup_delete` 模拟其中"查引用时还没人引用、现在执行删除"的那一步。
//!
//! 覆盖：草稿追加（内联、ops-from-upload）、发布（事务前确认操作文件和脚本、事务里确认全部
//! 引用）、"哈希已存在、直接复用"的上传、导入扫描建任务、事件类型的 spawnEntity 模型。

mod timeline_support;

use axum::http::{Method, StatusCode};
use mongodb::bson::{doc, DateTime, Document};
use serde_json::{json, Value};
use timeline_support::TestApp;

const SPACE: &str = "front-hall";

fn draft_path(draft: &str) -> String {
    format!("/api/v1/spaces/{SPACE}/drafts/{draft}")
}

async fn new_draft(app: &TestApp) -> String {
    let reply = app
        .org(
            Method::POST,
            &format!("/api/v1/spaces/{SPACE}/drafts"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    draft_path(reply.body["id"].as_str().unwrap())
}

async fn append(app: &TestApp, path: &str, ops: Value) -> timeline_support::Reply {
    app.org(
        Method::POST,
        &format!("{path}/ops"),
        Some(json!({ "ops": ops })),
    )
    .await
}

/// 放一块贴图地毯（物件的形状材质引用贴图资源）。
fn rug(id: &str, texture: &str) -> Value {
    json!([{"op": "placeEntity", "entity": {"entityId": id, "layer": "ext", "kind": "object",
        "shape": {"type": "box", "size": [1, 0.02, 1], "transform": {"position": [2, 0, 2]},
                  "material": {"texture": texture, "uv": "planar"}},
        "bounds": {"min": [1.5, 0, 1.5], "max": [2.5, 0.02, 2.5]}}}])
}

fn texture_meta() -> Document {
    doc! {"kind": "texture", "contentType": "image/png", "check": timeline_support::image_check("png", 64, 64)}
}

async fn setup() -> Option<TestApp> {
    let app = TestApp::start().await?;
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    Some(app)
}

async fn head_seq(app: &TestApp) -> i64 {
    let space = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap();
    let head = space.get_document("head").unwrap();
    head.get_i64("seq")
        .or_else(|_| head.get_i32("seq").map(i64::from))
        .unwrap()
}

async fn asset_ref_count(app: &TestApp, hash: &str) -> u64 {
    app.collection("assetRefs")
        .count_documents(doc! {"hash": hash, "spaceId": SPACE})
        .await
        .unwrap()
}

/// 刚刷新过：`touchedAt` 在最近一分钟内。
async fn assert_fresh(app: &TestApp, hash: &str) {
    let touched = app
        .touched_at(hash)
        .await
        .unwrap_or_else(|| panic!("{hash} 应该刷新过 touchedAt"));
    let age = DateTime::now().timestamp_millis() - touched.timestamp_millis();
    assert!((0..60_000).contains(&age), "touchedAt 是 {age} 毫秒前");
}

/// 追加时先刷新引用的资源：之后清理的条件删除删不掉它，发布后正常登记。
#[tokio::test]
async fn append_refreshes_touched_at_so_a_racing_cleanup_cannot_delete() {
    let Some(app) = setup().await else {
        return;
    };
    // 8 天前上传、一直没被引用：清理的候选。
    let texture = app
        .put_old_upload(SPACE, "texture", b"\x89PNG old rug", texture_meta(), 8)
        .await;
    assert!(app.touched_at(&texture).await.is_none());
    let path = new_draft(&app).await;
    let reply = append(&app, &path, rug("rug", &texture)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_fresh(&app, &texture).await;
    // 清理在追加之前查过引用（那时还没人引用），现在才执行删除：条件不再成立，删不掉。
    assert!(!app.cleanup_delete(&texture).await);
    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(asset_ref_count(&app, &texture).await, 1);
    assert!(app.touched_at(&texture).await.is_some(), "资源还在");
}

/// 资源在追加之前就被清理了：追加 422，草稿、记录都不变。
#[tokio::test]
async fn append_after_cleanup_is_rejected_without_writing_references() {
    let Some(app) = setup().await else {
        return;
    };
    let texture = app
        .put_old_upload(SPACE, "texture", b"\x89PNG cleaned rug", texture_meta(), 8)
        .await;
    assert!(app.cleanup_delete(&texture).await);
    let path = new_draft(&app).await;
    let records = app
        .collection("records")
        .count_documents(doc! {})
        .await
        .unwrap();
    let reply = append(&app, &path, rug("rug", &texture)).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "unknown_asset");
    let detail = reply.body["detail"].as_str().unwrap();
    assert!(
        detail.contains(&texture) && detail.contains("重新上传"),
        "{detail}"
    );
    let draft = app.org(Method::GET, &path, None).await;
    assert_eq!(draft.body["rev"], 0);
    assert_eq!(draft.body["assets"], json!([]));
    assert_eq!(
        app.collection("records")
            .count_documents(doc! {})
            .await
            .unwrap(),
        records
    );
}

/// 清理在追加和发布之间删掉了草稿引用的贴图（例如它查引用时草稿还没写下，追加又是旧版本、
/// 没有刷新）：发布在提交事务里发现，409 `asset_gone`，什么都不写；重新上传同一内容后能发布。
#[tokio::test]
async fn cleanup_between_append_and_publish_is_caught_inside_the_commit() {
    let Some(app) = setup().await else {
        return;
    };
    let bytes = b"\x89PNG rug that gets cleaned";
    let texture = app
        .put_old_upload(SPACE, "texture", bytes, texture_meta(), 8)
        .await;
    let path = new_draft(&app).await;
    let reply = append(&app, &path, rug("rug", &texture)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let rev = reply.body["rev"].clone();
    let seq = head_seq(&app).await;
    // 模拟清理删掉了它（重新变旧后执行条件删除）。
    app.age_asset(&texture, 8).await;
    assert!(app.cleanup_delete(&texture).await);

    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(reply.body["code"], "asset_gone");
    assert_eq!(reply.body["assets"], json!([texture]));
    // 整个提交作废：时间线没动，草稿仍是打开的、rev 不变，没有登记 assetRefs。
    assert_eq!(head_seq(&app).await, seq);
    let draft = app.org(Method::GET, &path, None).await;
    assert_eq!(draft.body["status"], "open");
    assert_eq!(draft.body["rev"], rev);
    assert_eq!(asset_ref_count(&app, &texture).await, 0);
    assert_eq!(
        app.collection("commits")
            .count_documents(doc! {"draftId": draft.body["id"].as_str().unwrap()})
            .await
            .unwrap(),
        0
    );

    // 重新上传同一内容（哈希不变）后再发布：成功，提交引用的资源都在。
    app.put_asset(bytes, "image/png", "texture").await;
    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(head_seq(&app).await, seq + 1);
    assert_eq!(asset_ref_count(&app, &texture).await, 1);
    assert_fresh(&app, &texture).await;
}

/// ops-from-upload：建任务之前和写进草稿之前都刷新操作文件；清理在追加和发布之间删掉它时，
/// 发布在事务之前就发现（409 `asset_gone`），重新上传后能发布；已被清理的文件不能再建任务。
#[tokio::test]
async fn ops_file_cleaned_between_append_and_publish() {
    let Some(app) = setup().await else {
        return;
    };
    let ops = format!(
        "{}\n{}\n",
        json!({"op": "fill", "box": [0, 0, 0, 2, 1, 1], "block": 2}),
        json!({"op": "fill", "box": [0, 1, 0, 1, 2, 1], "block": 3})
    );
    let (upload_id, hash) = app.put_ops_upload(SPACE, ops.as_bytes()).await;
    app.age_asset(&hash, 8).await;
    let path = new_draft(&app).await;
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({"uploadId": upload_id})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    let job = app.wait_job(reply.body["jobId"].as_str().unwrap()).await;
    assert_eq!(job.get_str("status").unwrap(), "done", "{job:?}");
    assert_fresh(&app, &hash).await;
    assert!(!app.cleanup_delete(&hash).await);
    let seq = head_seq(&app).await;

    // 模拟清理删掉了它。
    app.age_asset(&hash, 8).await;
    assert!(app.cleanup_delete(&hash).await);
    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(reply.body["code"], "asset_gone");
    assert_eq!(reply.body["assets"], json!([hash]));
    assert_eq!(head_seq(&app).await, seq);
    // 已被清理的操作文件不能再拿来建任务（404，不建任务）。
    let other = new_draft(&app).await;
    let jobs = app
        .collection("jobs")
        .count_documents(doc! {})
        .await
        .unwrap();
    let reply = app
        .org(
            Method::POST,
            &format!("{other}/ops-from-upload"),
            Some(json!({"assetHash": hash})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{:?}", reply.body);
    assert!(reply.body["detail"].as_str().unwrap().contains("重新上传"));
    assert_eq!(
        app.collection("jobs")
            .count_documents(doc! {})
            .await
            .unwrap(),
        jobs
    );

    // 重新上传同一个文件后发布：提交只放资源哈希，资源在。
    app.put_asset(ops.as_bytes(), "application/x-ndjson", "ops")
        .await;
    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let commit = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": seq + 1})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commit.get_str("opsRef").unwrap(), hash);
    assert_fresh(&app, &hash).await;
}

/// `scriptRef` 必须是本空间的脚本资源；发布时刷新它，提交写成之后清理删不掉它。
#[tokio::test]
async fn script_ref_must_be_a_script_of_the_space_and_is_fenced() {
    let Some(app) = setup().await else {
        return;
    };
    let script = app
        .put_old_upload(
            SPACE,
            "script",
            b"for x in range(2): fill(x)\n",
            doc! {"kind": "script", "contentType": "text/plain", "check": timeline_support::text_check()},
            8,
        )
        .await;
    let texture = app
        .put_old_upload(SPACE, "texture", b"\x89PNG not a script", texture_meta(), 1)
        .await;
    let foreign = app
        .put_space_asset(
            "other-space",
            b"someone else's script",
            "text/plain",
            "script",
        )
        .await;
    let path = new_draft(&app).await;
    let reply = append(
        &app,
        &path,
        json!([{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let seq = head_seq(&app).await;
    // 不存在、不是脚本、别的空间的：422，不发布。
    for hash in ["f".repeat(64), texture.clone(), foreign.clone()] {
        let reply = app
            .org(
                Method::POST,
                &format!("{path}/publish"),
                Some(json!({"scriptRef": hash})),
            )
            .await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{hash}");
        assert_eq!(reply.body["code"], "unknown_asset");
        assert_eq!(head_seq(&app).await, seq);
    }
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/publish"),
            Some(json!({"scriptRef": script})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let commit = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": seq + 1})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commit.get_str("scriptRef").unwrap(), script);
    assert_fresh(&app, &script).await;
    assert!(!app.cleanup_delete(&script).await);
}

/// "哈希已存在、直接复用"的上传、事件类型的 spawnEntity 模型：都先刷新资源，之后清理删不掉；
/// 资源已被清理时按不存在处理（复用改为完整上传）。
#[tokio::test]
async fn reuse_jobs_and_event_types_refresh_touched_at() {
    let Some(app) = setup().await else {
        return;
    };
    // 复用：本空间 8 天前传过的 ops 文件。
    let ops = format!(
        "{}\n",
        json!({"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2})
    );
    let (_, ops_hash) = app.put_ops_upload(SPACE, ops.as_bytes()).await;
    app.age_asset(&ops_hash, 8).await;
    let create =
        json!({"size": ops.len(), "sha256": ops_hash, "partSize": 262144, "format": "ndjson"});
    let uploads = format!("/api/v1/spaces/{SPACE}/uploads/ops");
    let reply = app.org(Method::POST, &uploads, Some(create.clone())).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["reused"], true);
    assert_eq!(reply.body["status"], "done");
    assert_fresh(&app, &ops_hash).await;
    assert!(!app.cleanup_delete(&ops_hash).await);
    // 资源已被清理：不再复用，照常要求上传完整数据。
    app.age_asset(&ops_hash, 8).await;
    assert!(app.cleanup_delete(&ops_hash).await);
    let reply = app.org(Method::POST, &uploads, Some(create)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["reused"], false);
    assert_eq!(reply.body["status"], "open");

    // 事件类型的 spawnEntity 模型：登记 assetRefs 之前刷新。
    let model = app
        .put_old_upload(
            SPACE,
            "model",
            b"glTF processed robot",
            doc! {"kind": "model", "contentType": "model/gltf-binary",
            "check": timeline_support::glb_check([-0.5, 0.0, -0.5], [0.5, 1.0, 0.5], 500)},
            8,
        )
        .await;
    let reply = app
        .org(
            Method::POST,
            &format!("/api/v1/admin/spaces/{SPACE}/event-types"),
            Some(json!({
                "type": "robot.arrived", "schema": {"type": "object"}, "defaultVisibility": "public",
                "display": {"kind": "spawnEntity", "entityAsset": model, "durationSec": 30},
            })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_fresh(&app, &model).await;
    assert!(!app.cleanup_delete(&model).await);
    assert_eq!(asset_ref_count(&app, &model).await, 1);
}
