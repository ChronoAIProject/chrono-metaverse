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
    // A one-time delivery must survive a later CMA configuration failure.
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
    assert_eq!(s.cma_auth_calls, 8);
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

#[tokio::test]
async fn browser_key_accepts_multiple_cma_connections_but_requires_its_owners_connection() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    register_org(&app.nyx.oauth);
    for (credential, owner) in [
        ("nyx_browser_key-owner", None),
        ("nyx_browser_org_credential", Some(ORG)),
    ] {
        let mut key = app.nyx.oauth.0.lock().unwrap().browser_keys[credential].clone();
        key["api_key"]["effective_services"][0]["owner_id"] = json!(owner.unwrap_or("key-owner"));
        let mut extra = key["api_key"]["effective_services"][0].clone();
        extra["id"] = json!("other-cma");
        extra["owner_id"] = json!(if owner.is_some() { "key-owner" } else { ORG });
        key["api_key"]["allowed_service_ids"] = json!(["svc-cma", "other-cma"]);
        key["api_key"]["effective_services"]
            .as_array_mut()
            .unwrap()
            .push(extra);
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .browser_keys
            .insert(credential.into(), key.clone());
        let checked = call_owner(
            &app,
            &cookie,
            "key/check",
            Some(credential),
            json!({}),
            owner,
        )
        .await;
        assert_eq!(checked.status, StatusCode::OK, "{}", checked.body);
        assert_eq!(checked.body["ownerId"], owner.unwrap_or("key-owner"));
        let mut delivery = key.clone();
        delivery["credential"] = json!(credential);
        app.nyx.oauth.0.lock().unwrap().key_delivery = Some(delivery);
        assert_eq!(
            call_owner(
                &app,
                &cookie,
                "key/poll",
                None,
                json!({"deviceCode":"private-device-code"}),
                owner
            )
            .await
            .status,
            StatusCode::OK
        );
        // Other catalog services remain forbidden, even alongside a valid CMA grant.
        key["api_key"]["effective_services"][1]["catalog_service_slug"] = json!("other-service");
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .browser_keys
            .insert(credential.into(), key.clone());
        assert_eq!(
            call_owner(
                &app,
                &cookie,
                "key/check",
                Some(credential),
                json!({}),
                owner
            )
            .await
            .body["code"],
            "cma_key_scope_required"
        );
        // A CMA grant under another owner cannot stand in for the required connection.
        key["api_key"]["effective_services"][1]["catalog_service_slug"] = json!("cma");
        key["api_key"]["effective_services"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        key["api_key"]["allowed_service_ids"] = json!(["other-cma"]);
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .browser_keys
            .insert(credential.into(), key);
        assert_eq!(
            call_owner(
                &app,
                &cookie,
                "key/check",
                Some(credential),
                json!({}),
                owner
            )
            .await
            .body["code"],
            "cma_key_scope_required"
        );
    }
}

#[tokio::test]
async fn browser_key_owner_is_bound_to_live_membership_connection_and_task_context() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    call(&app, &cookie, "consent", None, json!({"enabled":true})).await;
    register_org(&app.nyx.oauth);
    let personal = "nyx_browser_key-owner";
    let org = "nyx_browser_org_credential";
    let started = call_owner(&app, &cookie, "key/request", None, json!({}), Some(ORG)).await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.body);
    let url = url::Url::parse(started.body["verification_uri"].as_str().unwrap()).unwrap();
    // The unmodified NyxID approval page rejects unknown preferences.
    assert!(url.query_pairs().all(|(k, _)| matches!(
        k.as_ref(),
        "user_code"
            | "login_type"
            | "key_source"
            | "permissions"
            | "services"
            | "key_name"
            | "expiry_days"
    )));
    assert!(!url.query_pairs().any(|(k, _)| k == "owner_id"));
    for (key, owner) in [(personal, Some(ORG)), (org, None)] {
        let denied = call_owner(&app, &cookie, "key/check", Some(key), json!({}), owner).await;
        assert_eq!(denied.body["code"], "cma_key_account_mismatch");
    }
    let task = json!({"context":{"spaceId":"lobby","orgId":ORG},"instruction":"hello","idempotencyKey":"stable-org-create-001"});
    assert_eq!(
        call(&app, &cookie, "create", Some(personal), task.clone())
            .await
            .body["code"],
        "cma_key_account_mismatch"
    );
    let mut personal_task = task.clone();
    personal_task["context"]
        .as_object_mut()
        .unwrap()
        .remove("orgId");
    assert_eq!(
        call_owner(&app, &cookie, "create", Some(org), personal_task, Some(ORG))
            .await
            .body["code"],
        "cma_key_account_mismatch"
    );
    for service_owner in [Value::Null, json!("key-owner")] {
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .browser_keys
            .get_mut(org)
            .unwrap()["api_key"]["effective_services"][0]["owner_id"] = service_owner;
        assert_eq!(
            call_owner(&app, &cookie, "key/check", Some(org), json!({}), Some(ORG))
                .await
                .body["code"],
            "cma_key_scope_required"
        );
    }
    register_org(&app.nyx.oauth);
    for role in [Some("viewer"), None] {
        app.nyx.oauth.0.lock().unwrap().role = role.map(str::to_owned);
        assert_eq!(
            call_owner(&app, &cookie, "create", Some(org), task.clone(), Some(ORG))
                .await
                .status,
            StatusCode::FORBIDDEN
        );
    }
    assert!(app.nyx.oauth.0.lock().unwrap().worker_calls.is_empty());
    for role in ["admin", "member"] {
        app.nyx.oauth.0.lock().unwrap().role = Some(role.into());
        let checked = call_owner(&app, &cookie, "key/check", Some(org), json!({}), Some(ORG)).await;
        assert_eq!(checked.body["ownerId"], ORG, "{}", checked.body);
        let created = call_owner(&app, &cookie, "create", Some(org), task.clone(), Some(ORG)).await;
        assert_eq!(created.status, StatusCode::ACCEPTED, "{}", created.body);
    }
    app.nyx.oauth.0.lock().unwrap().role = None;
    assert_eq!(
        call_owner(&app, &cookie, "create", Some(org), task, Some(ORG))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(app.nyx.oauth.0.lock().unwrap().worker_calls.len(), 2);
    assert_eq!(
        call_owner(&app, &cookie, "key/revoke", Some(org), json!({}), Some(ORG))
            .await
            .status,
        StatusCode::OK
    );
}
pub(super) fn register(provider: &MockProvider, subject: &str) {
    provider
        .0
        .lock()
        .unwrap()
        .browser_keys
        .insert(format!("nyx_browser_{subject}"), metadata(subject));
}
pub(super) fn register_org(provider: &MockProvider) {
    let mut key = metadata(ORG);
    key["api_key"]["owner_type"] = json!("org");
    key["api_key"]["effective_services"][0]["owner_id"] = json!(ORG);
    provider
        .0
        .lock()
        .unwrap()
        .browser_keys
        .insert("nyx_browser_org_credential".into(), key);
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
    ];
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
async fn browser_key_enrollment_is_private_scoped_and_revokes_only_its_child() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    let denied = app
        .send(
            Method::POST,
            &format!("{ROOT}/worker/key/request"),
            &[("cookie", &cookie)],
            None,
        )
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    let started = call(&app, &cookie, "key/request", None, json!({})).await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.body);
    assert_eq!(started.headers[header::CACHE_CONTROL], "no-store");
    let uri = started.body["verification_uri"].as_str().unwrap();
    assert!(uri.contains("services=cma") && uri.contains("key_source=existing"));
    let uri = url::Url::parse(uri).unwrap();
    assert_eq!(
        uri.query_pairs().find(|(k, _)| k == "user_code").unwrap().1,
        "ABCD-1234"
    );
    assert!(!uri.as_str().contains("private-device"));
    let pending = call(
        &app,
        &cookie,
        "key/poll",
        None,
        json!({"deviceCode":"private-device-code"}),
    )
    .await;
    assert_eq!(pending.body["code"], "cma_key_pending");
    let credential = "nyx_browser_key-owner";
    let mut delivery = metadata("key-owner");
    delivery["credential"] = json!(credential);
    app.nyx.oauth.0.lock().unwrap().key_delivery = Some(delivery);
    let received = call(
        &app,
        &cookie,
        "key/poll",
        None,
        json!({"deviceCode":"private-device-code"}),
    )
    .await;
    assert_eq!(received.status, StatusCode::OK, "{}", received.body);
    assert_eq!(received.body["credential"], credential);
    assert_eq!(received.body["identity"]["credentialId"], "child-browser");
    let checked = call(&app, &cookie, "key/check", Some(credential), json!({})).await;
    assert_eq!(checked.status, StatusCode::OK);
    assert!(!checked.body.to_string().contains(credential));
    let client = mongodb::Client::with_uri_str(&app.uri).await.unwrap();
    let db = client.database(&app.database);
    for name in db.list_collection_names().await.unwrap() {
        let mut cursor = db
            .collection::<mongodb::bson::Document>(&name)
            .find(doc! {})
            .await
            .unwrap();
        while cursor.advance().await.unwrap() {
            assert!(!format!("{:?}", cursor.deserialize_current().unwrap()).contains(credential));
        }
    }
    app.nyx
        .oauth
        .0
        .lock()
        .unwrap()
        .browser_keys
        .get_mut(credential)
        .unwrap()["api_key"]["allow_all_services"] = json!(true);
    let revoked = call(&app, &cookie, "key/revoke", Some(credential), json!({})).await;
    assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.body);
    assert_eq!(
        app.nyx.oauth.0.lock().unwrap().key_revocations,
        vec![credential]
    );
    assert_eq!(
        call(&app, &cookie, "key/check", Some(credential), json!({}))
            .await
            .body["code"],
        "cma_key_required"
    );
}
#[tokio::test]
async fn worker_never_falls_back_to_oauth_and_checks_live_key_identity_and_scope() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    assert_eq!(
        call(&app, &cookie, "consent", None, json!({"enabled":true}))
            .await
            .status,
        StatusCode::OK
    );
    let task = json!({"context":{"spaceId":"lobby"},"instruction":"hello","idempotencyKey":"stable-key-create-001"});
    for credential in [None, Some("oauth-access-1")] {
        assert_eq!(
            call(&app, &cookie, "create", credential, task.clone())
                .await
                .body["code"],
            "cma_key_required"
        );
    }
    let credential = "nyx_browser_key-owner";
    for (field, value, expected) in [
        (
            "owner_id",
            json!("someone-else"),
            "cma_key_account_mismatch",
        ),
        (
            "owner_type",
            json!("organization"),
            "cma_key_account_mismatch",
        ),
        ("scopes", json!("read proxy"), "cma_key_scope_required"),
        ("allow_all_services", json!(true), "cma_key_scope_required"),
        (
            "allow_auto_connected_services",
            json!(true),
            "cma_key_scope_required",
        ),
        (
            "allowed_service_ids",
            json!(["svc-other"]),
            "cma_key_scope_required",
        ),
    ] {
        let mut changed = metadata("key-owner");
        changed["api_key"][field] = value;
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .browser_keys
            .insert(credential.into(), changed);
        let reply = call(&app, &cookie, "create", Some(credential), task.clone()).await;
        assert_eq!(reply.body["code"], expected, "{}", reply.body);
    }
    assert!(app.nyx.oauth.0.lock().unwrap().worker_calls.is_empty());
    let mut delivery = metadata("someone-else");
    delivery["credential"] = json!(credential);
    app.nyx.oauth.0.lock().unwrap().key_delivery = Some(delivery);
    let denied = call(
        &app,
        &cookie,
        "key/poll",
        None,
        json!({"deviceCode":"private-device-code"}),
    )
    .await;
    assert_eq!(denied.body["code"], "cma_key_account_mismatch");
    assert!(!denied.body.to_string().contains(credential));
    assert_eq!(
        app.nyx.oauth.0.lock().unwrap().key_revocations,
        vec![credential]
    );
}
#[tokio::test]
async fn follow_up_recovery_preserves_worker_content_and_idempotency_through_fixed_relay() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "key-owner", 3600).await;
    call(&app, &cookie, "consent", None, json!({"enabled":true})).await;
    let credential = "nyx_browser_key-owner";
    let first = json!({"context":{"spaceId":"lobby"},"instruction":"first","agentId":"agt_test","idempotencyKey":"stable-key-message-001"});
    let mut second = first.clone();
    second["instruction"] = json!("second");
    second["idempotencyKey"] = json!("stable-key-message-002");
    assert_eq!(
        call(&app, &cookie, "message", Some(credential), first)
            .await
            .status,
        StatusCode::ACCEPTED
    );
    for (status, code) in [
        (StatusCode::FORBIDDEN, "cma_response_forbidden"),
        (StatusCode::UNAUTHORIZED, "cma_key_not_accepted"),
    ] {
        app.nyx.oauth.0.lock().unwrap().key_message_refusal = Some(status);
        let denied = call(&app, &cookie, "message", Some(credential), second.clone()).await;
        assert_eq!(denied.body["code"], code);
        assert!(!denied.body.to_string().contains("private diagnostic"));
    }
    app.nyx.oauth.0.lock().unwrap().key_message_refusal = None;
    assert_eq!(
        call(&app, &cookie, "message", Some(credential), second)
            .await
            .status,
        StatusCode::ACCEPTED
    );
    let s = app.nyx.oauth.0.lock().unwrap();
    assert_eq!(s.worker_calls.len(), 4);
    assert_eq!(s.worker_calls[1], s.worker_calls[2]);
    assert_eq!(s.worker_calls[2], s.worker_calls[3]);
    assert!(s
        .worker_calls
        .iter()
        .all(|call| !call.2.to_string().contains(credential) && call.2["stream"] == true));
}
