use super::*;

pub(super) fn routes(provider: MockProvider, app: Router) -> Router {
    app.route("/api/v1/user-services", get(move |headers: HeaderMap| {
        let p = provider.clone();
        async move {
            let s = p.0.lock().unwrap();
            let token = headers[header::AUTHORIZATION].to_str().unwrap().strip_prefix("Bearer ").unwrap();
            assert!(s.access.contains_key(token));
            assert!(!headers.contains_key(header::COOKIE));
            Json(json!({"services":[
                {"id":"cma_personal","slug":"cma","catalog_service_id":"catalog_cma","is_active":true,"credential_source":{"type":"personal"}},
                {"id":"cma_org","slug":"cma","catalog_service_id":"catalog_cma","is_active":true,"credential_source":{"type":"org","org_id":ORG,"allowed":true}}
            ]}))
        }
    }))
}

#[tokio::test]
async fn oauth_proxy_checks_real_grant_and_owner_without_browser_credentials() {
    let app = TestApp::start_with_options(true, true)
        .await
        .expect("MongoDB required");
    let cookie = connect(&app, "proxy-owner", 1).await;
    let org = worker_tests::call(&app, &cookie, "connection", json!({})).await;
    assert_eq!(org.status, StatusCode::OK, "{}", org.body);
    assert_eq!(org.body["ownerId"], ORG);
    assert!(app.nyx.oauth.0.lock().unwrap().refreshes > 0);
    let s = session(&app, &cookie).await;
    let csrf = s.body["csrfToken"].as_str().unwrap();
    let personal = app
        .send(
            Method::POST,
            &format!("{ROOT}/worker/connection"),
            &[
                ("cookie", &cookie),
                ("origin", ORIGIN),
                ("x-csrf-token", csrf),
            ],
            Some(json!({})),
        )
        .await;
    assert_eq!(personal.status, StatusCode::OK);
    assert_eq!(personal.body["ownerId"], "proxy-owner");
    {
        let mut state = app.nyx.oauth.0.lock().unwrap();
        assert!(state
            .proxy_queries
            .iter()
            .any(|q| q["_nyxid_via"] == "cma_personal"));
        assert!(state
            .proxy_queries
            .iter()
            .any(|q| q["_nyxid_via"] == "cma_org"));
        state.proxy_denied = true;
    }
    let denied = worker_tests::call(&app, &cookie, "connection", json!({})).await;
    assert_eq!(denied.body["code"], "cma_oauth_required");
    assert!(!denied.body.to_string().contains("private"));
    assert_eq!(
        worker_tests::call(&app, &cookie, "consent", json!({"enabled":true}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(session(&app, &cookie).await.body["workerEnabled"], false);
    {
        let mut state = app.nyx.oauth.0.lock().unwrap();
        state.proxy_denied = false;
        state.proxy_configuration_required = true;
    }
    let unavailable = worker_tests::call(&app, &cookie, "connection", json!({})).await;
    assert_eq!(unavailable.body["code"], "cma_configuration_required");
    assert_eq!(unavailable.status, StatusCode::SERVICE_UNAVAILABLE);
    app.nyx.oauth.0.lock().unwrap().role = Some("viewer".into());
    let viewer = worker_tests::call(&app, &cookie, "connection", json!({})).await;
    assert_eq!(viewer.body["code"], "cma_owner_forbidden");
}

#[tokio::test]
async fn oauth_cma_authorization_returns_to_workspace_without_replaying_tasks() {
    let app = TestApp::start_with_options(true, true)
        .await
        .expect("MongoDB required");
    let (path, flow_cookie) = begin_at(&app, "workspace-owner", 3600, true).await;
    let reply = app
        .send(Method::GET, &path, &[("cookie", &flow_cookie)], None)
        .await;
    assert_eq!(reply.status, StatusCode::SEE_OTHER);
    assert_eq!(reply.headers[header::LOCATION], "/workspace");
    let cookie = response_cookie(&reply, "mv_nyx_session");
    assert_eq!(session(&app, &cookie).await.body["workerEnabled"], true);
    assert!(app.nyx.oauth.0.lock().unwrap().worker_calls.is_empty());
    assert_eq!(session(&app, &cookie).await.body["workerEnabled"], true);
}
