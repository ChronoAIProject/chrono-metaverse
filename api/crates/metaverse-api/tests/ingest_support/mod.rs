//! 上传、任务、事件、组合集成测试共用的设施：真实 MongoDB（本地副本集）+ 本地模拟的 NyxID
//! （公钥列表、组织授权接口）。写法与 `tests/api.rs` 相同（改编自 CMA 的 jwt_tests.rs）。
//!
//! - MongoDB 地址取 `METAVERSE_TEST_MONGODB_URI`，默认 `mongodb://127.0.0.1:27018/?replicaSet=rs0`；
//!   每个测试用独立的数据库，结束时删除。设置 `METAVERSE_SKIP_MONGO_TESTS=1` 可跳过；
//! - 测试密钥用 openssl 临时生成，不提交任何私钥；
//! - 处理服务（Python）不在测试里运行：需要它的结果时，直接按约定的文档格式写数据库。

#![allow(dead_code)]

use std::{
    process::Command,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::Path,
    http::{header, HeaderMap, Method, Request, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use metaverse_api::{config::Config, AppState};
use mongodb::bson::{doc, Document};
use ring::{
    rand::SystemRandom,
    signature::{KeyPair, RsaKeyPair, RSA_PKCS1_SHA256},
};
use serde_json::{json, Value};
use tower::ServiceExt;

pub const DEFAULT_MONGODB_URI: &str = "mongodb://127.0.0.1:27018/?replicaSet=rs0";
pub const ISSUER: &str = "http://127.0.0.1/nyx";
pub const AUDIENCE: &str = "urn:chrono-metaverse:api";
pub const SERVICE: &str = "svc-metaverse";
pub const KID: &str = "test-key";
pub const ORG: &str = "org-chronoai";
pub const OTHER_ORG: &str = "org-florist";

struct Signer(RsaKeyPair);

impl Signer {
    fn shared() -> &'static Signer {
        static SIGNER: OnceLock<Signer> = OnceLock::new();
        SIGNER.get_or_init(|| {
            let output = Command::new("openssl")
                .args(["genrsa", "2048"])
                .output()
                .expect("需要 openssl 生成临时测试密钥");
            assert!(output.status.success());
            let pem = String::from_utf8(output.stdout).unwrap();
            let encoded: String = pem.lines().filter(|line| !line.starts_with('-')).collect();
            let der = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap();
            let key = if pem.starts_with("-----BEGIN PRIVATE KEY-----") {
                RsaKeyPair::from_pkcs8(&der)
            } else {
                RsaKeyPair::from_der(&der)
            };
            Signer(key.unwrap())
        })
    }

    fn sign(&self, claims: &Value) -> String {
        let header = json!({"alg":"RS256","typ":"JWT","kid":KID}).to_string();
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let mut signature = vec![0; self.0.public().modulus_len()];
        self.0
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                signed.as_bytes(),
                &mut signature,
            )
            .unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    fn jwks(&self) -> Value {
        fn tlv<'a>(input: &mut &'a [u8], tag: u8) -> &'a [u8] {
            assert_eq!(input[0], tag);
            let head = input[1];
            *input = &input[2..];
            let size = if head < 128 {
                head as usize
            } else {
                let bytes = (head & 127) as usize;
                let size = input[..bytes]
                    .iter()
                    .fold(0_usize, |n, b| (n << 8) | usize::from(*b));
                *input = &input[bytes..];
                size
            };
            let value = &input[..size];
            *input = &input[size..];
            value
        }
        let mut der = self.0.public_key().as_ref();
        let mut sequence = tlv(&mut der, 0x30);
        let n = tlv(&mut sequence, 0x02);
        let e = tlv(&mut sequence, 0x02);
        json!({"keys":[{"kty":"RSA","kid":KID,"alg":"RS256","use":"sig","key_ops":["verify"],
            "n":URL_SAFE_NO_PAD.encode(n.strip_prefix(&[0]).unwrap_or(n)),
            "e":URL_SAFE_NO_PAD.encode(e)}]})
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// 一份合法的身份令牌；每次调用都是新的 jti。
pub fn identity(subject: &str) -> String {
    let now = unix_now();
    Signer::shared().sign(&json!({
        "sub": subject, "iss": ISSUER, "aud": AUDIENCE,
        "iat": now, "exp": now + 60,
        "jti": uuid::Uuid::new_v4().to_string(),
        "nyx_service_id": SERVICE,
        "permissions": [], "roles": [], "groups": []
    }))
}

/// 模拟 NyxID：公钥列表 + 组织授权接口（转发凭据 `admin-token` / `member-token` / `viewer-token`
/// 分别是 admin / member / viewer，其他一律不是成员）。
struct NyxMock {
    base_url: String,
    server: tokio::task::JoinHandle<()>,
}

impl NyxMock {
    async fn start() -> Self {
        let jwks = Signer::shared().jwks();
        let app = Router::new()
            .route("/nyx/jwks", get(move || async move { Json(jwks.clone()) }))
            .route(
                "/api/v1/orgs/{org}/authorization",
                get(
                    move |Path(org): Path<String>, headers: HeaderMap| async move {
                        let credential = headers
                            .get(header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        let token = credential.strip_prefix("Bearer ").unwrap_or_default();
                        // `<角色>-token` 对所有组织有效；`<角色>-token@<组织>` 只对那个组织有效。
                        let (role, only) = match token.split_once('@') {
                            Some((role, only)) => (role, Some(only)),
                            None => (token, None),
                        };
                        if only.is_some_and(|only| only != org) {
                            return StatusCode::NOT_FOUND.into_response();
                        }
                        let role = match role {
                            "admin-token" => "admin",
                            "member-token" => "member",
                            "viewer-token" => "viewer",
                            _ => return StatusCode::NOT_FOUND.into_response(),
                        };
                        Json(json!({
                        "id": org, "your_role": role, "member_count": 3,
                        "is_primary": true, "active_invite_count": 0,
                        "remote_credential_integrity_verification_opt_out": false,
                        "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
                    }))
                    .into_response()
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { base_url, server }
    }
}

impl Drop for NyxMock {
    fn drop(&mut self) {
        self.server.abort();
    }
}

pub struct TestApp {
    pub state: AppState,
    /// 启动时用的配置（部署配置种子的测试要用 `demo_seed`）。
    pub config: Config,
    nyx: NyxMock,
    pub uri: String,
    pub database: String,
    pub client: mongodb::Client,
}

#[derive(Debug)]
pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
}

/// 一个调用者：身份 sub + 可选的转发凭据。
#[derive(Clone, Copy)]
pub struct Who<'a> {
    pub sub: &'a str,
    pub forwarded: Option<&'a str>,
}

pub const fn who(sub: &str) -> Who<'_> {
    Who {
        sub,
        forwarded: None,
    }
}

pub const fn who_with<'a>(sub: &'a str, forwarded: &'a str) -> Who<'a> {
    Who {
        sub,
        forwarded: Some(forwarded),
    }
}

impl TestApp {
    /// 启动；`extra` 是额外的环境变量（例如调小上限）。
    pub async fn start(extra: &[(&str, &str)]) -> Option<Self> {
        if std::env::var("METAVERSE_SKIP_MONGO_TESTS").as_deref() == Ok("1") {
            eprintln!("跳过：METAVERSE_SKIP_MONGO_TESTS=1");
            return None;
        }
        let uri = std::env::var("METAVERSE_TEST_MONGODB_URI")
            .unwrap_or_else(|_| DEFAULT_MONGODB_URI.to_owned());
        let database = format!("metaverse_test_{}", uuid::Uuid::new_v4().simple());
        let nyx = NyxMock::start().await;
        let mut values: Vec<(String, String)> = vec![
            ("MONGODB_URI".into(), uri.clone()),
            ("MONGODB_DATABASE".into(), database.clone()),
            ("NYXID_BASE_URL".into(), nyx.base_url.clone()),
            (
                "NYXID_JWKS_URL".into(),
                format!("{}/nyx/jwks", nyx.base_url),
            ),
            ("NYXID_JWT_ISSUER".into(), ISSUER.to_owned()),
            ("NYXID_JWT_AUDIENCE".into(), AUDIENCE.to_owned()),
            ("ALLOWED_NYX_SERVICE_IDS".into(), SERVICE.to_owned()),
        ];
        values.extend(
            extra
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        );
        let config = Config::from_lookup(|name| {
            values
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        })
        .unwrap();
        let state = AppState::from_config(&config).await.unwrap();
        state.prepare().await.expect("连接本地 MongoDB 并建索引");
        let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
        Some(Self {
            state,
            config,
            nyx,
            uri,
            database,
            client,
        })
    }

    pub fn db(&self) -> mongodb::Database {
        self.client.database(&self.database)
    }

    pub fn collection(&self, name: &str) -> mongodb::Collection<Document> {
        self.db().collection(name)
    }

    async fn dispatch(&self, request: Request<Body>) -> Reply {
        let response = metaverse_api::app(self.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 64 << 20)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply {
            status,
            headers,
            body,
        }
    }

    fn builder(
        method: Method,
        path: &str,
        caller: Option<Who<'_>>,
        headers: &[(&str, &str)],
    ) -> axum::http::request::Builder {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(caller) = caller {
            request = request.header("x-nyxid-identity-token", identity(caller.sub));
            if let Some(token) = caller.forwarded {
                request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request
    }

    /// `/api/v1` 请求（带身份令牌）。
    pub async fn call(
        &self,
        caller: Who<'_>,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Reply {
        self.call_with(caller, method, path, &[], body).await
    }

    pub async fn call_with(
        &self,
        caller: Who<'_>,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Reply {
        let request = Self::builder(method, path, Some(caller), headers);
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        self.dispatch(request).await
    }

    /// 原始字节（分片）。
    pub async fn put_bytes(&self, caller: Who<'_>, path: &str, bytes: Vec<u8>) -> Reply {
        let request = Self::builder(Method::PUT, path, Some(caller), &[])
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .body(Body::from(bytes))
            .unwrap();
        self.dispatch(request).await
    }

    /// 公开读（`authorization` 例如 `Share <令牌>`）。
    pub async fn public(
        &self,
        path: &str,
        authorization: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Reply {
        let mut all: Vec<(&str, &str)> = headers.to_vec();
        if let Some(value) = authorization {
            all.push(("authorization", value));
        }
        let request = Self::builder(Method::GET, path, None, &all)
            .body(Body::empty())
            .unwrap();
        self.dispatch(request).await
    }

    /// 建空间，返回分享令牌原文。
    pub async fn create_space(
        &self,
        caller: Who<'_>,
        id: &str,
        owner_kind: &str,
        owner_id: &str,
        visibility: &str,
    ) -> String {
        let reply = self
            .call(
                caller,
                Method::POST,
                "/api/v1/admin/spaces",
                Some(json!({"id": id, "name": id, "visibility": visibility,
                            "owner": {"kind": owner_kind, "id": owner_id}})),
            )
            .await;
        assert_eq!(
            reply.status,
            StatusCode::CREATED,
            "建空间 {id}: {:?}",
            reply.body
        );
        reply.body["shareToken"]["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// 直接写空间的区域和地块（区域、地块的写接口不在这一分工里）。
    pub async fn set_layout(&self, space: &str, regions: Value, plots: Value) {
        self.collection("spaces")
            .update_one(
                doc! {"_id": space},
                doc! {"$set": {
                    "regions": mongodb::bson::serialize_to_bson(&regions).unwrap(),
                    "plots": mongodb::bson::serialize_to_bson(&plots).unwrap(),
                }},
            )
            .await
            .unwrap();
    }

    /// 直接写锚点当前状态（锚点写接口不在这一分工里）。
    pub async fn insert_anchor(&self, space: &str, owner: Value, body: Value) {
        let id = body["anchorId"].as_str().unwrap().to_owned();
        self.collection("anchors")
            .insert_one(doc! {
                "spaceId": space,
                "id": id,
                "owner": mongodb::bson::serialize_to_bson(&owner).unwrap(),
                "body": mongodb::bson::serialize_to_bson(&body).unwrap(),
            })
            .await
            .unwrap();
    }

    /// 直接写一条提交（提交写入不在这一分工里）：只写本分工读得到的字段，seq 接在空间的
    /// 最新 seq 之后。返回这次的 seq。
    pub async fn insert_commit(
        &self,
        space: &str,
        owner: Value,
        at: &str,
        scan_hash: Option<&str>,
    ) -> i64 {
        let current = self
            .collection("spaces")
            .find_one(doc! {"_id": space})
            .await
            .unwrap()
            .expect("空间存在");
        let head = current.get_document("head").unwrap();
        let seq = match head.get("seq") {
            Some(mongodb::bson::Bson::Int32(n)) => i64::from(*n),
            Some(mongodb::bson::Bson::Int64(n)) => *n,
            other => panic!("head.seq 不是整数：{other:?}"),
        } + 1;
        let mut document = doc! {
            "_id": format!("c_{space}_{seq}"),
            "spaceId": space,
            "owner": mongodb::bson::serialize_to_bson(&owner).unwrap(),
            "seq": seq,
            "at": at,
            "message": "测试提交",
            "actor": {"sub": "worker", "nyxServiceId": SERVICE, "scope": "physical", "kind": "job"},
        };
        if let Some(hash) = scan_hash {
            document.insert(
                "scan",
                doc! {"assetHash": hash, "webModelHashes": [], "transform": [1.0,0.0,0.0,0.0, 0.0,1.0,0.0,0.0, 0.0,0.0,1.0,0.0, 0.0,0.0,0.0,1.0]},
            );
        }
        self.collection("commits")
            .insert_one(document)
            .await
            .unwrap();
        self.collection("spaces")
            .update_one(
                doc! {"_id": space},
                doc! {"$set": {"head.seq": seq, "head.at": at}},
            )
            .await
            .unwrap();
        seq
    }

    /// 模拟处理服务完成 upload_verify（`handlers/upload_verify.py` 的 `_finish`）：登记资源
    /// （files 文档）、把上传标记为 done 并写回 assetHash、format、contentType、verifiedAt。
    pub async fn finish_upload(&self, upload_id: &str, sha256: &str, length: i64) {
        let upload = self
            .collection("uploads")
            .find_one(doc! {"_id": upload_id})
            .await
            .unwrap()
            .expect("上传存在");
        // 处理服务只处理 complete 的上传，读 size / sha256 / purpose。
        assert_eq!(upload.get_str("status").unwrap(), "complete");
        assert_eq!(upload.get_str("sha256").unwrap(), sha256);
        assert_eq!(upload.get_i64("size").unwrap(), length);
        let purpose = upload.get_str("purpose").unwrap().to_owned();
        self.collection("assets.files")
            .insert_one(doc! {
                "_id": upload_id,
                "length": length,
                "chunkSize": 262144_i64,
                "uploadDate": mongodb::bson::DateTime::now(),
                "filename": sha256,
                "metadata": {"sha256": sha256, "uploadId": upload_id, "kind": &purpose,
                             "format": "draco", "contentType": "application/x-draco"},
            })
            .await
            .unwrap();
        self.collection("uploads")
            .update_one(
                doc! {"_id": upload_id, "status": "complete"},
                doc! {"$set": {"status": "done", "assetHash": sha256, "format": "draco",
                "contentType": "application/x-draco", "verifiedAt": ago(0),
                "verifiedSha256": sha256}},
            )
            .await
            .unwrap();
    }

    /// 直接登记一份资源（与处理服务 `assets.put_asset` 相同的 GridFS 布局：256KiB 的数据块 +
    /// `files` 文档，文件名 = 内容哈希）。`metadata` 原样写入，再补上 `sha256`。返回内容哈希。
    pub async fn put_asset(&self, bytes: &[u8], mut metadata: Document) -> String {
        let hash = sha256_hex(bytes);
        let files_id = mongodb::bson::oid::ObjectId::new();
        let chunks: Vec<Document> = bytes
            .chunks(256 * 1024)
            .enumerate()
            .map(|(n, block)| {
                doc! {"files_id": files_id, "n": n as i32, "data": mongodb::bson::Binary {
                    subtype: mongodb::bson::spec::BinarySubtype::Generic,
                    bytes: block.to_vec(),
                }}
            })
            .collect();
        if !chunks.is_empty() {
            self.collection("assets.chunks")
                .insert_many(chunks)
                .await
                .unwrap();
        }
        metadata.insert("sha256", &hash);
        self.collection("assets.files")
            .insert_one(doc! {
                "_id": files_id, "length": bytes.len() as i64, "chunkSize": 256 * 1024,
                "uploadDate": mongodb::bson::DateTime::now(), "filename": &hash,
                "metadata": metadata,
            })
            .await
            .unwrap();
        hash
    }

    /// 模拟处理服务校验失败（`_fail_upload`）。
    pub async fn fail_upload(&self, upload_id: &str, reason: &str) {
        self.collection("uploads")
            .update_one(
                doc! {"_id": upload_id, "status": "complete"},
                doc! {"$set": {"status": "failed", "error": reason, "failedAt": ago(0)}},
            )
            .await
            .unwrap();
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        // 每个测试的数据库用完即删；驱动的后台任务绑定在测试的运行时上，所以在独立线程里删。
        let uri = self.uri.clone();
        let database = self.database.clone();
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                if let Ok(client) = mongodb::Client::with_uri_str(&uri).await {
                    let _ = client.database(&database).drop().await;
                }
            });
        })
        .join();
    }
}

/// 现在之前若干秒的 RFC 3339 时间（毫秒精度）。
pub fn ago(seconds: i64) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        - seconds * 1000;
    metaverse_core::Timestamp::from_millis(millis)
        .unwrap()
        .to_rfc3339()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    metaverse_core::sha256_hex(bytes)
}

pub fn org_owner() -> Value {
    json!({"kind": "org", "id": ORG})
}
