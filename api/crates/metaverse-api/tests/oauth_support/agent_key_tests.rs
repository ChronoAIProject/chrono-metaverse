use super::*;

fn metadata(subject: &str) -> Value {
    json!({"api_key":{"id":"key-cma","name":"Metaverse CMA","owner_type":"personal","owner_id":subject,"scopes":"proxy","allow_all_services":false,"allow_auto_connected_services":false,"allowed_service_ids":["svc-cma"],"effective_services":[{"id":"svc-cma","slug":"cma","catalog_service_slug":"cma","is_active":true}],"expires_at":null},"credential_id":"child-browser","credential_expires_at":null})
}

#[tokio::test]
async fn browser_key_connection_requires_cma_acceptance_without_losing_the_delivered_key() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    let credential = "nyx_browser_key-owner";
    let mut delivery = metadata("key-owner");
    delivery["credential"] = json!(credential);
    app.nyx.oauth.0.lock().unwrap().key_delivery = Some(delivery);
    // 一次性交付必须保留，CMA 配置失败不能消耗或撤销有效凭据。
    let delivered = call(
        &app,
        &cookie,
        "key/poll",
        None,
        json!({"deviceCode":"private-device-code"}),
    )
    .await;
    assert_eq!(delivered.body["credential"], credential);
    for (status, body, code) in [
        (
            StatusCode::UNAUTHORIZED,
            json!({"detail":"private diagnostic"}),
            "cma_key_not_accepted",
        ),
        (
            StatusCode::FORBIDDEN,
            json!({"detail":"private diagnostic"}),
            "cma_key_not_accepted",
        ),
        (
            StatusCode::OK,
            json!({"authenticated":true,"subject":"another-owner"}),
            "cma_key_not_accepted",
        ),
        (
            StatusCode::OK,
            json!({"authenticated":false,"subject":"key-owner"}),
            "cma_key_not_accepted",
        ),
        (StatusCode::OK, json!({}), "cma_key_unavailable"),
        (
            StatusCode::OK,
            json!({"authenticated":true,"subject":"key-owner","api_commands":false}),
            "cma_command_authority_required",
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"detail":"private diagnostic"}),
            "cma_key_unavailable",
        ),
        (StatusCode::FOUND, json!({}), "cma_key_unavailable"),
    ] {
        app.nyx.oauth.0.lock().unwrap().cma_auth_reply = Some((status, body));
        let checked = call(&app, &cookie, "key/check", Some(credential), json!({})).await;
        assert_eq!(checked.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(checked.body["code"], code, "{}", checked.body);
        assert_eq!(checked.headers[header::CACHE_CONTROL], "no-store");
        assert!(!checked.body.to_string().contains(credential));
        assert!(!checked.body.to_string().contains("private diagnostic"));
    }
    app.nyx.oauth.0.lock().unwrap().cma_auth_reply = None;
    let checked = call(&app, &cookie, "key/check", Some(credential), json!({})).await;
    assert_eq!(checked.status, StatusCode::OK, "{}", checked.body);
    assert_eq!(checked.body["ownerId"], "key-owner");
    let s = app.nyx.oauth.0.lock().unwrap();
    assert_eq!(s.cma_auth_calls, 9);
    assert!(s.browser_keys.contains_key(credential));
    assert!(s.key_revocations.is_empty());
    assert!(s.worker_calls.is_empty());
}

#[tokio::test]
async fn browser_key_cma_handshake_cannot_outlive_browser_disconnect() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let gate = Arc::new(tokio::sync::Notify::new());
    {
        let mut s = app.nyx.oauth.0.lock().unwrap();
        s.cma_auth_entered = Some(entered.clone());
        s.cma_auth_gate = Some(gate.clone());
    }
    let (checked, ()) = tokio::join!(
        call(
            &app,
            &cookie,
            "key/check",
            Some("nyx_browser_key-owner"),
            json!({})
        ),
        async {
            tokio::time::timeout(std::time::Duration::from_secs(5), entered.notified())
                .await
                .unwrap();
            assert_eq!(
                disconnect(&app, &cookie).await.status,
                StatusCode::NO_CONTENT
            );
            gate.notify_one();
        }
    );
    assert_eq!(checked.status, StatusCode::UNAUTHORIZED, "{}", checked.body);
    assert!(!checked.body.to_string().contains("ownerId"));
}

pub(super) fn register_state(state: &mut ProviderState, subject: &str) {
    let key = format!("nyx_browser_{subject}");
    state.access.insert(key.clone(), subject.into());
    state.browser_keys.insert(key, metadata(subject));
}
pub(super) fn routes(provider: MockProvider, app: Router) -> Router {
    let lookup = provider.clone();
    let revoke = provider.clone();
    app.route("/api/v1/auth/agent-key/request", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
        assert!(!headers.contains_key(header::COOKIE)); assert!(!headers.contains_key(header::AUTHORIZATION));
        assert_eq!(body["client_app"], "chrono-metaverse");
        Json(json!({"device_code":"private-device-code","user_code":"ABCD-1234","expires_in":300,"interval":1,"verification_uri":"https://nyxid.ai/login/agent-key"}))
    })).route("/api/v1/auth/agent-key/poll", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let p = provider.clone(); async move {
            assert!(!headers.contains_key(header::COOKIE)); assert!(!headers.contains_key(header::AUTHORIZATION));
            assert_eq!(body["device_code"], "private-device-code");
            match p.0.lock().unwrap().key_delivery.take() {
                Some(value) => Json(value).into_response(),
                None => (StatusCode::BAD_REQUEST, Json(json!({"error_code":11902}))).into_response(),
            }
        }
    })).route("/api/v1/auth/agent-key/self", get(move |headers: HeaderMap| {
        let p = lookup.clone(); async move {
            assert!(!headers.contains_key(header::COOKIE));
            let token = headers[header::AUTHORIZATION].to_str().unwrap().strip_prefix("Bearer ").unwrap();
            match p.0.lock().unwrap().browser_keys.get(token) {
                Some(value) => Json(value.clone()).into_response(), None => StatusCode::UNAUTHORIZED.into_response(),
            }
        }
    }).delete(move |headers: HeaderMap| {
        let p = revoke.clone(); async move {
            assert!(!headers.contains_key(header::COOKIE));
            let token = headers[header::AUTHORIZATION].to_str().unwrap().strip_prefix("Bearer ").unwrap();
            let mut s=p.0.lock().unwrap(); s.key_revocations.push(token.to_owned()); s.browser_keys.remove(token);
            Json(json!({"ok":true}))
        }
    }))
}
async fn call(
    app: &TestApp,
    cookie: &str,
    action: &str,
    credential: Option<&str>,
    body: Value,
) -> Reply {
    call_owner(app, cookie, action, credential, body, None).await
}
async fn call_owner(
    app: &TestApp,
    cookie: &str,
    action: &str,
    credential: Option<&str>,
    body: Value,
    owner: Option<&str>,
) -> Reply {
    let s = session(app, cookie).await;
    let csrf = s.body["csrfToken"].as_str().unwrap();
    let bearer = credential.map(|v| format!("Bearer {v}"));
    let mut headers = vec![
        ("cookie", cookie),
        ("origin", ORIGIN),
        ("x-csrf-token", csrf),
        ("x-metaverse-cma-auth", "agent_key"),
    ];
    if action == "consent" {
        headers.retain(|(name, _)| *name != "x-metaverse-cma-auth");
    }
    if let Some(bearer) = &bearer {
        headers.push(("authorization", bearer));
    }
    if let Some(owner) = owner {
        headers.push(("x-metaverse-cma-owner", owner));
    }
    app.send(
        Method::POST,
        &format!("{ROOT}/worker/{action}"),
        &headers,
        Some(body),
    )
    .await
}

#[tokio::test]
async fn explicit_key_chat_preserves_actor_resource_and_request_identity() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    call(&app, &cookie, "consent", None, json!({"enabled":true})).await;
    let key = "nyx_browser_key-owner";
    // 组织是目标资源，Key 仍属于当前登录用户。
    assert_eq!(
        call_owner(&app, &cookie, "connection", Some(key), json!({}), Some(ORG))
            .await
            .body["ownerId"],
        ORG
    );
    let body = json!({"context":{"spaceId":"lobby","orgId":ORG},"instruction":"first","agentId":"agt_test","idempotencyKey":"stable-dual-message-001"});
    assert_eq!(
        call_owner(&app, &cookie, "message", Some(key), body.clone(), Some(ORG))
            .await
            .status,
        StatusCode::ACCEPTED
    );
    app.nyx.oauth.0.lock().unwrap().message_refusal = Some(StatusCode::FORBIDDEN);
    let mut follow = body.clone();
    follow["instruction"] = json!("second");
    follow["idempotencyKey"] = json!("stable-dual-message-002");
    let denied = call_owner(
        &app,
        &cookie,
        "message",
        Some(key),
        follow.clone(),
        Some(ORG),
    )
    .await;
    assert_eq!(denied.body["code"], "cma_response_forbidden");
    app.nyx.oauth.0.lock().unwrap().message_refusal = None;
    assert_eq!(
        call_owner(
            &app,
            &cookie,
            "message",
            Some(key),
            follow.clone(),
            Some(ORG)
        )
        .await
        .status,
        StatusCode::ACCEPTED
    );
    {
        let s = app.nyx.oauth.0.lock().unwrap();
        assert_eq!(s.worker_calls[1], s.worker_calls[2]);
        assert!(s
            .worker_bearers
            .iter()
            .all(|v| v == &format!("Bearer {key}")));
        assert!(s
            .worker_calls
            .iter()
            .all(|v| !v.2.to_string().contains(key)));
    }
    app.nyx.oauth.0.lock().unwrap().role = Some("viewer".into());
    assert_eq!(
        call_owner(
            &app,
            &cookie,
            "message",
            Some(key),
            follow.clone(),
            Some(ORG)
        )
        .await
        .body["code"],
        "cma_owner_forbidden"
    );
    // 缺少 Key 时不能换用仍然有效的 OAuth。
    assert_eq!(
        call_owner(&app, &cookie, "message", None, follow, Some(ORG))
            .await
            .body["code"],
        "cma_key_required"
    );
}

#[tokio::test]
async fn key_identity_scope_and_revocation_are_rechecked_before_any_worker_operation() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    call(&app, &cookie, "consent", None, json!({"enabled":true})).await;
    let key = "nyx_browser_key-owner";
    for (field, value, expected) in [
        ("owner_id", json!("other"), "cma_key_account_mismatch"),
        ("owner_type", json!("org"), "cma_key_account_mismatch"),
        ("scopes", json!("read proxy"), "cma_key_scope_required"),
        ("allow_all_services", json!(true), "cma_key_scope_required"),
        (
            "allowed_service_ids",
            json!(["other"]),
            "cma_key_scope_required",
        ),
    ] {
        let mut value_body = metadata("key-owner");
        value_body["api_key"][field] = value;
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .browser_keys
            .insert(key.into(), value_body);
        assert_eq!(
            call(&app, &cookie, "agents", Some(key), json!({}))
                .await
                .body["code"],
            expected
        );
    }
    assert!(app.nyx.oauth.0.lock().unwrap().worker_bearers.is_empty());
}

#[tokio::test]
async fn model_upload_uses_selected_browser_key_and_keeps_the_original_receipt() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    call(&app, &cookie, "consent", None, json!({"enabled":true})).await;
    let status = session(&app, &cookie).await;
    let csrf = status.body["csrfToken"].as_str().unwrap();
    let mut receipts = Vec::new();
    for _ in 0..2 {
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!(
                "{ROOT}/worker/attachment?agentId=agt_test&name=room.glb"
            ))
            .header("cookie", &cookie)
            .header("origin", ORIGIN)
            .header("x-csrf-token", csrf)
            .header("x-metaverse-cma-auth", "agent_key")
            .header("authorization", "Bearer nyx_browser_key-owner")
            .header("idempotency-key", "dual-upload-original-0001")
            .header("content-type", "application/octet-stream")
            .body(Body::from(vec![42u8; 8]))
            .unwrap();
        let response = metaverse_api::app(app.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        receipts.push(
            axum::body::to_bytes(response.into_body(), 16384)
                .await
                .unwrap(),
        );
    }
    assert_eq!(receipts[0], receipts[1]);
    let s = app.nyx.oauth.0.lock().unwrap();
    assert!(s
        .worker_bearers
        .iter()
        .all(|v| v == "Bearer nyx_browser_key-owner"));
    assert_eq!(s.worker_calls[0], s.worker_calls[1]);
}
