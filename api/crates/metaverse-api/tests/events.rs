//! 现实事件的集成测试：写入、去重、更正、`/api/v1` 查询、公开读（投影、撤下标记、head、
//! 密度、状态与快照）、事件类型登记、抹除。

mod ingest_support;

use axum::http::{Method, StatusCode};
use ingest_support::*;
use mongodb::bson::doc;
use serde_json::{json, Value};

const BASE: &str = "/api/v1/spaces/restaurant";
const PUBLIC: &str = "/api/public/spaces/restaurant";

async fn restaurant(app: &TestApp) -> String {
    let token = app
        .create_space(who(ORG), "restaurant", "org", ORG, "unlisted")
        .await;
    for (id, visibility) in [("t1", "public"), ("t2", "public"), ("safe", "internal")] {
        app.insert_anchor(
            "restaurant",
            org_owner(),
            json!({"anchorId": id, "kind": "table", "box": [0, 0, 0, 10, 15, 10], "visibility": visibility}),
        )
        .await;
    }
    token
}

async fn register(app: &TestApp, caller: Who<'_>, body: Value) -> Reply {
    app.call(
        caller,
        Method::POST,
        "/api/v1/admin/spaces/restaurant/event-types",
        Some(body),
    )
    .await
}

fn occupancy() -> Value {
    json!({
        "type": "table.occupancy",
        "schema": {"type": "object", "properties": {"guests": {"type": "integer", "minimum": 0},
                   "amount": {"type": "number"}}, "required": ["guests"], "additionalProperties": false},
        "publicFields": ["guests"],
        "defaultVisibility": "public",
        "state": {"key": "occupancy", "value": "guests"},
        "maxAgeSec": 7200,
        "display": {"kind": "highlight", "labelTemplate": "{guests} 位"}
    })
}

async fn register_types(app: &TestApp) {
    for body in [
        occupancy(),
        json!({"type": "table.cleared", "schema": {"type": "object"}, "defaultVisibility": "public",
               "state": {"key": "occupancy", "clears": true}, "display": {"kind": "highlight"}}),
        json!({"type": "order.served", "schema": {"type": "object"}, "publicFields": ["dish"],
               "defaultVisibility": "internal", "display": {"kind": "icon", "durationSec": 3}}),
        json!({"type": "delivery.sent", "schema": {"type": "object"}, "defaultVisibility": "public",
               "display": {"kind": "path", "pathRole": "origin"}}),
        json!({"type": "seat.count", "schema": {"type": "object"}, "publicFields": ["n"],
               "defaultVisibility": "public", "state": {"key": "count", "value": "n"},
               "display": {"kind": "label"}}),
    ] {
        let reply = register(app, who(ORG), body).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    }
}

async fn write(app: &TestApp, caller: Who<'_>, source: &str, events: Value) -> Reply {
    app.call(
        caller,
        Method::POST,
        &format!("{BASE}/sources/{source}/events"),
        Some(json!({"events": events})),
    )
    .await
}

async fn correct(app: &TestApp, source: &str, corrections: Value) -> Reply {
    app.call(
        who(ORG),
        Method::POST,
        &format!("{BASE}/sources/{source}/corrections"),
        Some(json!({"corrections": corrections})),
    )
    .await
}

fn ids(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn event_types_are_versioned_and_validated() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    restaurant(&app).await;
    let first = register(&app, who(ORG), occupancy()).await;
    assert_eq!(first.status, StatusCode::CREATED, "{:?}", first.body);
    assert_eq!(first.body["version"], 1);
    let second = register(&app, who(ORG), occupancy()).await;
    assert_eq!(second.body["version"], 2);
    let mut bad_schema = occupancy();
    bad_schema["schema"] = json!({"type": "nonsense"});
    assert_eq!(register(&app, who(ORG), bad_schema).await.body["code"], "invalid_schema");
    let mut external = occupancy();
    external["schema"] = json!({"$ref": "file:///etc/passwd"});
    assert_eq!(register(&app, who(ORG), external).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    let mut label = occupancy();
    label["display"]["labelTemplate"] = json!("{amount} 元");
    assert_eq!(register(&app, who(ORG), label).await.body["code"], "label_not_public");
    let mut name = occupancy();
    name["type"] = json!("Table Occupancy");
    assert_eq!(register(&app, who(ORG), name).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    let path = json!({"type": "x.path", "schema": {}, "defaultVisibility": "public", "display": {"kind": "path"}});
    assert_eq!(register(&app, who(ORG), path).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    // 只读成员不能登记；陌生人看不到空间。
    assert_eq!(
        register(&app, who_with("bob", "member-token"), occupancy()).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        register(&app, who_with("eve", "stranger-token"), occupancy()).await.status,
        StatusCode::NOT_FOUND
    );
    // 给 AI 的列表含全部版本和 schema。
    let reply = app
        .call(who_with("bob", "member-token"), Method::GET, &format!("{BASE}/event-types"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let items = reply.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items[0]["schema"].is_object());
    assert!(items[0].get("spaceId").is_none());
}

#[tokio::test]
async fn write_dedupe_correct_and_read() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let token = restaurant(&app).await;
    register_types(&app).await;
    let share = format!("Share {token}");
    let batch = json!([
        {"sourceEventId": "e1", "type": "table.occupancy", "anchorId": "t1", "at": ago(600),
         "data": {"guests": 2, "amount": 80}},
        {"sourceEventId": "e2", "type": "order.served", "anchorId": "t1", "at": ago(500), "data": {"dish": "面"}},
        {"sourceEventId": "e3", "type": "table.occupancy", "anchorId": "safe", "at": ago(400), "data": {"guests": 1}},
        {"sourceEventId": "e4", "type": "table.occupancy", "anchorId": "t2", "at": ago(300), "data": {"guests": 4}},
        {"sourceEventId": "e5", "type": "delivery.sent", "anchorId": "_space", "at": ago(200),
         "correlationId": "restaurant:d-1"}
    ]);
    let reply = write(&app, who(ORG), "pos", batch.clone()).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["created"], 5);
    let event_ids: Vec<String> = reply.body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect();
    // 重试同一批：全部是 duplicate，编号不变。
    let again = write(&app, who(ORG), "pos", batch).await;
    assert_eq!(again.body["duplicates"], 5);
    assert_eq!(again.body["created"], 0);
    assert_eq!(again.body["results"][0]["id"], event_ids[0].as_str());
    // 同一个 sourceEventId 在另一个数据源下是另一条事件。
    let other = write(&app, who(ORG), "camera", json!([
        {"sourceEventId": "e1", "type": "table.occupancy", "anchorId": "t2", "at": ago(250), "data": {"guests": 1}}
    ]))
    .await;
    assert_eq!(other.body["created"], 1);
    assert_ne!(other.body["results"][0]["id"], event_ids[0].as_str());
    // 事件文档：source 来自路径，写入者和可见性都记下。
    let stored = app
        .collection("events")
        .find_one(doc! {"_id": &event_ids[0]})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.get_str("source").unwrap(), "pos");
    assert_eq!(stored.get_str("visibility").unwrap(), "public");
    assert_eq!(stored.get_document("actor").unwrap().get_str("scope").unwrap(), "source:pos");

    // 拒收的情况：整批一条也不写。
    let future = metaverse_core::Timestamp::from_millis(
        metaverse_core::Timestamp::parse_rfc3339(&ago(0)).unwrap().millis() + 10 * 60 * 1000,
    )
    .unwrap()
    .to_rfc3339();
    let cases: Vec<(Value, StatusCode, &str)> = vec![
        (json!([{"sourceEventId": "x1", "type": "table.occupancy", "anchorId": "t1", "at": ago(1),
                 "data": {"guests": 1}, "source": "camera"}]), StatusCode::FORBIDDEN, "scope_violation"),
        (json!([{"sourceEventId": "x1", "type": "table.occupancy", "anchorId": "t1", "at": future,
                 "data": {"guests": 1}}]), StatusCode::UNPROCESSABLE_ENTITY, "event_in_future"),
        (json!([{"sourceEventId": "x1", "type": "table.occupancy", "anchorId": "t1", "at": ago(1),
                 "data": {"guests": -1}}]), StatusCode::UNPROCESSABLE_ENTITY, "schema_violation"),
        (json!([{"sourceEventId": "x1", "type": "table.occupancy", "anchorId": "t1", "at": ago(1)}]),
            StatusCode::UNPROCESSABLE_ENTITY, "schema_violation"),
        (json!([{"sourceEventId": "x1", "type": "order.served", "anchorId": "t1", "at": ago(1),
                 "data": {"note": "很".repeat(2000)}}]), StatusCode::UNPROCESSABLE_ENTITY, "data_too_large"),
        (json!([{"sourceEventId": "x1", "type": "no.such", "anchorId": "t1", "at": ago(1)}]),
            StatusCode::UNPROCESSABLE_ENTITY, "unknown_event_type"),
        (json!([{"sourceEventId": "x1", "type": "table.occupancy", "typeVersion": 9, "anchorId": "t1",
                 "at": ago(1), "data": {"guests": 1}}]), StatusCode::UNPROCESSABLE_ENTITY, "unknown_event_type"),
        (json!([{"sourceEventId": "x1", "type": "table.occupancy", "anchorId": "t9", "at": ago(1),
                 "data": {"guests": 1}}]), StatusCode::UNPROCESSABLE_ENTITY, "unknown_anchor"),
        (json!([{"sourceEventId": "x1", "type": "delivery.sent", "anchorId": "_space", "at": ago(1),
                 "correlationId": "florist:d-1"}]), StatusCode::UNPROCESSABLE_ENTITY, "invalid_correlation_id"),
        (json!([{"sourceEventId": "x1", "type": "order.served", "anchorId": "t1", "at": ago(1)},
                {"sourceEventId": "x1", "type": "order.served", "anchorId": "t1", "at": ago(1)}]),
            StatusCode::UNPROCESSABLE_ENTITY, "invalid_request"),
        (json!([{"sourceEventId": "x1", "type": "order.served", "anchorId": "t1", "at": ago(1), "recordedAt": ago(1)}]),
            StatusCode::UNPROCESSABLE_ENTITY, "invalid_request"),
        (json!([]), StatusCode::UNPROCESSABLE_ENTITY, "invalid_request"),
    ];
    for (events, status, code) in cases {
        let reply = write(&app, who(ORG), "pos", events.clone()).await;
        assert_eq!(reply.status, status, "{events}: {:?}", reply.body);
        assert_eq!(reply.body["code"], code, "{events}");
    }
    let too_many: Vec<Value> = (0..1001)
        .map(|i| json!({"sourceEventId": format!("b{i}"), "type": "order.served", "anchorId": "t1", "at": ago(1)}))
        .collect();
    assert_eq!(write(&app, who(ORG), "pos", json!(too_many)).await.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(app
        .collection("events")
        .find_one(doc! {"sourceEventId": "x1"})
        .await
        .unwrap()
        .is_none());
    // 越权：只读成员 403，陌生人 404。
    let one = json!([{"sourceEventId": "m1", "type": "order.served", "anchorId": "t1", "at": ago(1)}]);
    assert_eq!(write(&app, who_with("bob", "member-token"), "pos", one.clone()).await.status, StatusCode::FORBIDDEN);
    assert_eq!(write(&app, who_with("eve", "stranger-token"), "pos", one).await.status, StatusCode::NOT_FOUND);

    // 更正：e1 替换（人数改成 3），e4 撤回。
    let reply = correct(&app, "pos", json!([
        {"sourceEventId": "c1", "correctsSourceEventId": "e1", "type": "table.occupancy", "anchorId": "t1",
         "data": {"guests": 3, "amount": 90}},
        {"sourceEventId": "c2", "corrects": event_ids[3], "retracted": true}
    ]))
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["created"], 2);
    let correction_id = reply.body["results"][0]["id"].as_str().unwrap().to_owned();
    let bad: Vec<(Value, StatusCode)> = vec![
        // 指向另一条更正。
        (json!([{"sourceEventId": "c3", "corrects": correction_id, "retracted": true}]), StatusCode::UNPROCESSABLE_ENTITY),
        // 替换的时间与原事件不同。
        (json!([{"sourceEventId": "c3", "corrects": event_ids[0], "type": "table.occupancy", "anchorId": "t1",
                 "at": ago(1), "data": {"guests": 1}}]), StatusCode::UNPROCESSABLE_ENTITY),
        // 撤回带内容；替换缺锚点；原事件不存在；两种指向都给。
        (json!([{"sourceEventId": "c3", "corrects": event_ids[0], "retracted": true, "data": {}}]), StatusCode::UNPROCESSABLE_ENTITY),
        (json!([{"sourceEventId": "c3", "corrects": event_ids[0], "type": "table.occupancy", "data": {"guests": 1}}]), StatusCode::UNPROCESSABLE_ENTITY),
        (json!([{"sourceEventId": "c3", "correctsSourceEventId": "nope", "retracted": true}]), StatusCode::UNPROCESSABLE_ENTITY),
        (json!([{"sourceEventId": "c3", "corrects": event_ids[0], "correctsSourceEventId": "e1", "retracted": true}]), StatusCode::UNPROCESSABLE_ENTITY),
    ];
    for (body, status) in bad {
        let reply = correct(&app, "pos", body.clone()).await;
        assert_eq!(reply.status, status, "{body}: {:?}", reply.body);
    }
    // 只能经原事件的数据源更正。
    let reply = correct(&app, "camera", json!([{"sourceEventId": "c3", "corrects": event_ids[0], "retracted": true}])).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN, "{:?}", reply.body);

    let window = format!("from={}&to={}", ago(3600), ago(0));
    // /api/v1：更正已应用，含内部级和全部数据。
    let reply = app
        .call(who_with("bob", "member-token"), Method::GET, &format!("{BASE}/events?{window}"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let items = reply.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 5, "{items:?}");
    assert_eq!(items[0]["sourceEventId"], "e1");
    assert_eq!(items[0]["data"], json!({"guests": 3, "amount": 90}));
    assert_eq!(items[0]["corrected"], true);
    assert!(items.iter().any(|item| item["visibility"] == "internal"));
    assert!(!items.iter().any(|item| item["id"] == event_ids[3].as_str()));
    let raw = app
        .call(who(ORG), Method::GET, &format!("{BASE}/events?{window}&raw=true"), None)
        .await;
    assert_eq!(raw.body["items"].as_array().unwrap().len(), 8);
    let reply = app
        .call(who(ORG), Method::GET, &format!("{BASE}/events?from={}&to={}", ago(3 * 86400), ago(0)), None)
        .await;
    assert_eq!(reply.body["code"], "window_too_large");

    // 公开读：要分享令牌；只有公开事件、公开锚点、公开字段。
    let path = format!("{PUBLIC}/events?{window}");
    assert_eq!(app.public(&path, None, &[]).await.status, StatusCode::NOT_FOUND);
    let reply = app.public(&path, Some(&share), &[]).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert!(reply.headers.get("cache-control").unwrap().to_str().unwrap().starts_with("private"));
    let items = reply.body["items"].as_array().unwrap();
    let public_ids = ids(&reply.body["items"]);
    assert!(public_ids.contains(&event_ids[0]));
    assert!(public_ids.contains(&event_ids[4]), "{items:?}");
    assert!(!public_ids.contains(&event_ids[1]), "内部级事件不公开");
    assert!(!public_ids.contains(&event_ids[2]), "内部锚点上的事件不公开");
    assert!(!public_ids.contains(&event_ids[3]), "撤回的事件不公开");
    let e1 = items.iter().find(|item| item["id"] == event_ids[0].as_str()).unwrap();
    assert_eq!(e1["data"], json!({"guests": 3}));
    assert_eq!(e1["type"], "table.occupancy");
    assert!(e1.get("sourceEventId").is_none());
    // types 过滤、分页。
    let reply = app.public(&format!("{path}&types=delivery.sent"), Some(&share), &[]).await;
    assert_eq!(ids(&reply.body["items"]), [event_ids[4].clone()]);
    let mut after: Option<String> = None;
    let mut seen = Vec::new();
    let mut pages = 0;
    loop {
        let mut url = format!("{path}&limit=1");
        if let Some(cursor) = &after {
            url.push_str(&format!("&after={cursor}"));
        }
        let reply = app.public(&url, Some(&share), &[]).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        seen.extend(ids(&reply.body["items"]));
        pages += 1;
        match reply.body["nextAfter"].as_str() {
            Some(next) => after = Some(next.to_owned()),
            None => break,
        }
    }
    assert_eq!(seen, public_ids);
    assert!(pages >= 5);
    // 增量：撤回的公开事件带"撤下"标记；内部级的原本就没公开过，没有标记。
    let reply = app
        .public(&format!("{PUBLIC}/events?since={}", ago(3600)), Some(&share), &[])
        .await;
    let items = reply.body["items"].as_array().unwrap();
    let withdrawn: Vec<&Value> = items.iter().filter(|item| item["withdrawn"] == true).collect();
    assert_eq!(withdrawn.len(), 1, "{items:?}");
    assert_eq!(withdrawn[0]["id"], event_ids[3].as_str());
    assert!(withdrawn[0].get("data").is_none());

    // 把公开事件更正成内部级：从公开接口消失，增量结果带撤下标记。
    let reply = correct(&app, "pos", json!([
        {"sourceEventId": "c4", "corrects": event_ids[4], "type": "delivery.sent", "anchorId": "_space",
         "visibility": "internal"}
    ]))
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let since = reply.body["recordedAt"].as_str().unwrap().to_owned();
    let reply = app.public(&path, Some(&share), &[]).await;
    assert!(!ids(&reply.body["items"]).contains(&event_ids[4]));
    let reply = app
        .public(&format!("{PUBLIC}/events?since={since}"), Some(&share), &[])
        .await;
    assert_eq!(reply.body["items"].as_array().unwrap().len(), 1, "{:?}", reply.body);
    assert_eq!(reply.body["items"][0]["id"], event_ids[4].as_str());
    assert_eq!(reply.body["items"][0]["withdrawn"], true);

    // 抹除 e1：/api/v1 和公开接口都不再返回 data。
    let redact = format!("/api/v1/admin/spaces/restaurant/events/{}/redact", event_ids[0]);
    assert_eq!(
        app.call(who_with("bob", "member-token"), Method::POST, &redact, None).await.status,
        StatusCode::FORBIDDEN
    );
    let reply = app.call(who(ORG), Method::POST, &redact, None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["records"], 2);
    let reply = app
        .call(who(ORG), Method::GET, &format!("{BASE}/events?{window}"), None)
        .await;
    let e1 = reply.body["items"].as_array().unwrap().iter().find(|i| i["id"] == event_ids[0].as_str()).unwrap().clone();
    assert!(e1.get("data").is_none());
    assert_eq!(e1["redacted"], true);
    let reply = app.public(&path, Some(&share), &[]).await;
    let e1 = reply.body["items"].as_array().unwrap().iter().find(|i| i["id"] == event_ids[0].as_str()).unwrap().clone();
    assert!(e1.get("data").is_none());
    let reply = app
        .call(who(ORG), Method::POST, "/api/v1/admin/spaces/restaurant/events/ev_nope/redact", None)
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn head_density_and_state() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let token = restaurant(&app).await;
    register_types(&app).await;
    let share = format!("Share {token}");
    let head = format!("{PUBLIC}/head");
    // 没有事件时 recordedAt 为 null。
    let reply = app.public(&head, Some(&share), &[]).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        reply.body,
        json!({"seq": reply.body["seq"], "at": reply.body["at"], "recordedAt": null})
    );
    assert!(reply.body["seq"].is_u64());
    // 空间信息里的 head 带同一个 recordedAt，还有事件类型（不含 schema）。
    let info = app.public(PUBLIC, Some(&share), &[]).await;
    assert_eq!(info.status, StatusCode::OK, "{:?}", info.body);
    assert_eq!(info.body["head"]["recordedAt"], Value::Null);
    let types = info.body["eventTypes"].as_array().unwrap();
    assert_eq!(types.len(), 5);
    assert!(types.iter().all(|t| t.get("schema").is_none() && t["display"].is_object()));
    assert_eq!(app.public(&head, None, &[]).await.status, StatusCode::NOT_FOUND);
    // 内部级事件不改变 head。
    write(&app, who(ORG), "pos", json!([
        {"sourceEventId": "i1", "type": "order.served", "anchorId": "t1", "at": ago(900)}
    ]))
    .await;
    let reply = app.public(&head, Some(&share), &[]).await;
    assert_eq!(reply.body["recordedAt"], Value::Null);
    let first_tag = reply.headers.get("etag").unwrap().to_str().unwrap().to_owned();
    let reply = app.public(&head, Some(&share), &[("if-none-match", &first_tag)]).await;
    assert_eq!(reply.status, StatusCode::NOT_MODIFIED);
    // 公开事件让 head 变化（同一进程的缓存在写入时失效）。
    let reply = write(&app, who(ORG), "pos", json!([
        {"sourceEventId": "p1", "type": "table.occupancy", "anchorId": "t1", "at": ago(800), "data": {"guests": 2}},
        {"sourceEventId": "p2", "type": "table.occupancy", "anchorId": "t2", "at": ago(700), "data": {"guests": 5}},
        {"sourceEventId": "p3", "type": "table.cleared", "anchorId": "t2", "at": ago(650)}
    ]))
    .await;
    let recorded = reply.body["recordedAt"].as_str().unwrap().to_owned();
    let reply = app.public(&head, Some(&share), &[("if-none-match", &first_tag)]).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["recordedAt"], recorded.as_str());
    assert_ne!(reply.headers.get("etag").unwrap().to_str().unwrap(), first_tag);
    assert!(reply.headers.get("cache-control").unwrap().to_str().unwrap().starts_with("private"));
    let info = app.public(PUBLIC, Some(&share), &[]).await;
    assert_eq!(info.body["head"]["recordedAt"], recorded.as_str());
    // 错误的令牌即使命中缓存也是 404。
    let wrong = format!("Share {}", "B".repeat(43));
    assert_eq!(app.public(&head, Some(&wrong), &[]).await.status, StatusCode::NOT_FOUND);

    // 密度：只数公开锚点上的公开事件。
    let to = metaverse_core::Timestamp::parse_rfc3339(&ago(0)).unwrap();
    let from = to.saturating_add_millis(-1_200_000);
    let reply = app
        .public(&format!("{PUBLIC}/events/density?from={from}&to={to}&bucket=300"), Some(&share), &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["bucketSec"], 300);
    let buckets = reply.body["buckets"].as_array().unwrap();
    assert_eq!(buckets.len(), 4);
    let total: u64 = buckets.iter().map(|b| b["count"].as_u64().unwrap()).sum();
    assert_eq!(total, 3);
    let reply = app
        .public(&format!("{PUBLIC}/events/density?from={}&to={}&bucket=1", ago(100 * 86400), ago(0)), Some(&share), &[])
        .await;
    assert_eq!(reply.body["code"], "window_too_large");

    // 状态：t1 有 2 人；t2 先 5 人、再清空。
    let state_at = |seconds: i64| format!("{PUBLIC}/state?at={}", ago(seconds));
    let reply = app.public(&state_at(0), Some(&share), &[]).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let states = reply.body["states"].as_array().unwrap();
    assert_eq!(states.len(), 1, "{states:?}");
    assert_eq!(states[0]["anchorId"], "t1");
    assert_eq!(states[0]["key"], "occupancy");
    assert_eq!(states[0]["value"], 2);
    assert_eq!(states[0]["type"], "table.occupancy");
    let reply = app.public(&state_at(680), Some(&share), &[]).await;
    assert_eq!(reply.body["states"].as_array().unwrap().len(), 2);
    let reply = app.public(&state_at(850), Some(&share), &[]).await;
    assert_eq!(reply.body["states"], json!([]));
    // 晚到的更正也反映在过去的状态里。
    correct(&app, "pos", json!([
        {"sourceEventId": "pc1", "correctsSourceEventId": "p1", "type": "table.occupancy", "anchorId": "t1",
         "data": {"guests": 6}}
    ]))
    .await;
    let reply = app.public(&state_at(750), Some(&share), &[]).await;
    assert_eq!(reply.body["states"][0]["value"], 6);
}

#[tokio::test]
async fn state_snapshots_are_saved_and_invalidated_by_late_events() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let token = restaurant(&app).await;
    register_types(&app).await;
    let share = format!("Share {token}");
    // 两小时前的 2100 条计数事件（分三批写）。
    let base = metaverse_core::Timestamp::parse_rfc3339(&ago(7200)).unwrap();
    for chunk in 0..3 {
        let events: Vec<Value> = (0..700)
            .map(|i| {
                let n = chunk * 700 + i;
                json!({"sourceEventId": format!("n{n}"), "type": "seat.count", "anchorId": "t2",
                       "at": base.saturating_add_millis(n).to_rfc3339(), "data": {"n": n}})
            })
            .collect();
        let reply = write(&app, who(ORG), "counter", json!(events)).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    // 当作很早以前就记录了（快照只信任两分钟以前记录的数据）。
    app.collection("events")
        .update_many(doc! {"source": "counter"}, doc! {"$set": {"recordedAt": ago(7000)}})
        .await
        .unwrap();
    let state = format!("{PUBLIC}/state?at={}", ago(3000));
    let reply = app.public(&state, Some(&share), &[]).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["states"][0]["value"], 2099);
    let snapshots = app.collection("stateSnapshots").count_documents(doc! {}).await.unwrap();
    assert_eq!(snapshots, 1);
    // 下次直接用快照：即使底层事件不在了，结果也来自快照。
    app.collection("events")
        .delete_many(doc! {"source": "counter"})
        .await
        .unwrap();
    let reply = app.public(&state, Some(&share), &[]).await;
    assert_eq!(reply.body["states"][0]["value"], 2099);
    // 晚到事件（at 早于快照时刻、刚刚记录）让快照失效，重新计算。
    write(&app, who(ORG), "counter", json!([
        {"sourceEventId": "late", "type": "seat.count", "anchorId": "t2", "at": ago(5000), "data": {"n": -1}}
    ]))
    .await;
    let reply = app.public(&state, Some(&share), &[]).await;
    assert_eq!(reply.body["states"][0]["value"], -1, "{:?}", reply.body);
    assert_eq!(app.collection("stateSnapshots").count_documents(doc! {}).await.unwrap(), 0);
}
