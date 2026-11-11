use super::*;

async fn probe(app: &TestApp, cookie: &str, owner: Option<&str>) -> Reply {
    let s = session(app, cookie).await;
    let mut headers = vec![
        ("cookie", cookie),
        ("origin", ORIGIN),
        ("x-csrf-token", s.body["csrfToken"].as_str().unwrap()),
    ];
    if let Some(owner) = owner {
        headers.push(("x-metaverse-cma-owner", owner));
    }
    app.send(
        Method::POST,
        &format!("{ROOT}/worker/connection"),
        &headers,
        None,
    )
    .await
}

#[tokio::test]
async fn oauth_probe_uses_saved_user_grant_without_browser_keys_and_survives_refresh() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "oauth-owner", 1).await;
    for _ in 0..2 {
        let r = probe(&app, &cookie, None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        assert_eq!(r.body, json!({"ready":true,"ownerId":"oauth-owner"}));
        assert!(!r.body.to_string().contains("oauth-access"));
    }
    assert_eq!(app.nyx.oauth.0.lock().unwrap().refreshes, 1);
    assert_eq!(app.nyx.oauth.0.lock().unwrap().cma_auth_calls, 2);
    assert_eq!(session(&app, &cookie).await.body["workerEnabled"], false);
}

#[tokio::test]
async fn oauth_probe_distinguishes_token_rejection_resource_denial_and_provider_outage() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "oauth-owner", 3600).await;
    for (status, code) in [
        (StatusCode::UNAUTHORIZED, "cma_oauth_required"),
        (StatusCode::FORBIDDEN, "cma_request_refused"),
        (StatusCode::SERVICE_UNAVAILABLE, "cma_request_refused"),
    ] {
        app.nyx.oauth.0.lock().unwrap().cma_auth_reply = Some((
            status,
            json!({"code":"private","message":"secret diagnostic"}),
        ));
        let r = probe(&app, &cookie, None).await;
        assert_eq!(r.body["code"], code);
        assert!(!r.body.to_string().contains("secret diagnostic"));
    }
    app.nyx.oauth.0.lock().unwrap().cma_auth_reply = Some((
        StatusCode::OK,
        json!({"authenticated":true,"subject":"different-user"}),
    ));
    assert_eq!(
        probe(&app, &cookie, None).await.status,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn oauth_org_selection_requires_live_membership_but_keeps_the_actual_user_actor() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "oauth-owner", 3600).await;
    let r = probe(&app, &cookie, Some(ORG)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["ownerId"], ORG);
    app.nyx.oauth.0.lock().unwrap().role = Some("viewer".into());
    assert_eq!(
        probe(&app, &cookie, Some(ORG)).await.status,
        StatusCode::FORBIDDEN
    );
    app.nyx.oauth.0.lock().unwrap().role = None;
    assert_eq!(
        probe(&app, &cookie, Some(ORG)).await.status,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn oauth_disconnect_fences_a_connection_probe_in_flight() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "oauth-owner", 3600).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    {
        let mut s = app.nyx.oauth.0.lock().unwrap();
        s.cma_auth_gate = Some(gate.clone());
        s.cma_auth_entered = Some(entered.clone());
    }
    let s = session(&app, &cookie).await;
    let request = probe(&app, &cookie, None);
    let disconnect = async {
        entered.notified().await;
        let r = app
            .send(
                Method::POST,
                &format!("{ROOT}/disconnect"),
                &[
                    ("cookie", &cookie),
                    ("origin", ORIGIN),
                    ("x-csrf-token", s.body["csrfToken"].as_str().unwrap()),
                ],
                None,
            )
            .await;
        gate.notify_one();
        r
    };
    let (r, d) = tokio::join!(request, disconnect);
    assert_eq!(d.status, StatusCode::NO_CONTENT);
    assert_eq!(r.body["code"], "nyxid_reconnect_required");
}

#[tokio::test]
async fn identity_only_session_is_not_reported_as_a_working_chat_connection() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "oauth-owner", 3600).await;
    for commands in [None, Some(false)] {
        let mut body = json!({"authenticated":true,"subject":"oauth-owner"});
        if let Some(value) = commands {
            body["api_commands"] = json!(value);
        }
        app.nyx.oauth.0.lock().unwrap().cma_auth_reply = Some((StatusCode::OK, body));
        let r = probe(&app, &cookie, None).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(r.body["code"], "cma_command_authority_required");
        assert_ne!(r.body["ready"], true);
    }
}

#[tokio::test]
async fn workspace_oauth_callback_returns_to_chat_and_enables_only_the_new_session() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let (path, flow) = begin_at(&app, "oauth-owner", 3600, true).await;
    let reply = app
        .send(Method::GET, &path, &[("cookie", &flow)], None)
        .await;
    assert_eq!(reply.status, StatusCode::SEE_OTHER);
    assert_eq!(reply.headers[header::LOCATION], "/workspace");
    let cookie = response_cookie(&reply, "mv_nyx_session");
    assert_eq!(session(&app, &cookie).await.body["workerEnabled"], true);
    assert_eq!(probe(&app, &cookie, None).await.body["ready"], true);
}
