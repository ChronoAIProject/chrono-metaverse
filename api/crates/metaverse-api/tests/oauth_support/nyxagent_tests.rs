use super::*;

const KEY: &str = "nyx_test_nyxagent_browser_credential";
const SUBJECT: &str = "nyx-owner";

fn metadata(subject: &str) -> Value {
    let services: Vec<_> = ["llm-nyx", "chrono-metaverse", "chrono-llm-public"]
        .into_iter()
        .map(|slug| json!({"id":format!("svc-{slug}"),"slug":slug,"catalog_service_slug":slug,"is_active":true}))
        .collect();
    json!({"api_key":{"id":"key-nyx","name":"Metaverse NyxAgent","owner_type":"personal","owner_id":subject,"scopes":"proxy","allow_all_services":false,"allow_auto_connected_services":false,"allowed_service_ids":services.iter().map(|s| s["id"].clone()).collect::<Vec<_>>(),"effective_services":services,"expires_at":null},"credential_id":"nyx-child","credential_expires_at":null})
}

fn response() -> Value {
    json!({"id":"resp_test","conversation":{"id":"conv_test"},"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"草稿已预览"}]}]})
}

fn record(p: &MockProvider, headers: &HeaderMap, action: &str, body: Value) {
    assert!(!headers.contains_key(header::COOKIE));
    let token = headers[header::AUTHORIZATION]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap();
    assert_eq!(token, KEY, "必须转发原始 Agent Key");
    p.0.lock()
        .unwrap()
        .worker_calls
        .push((action.into(), token.into(), body));
}

pub(super) fn routes(provider: MockProvider, app: Router) -> Router {
    let models = provider.clone();
    let read = provider.clone();
    app.route(
        "/api/v1/proxy/s/llm-nyx/v1/models",
        get(move |headers: HeaderMap| {
            let p = models.clone();
            async move {
                record(&p, &headers, "nyx-models", Value::Null);
                Json(json!({"data":[{"id":"nyxagent/chat"}]}))
            }
        }),
    )
    .route(
        "/api/v1/proxy/s/llm-nyx/v1/responses",
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let p = provider.clone();
            async move {
                assert_eq!(headers["idempotency-key"], "stable-nyx-request-001");
                record(&p, &headers, "nyx-message", body);
                if let Some(status) = p.0.lock().unwrap().message_refusal {
                    return (
                        status,
                        Json(json!({"detail":"private upstream diagnostics"})),
                    )
                        .into_response();
                }
                let mut created = response();
                created["status"] = json!("in_progress");
                created["output"] = json!([]);
                let sse = format!(
                    "data: {}\n\ndata: {}\n\n",
                    json!({"type":"response.created","response":created}),
                    json!({"type":"response.completed","response":response()})
                );
                ([(header::CONTENT_TYPE, "text/event-stream")], sse).into_response()
            }
        }),
    )
    .route(
        "/api/v1/proxy/s/llm-nyx/v1/responses/{id}",
        get(move |Path(id): Path<String>, headers: HeaderMap| {
            let p = read.clone();
            async move {
                assert_eq!(id, "resp_test");
                record(&p, &headers, "nyx-read", Value::Null);
                Json(response())
            }
        }),
    )
}

fn version() -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(format!("metaverse:cma:credential:v1:{KEY}")))
}
async fn setup(app: &TestApp) -> String {
    let cookie = connect(app, SUBJECT, 3600).await;
    let mut state = app.nyx.oauth.0.lock().unwrap();
    state.browser_keys.insert(KEY.into(), metadata(SUBJECT));
    state.access.insert(KEY.into(), SUBJECT.into());
    cookie
}
fn task() -> Value {
    json!({"spaceId":"lobby","orgId":ORG,"instruction":"增加一个欢迎牌，先预览","idempotencyKey":"stable-nyx-request-001"})
}
async fn raw(
    app: &TestApp,
    cookie: &str,
    action: &str,
    body: Value,
    csrf: &str,
    credential_version: &str,
) -> (StatusCode, HeaderMap, String) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("{ROOT}/nyxagent/{action}"))
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {KEY}"))
        .header("x-csrf-token", csrf)
        .header("x-metaverse-cma-owner", ORG)
        .header("x-metaverse-cma-credential", credential_version)
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = metaverse_api::app(app.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
}
async fn call(
    app: &TestApp,
    cookie: &str,
    action: &str,
    body: Value,
) -> (StatusCode, HeaderMap, String) {
    let session = session(app, cookie).await;
    raw(
        app,
        cookie,
        action,
        body,
        session.body["csrfToken"].as_str().unwrap(),
        &version(),
    )
    .await
}

#[tokio::test]
async fn nyxagent_preserves_original_key_stream_conversation_and_idempotency_without_cma_consent() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    let checked = call(&app, &cookie, "key/check", json!({})).await;
    assert_eq!(checked.0, StatusCode::OK, "{}", checked.2);
    let identity: Value = serde_json::from_str(&checked.2).unwrap();
    assert_eq!(identity["ownerId"], SUBJECT);
    assert_eq!(identity["credentialVersion"], version());
    let first = call(&app, &cookie, "message", task()).await;
    assert_eq!(first.0, StatusCode::OK, "{}", first.2);
    assert_eq!(first.1[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(first.1[header::CACHE_CONTROL], "no-store");
    assert!(first.2.contains("response.completed"));
    assert!(first.2.contains("conv_test"));
    let mut follow = task();
    follow["conversationId"] = json!("conv_test");
    assert_eq!(
        call(&app, &cookie, "message", follow).await.0,
        StatusCode::OK
    );
    let stored = call(&app, &cookie, "response", json!({"responseId":"resp_test"})).await;
    assert_eq!(stored.0, StatusCode::OK);
    assert_eq!(
        serde_json::from_str::<Value>(&stored.2).unwrap(),
        response()
    );
    let state = app.nyx.oauth.0.lock().unwrap();
    let writes: Vec<_> = state
        .worker_calls
        .iter()
        .filter(|(a, _, _)| a == "nyx-message")
        .collect();
    assert_eq!(writes.len(), 2);
    let body = &writes[0].2;
    assert_eq!(body["model"], "nyxagent/chat");
    assert_eq!(body["store"], true);
    assert_eq!(body["stream"], true);
    assert!(body.get("conversation").is_none());
    assert!(body["input"].as_str().unwrap().contains(ORG));
    assert!(body["input"].as_str().unwrap().contains("lobby"));
    assert!(body["instructions"]
        .as_str()
        .unwrap()
        .contains("明确发布确认"));
    assert_eq!(writes[1].2["conversation"], "conv_test");
    assert_eq!(state.cma_auth_calls, 0);
    drop(state);
}

#[tokio::test]
async fn nyxagent_rejects_cross_account_broad_or_incomplete_keys_before_model_or_write() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    let mut cases = Vec::new();
    let mut wrong_owner = metadata("other-owner");
    cases.push((wrong_owner.clone(), "nyxagent_key_account_mismatch"));
    wrong_owner["api_key"]["owner_type"] = json!("org");
    cases.push((wrong_owner, "nyxagent_key_account_mismatch"));
    for (field, value) in [
        ("allow_all_services", json!(true)),
        ("allow_auto_connected_services", json!(true)),
        ("scopes", json!("proxy admin")),
        ("scopes", json!("read")),
        ("allowed_service_ids", json!(["svc-llm-nyx"])),
    ] {
        let mut bad = metadata(SUBJECT);
        bad["api_key"][field] = value;
        cases.push((bad, "nyxagent_key_scope_required"));
    }
    let mut foreign = metadata(SUBJECT);
    foreign["api_key"]["effective_services"][0]["catalog_service_slug"] = json!("another-service");
    cases.push((foreign, "nyxagent_key_scope_required"));
    for (key, code) in cases {
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .browser_keys
            .insert(KEY.into(), key);
        let result = call(&app, &cookie, "message", task()).await;
        assert_eq!(result.0, StatusCode::FORBIDDEN, "{}", result.2);
        assert!(result.2.contains(code), "{}", result.2);
        assert!(!result.2.contains(KEY));
    }
    assert!(app.nyx.oauth.0.lock().unwrap().worker_calls.is_empty());
}

#[tokio::test]
async fn nyxagent_requires_session_csrf_original_credential_and_matching_owner_context() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    let s = session(&app, &cookie).await;
    let csrf = s.body["csrfToken"].as_str().unwrap();
    for (cookie, csrf, v) in [
        (&*cookie, "bad-csrf", version()),
        ("", csrf, version()),
        (&*cookie, csrf, "x".repeat(43)),
    ] {
        assert_ne!(
            raw(&app, cookie, "message", task(), csrf, &v).await.0,
            StatusCode::OK
        );
    }
    let mut mismatch = task();
    mismatch["orgId"] = json!("other-org");
    assert_eq!(
        call(&app, &cookie, "message", mismatch).await.0,
        StatusCode::FORBIDDEN
    );
    let mut injection = task();
    injection["model"] = json!("unapproved-model");
    assert_eq!(
        call(&app, &cookie, "message", injection).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    app.nyx.oauth.0.lock().unwrap().role = Some("viewer".into());
    assert_eq!(
        call(&app, &cookie, "message", task()).await.0,
        StatusCode::FORBIDDEN
    );
    assert!(app.nyx.oauth.0.lock().unwrap().worker_calls.is_empty());
}

#[tokio::test]
async fn nyxagent_enrollment_has_separate_scope_and_invalid_delivery_revokes_only_child() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    let requested = call(&app, &cookie, "key/request", json!({})).await;
    assert_eq!(requested.0, StatusCode::OK);
    let requested: Value = serde_json::from_str(&requested.2).unwrap();
    let url = url::Url::parse(requested["verification_uri"].as_str().unwrap()).unwrap();
    let params: HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(
        params["services"],
        "llm-nyx,chrono-metaverse,chrono-llm-public"
    );
    assert_eq!(params["permissions"], "proxy");
    let mut delivery = metadata(SUBJECT);
    delivery["credential"] = json!(KEY);
    app.nyx.oauth.0.lock().unwrap().key_delivery = Some(delivery);
    let polled = call(
        &app,
        &cookie,
        "key/poll",
        json!({"deviceCode":"private-device-code"}),
    )
    .await;
    assert_eq!(polled.0, StatusCode::OK, "{}", polled.2);
    assert_eq!(
        serde_json::from_str::<Value>(&polled.2).unwrap()["credential"],
        KEY
    );
    let mut invalid = metadata("another-owner");
    invalid["credential"] = json!(KEY);
    app.nyx.oauth.0.lock().unwrap().key_delivery = Some(invalid);
    assert_eq!(
        call(
            &app,
            &cookie,
            "key/poll",
            json!({"deviceCode":"private-device-code"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(app.nyx.oauth.0.lock().unwrap().key_revocations, vec![KEY]);
}

#[tokio::test]
async fn nyxagent_accepts_implicit_read_and_catalog_connections_during_delivery_and_check() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    let mut key = metadata(SUBJECT);
    key["api_key"]["scopes"] = json!("read proxy");
    for service in key["api_key"]["effective_services"].as_array_mut().unwrap() {
        service["slug"] = json!(format!(
            "my-{}",
            service["catalog_service_slug"].as_str().unwrap()
        ));
        service["owner_id"] = json!(SUBJECT);
    }
    {
        let mut state = app.nyx.oauth.0.lock().unwrap();
        state.browser_keys.insert(KEY.into(), key.clone());
        key["credential"] = json!(KEY);
        state.key_delivery = Some(key);
    }
    let polled = call(
        &app,
        &cookie,
        "key/poll",
        json!({"deviceCode":"private-device-code"}),
    )
    .await;
    assert_eq!(polled.0, StatusCode::OK, "{}", polled.2);
    assert_eq!(
        serde_json::from_str::<Value>(&polled.2).unwrap()["credential"],
        KEY
    );
    let checked = call(&app, &cookie, "key/check", json!({})).await;
    assert_eq!(checked.0, StatusCode::OK, "{}", checked.2);
    assert!(app.nyx.oauth.0.lock().unwrap().key_revocations.is_empty());
}

#[tokio::test]
async fn nyxagent_sanitizes_upstream_refusal_without_automatic_retry() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    app.nyx.oauth.0.lock().unwrap().message_refusal = Some(StatusCode::CONFLICT);
    let result = call(&app, &cookie, "message", task()).await;
    assert_eq!(result.0, StatusCode::CONFLICT);
    assert!(result.2.contains("nyxagent_request_refused"));
    assert!(!result.2.contains("private upstream diagnostics"));
    assert_eq!(app.nyx.oauth.0.lock().unwrap().worker_calls.len(), 1);
}
