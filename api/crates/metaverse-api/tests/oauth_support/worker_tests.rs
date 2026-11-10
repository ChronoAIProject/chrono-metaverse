use super::*;

pub(super) fn routes(provider: MockProvider, app: Router) -> Router {
    let list = provider.clone();
    let create = provider.clone();
    let message = provider.clone();
    let control = provider.clone();
    app.route("/api/v1/agents", get(move |headers: HeaderMap| {
        let p = list.clone(); async move {
            let s = p.0.lock().unwrap();
            let token = headers[header::AUTHORIZATION].to_str().unwrap().strip_prefix("Bearer ").unwrap();
            assert!(s.access.contains_key(token));
            assert!(!headers.contains_key(header::COOKIE));
            Json(json!({"items":[{"id":"agt_test","title":"Builder","status":"working"}],"next":null}))
        }
    }).post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let p = create.clone(); async move {
            let (gate, entered, setup) = {
                let mut s=p.0.lock().unwrap();
                let token=headers[header::AUTHORIZATION].to_str().unwrap().strip_prefix("Bearer ").unwrap();
                assert!(s.access.contains_key(token));
                assert!(!headers.contains_key(header::COOKIE));
                s.worker_calls.push(("create".into(),headers["idempotency-key"].to_str().unwrap().into(),body));
                (s.worker_gate.clone(),s.worker_entered.clone(),s.worker_setup_required)
            };
            if let Some(n)=entered {n.notify_one();}
            if let Some(n)=gate {n.notified().await;}
            if setup { return (StatusCode::CONFLICT,Json(json!({"code":"sandbox_credential_setup_required","detail":"secret provider diagnostic"}))).into_response(); }
            (StatusCode::ACCEPTED,Json(json!({"id":"op_test","status":"pending"}))).into_response()
        }
    }))
    .route("/api/v1/agent-lifecycle/{id}",get(|| async {Json(json!({"id":"op_test","status":"succeeded","phase":"ready","agent_id":"agt_test"}))}))
    .route("/api/v1/agents/{id}",get(|| async {Json(json!({"id":"agt_test","status":"working"}))}))
    .route("/api/v1/agents/{id}/transcript",get(|| async {Json(json!({"agent_id":"agt_test","through_seq":4,"turns":[]}))}))
    .route("/api/v2/agents/{id}/responses",post(move |headers: HeaderMap,Json(body):Json<Value>|{
        let p=message.clone();async move {
            p.0.lock().unwrap().worker_calls.push(("message".into(),headers["idempotency-key"].to_str().unwrap().into(),body));
            (StatusCode::OK,[("x-cma-response-id","resp_test"),("x-cma-command-id","cmd_test"),("content-type","text/event-stream")],"event: response.created\ndata: {}\n\n")
        }
    }))
    .route("/api/v2/responses/{id}",get(||async{Json(json!({"id":"resp_test","status":"in_progress"}))}))
    .route("/api/v2/agents/{id}/responses/{response_id}/controls",get(||async{Json(json!({"agent_revision":7,"target_active":true,"target":{"turn_sequence":3}}))}).post(move|headers:HeaderMap,Json(body):Json<Value>|{
        let p=control.clone();async move{
            p.0.lock().unwrap().worker_calls.push(("cancel".into(),headers["idempotency-key"].to_str().unwrap().into(),body));
            (StatusCode::ACCEPTED,Json(json!({"control":{"id":"cmd_stop","status":"admitted"}})))
        }
    }))
}

async fn call(app: &TestApp, cookie: &str, action: &str, body: Value) -> Reply {
    let s = session(app, cookie).await;
    let csrf = s.body["csrfToken"].as_str().unwrap();
    app.send(
        Method::POST,
        &format!("{ROOT}/worker/{action}"),
        &[
            ("cookie", cookie),
            ("origin", ORIGIN),
            ("x-csrf-token", csrf),
        ],
        Some(body),
    )
    .await
}
fn task() -> Value {
    json!({"context":{"spaceId":"lobby","orgId":ORG},"instruction":"在入口建欢迎区，先预览","idempotencyKey":"stable-create-000001"})
}

#[tokio::test]
async fn worker_requires_browser_consent_and_preserves_service_scope_and_request_identity() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "worker-owner", 3600).await;
    let s = session(&app, &cookie).await;
    assert_eq!(s.body["workerAvailable"], true);
    assert_eq!(s.body["workerEnabled"], false);
    assert_eq!(
        call(&app, &cookie, "create", task()).await.status,
        StatusCode::FORBIDDEN
    );
    assert!(app.nyx.oauth.0.lock().unwrap().worker_calls.is_empty());
    let denied = app
        .send(
            Method::POST,
            &format!("{ROOT}/worker/consent"),
            &[("cookie", &cookie)],
            Some(json!({"enabled":true})),
        )
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(
        call(&app, &cookie, "consent", json!({"enabled":true}))
            .await
            .status,
        StatusCode::OK
    );
    let created = call(&app, &cookie, "create", task()).await;
    assert_eq!(created.status, StatusCode::ACCEPTED, "{}", created.body);
    assert_eq!(created.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        call(&app, &cookie, "create", task()).await.body,
        created.body
    );
    {
        let s = app.nyx.oauth.0.lock().unwrap();
        assert_eq!(s.worker_calls.len(), 2);
        assert_eq!(s.worker_calls[0], s.worker_calls[1]);
        let body = &s.worker_calls[0].2;
        assert_eq!(
            body["profile"]["permissions"]["services"],
            json!(["chrono-metaverse"])
        );
        assert!(body["initial_message"].as_str().unwrap().contains(ORG));
        assert!(body["initial_message"].as_str().unwrap().contains("欢迎区"));
        assert!(!body.to_string().contains("oauth-access"));
    }
    assert_eq!(
        call(&app, &cookie, "agents", json!({})).await.body["items"][0]["id"],
        "agt_test"
    );
    assert_eq!(
        call(&app, &cookie, "observe", json!({"operationId":"op_test"}))
            .await
            .body["operation"]["agent_id"],
        "agt_test"
    );
    assert_eq!(
        call(&app, &cookie, "observe", json!({"agentId":"agt_test"}))
            .await
            .body["agent"]["id"],
        "agt_test"
    );
    let mut message = task();
    message["agentId"] = json!("agt_test");
    let reply = call(&app, &cookie, "message", message).await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{}", reply.body);
    assert_eq!(
        reply.body,
        json!({"responseId":"resp_test","commandId":"cmd_test"})
    );
    let r = call(
        &app,
        &cookie,
        "response",
        json!({"agentId":"agt_test","responseId":"resp_test"}),
    )
    .await;
    assert_eq!(r.body["controls"]["agent_revision"], 7);
    let stopped=call(&app,&cookie,"cancel",json!({"agentId":"agt_test","responseId":"resp_test","turnSequence":3,"agentRevision":7,"idempotencyKey":"stable-cancel-00001"})).await;
    assert_eq!(stopped.status, StatusCode::ACCEPTED, "{}", stopped.body);
    assert_eq!(
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .worker_calls
            .last()
            .unwrap()
            .2,
        json!({"turn_sequence":3,"expected_agent_revision":7,"command":{"type":"cancel"}})
    );
    assert_eq!(
        call(&app, &cookie, "observe", json!({"agentId":"agt_test?x=1"}))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(&app, &cookie, "agents", json!({"url":"https://evil.test"}))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    call(&app, &cookie, "consent", json!({"enabled":false})).await;
    assert_eq!(
        call(&app, &cookie, "observe", json!({"agentId":"agt_test"}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    disconnect(&app, &cookie).await;
    let denied = app
        .send(
            Method::POST,
            &format!("{ROOT}/worker/create"),
            &[
                ("cookie", &cookie),
                ("origin", ORIGIN),
                ("x-csrf-token", s.body["csrfToken"].as_str().unwrap()),
            ],
            Some(task()),
        )
        .await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn worker_revocation_fences_inflight_requests_even_after_reenable() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "worker-owner", 3600).await;
    call(&app, &cookie, "consent", json!({"enabled":true})).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    {
        let mut s = app.nyx.oauth.0.lock().unwrap();
        s.worker_gate = Some(gate.clone());
        s.worker_entered = Some(entered.clone());
    }
    let future = call(&app, &cookie, "create", task());
    tokio::pin!(future);
    tokio::select! {_=entered.notified()=>{},r=&mut future=>panic!("request should be gated: {}",r.body)}
    call(&app, &cookie, "consent", json!({"enabled":false})).await;
    call(&app, &cookie, "consent", json!({"enabled":true})).await;
    gate.notify_one();
    assert_eq!(future.await.status, StatusCode::FORBIDDEN);
    {
        let mut s = app.nyx.oauth.0.lock().unwrap();
        s.worker_gate = None;
        s.worker_entered = None;
        s.worker_setup_required = true;
    }
    let setup = call(&app, &cookie, "create", task()).await;
    assert_eq!(setup.body["code"], "cma_setup_required");
    assert!(!setup.body.to_string().contains("secret provider"));
    let other = connect(&app, "worker-owner", 3600).await;
    assert_eq!(session(&app, &other).await.body["workerEnabled"], false);
}
