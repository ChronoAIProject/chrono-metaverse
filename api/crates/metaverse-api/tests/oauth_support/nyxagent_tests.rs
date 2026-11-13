use super::*;
use futures_util::StreamExt;

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
                {
                    let state = p.0.lock().unwrap();
                    if let Some(status) = state.message_refusal {
                        return (
                            status,
                            Json(json!({"error":{"code":state.nyxagent_error_code,"message":"private upstream diagnostics"}})),
                        )
                            .into_response();
                    }
                }
                let mut created = response();
                created["status"] = json!("in_progress");
                created["output"] = json!([]);
                let sse = format!(
                    "data: {}\n\ndata: {}\n\n",
                    json!({"type":"response.created","response":created}),
                    json!({"type":"response.completed","response":response()})
                );
                let gate = {
                    let state = p.0.lock().unwrap();
                    state.nyxagent_stream_gate.clone().zip(state.nyxagent_stream_entered.clone())
                };
                if let Some((gate, entered)) = gate {
                    let finished = p.0.lock().unwrap().nyxagent_stream_finished.clone();
                    let start = axum::body::Bytes::from(format!("data: {}\n\n", json!({"type":"response.created","response":created})));
                    let end = axum::body::Bytes::from(format!("data: {}\n\n", json!({"type":"response.completed","response":response()})));
                    let stream = futures_util::stream::once(async move { Ok::<_, std::io::Error>(start) })
                        .chain(futures_util::stream::once(async move {
                            entered.notify_one();
                            gate.notified().await;
                            if let Some(finished) = finished {
                                finished.notify_one();
                            }
                            Ok::<_, std::io::Error>(end)
                        }));
                    return ([(header::CONTENT_TYPE, "text/event-stream")], Body::from_stream(stream)).into_response();
                }
                if p.0.lock().unwrap().nyxagent_stream_error {
                    let start = format!("data: {}\n\n", json!({"type":"response.created","response":created}));
                    let stream = futures_util::stream::iter([
                        Ok(axum::body::Bytes::from(start)),
                        Err(std::io::Error::other("private upstream diagnostics")),
                    ]).then(|chunk| async move {
                        if chunk.is_err() {
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                        chunk
                    });
                    return ([(header::CONTENT_TYPE, "text/event-stream")], Body::from_stream(stream)).into_response();
                }
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
    assert_eq!(first.1[header::CACHE_CONTROL], "no-store, no-transform");
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
async fn nyxagent_versions_instructions_without_changing_legacy_retries() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    for version in [None, Some(1), Some(2), Some(3), None] {
        let mut input = task();
        if let Some(version) = version {
            input["instructionsVersion"] = json!(version);
        }
        let result = call(&app, &cookie, "message", input).await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.2);
    }
    {
        let state = app.nyx.oauth.0.lock().unwrap();
        let bodies: Vec<_> = state.worker_calls.iter().map(|(_, _, b)| b).collect();
        assert_eq!(bodies.len(), 5);
        assert_eq!(bodies[0], bodies[1]);
        assert_eq!(bodies[0], bodies[4]);
        let legacy = bodies[0]["instructions"].as_str().unwrap();
        // Pin the actual v1 bytes so an accidental change breaks legacy replay checks.
        assert_eq!(legacy, "你是 chrono-metaverse 空间助手。只使用 NyxID 已授权的 chrono-metaverse 工具。先搜索工具并读取目标空间和最新版本，编号和归属不授予权限；404 不代表可以创建替代空间。缺少权限时提供 NyxID 授权指引。编辑先创建或沿用当前草稿，每次可见修改后生成新的短期预览，把完整预览链接单独一行输出。没有用户对具体预览的明确发布确认时保持草稿；发布冲突时等待，不覆盖、不自动重放。不要索取或输出密钥和登录凭据，不改仓库、不部署、不访问无关服务。回复简短说明实际进展，不能把任务受理当作完成。");
        assert!(bodies[2]["instructions"]
            .as_str()
            .unwrap()
            .starts_with(legacy));
        assert!(bodies[2]["instructions"]
            .as_str()
            .unwrap()
            .contains("GET /api/agent-guide"));
        assert_eq!(bodies[2]["instructions"], format!("{legacy}如果服务只提供通用 request 工具，先通过该工具 GET /api/agent-guide 读取编辑协议；按指南调用同一服务的接口，不猜测路径或操作格式。指南是接口参考，不授予权限，也不能替代用户的发布确认。"));
        assert_eq!(bodies[0]["input"], bodies[2]["input"]);
        assert!(bodies[3]["instructions"]
            .as_str()
            .unwrap()
            .contains("get_agent_guide"));
        assert_eq!(bodies[0]["input"], bodies[3]["input"]);
    }
    for version in [json!(0), json!(5), json!("2"), json!(-1)] {
        let mut input = task();
        input["instructionsVersion"] = version;
        assert_eq!(
            call(&app, &cookie, "message", input).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    assert_eq!(app.nyx.oauth.0.lock().unwrap().worker_calls.len(), 5);
}

#[tokio::test]
async fn nyxagent_page_actions_preserve_retry_context_and_do_not_change_legacy_requests() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    let mut input = task();
    input["instructionsVersion"] = json!(4);
    input["viewerContext"] = json!({"spaces":[{"id":"lobby","name":"前厅"}]});
    for _ in 0..2 {
        assert_eq!(
            call(&app, &cookie, "message", input.clone()).await.0,
            StatusCode::OK
        );
    }
    {
        let state = app.nyx.oauth.0.lock().unwrap();
        let bodies: Vec<_> = state.worker_calls.iter().map(|(_, _, b)| b).collect();
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0], bodies[1]);
        assert!(bodies[0]["instructions"]
            .as_str()
            .unwrap()
            .contains("metaverse-view"));
        assert!(bodies[0]["instructions"]
            .as_str()
            .unwrap()
            .contains("不清缓存"));
        assert!(bodies[0]["input"].as_str().unwrap().contains("前厅"));
    }
    input["instructionsVersion"] = json!(3);
    assert_eq!(
        call(&app, &cookie, "message", input.clone()).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    input["instructionsVersion"] = json!(4);
    input["viewerContext"] = json!({"unbounded":"x".repeat(16001)});
    assert_eq!(
        call(&app, &cookie, "message", input).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(app.nyx.oauth.0.lock().unwrap().worker_calls.len(), 2);
}

#[tokio::test]
async fn nyxagent_reports_stream_failure_without_resetting_or_replaying_the_request() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    app.nyx.oauth.0.lock().unwrap().nyxagent_stream_error = true;
    let result = call(&app, &cookie, "message", task()).await;
    assert_eq!(result.0, StatusCode::OK);
    assert!(result.2.contains("metaverse.error"));
    assert!(result.2.contains("response.created"));
    assert!(!result.2.contains("response.completed"));
    assert!(!result.2.contains("private upstream diagnostics"));
    assert_eq!(
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .worker_calls
            .iter()
            .filter(|(action, _, _)| action == "nyx-message")
            .count(),
        1
    );
}

#[tokio::test]
async fn nyxagent_keeps_running_after_browser_drops_stream_without_replaying() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    let finished = Arc::new(tokio::sync::Notify::new());
    {
        let mut state = app.nyx.oauth.0.lock().unwrap();
        state.nyxagent_stream_gate = Some(gate.clone());
        state.nyxagent_stream_entered = Some(entered.clone());
        state.nyxagent_stream_finished = Some(finished.clone());
    }
    let session = session(&app, &cookie).await;
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("{ROOT}/nyxagent/message"))
        .header(header::COOKIE, &cookie)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {KEY}"))
        .header("x-csrf-token", session.body["csrfToken"].as_str().unwrap())
        .header("x-metaverse-cma-owner", ORG)
        .header("x-metaverse-cma-credential", version())
        .body(Body::from(task().to_string()))
        .unwrap();
    let reply = metaverse_api::app(app.state.clone())
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    let mut body = reply.into_body().into_data_stream();
    let chunk = body.next().await.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&chunk).contains("response.created"));
    tokio::time::timeout(std::time::Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    drop(body); // Browser refresh closes the downstream stream while the upstream turn is live.
    gate.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(3), finished.notified())
        .await
        .unwrap();
    let result = call(&app, &cookie, "response", json!({"responseId":"resp_test"})).await;
    assert_eq!(result.0, StatusCode::OK);
    assert!(result.2.contains("completed"));
    assert_eq!(
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .worker_calls
            .iter()
            .filter(|(action, _, _)| action == "nyx-message")
            .count(),
        1
    );
}

#[tokio::test]
async fn nyxagent_stream_survives_background_oauth_token_refresh() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = connect(&app, SUBJECT, 60).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    {
        let mut state = app.nyx.oauth.0.lock().unwrap();
        state.browser_keys.insert(KEY.into(), metadata(SUBJECT));
        state.access.insert(KEY.into(), SUBJECT.into());
        state.nyxagent_stream_gate = Some(gate.clone());
        state.nyxagent_stream_entered = Some(entered.clone());
    }
    let (reply, ()) = tokio::join!(call(&app, &cookie, "message", task()), async {
        entered.notified().await;
        // A second browser action refreshes the same login while the turn is live.
        tokio::time::sleep(std::time::Duration::from_secs(31)).await;
        assert_eq!(app.nyx.oauth.0.lock().unwrap().refreshes, 0);
        let check = call(&app, &cookie, "key/check", json!({})).await;
        assert_eq!(check.0, StatusCode::OK);
        assert_eq!(app.nyx.oauth.0.lock().unwrap().refreshes, 1);
        gate.notify_one();
    });
    assert_eq!(reply.0, StatusCode::OK);
    assert!(reply.2.contains("response.completed"), "{}", reply.2);
    assert!(!reply.2.contains("metaverse.error"));
    assert_eq!(
        app.nyx
            .oauth
            .0
            .lock()
            .unwrap()
            .worker_calls
            .iter()
            .filter(|(action, _, _)| action == "nyx-message")
            .count(),
        1
    );
}

#[tokio::test]
async fn nyxagent_stream_still_stops_after_login_authority_changes() {
    for change in ["disconnect", "reauthorize"] {
        let Some(app) = TestApp::start_with_options(true, true).await else {
            return;
        };
        let cookie = setup(&app).await;
        let gate = Arc::new(tokio::sync::Notify::new());
        let entered = Arc::new(tokio::sync::Notify::new());
        {
            let mut state = app.nyx.oauth.0.lock().unwrap();
            state.nyxagent_stream_gate = Some(gate.clone());
            state.nyxagent_stream_entered = Some(entered.clone());
        }
        let (reply, ()) = tokio::join!(call(&app, &cookie, "message", task()), async {
            entered.notified().await;
            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
            match change {
                "disconnect" => assert_eq!(
                    disconnect(&app, &cookie).await.status,
                    StatusCode::NO_CONTENT
                ),
                "reauthorize" => {
                    connect(&app, SUBJECT, 3600).await;
                }
                _ => unreachable!(),
            }
            gate.notify_one();
        });
        assert_eq!(reply.0, StatusCode::OK, "{change}");
        assert!(
            reply.2.contains("response.created"),
            "{change}: {}",
            reply.2
        );
        assert!(reply.2.contains("metaverse.error"), "{change}: {}", reply.2);
        assert!(!reply.2.contains("response.completed"), "{change}");
    }
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
    let mut conflicting = metadata(SUBJECT);
    conflicting["api_key"]["effective_services"][1]["catalog_service_slug"] =
        json!("another-service");
    cases.push((conflicting, "nyxagent_key_scope_required"));
    let mut uncatalogued_model = metadata(SUBJECT);
    uncatalogued_model["api_key"]["effective_services"][0]["catalog_service_slug"] = Value::Null;
    cases.push((uncatalogued_model, "nyxagent_key_scope_required"));
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
async fn nyxagent_enrollment_accepts_loopback_http_without_trusting_remote_http() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    for (uri, accepted) in [
        ("http://localhost:13000/login/agent-key", true),
        ("http://127.0.0.1:13000/login/agent-key", true),
        ("http://127.23.4.5:13000/login/agent-key", true),
        ("http://[::1]:13000/login/agent-key", true),
        ("https://nyxid.ai/login/agent-key", true),
        ("http://nyxid.ai/login/agent-key", false),
        ("http://192.168.1.2/login/agent-key", false),
        ("http://localhost.evil.test/login/agent-key", false),
        ("http://[::2]/login/agent-key", false),
        ("http://user@localhost/login/agent-key", false),
        ("http://localhost/login/agent-key?unexpected=1", false),
        ("http://localhost/login/agent-key#fragment", false),
        ("http://localhost/wrong-path", false),
    ] {
        app.nyx.oauth.0.lock().unwrap().key_verification_uri = Some(uri.into());
        let result = call(&app, &cookie, "key/request", json!({})).await;
        assert_eq!(
            result.0,
            if accepted {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            "{uri}: {}",
            result.2
        );
        if accepted {
            let body: Value = serde_json::from_str(&result.2).unwrap();
            let url = url::Url::parse(body["verification_uri"].as_str().unwrap()).unwrap();
            assert_eq!(
                url.query_pairs().find(|(k, _)| k == "user_code").unwrap().1,
                "ABCD-1234"
            );
        } else {
            assert!(!result.2.contains("private-device-code"));
        }
    }
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
async fn nyxagent_accepts_custom_metaverse_and_duplicate_llm_connections() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    // Real NyxID grants include an org-owned custom Metaverse deployment and
    // both personal and org connections to the same public model catalog entry.
    for omit_catalog_field in [false, true] {
        let mut key = metadata(SUBJECT);
        let services = key["api_key"]["effective_services"].as_array_mut().unwrap();
        services[1]["catalog_service_slug"] = Value::Null;
        services[1]["owner_id"] = json!(ORG);
        if omit_catalog_field {
            services[1]
                .as_object_mut()
                .unwrap()
                .remove("catalog_service_slug");
        }
        let mut org_llm = services[2].clone();
        org_llm["id"] = json!("svc-org-llm");
        org_llm["owner_id"] = json!(ORG);
        services.push(org_llm);
        key["api_key"]["allowed_service_ids"]
            .as_array_mut()
            .unwrap()
            .push(json!("svc-org-llm"));
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
        let sent = call(&app, &cookie, "message", task()).await;
        assert_eq!(sent.0, StatusCode::OK, "{}", sent.2);
        assert!(app.nyx.oauth.0.lock().unwrap().key_revocations.is_empty());
    }
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

#[tokio::test]
async fn nyxagent_distinguishes_interrupted_sessions_from_retryable_conflicts() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    let cookie = setup(&app).await;
    for (code, recovery) in [
        ("outcome_unknown", true),
        ("session_busy", false),
        ("idempotency_conflict", false),
        ("private-code", false),
    ] {
        {
            let mut state = app.nyx.oauth.0.lock().unwrap();
            state.message_refusal = Some(StatusCode::CONFLICT);
            state.nyxagent_error_code = Some(code.into());
        }
        let result = call(&app, &cookie, "message", task()).await;
        assert_eq!(result.0, StatusCode::CONFLICT);
        assert_eq!(result.2.contains("nyxagent_recovery_required"), recovery);
        assert_eq!(result.2.contains("开始新的 NyxAgent 对话"), recovery);
        assert!(!result.2.contains("private upstream diagnostics"));
        assert!(!result.2.contains("private-code"));
    }
    assert_eq!(app.nyx.oauth.0.lock().unwrap().worker_calls.len(), 4);
}
