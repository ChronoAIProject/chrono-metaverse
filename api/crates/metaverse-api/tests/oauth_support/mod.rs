//! 模拟可信 OAuth provider；业务 API、索引、租约、密文均使用真实服务和 MongoDB。
use super::*;
use axum::{extract::Form, routing::post};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

mod catalog_tests;
mod cma_proxy_tests;
mod worker_tests;

const ROOT: &str = "/api/auth/nyxid";
const ORIGIN: &str = "http://localhost:8080";

pub(super) fn config_values() -> Vec<(&'static str, String)> {
    vec![
        ("PUBLIC_BASE_URL", ORIGIN.into()),
        ("NYXID_OAUTH_CLIENT_ID", "metaverse-oauth".into()),
        ("NYXID_OAUTH_CLIENT_SECRET", "test-client-secret".into()),
        (
            "NYXID_OAUTH_ENCRYPTION_KEY",
            base64::engine::general_purpose::STANDARD.encode([42_u8; 32]),
        ),
    ]
}

struct Code {
    challenge: String,
    subject: String,
    ttl: i64,
}

#[derive(Default)]
struct ProviderState {
    codes: HashMap<String, Code>,
    access: HashMap<String, String>,
    refresh: HashMap<String, String>,
    serial: u64,
    refreshes: usize,
    worker_calls: Vec<(String, String, Value)>,
    proxy_denied: bool,
    proxy_configuration_required: bool,
    proxy_queries: Vec<HashMap<String, String>>,
    key_message_failure: bool,
    worker_setup_required: bool,
    worker_creation_proxy_conflict: bool,
    worker_gate: Option<Arc<tokio::sync::Notify>>,
    worker_entered: Option<Arc<tokio::sync::Notify>>,
    role: Option<String>,
    userinfo_down: bool,
    refresh_rejected: bool,
    refresh_subject: Option<String>,
    jwt_access: bool,
    refresh_gate: Option<Arc<tokio::sync::Notify>>,
    refresh_entered: Option<Arc<tokio::sync::Notify>>,
    role_gate: Option<Arc<tokio::sync::Notify>>,
    role_entered: Option<Arc<tokio::sync::Notify>>,
}

#[derive(Clone)]
pub(super) struct MockProvider(Arc<Mutex<ProviderState>>);

impl Default for MockProvider {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(ProviderState {
            role: Some("admin".into()),
            ..Default::default()
        })))
    }
}

impl MockProvider {
    pub(super) async fn role(&self, token: &str) -> Option<String> {
        let (role, gate, entered) = {
            let state = self.0.lock().unwrap();
            (
                state.access.get(token).and(state.role.clone()),
                state.role_gate.clone(),
                state.role_entered.clone(),
            )
        };
        if let Some(entered) = entered {
            entered.notify_one();
        }
        if let Some(gate) = gate {
            gate.notified().await;
        }
        role
    }

    pub(super) fn routes(&self, app: Router) -> Router {
        let token = self.clone();
        let user = self.clone();
        let orgs = self.clone();
        let app = app.route("/oauth/token", post(move |Form(fields): Form<HashMap<String,String>>| {
            let provider = token.clone();
            async move {
                    if fields["grant_type"] == "refresh_token" {
                        let (gate, entered) = {
                            let state = provider.0.lock().unwrap();
                            (state.refresh_gate.clone(), state.refresh_entered.clone())
                        };
                        if let Some(entered) = entered { entered.notify_one(); }
                        if let Some(gate) = gate { gate.notified().await; }
                    }
                let mut state = provider.0.lock().unwrap();
                assert_eq!(fields.get("client_id").unwrap(), "metaverse-oauth");
                assert_eq!(fields.get("client_secret").unwrap(), "test-client-secret");
                let (subject, ttl) = if fields["grant_type"] == "authorization_code" {
                    let code = state.codes.remove(&fields["code"]).unwrap();
                    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(fields["code_verifier"].as_bytes()));
                    assert_eq!(challenge, code.challenge);
                    assert_eq!(fields["redirect_uri"], format!("{ORIGIN}{ROOT}/callback"));
                    (code.subject, code.ttl)
                } else {
                    state.refreshes += 1;
                    if state.refresh_rejected {
                        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_grant"}))).into_response();
                    }
                    let Some(subject) = state.refresh.remove(&fields["refresh_token"]) else {
                        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_grant"}))).into_response();
                    };
                    (state.refresh_subject.clone().unwrap_or(subject), 3600)
                };
                state.serial += 1;
                let access = if state.jwt_access {
                    Signer::shared().sign(&json!({"sub":subject,"iss":ISSUER,"token_type":"access","exp":unix_now()+ttl,"jti":state.serial}))
                } else { format!("oauth-access-{}", state.serial) };
                let refresh = format!("oauth-refresh-{}", state.serial);
                state.access.insert(access.clone(), subject.clone());
                state.refresh.insert(refresh.clone(), subject);
                Json(json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer","expires_in":ttl})).into_response()
            }
        }))
        .route("/api/v1/orgs", get(move |headers: HeaderMap| {
            let provider = orgs.clone();
            async move {
                let state = provider.0.lock().unwrap();
                let token = headers.get(header::AUTHORIZATION).unwrap().to_str().unwrap().strip_prefix("Bearer ").unwrap();
                if !state.access.contains_key(token) { return StatusCode::UNAUTHORIZED.into_response(); }
                let orgs = state.role.as_ref().map(|role| vec![json!({"id":ORG,"slug":"chronoai","display_name":"ChronoAI","your_role":role,"contact_email":"not-forwarded@example.com"})]).unwrap_or_default();
                Json(json!({"orgs":orgs})).into_response()
            }
        }))
        .route("/oauth/userinfo", get(move |headers: HeaderMap| {
            let provider = user.clone();
            async move {
                let state = provider.0.lock().unwrap();
                if state.userinfo_down { return StatusCode::SERVICE_UNAVAILABLE.into_response(); }
                let token = headers.get(header::AUTHORIZATION).unwrap().to_str().unwrap().strip_prefix("Bearer ").unwrap();
                match state.access.get(token) {
                    Some(subject) => Json(json!({"sub":subject})).into_response(),
                    None => StatusCode::UNAUTHORIZED.into_response(),
                }
            }
        }));
        cma_proxy_tests::routes(self.clone(), app)
            .merge(worker_tests::routes(self.clone(), Router::new()))
    }
}

fn response_cookie(reply: &Reply, name: &str) -> String {
    reply
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .find(|h| h.starts_with(&format!("{name}=")))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn begin(app: &TestApp, subject: &str, ttl: i64) -> (String, String) {
    begin_at(app, subject, ttl, false).await
}
async fn begin_at(app: &TestApp, subject: &str, ttl: i64, workspace: bool) -> (String, String) {
    let login = app
        .send(
            Method::GET,
            &format!(
                "{ROOT}/login{}",
                if workspace { "?workspace=1" } else { "" }
            ),
            &[],
            None,
        )
        .await;
    assert_eq!(login.status, StatusCode::SEE_OTHER);
    assert_eq!(login.headers[header::CACHE_CONTROL], "no-store");
    let cookie = response_cookie(&login, "mv_nyx_flow");
    let flags = login.headers[header::SET_COOKIE].to_str().unwrap();
    assert!(flags.contains("HttpOnly") && flags.contains("SameSite=Lax"));
    let url = url::Url::parse(login.headers[header::LOCATION].to_str().unwrap()).unwrap();
    assert_eq!(url.path(), "/oauth/authorize");
    let params: HashMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(params["scope"], "openid offline_access proxy");
    assert!(params["resource"].ends_with("/api/v1/proxy/s/cma"));
    assert_eq!(params["code_challenge_method"], "S256");
    let code = uuid::Uuid::new_v4().to_string();
    app.nyx.oauth.0.lock().unwrap().codes.insert(
        code.clone(),
        Code {
            challenge: params["code_challenge"].clone(),
            subject: subject.into(),
            ttl,
        },
    );
    (
        format!("{ROOT}/callback?code={code}&state={}", params["state"]),
        cookie,
    )
}

async fn connect(app: &TestApp, subject: &str, ttl: i64) -> String {
    let (path, cookie) = begin(app, subject, ttl).await;
    let reply = app
        .send(Method::GET, &path, &[("cookie", &cookie)], None)
        .await;
    assert_eq!(reply.status, StatusCode::SEE_OTHER, "{}", reply.body);
    assert_eq!(reply.headers[header::LOCATION], "/connect?connected=1");
    assert!(!format!("{:?}", reply.headers).contains("oauth-access"));
    response_cookie(&reply, "mv_nyx_session")
}

async fn session(app: &TestApp, cookie: &str) -> Reply {
    app.send(
        Method::GET,
        &format!("{ROOT}/session"),
        &[("cookie", cookie)],
        None,
    )
    .await
}

async fn disconnect(app: &TestApp, cookie: &str) -> Reply {
    let status = session(app, cookie).await;
    let csrf = status.body["csrfToken"].as_str().unwrap();
    app.send(
        Method::POST,
        &format!("{ROOT}/disconnect"),
        &[
            ("cookie", cookie),
            ("origin", ORIGIN),
            ("x-csrf-token", csrf),
        ],
        None,
    )
    .await
}

async fn create_org(app: &TestApp) {
    assert_eq!(
        app.create(&identity(ORG), None, space_body("oauth-hall", "org", ORG))
            .await
            .status,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn oauth_state_is_browser_bound_one_time_and_pkce_protected() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let (path, cookie) = begin(&app, "alice", 3600).await;
    assert_eq!(
        app.send(Method::GET, &path, &[], None).await.headers[header::LOCATION],
        "/connect?error=expired"
    );
    let other = format!("mv_nyx_flow={}", "a".repeat(43));
    assert_eq!(
        app.send(Method::GET, &path, &[("cookie", &other)], None)
            .await
            .headers[header::LOCATION],
        "/connect?error=expired"
    );
    let linked = app
        .send(Method::GET, &path, &[("cookie", &cookie)], None)
        .await;
    assert_eq!(linked.status, StatusCode::SEE_OTHER);
    assert_eq!(
        app.send(Method::GET, &path, &[("cookie", &cookie)], None)
            .await
            .headers[header::LOCATION],
        "/connect?error=expired"
    );
    let cookie = response_cookie(&linked, "mv_nyx_session");
    let status = session(&app, &cookie).await;
    assert_eq!(status.body["subject"], "alice");
    assert_eq!(status.body["connected"], true);
    assert!(!status.body.to_string().contains("oauth-access"));

    let client = mongodb::Client::with_uri_str(&app.uri).await.unwrap();
    let db = client.database(&app.database);
    let grant = db
        .collection::<mongodb::bson::Document>("oauthGrants")
        .find_one(doc! {})
        .await
        .unwrap()
        .unwrap();
    assert!(grant.get_str("ciphertext").unwrap().starts_with("v1."));
    assert!(!format!("{grant:?}").contains("oauth-refresh"));
    let stored = db
        .collection::<mongodb::bson::Document>("oauthSessions")
        .find_one(doc! {})
        .await
        .unwrap()
        .unwrap();
    assert!(!format!("{stored:?}").contains(cookie.split_once('=').unwrap().1));
}

#[tokio::test]
async fn oauth_agent_access_stays_with_signed_subject_and_live_role() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let cookie = connect(&app, "alice", 3600).await;
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.read("oauth-hall", &identity("bob"), None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.send(
            Method::GET,
            "/api/v1/spaces/oauth-hall",
            &[("cookie", &cookie)],
            None
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), Some("invalid-token"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.send(
            Method::GET,
            "/api/v1/spaces/oauth-hall",
            &[
                ("x-nyxid-identity-token", &identity("alice")),
                ("authorization", "Bearer ")
            ],
            None
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    app.nyx.oauth.0.lock().unwrap().role = Some("viewer".into());
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        app.create(&identity("alice"), None, space_body("new-hall", "org", ORG))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    app.nyx.oauth.0.lock().unwrap().role = None;
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn oauth_refresh_uses_database_lease_across_instances() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    connect(&app, "alice", 1).await;
    // 第二个独立 AppState 模拟另一副本；共用数据库和 provider，不共用刷新内存锁。
    let mut values = config_values();
    values.extend([
        ("MONGODB_URI", app.uri.clone()),
        ("MONGODB_DATABASE", app.database.clone()),
        ("NYXID_BASE_URL", app.nyx.base_url.clone()),
        ("NYXID_JWKS_URL", format!("{}/nyx/jwks", app.nyx.base_url)),
        ("NYXID_JWT_ISSUER", ISSUER.into()),
        ("NYXID_JWT_AUDIENCE", AUDIENCE.into()),
        ("ALLOWED_NYX_SERVICE_IDS", SERVICE.into()),
    ]);
    let config = Config::from_lookup(|name| {
        values
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
    })
    .unwrap();
    let second = AppState::from_config(&config).await.unwrap();
    second.prepare().await.unwrap();
    let (a, b) = tokio::join!(
        async { app.read("oauth-hall", &identity("alice"), None).await },
        async {
            let request = Request::builder()
                .uri("/api/v1/spaces/oauth-hall")
                .header("x-nyxid-identity-token", identity("alice"))
                .body(Body::empty())
                .unwrap();
            metaverse_api::app(second)
                .oneshot(request)
                .await
                .unwrap()
                .status()
        },
    );
    assert_eq!(a.status, StatusCode::OK);
    assert_eq!(b, StatusCode::OK);
    assert_eq!(app.nyx.oauth.0.lock().unwrap().refreshes, 1);
}

#[tokio::test]
async fn oauth_refresh_subject_mismatch_and_rejected_grant_fail_closed() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    let cookie = connect(&app, "alice", 1).await;
    app.nyx.oauth.0.lock().unwrap().refresh_subject = Some("bob".into());
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(session(&app, &cookie).await.body["connected"], false);
    assert!(app.seen_credentials().is_empty());
    app.nyx.oauth.0.lock().unwrap().refresh_subject = None;
    connect(&app, "alice", 1).await;
    app.nyx.oauth.0.lock().unwrap().refresh_rejected = true;
    assert_eq!(
        app.create(&identity("alice"), None, space_body("new-hall", "org", ORG))
            .await
            .status,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn oauth_rotated_tokens_survive_transient_subject_check_failure() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    connect(&app, "alice", 1).await;
    app.nyx.oauth.0.lock().unwrap().userinfo_down = true;
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(app.nyx.oauth.0.lock().unwrap().refreshes, 1);
    app.nyx.oauth.0.lock().unwrap().userinfo_down = false;
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(app.nyx.oauth.0.lock().unwrap().refreshes, 1);
}

#[tokio::test]
async fn oauth_disconnect_requires_origin_csrf_and_fences_inflight_lookup() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    let cookie = connect(&app, "alice", 3600).await;
    let status = session(&app, &cookie).await;
    let csrf = status.body["csrfToken"].as_str().unwrap();
    for headers in [
        vec![("cookie", cookie.as_str())],
        vec![
            ("cookie", cookie.as_str()),
            ("origin", "https://evil.example"),
            ("x-csrf-token", csrf),
        ],
    ] {
        assert_eq!(
            app.send(Method::POST, &format!("{ROOT}/disconnect"), &headers, None)
                .await
                .status,
            StatusCode::FORBIDDEN
        );
    }
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    {
        let mut provider = app.nyx.oauth.0.lock().unwrap();
        provider.role_gate = Some(gate.clone());
        provider.role_entered = Some(entered.clone());
    }
    let read = async { app.read("oauth-hall", &identity("alice"), None).await };
    let stop = async {
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        assert_eq!(
            disconnect(&app, &cookie).await.status,
            StatusCode::NO_CONTENT
        );
        gate.notify_one();
    };
    let (read, ()) = tokio::join!(read, stop);
    assert_eq!(read.status, StatusCode::NOT_FOUND);
    assert_eq!(session(&app, &cookie).await.body["connected"], false);
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn oauth_reconnect_invalidates_old_browser_session() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    let old = connect(&app, "alice", 3600).await;
    let old_csrf = session(&app, &old).await.body["csrfToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let new = connect(&app, "alice", 3600).await;
    assert_eq!(session(&app, &old).await.body["connected"], false);
    assert_eq!(
        app.send(
            Method::POST,
            &format!("{ROOT}/disconnect"),
            &[
                ("cookie", &old),
                ("origin", ORIGIN),
                ("x-csrf-token", &old_csrf)
            ],
            None
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(session(&app, &new).await.body["connected"], true);
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn oauth_refresh_survives_request_cancellation_and_cannot_undo_disconnect() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    let cookie = connect(&app, "alice", 1).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    {
        let mut provider = app.nyx.oauth.0.lock().unwrap();
        provider.refresh_gate = Some(gate.clone());
        provider.refresh_entered = Some(entered.clone());
    }
    let state = app.state.clone();
    let request = tokio::spawn(async move {
        metaverse_api::app(state)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/spaces/oauth-hall")
                    .header("x-nyxid-identity-token", identity("alice"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    request.abort();
    gate.notify_one();
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(app.nyx.oauth.0.lock().unwrap().refreshes, 1);

    // 再授权后，在 provider 刷新未完成时断开；迟到的刷新不得重新激活授权。
    let new_cookie = connect(&app, "alice", 1).await;
    assert_eq!(session(&app, &cookie).await.body["connected"], false);
    let read = async { app.read("oauth-hall", &identity("alice"), None).await };
    let stop = async {
        tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        assert_eq!(
            disconnect(&app, &new_cookie).await.status,
            StatusCode::NO_CONTENT
        );
        gate.notify_one();
    };
    let (read, ()) = tokio::join!(read, stop);
    assert_eq!(read.status, StatusCode::NOT_FOUND);
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(session(&app, &new_cookie).await.body["connected"], false);
}

#[tokio::test]
async fn oauth_saved_jwt_access_token_passes_real_signature_subject_validation() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    app.nyx.oauth.0.lock().unwrap().jwt_access = true;
    connect(&app, "alice", 3600).await;
    assert_eq!(
        app.read("oauth-hall", &identity("alice"), None)
            .await
            .status,
        StatusCode::OK
    );
    assert!(app
        .seen_credentials()
        .last()
        .unwrap()
        .starts_with("Bearer eyJ"));
    assert_eq!(
        app.read("oauth-hall", &identity("bob"), None).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn oauth_disabled_denied_and_expired_browser_flows_do_not_authorize() {
    let Some(disabled) = TestApp::start().await else {
        return;
    };
    assert_eq!(
        session(&disabled, "").await.body,
        json!({"enabled":false,"connected":false})
    );
    assert_eq!(
        disabled
            .send(Method::GET, &format!("{ROOT}/login"), &[], None)
            .await
            .status,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let (path, cookie) = begin(&app, "alice", 3600).await;
    let path = format!("{path}&error=access_denied");
    let reply = app
        .send(Method::GET, &path, &[("cookie", &cookie)], None)
        .await;
    assert_eq!(reply.headers[header::LOCATION], "/connect?error=denied");
    assert!(app.nyx.oauth.0.lock().unwrap().access.is_empty());
    let (path, cookie) = begin(&app, "alice", 3600).await;
    let client = mongodb::Client::with_uri_str(&app.uri).await.unwrap();
    let db = client.database(&app.database);
    db.collection::<mongodb::bson::Document>("oauthFlows")
        .update_many(
            doc! {},
            doc! {"$set":{"expiresAt":mongodb::bson::DateTime::from_millis(0)}},
        )
        .await
        .unwrap();
    assert_eq!(
        app.send(Method::GET, &path, &[("cookie", &cookie)], None)
            .await
            .headers[header::LOCATION],
        "/connect?error=expired"
    );
    let cookie = connect(&app, "alice", 3600).await;
    db.collection::<mongodb::bson::Document>("oauthSessions")
        .update_many(
            doc! {},
            doc! {"$set":{"expiresAt":mongodb::bson::DateTime::from_millis(0)}},
        )
        .await
        .unwrap();
    assert_eq!(session(&app, &cookie).await.body["connected"], false);
}

async fn check_connection(app: &TestApp, cookie: &str, body: Value) -> Reply {
    let status = session(app, cookie).await;
    let csrf = status.body["csrfToken"].as_str().unwrap_or_default();
    app.send(
        Method::POST,
        &format!("{ROOT}/check"),
        &[
            ("cookie", cookie),
            ("origin", ORIGIN),
            ("x-csrf-token", csrf),
        ],
        Some(body),
    )
    .await
}

#[tokio::test]
async fn oauth_browser_lists_only_connected_account_organizations_and_safe_fields() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "alice", 3600).await;
    let session = session(&app, &cookie).await;
    let csrf = session.body["csrfToken"].as_str().unwrap();
    assert_eq!(
        app.send(
            Method::POST,
            &format!("{ROOT}/organizations"),
            &[("cookie", &cookie)],
            None
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
    let list = app
        .send(
            Method::POST,
            &format!("{ROOT}/organizations"),
            &[
                ("cookie", &cookie),
                ("origin", ORIGIN),
                ("x-csrf-token", csrf),
                ("authorization", "Bearer bob-token"),
            ],
            None,
        )
        .await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(
        list.body,
        json!({"subject":"alice","organizations":[{"id":ORG,"name":"ChronoAI","role":"admin"}]})
    );
    assert_eq!(list.headers[header::CACHE_CONTROL], "no-store");
    assert!(!list.body.to_string().contains("not-forwarded"));
    app.nyx.oauth.0.lock().unwrap().role = None;
    let list = app
        .send(
            Method::POST,
            &format!("{ROOT}/organizations"),
            &[
                ("cookie", &cookie),
                ("origin", ORIGIN),
                ("x-csrf-token", csrf),
            ],
            None,
        )
        .await;
    assert_eq!(list.body["organizations"], json!([]));
}

#[tokio::test]
async fn oauth_browser_checks_use_own_identity_and_live_organization_roles() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "alice", 3600).await;
    let checked = check_connection(&app, &cookie, json!({})).await;
    assert_eq!(checked.status, StatusCode::OK);
    assert_eq!(
        checked.body,
        json!({"subject":"alice","status":"ready","organization":null})
    );
    assert_eq!(checked.headers[header::CACHE_CONTROL], "no-store");
    assert!(!checked.body.to_string().contains("oauth-access"));
    for (role, access) in [
        (Some("admin"), "manage"),
        (Some("member"), "read"),
        (Some("viewer"), "read"),
        (None, "none"),
    ] {
        app.nyx.oauth.0.lock().unwrap().role = role.map(str::to_owned);
        let checked = check_connection(&app, &cookie, json!({"orgId":ORG})).await;
        assert_eq!(checked.status, StatusCode::OK, "{}", checked.body);
        assert_eq!(checked.body["subject"], "alice");
        assert_eq!(
            checked.body["organization"],
            json!({"id":ORG,"role":role,"access":access})
        );
    }
    // 不能由网页指定另一用户或注入任意 URL；业务接口仍然不接受浏览器 Cookie。
    assert_eq!(
        check_connection(&app, &cookie, json!({"subject":"bob"}))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        check_connection(&app, &cookie, json!({"orgId":"https://evil.example"}))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        app.send(
            Method::GET,
            "/api/v1/spaces/oauth-hall",
            &[("cookie", &cookie)],
            None
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn oauth_browser_checks_require_session_origin_csrf_and_handle_revocation() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    assert_eq!(
        app.send(Method::POST, &format!("{ROOT}/check"), &[], Some(json!({})))
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let cookie = connect(&app, "alice", 3600).await;
    let status = session(&app, &cookie).await;
    let csrf = status.body["csrfToken"].as_str().unwrap();
    for headers in [
        vec![("cookie", cookie.as_str()), ("origin", ORIGIN)],
        vec![
            ("cookie", cookie.as_str()),
            ("origin", "https://evil.example"),
            ("x-csrf-token", csrf),
        ],
    ] {
        assert_eq!(
            app.send(
                Method::POST,
                &format!("{ROOT}/check"),
                &headers,
                Some(json!({}))
            )
            .await
            .status,
            StatusCode::FORBIDDEN
        );
    }
    app.nyx.oauth.0.lock().unwrap().userinfo_down = true;
    assert_eq!(
        check_connection(&app, &cookie, json!({})).await.status,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(session(&app, &cookie).await.body["connected"], true);
    app.nyx.oauth.0.lock().unwrap().userinfo_down = false;
    app.nyx.oauth.0.lock().unwrap().access.clear();
    assert_eq!(
        check_connection(&app, &cookie, json!({})).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(session(&app, &cookie).await.body["connected"], false);
}

#[tokio::test]
async fn oauth_browser_organization_check_cannot_outlive_disconnect() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "alice", 3600).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    {
        let mut provider = app.nyx.oauth.0.lock().unwrap();
        provider.role_gate = Some(gate.clone());
        provider.role_entered = Some(entered.clone());
    }
    let check = check_connection(&app, &cookie, json!({"orgId":ORG}));
    let stop = async {
        entered.notified().await;
        assert_eq!(
            disconnect(&app, &cookie).await.status,
            StatusCode::NO_CONTENT
        );
        gate.notify_one();
    };
    let (checked, _) = tokio::join!(check, stop);
    assert!(matches!(
        checked.status,
        StatusCode::UNAUTHORIZED | StatusCode::SERVICE_UNAVAILABLE
    ));
    assert!(checked.body.get("organization").is_none());
}

#[tokio::test]
async fn oauth_callback_failures_return_safe_recoverable_browser_routes() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let missing = app
        .send(
            Method::GET,
            &format!("{ROOT}/callback?code=secret"),
            &[],
            None,
        )
        .await;
    assert_eq!(missing.status, StatusCode::SEE_OTHER);
    assert_eq!(missing.headers[header::LOCATION], "/connect?error=expired");
    assert_eq!(missing.headers[header::CACHE_CONTROL], "no-store");
    let (path, cookie) = begin(&app, "alice", 3600).await;
    app.nyx.oauth.0.lock().unwrap().userinfo_down = true;
    let failed = app
        .send(Method::GET, &path, &[("cookie", &cookie)], None)
        .await;
    assert_eq!(
        failed.headers[header::LOCATION],
        "/connect?error=unavailable"
    );
    assert!(!failed.headers[header::LOCATION]
        .to_str()
        .unwrap()
        .contains("code="));
    assert_eq!(session(&app, &cookie).await.body["connected"], false);
    let (path, cookie) = begin(&app, "alice", 3600).await;
    let failed = app
        .send(
            Method::GET,
            &format!("{path}&error=server_error&error_description=private-detail"),
            &[("cookie", &cookie)],
            None,
        )
        .await;
    assert_eq!(
        failed.headers[header::LOCATION],
        "/connect?error=unavailable"
    );
}
