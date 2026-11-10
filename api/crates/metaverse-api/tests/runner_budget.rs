//! 内存和计算预算的实测（docs/design/server-slim.md 4.8，不进持续集成）：
//!
//! ```text
//! cargo test --release -p metaverse-api --test runner_budget -- --ignored --nocapture --test-threads 1
//! ```
//!
//! - `peak_memory_under_worst_case_load`：同时跑 2 个最坏的核对（16 MiB 的重建包清单、JSON 块 8 MiB 的
//!   扫描 glb）、1 个最坏的重任务（`ops_from_upload`：解压后约 256 MiB、10 万条操作）、4 片并发的
//!   32 MiB 分片上传，再加 128 MiB 的公开缓存（直接占用同样大小的内存模拟），每 50 毫秒采样一次
//!   本进程的常驻内存，报告峰值；
//! - `one_gib_scan_verification`：1 GiB 的 Draco 扫描从 GridFS 流式读出、核对的耗时。
//!
//! 结果记进 `api/README.md`。

mod ingest_support;
mod runner_support;

use std::io::Write;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use flate2::write::GzEncoder;
use ingest_support::*;
use metaverse_api::runner::{Outcome, SlotClass};
use mongodb::bson::{doc, spec::BinarySubtype, Binary};
use runner_support::*;
use serde_json::json;

const MIB: usize = 1 << 20;

/// 本进程当前的常驻内存（字节）。
fn rss() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|kb| kb.parse::<u64>().ok())
        .map_or(0, |kb| kb * 1024)
}

/// 直接写一个已完成的上传会话和它的数据块、`upload_verify` 任务（用途不能经实体区路径上传时用）。
async fn complete_upload_directly(
    app: &TestApp,
    space: &str,
    purpose: &str,
    format: &str,
    bytes: &[u8],
) -> String {
    let id = format!("up_{}", uuid::Uuid::new_v4().simple());
    let now = metaverse_api::now().unwrap().to_rfc3339();
    let chunks: Vec<_> = bytes
        .chunks(KIB256)
        .enumerate()
        .map(|(n, block)| {
            doc! {"files_id": &id, "n": n as i32,
            "data": Binary { subtype: BinarySubtype::Generic, bytes: block.to_vec() }}
        })
        .collect();
    for batch in chunks.chunks(32) {
        app.collection("assets.chunks")
            .insert_many(batch.to_vec())
            .await
            .unwrap();
    }
    let part_size = 32 * MIB as i64;
    app.collection("uploads")
        .insert_one(doc! {
            "_id": &id, "spaceId": space, "owner": {"kind": "org", "id": ORG}, "scope": "rebuild",
            "purpose": purpose, "declaredFormat": format, "status": "complete",
            "size": bytes.len() as i64, "sha256": sha256_hex(bytes), "partSize": part_size,
            "partCount": (bytes.len() as u64).div_ceil(part_size as u64) as i64, "parts": {}, "headerChecked": true,
            "actor": {"sub": ORG, "nyxServiceId": SERVICE}, "createdAt": &now, "updatedAt": &now,
            "completedAt": &now, "jobId": format!("job_{id}"),
        })
        .await
        .unwrap();
    app.collection("jobs")
        .insert_one(doc! {
            "_id": format!("job_{id}"), "spaceId": space, "owner": {"kind": "org", "id": ORG},
            "kind": "upload_verify", "params": {"uploadId": &id}, "status": "queued",
            "attempt": 0, "maxAttempts": 3, "createdAt": &now, "scope": "rebuild",
        })
        .await
        .unwrap();
    id
}

/// JSON 块约 `json_bytes`、BIN 块 `bin_bytes` 的扫描 glb（`extras` 里塞一个长字符串）。
fn big_scan_glb(json_bytes: usize, bin_bytes: usize) -> Vec<u8> {
    let filler = "x".repeat(json_bytes.saturating_sub(400));
    let json = json!({
        "asset": {"version": "2.0", "extras": {"filler": filler}}, "scene": 0,
        "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
                       "min": [0, 0, 0], "max": [1, 1, 1]}],
        "bufferViews": [{"buffer": 0, "byteLength": bin_bytes}],
        "buffers": [{"byteLength": bin_bytes}],
    });
    let mut text = serde_json::to_vec(&json).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let total = 12 + 8 + text.len() + 8 + bin_bytes;
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(text.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&text);
    out.extend_from_slice(&(bin_bytes as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend((0..bin_bytes).map(|i| (i % 7) as u8));
    out
}

/// 10 万条放物件的操作，每条约 2.6 KiB（`props` 里一段说明），gzip 压缩。
fn heavy_ops(count: usize) -> Vec<u8> {
    let note = "前厅物件的建模说明。".repeat(80);
    let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::fast());
    for n in 0..count {
        let x = (n % 300) as f64 * 0.01;
        let z = (n / 300) as f64 * 0.01;
        let op = json!({"op": "placeEntity", "entity": {
            "entityId": format!("budget-{n:06}"), "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [0.01, 0.01, 0.01],
                      "transform": {"position": [x + 0.005, 0.0, z + 0.005]}},
            "bounds": {"min": [x, 0.0, z], "max": [x + 0.01, 0.01, z + 0.01]},
            "props": {"note": note},
        }});
        encoder.write_all(op.to_string().as_bytes()).unwrap();
        encoder.write_all(b"\n").unwrap();
    }
    encoder.finish().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn peak_memory_under_worst_case_load() {
    let Some(app) = TestApp::start(&[("UPLOAD_MAX_CONCURRENT_PARTS", "4")]).await else {
        return;
    };
    for space in ["verify-a", "verify-b", "heavy", "parts"] {
        front_hall(&app, space).await;
    }
    // 重任务：先把操作文件上传、核对好，建草稿并排上队。
    let ops = heavy_ops(100_000);
    eprintln!("操作文件压缩后 {} 字节", ops.len());
    let (ops_upload, _) = upload(&app, "heavy", "ops", "gzip", &ops).await;
    drop(ops);
    assert_eq!(runner(&app, "prep").run_until_idle().await, [Outcome::Done]);
    let reply = app
        .call(who(ORG), Method::POST, "/api/v1/spaces/heavy/drafts", None)
        .await;
    let draft = reply.body["id"].as_str().unwrap().to_owned();
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("/api/v1/spaces/heavy/drafts/{draft}/ops-from-upload"),
            Some(json!({"uploadId": ops_upload})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    // 两个最坏的核对。
    let prefix =
        "{\"format\":\"chrono-metaverse-rebuild-bundle\",\"version\":1,\"files\":[],\"note\":\"";
    let suffix = "\"}";
    let mut bundle = prefix.as_bytes().to_vec();
    bundle.resize(16 * MIB - suffix.len(), b'n');
    bundle.extend_from_slice(suffix.as_bytes());
    complete_upload_directly(&app, "verify-a", "bundle", "json", &bundle).await;
    drop(bundle);
    let glb = big_scan_glb(8 * MIB - 64, 200 * MIB);
    complete_upload_directly(&app, "verify-b", "scan", "glb", &glb).await;
    drop(glb);
    // 4 片并发上传（ops 用途，每片 32 MiB）：先建好会话。
    let mut sessions = Vec::new();
    for n in 0..4u8 {
        let mut body = vec![b' '; 32 * MIB];
        body[..3].copy_from_slice(&[b'{', b'0' + n, b'}']);
        let reply = app
            .call(
                who(ORG),
                Method::POST,
                "/api/v1/spaces/parts/uploads/ops",
                Some(json!({"size": body.len(), "sha256": sha256_hex(&body),
                            "partSize": 32 * MIB, "format": "ndjson"})),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
        sessions.push((reply.body["uploadId"].as_str().unwrap().to_owned(), body));
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let baseline = rss();
    // 从这里开始量峰值（写 5 到 clear_refs 把 VmHWM 重置成当前值）。
    let _ = std::fs::write("/proc/self/clear_refs", "5");
    // 公开缓存装满（128 MiB）。
    let cache = vec![1u8; 128 * MIB];
    std::hint::black_box(&cache);

    let runner = runner(&app, "budget");
    let started = Instant::now();
    let verify_a = runner
        .claim(SlotClass::Verify, metaverse_api::now().unwrap())
        .await
        .unwrap()
        .unwrap();
    let verify_b = runner
        .claim(SlotClass::Verify, metaverse_api::now().unwrap())
        .await
        .unwrap()
        .unwrap();
    let heavy = runner
        .claim(SlotClass::Heavy, metaverse_api::now().unwrap())
        .await
        .unwrap()
        .unwrap();
    let jobs = [verify_a, verify_b, heavy].map(|lease| {
        let runner = runner.clone();
        tokio::spawn(async move { runner.execute(lease).await })
    });
    let uploads = sessions.into_iter().map(|(id, body)| {
        let app = &app;
        async move {
            app.put_bytes(
                who(ORG),
                &format!("/api/v1/spaces/parts/uploads/ops/{id}/parts/0"),
                body,
            )
            .await
            .status
        }
    });
    let statuses = futures_util::future::join_all(uploads).await;
    for job in jobs {
        let outcome = job.await.unwrap();
        eprintln!("任务结局：{outcome:?}");
    }
    let elapsed = started.elapsed();
    let peak = rss();
    let hwm = std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .map(str::to_owned)
        .unwrap_or_default();
    eprintln!(
        "分片上传：{statuses:?}；基线 {} MiB，结束时 {} MiB，{hwm}，耗时 {elapsed:?}",
        baseline / MIB as u64,
        peak / MIB as u64,
    );
    drop(cache);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn one_gib_scan_verification() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    front_hall(&app, SPACE).await;
    let data = draco(1 << 30, 9);
    let (upload_id, _) = upload(&app, SPACE, "scan", "drc", &data).await;
    drop(data);
    let runner = runner(&app, "budget");
    let started = Instant::now();
    assert_eq!(runner.run_until_idle().await, [Outcome::Done]);
    let elapsed = started.elapsed();
    assert_eq!(
        upload_doc(&app, &upload_id)
            .await
            .get_str("status")
            .unwrap(),
        "done"
    );
    eprintln!(
        "1 GiB 扫描核对耗时 {elapsed:?}（常驻内存 {} MiB）",
        rss() / MIB as u64
    );
}
