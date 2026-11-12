//! 接口服务集成测试：真实 MongoDB（本地副本集）+ 本地模拟的 NyxID（公钥列表、组织授权接口）。
//!
//! - MongoDB 地址取 `METAVERSE_TEST_MONGODB_URI`，默认 `mongodb://127.0.0.1:27018/?replicaSet=rs0`；
//!   每个测试用独立的数据库，结束时删除。设置 `METAVERSE_SKIP_MONGO_TESTS=1` 可跳过。
//! - 测试密钥用 openssl 临时生成（与 CMA 的测试相同），不提交任何私钥。

use std::{
    process::Command,
    sync::{Arc, Mutex, OnceLock},
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
use mongodb::bson::doc;
use ring::{
    rand::SystemRandom,
    signature::{KeyPair, RsaKeyPair, RSA_PKCS1_SHA256},
};
use serde_json::{json, Value};
use tower::ServiceExt;

const DEFAULT_MONGODB_URI: &str = "mongodb://127.0.0.1:27018/?replicaSet=rs0";
const ISSUER: &str = "http://127.0.0.1/nyx";
const AUDIENCE: &str = "urn:chrono-metaverse:api";
const SERVICE: &str = "svc-metaverse";
const KID: &str = "test-key";
const ORG: &str = "org-chronoai";

#[path = "oauth_support/mod.rs"]
mod oauth_tests;

// ---------------------------------------------------------------------------
// 测试签名密钥（改编自 CMA jwt_tests.rs）
// ---------------------------------------------------------------------------

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

/// 一份合法的身份令牌声明；每次调用都是新的 jti。
fn claims(subject: &str) -> Value {
    let now = unix_now();
    json!({
        "sub": subject, "iss": ISSUER, "aud": AUDIENCE,
        "iat": now, "exp": now + 60,
        "jti": uuid::Uuid::new_v4().to_string(),
        "nyx_service_id": SERVICE,
        "permissions": [], "roles": [], "groups": []
    })
}

fn identity(subject: &str) -> String {
    Signer::shared().sign(&claims(subject))
}

// ---------------------------------------------------------------------------
// 模拟 NyxID：公钥列表 + 组织授权接口
// ---------------------------------------------------------------------------

struct NyxMock {
    base_url: String,
    seen_credentials: Arc<Mutex<Vec<String>>>,
    server: tokio::task::JoinHandle<()>,
    oauth: oauth_tests::MockProvider,
}

impl NyxMock {
    async fn start() -> Self {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let jwks = Signer::shared().jwks();
        let oauth = oauth_tests::MockProvider::default();
        let org_oauth = oauth.clone();
        let app = Router::new()
            .route("/nyx/jwks", get(move || async move { Json(jwks.clone()) }))
            .route(
                "/api/v1/orgs/{org}/authorization",
                get(move |Path(org): Path<String>, headers: HeaderMap| {
                    let recorder = recorder.clone();
                    let oauth = org_oauth.clone();
                    async move {
                        let credential = headers
                            .get(header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        recorder.lock().unwrap().push(credential.clone());
                        let token = credential.strip_prefix("Bearer ").unwrap_or_default();
                        let role = if token.starts_with("oauth-") {
                            match oauth.role(token).await {
                                Some(role) => role,
                                None => return StatusCode::NOT_FOUND.into_response(),
                            }
                        } else { match token {
                            "admin-token" => "admin",
                            "member-token" => "member",
                            "viewer-token" => "viewer",
                            "down-token" => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                            "slug-token" => {
                                return Json(json!({"id": "some-other-org", "your_role": "admin"}))
                                    .into_response()
                            }
                            // 转发来的 JWT：服务端已核对过 sub，这里当作 admin。
                            jwt if jwt.starts_with("eyJ") => "admin",
                            _ => return StatusCode::NOT_FOUND.into_response(),
                        }.to_owned() };
                        Json(json!({
                            "id": org, "your_role": role, "member_count": 3,
                            "is_primary": true, "active_invite_count": 0,
                            "remote_credential_integrity_verification_opt_out": false,
                            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
                        }))
                        .into_response()
                    }
                }),
            );
        let app = oauth.routes(app);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base_url,
            seen_credentials: seen,
            server,
            oauth,
        }
    }
}

impl Drop for NyxMock {
    fn drop(&mut self) {
        self.server.abort();
    }
}

// ---------------------------------------------------------------------------
// 被测服务
// ---------------------------------------------------------------------------

struct TestApp {
    state: AppState,
    nyx: NyxMock,
    uri: String,
    database: String,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl TestApp {
    async fn start() -> Option<Self> {
        Self::start_with(true).await
    }

    async fn start_with(prepare: bool) -> Option<Self> {
        Self::start_with_options(prepare, false).await
    }

    async fn start_with_options(prepare: bool, oauth: bool) -> Option<Self> {
        if std::env::var("METAVERSE_SKIP_MONGO_TESTS").as_deref() == Ok("1") {
            eprintln!("跳过：METAVERSE_SKIP_MONGO_TESTS=1");
            return None;
        }
        let uri = std::env::var("METAVERSE_TEST_MONGODB_URI")
            .unwrap_or_else(|_| DEFAULT_MONGODB_URI.to_owned());
        let database = format!("metaverse_test_{}", uuid::Uuid::new_v4().simple());
        let nyx = NyxMock::start().await;
        // 签发方只是一个字符串，但校验器要求它是合法地址；用本机地址。
        let mut values = vec![
            ("MONGODB_URI", uri.clone()),
            ("MONGODB_DATABASE", database.clone()),
            ("NYXID_BASE_URL", nyx.base_url.clone()),
            ("NYXID_JWKS_URL", format!("{}/nyx/jwks", nyx.base_url)),
            ("NYXID_JWT_ISSUER", ISSUER.to_owned()),
            ("NYXID_JWT_AUDIENCE", AUDIENCE.to_owned()),
            ("ALLOWED_NYX_SERVICE_IDS", format!("{SERVICE},svc-catalog")),
        ];
        if oauth {
            values.extend(oauth_tests::config_values());
            values.push(("CMA_BASE_URL", nyx.base_url.clone()));
        }
        let config = Config::from_lookup(|name| {
            values
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.clone())
        })
        .unwrap();
        let state = AppState::from_config(&config).await.unwrap();
        if prepare {
            state.prepare().await.expect("连接本地 MongoDB 并建索引");
        }
        Some(Self {
            state,
            nyx,
            uri,
            database,
        })
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = metaverse_api::app(self.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply {
            status,
            headers,
            body,
        }
    }

    async fn create(&self, identity: &str, forwarded: Option<&str>, body: Value) -> Reply {
        let bearer = forwarded.map(|token| format!("Bearer {token}"));
        let mut headers = vec![("x-nyxid-identity-token", identity)];
        if let Some(bearer) = &bearer {
            headers.push(("authorization", bearer.as_str()));
        }
        self.send(Method::POST, "/api/v1/admin/spaces", &headers, Some(body))
            .await
    }

    async fn read(&self, space: &str, identity: &str, forwarded: Option<&str>) -> Reply {
        let bearer = forwarded.map(|token| format!("Bearer {token}"));
        let mut headers = vec![("x-nyxid-identity-token", identity)];
        if let Some(bearer) = &bearer {
            headers.push(("authorization", bearer.as_str()));
        }
        self.send(
            Method::GET,
            &format!("/api/v1/spaces/{space}"),
            &headers,
            None,
        )
        .await
    }

    async fn public(&self, space: &str, authorization: Option<&str>) -> Reply {
        let headers: Vec<_> = authorization
            .map(|value| ("authorization", value))
            .into_iter()
            .collect();
        self.send(
            Method::GET,
            &format!("/api/public/spaces/{space}"),
            &headers,
            None,
        )
        .await
    }

    fn seen_credentials(&self) -> Vec<String> {
        self.nyx.seen_credentials.lock().unwrap().clone()
    }

    /// 测试里直接写锚点当前状态（锚点写接口还没实现）。
    async fn insert_anchor(&self, space: &str, owner: Value, body: Value) {
        let client = mongodb::Client::with_uri_str(&self.uri).await.unwrap();
        let id = body["anchorId"].as_str().unwrap().to_owned();
        client
            .database(&self.database)
            .collection::<mongodb::bson::Document>("anchors")
            .insert_one(doc! {
                "spaceId": space,
                "id": id,
                "owner": mongodb::bson::serialize_to_bson(&owner).unwrap(),
                "body": mongodb::bson::serialize_to_bson(&body).unwrap(),
            })
            .await
            .unwrap();
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        // 每个测试的数据库用完即删。驱动的后台任务绑定在测试的运行时上，
        // 所以在独立线程里用新的客户端删除。
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

fn space_body(id: &str, owner_kind: &str, owner_id: &str) -> Value {
    json!({"id": id, "name": "前厅", "owner": {"kind": owner_kind, "id": owner_id}})
}

// ---------------------------------------------------------------------------
// 身份层
// ---------------------------------------------------------------------------

#[tokio::test]
async fn identity_failures_are_401() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let path = "/api/v1/spaces/front-hall";
    let signer = Signer::shared();
    let mut cases: Vec<(&str, Vec<(&str, String)>)> = vec![
        ("缺少令牌", vec![]),
        ("只有明文身份头", vec![("x-nyxid-user-id", "alice".into())]),
        (
            "乱码令牌",
            vec![("x-nyxid-identity-token", "not.a.jwt".into())],
        ),
    ];
    let mut expired = claims("alice");
    expired["iat"] = json!(unix_now() - 120);
    expired["exp"] = json!(unix_now() - 60);
    let mut wrong_audience = claims("alice");
    wrong_audience["aud"] = json!("https://someone-else.example");
    let mut unknown_service = claims("alice");
    unknown_service["nyx_service_id"] = json!("svc-someone-elses-connection");
    let mut access_token = claims("alice");
    access_token["token_type"] = json!("access");
    let mut too_long = claims("alice");
    too_long["exp"] = json!(unix_now() + 3600);
    for (name, value) in [
        ("已过期", expired),
        ("受众不对", wrong_audience),
        ("服务编号不在允许列表", unknown_service),
        ("访问令牌冒充身份令牌", access_token),
        ("有效期超过 60 秒", too_long),
    ] {
        cases.push((name, vec![("x-nyxid-identity-token", signer.sign(&value))]));
    }
    let forged = {
        let token = identity("alice");
        let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
        let mut tampered = claims("mallory");
        tampered["jti"] = json!("forged");
        parts[1] = URL_SAFE_NO_PAD.encode(tampered.to_string());
        parts.join(".")
    };
    cases.push(("篡改过的令牌", vec![("x-nyxid-identity-token", forged)]));
    for (name, headers) in cases {
        let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let reply = app.send(Method::GET, path, &headers, None).await;
        assert_eq!(
            reply.status,
            StatusCode::UNAUTHORIZED,
            "{name}: {:?}",
            reply.body
        );
        assert_eq!(reply.body["code"], "unauthenticated", "{name}");
        assert_eq!(
            reply.headers.get(header::CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
    }
    // 对照：合法令牌通过身份层，空间不存在所以是 404。
    let reply = app.read("front-hall", &identity("alice"), None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // 允许列表里的第二个服务编号同样可用。
    let mut catalog = claims("alice");
    catalog["nyx_service_id"] = json!("svc-catalog");
    let reply = app.read("front-hall", &signer.sign(&catalog), None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn replayed_jti_is_rejected() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let token = identity("alice");
    let first = app
        .create(&token, None, space_body("alice-room", "person", "alice"))
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);
    let replay = app
        .create(&token, None, space_body("alice-room-2", "person", "alice"))
        .await;
    assert_eq!(replay.status, StatusCode::UNAUTHORIZED);
    assert!(replay.body["detail"]
        .as_str()
        .unwrap()
        .contains("token_replayed"));
    // 重放的请求没有产生任何效果。
    let check = app.read("alice-room-2", &identity("alice"), None).await;
    assert_eq!(check.status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// 建空间与组织角色
// ---------------------------------------------------------------------------

#[tokio::test]
async fn org_admin_creates_org_space_with_evidence() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let reply = app
        .create(
            &identity("alice"),
            Some("admin-token"),
            json!({"id": "front-hall", "name": "公司前厅", "description": "演示空间",
                   "owner": {"kind": "org", "id": ORG}}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(
        reply.headers.get(header::LOCATION).unwrap(),
        "/api/v1/spaces/front-hall"
    );
    assert_eq!(
        reply.headers.get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let space = &reply.body["space"];
    assert_eq!(space["owner"], json!({"kind": "org", "id": ORG}));
    assert_eq!(space["visibility"], "unlisted");
    // 建空间时自动写第一次提交（`_space` 锚点 + 通用方块表）。
    assert_eq!(space["head"]["seq"], 1);
    let evidence = &space["ownerEvidence"];
    assert_eq!(evidence["basis"], "org_admin");
    assert_eq!(evidence["roleAtVerification"], "admin");
    assert_eq!(evidence["verifiedBy"], "alice");
    assert_eq!(evidence["orgId"], ORG);
    assert_eq!(evidence["issuer"], ISSUER);
    let token = reply.body["shareToken"]["token"].as_str().unwrap();
    assert!(token.len() >= 43);
    assert!(space.get("shareTokens").is_none());
    // 组织角色是用调用者自己转发来的凭据查的。
    assert_eq!(app.seen_credentials(), ["Bearer admin-token"]);
}

#[tokio::test]
async fn org_member_viewer_and_strangers_cannot_create() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let body = || space_body("front-hall", "org", ORG);
    for credential in ["member-token", "viewer-token", "stranger-token"] {
        let reply = app.create(&identity("bob"), Some(credential), body()).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{credential}");
        assert_eq!(reply.body["code"], "forbidden");
    }
    // 查不到组织角色：写操作返回 503。
    for credential in [None, Some("down-token"), Some("slug-token")] {
        let reply = app.create(&identity("bob"), credential, body()).await;
        assert_eq!(
            reply.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{credential:?}"
        );
        assert_eq!(reply.body["code"], "org_membership_unavailable");
    }
    // 以上都没有建出空间。
    let reply = app.read("front-hall", &identity(ORG), None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn org_itself_and_person_owners() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    // 组织的 agent key：令牌 sub 就是组织，不用查角色。
    let reply = app
        .create(&identity(ORG), None, space_body("restaurant", "org", ORG))
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["space"]["ownerEvidence"]["basis"], "org_subject");
    assert!(app.seen_credentials().is_empty());
    // 个人空间只能本人建。
    let reply = app
        .create(
            &identity("carol"),
            None,
            space_body("carol-home", "person", "carol"),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert!(reply.body["space"].get("ownerEvidence").is_none());
    let reply = app
        .create(
            &identity("carol"),
            Some("admin-token"),
            space_body("dave-home", "person", "dave"),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    // 编号重复、格式不对、字段拼错。
    let reply = app
        .create(&identity(ORG), None, space_body("restaurant", "org", ORG))
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    for bad in [
        space_body("Bad_Id", "org", ORG),
        space_body("ok-id", "org", "org/slug"),
        json!({"id": "ok-id", "name": "x", "owner": {"kind": "org", "id": ORG}, "ownerEvidence": {}}),
        json!({"id": "ok-id", "name": "  ", "owner": {"kind": "org", "id": ORG}}),
        json!({"id": "ok-id", "name": "x", "owner": {"kind": "team", "id": ORG}}),
    ] {
        let reply = app.create(&identity(ORG), None, bad.clone()).await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{bad}: {:?}",
            reply.body
        );
    }
}

#[tokio::test]
async fn forwarded_jwt_must_belong_to_the_same_subject() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let access = |subject: &str| {
        let now = unix_now();
        Signer::shared().sign(&json!({
            "sub": subject, "iss": ISSUER, "aud": "nyxid", "iat": now, "exp": now + 900,
            "jti": uuid::Uuid::new_v4().to_string(), "scope": "openid", "token_type": "access"
        }))
    };
    // 别人的访问令牌：不调用 NyxID，直接判为不是成员。
    let reply = app
        .create(
            &identity("alice"),
            Some(&access("mallory")),
            space_body("hall-a", "org", ORG),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert!(app.seen_credentials().is_empty());
    let reply = app
        .create(
            &identity("alice"),
            Some(&access("alice")),
            space_body("hall-a", "org", ORG),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(app.seen_credentials().len(), 1);
}

// ---------------------------------------------------------------------------
// 读接口
// ---------------------------------------------------------------------------

#[tokio::test]
async fn space_reads_follow_the_access_table() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let reply = app
        .create(&identity(ORG), None, space_body("front-hall", "org", ORG))
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let owner = json!({"kind": "org", "id": ORG});
    app.insert_anchor(
        "front-hall",
        owner.clone(),
        json!({"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 10, 15, 10], "visibility": "public"}),
    )
    .await;
    app.insert_anchor(
        "front-hall",
        owner,
        json!({"anchorId": "safe", "kind": "zone", "position": [1, 0, 1], "visibility": "internal"}),
    )
    .await;
    // 组织本身、admin、member、viewer 都能读，包括内部级锚点。
    for (subject, credential) in [
        (ORG, None),
        ("alice", Some("admin-token")),
        ("bob", Some("member-token")),
        ("vic", Some("viewer-token")),
    ] {
        let reply = app.read("front-hall", &identity(subject), credential).await;
        assert_eq!(reply.status, StatusCode::OK, "{subject}");
        // 两个测试锚点 + 建空间时自动创建的 `_space`。
        assert_eq!(
            reply.body["anchors"].as_array().unwrap().len(),
            3,
            "{subject}"
        );
        assert_eq!(reply.headers.get(header::ETAG).unwrap(), "\"1\"");
    }
    // 不是成员、查不到角色（读操作按"不是成员"处理）、没有转发凭据：一律 404。
    for credential in [Some("stranger-token"), Some("down-token"), None] {
        let reply = app.read("front-hall", &identity("eve"), credential).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{credential:?}");
    }
}

#[tokio::test]
async fn public_read_needs_share_token_unless_public() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let created = app
        .create(&identity(ORG), None, space_body("front-hall", "org", ORG))
        .await;
    let token = created.body["shareToken"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = json!({"kind": "org", "id": ORG});
    app.insert_anchor(
        "front-hall",
        owner.clone(),
        json!({"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 10, 15, 10], "visibility": "public"}),
    )
    .await;
    app.insert_anchor(
        "front-hall",
        owner,
        json!({"anchorId": "safe", "kind": "zone", "position": [1, 0, 1], "visibility": "internal"}),
    )
    .await;

    // 凭链接查看：没带令牌、令牌不对、方案不对都是 404，且拒绝响应不缓存。
    let wrong = format!("Share {}", "A".repeat(43));
    let bearer = format!("Bearer {token}");
    for authorization in [
        None,
        Some(wrong.as_str()),
        Some(bearer.as_str()),
        Some("Share short"),
    ] {
        let reply = app.public("front-hall", authorization).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{authorization:?}");
        assert_eq!(
            reply.headers.get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }
    let share = format!("Share {token}");
    let reply = app.public("front-hall", Some(&share)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert!(reply
        .headers
        .get(header::CACHE_CONTROL)
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("private"));
    // 公开投影：只有公开锚点，没有主人、证据和令牌。
    let anchors: Vec<&str> = reply.body["anchors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|anchor| anchor["anchorId"].as_str().unwrap())
        .collect();
    assert_eq!(anchors, ["_space", "t1"]);
    for hidden in ["owner", "ownerEvidence", "shareTokens", "storageLimitBytes"] {
        assert!(reply.body.get(hidden).is_none(), "{hidden}");
    }
    // 不存在的空间同样是 404。
    assert_eq!(
        app.public("no-such-space", Some(&share)).await.status,
        StatusCode::NOT_FOUND
    );

    // 公开空间：不带令牌也能读，可以被共享缓存。
    let created = app
        .create(
            &identity(ORG),
            None,
            json!({"id": "flower-shop", "name": "花店", "visibility": "public",
                   "owner": {"kind": "org", "id": ORG}}),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED);
    let reply = app.public("flower-shop", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["visibility"], "public");
    assert!(reply
        .headers
        .get(header::CACHE_CONTROL)
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("public"));
}

// ---------------------------------------------------------------------------
// 健康检查与 OpenAPI
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_waits_for_indexes_and_openapi_lists_only_v1() {
    let Some(starting) = TestApp::start_with(false).await else {
        return;
    };
    let reply = starting.send(Method::GET, "/api/healthz", &[], None).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.body["status"], "starting");
    let reply = starting.public("front-hall", None).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.body["code"], "starting");
    starting.state.prepare().await.unwrap();
    // 再建一次索引也没问题（幂等）。
    starting.state.prepare().await.unwrap();
    let reply = starting.send(Method::GET, "/api/healthz", &[], None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["status"], "ok");

    let reply = starting
        .send(Method::GET, "/api/openapi.json", &[], None)
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let paths = reply.body["paths"].as_object().unwrap();
    assert!(paths.contains_key("/api/v1/spaces/{space_id}"));
    assert!(paths
        .keys()
        .all(|p| p.starts_with("/api/v1/") && !p.starts_with("/api/v1/admin")));
    assert_eq!(
        reply.body["paths"]["/api/v1/spaces/{space_id}"]["get"]["operationId"],
        "get_space"
    );
    let reply = starting
        .send(Method::GET, "/api/v1/nothing-here", &[], None)
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}
