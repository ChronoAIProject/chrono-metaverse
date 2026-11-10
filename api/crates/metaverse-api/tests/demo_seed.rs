//! 部署配置种子的集成测试（docs/design/server-slim.md 13.2 S4 的验收）：真实 MongoDB + 模拟 NyxID +
//! 本机 HTTP 文件服务（当 GitHub 和 Scaniverse；种子只在本机地址上允许明文 http，主机列表写
//! `127.0.0.1:<端口>`）。
//!
//! "启动"就是按同一份配置新建一个 `AppState` 再执行种子（与 `main.rs` 里索引建好之后的后台执行相同）；
//! 后台执行器由测试一个一个地领取、执行（`Runner::run_until_idle`）。
//!
//! 覆盖：新库全流程（建空间、下载、按成员打包扫描、核对登记、展开、发布）；已有旧任务的版本什么都不做；
//! 版本加一在同一空间追加；内容没有变化写 `unchanged`；第一次 404、用完次数后重启重新排队、成功；
//! 403、429 先重试；租约丢失后在"追加"和"发布"之间重做，只有一个提交；发布时有冲突自动重放；主机
//! 不在列表、重定向到列表外、哈希不符、清单不合规、来源表缺文件各自失败且不重试；空间不是种子建的不碰；
//! 旧格式配置只记错误、服务照常就绪；多副本同时启动只建一次。

mod ingest_support;
mod runner_support;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Redirect},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ingest_support::*;
use metaverse_api::demo_seed::{
    self, config::DemoSeedConfig, pack::stored_zip, RetryPolicy, SeedError, SeedOutcome,
};
use metaverse_api::runner::{bundle_import, JobFailure, Outcome, Runner, RunnerConfig, SlotClass};
use metaverse_api::AppState;
use metaverse_core::model::{ErrorClass, Space, UploadFormat};
use mongodb::bson::{doc, Bson, Document};
use runner_support::{draco, model_glb};
use serde_json::{json, Value};

const SPACE: &str = "chronoai-lobby";
const TOKEN: &str = "demo-share-token_0123456789abcdefghijklmnopqrstuv";
const SEED_ENV: &str = "METAVERSE_DEMO_SEED";
const TOKEN_ENV: &str = "METAVERSE_DEMO_SHARE_TOKEN";
const HOSTS_ENV: &str = "METAVERSE_DEMO_SEED_HOSTS";
const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

fn once() -> RetryPolicy {
    RetryPolicy {
        attempts: 1,
        first_delay: Duration::ZERO,
        max_delay: Duration::ZERO,
    }
}

const KIB256: usize = 256 * 1024;

fn drc() -> Vec<u8> {
    let mut bytes = b"DRACO\x02\x02\x01\x01".to_vec();
    bytes.extend((0..KIB256 + 4321).map(|i| (i % 251) as u8));
    bytes
}

fn jpg() -> Vec<u8> {
    let mut bytes = b"\xff\xd8\xff\xe0".to_vec();
    bytes.extend((0..200_000).map(|i| (i % 253) as u8));
    bytes
}

/// 一张 `width × height` 的 PNG（只有文件头和 IHDR、IEND，核对只读 IHDR）。
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde]);
    bytes.extend_from_slice(b"\0\0\0\0IEND\xaeB`\x82");
    bytes
}

// ---------------------------------------------------------------------------
// 本机 HTTP 文件服务
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Served {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    /// 某个文件前几次请求返回的状态码（测试重试）。
    statuses: Arc<Mutex<BTreeMap<String, VecDeque<u16>>>>,
    hits: Arc<Mutex<BTreeMap<String, usize>>>,
}

struct FileServer {
    base: String,
    served: Served,
    server: tokio::task::JoinHandle<()>,
}

impl FileServer {
    async fn start() -> Self {
        let served = Served::default();
        let app = Router::new()
            .route(
                "/files/{name}",
                get(
                    |State(served): State<Served>, Path(name): Path<String>| async move {
                        *served.hits.lock().unwrap().entry(name.clone()).or_default() += 1;
                        let status = served
                            .statuses
                            .lock()
                            .unwrap()
                            .get_mut(&name)
                            .and_then(VecDeque::pop_front);
                        if let Some(code) = status {
                            return StatusCode::from_u16(code).unwrap().into_response();
                        }
                        match served.files.lock().unwrap().get(&name) {
                            Some(bytes) => bytes.clone().into_response(),
                            None => StatusCode::NOT_FOUND.into_response(),
                        }
                    },
                ),
            )
            // 本机内的重定向（本机 http → 本机 http，允许跟随）。
            .route(
                "/hop/{name}",
                get(|Path(name): Path<String>| async move {
                    Redirect::temporary(&format!("/files/{name}"))
                }),
            )
            // 重定向到列表外的主机（不跟随，按内容问题失败）。
            .route(
                "/away/{name}",
                get(|Path(name): Path<String>| async move {
                    Redirect::temporary(&format!("http://downgrade.example/files/{name}"))
                }),
            )
            .with_state(served.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base,
            served,
            server,
        }
    }

    /// 主机列表里写的本机地址（带端口）。
    fn host(&self) -> String {
        self.base.trim_start_matches("http://").to_owned()
    }

    fn url(&self, name: &str) -> String {
        format!("{}/files/{name}", self.base)
    }

    fn put(&self, name: &str, bytes: &[u8]) {
        self.served
            .files
            .lock()
            .unwrap()
            .insert(name.to_owned(), bytes.to_vec());
    }

    fn remove(&self, name: &str) {
        self.served.files.lock().unwrap().remove(name);
    }

    fn fail_with(&self, name: &str, codes: &[u16]) {
        self.served
            .statuses
            .lock()
            .unwrap()
            .insert(name.to_owned(), codes.iter().copied().collect());
    }

    fn hits(&self, name: &str) -> usize {
        self.served
            .hits
            .lock()
            .unwrap()
            .get(name)
            .copied()
            .unwrap_or(0)
    }

    fn total_hits(&self) -> usize {
        self.served.hits.lock().unwrap().values().sum()
    }
}

impl Drop for FileServer {
    fn drop(&mut self) {
        self.server.abort();
    }
}

// ---------------------------------------------------------------------------
// 前厅的测试包
// ---------------------------------------------------------------------------

/// 测试用的包文件：扫描（drc + jpg，按成员打包成 zip）、网页用模型、椅子模型、贴图、建模记录。
struct Lobby {
    mesh: Vec<u8>,
    tex: Vec<u8>,
    zip: Vec<u8>,
    web: Vec<u8>,
    chair: Vec<u8>,
    oak: Vec<u8>,
    notes: Vec<u8>,
}

impl Lobby {
    fn new() -> Self {
        let mesh = draco(300 * 1024, 7);
        let tex = jpg();
        let zip = stored_zip(&[("mesh.drc", &mesh), ("tex.jpg", &tex)]).unwrap();
        Self {
            mesh,
            tex,
            zip,
            web: model_glb(3.0),
            chair: model_glb(0.8),
            oak: png(64, 64),
            notes: "# 建模记录\n测试用。\n".as_bytes().to_vec(),
        }
    }

    fn entries(&self) -> Vec<(&'static str, &'static str, &[u8])> {
        vec![
            ("scan/scan.zip", "scan", &self.zip),
            ("web/scan-0.glb", "webmodel", &self.web),
            ("models/chair.glb", "model", &self.chair),
            ("textures/oak.png", "texture", &self.oak),
            ("notes.md", "script", &self.notes),
        ]
    }

    fn files(&self) -> Vec<Value> {
        self.entries()
            .into_iter()
            .map(|(path, purpose, bytes)| {
                json!({"path": path, "purpose": purpose, "sha256": sha256_hex(bytes), "size": bytes.len()})
            })
            .collect()
    }

    fn total_bytes(&self) -> usize {
        self.entries().iter().map(|(_, _, bytes)| bytes.len()).sum()
    }

    fn manifest(&self, note: &str, body: Value) -> Value {
        let mut manifest = json!({
            "format": "chrono-metaverse-rebuild-bundle",
            "version": 1,
            "tool": {"name": "metaverse-recon", "version": "0.2.0"},
            "note": note,
            "createdAt": "2026-11-01T00:00:00.000Z",
            "files": self.files(),
        });
        for (key, value) in body.as_object().unwrap() {
            manifest[key] = value.clone();
        }
        manifest
    }

    /// 完整的包：扫描、整体替换重建层（模板 + 实例、只有模型的椅子、带贴图的柜台）、锚点、建模记录。
    fn full(&self) -> Value {
        self.manifest(
            "测试种子包",
            json!({
                "scan": {"assetHash": sha256_hex(&self.zip), "webModelHashes": [sha256_hex(&self.web)],
                         "transform": IDENTITY, "observedAt": "2026-10-20T00:00:00.000Z",
                         "alignment": {"method": "given", "rotationDeg": -61.42}},
                "rebuilt": {"mode": "replace",
                    "templates": [{"entityId": "rb.stool", "layer": "rebuilt", "kind": "template",
                        "shape": {"type": "box", "size": [0.4, 0.45, 0.4]},
                        "bounds": {"min": [-0.2, 0, -0.2], "max": [0.2, 0.45, 0.2]}}],
                    "entities": [
                        {"entityId": "rb.stool-1", "layer": "rebuilt", "kind": "object",
                         "shape": {"type": "instance", "template": "rb.stool",
                                   "transform": {"position": [8, 0, 8]}},
                         "bounds": {"min": [7.8, 0, 7.8], "max": [8.2, 0.45, 8.2]}},
                        {"entityId": "rb.chair-1", "layer": "rebuilt", "kind": "object",
                         "assetHash": sha256_hex(&self.chair), "anchorId": "counter",
                         "bounds": {"min": [3.5, 0, 4.5], "max": [4.5, 0.8, 5.5]}},
                        {"entityId": "rb.counter", "layer": "rebuilt", "kind": "object",
                         "anchorId": "counter",
                         "shape": {"type": "box", "size": [2, 1, 0.6], "transform": {"position": [5, 0, 5]},
                                   "material": {"texture": sha256_hex(&self.oak), "uv": "box"}},
                         "bounds": {"min": [4, 0, 4.7], "max": [6, 1, 5.3]}}
                    ]},
                "anchors": [{"anchorId": "counter", "kind": "counter", "box": [70, 0, 90, 125, 20, 110],
                             "label": "前台", "visibility": "public"}],
                "notes": sha256_hex(&self.notes),
                "report": {"fit": {"meanCm": 4.3}},
            }),
        )
    }

    /// 合并包：只加一件物件（文件表照样列出全部文件）。
    fn merge(&self) -> Value {
        self.manifest(
            "加一张边几",
            json!({"rebuilt": {"mode": "merge", "entities": [
                {"entityId": "rb.side-table", "layer": "rebuilt", "kind": "object",
                 "shape": {"type": "box", "size": [0.6, 0.5, 0.6], "transform": {"position": [2, 0, 2]}},
                 "bounds": {"min": [1.7, 0, 1.7], "max": [2.3, 0.5, 2.3]}}
            ]}}),
        )
    }

    /// 来源表：扫描按成员打包，其余按哈希命名放在 `/files/` 下。
    fn sources(&self, server: &FileServer) -> Value {
        let mut files = serde_json::Map::new();
        files.insert(
            sha256_hex(&self.zip),
            json!({"zip": [
                {"name": "mesh.drc", "url": server.url("mesh.drc"), "sha256": sha256_hex(&self.mesh), "size": self.mesh.len()},
                {"name": "tex.jpg", "url": server.url("tex.jpg"), "sha256": sha256_hex(&self.tex), "size": self.tex.len()},
            ]}),
        );
        for (_, _, bytes) in self.entries().into_iter().skip(1) {
            let hash = sha256_hex(bytes);
            files.insert(hash.clone(), json!({"url": server.url(&hash)}));
        }
        json!({"format": "chrono-metaverse-bundle-sources", "version": 1, "files": files})
    }

    /// 把全部文件放到文件服务上。
    fn serve(&self, server: &FileServer) {
        server.put("mesh.drc", &self.mesh);
        server.put("tex.jpg", &self.tex);
        for (_, _, bytes) in self.entries().into_iter().skip(1) {
            server.put(&sha256_hex(bytes), bytes);
        }
    }
}

/// 一份种子配置（清单和来源表放到文件服务上，按哈希固定）。
fn seed_json(
    server: &FileServer,
    space: &str,
    revision: u32,
    manifest: &Value,
    sources: &Value,
) -> String {
    let manifest = serde_json::to_vec(manifest).unwrap();
    let sources = serde_json::to_vec(sources).unwrap();
    let manifest_name = format!("manifest-{}.json", sha256_hex(&manifest));
    let sources_name = format!("sources-{}.json", sha256_hex(&sources));
    server.put(&manifest_name, &manifest);
    server.put(&sources_name, &sources);
    json!({
        "spaceId": space,
        "name": "ChronoAI 前厅",
        "description": "测试用的演示空间",
        "owner": {"kind": "org", "id": ORG},
        "visibility": "unlisted",
        "revision": revision,
        "bundle": {
            "manifest": {"url": server.url(&manifest_name), "sha256": sha256_hex(&manifest), "size": manifest.len()},
            "sources": {"url": server.url(&sources_name), "sha256": sha256_hex(&sources), "size": sources.len()},
        },
    })
    .to_string()
}

/// 解析一份种子配置（用来在同一个库上换配置再执行）。
fn parse_seed(seed: &str, hosts: &str) -> DemoSeedConfig {
    DemoSeedConfig::from_lookup(
        &|name| match name {
            SEED_ENV => Some(seed.to_owned()),
            TOKEN_ENV => Some(TOKEN.to_owned()),
            HOSTS_ENV => Some(hosts.to_owned()),
            _ => None,
        },
        16 << 20,
    )
    .unwrap()
    .unwrap()
}

async fn start(server: &FileServer, seed: &str) -> Option<TestApp> {
    let hosts = server.host();
    TestApp::start(&[(SEED_ENV, seed), (TOKEN_ENV, TOKEN), (HOSTS_ENV, &hosts)]).await
}

/// 按同一份配置"重新启动"：新建 `AppState` 连同一个库。
async fn restart(app: &TestApp) -> AppState {
    let state = AppState::from_config(&app.config).await.unwrap();
    state.prepare().await.unwrap();
    state
}

/// 用应用配置（含种子主机列表）的执行器。
fn runner(app: &TestApp, instance: &str) -> Arc<Runner> {
    Runner::new(
        app.state.clone(),
        RunnerConfig {
            instance_id: instance.to_owned(),
            ..app.config.runner.clone()
        },
    )
}

async fn count(app: &TestApp, collection: &str, filter: Document) -> u64 {
    app.collection(collection)
        .count_documents(filter)
        .await
        .unwrap()
}

async fn job(app: &TestApp, id: &str) -> Document {
    app.collection("jobs")
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .expect("任务存在")
}

async fn space_doc(app: &TestApp, id: &str) -> Document {
    app.collection("spaces")
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .expect("空间存在")
}

fn int(value: Option<&Bson>) -> i64 {
    match value {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        other => panic!("不是整数：{other:?}"),
    }
}

fn result_of(job: &Document) -> Value {
    serde_json::to_value(job.get_document("result").expect("任务结果")).unwrap()
}

/// 一直执行到任务结束：退回队列的去掉 `notBefore`（模拟退避时间已过）再领取。返回每次的结局。
async fn run_to_end(app: &TestApp, runner: &Arc<Runner>, job_id: &str) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    for _ in 0..10 {
        outcomes.extend(runner.run_until_idle().await);
        let status = job(app, job_id).await.get_str("status").unwrap().to_owned();
        if status != "queued" {
            break;
        }
        app.collection("jobs")
            .update_one(doc! {"_id": job_id}, doc! {"$unset": {"notBefore": ""}})
            .await
            .unwrap();
    }
    outcomes
}

fn created_job(outcome: SeedOutcome) -> String {
    match outcome {
        SeedOutcome::Created {
            job_id: Some(job_id),
        }
        | SeedOutcome::Queued { job_id } => job_id,
        other => panic!("应当建导入任务，实际 {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

/// 新库全流程：建空间、下载、按成员打包扫描、核对登记、展开、发布；再次启动什么都不做。
#[tokio::test]
async fn new_database_imports_the_bundle_and_restart_does_nothing() {
    let server = FileServer::start().await;
    let lobby = Lobby::new();
    lobby.serve(&server);
    let manifest = lobby.full();
    let seed = seed_json(&server, SPACE, 4, &manifest, &lobby.sources(&server));
    let Some(app) = start(&server, &seed).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let job_id = created_job(demo_seed::run(&app.state, &config, once()).await.unwrap());

    // 空间、第一次提交、任务（启动时只下载了清单和来源表）。
    let space = space_doc(&app, SPACE).await;
    assert_eq!(
        space.get_document("owner").unwrap().get_str("id").unwrap(),
        ORG
    );
    assert_eq!(
        space
            .get_document("ownerEvidence")
            .unwrap()
            .get_str("basis")
            .unwrap(),
        "operator_seed"
    );
    assert_eq!(count(&app, "commits", doc! {"spaceId": SPACE}).await, 1);
    assert_eq!(server.hits("mesh.drc"), 0, "启动时不下载包里的文件");
    let queued = job(&app, &job_id).await;
    assert_eq!(queued.get_str("kind").unwrap(), "bundle_import");
    assert_eq!(queued.get_str("status").unwrap(), "queued");
    assert_eq!(queued.get_str("scope").unwrap(), "rebuild");
    assert_eq!(int(queued.get("maxAttempts")), 5);
    assert_eq!(
        queued
            .get_document("actor")
            .unwrap()
            .get_str("sub")
            .unwrap(),
        "system:demo-seed"
    );
    let params = queued.get_document("params").unwrap();
    assert_eq!(int(params.get("revision")), 4);
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    let manifest_hash = sha256_hex(&manifest_bytes);
    assert_eq!(
        params
            .get_document("manifest")
            .unwrap()
            .get_str("sha256")
            .unwrap(),
        manifest_hash
    );

    // 执行器：下载、打包、核对、登记、展开、发布，一次做完。
    let outcomes = runner(&app, "seed-a").run_until_idle().await;
    assert_eq!(outcomes, vec![Outcome::Done]);
    let done = job(&app, &job_id).await;
    assert_eq!(done.get_str("status").unwrap(), "done", "{done:?}");
    let result = result_of(&done);
    assert_eq!(
        result["files"],
        json!({"total": 6, "reused": 0, "downloaded": 6,
               "bytes": lobby.total_bytes() + manifest_bytes.len()})
    );
    assert_eq!(result["manifest"], manifest_hash);
    assert_eq!(result["seq"], 2);
    assert_eq!(result["anchors"]["created"], json!(["counter"]));
    assert!(result.get("unchanged").is_none());
    let commit_id = result["commitId"].as_str().unwrap().to_owned();
    assert_eq!(done.get_str("resultCommitId").unwrap(), commit_id);

    // 提交：发布者类别 rebuild、带任务编号、扫描、包清单、说明、拍摄时间。
    let commit = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": 2})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commit.get_str("_id").unwrap(), commit_id);
    assert_eq!(commit.get_str("jobId").unwrap(), job_id);
    assert_eq!(commit.get_str("bundleRef").unwrap(), manifest_hash);
    assert_eq!(
        commit.get_str("message").unwrap(),
        "测试种子包（部署配置种子第 4 版）"
    );
    assert_eq!(
        commit.get_str("observedAt").unwrap(),
        "2026-10-20T00:00:00.000Z"
    );
    assert_eq!(
        commit.get_str("scriptRef").unwrap(),
        sha256_hex(&lobby.notes)
    );
    let actor = commit.get_document("actor").unwrap();
    assert_eq!(actor.get_str("sub").unwrap(), "system:demo-seed");
    assert_eq!(actor.get_str("nyxServiceId").unwrap(), "");
    assert_eq!(actor.get_str("scope").unwrap(), "rebuild");
    assert_eq!(actor.get_str("kind").unwrap(), "rebuild");
    let zip_hash = sha256_hex(&lobby.zip);
    assert_eq!(
        commit
            .get_document("scan")
            .unwrap()
            .get_str("assetHash")
            .unwrap(),
        zip_hash
    );
    let changed: Vec<&str> = commit
        .get_array("changedEntities")
        .unwrap()
        .iter()
        .map(|change| change.as_document().unwrap().get_str("id").unwrap())
        .collect();
    for id in ["rb.stool", "rb.stool-1", "rb.chair-1", "rb.counter"] {
        assert!(changed.contains(&id), "{id}: {changed:?}");
    }
    // 第一次带扫描的提交固定坐标系。
    let space = space_doc(&app, SPACE).await;
    assert_eq!(
        space
            .get_document("frame")
            .unwrap()
            .get_str("referenceScan")
            .unwrap(),
        zip_hash
    );

    // 扫描按成员打包：字节与打包规则一致，核对出网格成员。
    let scan = app
        .collection("assets.files")
        .find_one(doc! {"filename": &zip_hash})
        .await
        .unwrap()
        .expect("扫描已登记");
    let check = scan
        .get_document("metadata")
        .unwrap()
        .get_document("check")
        .unwrap();
    assert_eq!(check.get_str("format").unwrap(), "zip");
    assert_eq!(check.get_str("mesh").unwrap(), "mesh.drc");
    assert_eq!(int(scan.get("length")), lobby.zip.len() as i64);
    // 每个文件都经过一个系统身份、重建范围的上传会话（计入存储用量）。
    assert_eq!(
        count(
            &app,
            "uploads",
            doc! {"spaceId": SPACE, "status": "done", "scope": "rebuild", "actor.sub": "system:demo-seed"}
        )
        .await,
        6
    );
    assert_eq!(
        int(space.get("storageUsedBytes")),
        (lobby.total_bytes() + manifest_bytes.len()) as i64
    );
    // assetRefs 只登记可预览的资源（网页用模型、物件模型、贴图）。
    let refs: Vec<String> = app
        .collection("assetRefs")
        .distinct("hash", doc! {"spaceId": SPACE})
        .await
        .unwrap()
        .into_iter()
        .map(|hash| hash.as_str().unwrap().to_owned())
        .collect();
    for hash in [&lobby.web, &lobby.chair, &lobby.oak].map(|bytes| sha256_hex(bytes)) {
        assert!(refs.contains(&hash), "{hash}");
    }
    for hash in [
        zip_hash.clone(),
        manifest_hash.clone(),
        sha256_hex(&lobby.notes),
    ] {
        assert!(!refs.contains(&hash), "{hash} 不该公开");
    }
    // 草稿已发布。
    let draft = app
        .collection("drafts")
        .find_one(doc! {"_id": bundle_import::seed_draft_id(&job_id)})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.get_str("status").unwrap(), "published");

    // 凭分享链接能看到重建层。
    let snapshot = app
        .public(
            &format!("/api/public/spaces/{SPACE}/snapshot?seq=2"),
            Some(&format!("Share {TOKEN}")),
            &[],
        )
        .await;
    assert_eq!(snapshot.status, StatusCode::OK, "{:?}", snapshot.body);
    assert!(snapshot.body.to_string().contains("rb.counter"));

    // 再次启动：任务已经存在，什么都不做、不下载。
    let hits = server.total_hits();
    let again = demo_seed::run(&restart(&app).await, &config, once())
        .await
        .unwrap();
    assert_eq!(again, SeedOutcome::AlreadyDone { job_id });
    assert_eq!(server.total_hits(), hits);
    assert_eq!(count(&app, "jobs", doc! {"spaceId": SPACE}).await, 1);
    assert_eq!(count(&app, "commits", doc! {"spaceId": SPACE}).await, 2);
}

/// 线上第 1–3 版的旧任务还在：同一版本什么都不做；版本加一在同一空间追加；内容没有变化写
/// `unchanged`；配置换了主人不碰；没有包时只保证空间存在。
#[tokio::test]
async fn old_revisions_are_kept_and_new_revisions_append() {
    let server = FileServer::start().await;
    let lobby = Lobby::new();
    lobby.serve(&server);
    let sources = lobby.sources(&server);
    // 先只建空间（不带包）：模拟线上已有的种子空间。
    let bare =
        json!({"spaceId": SPACE, "name": "ChronoAI 前厅", "owner": {"kind": "org", "id": ORG},
                      "visibility": "unlisted", "revision": 3})
        .to_string();
    let Some(app) = start(&server, &bare).await else {
        return;
    };
    let hosts = server.host();
    let config = app.config.demo_seed.clone().unwrap();
    assert_eq!(
        demo_seed::run(&app.state, &config, once()).await.unwrap(),
        SeedOutcome::Created { job_id: None }
    );
    assert_eq!(
        demo_seed::run(&app.state, &config, once()).await.unwrap(),
        SeedOutcome::NothingToImport
    );
    assert_eq!(count(&app, "commits", doc! {"spaceId": SPACE}).await, 1);
    // 线上第 3 版的 scan_import 任务（同一个编号公式）。
    let space: Space =
        mongodb::bson::deserialize_from_document(space_doc(&app, SPACE).await).unwrap();
    let old_job = demo_seed::seed_job_id(&space, 3);
    app.collection("jobs")
        .insert_one(doc! {
            "_id": &old_job, "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "kind": "scan_import", "params": {"assetHash": "a".repeat(64)}, "status": "done",
            "attempt": 1, "maxAttempts": 3, "createdAt": ago(3600),
        })
        .await
        .unwrap();
    let third = parse_seed(
        &seed_json(&server, SPACE, 3, &lobby.full(), &sources),
        &hosts,
    );
    assert_eq!(
        demo_seed::run(&app.state, &third, once()).await.unwrap(),
        SeedOutcome::AlreadyDone {
            job_id: old_job.clone()
        }
    );
    assert_eq!(server.total_hits(), 0, "旧版本的任务在：什么都不下载");

    // 第 4 版：在同一个空间里追加。
    let fourth = parse_seed(
        &seed_json(&server, SPACE, 4, &lobby.full(), &sources),
        &hosts,
    );
    let job4 = created_job(demo_seed::run(&app.state, &fourth, once()).await.unwrap());
    assert_ne!(job4, old_job);
    let worker = runner(&app, "seed-a");
    assert_eq!(worker.run_until_idle().await, vec![Outcome::Done]);
    assert_eq!(result_of(&job(&app, &job4).await)["seq"], 2);

    // 第 5 版合并一件物件：文件都已在空间里，只下载新清单。
    let fifth = parse_seed(
        &seed_json(&server, SPACE, 5, &lobby.merge(), &sources),
        &hosts,
    );
    let job5 = created_job(demo_seed::run(&app.state, &fifth, once()).await.unwrap());
    let hits = server.hits("mesh.drc");
    assert_eq!(worker.run_until_idle().await, vec![Outcome::Done]);
    let result = result_of(&job(&app, &job5).await);
    assert_eq!(result["files"]["downloaded"], 1, "{result}");
    assert_eq!(result["files"]["reused"], 5);
    assert_eq!(result["seq"], 3);
    assert_eq!(server.hits("mesh.drc"), hits);
    let commit = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": 3})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        commit.get_str("message").unwrap(),
        "加一张边几（部署配置种子第 5 版）"
    );
    assert!(commit.get("scan").is_none(), "合并包不带扫描");

    // 第 6 版是同一个合并包：内容没有变化，不写提交，任务结果 unchanged。
    let sixth = parse_seed(
        &seed_json(&server, SPACE, 6, &lobby.merge(), &sources),
        &hosts,
    );
    let job6 = created_job(demo_seed::run(&app.state, &sixth, once()).await.unwrap());
    assert_eq!(worker.run_until_idle().await, vec![Outcome::Done]);
    let six = job(&app, &job6).await;
    let result = result_of(&six);
    assert_eq!(result["unchanged"], true, "{result}");
    assert_eq!(result["seq"], 3);
    assert!(six.get("resultCommitId").is_none());
    assert_eq!(count(&app, "commits", doc! {"spaceId": SPACE}).await, 3);
    let draft = app
        .collection("drafts")
        .find_one(doc! {"_id": bundle_import::seed_draft_id(&job6)})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.get_str("status").unwrap(), "published");
    assert!(draft.get_bool("unchanged").unwrap());

    // 配置换了主人（别的组织）：种子建的空间也不归它，什么都不做、不下载。
    let hits = server.total_hits();
    let mut foreign: Value =
        serde_json::from_str(&seed_json(&server, SPACE, 7, &lobby.full(), &sources)).unwrap();
    foreign["owner"]["id"] = json!(OTHER_ORG);
    let hits_after_put = server.total_hits();
    assert_eq!(hits, hits_after_put);
    assert_eq!(
        demo_seed::run(
            &app.state,
            &parse_seed(&foreign.to_string(), &hosts),
            once()
        )
        .await
        .unwrap(),
        SeedOutcome::Foreign
    );
    assert_eq!(server.total_hits(), hits);

    // 别人建的空间：种子不碰。
    app.create_space(who(ORG), "someone-else", "org", ORG, "unlisted")
        .await;
    let other = parse_seed(
        &seed_json(&server, "someone-else", 1, &lobby.full(), &sources),
        &hosts,
    );
    assert_eq!(
        demo_seed::run(&app.state, &other, once()).await.unwrap(),
        SeedOutcome::Foreign
    );
    assert_eq!(
        count(&app, "jobs", doc! {"spaceId": "someone-else"}).await,
        0
    );
}

/// 第一次 404：按退避重试，次数用完后失败（`fetch`）；重启时重新排队（错误进 `history`），文件
/// 补上以后成功。403、429 也是先重试。
#[tokio::test]
async fn fetch_failures_retry_and_requeue_on_restart() {
    let server = FileServer::start().await;
    let lobby = Lobby::new();
    lobby.serve(&server);
    let web = sha256_hex(&lobby.web);
    server.remove(&web);
    let seed = seed_json(&server, SPACE, 4, &lobby.full(), &lobby.sources(&server));
    let Some(app) = start(&server, &seed).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let job_id = created_job(demo_seed::run(&app.state, &config, once()).await.unwrap());
    let worker = runner(&app, "seed-a");
    let outcomes = run_to_end(&app, &worker, &job_id).await;
    assert_eq!(
        outcomes,
        vec![
            Outcome::Retrying(ErrorClass::Fetch),
            Outcome::Retrying(ErrorClass::Fetch),
            Outcome::Retrying(ErrorClass::Fetch),
            Outcome::Retrying(ErrorClass::Fetch),
            Outcome::Failed(ErrorClass::Fetch),
        ]
    );
    let failed = job(&app, &job_id).await;
    let error = failed.get_document("lastError").unwrap();
    assert_eq!(error.get_str("class").unwrap(), "fetch");
    let message = error.get_str("message").unwrap();
    assert!(
        message.contains("web/scan-0.glb") && message.contains("404"),
        "{message}"
    );
    assert!(
        !message.contains("http://"),
        "错误说明不带完整地址：{message}"
    );
    assert_eq!(count(&app, "commits", doc! {"spaceId": SPACE}).await, 1);

    // 重启：上次因为下载失败而失败，重新排队。
    let restarted = restart(&app).await;
    assert_eq!(
        demo_seed::run(&restarted, &config, once()).await.unwrap(),
        SeedOutcome::Requeued {
            job_id: job_id.clone()
        }
    );
    let requeued = job(&app, &job_id).await;
    assert_eq!(requeued.get_str("status").unwrap(), "queued");
    assert_eq!(int(requeued.get("attempt")), 0);
    assert!(requeued.get("notBefore").is_none());
    let history = requeued.get_array("history").unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(
        history[0].as_document().unwrap().get_str("class").unwrap(),
        "fetch"
    );
    // 已经在重新排队（或已在运行）：再启动一次什么都不做。
    assert_eq!(
        demo_seed::run(&restarted, &config, once()).await.unwrap(),
        SeedOutcome::AlreadyDone {
            job_id: job_id.clone()
        }
    );

    // 补上文件；另一个文件先 403、再 429：都按退避重试，最后成功。已下载、登记的文件不再下载。
    server.put(&web, &lobby.web);
    let chair = sha256_hex(&lobby.chair);
    server.fail_with(&chair, &[403, 429]);
    let mesh_hits = server.hits("mesh.drc");
    let outcomes = run_to_end(&app, &worker, &job_id).await;
    assert_eq!(
        outcomes,
        vec![
            Outcome::Retrying(ErrorClass::Fetch),
            Outcome::Retrying(ErrorClass::Fetch),
            Outcome::Done,
        ]
    );
    assert_eq!(server.hits("mesh.drc"), mesh_hits, "扫描已登记，不再下载");
    let done = job(&app, &job_id).await;
    assert_eq!(done.get_str("status").unwrap(), "done");
    assert_eq!(result_of(&done)["seq"], 2);
}

/// 租约丢失后在"追加"和"发布"之间重做：新的持有者不再下载、直接发布；旧的持有者什么都写不进去，
/// 只有一个提交。
#[tokio::test]
async fn lease_lost_between_append_and_publish_commits_once() {
    let server = FileServer::start().await;
    let lobby = Lobby::new();
    lobby.serve(&server);
    let seed = seed_json(&server, SPACE, 4, &lobby.full(), &lobby.sources(&server));
    let Some(app) = start(&server, &seed).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let job_id = created_job(demo_seed::run(&app.state, &config, once()).await.unwrap());
    let a = runner(&app, "seed-a");
    let lease_a = a
        .claim(SlotClass::Heavy, metaverse_api::now().unwrap())
        .await
        .unwrap()
        .expect("领到种子任务");
    let prepared = bundle_import::prepare_import(&a, &lease_a)
        .await
        .unwrap()
        .expect("展开好、等发布");
    assert_eq!(prepared.draft_id(), bundle_import::seed_draft_id(&job_id));
    let draft = app
        .collection("drafts")
        .find_one(doc! {"_id": prepared.draft_id()})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        draft.get_str("bundleRef").unwrap(),
        sha256_hex(&serde_json::to_vec(&lobby.full()).unwrap())
    );
    // A 的租约过期，B 领取：草稿已经展开，不再下载，直接发布。
    runner_support::expire_lease(&app, &job_id).await;
    let hits = server.total_hits();
    let b = runner(&app, "seed-b");
    assert_eq!(b.run_until_idle().await, vec![Outcome::Done]);
    assert_eq!(server.total_hits(), hits, "B 没有再下载");
    let done = job(&app, &job_id).await;
    assert_eq!(done.get_str("status").unwrap(), "done");
    assert_eq!(done.get_str("leaseOwner").unwrap(), "seed-b");
    let result = result_of(&done);
    assert_eq!(
        result["files"]["downloaded"], 6,
        "摘要沿用 A 展开时写的进度"
    );
    // A 回来发布：租约已经丢了，什么都写不进去。
    let late = bundle_import::publish_import(&a, &lease_a, prepared).await;
    assert_eq!(late, Err(JobFailure::LeaseLost));
    assert_eq!(a.settle(&lease_a, late).await, Outcome::LeaseLost);
    assert_eq!(
        count(&app, "commits", doc! {"spaceId": SPACE, "jobId": &job_id}).await,
        1
    );
    assert_eq!(count(&app, "commits", doc! {"spaceId": SPACE}).await, 2);
    assert_eq!(job(&app, &job_id).await.get_str("status").unwrap(), "done");
}

/// 发布时有冲突（展开以后别人在实体区草稿里建了同编号的锚点）：自动在最新版本上重放，锚点按
/// `ifNew` 跳过，物件照常写进去。
#[tokio::test]
async fn publish_conflict_replays_on_the_latest_version() {
    let server = FileServer::start().await;
    let lobby = Lobby::new();
    lobby.serve(&server);
    let seed = seed_json(&server, SPACE, 4, &lobby.full(), &lobby.sources(&server));
    let Some(app) = start(&server, &seed).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let job_id = created_job(demo_seed::run(&app.state, &config, once()).await.unwrap());
    let a = runner(&app, "seed-a");
    let lease = a
        .claim(SlotClass::Heavy, metaverse_api::now().unwrap())
        .await
        .unwrap()
        .unwrap();
    let prepared = bundle_import::prepare_import(&a, &lease)
        .await
        .unwrap()
        .unwrap();
    // 组织在实体区草稿里先建了 counter 锚点（没定义实体区的空间，实体区路径可以写）。
    let base = format!("/api/v1/spaces/{SPACE}");
    let reply = app
        .call(who(ORG), Method::POST, &format!("{base}/drafts"), None)
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let draft = reply.body["id"].as_str().unwrap().to_owned();
    let anchor = json!({"anchorId": "counter", "kind": "counter", "box": [0, 0, 0, 10, 10, 10],
                        "label": "人工建的前台", "visibility": "public"});
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{base}/drafts/{draft}/ops"),
            Some(json!({"ops": [{"op": "createAnchor", "anchor": anchor}]})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{base}/drafts/{draft}/publish"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 2);
    // 种子发布：冲突（anchor:counter），自动重放。
    let published = bundle_import::publish_import(&a, &lease, prepared).await;
    assert_eq!(published, Ok(()));
    let done = job(&app, &job_id).await;
    assert_eq!(done.get_str("status").unwrap(), "done");
    assert_eq!(result_of(&done)["seq"], 3);
    let commit = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": 3})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commit.get_str("jobId").unwrap(), job_id);
    assert!(commit.get_array("changedAnchors").unwrap().is_empty());
    assert!(!commit.get_array("changedEntities").unwrap().is_empty());
    let current = app
        .collection("anchors")
        .find_one(doc! {"spaceId": SPACE, "id": "counter"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current
            .get_document("body")
            .unwrap()
            .get_str("label")
            .unwrap(),
        "人工建的前台",
        "人建的锚点不被种子覆盖"
    );
}

/// 内容问题各自失败且不重试：启动时的清单哈希不符、清单不合规、来源表的主机不在列表里（不建空间、
/// 不插任务）；执行时的重定向到列表外、文件哈希不符、来源表缺文件（任务失败，`content`）。
#[tokio::test]
async fn content_failures_are_not_retried() {
    let server = FileServer::start().await;
    let lobby = Lobby::new();
    lobby.serve(&server);
    let sources = lobby.sources(&server);
    let bare = json!({"spaceId": "unused", "name": "占位", "owner": {"kind": "org", "id": ORG},
                      "visibility": "public"})
    .to_string();
    let Some(app) = start(&server, &bare).await else {
        return;
    };
    let hosts = server.host();

    // 启动时就失败的：不建空间、不插任务。
    let mut wrong_hash: Value =
        serde_json::from_str(&seed_json(&server, "lobby-a", 1, &lobby.full(), &sources)).unwrap();
    wrong_hash["bundle"]["manifest"]["sha256"] = json!("0".repeat(64));
    let mut not_bundle = lobby.full();
    not_bundle["format"] = json!("something-else");
    let mut far_sources = sources.clone();
    let web = sha256_hex(&lobby.web);
    far_sources["files"][&web] = json!({"url": "https://elsewhere.example/web.glb"});
    for (label, seed, expected) in [
        ("清单哈希不符", wrong_hash.to_string(), "sha256"),
        (
            "清单不合规",
            seed_json(&server, "lobby-b", 1, &not_bundle, &sources),
            "清单不合规",
        ),
        (
            "来源表的主机不在列表",
            seed_json(&server, "lobby-c", 1, &lobby.full(), &far_sources),
            "不在允许下载",
        ),
    ] {
        let config = parse_seed(&seed, &hosts);
        match demo_seed::run(&app.state, &config, once()).await {
            Err(SeedError::Permanent(message)) => {
                assert!(message.contains(expected), "{label}: {message}")
            }
            other => panic!("{label}：应当失败，实际 {other:?}"),
        }
    }
    assert_eq!(count(&app, "spaces", doc! {}).await, 0);
    assert_eq!(count(&app, "jobs", doc! {}).await, 0);

    // 执行时才发现的：任务失败（content），不重试。
    let chair = sha256_hex(&lobby.chair);
    let mut redirected = sources.clone();
    redirected["files"][&chair] = json!({"url": format!("{}/away/{chair}", server.base)});
    let mut corrupted = lobby.chair.clone();
    corrupted[40] ^= 0xff;
    server.put("chair-corrupted.glb", &corrupted);
    let mut swapped = sources.clone();
    swapped["files"][&chair] = json!({"url": server.url("chair-corrupted.glb")});
    let mut missing = sources.clone();
    missing["files"].as_object_mut().unwrap().remove(&chair);
    let mut jobs = Vec::new();
    for (space, table, expected) in [
        ("lobby-d", &redirected, "重定向"),
        ("lobby-e", &swapped, "sha256"),
        ("lobby-f", &missing, "来源表也没给"),
    ] {
        let config = parse_seed(&seed_json(&server, space, 1, &lobby.full(), table), &hosts);
        let job_id = created_job(demo_seed::run(&app.state, &config, once()).await.unwrap());
        jobs.push((job_id, expected));
    }
    let outcomes = runner(&app, "seed-a").run_until_idle().await;
    assert_eq!(outcomes, vec![Outcome::Failed(ErrorClass::Content); 3]);
    for (job_id, expected) in jobs {
        let failed = job(&app, &job_id).await;
        assert_eq!(failed.get_str("status").unwrap(), "failed");
        assert_eq!(int(failed.get("attempt")), 1, "不重试");
        let error = failed.get_document("lastError").unwrap();
        assert_eq!(error.get_str("class").unwrap(), "content");
        let message = error.get_str("message").unwrap();
        assert!(message.contains(expected), "{expected}: {message}");
        assert!(message.contains("models/chair.glb"), "{message}");
        assert!(
            !message.contains("http://"),
            "错误说明不带完整地址：{message}"
        );
    }
    assert_eq!(
        count(&app, "commits", doc! {"jobId": {"$exists": true}}).await,
        0
    );
}

/// 旧格式的种子（处理服务时代的 files、hints、authored……）：只记错误日志、跳过，服务照常就绪。
#[tokio::test]
async fn legacy_seed_is_skipped_and_the_service_starts() {
    let legacy = json!({
        "spaceId": SPACE, "name": "ChronoAI 前厅", "owner": {"kind": "org", "id": ORG},
        "visibility": "unlisted", "revision": 3,
        "files": [{"url": "https://scaniverse.com/api/media/x/mesh.drc", "name": "mesh.drc",
                   "sha256": "a".repeat(64), "size": 1000}],
        "rebuild": true, "voxelize": false, "hints": {"objects": []},
    })
    .to_string();
    let Some(app) = TestApp::start(&[(SEED_ENV, &legacy), (TOKEN_ENV, TOKEN)]).await else {
        return;
    };
    assert!(app.config.demo_seed.is_none());
    let health = app.public("/api/healthz", None, &[]).await;
    assert_eq!(health.status, StatusCode::OK, "{:?}", health.body);
    assert_eq!(count(&app, "spaces", doc! {}).await, 0);
}

/// 多副本同时启动：空间和导入任务都只建一个。
#[tokio::test]
async fn concurrent_replicas_create_once() {
    let server = FileServer::start().await;
    let lobby = Lobby::new();
    lobby.serve(&server);
    let seed = seed_json(&server, SPACE, 4, &lobby.full(), &lobby.sources(&server));
    let Some(app) = start(&server, &seed).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let replicas = [
        restart(&app).await,
        restart(&app).await,
        restart(&app).await,
    ];
    let outcomes = futures_util::future::join_all(
        replicas
            .iter()
            .map(|state| demo_seed::run(state, &config, once())),
    )
    .await;
    let outcomes: Vec<SeedOutcome> = outcomes.into_iter().map(Result::unwrap).collect();
    let made = outcomes
        .iter()
        .filter(|o| matches!(o, SeedOutcome::Created { .. } | SeedOutcome::Queued { .. }))
        .count();
    assert_eq!(made, 1, "只有一个副本建成任务：{outcomes:?}");
    assert_eq!(count(&app, "spaces", doc! {"_id": SPACE}).await, 1);
    assert_eq!(count(&app, "jobs", doc! {"spaceId": SPACE}).await, 1);
    assert_eq!(
        count(&app, "commits", doc! {"spaceId": SPACE}).await,
        1,
        "第一次提交只写一次"
    );
}

/// 跨语言向量 `tests/vectors/demo_seed_zip.json`：种子打包出的 zip 字节，以及登记资源时写的
/// `metadata.format` / `contentType`。这里用 Rust 实现重算并核对（`METAVERSE_WRITE_VECTORS=1` 时重新
/// 生成）；本地重建工具的 `recon/tests/test_demo_seed_zip.py` 读同一个文件，用它自己的格式嗅探和
/// 解包核对。两边都在持续集成里跑，不依赖本机有没有装本地重建工具。
#[test]
fn packed_zip_vector_matches_the_implementation() {
    let mut mesh = b"DRACO\x02\x02\x01\x01".to_vec();
    mesh.extend((0..600_u32).map(|i| (i % 251) as u8));
    let mut texture = b"\xff\xd8\xff\xe0".to_vec();
    texture.extend((0..900_u32).map(|i| (i % 253) as u8));
    let zipped = stored_zip(&[("mesh.drc", &mesh), ("tex.jpg", &texture)]).unwrap();
    let member = |name: &str, bytes: &[u8]| json!({"name": name, "base64": STANDARD.encode(bytes), "sha256": sha256_hex(bytes)});
    // `registered`、`single` 是格式嗅探的结果（接口服务按核对记录登记的 `format` 对 zip 也是 "zip"；
    // 单独一个 drc 在本地工具里叫 "draco"），由 Python 那边核对。
    let vector = json!({
        "kind": "demo-seed-zip",
        "description": "部署配置种子把网格 + 贴图打包成的 stored zip（固定时间 1980-01-01），以及登记资源时 metadata 里的 format / contentType；处理服务对同一份内容嗅探出的结果必须相同",
        "members": [member("mesh.drc", &mesh), member("tex.jpg", &texture)],
        "zipBase64": STANDARD.encode(&zipped),
        "zipSha256": sha256_hex(&zipped),
        "registered": {
            "format": "zip",
            "contentType": UploadFormat::Zip.content_type(),
            "detail": {"model": "draco", "texture": true},
        },
        "single": {
            "name": "mesh.drc",
            "format": "draco",
            "contentType": UploadFormat::Drc.content_type(),
        },
    });
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/demo_seed_zip.json");
    if std::env::var_os("METAVERSE_WRITE_VECTORS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = serde_json::to_string_pretty(&vector).unwrap();
        std::fs::write(&path, format!("{text}\n")).unwrap();
    }
    let stored: Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .expect("缺少向量文件，用 METAVERSE_WRITE_VECTORS=1 运行这个测试生成"),
    )
    .unwrap();
    assert_eq!(
        stored, vector,
        "向量与实现不一致：确认改动无误后用 METAVERSE_WRITE_VECTORS=1 重新生成"
    );
}

/// 打包出来的 zip 本地重建工具读得懂：用它自己的格式嗅探和解包（`processing/sniff.py`）核对。
/// 需要 `recon/.venv`（或 `METAVERSE_RECON_PYTHON` 指向装了本地重建工具的 Python）；没有就跳过
/// （持续集成里由上面的跨语言向量和本地重建工具的 `test_demo_seed_zip.py` 覆盖）。
#[test]
fn packed_zip_is_readable_by_the_recon_sniffer() {
    let python = std::env::var("METAVERSE_RECON_PYTHON")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../recon/.venv/bin/python")
        });
    if !python.exists() {
        eprintln!("跳过：没有本地重建工具的 Python（{}）", python.display());
        return;
    }
    let (mesh, texture) = (drc(), jpg());
    let zip = stored_zip(&[("mesh.drc", &mesh), ("tex.jpg", &texture)]).unwrap();
    let dir = std::env::temp_dir().join(format!("demo-seed-zip-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("scan.zip");
    std::fs::write(&path, &zip).unwrap();
    let script = r#"
import hashlib, json, sys
from metaverse_recon.processing.sniff import check_model_file, extract_model
found = check_model_file(sys.argv[1], 1 << 30)
model, texture = extract_model(sys.argv[1], sys.argv[2], 1 << 30)
digest = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
print(json.dumps({"format": found.format, "contentType": found.content_type, "detail": found.detail,
                  "model": [model.rsplit("/", 1)[-1], digest(model)],
                  "texture": [texture.rsplit("/", 1)[-1], digest(texture)]}))
"#;
    let output = std::process::Command::new(&python)
        .arg("-I")
        .arg("-c")
        .arg(script)
        .arg(&path)
        .arg(dir.join("out"))
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["format"], "zip");
    assert_eq!(result["contentType"], "application/zip");
    assert_eq!(result["detail"], json!({"model": "draco", "texture": true}));
    assert_eq!(result["model"], json!(["model.drc", sha256_hex(&mesh)]));
    assert_eq!(
        result["texture"],
        json!(["texture.jpg", sha256_hex(&texture)])
    );
}
