//! 重建路径的集成测试（docs/design/server-slim.md 13.2 S3 的验收）：真实本地 MongoDB + 模拟 NyxID。
//!
//! 覆盖：重建权限（总开关开和关都要求）、member 403；重建路径全套接口的成功和失败路径（真实的
//! 分片上传、核对、交包展开、预览、发布）；实体区草稿和重建草稿互不相通；同层模板和发布时的模板
//! 完整性；`setScan` 首次固定坐标系、拍摄时间沿用；两个重建草稿交错时的 `layer:rebuilt` 冲突和重放；
//! 实体区草稿与重建草稿只在同一锚点编号上冲突；没有变化不写提交、合并包推两次、删掉的锚点不复活、
//! 锚点漂移；文件按核对记录判断角色；预览拿不到原始扫描、清单、建模记录、操作文件；没定义实体区
//! 的空间的范围。资源直接登记进库（带核对记录），模拟核对通过的上传。

mod timeline_support;

use axum::http::{Method, StatusCode};
use mongodb::bson::{doc, Document};
use serde_json::{json, Value};
use timeline_support::{
    glb_check, identity_with, image_check, scan_glb_check, text_check, Payload, Reply, TestApp, ORG,
};

const SPACE: &str = "lobby";
const REBUILD: &str = "metaverse:rebuild:write";
const CONTENT: &str = "metaverse:content:write";
const CREATE: &str = "metaverse:space:create";
const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

fn rb(space: &str) -> String {
    format!("/api/v1/spaces/{space}/rebuild")
}

/// 带重建权限的组织本身（组织的 agent key，"管理"级别）。
async fn rebuilder(app: &TestApp, method: Method, path: &str, body: Option<Value>) -> Reply {
    app.org_with(&[REBUILD], method, path, body).await
}

/// 某个调用者带着给定的权限和转发凭据。
async fn as_caller(
    app: &TestApp,
    subject: &str,
    forwarded: Option<&str>,
    permissions: &[&str],
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Reply {
    let token = identity_with(subject, permissions);
    let bearer = forwarded.map(|credential| format!("Bearer {credential}"));
    let mut headers = vec![("x-nyxid-identity-token", token.as_str())];
    if let Some(bearer) = &bearer {
        headers.push(("authorization", bearer.as_str()));
    }
    let payload = body.map_or(Payload::None, Payload::Json);
    app.send(method, path, &headers, payload).await
}

/// 一份登记好的文件（清单 `files[]` 的一项）。
#[derive(Clone)]
struct File {
    path: &'static str,
    purpose: &'static str,
    hash: String,
    size: usize,
}

impl File {
    fn entry(&self) -> Value {
        json!({"path": self.path, "purpose": self.purpose, "sha256": self.hash, "size": self.size})
    }
}

/// 一组核对通过的文件：原始扫描（zip）、网页用模型、物件模型、贴图、建模记录。
struct Files {
    scan: File,
    web: File,
    model: File,
    texture: File,
    notes: File,
}

impl Files {
    fn all(&self) -> Vec<Value> {
        [
            &self.scan,
            &self.web,
            &self.model,
            &self.texture,
            &self.notes,
        ]
        .iter()
        .map(|file| file.entry())
        .collect()
    }
}

async fn put_file(
    app: &TestApp,
    space: &str,
    path: &'static str,
    purpose: &'static str,
    bytes: &[u8],
    kind: &str,
    check: Document,
) -> File {
    let hash = app
        .put_checked_asset(space, bytes, "application/octet-stream", kind, check)
        .await;
    File {
        path,
        purpose,
        hash,
        size: bytes.len(),
    }
}

/// 椅子模型的实测包围盒：0.8 × 0.8 × 0.6 米，原点在底面中心。
const CHAIR: ([f64; 3], [f64; 3]) = ([-0.4, 0.0, -0.3], [0.4, 0.8, 0.3]);

async fn register_files(app: &TestApp, space: &str, tag: &str) -> Files {
    let zip = doc! {"v": 1, "format": "zip", "mesh": "mesh.drc", "members": 2};
    Files {
        scan: put_file(
            app,
            space,
            "scan/scan.zip",
            "scan",
            format!("PK scan {tag}").as_bytes(),
            "scan",
            zip,
        )
        .await,
        web: put_file(
            app,
            space,
            "web/scan-0.glb",
            "webmodel",
            format!("glTF web {tag}").as_bytes(),
            "web_model",
            glb_check([-30.0, -1.0, -30.0], [30.0, 4.0, 30.0], 300_000),
        )
        .await,
        model: put_file(
            app,
            space,
            "models/chair.glb",
            "model",
            format!("glTF chair {tag}").as_bytes(),
            "model",
            glb_check(CHAIR.0, CHAIR.1, 2400),
        )
        .await,
        texture: put_file(
            app,
            space,
            "textures/oak.jpg",
            "texture",
            format!("JFIF oak {tag}").as_bytes(),
            "texture",
            image_check("jpeg", 512, 512),
        )
        .await,
        notes: put_file(
            app,
            space,
            "notes.md",
            "script",
            format!("# 建模记录 {tag}\n").as_bytes(),
            "script",
            text_check(),
        )
        .await,
    }
}

fn scan_of(files: &Files, observed: Option<&str>, transform: [f64; 16]) -> Value {
    let mut scan = json!({
        "assetHash": files.scan.hash,
        "webModelHashes": [files.web.hash],
        "transform": transform,
        "alignment": {"method": "given", "rotationDeg": -61.42},
    });
    if let Some(at) = observed {
        scan["observedAt"] = json!(at);
    }
    scan
}

/// 1 米见方的盒子物件（底面中心在 (x, 0, z)）。
fn boxy(id: &str, x: f64, z: f64) -> Value {
    json!({"entityId": id, "layer": "rebuilt", "kind": "object",
        "shape": {"type": "box", "size": [1, 1, 1], "transform": {"position": [x, 0, z]}},
        "bounds": {"min": [x - 0.5, 0, z - 0.5], "max": [x + 0.5, 1, z + 0.5]}})
}

fn anchor(id: &str, cells: [i64; 6]) -> Value {
    json!({"anchorId": id, "kind": "counter", "box": cells, "label": id, "visibility": "public"})
}

fn manifest(note: &str, body: Value, files: Vec<Value>) -> Value {
    let mut manifest = json!({
        "format": "chrono-metaverse-rebuild-bundle",
        "version": 1,
        "tool": {"name": "metaverse-recon", "version": "0.2.0"},
        "note": note,
        "createdAt": "2026-11-01T00:00:00.000Z",
        "files": files,
    });
    for (key, value) in body.as_object().unwrap() {
        manifest[key] = value.clone();
    }
    manifest
}

/// 完整的包：扫描、整体替换重建层（模板 + 实例、外部模型物件、带贴图的柜台）、锚点、建模记录。
fn full_manifest(files: &Files, note: &str) -> Value {
    manifest(
        note,
        json!({
            "scan": scan_of(files, Some("2026-10-20T00:00:00.000Z"), IDENTITY),
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
                     "assetHash": files.model.hash, "anchorId": "counter",
                     "bounds": {"min": [3.6, 0, 4.7], "max": [4.4, 0.8, 5.3]}},
                    {"entityId": "rb.counter", "layer": "rebuilt", "kind": "object",
                     "anchorId": "counter",
                     "shape": {"type": "box", "size": [2, 1, 0.6], "transform": {"position": [5, 0, 5]},
                               "material": {"texture": files.texture.hash, "uv": "box"}},
                     "bounds": {"min": [4, 0, 4.7], "max": [6, 1, 5.3]}}
                ]},
            "anchors": [anchor("counter", [70, 0, 90, 125, 20, 110])],
            "notes": files.notes.hash,
            "report": {"fit": {"meanCm": 4.3}},
        }),
        files.all(),
    )
}

/// 把清单登记成本空间核对通过的资源（模拟经重建路径上传、核对通过），返回哈希。同一份清单已经
/// 登记过就直接用（同一个包推几次）。
async fn put_manifest(app: &TestApp, space: &str, manifest: &Value) -> String {
    let bytes = serde_json::to_vec(manifest).unwrap();
    let hash = metaverse_core::sha256_hex(&bytes);
    let exists = app
        .collection("assets.files")
        .find_one(doc! {"filename": &hash})
        .await
        .unwrap()
        .is_some();
    if exists {
        return hash;
    }
    app.put_checked_asset(
        space,
        &bytes,
        "application/json",
        "bundle",
        doc! {"v": 1, "format": "json"},
    )
    .await
}

async fn new_rebuild_draft(app: &TestApp, space: &str, body: Option<Value>) -> String {
    let reply = rebuilder(app, Method::POST, &format!("{}/drafts", rb(space)), body).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["scope"], "rebuild");
    let id = reply.body["id"].as_str().unwrap().to_owned();
    assert_eq!(
        reply.header(axum::http::header::LOCATION),
        format!("{}/drafts/{id}", rb(space))
    );
    format!("{}/drafts/{id}", rb(space))
}

/// 交包并等展开任务结束，返回任务文档。
async fn apply_bundle(app: &TestApp, draft: &str, body: Value) -> Document {
    let reply = rebuilder(app, Method::POST, &format!("{draft}/bundle"), Some(body)).await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    assert_eq!(reply.body["status"], "queued");
    let job_id = reply.body["jobId"].as_str().unwrap().to_owned();
    app.wait_job(&job_id).await
}

/// 建重建草稿、按资源哈希交包、等展开，返回草稿路径和任务文档。
async fn push(app: &TestApp, space: &str, manifest: &Value) -> (String, Document) {
    let hash = put_manifest(app, space, manifest).await;
    let draft = new_rebuild_draft(app, space, None).await;
    let job = apply_bundle(app, &draft, json!({"assetHash": hash})).await;
    (draft, job)
}

fn job_result(job: &Document) -> Value {
    assert_eq!(job.get_str("status").unwrap(), "done", "{job:?}");
    serde_json::to_value(job.get_document("result").unwrap()).unwrap()
}

async fn publish(app: &TestApp, draft: &str, body: Option<Value>) -> Reply {
    rebuilder(app, Method::POST, &format!("{draft}/publish"), body).await
}

async fn head_seq(app: &TestApp, space: &str) -> u64 {
    app.org(Method::GET, &format!("/api/v1/spaces/{space}"), None)
        .await
        .body["head"]["seq"]
        .as_u64()
        .unwrap()
}

async fn commit_at(app: &TestApp, space: &str, seq: u64) -> Document {
    app.collection("commits")
        .find_one(doc! {"spaceId": space, "seq": seq as i64})
        .await
        .unwrap()
        .expect("提交存在")
}

/// 当前重建层的物件编号（`/api/v1` 快照）。
async fn rebuilt_ids(app: &TestApp, space: &str) -> Vec<String> {
    let reply = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{space}/snapshot"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let mut ids: Vec<String> = reply.body["entities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entity| entity["body"]["layer"] == "rebuilt")
        .map(|entity| entity["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

async fn ext_draft(app: &TestApp, space: &str) -> String {
    let reply = app
        .org(
            Method::POST,
            &format!("/api/v1/spaces/{space}/drafts"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    format!(
        "/api/v1/spaces/{space}/drafts/{}",
        reply.body["id"].as_str().unwrap()
    )
}

async fn append(app: &TestApp, draft: &str, ops: Value) -> Reply {
    app.org(
        Method::POST,
        &format!("{draft}/ops"),
        Some(json!({"ops": ops})),
    )
    .await
}

/// 上传一份小文件（一片）经重建路径：创建、传片、完成，等核对任务。返回上传编号。
async fn upload_small(
    app: &TestApp,
    space: &str,
    purpose: &str,
    format: &str,
    bytes: &[u8],
) -> String {
    let base = format!("{}/uploads/{purpose}", rb(space));
    let reply = rebuilder(
        app,
        Method::POST,
        &base,
        Some(
            json!({"size": bytes.len(), "sha256": metaverse_core::sha256_hex(bytes),
            "partSize": 262144, "format": format}),
        ),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["scope"], "rebuild");
    let upload_id = reply.body["uploadId"].as_str().unwrap().to_owned();
    let token = identity_with(ORG, &[REBUILD]);
    let reply = app
        .send(
            Method::PUT,
            &format!("{base}/{upload_id}/parts/0"),
            &[("x-nyxid-identity-token", token.as_str())],
            Payload::Raw("application/octet-stream", bytes.to_vec()),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = rebuilder(
        app,
        Method::POST,
        &format!("{base}/{upload_id}/complete"),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    assert_eq!(
        reply.header(axum::http::header::LOCATION),
        format!(
            "{}/jobs/{}",
            rb(space),
            reply.body["jobId"].as_str().unwrap()
        )
    );
    let job = app.wait_job(reply.body["jobId"].as_str().unwrap()).await;
    assert_eq!(job.get_str("status").unwrap(), "done", "{job:?}");
    upload_id
}

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

/// 重建路径的写操作始终要求 `metaverse:rebuild:write`：总开关开和关两种配置都是 403；
/// `metaverse:content:write` 不够，开关打开时重建路径也不要求它；读操作不要求；member 带着重建权限
/// 也是 403（不是"管理"级别）。
#[tokio::test]
async fn rebuild_writes_always_require_the_rebuild_permission() {
    for enforced in [false, true] {
        let env: &[(&str, &str)] = if enforced {
            &[("METAVERSE_REQUIRE_PERMISSIONS", "true")]
        } else {
            &[]
        };
        let Some(app) = TestApp::start_with_env(env).await else {
            return;
        };
        let reply = app
            .org_with(
                &[CREATE],
                Method::POST,
                "/api/v1/admin/spaces",
                Some(json!({"id": SPACE, "name": "前厅", "owner": {"kind": "org", "id": ORG}})),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
        let drafts = format!("{}/drafts", rb(SPACE));
        let upload = format!("{}/uploads/bundle", rb(SPACE));
        let upload_body =
            json!({"size": 10, "sha256": "a".repeat(64), "partSize": 262144, "format": "json"});
        // 没有任何权限、只有 content:write：403 rebuild_permission_required。
        for permissions in [&[][..], &[CONTENT][..], &["metaverse:rebuild:*"][..]] {
            for (path, body) in [(&drafts, None), (&upload, Some(upload_body.clone()))] {
                let reply = app.org_with(permissions, Method::POST, path, body).await;
                assert_eq!(
                    reply.status,
                    StatusCode::FORBIDDEN,
                    "{enforced} {permissions:?} {path}"
                );
                assert_eq!(reply.body["code"], "rebuild_permission_required");
            }
        }
        // 只有重建权限（开关打开时也不要求 content:write）：可以建草稿。
        let draft = new_rebuild_draft(&app, SPACE, None).await;
        // 读操作只按访问级别。
        for path in [
            draft.clone(),
            format!("{}/jobs", rb(SPACE)),
            format!("/api/v1/spaces/{SPACE}"),
        ] {
            let reply = app.org_with(&[], Method::GET, &path, None).await;
            assert_eq!(reply.status, StatusCode::OK, "{path} {:?}", reply.body);
        }
        // 交包、预览、发布、丢弃：没有重建权限一律 403，草稿不变。
        for (method, suffix, body) in [
            (
                Method::POST,
                "/bundle",
                Some(json!({"assetHash": "a".repeat(64)})),
            ),
            (Method::POST, "/preview", None),
            (Method::POST, "/publish", None),
            (Method::DELETE, "", None),
        ] {
            let reply = app
                .org_with(
                    &[CONTENT],
                    method.clone(),
                    &format!("{draft}{suffix}"),
                    body,
                )
                .await;
            assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {suffix}");
            assert_eq!(reply.body["code"], "rebuild_permission_required");
        }
        assert_eq!(
            app.org_with(&[], Method::GET, &draft, None).await.body["rev"],
            0
        );
        // 组织 member 带着重建权限：只读级别，写操作 403；读可以。
        let reply = as_caller(
            &app,
            "bob",
            Some("member-token"),
            &[REBUILD],
            Method::POST,
            &drafts,
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{:?}", reply.body);
        assert_eq!(reply.body["code"], "forbidden");
        let reply = as_caller(
            &app,
            "bob",
            Some("member-token"),
            &[],
            Method::GET,
            &draft,
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        // 不是成员：写和读都是 404（带着重建权限也一样）。
        let reply = as_caller(
            &app,
            "eve",
            Some("stranger-token"),
            &[REBUILD],
            Method::POST,
            &drafts,
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND);
        // 带重建权限丢弃：可以。
        let reply = rebuilder(&app, Method::DELETE, &draft, None).await;
        assert_eq!(reply.status, StatusCode::NO_CONTENT);
    }
}

// ---------------------------------------------------------------------------
// 全套接口
// ---------------------------------------------------------------------------

/// 重建路径的全套接口：经重建路径真实上传清单（核对、check）、建草稿、交包（展开结果）、第二个包
/// 409、预览（只给可预览的资源）、发布（发布者类别、扫描、坐标系、拍摄时间、说明和建模记录、
/// assetRefs 只登记可预览的资源）、快照的对齐信息、同一个包再推一次没有变化、同一扫描换变换时
/// 拍摄时间沿用、坐标系不变。
#[tokio::test]
async fn rebuild_path_end_to_end() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let token = app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let space = app
        .org(Method::GET, &format!("/api/v1/spaces/{SPACE}"), None)
        .await;
    assert_eq!(space.body["uploadLimits"]["v"], 1);
    assert_eq!(space.body["uploadLimits"]["model"]["maxTriangles"], 100_000);
    assert_eq!(space.body["uploadLimits"]["bundle"]["maxBytes"], 16 << 20);
    assert!(app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap()
        .get("frame")
        .is_none());
    let files = register_files(&app, SPACE, "v1").await;
    let manifest_value = full_manifest(&files, "前厅第 4 版：重建层整体替换");
    let manifest_bytes = serde_json::to_vec(&manifest_value).unwrap();
    let manifest_hash = metaverse_core::sha256_hex(&manifest_bytes);

    // 经重建路径上传清单：核对通过，查询上传带 check。
    let upload_id = upload_small(&app, SPACE, "bundle", "json", &manifest_bytes).await;
    let reply = rebuilder(
        &app,
        Method::GET,
        &format!("{}/uploads/bundle/{upload_id}", rb(SPACE)),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["status"], "done");
    assert_eq!(reply.body["assetHash"], manifest_hash.as_str());
    assert_eq!(reply.body["check"]["format"], "json");
    // 同一上传经实体区路径查不到（范围不同）。
    let reply = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/uploads/bundle/{upload_id}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{:?}", reply.body);

    // 建草稿、交包。
    let draft = new_rebuild_draft(&app, SPACE, None).await;
    // 请求体不合法、上传不存在、哈希不是本空间核对通过的清单。
    for (body, status) in [
        (json!({}), StatusCode::UNPROCESSABLE_ENTITY),
        (
            json!({"uploadId": upload_id, "assetHash": manifest_hash}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (json!({"uploadId": "up_missing"}), StatusCode::NOT_FOUND),
        (
            json!({"assetHash": files.notes.hash}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            json!({"assetHash": "e".repeat(64)}),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
    ] {
        let reply = rebuilder(
            &app,
            Method::POST,
            &format!("{draft}/bundle"),
            Some(body.clone()),
        )
        .await;
        assert_eq!(reply.status, status, "{body} {:?}", reply.body);
    }
    let job = apply_bundle(&app, &draft, json!({"uploadId": upload_id})).await;
    let result = job_result(&job);
    assert_eq!(result["applied"], 7, "{result}");
    assert_eq!(result["entities"]["placed"], 4, "{result}");
    assert_eq!(result["entities"]["removed"], 0);
    assert_eq!(result["anchors"]["created"], json!(["counter"]));
    assert_eq!(result["anchors"]["skipped"], json!([]));
    assert_eq!(result["anchorDrift"], json!([]));
    assert_eq!(result["files"], 5);
    assert_eq!(result["manifestHash"], manifest_hash.as_str());
    // 任务经重建路径查得到，实体区路径也查得到；地块路径查不到。
    let job_id = job.get_str("_id").unwrap();
    let reply = rebuilder(
        &app,
        Method::GET,
        &format!("{}/jobs/{job_id}", rb(SPACE)),
        None,
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["kind"], "ops_from_upload");
    assert_eq!(reply.body["scope"], "rebuild");
    let reply = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/jobs/{job_id}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/plots/p1/jobs/{job_id}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = rebuilder(&app, Method::GET, &format!("{}/jobs", rb(SPACE)), None).await;
    let items = reply.body["items"].as_array().unwrap();
    assert!(!items.is_empty());
    assert!(items.iter().all(|item| item["scope"] == "rebuild"));

    // 一个重建草稿只收一个包。
    let reply = rebuilder(
        &app,
        Method::POST,
        &format!("{draft}/bundle"),
        Some(json!({"assetHash": manifest_hash})),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.body["code"], "bundle_already_applied");

    // 草稿：两类资源。
    let view = rebuilder(&app, Method::GET, &draft, None).await.body;
    assert_eq!(view["bundleRef"], manifest_hash.as_str());
    assert_eq!(view["defaultMessage"], "前厅第 4 版：重建层整体替换");
    assert_eq!(view["defaultScriptRef"], files.notes.hash.as_str());
    let mut assets = vec![
        files.web.hash.clone(),
        files.model.hash.clone(),
        files.texture.hash.clone(),
    ];
    assets.sort();
    assert_eq!(view["assets"], json!(assets));
    let mut held = vec![
        manifest_hash.clone(),
        files.scan.hash.clone(),
        files.notes.hash.clone(),
    ];
    held.sort();
    assert_eq!(view["heldAssets"], json!(held));
    assert_eq!(view["touched"]["scan"], true);
    assert_eq!(view["touched"]["rebuiltLayer"], true);
    let ops_hash = view["opsRefs"][0]["assetHash"].as_str().unwrap().to_owned();
    assert_eq!(view["opsRefs"][0]["source"], manifest_hash.as_str());
    assert_eq!(view["opsRefs"][0]["jobId"], job_id);

    // 预览：网页用模型、物件模型、贴图能下载；原始扫描、清单、建模记录、操作文件都是 404。
    let reply = rebuilder(&app, Method::POST, &format!("{draft}/preview"), None).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let preview = format!("Preview {}", reply.body["token"].as_str().unwrap());
    let reply = app.public("/api/public/previews", Some(&preview)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["preview"]["scope"], "rebuild");
    assert_eq!(
        reply.body["scan"]["webModelHashes"],
        json!([files.web.hash])
    );
    assert_eq!(reply.body["scan"]["observedAt"], "2026-10-20T00:00:00.000Z");
    assert!(reply.body["scan"].get("assetHash").is_none());
    assert!(reply.body["scan"].get("alignment").is_none());
    for hash in [&files.web.hash, &files.model.hash, &files.texture.hash] {
        let reply = app
            .public(
                &format!("/api/public/previews/assets/{hash}"),
                Some(&preview),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{hash}");
    }
    for hash in [
        &files.scan.hash,
        &manifest_hash,
        &files.notes.hash,
        &ops_hash,
    ] {
        let reply = app
            .public(
                &format!("/api/public/previews/assets/{hash}"),
                Some(&preview),
            )
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{hash}");
    }

    // 发布。
    let seq = head_seq(&app, SPACE).await;
    let reply = publish(&app, &draft, None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], seq + 1);
    assert!(reply.body.get("unchanged").is_none());
    let commit = commit_at(&app, SPACE, seq + 1).await;
    let actor = commit.get_document("actor").unwrap();
    assert_eq!(actor.get_str("kind").unwrap(), "rebuild");
    assert_eq!(actor.get_str("scope").unwrap(), "rebuild");
    assert_eq!(commit.get_str("bundleRef").unwrap(), manifest_hash);
    assert_eq!(
        commit.get_str("message").unwrap(),
        "前厅第 4 版：重建层整体替换"
    );
    assert_eq!(commit.get_str("scriptRef").unwrap(), files.notes.hash);
    assert_eq!(commit.get_str("opsRef").unwrap(), ops_hash);
    assert_eq!(
        commit.get_str("observedAt").unwrap(),
        "2026-10-20T00:00:00.000Z"
    );
    let scan = commit.get_document("scan").unwrap();
    assert_eq!(scan.get_str("assetHash").unwrap(), files.scan.hash);
    assert_eq!(
        scan.get_document("alignment")
            .unwrap()
            .get_str("method")
            .unwrap(),
        "given"
    );
    // 第一次带扫描的提交固定坐标系。
    let space_doc = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap();
    let frame = space_doc.get_document("frame").unwrap().clone();
    assert_eq!(frame.get_str("referenceScan").unwrap(), files.scan.hash);
    assert_eq!(
        frame.get_str("fixedAt").unwrap(),
        commit.get_str("at").unwrap()
    );
    // assetRefs 只登记可预览的资源。
    for hash in &assets {
        assert_eq!(
            app.collection("assetRefs")
                .count_documents(doc! {"hash": hash, "spaceId": SPACE})
                .await
                .unwrap(),
            1,
            "{hash}"
        );
    }
    for hash in [
        &files.scan.hash,
        &manifest_hash,
        &files.notes.hash,
        &ops_hash,
    ] {
        assert_eq!(
            app.collection("assetRefs")
                .count_documents(doc! {"hash": hash})
                .await
                .unwrap(),
            0,
            "{hash}"
        );
    }
    // 快照：/api/v1 带对齐信息和原始扫描，公开快照不带。
    let reply = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/snapshot"),
            None,
        )
        .await;
    assert_eq!(reply.body["scan"]["alignment"]["rotationDeg"], -61.42);
    assert_eq!(reply.body["scan"]["assetHash"], files.scan.hash.as_str());
    assert_eq!(
        rebuilt_ids(&app, SPACE).await,
        ["rb.chair-1", "rb.counter", "rb.stool", "rb.stool-1"]
    );
    let reply = app
        .public(
            &format!("/api/public/spaces/{SPACE}/snapshot?seq={}", seq + 1),
            Some(&format!("Share {token}")),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert!(reply.body["scan"].get("alignment").is_none());
    assert!(reply.body["scan"].get("assetHash").is_none());
    // 公开的提交列表：发布者类别是 rebuild。
    let reply = app
        .public(
            &format!("/api/public/spaces/{SPACE}/timeline"),
            Some(&format!("Share {token}")),
        )
        .await;
    let last = reply.body["items"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    assert_eq!(last["actor"]["kind"], "rebuild");

    // 同一个包再推一次：没有变化，不写提交；同一个草稿再发布还是这个结果。
    let (again, job) = push(&app, SPACE, &manifest_value).await;
    let result = job_result(&job);
    assert_eq!(
        result["anchors"]["skipped"],
        json!([{"id": "counter", "reason": "exists"}])
    );
    for _ in 0..2 {
        let reply = publish(&app, &again, None).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        assert_eq!(reply.body["unchanged"], true);
        assert_eq!(reply.body["seq"], seq + 1);
        assert!(reply.body.get("commitId").is_none());
    }
    assert_eq!(head_seq(&app, SPACE).await, seq + 1);
    let view = rebuilder(&app, Method::GET, &again, None).await.body;
    assert_eq!(view["status"], "published");
    assert_eq!(view["unchanged"], true);

    // 同一扫描换了变换、清单不写拍摄时间：写扫描，拍摄时间沿用；坐标系不变。
    let mut moved = IDENTITY;
    moved[12] = 0.5;
    let shifted = manifest(
        "重新对齐",
        json!({"scan": scan_of(&files, None, moved)}),
        vec![files.scan.entry(), files.web.entry()],
    );
    let (draft3, job) = push(&app, SPACE, &shifted).await;
    job_result(&job);
    let reply = publish(&app, &draft3, Some(json!({"message": "人写的说明"}))).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let commit = commit_at(&app, SPACE, seq + 2).await;
    assert_eq!(commit.get_str("message").unwrap(), "人写的说明");
    assert_eq!(
        commit.get_str("observedAt").unwrap(),
        "2026-10-20T00:00:00.000Z"
    );
    assert_eq!(
        commit
            .get_document("scan")
            .unwrap()
            .get_array("transform")
            .unwrap()[12],
        mongodb::bson::Bson::Double(0.5)
    );
    // 没有写 scriptRef（包里没有建模记录）。
    assert!(commit.get_str("scriptRef").is_err());
    let space_doc = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(space_doc.get_document("frame").unwrap(), &frame);
    let reply = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/snapshot"),
            None,
        )
        .await;
    assert_eq!(reply.body["scan"]["observedAt"], "2026-10-20T00:00:00.000Z");
    assert_eq!(reply.body["scan"]["transform"][12], 0.5);
    // 重建层没动。
    assert_eq!(rebuilt_ids(&app, SPACE).await.len(), 4);
}

// ---------------------------------------------------------------------------
// 两种草稿互不相通
// ---------------------------------------------------------------------------

/// 实体区草稿不能写重建层、不能放 `rb.` 编号、不能用 `setScan`、`clearRebuilt`；重建草稿只能经重建
/// 路径操作，没有内联操作的接口，清单不能写扩展层；上传用途按路径分开。
#[tokio::test]
async fn physical_and_rebuild_drafts_stay_apart() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let draft = ext_draft(&app, SPACE).await;
    let files = register_files(&app, SPACE, "apart").await;
    for (ops, code) in [
        (json!([boxy("wall", 2.0, 2.0)]), "invalid_op"),
        (
            json!([{"op": "placeEntity", "entity": {"entityId": "rb.lamp", "layer": "ext", "kind": "object",
                "shape": {"type": "box", "size": [1, 1, 1], "transform": {"position": [2, 0, 2]}},
                "bounds": {"min": [1.5, 0, 1.5], "max": [2.5, 1, 2.5]}}}]),
            "invalid_op",
        ),
        (
            json!([{"op": "setScan", "scan": scan_of(&files, None, IDENTITY)}]),
            "op_not_allowed",
        ),
        (json!([{"op": "clearRebuilt"}]), "op_not_allowed"),
    ] {
        let ops = if ops[0].get("op").is_some() {
            ops
        } else {
            json!([{"op": "placeEntity", "entity": ops[0]}])
        };
        let reply = append(&app, &draft, ops.clone()).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{ops}");
        assert_eq!(reply.body["code"], code, "{ops} {:?}", reply.body);
    }
    let rebuild_draft = new_rebuild_draft(&app, SPACE, None).await;
    let rebuild_id = rebuild_draft.rsplit('/').next().unwrap().to_owned();
    let ext_id = draft.rsplit('/').next().unwrap().to_owned();
    // 重建草稿经实体区路径、实体区草稿经重建路径：一律 404。
    for path in [
        format!("/api/v1/spaces/{SPACE}/drafts/{rebuild_id}"),
        format!("{}/drafts/{ext_id}", rb(SPACE)),
    ] {
        assert_eq!(
            rebuilder(&app, Method::GET, &path, None).await.status,
            StatusCode::NOT_FOUND,
            "{path}"
        );
        assert_eq!(
            rebuilder(&app, Method::POST, &format!("{path}/publish"), None)
                .await
                .status,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    let reply = rebuilder(
        &app,
        Method::POST,
        &format!("{}/drafts/{ext_id}/bundle", rb(SPACE)),
        Some(json!({"assetHash": "a".repeat(64)})),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // 重建路径没有内联操作和操作文件的接口。
    for suffix in ["/ops", "/ops-from-upload"] {
        let reply = rebuilder(
            &app,
            Method::POST,
            &format!("{rebuild_draft}{suffix}"),
            Some(json!({"ops": []})),
        )
        .await;
        assert!(
            matches!(
                reply.status,
                StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
            ),
            "{suffix} {}",
            reply.status
        );
    }
    // 还没交包的重建草稿不能发布。
    let reply = publish(&app, &rebuild_draft, None).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    // 清单把物件写进扩展层：展开任务失败（内容问题，不重试），草稿不变。
    let bad = manifest(
        "写错层",
        json!({"rebuilt": {"mode": "merge", "entities": [
            {"entityId": "rb.x", "layer": "ext", "kind": "object",
             "shape": {"type": "box", "size": [1, 1, 1], "transform": {"position": [2, 0, 2]}},
             "bounds": {"min": [1.5, 0, 1.5], "max": [2.5, 1, 2.5]}}]}}),
        vec![],
    );
    let hash = put_manifest(&app, SPACE, &bad).await;
    let job = apply_bundle(&app, &rebuild_draft, json!({"assetHash": hash})).await;
    assert_eq!(job.get_str("status").unwrap(), "failed");
    let error = job.get_document("lastError").unwrap();
    assert_eq!(error.get_str("class").unwrap(), "content");
    assert!(
        error.get_str("message").unwrap().contains("layer"),
        "{error:?}"
    );
    assert_eq!(
        rebuilder(&app, Method::GET, &rebuild_draft, None)
            .await
            .body["rev"],
        0
    );
    // 上传用途按路径分开：实体区路径不收网页用模型和清单，重建路径不收操作文件。
    let body = json!({"size": 10, "sha256": "a".repeat(64), "partSize": 262144, "format": "glb"});
    for (path, purpose) in [
        (
            format!("/api/v1/spaces/{SPACE}/uploads/webmodel"),
            "webmodel",
        ),
        (
            format!("/api/v1/spaces/{SPACE}/plots/p1/uploads/bundle"),
            "bundle",
        ),
        (format!("{}/uploads/ops", rb(SPACE)), "ops"),
    ] {
        let mut body = body.clone();
        if purpose != "webmodel" {
            body["format"] = json!(if purpose == "ops" { "ndjson" } else { "json" });
        }
        let reply = rebuilder(&app, Method::POST, &path, Some(body)).await;
        assert_eq!(
            reply.status,
            StatusCode::FORBIDDEN,
            "{path} {:?}",
            reply.body
        );
        assert_eq!(reply.body["code"], "scope_violation");
    }
    let reply = rebuilder(
        &app,
        Method::POST,
        &format!("{}/uploads/authored", rb(SPACE)),
        Some(json!({"size": 10, "sha256": "a".repeat(64), "partSize": 262144, "format": "json"})),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

/// 模板只能被同一层引用；发布时在"最新版本 + 本次变化"上查模板完整性：一个草稿删了模板、另一个
/// 草稿刚加了它的使用者时，后发布的 409 `broken_template_ref`。
#[tokio::test]
async fn templates_are_per_layer_and_checked_when_publishing() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let files = register_files(&app, SPACE, "tpl").await;
    let (draft, job) = push(&app, SPACE, &full_manifest(&files, "带模板的重建层")).await;
    job_result(&job);
    assert_eq!(publish(&app, &draft, None).await.status, StatusCode::OK);
    // 扩展层引用重建层的模板：422。
    let instance = |id: &str, template: &str| {
        json!({"op": "placeEntity", "entity": {"entityId": id, "layer": "ext", "kind": "object",
            "shape": {"type": "instance", "template": template, "transform": {"position": [2, 0, 2]}},
            "bounds": {"min": [1.8, 0, 1.8], "max": [2.2, 0.45, 2.2]}}})
    };
    let ext = ext_draft(&app, SPACE).await;
    let reply = append(&app, &ext, json!([instance("stool-x", "rb.stool")])).await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        reply.body
    );
    // 扩展层自己的模板。
    let template = json!({"op": "placeEntity", "entity": {"entityId": "stool", "layer": "ext",
        "kind": "template", "shape": {"type": "box", "size": [0.4, 0.45, 0.4]},
        "bounds": {"min": [-0.2, 0, -0.2], "max": [0.2, 0.45, 0.2]}}});
    let reply = append(&app, &ext, json!([template])).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        app.org(Method::POST, &format!("{ext}/publish"), None)
            .await
            .status,
        StatusCode::OK
    );
    // 同一批里把模板换成普通物件、而它还有使用者：追加后的完整性检查 409，草稿不变。
    let c = ext_draft(&app, SPACE).await;
    let template = json!({"op": "placeEntity", "entity": {"entityId": "table", "layer": "ext",
        "kind": "template", "shape": {"type": "box", "size": [0.4, 0.45, 0.4]},
        "bounds": {"min": [-0.2, 0, -0.2], "max": [0.2, 0.45, 0.2]}}});
    let object = json!({"op": "placeEntity", "entity": {"entityId": "table", "layer": "ext",
        "kind": "object",
        "shape": {"type": "box", "size": [0.4, 0.45, 0.4], "transform": {"position": [3, 0, 3]}},
        "bounds": {"min": [2.8, 0, 2.8], "max": [3.2, 0.45, 3.2]}}});
    let reply = append(
        &app,
        &c,
        json!([template, instance("table-1", "table"), object]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(reply.body["code"], "broken_template_ref");
    assert!(reply.body["detail"]
        .as_str()
        .unwrap()
        .contains("table-1 → table"));
    assert_eq!(app.org(Method::GET, &c, None).await.body["rev"], 0);
    // A 删模板，B 加使用者；先发布 B，再发布 A：409 broken_template_ref。
    let a = ext_draft(&app, SPACE).await;
    let b = ext_draft(&app, SPACE).await;
    let reply = append(
        &app,
        &a,
        json!([{"op": "removeEntity", "entityId": "stool"}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = append(&app, &b, json!([instance("stool-1", "stool")])).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        app.org(Method::POST, &format!("{b}/publish"), None)
            .await
            .status,
        StatusCode::OK
    );
    let seq = head_seq(&app, SPACE).await;
    let reply = app.org(Method::POST, &format!("{a}/publish"), None).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(reply.body["code"], "broken_template_ref");
    assert_eq!(
        reply.body["brokenRefs"],
        json!([{"entityId": "stool-1", "templateId": "stool"}])
    );
    assert_eq!(head_seq(&app, SPACE).await, seq);
    // 带 replay 在最新版本上重放：删模板时它仍被使用，同样不发布。
    let reply = app
        .org(
            Method::POST,
            &format!("{a}/publish"),
            Some(json!({"replay": true})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(head_seq(&app, SPACE).await, seq);
}

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

/// 两个重建草稿交错：A 整体替换、B 合并新增，先发布 A 后发布 B 得 409（键 `layer:rebuilt`），
/// B 重放后结果是"A 的层 + B 新增的"。实体区草稿与重建草稿只在同一锚点编号上冲突。
#[tokio::test]
async fn rebuild_layer_is_one_conflict_unit() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let base = manifest(
        "基础",
        json!({"rebuilt": {"mode": "replace", "entities": [boxy("rb.a", 2.0, 2.0), boxy("rb.b", 3.0, 2.0)]}}),
        vec![],
    );
    let (draft, job) = push(&app, SPACE, &base).await;
    job_result(&job);
    assert_eq!(publish(&app, &draft, None).await.status, StatusCode::OK);
    let replace = manifest(
        "A：整体替换",
        json!({"rebuilt": {"mode": "replace", "entities": [boxy("rb.c", 4.0, 4.0)]}}),
        vec![],
    );
    let merge = manifest(
        "B：合并新增",
        json!({"rebuilt": {"mode": "merge", "entities": [boxy("rb.d", 6.0, 6.0)]}}),
        vec![],
    );
    let (a, job) = push(&app, SPACE, &replace).await;
    let result = job_result(&job);
    assert_eq!(result["entities"]["removed"], 2, "{result}");
    let (b, job) = push(&app, SPACE, &merge).await;
    job_result(&job);

    // A 先发布；B 冲突在 layer:rebuilt。
    assert_eq!(publish(&app, &a, None).await.status, StatusCode::OK);
    let reply = publish(&app, &b, None).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(reply.body["code"], "draft_conflict");
    assert_eq!(
        reply.body["conflicts"],
        json!(["layer:rebuilt"]),
        "{:?}",
        reply.body
    );
    let reply = publish(&app, &b, Some(json!({"replay": true}))).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(rebuilt_ids(&app, SPACE).await, ["rb.c", "rb.d"]);

    // 实体区草稿与重建草稿只在同一个锚点编号上冲突。从同一个版本出发：E 改区块并建锚点 kiosk；
    // R 的包也建 kiosk；R2 的包合并一个物件。
    let e = ext_draft(&app, SPACE).await;
    let reply = append(
        &app,
        &e,
        json!([{"op": "createAnchor", "anchor": anchor("kiosk", [10, 0, 10, 20, 10, 20])},
               {"op": "fill", "box": [0, 0, 0, 2, 2, 2], "block": 2}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let kiosk = manifest(
        "R：只建锚点",
        json!({"anchors": [anchor("kiosk", [30, 0, 30, 40, 10, 40])]}),
        vec![],
    );
    let (r, job) = push(&app, SPACE, &kiosk).await;
    assert_eq!(job_result(&job)["anchors"]["created"], json!(["kiosk"]));
    let more = manifest(
        "R2：合并一个物件",
        json!({"rebuilt": {"mode": "merge", "entities": [boxy("rb.e", 7.0, 2.0)]}}),
        vec![],
    );
    let (r2, job) = push(&app, SPACE, &more).await;
    job_result(&job);
    let e2 = ext_draft(&app, SPACE).await;
    let reply = append(
        &app,
        &e2,
        json!([{"op": "fill", "box": [40, 0, 40, 42, 2, 42], "block": 2}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // E 先发布。
    let reply = app.org(Method::POST, &format!("{e}/publish"), None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // R 只在 anchor:kiosk 上与 E 冲突。
    let reply = publish(&app, &r, None).await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    assert_eq!(
        reply.body["conflicts"],
        json!(["anchor:kiosk"]),
        "{:?}",
        reply.body
    );
    // R2 与 E 不冲突（E 只改扩展层和别的锚点），直接叠加发布。
    let reply = publish(&app, &r2, None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(rebuilt_ids(&app, SPACE).await, ["rb.c", "rb.d", "rb.e"]);
    // 反过来，E2 在 R2 的重建提交之后发布：同样不冲突。
    let reply = app.org(Method::POST, &format!("{e2}/publish"), None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // R 重放：ifNew 按最新版本的历史判断，kiosk 已存在，跳过；没有别的变化，不写提交。
    let seq = head_seq(&app, SPACE).await;
    let reply = publish(&app, &r, Some(json!({"replay": true}))).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["unchanged"], true);
    assert_eq!(head_seq(&app, SPACE).await, seq);
    let anchors = app
        .org(Method::GET, &format!("/api/v1/spaces/{SPACE}"), None)
        .await
        .body["anchors"]
        .clone();
    let kiosk = anchors
        .as_array()
        .unwrap()
        .iter()
        .find(|anchor| anchor["anchorId"] == "kiosk")
        .unwrap()
        .clone();
    assert_eq!(kiosk["box"], json!([10, 0, 10, 20, 10, 20]));
}

// ---------------------------------------------------------------------------
// 幂等、锚点
// ---------------------------------------------------------------------------

/// 合并包推两次，第二次没有变化；实体区草稿删掉的锚点，之后重建包不会把它重新建出来；锚点漂移
/// 列在展开结果里。
#[tokio::test]
async fn merge_bundle_twice_and_deleted_anchors_stay_deleted() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let mut far = boxy("rb.sofa", 8.0, 8.0);
    far["anchorId"] = json!("sofa");
    let merge = manifest(
        "沙发",
        json!({"rebuilt": {"mode": "merge", "entities": [far], "remove": ["rb.gone"]},
               "anchors": [anchor("sofa", [0, 0, 0, 10, 10, 10])]}),
        vec![],
    );
    let (draft, job) = push(&app, SPACE, &merge).await;
    let result = job_result(&job);
    assert_eq!(result["anchors"]["created"], json!(["sofa"]));
    // 沙发在 (8, 8) 米，锚点盒子在原点附近：锚点漂移。
    assert_eq!(
        result["anchorDrift"],
        json!([{"anchorId": "sofa", "entityIds": ["rb.sofa"]}])
    );
    assert_eq!(publish(&app, &draft, None).await.status, StatusCode::OK);
    // 第二次：没有变化。
    let (again, job) = push(&app, SPACE, &merge).await;
    assert_eq!(
        job_result(&job)["anchors"]["skipped"],
        json!([{"id": "sofa", "reason": "exists"}])
    );
    let seq = head_seq(&app, SPACE).await;
    let reply = publish(&app, &again, None).await;
    assert_eq!(reply.body["unchanged"], true, "{:?}", reply.body);
    assert_eq!(head_seq(&app, SPACE).await, seq);
    // 实体区草稿删掉锚点；之后同一个包不会把它建出来（曾经存在）。
    let ext = ext_draft(&app, SPACE).await;
    let reply = append(
        &app,
        &ext,
        json!([{"op": "removeAnchor", "anchorId": "sofa"}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        app.org(Method::POST, &format!("{ext}/publish"), None)
            .await
            .status,
        StatusCode::OK
    );
    let (third, job) = push(&app, SPACE, &merge).await;
    let result = job_result(&job);
    assert_eq!(
        result["anchors"]["skipped"],
        json!([{"id": "sofa", "reason": "existed"}])
    );
    assert_eq!(result["anchors"]["created"], json!([]));
    let seq = head_seq(&app, SPACE).await;
    let reply = publish(&app, &third, None).await;
    assert_eq!(reply.body["unchanged"], true, "{:?}", reply.body);
    assert_eq!(head_seq(&app, SPACE).await, seq);
    let anchors = app
        .org(Method::GET, &format!("/api/v1/spaces/{SPACE}"), None)
        .await
        .body["anchors"]
        .clone();
    assert!(anchors
        .as_array()
        .unwrap()
        .iter()
        .all(|anchor| anchor["anchorId"] != "sofa"));
}

// ---------------------------------------------------------------------------
// 文件角色
// ---------------------------------------------------------------------------

/// 清单里的文件按核对记录判断角色：网页用模型要完整检查过的 glb、原始扫描要网格格式、长度要与
/// 清单一致、要属于本空间；别的空间抢先以别的用途登记同一份 glb，本空间上传过就照样能按物件模型
/// 引用；只有模型的物件要与模型的实测包围盒一致。
#[tokio::test]
async fn bundle_files_are_checked_by_role() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let files = register_files(&app, SPACE, "roles").await;
    // 网页用模型只做过扫描用途的轻量检查；原始扫描是一张图片；别的空间的模型；大小对不上。
    let light = put_file(
        &app,
        SPACE,
        "web/light.glb",
        "webmodel",
        b"glTF light",
        "web_model",
        scan_glb_check(),
    )
    .await;
    let picture = put_file(
        &app,
        SPACE,
        "scan/pic.zip",
        "scan",
        b"JFIF not a scan",
        "scan",
        image_check("jpeg", 64, 64),
    )
    .await;
    let foreign = put_file(
        &app,
        "elsewhere",
        "models/foreign.glb",
        "model",
        b"glTF foreign",
        "model",
        glb_check(CHAIR.0, CHAIR.1, 10),
    )
    .await;
    let mut wrong_size = files.texture.clone();
    wrong_size.size += 1;
    let scan_with = |asset: &str, web: &str| json!({"assetHash": asset, "webModelHashes": [web], "transform": IDENTITY});
    let cases = [
        (
            "轻量 glb 当网页用模型",
            scan_with(&files.scan.hash, &light.hash),
            vec![files.scan.entry(), light.entry()],
        ),
        (
            "图片当原始扫描",
            scan_with(&picture.hash, &files.web.hash),
            vec![picture.entry(), files.web.entry()],
        ),
        (
            "别的空间的文件",
            scan_with(&files.scan.hash, &files.web.hash),
            vec![files.scan.entry(), files.web.entry(), foreign.entry()],
        ),
        (
            "大小与清单不符",
            scan_with(&files.scan.hash, &files.web.hash),
            vec![files.scan.entry(), files.web.entry(), wrong_size.entry()],
        ),
    ];
    for (label, scan, listed) in cases {
        let bad = manifest(label, json!({"scan": scan}), listed);
        let (draft, job) = push(&app, SPACE, &bad).await;
        assert_eq!(job.get_str("status").unwrap(), "failed", "{label} {job:?}");
        let error = job.get_document("lastError").unwrap();
        assert_eq!(error.get_str("class").unwrap(), "content", "{label}");
        assert!(
            error
                .get_str("message")
                .unwrap()
                .contains("核对结果不合用途"),
            "{label} {error:?}"
        );
        assert_eq!(
            rebuilder(&app, Method::GET, &draft, None).await.body["rev"],
            0
        );
    }
    // 别的空间先以"贴图"登记同一份 glb；本空间经重建路径上传过同一内容，就能按物件模型引用。
    let shared_bytes = b"glTF shared chair";
    let shared = put_file(
        &app,
        "elsewhere",
        "models/shared.glb",
        "model",
        shared_bytes,
        "texture",
        glb_check(CHAIR.0, CHAIR.1, 50),
    )
    .await;
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_shared", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "scope": "rebuild", "purpose": "model", "status": "done",
            "sha256": &shared.hash, "assetHash": &shared.hash,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    let chair = |id: &str, hash: &str, max_y: f64| {
        json!({"entityId": id, "layer": "rebuilt", "kind": "object", "assetHash": hash,
            "bounds": {"min": [1.6, 0, 1.7], "max": [2.4, max_y, 2.3]}})
    };
    // 模型与记录不一致：展开后作用时被拒。
    let mismatch = manifest(
        "尺寸不对",
        json!({"rebuilt": {"mode": "merge", "entities": [chair("rb.chair", &shared.hash, 1.6)]}}),
        vec![shared.entry()],
    );
    let (_, job) = push(&app, SPACE, &mismatch).await;
    assert_eq!(job.get_str("status").unwrap(), "failed");
    assert!(job
        .get_document("lastError")
        .unwrap()
        .get_str("message")
        .unwrap()
        .contains("实测"));
    let ok = manifest(
        "共享的模型",
        json!({"rebuilt": {"mode": "merge", "entities": [chair("rb.chair", &shared.hash, 0.8)]}}),
        vec![shared.entry()],
    );
    let (draft, job) = push(&app, SPACE, &ok).await;
    job_result(&job);
    assert_eq!(publish(&app, &draft, None).await.status, StatusCode::OK);
    assert_eq!(
        app.collection("assetRefs")
            .count_documents(doc! {"hash": &shared.hash, "spaceId": SPACE})
            .await
            .unwrap(),
        1
    );
}

// ---------------------------------------------------------------------------
// 没有实体区
// ---------------------------------------------------------------------------

/// 空间没有定义实体区时，实体区路径和重建路径都可以写"虚拟区和地块以外"的地方：实体区草稿能
/// 挪锚点，虚拟区里的操作被拒；重建包把物件放进虚拟区，展开失败。
#[tokio::test]
async fn spaces_without_a_physical_region() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    // 还没定义任何区域：哪里都能写。
    let draft = ext_draft(&app, SPACE).await;
    let reply = append(
        &app,
        &draft,
        json!([{"op": "createAnchor", "anchor": anchor("door", [0, 0, 0, 10, 10, 10])}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        app.org(Method::POST, &format!("{draft}/publish"), None)
            .await
            .status,
        StatusCode::OK
    );
    // 只定义一个虚拟区和地块。
    let reply = app
        .org(
            Method::PUT,
            &format!("/api/v1/admin/spaces/{SPACE}/layout"),
            Some(json!({
                "regions": [{"id": "garden", "kind": "virtual", "boxes": [[200, 0, 0, 400, 60, 200]]}],
                "plots": [{"id": "p1", "regionId": "garden", "boxes": [[200, 0, 0, 264, 60, 64]]}],
                "message": "只有虚拟区",
            })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let draft = ext_draft(&app, SPACE).await;
    let reply = append(
        &app,
        &draft,
        json!([{"op": "moveAnchor", "anchorId": "door", "box": [210, 0, 10, 220, 10, 20]}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{:?}", reply.body);
    assert_eq!(reply.body["code"], "out_of_scope");
    let reply = append(
        &app,
        &draft,
        json!([{"op": "moveAnchor", "anchorId": "door", "box": [20, 0, 20, 30, 10, 30]}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        app.org(Method::POST, &format!("{draft}/publish"), None)
            .await
            .status,
        StatusCode::OK
    );
    // 重建包：虚拟区里的物件被拒，外面的可以。
    let inside = manifest(
        "放进虚拟区",
        json!({"rebuilt": {"mode": "merge", "entities": [boxy("rb.bench", 12.0, 1.0)]}}),
        vec![],
    );
    let (_, job) = push(&app, SPACE, &inside).await;
    assert_eq!(job.get_str("status").unwrap(), "failed");
    assert!(job
        .get_document("lastError")
        .unwrap()
        .get_str("message")
        .unwrap()
        .contains("范围"));
    let outside = manifest(
        "放在外面",
        json!({"rebuilt": {"mode": "merge", "entities": [boxy("rb.bench", 2.0, 1.0)]}}),
        vec![],
    );
    let (draft, job) = push(&app, SPACE, &outside).await;
    job_result(&job);
    assert_eq!(publish(&app, &draft, None).await.status, StatusCode::OK);
    assert_eq!(rebuilt_ids(&app, SPACE).await, ["rb.bench"]);
}
