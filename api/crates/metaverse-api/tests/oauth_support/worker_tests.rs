use super::*;

pub(super) fn routes(provider: MockProvider, app: Router) -> Router {
    let handshake = provider.clone();
    let list = provider.clone();
    let create = provider.clone();
    let message = provider.clone();
    let control = provider.clone();
    let attachment = provider.clone();
    app.route("/auth/session", get(move |headers: HeaderMap| {
        let p = handshake.clone(); async move {
            assert!(!headers.contains_key(header::COOKIE));
            let token = headers[header::AUTHORIZATION].to_str().unwrap().strip_prefix("Bearer ").unwrap();
            let (reply, gate, entered) = {
                let mut s = p.0.lock().unwrap();
                let subject = json!(s.access[token]);
                s.cma_auth_calls += 1;
                (s.cma_auth_reply.clone().unwrap_or((StatusCode::OK, json!({"authenticated":true,"subject":subject,"api_commands":true}))), s.cma_auth_gate.clone(), s.cma_auth_entered.clone())
            };
            if let Some(entered) = entered { entered.notify_one(); }
            if let Some(gate) = gate { gate.notified().await; }
            (reply.0, Json(reply.1))
        }
    }))
    .route("/api/v1/agents", get(move |headers: HeaderMap| {
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
    .route("/api/v1/agents/{id}/attachments", post(move |Path(id): Path<String>, axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>, headers: HeaderMap, bytes: axum::body::Bytes| {
        let p = attachment.clone(); async move {
            let token = headers[header::AUTHORIZATION].to_str().unwrap().strip_prefix("Bearer ").unwrap();
            let name = &query["name"];
            let hash = format!("{:x}", Sha256::digest(&bytes));
            let receipt = json!({"id":"att_test","agent_id":id,"name":name,"path":format!("/home/attachments/{id}/att_test/{name}"),"size_bytes":bytes.len(),"media_type":"application/octet-stream","sha256":if name == "bad.glb" {"bad"} else {&hash}});
            let mut state = p.0.lock().unwrap();
            assert!(state.access.contains_key(token));
            assert!(!headers.contains_key(header::COOKIE));
            state.worker_calls.push(("attachment".into(),headers["idempotency-key"].to_str().unwrap().into(),receipt.clone()));
            (StatusCode::CREATED, Json(receipt))
        }
    }).layer(axum::extract::DefaultBodyLimit::max(20 * 1024 * 1024)))
    .route("/api/v1/agent-lifecycle/{id}",get(|| async {Json(json!({"id":"op_test","status":"succeeded","phase":"ready","agent_id":"agt_test"}))}))
    .route("/api/v1/agents/{id}",get(|| async {Json(json!({"id":"agt_test","status":"working"}))}))
    .route("/api/v1/agents/{id}/transcript",get(|| async {Json(json!({"agent_id":"agt_test","through_seq":4,"turns":[]}))}))
    .route("/api/v2/agents/{id}/responses",post(move |headers: HeaderMap,Json(body):Json<Value>|{
        let p=message.clone();async move {
            let mut state = p.0.lock().unwrap();
            state.worker_calls.push(("message".into(),headers["idempotency-key"].to_str().unwrap().into(),body));
            if let Some(status) = state.message_refusal { return (status, Json(json!({"code":"response_forbidden","message":"private diagnostic"}))).into_response(); }
            (StatusCode::OK,[("x-cma-response-id","resp_test"),("x-cma-command-id","cmd_test"),("content-type","text/event-stream")],"event: response.created\ndata: {}\n\n").into_response()
        }
    }))
    .route("/api/v2/responses/{id}",get(||async{Json(json!({"id":"resp_test","status":"in_progress"}))}))
    .route("/api/v2/agents/{id}/responses/{response_id}/controls",get(||async{Json(json!({"agent_revision":7,"target_active":true,"target":{"turn_sequence":3}}))}).post(move|headers:HeaderMap,Json(body):Json<Value>|{
        let p=control.clone();async move{
            p.0.lock().unwrap().worker_calls.push(("cancel".into(),headers["idempotency-key"].to_str().unwrap().into(),body));
            (StatusCode::ACCEPTED,Json(json!({"control":{"id":"cmd_stop","status":"admitted"}})))
        }
    })).layer(axum::middleware::from_fn(move |request: axum::extract::Request, next: axum::middleware::Next| {
        let p = provider.clone();
        async move {
            assert!(!request.headers().contains_key(header::COOKIE));
            let valid = request.headers().get(header::AUTHORIZATION).and_then(|v|v.to_str().ok()).and_then(|v|v.strip_prefix("Bearer ")).is_some_and(|v|p.0.lock().unwrap().access.contains_key(v));
            if !valid { return StatusCode::UNAUTHORIZED.into_response(); }
            p.0.lock().unwrap().worker_bearers.push(request.headers()[header::AUTHORIZATION].to_str().unwrap().to_owned());
            next.run(request).await
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
            ("x-metaverse-cma-owner", ORG),
        ],
        Some(body),
    )
    .await
}
fn task() -> Value {
    json!({"context":{"spaceId":"lobby","orgId":ORG},"instruction":"在入口建欢迎区，先预览","idempotencyKey":"stable-create-000001"})
}

#[tokio::test]
async fn existing_space_worker_uses_pinned_tools_and_accepts_only_its_own_attachments() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "context-owner", 3600).await;
    call(&app, &cookie, "consent", json!({"enabled": true})).await;
    let source = session(&app, &cookie).await.body["toolSourceRef"].clone();
    assert_eq!(source.as_str().unwrap().len(), 40);
    let mut input = task();
    input["context"]["toolSourceRef"] = source.clone();
    assert_eq!(
        call(&app, &cookie, "create", input.clone()).await.status,
        StatusCode::ACCEPTED
    );
    {
        let state = app.nyx.oauth.0.lock().unwrap();
        let body = &state.worker_calls.last().unwrap().2;
        assert_eq!(body["repository"]["ref"], source);
        assert!(body["initial_message"]
            .as_str()
            .unwrap()
            .contains("metaverse context"));
        assert!(!body.to_string().contains("oauth-access"));
    }
    input["context"]["toolSourceRef"] = json!("dev");
    assert_eq!(
        call(&app, &cookie, "create", input.clone()).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    input["context"]["toolSourceRef"] = source;
    input["agentId"] = json!("agt_test");
    input["context"]["attachments"] = json!([{"id":"att_test", "agent_id":"agt_other", "name":"building.glb", "path":"/home/attachments/agt_other/att_test/building.glb", "size_bytes":100, "media_type":"application/octet-stream", "sha256":"a".repeat(64)}]);
    assert_eq!(
        call(&app, &cookie, "message", input.clone()).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    input["context"]["attachments"][0]["agent_id"] = json!("agt_test");
    input["context"]["attachments"][0]["path"] =
        json!("/home/attachments/agt_test/att_test/building.glb");
    assert_eq!(
        call(&app, &cookie, "message", input).await.status,
        StatusCode::ACCEPTED
    );
    let state = app.nyx.oauth.0.lock().unwrap();
    let message = &state.worker_calls.last().unwrap().2;
    assert!(message["input"].as_str().unwrap().contains("building.glb"));
    assert_eq!(
        state
            .worker_calls
            .iter()
            .filter(|call| call.0 == "create")
            .count(),
        1
    );
    drop(state);
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

#[tokio::test]
async fn creation_sources_select_the_pinned_tools_and_preserve_owner_and_service_scope() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "source-owner", 3600).await;
    call(&app, &cookie, "consent", json!({"enabled":true})).await;
    let mut input = task();
    input["context"]["creation"] = json!({"name":"New room","source":{"kind":"scaniverse","url":"https://scaniverse.com/scan/one"}});
    let created = call(&app, &cookie, "create", input.clone()).await;
    assert_eq!(created.status, StatusCode::ACCEPTED, "{}", created.body);
    let body = app
        .nyx
        .oauth
        .0
        .lock()
        .unwrap()
        .worker_calls
        .last()
        .unwrap()
        .2
        .clone();
    assert_eq!(
        body["repository"]["ref"],
        "d2ac32a337836d8338a5ed9b1cd7f8e8cc0429e2"
    );
    assert!(body["initial_message"]
        .as_str()
        .unwrap()
        .contains("metaverse-recon source"));
    assert!(body["initial_message"].as_str().unwrap().contains(ORG));
    assert_eq!(
        body["profile"]["permissions"]["services"],
        json!(["chrono-metaverse"])
    );
    input["context"]["creation"]["source"]["url"] = json!("https://evil.test/scan/one");
    assert_eq!(
        call(&app, &cookie, "create", input.clone()).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    input["context"]["creation"]["source"] =
        json!({"kind":"file","name":"room.glb","size":8,"sha256":"a".repeat(64)});
    assert_eq!(
        call(&app, &cookie, "create", input.clone()).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    input["prepareOnly"] = json!(true);
    assert_eq!(
        call(&app, &cookie, "create", input).await.status,
        StatusCode::ACCEPTED
    );
    let body = app
        .nyx
        .oauth
        .0
        .lock()
        .unwrap()
        .worker_calls
        .last()
        .unwrap()
        .2
        .clone();
    assert!(body["initial_message"]
        .as_str()
        .unwrap()
        .contains("文件尚未上传"));
    assert!(!body["initial_message"]
        .as_str()
        .unwrap()
        .contains("metaverse-recon source"));
}

async fn upload(
    app: &TestApp,
    cookie: &str,
    csrf: &str,
    name: &str,
    size: usize,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::POST)
        .uri(format!(
            "{ROOT}/worker/attachment?agentId=agt_test&name={name}"
        ))
        .header("cookie", cookie)
        .header("origin", ORIGIN)
        .header("x-csrf-token", csrf)
        .header("idempotency-key", "stable-attachment-0001")
        .header("content-type", "application/octet-stream")
        .body(Body::from(vec![42u8; size]))
        .unwrap();
    let response = metaverse_api::app(app.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    assert!(response.headers()[header::CACHE_CONTROL]
        .to_str()
        .unwrap()
        .contains("no-store"));
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn model_upload_checks_consent_csrf_size_and_receipt_and_retries_the_same_upstream_request() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, "upload-owner", 3600).await;
    let session = session(&app, &cookie).await;
    let csrf = session.body["csrfToken"].as_str().unwrap();
    assert_eq!(
        upload(&app, &cookie, csrf, "room.glb", 8).await.0,
        StatusCode::FORBIDDEN
    );
    call(&app, &cookie, "consent", json!({"enabled":true})).await;
    assert_eq!(
        upload(&app, &cookie, "wrong", "room.glb", 8).await.0,
        StatusCode::FORBIDDEN
    );
    let first = upload(&app, &cookie, csrf, "room.glb", 9 * 1024 * 1024).await;
    assert_eq!(first.0, StatusCode::CREATED, "{}", first.1);
    assert_eq!(first.1["size_bytes"], 9 * 1024 * 1024);
    assert_eq!(
        upload(&app, &cookie, csrf, "room.glb", 9 * 1024 * 1024).await,
        first
    );
    {
        let state = app.nyx.oauth.0.lock().unwrap();
        assert_eq!(state.worker_calls.len(), 2);
        assert_eq!(state.worker_calls[0], state.worker_calls[1]);
    }
    assert_eq!(
        upload(&app, &cookie, csrf, "bad.glb", 8).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        upload(&app, &cookie, csrf, "room.glb", 20 * 1024 * 1024 + 1)
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        upload(&app, &cookie, csrf, "room.exe", 8).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    call(&app, &cookie, "consent", json!({"enabled":false})).await;
    assert_eq!(
        upload(&app, &cookie, csrf, "room.glb", 8).await.0,
        StatusCode::FORBIDDEN
    );
}
