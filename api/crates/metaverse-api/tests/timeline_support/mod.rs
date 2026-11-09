//! 时间线与公开读集成测试的测试设施：真实本地 MongoDB + 模拟 NyxID（公钥列表、组织授权接口）。
//! 与 `tests/api.rs` 里的设施相同（测试密钥运行时用 openssl 生成），另外提供直接读写数据库的
//! 辅助函数，用来模拟上传和处理服务写入的数据。

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
use mongodb::bson::{doc, oid::ObjectId, spec::BinarySubtype, Binary, DateTime, Document};
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

pub struct Signer(RsaKeyPair);

impl Signer {
    pub fn shared() -> &'static Signer {
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

    pub fn sign(&self, claims: &Value) -> String {
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
                        let role = match credential.strip_prefix("Bearer ").unwrap_or_default() {
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
    nyx: NyxMock,
    pub uri: String,
    pub database: String,
    client: mongodb::Client,
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub bytes: Vec<u8>,
    pub body: Value,
}

impl Reply {
    pub fn header(&self, name: impl axum::http::header::AsHeaderName) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
    }
}

/// 请求体。
pub enum Payload {
    None,
    Json(Value),
    Raw(&'static str, Vec<u8>),
}

impl TestApp {
    pub async fn start() -> Option<Self> {
        Self::start_with_env(&[]).await
    }

    pub async fn start_with_env(extra: &[(&str, &str)]) -> Option<Self> {
        if std::env::var("METAVERSE_SKIP_MONGO_TESTS").as_deref() == Ok("1") {
            eprintln!("跳过：METAVERSE_SKIP_MONGO_TESTS=1");
            return None;
        }
        let uri = std::env::var("METAVERSE_TEST_MONGODB_URI")
            .unwrap_or_else(|_| DEFAULT_MONGODB_URI.to_owned());
        let database = format!("metaverse_test_{}", uuid::Uuid::new_v4().simple());
        let nyx = NyxMock::start().await;
        let mut values = vec![
            ("MONGODB_URI".to_owned(), uri.clone()),
            ("MONGODB_DATABASE".to_owned(), database.clone()),
            ("NYXID_BASE_URL".to_owned(), nyx.base_url.clone()),
            (
                "NYXID_JWKS_URL".to_owned(),
                format!("{}/nyx/jwks", nyx.base_url),
            ),
            ("NYXID_JWT_ISSUER".to_owned(), ISSUER.to_owned()),
            ("NYXID_JWT_AUDIENCE".to_owned(), AUDIENCE.to_owned()),
            ("ALLOWED_NYX_SERVICE_IDS".to_owned(), SERVICE.to_owned()),
            (
                "PUBLIC_BASE_URL".to_owned(),
                "https://metaverse.example".to_owned(),
            ),
        ];
        for (key, value) in extra {
            values.push(((*key).to_owned(), (*value).to_owned()));
        }
        let config = Config::from_lookup(|name| {
            values
                .iter()
                .rev()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        })
        .unwrap();
        let state = AppState::from_config(&config).await.unwrap();
        state.prepare().await.expect("连接本地 MongoDB 并建索引");
        let client = mongodb::Client::with_uri_str(&uri).await.unwrap();
        Some(Self {
            state,
            nyx,
            uri,
            database,
            client,
        })
    }

    pub fn collection(&self, name: &str) -> mongodb::Collection<Document> {
        self.client.database(&self.database).collection(name)
    }

    pub async fn send(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        payload: Payload,
    ) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = match payload {
            Payload::Json(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            Payload::Raw(content_type, bytes) => request
                .header(header::CONTENT_TYPE, content_type)
                .body(Body::from(bytes)),
            Payload::None => request.body(Body::empty()),
        }
        .unwrap();
        let response = metaverse_api::app(self.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 64 << 20)
            .await
            .unwrap()
            .to_vec();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply {
            status,
            headers,
            bytes,
            body,
        }
    }

    /// 带身份令牌（和可选的转发凭据）调用 `/api/v1`。
    pub async fn v1(
        &self,
        method: Method,
        path: &str,
        subject: &str,
        forwarded: Option<&str>,
        payload: Payload,
    ) -> Reply {
        let token = identity(subject);
        let bearer = forwarded.map(|credential| format!("Bearer {credential}"));
        let mut headers = vec![("x-nyxid-identity-token", token.as_str())];
        if let Some(bearer) = &bearer {
            headers.push(("authorization", bearer.as_str()));
        }
        self.send(method, path, &headers, payload).await
    }

    /// 组织本身（组织的 agent key）调用 `/api/v1`。
    pub async fn org(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let payload = body.map_or(Payload::None, Payload::Json);
        self.v1(method, path, ORG, None, payload).await
    }

    /// 公开读。
    pub async fn public(&self, path: &str, authorization: Option<&str>) -> Reply {
        let headers: Vec<_> = authorization
            .map(|value| ("authorization", value))
            .into_iter()
            .collect();
        self.send(Method::GET, path, &headers, Payload::None).await
    }

    /// 建组织空间，返回分享令牌。
    pub async fn create_space(&self, id: &str) -> String {
        let reply = self
            .org(
                Method::POST,
                "/api/v1/admin/spaces",
                Some(json!({"id": id, "name": "测试空间", "owner": {"kind": "org", "id": ORG}})),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
        reply.body["shareToken"]["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// 定义区域：实体区 hall [0,0,0,200,60,200]，虚拟区 garden [200,0,0,400,60,200]，
    /// 地块 p1 [200,0,0,264,60,64]。
    pub async fn define_layout(&self, space: &str) -> Value {
        let reply = self
            .org(
                Method::PUT,
                &format!("/api/v1/admin/spaces/{space}/layout"),
                Some(json!({
                    "regions": [
                        {"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 200, 60, 200]], "name": "前厅"},
                        {"id": "garden", "kind": "virtual", "boxes": [[200, 0, 0, 400, 60, 200]]}
                    ],
                    "plots": [
                        {"id": "p1", "regionId": "garden", "boxes": [[200, 0, 0, 264, 60, 64]]}
                    ],
                    "message": "定义区域"
                })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        reply.body
    }

    /// 把一段字节登记成资源（与处理服务 `assets.put_asset` 相同的 GridFS 布局）。
    pub async fn put_asset(&self, bytes: &[u8], content_type: &str, kind: &str) -> String {
        let hash = metaverse_core::sha256_hex(bytes);
        let files_id = ObjectId::new();
        let chunks: Vec<Document> = bytes
            .chunks(256 * 1024)
            .enumerate()
            .map(|(n, block)| {
                doc! {"files_id": files_id, "n": n as i32,
                "data": Binary { subtype: BinarySubtype::Generic, bytes: block.to_vec() }}
            })
            .collect();
        if !chunks.is_empty() {
            self.collection("assets.chunks")
                .insert_many(chunks)
                .await
                .unwrap();
        }
        self.collection("assets.files")
            .insert_one(doc! {
                "_id": files_id, "length": bytes.len() as i64, "chunkSize": 256 * 1024,
                "uploadDate": DateTime::now(), "filename": &hash,
                "metadata": {"sha256": &hash, "contentType": content_type, "kind": kind},
            })
            .await
            .unwrap();
        hash
    }

    /// 模拟一次已完成校验的 ops 上传：登记资源，并写上传会话（`status: done`）。
    pub async fn put_ops_upload(&self, space: &str, bytes: &[u8]) -> (String, String) {
        let hash = self.put_asset(bytes, "application/x-ndjson", "ops").await;
        let upload_id = format!("up_{}", uuid::Uuid::new_v4().simple());
        self.collection("uploads")
            .insert_one(doc! {
                "_id": &upload_id, "spaceId": space,
                "owner": {"kind": "org", "id": ORG},
                "purpose": "ops", "status": "done", "assetHash": &hash,
                "createdAt": "2026-01-01T00:00:00.000Z",
            })
            .await
            .unwrap();
        (upload_id, hash)
    }

    /// 把资源登记到 `assetRefs`（网页可读）。
    pub async fn register_asset_ref(&self, space: &str, hash: &str) {
        self.collection("assetRefs")
            .insert_one(doc! {"hash": hash, "spaceId": space,
            "owner": {"kind": "org", "id": ORG}, "createdAt": "2026-01-01T00:00:00.000Z"})
            .await
            .unwrap();
    }

    /// 等任务结束，返回任务文档。
    pub async fn wait_job(&self, job_id: &str) -> Document {
        for _ in 0..200 {
            let job = self
                .collection("jobs")
                .find_one(doc! {"_id": job_id})
                .await
                .unwrap()
                .expect("任务记录存在");
            if job.get_str("status").unwrap() != "running" {
                return job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("任务 {job_id} 没有在 10 秒内结束");
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
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

/// 解压区块并核对哈希，返回方块编号（下标 x + 32·(z + 32·y)）。
pub fn decode_chunk(compressed: &[u8], hash: &str) -> Vec<u16> {
    let chunk = metaverse_core::chunk::Chunk::decompress(compressed).expect("区块能解压");
    assert_eq!(chunk.hash(), hash, "区块内容与哈希一致");
    chunk.cells().to_vec()
}
