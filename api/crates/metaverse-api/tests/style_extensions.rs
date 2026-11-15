//! 命名样式扩展的真实数据库往返、公开投影、输入边界和旧数据兼容验证。

mod ingest_support;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
};
use ingest_support::*;
use metaverse_core::model::SpaceStyleSpec;
use mongodb::bson::{self, doc};
use serde_json::{json, Value};
use tower::ServiceExt;

const ADMIN: &str = "/api/v1/admin/spaces/style-room";
const PUBLIC: &str = "/api/public/spaces/style-room";

async fn start() -> TestApp {
    let app = TestApp::start(&[]).await.expect("本测试必须连接真实数据库");
    app.create_space(who(ORG), "style-room", "org", ORG, "public")
        .await;
    app
}

async fn update(app: &TestApp, styles: Value) -> Reply {
    app.call(
        who(ORG),
        Method::PATCH,
        ADMIN,
        Some(json!({"styles": styles})),
    )
    .await
}

async fn preview_styles(app: &TestApp) -> Value {
    let draft = app
        .call(
            who(ORG),
            Method::POST,
            "/api/v1/spaces/style-room/drafts",
            Some(json!({})),
        )
        .await;
    assert_eq!(draft.status, StatusCode::CREATED, "{:?}", draft.body);
    let preview = app
        .call(
            who(ORG),
            Method::POST,
            &format!(
                "/api/v1/spaces/style-room/drafts/{}/preview",
                draft.body["id"].as_str().unwrap()
            ),
            Some(json!({})),
        )
        .await;
    assert_eq!(preview.status, StatusCode::CREATED, "{:?}", preview.body);
    let auth = format!("Preview {}", preview.body["token"].as_str().unwrap());
    let reply = app.public("/api/public/previews", Some(&auth), &[]).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    reply.body["styles"].clone()
}

#[tokio::test]
async fn 自定义扩展经管理更新和数据库无损投影到公开空间与时间线快照() {
    let app = start().await;
    let seq = app
        .insert_commit("style-room", org_owner(), &ago(0), None)
        .await;
    let styles = json!([{
        "id": "curated", "name": "策展主题", "visibleLayers": ["ext"],
        "extensions": {
            "badge": "开放日策展",
            "exhibition": {"title": "共创展", "edition": 2026, "zones": ["实体区", "虚拟展区"]},
            "options": [true, false, null, 0.125, -9007199254740991_i64, {"enabled": true}]
        }
    }]);
    let saved = update(&app, styles.clone()).await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body["styles"], styles);
    let partial = app
        .call(
            who(ORG),
            Method::PATCH,
            ADMIN,
            Some(json!({"name": "保留扩展"})),
        )
        .await;
    assert_eq!(partial.status, StatusCode::OK, "{:?}", partial.body);
    assert_eq!(partial.body["styles"], styles);
    let persisted = app
        .collection("spaces")
        .find_one(doc! {"_id": "style-room"})
        .await
        .unwrap()
        .unwrap();
    let decoded: Vec<SpaceStyleSpec> =
        bson::deserialize_from_bson(persisted.get("styles").unwrap().clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), styles);
    assert_eq!(preview_styles(&app).await, styles);
    for path in [
        PUBLIC.to_owned(),
        "/api/v1/spaces/style-room".to_owned(),
        format!("{PUBLIC}/snapshot?seq=0"),
        format!("{PUBLIC}/snapshot?seq={seq}"),
        format!("/api/v1/spaces/style-room/snapshot?seq={seq}"),
    ] {
        let reply = if path.starts_with("/api/v1") {
            app.call(who(ORG), Method::GET, &path, None).await
        } else {
            app.public(&path, None, &[]).await
        };
        assert_eq!(reply.status, StatusCode::OK, "{path}：{:?}", reply.body);
        assert_eq!(reply.body["styles"], styles, "{path}");
    }
}

fn assert_chinese_problem(status: StatusCode, problem: &Value) {
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
    assert_eq!(problem["code"], "invalid_request", "{problem}");
    let detail = problem["detail"].as_str().unwrap();
    assert!(
        detail
            .chars()
            .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch)),
        "必须返回中文校验说明：{detail}"
    );
    assert_eq!(detail.matches('`').count() % 2, 0, "{detail}");
    for prose in detail.split('`').step_by(2) {
        assert!(
            !prose.chars().any(|ch| ch.is_ascii_alphabetic()),
            "说明中存在裸英文标识：{detail}"
        );
    }
}

#[tokio::test]
async fn 样式输入边界的完整中文错误说明与逐次数据库不变矩阵() {
    let app = start().await;
    let original =
        json!([{"id": "curated", "name": "策展主题", "extensions": {"badge": "原有策展"}}]);
    assert_eq!(update(&app, original.clone()).await.status, StatusCode::OK);
    let before = app
        .collection("spaces")
        .find_one(doc! {"_id": "style-room"})
        .await
        .unwrap()
        .unwrap();
    let mut extensions = vec![
        json!(null),
        json!([]),
        json!("文本"),
        json!(42),
        json!(true),
    ];
    for key in [
        "",
        "$where",
        "a$b",
        "a.b",
        "a\0b",
        "a\nb",
        "__proto__",
        "constructor",
        "prototype",
        &"键".repeat(43),
    ] {
        extensions.extend([json!({key: true}), json!({"nested": [{key: true}]})]);
    }
    extensions.extend([
        json!({"number": u64::MAX}),
        json!({"number": i64::MIN}),
        json!({"number": 9007199254740992_i64}),
        json!({"number": 1e100}),
        json!({"entries": vec![Value::Null; 256]}),
        json!({"depth": (0..8).fold(Value::Null, |v, _| json!([v]))}),
        json!({"text": "中".repeat(6000)}),
    ]);
    let mut fields: Vec<Value> = extensions
        .into_iter()
        .map(|value| json!({"extensions": value}))
        .collect();
    fields.extend([
        json!({"mode": "invalid"}),
        json!({"rebuiltStyle": "invalid"}),
        json!({"lighting": "invalid"}),
        json!({"look": {"opacity": -0.1}}),
        json!({"look": {"opacity": 1.1}}),
        json!({"id": "invalid/id"}),
        json!({"id": "`bareEnglish"}),
        json!({"name": " "}),
        json!({"visibleLayers": ["ext", "ext"]}),
        json!({"filterKinds": ["object", "object"]}),
        json!({"extensons": {}, "visbleLayers": ["ext"]}),
        json!({"look": {"roughnes": 0.5}}),
        json!({"look": {"`unknownField": true}}),
    ]);
    for field in [
        "id",
        "name",
        "description",
        "swatch",
        "mode",
        "rebuiltStyle",
        "lighting",
        "backgroundColor",
    ] {
        for value in [json!(false), json!(42), json!([]), json!({})] {
            fields.push(json!({field: value}));
        }
    }
    for field in ["visibleLayers", "filterKinds"] {
        for value in [
            json!(true),
            json!(42),
            json!("ext"),
            json!({}),
            json!(["unknown"]),
            json!([""]),
            json!([false]),
            json!([null]),
        ] {
            fields.push(json!({field: value}));
        }
    }
    for value in [json!(true), json!(42), json!("外观"), json!([])] {
        fields.push(json!({"look": value}));
    }
    for field in ["stripTextures", "wireframe", "unlit"] {
        fields.push(json!({"look": {field: "错误类型"}}));
    }
    for field in ["roughness", "metalness", "opacity"] {
        fields.push(json!({"look": {field: "错误类型"}}));
    }
    for field in ["structureColor", "objectColor", "tint"] {
        for value in [
            json!("颜色"),
            json!([0, 0]),
            json!([256, 0, 0]),
            json!([0, "错误", 0]),
        ] {
            fields.push(json!({"look": {field: value}}));
        }
    }
    fields.push(json!({"look": {"edgeColor": 42}}));
    let mut requests: Vec<String> = fields
        .into_iter()
        .map(|fields| {
            let mut style = json!({"id": "invalid", "name": "非法样式"});
            style
                .as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            json!({"styles": [style]}).to_string()
        })
        .collect();
    for styles in [
        json!(true),
        json!(42),
        json!("样式"),
        json!({}),
        json!([null]),
        json!([true]),
        json!([42]),
        json!(["样式"]),
        json!([[]]),
        json!([{}]),
        json!([{"id": "invalid"}]),
        json!([{"name": "缺少编号"}]),
        json!([{"id": null, "name": "空编号"}]),
        json!([{"id": "invalid", "name": null}]),
        json!([{"id": "same", "name": "重复"}, {"id": "same", "name": "重复"}]),
    ] {
        requests.push(json!({"styles": styles}).to_string());
    }
    for id in [
        json!(true),
        json!(42),
        json!([]),
        json!({}),
        json!(".hidden"),
        json!("with space"),
        json!("with:colon"),
        json!("样式"),
        json!("trailing\n"),
        json!("a".repeat(129)),
        json!("`bareEnglish"),
    ] {
        requests.push(json!({"defaultStyleId": id}).to_string());
        requests.push(json!({"styles": original, "defaultStyleId": id}).to_string());
    }
    requests.extend([
        r#"{"styles":[{"id":"invalid","name":"非法数值","extensions":{"value":1e400}}]}"#
            .to_owned(),
        r#"{"styles":[{"id":"invalid","name":"非法数值","look":{"opacity":1e400}}]}"#.to_owned(),
        r#"{"styles":1e400}"#.to_owned(),
        r#"{"defaultStyleId":1e400}"#.to_owned(),
    ]);
    for body in &requests {
        let request = Request::builder()
            .method(Method::PATCH)
            .uri(ADMIN)
            .header("content-type", "application/json")
            .header("x-nyxid-identity-token", identity(ORG))
            .body(Body::from(body.clone()))
            .unwrap();
        let response = metaverse_api::app(app.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let problem: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "请求应被拒绝：{body}；响应：{problem}"
        );
        assert_chinese_problem(status, &problem);
        let after = app
            .collection("spaces")
            .find_one(doc! {"_id": "style-room"})
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after, before, "每次拒绝均不得改变完整空间文档：{body}");
    }
    println!("完整中文说明及数据库不变矩阵：{} 例", requests.len());
    let public = app.public(PUBLIC, None, &[]).await;
    assert_eq!(public.status, StatusCode::OK);
    assert_eq!(public.body["styles"], original);
}

#[tokio::test]
async fn 样式目录省略与空值保留而空数组清空() {
    let app = start().await;
    let styles = json!([{"id": "saved", "name": "保存样式"}]);
    assert_eq!(update(&app, styles.clone()).await.status, StatusCode::OK);
    for body in [json!({}), json!({"styles": null})] {
        let reply = app.call(who(ORG), Method::PATCH, ADMIN, Some(body)).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        assert_eq!(reply.body["styles"], styles);
    }
    let reply = update(&app, json!([])).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert!(reply.body.get("styles").is_none());
    let stored = app
        .collection("spaces")
        .find_one(doc! {"_id": "style-room"})
        .await
        .unwrap()
        .unwrap();
    assert!(stored.get_array("styles").unwrap().is_empty());
}

#[tokio::test]
async fn 旧样式与空扩展在管理公开快照和存储中不产生多余字段() {
    let app = start().await;
    for extensions in [None, Some(json!({}))] {
        let mut style = json!({"id": "legacy", "name": "兼容样式", "mode": "optimized"});
        let expected = json!([style.clone()]);
        if let Some(extensions) = extensions {
            style["extensions"] = extensions;
        }
        let saved = update(&app, json!([style])).await;
        assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
        assert_eq!(saved.body["styles"], expected);
        assert_eq!(preview_styles(&app).await, expected);
        let persisted = app
            .collection("spaces")
            .find_one(doc! {"_id": "style-room"})
            .await
            .unwrap()
            .unwrap();
        assert!(persisted.get_array("styles").unwrap()[0]
            .as_document()
            .unwrap()
            .get("extensions")
            .is_none());
        for path in [PUBLIC.to_owned(), format!("{PUBLIC}/snapshot?seq=0")] {
            let reply = app.public(&path, None, &[]).await;
            assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
            assert_eq!(reply.body["styles"], expected);
        }
    }
    // 旧存储模型继续容忍未来字段，严格输入边界只作用于管理写请求。
    let decoded: SpaceStyleSpec =
        serde_json::from_value(json!({"id": "legacy", "name": "兼容样式", "futureField": true}))
            .unwrap();
    assert!(decoded.extensions.is_empty());
}

#[tokio::test]
async fn 既有字段类型错误保持原提取器响应() {
    use metaverse_api::routes::{
        admin_space_settings::UpdateSpaceRequest,
        universes::{JoinUniverseRequest, UpdateUniverseRequest},
    };
    let app = start().await;
    for (method, path, body, expected) in [
        (
            Method::PATCH,
            ADMIN,
            json!({"name": 42}),
            axum::Json::<UpdateSpaceRequest>::from_bytes(br#"{"name":42}"#)
                .unwrap_err()
                .body_text(),
        ),
        (
            Method::PATCH,
            "/api/v1/universes/missing",
            json!({"name": 42}),
            axum::Json::<UpdateUniverseRequest>::from_bytes(br#"{"name":42}"#)
                .unwrap_err()
                .body_text(),
        ),
        (
            Method::POST,
            "/api/v1/universes/missing/members/style-room",
            json!({"offset": "错误类型", "rotation": 0}),
            axum::Json::<JoinUniverseRequest>::from_bytes(
                "{\"offset\":\"错误类型\",\"rotation\":0}".as_bytes(),
            )
            .unwrap_err()
            .body_text(),
        ),
    ] {
        let reply = app.call(who(ORG), method, path, Some(body)).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(reply.body["code"], "invalid_request");
        assert_eq!(reply.body["detail"], expected, "既有字段应保留原错误行为");
    }
}

fn 验证无内部字段(value: &Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                assert!(
                    !["shareTokens", "owner", "ownerEvidence", "storageLimitBytes"]
                        .contains(&key.as_str()),
                    "公开投影不得泄露内部字段：`{key}`"
                );
                验证无内部字段(value);
            }
        }
        Value::Array(items) => items.iter().for_each(验证无内部字段),
        _ => {}
    }
}

async fn 验证空间分享读取(
    app: &TestApp,
    share: &str,
    styles: &Value,
    default: Option<&str>,
    seqs: &[i64],
) {
    let mut paths = vec![PUBLIC.to_owned(), format!("{PUBLIC}/timeline")];
    paths.extend(
        seqs.iter()
            .map(|seq| format!("{PUBLIC}/snapshot?seq={seq}")),
    );
    for path in paths {
        let reply = app.public(&path, Some(share), &[]).await;
        assert_eq!(
            reply.status,
            StatusCode::OK,
            "读取失败：{path}；{:?}",
            reply.body
        );
        assert!(
            reply.headers["cache-control"]
                .to_str()
                .unwrap()
                .starts_with("private"),
            "分享读取必须使用私有缓存：{path}"
        );
        验证无内部字段(&reply.body);
        if path.ends_with("/timeline") {
            let actual: Vec<i64> = reply.body["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["seq"].as_i64().unwrap())
                .collect();
            for seq in seqs.iter().filter(|seq| **seq > 0) {
                assert!(actual.contains(seq), "时间线必须保留已发布提交：{seq}");
            }
        } else {
            if styles.as_array().unwrap().is_empty() {
                assert!(reply.body.get("styles").is_none(), "空目录应省略 `styles`");
            } else {
                assert_eq!(
                    &reply.body["styles"], styles,
                    "样式目录必须完整投影：{path}"
                );
            }
            assert_eq!(
                reply.body.get("defaultStyleId").and_then(Value::as_str),
                default,
                "默认样式必须完整投影：{path}"
            );
        }
        for invalid in [
            None,
            Some("Share wrong-token-0123456789abcdef"),
            Some("Share short"),
            Some(&share.replacen("Share ", "Bearer ", 1)),
        ] {
            let rejected = app.public(&path, invalid, &[]).await;
            assert_eq!(
                rejected.status,
                StatusCode::NOT_FOUND,
                "无效授权不得读取：{path}"
            );
            assert_eq!(
                rejected.headers["cache-control"], "no-store",
                "拒绝响应不得缓存：{path}"
            );
        }
    }
}

#[tokio::test]
async fn 凭链接空间的原分享令牌贯穿样式配置清空草稿预览并在轮换后立即吊销() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接真实数据库");
    let token = app
        .create_space(who(ORG), "style-room", "org", ORG, "unlisted")
        .await;
    let share = format!("Share {token}");
    let historical = app
        .insert_commit("style-room", org_owner(), &ago(2), None)
        .await;
    let latest = app
        .insert_commit("style-room", org_owner(), &ago(1), None)
        .await;
    let seqs = [0, historical, latest];
    let mut styles = json!([{
        "id": "curated", "name": "策展主题", "mode": "extended",
        "visibleLayers": ["rebuilt", "ext"], "filterKinds": ["structure", "object"],
        "look": {"wireframe": true, "opacity": 0.75, "tint": [32, 96, 160]},
        "extensions": {"badge": "链接策展", "exhibition": {"edition": 2026, "zones": ["实体区", "虚拟区"]}}
    }]);
    验证空间分享读取(&app, &share, &json!([]), None, &seqs).await;
    for body in [
        json!({"styles": styles, "defaultStyleId": "curated"}),
        json!({"name": "保留既有分享"}),
        json!({"styles": null}),
    ] {
        let saved = app.call(who(ORG), Method::PATCH, ADMIN, Some(body)).await;
        assert_eq!(
            saved.status,
            StatusCode::OK,
            "管理更新失败：{:?}",
            saved.body
        );
        验证空间分享读取(&app, &share, &styles, Some("curated"), &seqs).await;
    }
    styles[0]["visibleLayers"] = json!(["ext"]);
    styles[0]["filterKinds"] = json!(["object"]);
    styles[0]["look"]["opacity"] = json!(0.5);
    styles[0]["extensions"]["badge"] = json!("更新后的策展");
    assert_eq!(update(&app, styles.clone()).await.status, StatusCode::OK);
    验证空间分享读取(&app, &share, &styles, Some("curated"), &seqs).await;
    let cleared = app
        .call(
            who(ORG),
            Method::PATCH,
            ADMIN,
            Some(json!({"styles": [], "defaultStyleId": null})),
        )
        .await;
    assert_eq!(
        cleared.status,
        StatusCode::OK,
        "清空失败：{:?}",
        cleared.body
    );
    验证空间分享读取(&app, &share, &json!([]), None, &seqs).await;
    let saved = app
        .call(
            who(ORG),
            Method::PATCH,
            ADMIN,
            Some(json!({"styles": styles, "defaultStyleId": "curated"})),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK);

    let before = app
        .collection("spaces")
        .find_one(doc! {"_id": "style-room"})
        .await
        .unwrap()
        .unwrap()["shareTokens"]
        .clone();
    let draft = app
        .call(
            who(ORG),
            Method::POST,
            "/api/v1/spaces/style-room/drafts",
            Some(json!({})),
        )
        .await;
    assert_eq!(
        draft.status,
        StatusCode::CREATED,
        "创建草稿失败：{:?}",
        draft.body
    );
    let preview = app
        .call(
            who(ORG),
            Method::POST,
            &format!(
                "/api/v1/spaces/style-room/drafts/{}/preview",
                draft.body["id"].as_str().unwrap()
            ),
            Some(json!({})),
        )
        .await;
    assert_eq!(
        preview.status,
        StatusCode::CREATED,
        "签发预览失败：{:?}",
        preview.body
    );
    let preview_auth = format!("Preview {}", preview.body["token"].as_str().unwrap());
    let view = app
        .public("/api/public/previews", Some(&preview_auth), &[])
        .await;
    assert_eq!(view.status, StatusCode::OK, "预览读取失败：{:?}", view.body);
    assert_eq!(view.headers["cache-control"], "no-store");
    assert_eq!(view.body["styles"], styles);
    assert_eq!(view.body["defaultStyleId"], "curated");
    验证无内部字段(&view.body);
    let after = app
        .collection("spaces")
        .find_one(doc! {"_id": "style-room"})
        .await
        .unwrap()
        .unwrap()["shareTokens"]
        .clone();
    assert_eq!(before, after, "创建和读取草稿预览不得覆盖既有分享令牌记录");
    验证空间分享读取(&app, &share, &styles, Some("curated"), &seqs).await;
    let mut protected = vec![PUBLIC.to_owned(), format!("{PUBLIC}/timeline")];
    protected.extend(
        seqs.iter()
            .map(|seq| format!("{PUBLIC}/snapshot?seq={seq}")),
    );
    for path in &protected {
        let rejected = app.public(path, Some(&preview_auth), &[]).await;
        assert_eq!(
            rejected.status,
            StatusCode::NOT_FOUND,
            "预览令牌不得替代分享授权：{path}"
        );
        assert_eq!(rejected.headers["cache-control"], "no-store");
    }
    let rejected = app.public("/api/public/previews", Some(&share), &[]).await;
    assert_eq!(
        rejected.status,
        StatusCode::NOT_FOUND,
        "分享令牌不得替代预览授权"
    );
    assert_eq!(rejected.headers["cache-control"], "no-store");

    let rotated = app
        .call(
            who(ORG),
            Method::POST,
            &format!("{ADMIN}/share-tokens"),
            None,
        )
        .await;
    assert_eq!(
        rotated.status,
        StatusCode::CREATED,
        "轮换失败：{:?}",
        rotated.body
    );
    let fresh = format!("Share {}", rotated.body["token"].as_str().unwrap());
    assert_ne!(fresh, share, "轮换必须生成新的分享令牌");
    for path in &protected {
        let rejected = app.public(path, Some(&share), &[]).await;
        assert_eq!(
            rejected.status,
            StatusCode::NOT_FOUND,
            "旧令牌必须立即失效：{path}"
        );
        assert_eq!(rejected.headers["cache-control"], "no-store");
    }
    验证空间分享读取(&app, &fresh, &styles, Some("curated"), &seqs).await;
}
