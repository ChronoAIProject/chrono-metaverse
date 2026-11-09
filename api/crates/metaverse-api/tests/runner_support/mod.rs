//! 后台执行器测试共用的设施：建空间、经接口分片上传、按需要的配置建执行器、读任务和上传的文档。

#![allow(dead_code)]

use std::sync::Arc;

use axum::http::{Method, StatusCode};
use metaverse_api::runner::{Runner, RunnerConfig};
use mongodb::bson::{doc, Bson, Document};
use serde_json::{json, Value};

use crate::ingest_support::*;

pub const SPACE: &str = "front-hall";
pub const BASE: &str = "/api/v1/spaces/front-hall";
pub const KIB256: usize = 256 * 1024;

/// 建组织空间（实体区、虚拟区、地块 p1）。
pub async fn front_hall(app: &TestApp, id: &str) {
    app.create_space(who(ORG), id, "org", ORG, "unlisted").await;
    app.set_layout(
        id,
        json!([
            {"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 100, 60, 100]]},
            {"id": "garden", "kind": "virtual", "boxes": [[100, 0, 0, 200, 60, 100]]}
        ]),
        json!([{"id": "p1", "regionId": "garden", "boxes": [[100, 0, 0, 120, 20, 20]]}]),
    )
    .await;
}

/// 一个执行器（编号固定，便于核对 `leaseOwner`）。
pub fn runner(app: &TestApp, instance: &str) -> Arc<Runner> {
    Runner::new(
        app.state.clone(),
        RunnerConfig {
            instance_id: instance.to_owned(),
            ..RunnerConfig::default()
        },
    )
}

/// 经接口分片上传（256 KiB 一片）并完成，返回 `(上传编号, 任务编号)`。不等核对。
pub async fn upload(
    app: &TestApp,
    space: &str,
    purpose: &str,
    format: &str,
    bytes: &[u8],
) -> (String, String) {
    upload_declared(app, space, purpose, format, bytes, &sha256_hex(bytes)).await
}

/// 同上，声明的哈希由调用方给（哈希不符的用例）。
pub async fn upload_declared(
    app: &TestApp,
    space: &str,
    purpose: &str,
    format: &str,
    bytes: &[u8],
    sha: &str,
) -> (String, String) {
    let base = format!("/api/v1/spaces/{space}");
    let created = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{base}/uploads/{purpose}"),
            Some(json!({"size": bytes.len(), "sha256": sha, "partSize": KIB256, "format": format})),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    let id = created.body["uploadId"].as_str().unwrap().to_owned();
    for (n, part) in bytes.chunks(KIB256).enumerate() {
        let reply = app
            .put_bytes(
                who(ORG),
                &format!("{base}/uploads/{purpose}/{id}/parts/{n}"),
                part.to_vec(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{base}/uploads/{purpose}/{id}/complete"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    let job = reply.body["jobId"].as_str().unwrap().to_owned();
    (id, job)
}

pub async fn job(app: &TestApp, id: &str) -> Document {
    app.collection("jobs")
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .expect("任务存在")
}

pub async fn upload_doc(app: &TestApp, id: &str) -> Document {
    app.collection("uploads")
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .expect("上传存在")
}

pub async fn files_doc(app: &TestApp, hash: &str) -> Option<Document> {
    app.collection("assets.files")
        .find_one(doc! {"filename": hash})
        .await
        .unwrap()
}

pub async fn chunk_count(app: &TestApp, files_id: &str) -> u64 {
    app.collection("assets.chunks")
        .count_documents(doc! {"files_id": files_id})
        .await
        .unwrap()
}

pub fn number(document: &Document, key: &str) -> i64 {
    match document.get(key) {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        Some(Bson::Double(n)) => *n as i64,
        other => panic!("{key} 不是数：{other:?}"),
    }
}

pub async fn storage_used(app: &TestApp, space: &str) -> i64 {
    let space = app
        .collection("spaces")
        .find_one(doc! {"_id": space})
        .await
        .unwrap()
        .unwrap();
    match space.get("storageUsedBytes") {
        None => 0,
        Some(_) => number(&space, "storageUsedBytes"),
    }
}

/// 任务的 `lastError.class`。
pub fn error_class(job: &Document) -> String {
    job.get_document("lastError")
        .unwrap()
        .get_str("class")
        .unwrap()
        .to_owned()
}

/// 把任务的租约改成已过期（模拟执行器卡住、租约过期）。
pub async fn expire_lease(app: &TestApp, job_id: &str) {
    app.collection("jobs")
        .update_one(
            doc! {"_id": job_id},
            doc! {"$set": {"leaseUntil": "2000-01-01T00:00:00.000Z"}},
        )
        .await
        .unwrap();
}

/// 一个合格的物件模型 glb：一个三角形，底面中心在原点，`height` 米高。
pub fn model_glb(height: f32) -> Vec<u8> {
    let positions: [f32; 9] = [-0.5, 0.0, -0.5, 0.5, 0.0, -0.5, 0.0, height, 0.5];
    let bin: Vec<u8> = positions.iter().flat_map(|v| v.to_le_bytes()).collect();
    let json: Value = json!({
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
                       "min": [-0.5, 0.0, -0.5], "max": [0.5, height, 0.5]}],
        "bufferViews": [{"buffer": 0, "byteLength": 36}],
        "buffers": [{"byteLength": 36}],
    });
    let mut text = serde_json::to_vec(&json).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let total = 12 + 8 + text.len() + 8 + bin.len();
    let mut out = b"glTF".to_vec();
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(text.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&text);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    out
}

/// 一个 Draco 扫描文件（`size` 字节）。
pub fn draco(size: usize, seed: u8) -> Vec<u8> {
    let mut bytes = b"DRACO\x02\x02\x01\x01\x00\x00".to_vec();
    bytes.extend(
        (0..size.saturating_sub(11)).map(|i| ((i as u64 * 31 + u64::from(seed)) % 251) as u8),
    );
    bytes
}
