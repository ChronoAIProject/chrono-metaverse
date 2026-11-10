//! 部署配置种子的集成测试（真实 MongoDB + 模拟 NyxID + 本机 HTTP 文件服务）。
//!
//! 文件由本机的 HTTP 服务提供（种子配置只在本机地址上允许明文 http）；"启动"就是按同一份配置
//! 新建一个 `AppState` 再执行种子（与 `main.rs` 里索引建好之后的后台执行相同）。

mod ingest_support;

use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Redirect},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::TryStreamExt;
use ingest_support::*;
use metaverse_api::demo_seed::{
    self,
    config::{DemoSeedConfig, FileRole, SeedFile},
    pack::{scan_asset, stored_zip},
    RetryPolicy, SeedError, SeedOutcome,
};
use metaverse_api::AppState;
use metaverse_core::model::UploadFormat;
use mongodb::bson::{doc, Bson, Document};
use serde_json::{json, Value};

const SPACE: &str = "chronoai-lobby";
const TOKEN: &str = "demo-share-token_0123456789abcdefghijklmnopqrstuv";
const SEED_ENV: &str = "METAVERSE_DEMO_SEED";
const TOKEN_ENV: &str = "METAVERSE_DEMO_SHARE_TOKEN";
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

fn glb() -> Vec<u8> {
    let total = 4096_u32;
    let mut bytes = b"glTF".to_vec();
    bytes.extend_from_slice(&2_u32.to_le_bytes());
    bytes.extend_from_slice(&total.to_le_bytes());
    bytes.resize(total as usize, 0x20);
    bytes
}

fn once() -> RetryPolicy {
    RetryPolicy {
        attempts: 1,
        first_delay: Duration::ZERO,
        max_delay: Duration::ZERO,
    }
}

// ---------------------------------------------------------------------------
// 本机 HTTP 文件服务
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Served {
    files: Arc<BTreeMap<String, Vec<u8>>>,
    hits: Arc<AtomicUsize>,
    /// 前几次请求返回 503（测试重试）。
    fail_first: Arc<AtomicUsize>,
}

struct FileServer {
    base: String,
    served: Served,
    server: tokio::task::JoinHandle<()>,
}

impl FileServer {
    async fn start(files: &[(&str, Vec<u8>)], fail_first: usize) -> Self {
        let served = Served {
            files: Arc::new(
                files
                    .iter()
                    .map(|(name, bytes)| ((*name).to_owned(), bytes.clone()))
                    .collect(),
            ),
            hits: Arc::default(),
            fail_first: Arc::new(AtomicUsize::new(fail_first)),
        };
        let app = Router::new()
            .route(
                "/files/{name}",
                get(
                    |State(served): State<Served>, Path(name): Path<String>| async move {
                        served.hits.fetch_add(1, Ordering::SeqCst);
                        if served
                            .fail_first
                            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                            .is_ok()
                        {
                            return StatusCode::SERVICE_UNAVAILABLE.into_response();
                        }
                        match served.files.get(&name) {
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
            // 重定向到公网的明文 http（不允许跟随）。
            .route(
                "/away/{name}",
                get(|Path(name): Path<String>| async move {
                    Redirect::temporary(&format!("http://downgrade.example/files/{name}"))
                }),
            )
            // 不带 Content-Length 的分块响应（只能边收边数字节）。
            .route(
                "/stream/{name}",
                get(
                    |State(served): State<Served>, Path(name): Path<String>| async move {
                        served.hits.fetch_add(1, Ordering::SeqCst);
                        let bytes = served.files.get(&name).cloned().unwrap_or_default();
                        let parts: Vec<Result<Vec<u8>, std::io::Error>> =
                            bytes.chunks(64 * 1024).map(|c| Ok(c.to_vec())).collect();
                        Body::from_stream(futures_util::stream::iter(parts)).into_response()
                    },
                ),
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

    fn hits(&self) -> usize {
        self.served.hits.load(Ordering::SeqCst)
    }

    /// 种子配置里的一项文件（哈希和大小取自 `bytes`，可以和服务上的内容不同）。
    fn file(&self, name: &str, bytes: &[u8]) -> Value {
        self.file_at("files", name, bytes)
    }

    /// 同 [`FileServer::file`]，地址走 `/<route>/<name>`（`hop`、`away`、`stream`）。
    fn file_at(&self, route: &str, name: &str, bytes: &[u8]) -> Value {
        json!({"url": format!("{}/{route}/{name}", self.base), "name": name,
               "sha256": sha256_hex(bytes), "size": bytes.len()})
    }
}

impl Drop for FileServer {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn seed_json(files: Vec<Value>, extra: Value) -> String {
    let mut seed = json!({
        "spaceId": SPACE,
        "name": "ChronoAI 前厅",
        "description": "测试用的演示空间",
        "owner": {"kind": "org", "id": ORG},
        "visibility": "unlisted",
        "files": files,
        "rebuild": true,
        "voxelize": false,
        "hints": {"objects": [{"center": [1.0, 0.5, 2.0], "kind": "chair", "label": "会议椅"}]}
    });
    for (key, value) in extra.as_object().unwrap() {
        seed[key] = value.clone();
    }
    seed.to_string()
}

/// 解析一份种子配置（用来在同一个库上换配置再执行）。
fn parse_seed(seed: &str, token: Option<&str>) -> DemoSeedConfig {
    DemoSeedConfig::from_lookup(
        &|name| match name {
            SEED_ENV => Some(seed.to_owned()),
            TOKEN_ENV => token.map(str::to_owned),
            _ => None,
        },
        1 << 30,
    )
    .unwrap()
    .unwrap()
}

/// 按同一份配置"重新启动"：新建 `AppState` 连同一个库。
async fn restart(app: &TestApp) -> AppState {
    let state = AppState::from_config(&app.config).await.unwrap();
    state.prepare().await.unwrap();
    state
}

async fn count(app: &TestApp, collection: &str, filter: Document) -> u64 {
    app.collection(collection)
        .count_documents(filter)
        .await
        .unwrap()
}

/// 经接口上传一份扫描并模拟处理服务校验通过，返回内容哈希。
async fn uploaded_scan(app: &TestApp, base: &str, bytes: Vec<u8>) -> String {
    let sha = sha256_hex(&bytes);
    let created = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{base}/uploads/scan"),
            Some(json!({"size": bytes.len(), "sha256": sha, "partSize": 4 * KIB256, "format": "drc"})),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{:?}", created.body);
    let id = created.body["uploadId"].as_str().unwrap().to_owned();
    let length = bytes.len() as i64;
    let part = app
        .put_bytes(
            who(ORG),
            &format!("{base}/uploads/scan/{id}/parts/0"),
            bytes,
        )
        .await;
    assert!(part.status.is_success(), "{:?}", part.body);
    let done = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{base}/uploads/scan/{id}/complete"),
            None,
        )
        .await;
    assert_eq!(done.status, StatusCode::ACCEPTED, "{:?}", done.body);
    app.finish_upload(&id, &sha, length).await;
    sha
}

fn int(value: Option<&Bson>) -> i64 {
    match value {
        Some(Bson::Int32(n)) => i64::from(*n),
        Some(Bson::Int64(n)) => *n,
        other => panic!("不是整数：{other:?}"),
    }
}

fn keys(document: &Document) -> Vec<String> {
    let mut keys: Vec<String> = document.keys().cloned().collect();
    keys.sort();
    keys
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[tokio::test]
async fn first_start_seeds_space_asset_and_job_and_restart_does_nothing() {
    let (mesh, texture) = (drc(), jpg());
    let server = FileServer::start(
        &[("mesh.drc", mesh.clone()), ("tex.jpg", texture.clone())],
        0,
    )
    .await;
    let seed = seed_json(
        vec![
            server.file("mesh.drc", &mesh),
            server.file("tex.jpg", &texture),
        ],
        json!({"observedAt": "2026-10-01T09:30:00+08:00"}),
    );
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed), (TOKEN_ENV, TOKEN)]).await else {
        return;
    };
    let config = app.config.demo_seed.clone().expect("配置了种子");
    let outcome = demo_seed::run(&app.state, &config, once()).await.unwrap();
    let SeedOutcome::Created { job_id } = outcome else {
        panic!("第一次启动应当建空间：{outcome:?}");
    };
    assert_eq!(server.hits(), 2);

    // 空间：主人取配置，归属证据是部署配置种子；分享令牌只存哈希。
    let space = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .expect("空间已建");
    assert_eq!(
        space.get_document("owner").unwrap(),
        &doc! {"kind": "org", "id": ORG}
    );
    let evidence = space.get_document("ownerEvidence").unwrap();
    assert_eq!(evidence.get_str("basis").unwrap(), "operator_seed");
    assert_eq!(evidence.get_str("verifiedBy").unwrap(), "system:demo-seed");
    assert_eq!(evidence.get_str("orgId").unwrap(), ORG);
    assert_eq!(evidence.get_str("issuer").unwrap(), ISSUER);
    assert!(evidence.get("roleAtVerification").is_none());
    assert_eq!(space.get_str("visibility").unwrap(), "unlisted");
    assert_eq!(space.get_str("name").unwrap(), "ChronoAI 前厅");
    let tokens = space.get_array("shareTokens").unwrap();
    assert_eq!(tokens.len(), 1);
    let token = tokens[0].as_document().unwrap();
    assert_eq!(token.get_str("hash").unwrap(), sha256_hex(TOKEN.as_bytes()));
    assert!(token.get_str("id").unwrap().starts_with("st_"));
    let everything = format!(
        "{space:?}{:?}",
        app.collection("commits")
            .find(doc! {})
            .await
            .unwrap()
            .try_collect::<Vec<Document>>()
            .await
            .unwrap()
    );
    assert!(!everything.contains(TOKEN), "库里不能有分享令牌原文");
    assert_eq!(int(space.get_document("head").unwrap().get("seq")), 1);

    // 第一次提交照常写：`_space` 锚点 + 通用方块表，发布者是种子。
    let genesis = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": {"$in": [1_i32, 1_i64]}})
        .await
        .unwrap()
        .expect("第一次提交");
    let actor = genesis.get_document("actor").unwrap();
    assert_eq!(actor.get_str("sub").unwrap(), "system:demo-seed");
    assert_eq!(actor.get_str("nyxServiceId").unwrap(), "");
    assert_eq!(actor.get_str("kind").unwrap(), "admin");
    assert!(genesis.get_str("paletteHash").is_ok());
    assert_eq!(
        count(&app, "anchors", doc! {"spaceId": SPACE, "id": "_space"}).await,
        1
    );

    // 资源：两个文件打成 stored zip，布局和元数据与处理服务 put_asset 相同。
    let zip = stored_zip(&[("mesh.drc", &mesh), ("tex.jpg", &texture)]).unwrap();
    let zip_hash = sha256_hex(&zip);
    let file = app
        .collection("assets.files")
        .find_one(doc! {"filename": &zip_hash})
        .await
        .unwrap()
        .expect("扫描已登记成资源");
    assert!(matches!(file.get("_id"), Some(Bson::ObjectId(_))));
    assert_eq!(file.get("length"), Some(&Bson::Int32(zip.len() as i32)));
    assert_eq!(file.get("chunkSize"), Some(&Bson::Int32(KIB256 as i32)));
    assert!(matches!(file.get("uploadDate"), Some(Bson::DateTime(_))));
    assert_eq!(
        file.get_document("metadata").unwrap(),
        &doc! {"sha256": &zip_hash, "contentType": "application/zip", "kind": "scan",
        "spaceId": SPACE, "format": "zip"}
    );
    let chunks: Vec<Document> = app
        .collection("assets.chunks")
        .find(doc! {"files_id": file.get("_id").unwrap().clone()})
        .sort(doc! {"n": 1})
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(chunks.len(), zip.len().div_ceil(KIB256));
    let mut joined = Vec::new();
    for (n, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.get("n"), Some(&Bson::Int32(n as i32)));
        let data = chunk.get_binary_generic("data").unwrap();
        if n + 1 < chunks.len() {
            assert_eq!(data.len(), KIB256);
        }
        joined.extend_from_slice(data);
    }
    assert_eq!(joined, zip);

    // 任务：字段与 POST /scans 建的任务完全一致。
    let job = app
        .collection("jobs")
        .find_one(doc! {"_id": &job_id})
        .await
        .unwrap()
        .expect("scan_import 任务");
    assert_eq!(job.get_str("kind").unwrap(), "scan_import");
    assert_eq!(job.get_str("status").unwrap(), "queued");
    assert_eq!(job.get_str("spaceId").unwrap(), SPACE);
    assert_eq!(
        job.get_document("owner").unwrap(),
        &doc! {"kind": "org", "id": ORG}
    );
    assert_eq!(int(job.get("attempt")), 0);
    assert_eq!(int(job.get("maxAttempts")), 3);
    assert_eq!(
        job.get_document("actor").unwrap(),
        &doc! {"sub": "system:demo-seed", "nyxServiceId": ""}
    );
    assert_eq!(job.get_str("scope").unwrap(), "physical");
    assert_eq!(
        job.get_document("params").unwrap(),
        &doc! {
            "assetHash": &zip_hash,
            "observedAt": "2026-10-01T01:30:00.000Z",
            "rebuild": true,
            "voxelize": false,
            "hints": {"objects": [{"center": [1.0, 0.5, 2.0], "kind": "chair", "label": "会议椅"}]},
        }
    );
    // 同样的请求经 POST /scans 建的任务，字段集合相同。
    app.create_space(who(ORG), "front-hall", "org", ORG, "unlisted")
        .await;
    let base = "/api/v1/spaces/front-hall";
    let uploaded = uploaded_scan(&app, base, drc()).await;
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{base}/scans"),
            Some(
                json!({"assetHash": uploaded, "observedAt": "2026-10-01T09:30:00+08:00",
                        "rebuild": true, "voxelize": false, "hints": {"objects": []}}),
            ),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    let via_api = app
        .collection("jobs")
        .find_one(doc! {"_id": reply.body["id"].as_str().unwrap()})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(keys(&job), keys(&via_api));
    assert_eq!(
        keys(job.get_document("params").unwrap()),
        keys(via_api.get_document("params").unwrap())
    );
    assert_eq!(
        keys(job.get_document("actor").unwrap()),
        keys(via_api.get_document("actor").unwrap())
    );
    for field in ["createdAt", "scope", "status", "kind"] {
        assert_eq!(
            job.get(field).map(Bson::element_type),
            via_api.get(field).map(Bson::element_type),
            "{field}"
        );
    }

    // 公开接口凭分享令牌读得到，不带令牌 404；组织 admin 经 /api/v1 能管理，member 只读。
    let public = app
        .public(
            &format!("/api/public/spaces/{SPACE}"),
            Some(&format!("Share {TOKEN}")),
            &[],
        )
        .await;
    assert_eq!(public.status, StatusCode::OK, "{:?}", public.body);
    assert_eq!(public.body["name"], "ChronoAI 前厅");
    assert_eq!(
        app.public(&format!("/api/public/spaces/{SPACE}"), None, &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let admin = app
        .call(
            who_with("alice", "admin-token"),
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}"),
            None,
        )
        .await;
    assert_eq!(admin.status, StatusCode::OK, "{:?}", admin.body);
    assert_eq!(admin.body["ownerEvidence"]["basis"], "operator_seed");
    let member_draft = app
        .call(
            who_with("bob", "member-token"),
            Method::POST,
            &format!("/api/v1/spaces/{SPACE}/drafts"),
            Some(json!({})),
        )
        .await;
    assert_eq!(member_draft.status, StatusCode::FORBIDDEN);
    let stranger = app
        .call(
            who("dave"),
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}"),
            None,
        )
        .await;
    assert_eq!(stranger.status, StatusCode::NOT_FOUND);

    // 再次启动：什么都不做（不下载、不重复建）。
    let restarted = restart(&app).await;
    let again = demo_seed::run(&restarted, &config, once()).await.unwrap();
    assert_eq!(again, SeedOutcome::AlreadyDone { job_id });
    assert_eq!(server.hits(), 2, "空间和任务都在时不再下载");
    assert_eq!(count(&app, "spaces", doc! {"_id": SPACE}).await, 1);
    assert_eq!(count(&app, "jobs", doc! {"spaceId": SPACE}).await, 1);
    assert_eq!(
        count(&app, "assets.files", doc! {"metadata.spaceId": SPACE}).await,
        1
    );
}

#[tokio::test]
async fn hash_mismatch_creates_nothing() {
    let (mesh, texture) = (drc(), jpg());
    let server = FileServer::start(&[("mesh.drc", mesh.clone()), ("tex.jpg", texture)], 0).await;
    // 配置里的贴图哈希对应别的内容（大小相同）。
    let other = vec![0xAB_u8; jpg().len()];
    let seed = seed_json(
        vec![
            server.file("mesh.drc", &mesh),
            server.file("tex.jpg", &other),
        ],
        json!({}),
    );
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed), (TOKEN_ENV, TOKEN)]).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let error = demo_seed::run(&app.state, &config, once())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, SeedError::Permanent(reason) if reason.contains("sha256")),
        "{error:?}"
    );
    for collection in ["spaces", "jobs", "assets.files", "assets.chunks", "commits"] {
        assert_eq!(count(&app, collection, doc! {}).await, 0, "{collection}");
    }

    // 文件不存在（404）、内容与扩展名不符：同样不建空间，也不重试。
    let missing = seed_json(
        vec![
            server.file("mesh.drc", &mesh),
            server.file("nothing.jpg", &jpg()),
        ],
        json!({}),
    );
    let config = DemoSeedConfig::from_lookup(
        &|name| match name {
            SEED_ENV => Some(missing.clone()),
            TOKEN_ENV => Some(TOKEN.to_owned()),
            _ => None,
        },
        1 << 30,
    )
    .unwrap()
    .unwrap();
    let hits = server.hits();
    let error = demo_seed::run(
        &app.state,
        &config,
        RetryPolicy {
            attempts: 3,
            first_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(&error, SeedError::Permanent(reason) if reason.contains("404")),
        "{error:?}"
    );
    assert_eq!(server.hits(), hits + 2, "404 不重试");
    let html = b"<html>not a mesh</html>".to_vec();
    let fake = FileServer::start(&[("mesh.drc", html.clone())], 0).await;
    let wrong = seed_json(vec![fake.file("mesh.drc", &html)], json!({}));
    let config = DemoSeedConfig::from_lookup(
        &|name| match name {
            SEED_ENV => Some(wrong.clone()),
            TOKEN_ENV => Some(TOKEN.to_owned()),
            _ => None,
        },
        1 << 30,
    )
    .unwrap()
    .unwrap();
    let error = demo_seed::run(&app.state, &config, once())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, SeedError::Permanent(reason) if reason.contains("扩展名")),
        "{error:?}"
    );
    assert_eq!(count(&app, "spaces", doc! {}).await, 0);
}

#[tokio::test]
async fn transient_failures_are_retried() {
    let model = glb();
    // 前两次请求 503。
    let server = FileServer::start(&[("scan.glb", model.clone())], 2).await;
    let seed = seed_json(
        vec![server.file("scan.glb", &model)],
        json!({"visibility": "public", "hints": null}),
    );
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed)]).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let error = demo_seed::run(&app.state, &config, once())
        .await
        .unwrap_err();
    assert!(matches!(error, SeedError::Transient(_)), "{error:?}");
    let outcome = demo_seed::run(
        &app.state,
        &config,
        RetryPolicy {
            attempts: 3,
            first_delay: Duration::from_millis(5),
            max_delay: Duration::from_millis(20),
        },
    )
    .await
    .unwrap();
    assert!(
        matches!(outcome, SeedOutcome::Created { .. }),
        "{outcome:?}"
    );
    assert_eq!(server.hits(), 3);

    // 单个 glb 直接用（不打包）；公开空间不需要分享令牌。
    let hash = sha256_hex(&model);
    let file = app
        .collection("assets.files")
        .find_one(doc! {"filename": &hash})
        .await
        .unwrap()
        .expect("glb 原样登记");
    assert_eq!(
        file.get_document("metadata").unwrap(),
        &doc! {"sha256": &hash, "contentType": "model/gltf-binary", "kind": "scan",
        "spaceId": SPACE, "format": "glb"}
    );
    let space = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(space.get_str("visibility").unwrap(), "public");
    assert!(space.get_array("shareTokens").unwrap().is_empty());
    let job = app
        .collection("jobs")
        .find_one(doc! {"spaceId": SPACE})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        job.get_document("params").unwrap(),
        &doc! {"assetHash": &hash, "rebuild": true, "voxelize": false}
    );
    let public = app
        .public(&format!("/api/public/spaces/{SPACE}"), None, &[])
        .await;
    assert_eq!(public.status, StatusCode::OK);
}

#[tokio::test]
async fn concurrent_replicas_create_once() {
    let (mesh, texture) = (drc(), jpg());
    let server = FileServer::start(
        &[("mesh.drc", mesh.clone()), ("tex.jpg", texture.clone())],
        0,
    )
    .await;
    let seed = seed_json(
        vec![
            server.file("mesh.drc", &mesh),
            server.file("tex.jpg", &texture),
        ],
        json!({}),
    );
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed), (TOKEN_ENV, TOKEN)]).await else {
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
        .filter(|o| matches!(o, SeedOutcome::Created { .. } | SeedOutcome::Resumed { .. }))
        .count();
    assert_eq!(made, 1, "只有一个副本建成任务：{outcomes:?}");
    assert!(outcomes.iter().all(|o| !matches!(o, SeedOutcome::Foreign)));
    assert_eq!(count(&app, "spaces", doc! {"_id": SPACE}).await, 1);
    assert_eq!(count(&app, "jobs", doc! {"spaceId": SPACE}).await, 1);
    assert_eq!(count(&app, "assets.files", doc! {}).await, 1);
    assert_eq!(
        count(&app, "commits", doc! {"spaceId": SPACE}).await,
        1,
        "第一次提交只写一次"
    );
}

#[tokio::test]
async fn resumes_unfinished_seed_and_imports_new_revision() {
    let (mesh, texture) = (drc(), jpg());
    let server = FileServer::start(
        &[("mesh.drc", mesh.clone()), ("tex.jpg", texture.clone())],
        0,
    )
    .await;
    let files = vec![
        server.file("mesh.drc", &mesh),
        server.file("tex.jpg", &texture),
    ];
    let seed = seed_json(files.clone(), json!({}));
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed), (TOKEN_ENV, TOKEN)]).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let SeedOutcome::Created { job_id } =
        demo_seed::run(&app.state, &config, once()).await.unwrap()
    else {
        panic!("应当建空间");
    };
    // 模拟上次建完空间、还没建任务就退出了。
    app.collection("jobs")
        .delete_one(doc! {"_id": &job_id})
        .await
        .unwrap();
    let resumed = demo_seed::run(&restart(&app).await, &config, once())
        .await
        .unwrap();
    assert_eq!(
        resumed,
        SeedOutcome::Resumed {
            job_id: job_id.clone()
        }
    );
    assert_eq!(count(&app, "spaces", doc! {}).await, 1);

    // 导入版本加一：同一个空间再建一个任务，资源复用。
    let next = seed_json(files, json!({"revision": 2}));
    let config2 = DemoSeedConfig::from_lookup(
        &|name| match name {
            SEED_ENV => Some(next.clone()),
            TOKEN_ENV => Some(TOKEN.to_owned()),
            _ => None,
        },
        1 << 30,
    )
    .unwrap()
    .unwrap();
    let SeedOutcome::Resumed { job_id: second } =
        demo_seed::run(&app.state, &config2, once()).await.unwrap()
    else {
        panic!("新版本应当补建任务");
    };
    assert_ne!(second, job_id);
    assert_eq!(count(&app, "jobs", doc! {"spaceId": SPACE}).await, 2);
    assert_eq!(count(&app, "assets.files", doc! {}).await, 1);
    // 旧版本的配置再启动不会再建。
    assert!(matches!(
        demo_seed::run(&app.state, &config, once()).await.unwrap(),
        SeedOutcome::AlreadyDone { .. }
    ));
}

#[tokio::test]
async fn existing_space_not_created_by_the_seed_is_left_alone() {
    let (mesh, texture) = (drc(), jpg());
    let server = FileServer::start(
        &[("mesh.drc", mesh.clone()), ("tex.jpg", texture.clone())],
        0,
    )
    .await;
    let seed = seed_json(
        vec![
            server.file("mesh.drc", &mesh),
            server.file("tex.jpg", &texture),
        ],
        json!({}),
    );
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed), (TOKEN_ENV, TOKEN)]).await else {
        return;
    };
    // 组织自己经管理接口建了同名空间。
    app.create_space(who(ORG), SPACE, "org", ORG, "unlisted")
        .await;
    let config = app.config.demo_seed.clone().unwrap();
    let outcome = demo_seed::run(&app.state, &config, once()).await.unwrap();
    assert_eq!(outcome, SeedOutcome::Foreign);
    assert_eq!(server.hits(), 0, "不碰别人的空间，也不下载");
    assert_eq!(count(&app, "jobs", doc! {}).await, 0);
    let space = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        space
            .get_document("ownerEvidence")
            .unwrap()
            .get_str("basis")
            .unwrap(),
        "org_subject"
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
    let file = |name: &str, bytes: &[u8], role, format| SeedFile {
        url: url::Url::parse(&format!("https://scaniverse.example/x/{name}")).unwrap(),
        name: name.to_owned(),
        sha256: sha256_hex(bytes),
        size: bytes.len() as u64,
        role,
        format,
    };
    let drc = file("mesh.drc", &mesh, FileRole::Mesh, UploadFormat::Drc);
    let jpg = file("tex.jpg", &texture, FileRole::Texture, UploadFormat::Jpeg);
    let zipped = scan_asset(
        &[drc.clone(), jpg],
        vec![mesh.clone(), texture.clone()],
        1 << 20,
    )
    .unwrap();
    let single = scan_asset(std::slice::from_ref(&drc), vec![mesh.clone()], 1 << 20).unwrap();
    let member = |name: &str, bytes: &[u8]| json!({"name": name, "base64": STANDARD.encode(bytes), "sha256": sha256_hex(bytes)});
    let vector = json!({
        "kind": "demo-seed-zip",
        "description": "部署配置种子把网格 + 贴图打包成的 stored zip（固定时间 1980-01-01），以及登记资源时 metadata 里的 format / contentType；处理服务对同一份内容嗅探出的结果必须相同",
        "members": [member("mesh.drc", &mesh), member("tex.jpg", &texture)],
        "zipBase64": STANDARD.encode(&zipped.bytes),
        "zipSha256": sha256_hex(&zipped.bytes),
        "registered": {
            "format": zipped.worker_format(),
            "contentType": zipped.format.content_type(),
            "detail": {"model": "draco", "texture": true},
        },
        "single": {
            "name": "mesh.drc",
            "format": single.worker_format(),
            "contentType": single.format.content_type(),
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

#[tokio::test]
async fn redirects_and_oversized_downloads_are_checked() {
    let (mesh, texture) = (drc(), jpg());
    let server = FileServer::start(
        &[("mesh.drc", mesh.clone()), ("tex.jpg", texture.clone())],
        0,
    )
    .await;
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    // 重定向到公网的明文 http：不跟随，按失败处理（不重试），不建空间。
    let away = seed_json(
        vec![
            server.file_at("away", "mesh.drc", &mesh),
            server.file("tex.jpg", &texture),
        ],
        json!({}),
    );
    let error = demo_seed::run(&app.state, &parse_seed(&away, Some(TOKEN)), once())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, SeedError::Permanent(reason) if reason.contains("重定向")),
        "{error:?}"
    );
    assert!(
        !format!("{error:?}").contains("downgrade.example"),
        "错误信息里不带地址：{error:?}"
    );
    // 分块响应（没有 Content-Length）比配置的大：边收边数，超过就停，不建空间。
    let short = &texture[..texture.len() - 1];
    let oversized = seed_json(
        vec![
            server.file("mesh.drc", &mesh),
            server.file_at("stream", "tex.jpg", short),
        ],
        json!({}),
    );
    let error = demo_seed::run(&app.state, &parse_seed(&oversized, Some(TOKEN)), once())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, SeedError::Permanent(reason) if reason.contains("比配置的")),
        "{error:?}"
    );
    // 带 Content-Length 的响应与配置的大小不符：读之前就拒绝。
    let mismatched = seed_json(
        vec![
            server.file("mesh.drc", &mesh),
            server.file("tex.jpg", short),
        ],
        json!({}),
    );
    let error = demo_seed::run(&app.state, &parse_seed(&mismatched, Some(TOKEN)), once())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, SeedError::Permanent(reason) if reason.contains("不符")),
        "{error:?}"
    );
    for collection in ["spaces", "jobs", "assets.files", "assets.chunks", "commits"] {
        assert_eq!(count(&app, collection, doc! {}).await, 0, "{collection}");
    }
    // 本机内的重定向和分块响应（大小、哈希都对）：正常建成。
    let fine = seed_json(
        vec![
            server.file_at("hop", "mesh.drc", &mesh),
            server.file_at("stream", "tex.jpg", &texture),
        ],
        json!({}),
    );
    let outcome = demo_seed::run(&app.state, &parse_seed(&fine, Some(TOKEN)), once())
        .await
        .unwrap();
    assert!(
        matches!(outcome, SeedOutcome::Created { .. }),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn seeded_space_keeps_its_owner_and_share_tokens() {
    let (mesh, texture) = (drc(), jpg());
    let server = FileServer::start(
        &[("mesh.drc", mesh.clone()), ("tex.jpg", texture.clone())],
        0,
    )
    .await;
    let files = vec![
        server.file("mesh.drc", &mesh),
        server.file("tex.jpg", &texture),
    ];
    let seed = seed_json(files.clone(), json!({}));
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed), (TOKEN_ENV, TOKEN)]).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    assert!(matches!(
        demo_seed::run(&app.state, &config, once()).await.unwrap(),
        SeedOutcome::Created { .. }
    ));
    let before = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap();
    let hits = server.hits();

    // 配置换了主人（别的组织）：种子建的空间也不归它，什么都不做、不下载。
    let other_owner = seed_json(
        files.clone(),
        json!({"owner": {"kind": "org", "id": OTHER_ORG}, "revision": 2}),
    );
    assert_eq!(
        demo_seed::run(&app.state, &parse_seed(&other_owner, Some(TOKEN)), once())
            .await
            .unwrap(),
        SeedOutcome::Foreign
    );
    assert_eq!(server.hits(), hits);

    // 换了分享令牌、改成公开、改了名字：已有空间都不改（令牌只在第一次建空间时写入）。
    let other_token = "another-share-token_0123456789abcdefghijklmn";
    let changed = seed_json(
        files,
        json!({"name": "改过的名字", "visibility": "public", "revision": 2}),
    );
    assert!(matches!(
        demo_seed::run(&app.state, &parse_seed(&changed, Some(other_token)), once())
            .await
            .unwrap(),
        SeedOutcome::Resumed { .. }
    ));
    let after = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap();
    for field in [
        "owner",
        "ownerEvidence",
        "visibility",
        "shareTokens",
        "name",
        "createdAt",
    ] {
        assert_eq!(before.get(field), after.get(field), "{field}");
    }
    let everything = format!("{after:?}");
    assert!(!everything.contains(other_token));
    assert!(!everything.contains(&sha256_hex(other_token.as_bytes())));
    // 旧令牌照常能读，新令牌读不到。
    let public = |token: &str| {
        let path = format!("/api/public/spaces/{SPACE}");
        let header = format!("Share {token}");
        let app = &app;
        async move { app.public(&path, Some(&header), &[]).await.status }
    };
    assert_eq!(public(TOKEN).await, StatusCode::OK);
    assert_eq!(public(other_token).await, StatusCode::NOT_FOUND);
}

/// AI 物件集：和扫描一起下载、核对、浅层校验，登记成 authored 资源，导入任务带 authoredAsset。
#[tokio::test]
async fn seed_with_authored_set_registers_it_and_passes_it_to_the_import() {
    let model = glb();
    let authored = serde_json::to_vec(&json!({
        "version": 1,
        "entities": [{"entityId": "panel-01", "kind": "object",
                      "shape": {"type": "box", "size": [1, 1, 0.02], "material": {"bake": "planar"}}}],
        "notes": "演示用的物件集"
    }))
    .unwrap();
    let bad = br#"{"version": 1, "entities": []}"#.to_vec();
    let server = FileServer::start(
        &[
            ("scan.glb", model.clone()),
            ("authored.json", authored.clone()),
            ("bad.json", bad.clone()),
        ],
        0,
    )
    .await;
    let entry = |name: &str, bytes: &[u8]| {
        let file = server.file(name, bytes);
        json!({"url": file["url"], "sha256": file["sha256"], "size": file["size"]})
    };

    // 物件集不合法（浅层校验不通过）：什么都不建，也不重试。
    let seed = seed_json(
        vec![server.file("scan.glb", &model)],
        json!({"authored": entry("bad.json", &bad)}),
    );
    let Some(app) = TestApp::start(&[(SEED_ENV, &seed), (TOKEN_ENV, TOKEN)]).await else {
        return;
    };
    let config = app.config.demo_seed.clone().unwrap();
    let error = demo_seed::run(&app.state, &config, once())
        .await
        .unwrap_err();
    assert!(
        matches!(&error, SeedError::Permanent(reason) if reason.contains("authored.json") && reason.contains("entities")),
        "{error:?}"
    );
    for collection in ["spaces", "jobs", "assets.files"] {
        assert_eq!(count(&app, collection, doc! {}).await, 0, "{collection}");
    }

    // 哈希对不上：同样不建。
    let mismatch = seed_json(
        vec![server.file("scan.glb", &model)],
        json!({"authored": entry("authored.json", b"{}")}),
    );
    let error = demo_seed::run(&app.state, &parse_seed(&mismatch, Some(TOKEN)), once())
        .await
        .unwrap_err();
    assert!(matches!(&error, SeedError::Permanent(_)), "{error:?}");
    assert_eq!(count(&app, "spaces", doc! {}).await, 0);

    // 合法：空间、扫描、物件集都登记，任务参数带 authoredAsset。
    let good = seed_json(
        vec![server.file("scan.glb", &model)],
        json!({"authored": entry("authored.json", &authored)}),
    );
    let outcome = demo_seed::run(&app.state, &parse_seed(&good, Some(TOKEN)), once())
        .await
        .unwrap();
    let SeedOutcome::Created { job_id } = outcome else {
        panic!("应当建空间：{outcome:?}");
    };
    let authored_hash = sha256_hex(&authored);
    let files = app
        .collection("assets.files")
        .find_one(doc! {"filename": &authored_hash})
        .await
        .unwrap()
        .expect("物件集已登记");
    let metadata = files.get_document("metadata").unwrap();
    assert_eq!(metadata.get_str("kind").unwrap(), "authored");
    assert_eq!(metadata.get_str("spaceId").unwrap(), SPACE);
    let job = app
        .collection("jobs")
        .find_one(doc! {"_id": &job_id})
        .await
        .unwrap()
        .unwrap();
    let params = job.get_document("params").unwrap();
    assert_eq!(params.get_str("authoredAsset").unwrap(), authored_hash);
    assert!(params.get_bool("rebuild").unwrap());
    assert_eq!(params.get_str("assetHash").unwrap(), sha256_hex(&model));
}
