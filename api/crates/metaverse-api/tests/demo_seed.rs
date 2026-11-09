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
    extract::{Path, State},
    http::{Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::TryStreamExt;
use ingest_support::*;
use metaverse_api::demo_seed::{
    self, config::DemoSeedConfig, pack::stored_zip, RetryPolicy, SeedError, SeedOutcome,
};
use metaverse_api::AppState;
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
        json!({"url": format!("{}/files/{name}", self.base), "name": name,
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

/// 打包出来的 zip 处理服务读得懂：用处理服务自己的格式嗅探和解包（`processing/sniff.py`）核对。
/// 需要 `worker/.venv`（或 `METAVERSE_WORKER_PYTHON` 指向装了处理服务的 Python）；没有就跳过。
#[test]
fn packed_zip_is_readable_by_the_worker_sniffer() {
    let python = std::env::var("METAVERSE_WORKER_PYTHON")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../worker/.venv/bin/python")
        });
    if !python.exists() {
        eprintln!("跳过：没有处理服务的 Python（{}）", python.display());
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
from metaverse_worker.processing.sniff import check_model_file, extract_model
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
