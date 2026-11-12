//! 时间线与公开读的集成测试：真实本地 MongoDB + 模拟 NyxID。
//!
//! 覆盖：第一次提交、区域和地块、草稿（追加、范围、预览、发布、冲突与重放、方块正式编号、
//! 从上传应用操作）、时间线和快照（`/api/v1` 与公开投影）、区块与资源（Range、类型白名单）、
//! 管理接口、限流，以及越权 403/404、范围外 403/409、冲突 409、过大 413、令牌无效 404。

mod timeline_support;

use std::io::Write as _;

use axum::http::{header, Method, StatusCode};
use mongodb::bson::doc;
use serde_json::{json, Value};
use timeline_support::{
    decode_chunk, glb_check, image_check, scan_glb_check, Payload, TestApp, ORG,
};

const SPACE: &str = "front-hall";

fn draft_path(space: &str, draft: &str) -> String {
    format!("/api/v1/spaces/{space}/drafts/{draft}")
}

fn plot_draft_path(space: &str, plot: &str, draft: &str) -> String {
    format!("/api/v1/spaces/{space}/plots/{plot}/drafts/{draft}")
}

async fn new_draft(app: &TestApp, path: &str) -> String {
    let reply = app.org(Method::POST, path, None).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    reply.body["id"].as_str().unwrap().to_owned()
}

async fn append(app: &TestApp, draft_path: &str, ops: Value) -> timeline_support::Reply {
    app.org(
        Method::POST,
        &format!("{draft_path}/ops"),
        Some(json!({ "ops": ops })),
    )
    .await
}

fn ids(list: &Value, key: &str) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|item| item[key].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn agent_guide_example_creates_a_real_preview_without_layout_or_publication() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    let guide = app.public("/api/agent-guide", None).await;
    assert_eq!(guide.status, StatusCode::OK);
    let text = std::str::from_utf8(&guide.bytes).unwrap();
    let example = text
        .split_once("```json\n")
        .unwrap()
        .1
        .split_once("```")
        .unwrap()
        .0;
    let body: Value = serde_json::from_str(example).unwrap();
    let id = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path = draft_path(SPACE, &id);
    let updated = app
        .org(Method::POST, &format!("{path}/ops"), Some(body))
        .await;
    assert_eq!(updated.status, StatusCode::OK, "{:?}", updated.body);
    assert_eq!(updated.body["rev"], 1);
    let preview = app
        .org(
            Method::POST,
            &format!("{path}/preview"),
            Some(json!({"ttlSeconds":3600})),
        )
        .await;
    assert_eq!(preview.status, StatusCode::CREATED, "{:?}", preview.body);
    let auth = format!("Preview {}", preview.body["token"].as_str().unwrap());
    let view = app.public("/api/public/previews", Some(&auth)).await;
    assert_eq!(view.status, StatusCode::OK);
    assert_eq!(
        view.body["entities"][0]["body"]["shape"]["size"],
        json!([1.0, 1.0, 1.0])
    );
    assert_eq!(
        view.body["entities"][0]["body"]["shape"]["material"]["color"],
        json!([255, 0, 0])
    );
    let published = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/snapshot"),
            None,
        )
        .await;
    assert_eq!(published.body["seq"], 1);
    assert!(published.body["entities"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn genesis_layout_drafts_preview_publish_and_reads() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let share_token = app.create_space(SPACE).await;
    let share = format!("Share {share_token}");

    // 第一次提交：_space 锚点 + 通用方块表。
    let snapshot = app
        .public(
            &format!("/api/public/spaces/{SPACE}/snapshot?seq=1"),
            Some(&share),
        )
        .await;
    assert_eq!(snapshot.status, StatusCode::OK, "{:?}", snapshot.body);
    assert_eq!(snapshot.body["seq"], 1);
    assert_eq!(ids(&snapshot.body["anchors"], "anchorId"), ["_space"]);
    assert_eq!(snapshot.body["palette"]["blocks"][0]["id"], 2);
    assert_eq!(snapshot.body["palette"]["blocks"][0]["name"], "stone");
    assert!(snapshot.body["chunks"].as_array().unwrap().is_empty());
    assert!(snapshot
        .header(header::CACHE_CONTROL)
        .starts_with("private"));

    // 区域和地块写成一次提交。
    let layout = app.define_layout(SPACE).await;
    assert_eq!(layout["seq"], 2);
    let public_space = app
        .public(&format!("/api/public/spaces/{SPACE}"), Some(&share))
        .await;
    assert_eq!(public_space.body["regions"][0]["label"], "前厅");
    assert_eq!(public_space.body["plots"][0]["regionId"], "garden");

    // 实体区草稿：方块、锚点（公开 + 内部）、物件。
    let draft_id = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path = draft_path(SPACE, &draft_id);
    let reply = append(
        &app,
        &path,
        json!([
            {"op": "fill", "box": [0, 0, 0, 4, 1, 4], "block": 2},
            {"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "table", "box": [10, 0, 10, 20, 15, 20], "label": "1号桌", "visibility": "public"}},
            {"op": "createAnchor", "anchor": {"anchorId": "safe", "kind": "zone", "position": [1, 0, 1], "visibility": "internal"}},
            {"op": "placeEntity", "entity": {"entityId": "counter-01", "layer": "ext", "kind": "object", "label": "前台",
                "shape": {"type": "box", "size": [2, 1, 0.6], "transform": {"position": [3, 0, 3]}},
                "bounds": {"min": [2, 0, 2.7], "max": [4, 1, 3.3]}}}
        ]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["rev"], 1);
    assert_eq!(reply.body["opsCount"], 4);
    assert_eq!(reply.body["touched"]["chunks"].as_array().unwrap().len(), 1);

    // 预览：只显示公开锚点；草稿区块走预览专用地址。
    let preview = app
        .org(Method::POST, &format!("{path}/preview"), None)
        .await;
    assert_eq!(preview.status, StatusCode::CREATED, "{:?}", preview.body);
    let token = preview.body["token"].as_str().unwrap().to_owned();
    assert_eq!(token.len(), 43);
    assert!(preview.body["url"]
        .as_str()
        .unwrap()
        .starts_with("https://metaverse.example/preview#t="));
    let preview_auth = format!("Preview {token}");
    let view = app
        .public("/api/public/previews", Some(&preview_auth))
        .await;
    assert_eq!(view.status, StatusCode::OK, "{:?}", view.body);
    assert_eq!(view.header(header::CACHE_CONTROL), "no-store");
    // 快照加空间名称和草稿信息（网站的 PreviewView）。
    assert_eq!(view.body["spaceName"], "测试空间");
    assert_eq!(
        view.body["preview"],
        json!({"draftId": draft_id, "rev": 1, "baseSeq": view.body["seq"], "scope": "physical",
               "expiresAt": preview.body["expiresAt"]})
    );
    assert_eq!(view.body["spaceId"], SPACE);
    assert_eq!(ids(&view.body["anchors"], "anchorId"), ["_space", "t1"]);
    assert_eq!(ids(&view.body["entities"], "id"), ["counter-01"]);
    let draft_chunk = view.body["chunks"][0]["hash"].as_str().unwrap().to_owned();
    let chunk = app
        .public(
            &format!("/api/public/previews/chunks/{draft_chunk}"),
            Some(&preview_auth),
        )
        .await;
    assert_eq!(chunk.status, StatusCode::OK);
    let cells = decode_chunk(&chunk.bytes, &draft_chunk);
    assert_eq!(cells[0], 2);
    // 草稿区块还没发布：公开区块地址读不到。
    assert_eq!(
        app.public(&format!("/api/public/chunks/{draft_chunk}.bin"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // 令牌无效：404。
    for bad in [
        format!("Preview {}", "A".repeat(43)),
        "Preview short".to_owned(),
        format!("Share {token}"),
    ] {
        let reply = app.public("/api/public/previews", Some(&bad)).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{bad}");
        assert_eq!(reply.header(header::CACHE_CONTROL), "no-store");
    }

    // 不允许发布已经过期的预览修订，时间线与草稿保持不变。
    let stale = app
        .org(
            Method::POST,
            &format!("{path}/publish"),
            Some(json!({"message": "过期预览", "rev": 0})),
        )
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    assert_eq!(stale.body["code"], "draft_rev_changed");
    assert_eq!(app.org(Method::GET, &path, None).await.body["rev"], 1);

    // 发布：seq 3；预览令牌立即失效。
    let published = app
        .org(
            Method::POST,
            &format!("{path}/publish"),
            Some(json!({"message": "布置前台", "rev": 1})),
        )
        .await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.body);
    assert_eq!(published.body["seq"], 3);
    assert_eq!(
        app.public("/api/public/previews", Some(&preview_auth))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // 已发布的草稿不能再发布或追加。
    let again = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    let more = append(
        &app,
        &path,
        json!([{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}]),
    )
    .await;
    assert_eq!(more.status, StatusCode::CONFLICT);

    // 公开快照：公开锚点、物件、区块；区块已发布。
    let snapshot = app
        .public(
            &format!("/api/public/spaces/{SPACE}/snapshot?seq=3"),
            Some(&share),
        )
        .await;
    assert_eq!(snapshot.status, StatusCode::OK);
    assert_eq!(ids(&snapshot.body["anchors"], "anchorId"), ["_space", "t1"]);
    assert_eq!(snapshot.body["entities"][0]["body"]["label"], "前台");
    assert_eq!(snapshot.body["regions"][0]["id"], "hall");
    let chunk_hash = snapshot.body["chunks"][0]["hash"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(chunk_hash, draft_chunk);
    assert_eq!(snapshot.body["chunks"][0]["layer"], "ext");
    let chunk = app
        .public(&format!("/api/public/chunks/{chunk_hash}.bin"), None)
        .await;
    assert_eq!(chunk.status, StatusCode::OK);
    assert_eq!(
        chunk.header(header::CACHE_CONTROL),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(chunk.header(header::X_CONTENT_TYPE_OPTIONS), "nosniff");
    decode_chunk(&chunk.bytes, &chunk_hash);
    // 第二次从进程内缓存读，结果一样。
    let cached = app
        .public(
            &format!("/api/public/spaces/{SPACE}/snapshot?seq=3"),
            Some(&share),
        )
        .await;
    assert_eq!(cached.body, snapshot.body);
    // 凭链接查看的空间：没带令牌一律 404，且不缓存。
    let denied = app
        .public(&format!("/api/public/spaces/{SPACE}/snapshot?seq=3"), None)
        .await;
    assert_eq!(denied.status, StatusCode::NOT_FOUND);
    assert_eq!(denied.header(header::CACHE_CONTROL), "no-store");
    // 超过最新版本：404；seq 和 at 都没给：422。
    assert_eq!(
        app.public(
            &format!("/api/public/spaces/{SPACE}/snapshot?seq=9"),
            Some(&share)
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.public(
            &format!("/api/public/spaces/{SPACE}/snapshot"),
            Some(&share)
        )
        .await
        .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    // /api/v1 快照含内部锚点和发布者信息。
    let internal = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/snapshot"),
            None,
        )
        .await;
    assert_eq!(internal.status, StatusCode::OK);
    assert_eq!(internal.body["seq"], 3);
    assert_eq!(
        ids(&internal.body["anchors"], "anchorId"),
        ["_space", "safe", "t1"]
    );

    // 时间线：/api/v1 带发布者；公开投影只有类别、不出现内部锚点。
    let timeline = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/timeline"),
            None,
        )
        .await;
    assert_eq!(timeline.status, StatusCode::OK);
    let items = timeline.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[2]["actor"]["sub"], ORG);
    assert_eq!(items[2]["actor"]["scope"], "physical");
    assert_eq!(items[2]["draftId"], draft_id.as_str());
    assert!(items[0]["paletteHash"].is_string());
    assert!(items[1]["regionsHash"].is_string());
    assert!(timeline.body["nextAfter"].is_null());
    let public_timeline = app
        .public(
            &format!("/api/public/spaces/{SPACE}/timeline"),
            Some(&share),
        )
        .await;
    assert_eq!(public_timeline.status, StatusCode::OK);
    let items = public_timeline.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[2]["actor"], json!({"kind": "physical"}));
    assert_eq!(items[0]["actor"], json!({"kind": "admin"}));
    assert_eq!(ids(&items[2]["changedAnchors"], "id"), ["t1"]);
    for hidden in ["id", "draftId", "author", "opsRef"] {
        assert!(items[2].get(hidden).is_none(), "{hidden}");
    }
    // 分页。
    let page = app
        .public(
            &format!("/api/public/spaces/{SPACE}/timeline?limit=2"),
            Some(&share),
        )
        .await;
    assert_eq!(page.body["items"].as_array().unwrap().len(), 2);
    assert_eq!(page.body["nextAfter"], "2");
    let page = app
        .public(
            &format!("/api/public/spaces/{SPACE}/timeline?limit=2&after=2"),
            Some(&share),
        )
        .await;
    assert_eq!(page.body["items"][0]["seq"], 3);
    assert!(page.body["nextAfter"].is_null());

    // ?at= 换算成 seq 后 302 跳转，不缓存。
    let at = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/timeline"),
            None,
        )
        .await
        .body["items"][1]["at"]
        .as_str()
        .unwrap()
        .to_owned();
    let redirect = app
        .public(
            &format!("/api/public/spaces/{SPACE}/snapshot?at={at}"),
            Some(&share),
        )
        .await;
    assert_eq!(redirect.status, StatusCode::FOUND);
    assert_eq!(redirect.header(header::CACHE_CONTROL), "no-store");
    assert_eq!(
        redirect.header(header::LOCATION),
        format!("/api/public/spaces/{SPACE}/snapshot?seq=2")
    );
    let early = app
        .public(
            &format!("/api/public/spaces/{SPACE}/snapshot?at=2000-01-01T00:00:00Z"),
            Some(&share),
        )
        .await;
    assert!(early.header(header::LOCATION).ends_with("/snapshot?seq=0"));

    // 区域内容（分层文字）。
    let content = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/regions/hall/content"),
            None,
        )
        .await;
    assert_eq!(content.status, StatusCode::OK, "{:?}", content.body);
    let text = content.body["text"].as_str().unwrap();
    assert!(text.contains("实体区"), "{text}");
    assert!(text.contains("counter-01"), "{text}");
    assert!(text.contains("stone(2) 16 格"), "{text}");
    assert!(text.contains("safe"), "{text}");
    assert_eq!(
        app.org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/regions/nowhere/content"),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    // 命令行 pull：/api/v1 区块；不属于这个空间的哈希 404。
    let chunk = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/chunks/{chunk_hash}"),
            None,
        )
        .await;
    assert_eq!(chunk.status, StatusCode::OK);
    decode_chunk(&chunk.bytes, &chunk_hash);
    assert_eq!(
        app.org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/chunks/{}", "0".repeat(64)),
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    // 预览按草稿状态里的可见级别：把内部锚点改成公开的草稿，预览里能看到它。
    let reveal = draft_path(
        SPACE,
        &new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await,
    );
    let reply = append(
        &app,
        &reveal,
        json!([{"op": "updateAnchor", "anchorId": "safe", "visibility": "public"}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let token = app
        .org(
            Method::POST,
            &format!("{reveal}/preview"),
            Some(json!({"ttlSeconds": 600})),
        )
        .await
        .body["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let view = app
        .public("/api/public/previews", Some(&format!("Preview {token}")))
        .await;
    assert_eq!(
        ids(&view.body["anchors"], "anchorId"),
        ["_space", "safe", "t1"]
    );
    // 预览有效期超出范围：422。
    let reply = app
        .org(
            Method::POST,
            &format!("{reveal}/preview"),
            Some(json!({"ttlSeconds": 999999})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    // 草稿再追加操作后 rev 变了，旧预览令牌失效。
    append(
        &app,
        &reveal,
        json!([{"op": "updateAnchor", "anchorId": "t1", "label": "一号桌"}]),
    )
    .await;
    assert_eq!(
        app.public("/api/public/previews", Some(&format!("Preview {token}")))
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // 别人看不到：/api/v1 一律 404。
    for path in [
        format!("/api/v1/spaces/{SPACE}/timeline"),
        format!("/api/v1/spaces/{SPACE}/snapshot"),
        format!("/api/v1/spaces/{SPACE}/chunks/{chunk_hash}"),
        draft_path(SPACE, &draft_id),
    ] {
        let reply = app
            .v1(
                Method::GET,
                &path,
                "mallory",
                Some("stranger-token"),
                Payload::None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn scope_rules_access_levels_and_size_limits() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;

    // 地块草稿：地块内可以，越出地块 403 且整批不生效。
    let plot_draft = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/plots/p1/drafts")).await;
    let plot_path = plot_draft_path(SPACE, "p1", &plot_draft);
    let ok = append(
        &app,
        &plot_path,
        json!([{"op": "fill", "box": [200, 0, 0, 210, 1, 10], "block": 3}]),
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK, "{:?}", ok.body);
    let out = append(
        &app,
        &plot_path,
        json!([
            {"op": "fill", "box": [200, 0, 0, 201, 1, 1], "block": 4},
            {"op": "createAnchor", "anchor": {"anchorId": "gate", "kind": "door", "box": [260, 0, 60, 270, 10, 70], "visibility": "public"}}
        ]),
    )
    .await;
    assert_eq!(out.status, StatusCode::FORBIDDEN, "{:?}", out.body);
    assert_eq!(out.body["code"], "out_of_scope");
    assert!(out.body["detail"].as_str().unwrap().contains("第 1 条"));
    let unchanged = app.org(Method::GET, &plot_path, None).await;
    assert_eq!(unchanged.body["rev"], 1);
    assert_eq!(unchanged.body["opsCount"], 1);
    // 地块路径下不能动空间级锚点。
    let space_anchor = append(
        &app,
        &plot_path,
        json!([{"op": "updateAnchor", "anchorId": "_space", "label": "营业中"}]),
    )
    .await;
    assert_eq!(space_anchor.status, StatusCode::FORBIDDEN);

    // 草稿只能走创建时的范围：经实体区路径或别的地块路径访问一律 404。
    for wrong in [
        draft_path(SPACE, &plot_draft),
        plot_draft_path(SPACE, "p2", &plot_draft),
    ] {
        let reply = app.org(Method::GET, &wrong, None).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{wrong}");
        let reply = append(
            &app,
            &wrong,
            json!([{"op": "fill", "box": [200, 0, 0, 201, 1, 1], "block": 2}]),
        )
        .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{wrong}");
    }
    // 不存在的地块不能建草稿。
    let reply = app
        .org(
            Method::POST,
            &format!("/api/v1/spaces/{SPACE}/plots/p9/drafts"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // 实体区草稿不能改虚拟区。
    let physical = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let physical_path = draft_path(SPACE, &physical);
    let reply = append(
        &app,
        &physical_path,
        json!([{"op": "fill", "box": [250, 0, 0, 251, 1, 1], "block": 2}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    // 操作不合法：422；方块不存在：422。
    let reply = append(&app, &physical_path, json!([{"op": "explode"}])).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "invalid_op");
    let reply = append(
        &app,
        &physical_path,
        json!([{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 999}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    // 引用了没登记的模型：422。
    let reply = append(
        &app,
        &physical_path,
        json!([{"op": "placeEntity", "entity": {"entityId": "vase", "layer": "ext", "kind": "object",
            "assetHash": "a".repeat(64), "bounds": {"min": [1, 0, 1], "max": [1.2, 0.4, 1.2]}}}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "unknown_asset");
    // rev 不一致：409。
    let reply = app
        .org(
            Method::POST,
            &format!("{physical_path}/ops"),
            Some(json!({"ops": [{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}], "rev": 7})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);

    // 超过 200 条或 1MB：413，并提示改走上传。
    let many: Vec<Value> = (0..201)
        .map(|i| json!({"op": "fill", "box": [i, 0, 0, i + 1, 1, 1], "block": 2}))
        .collect();
    let reply = append(&app, &physical_path, Value::Array(many)).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(reply.body["detail"]
        .as_str()
        .unwrap()
        .contains("ops-from-upload"));
    let label = "长".repeat(400_000);
    let reply = append(
        &app,
        &physical_path,
        json!([{"op": "updateAnchor", "anchorId": "_space", "label": label}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(reply.body["detail"].as_str().unwrap().contains("1MB"));

    // 组织成员只读：能看草稿，不能写（403）；查不到的人 404。
    let reply = app
        .v1(
            Method::GET,
            &physical_path,
            "bob",
            Some("member-token"),
            Payload::None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    for (method, path) in [
        (Method::POST, format!("/api/v1/spaces/{SPACE}/drafts")),
        (Method::POST, format!("{physical_path}/publish")),
        (Method::POST, format!("{physical_path}/preview")),
        (Method::DELETE, physical_path.clone()),
    ] {
        let reply = app
            .v1(
                method.clone(),
                &path,
                "bob",
                Some("member-token"),
                Payload::None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
        let reply = app
            .v1(
                method.clone(),
                &path,
                "eve",
                Some("stranger-token"),
                Payload::None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{method} {path}");
    }
    // 组织 admin 可以写，发布时 author 记创建者。
    let reply = app
        .v1(
            Method::POST,
            &format!("{plot_path}/publish"),
            "alice",
            Some("admin-token"),
            Payload::Json(json!({"message": "地块里铺地"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let commit = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": reply.body["seq"].as_i64().unwrap()})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        commit
            .get_document("actor")
            .unwrap()
            .get_str("sub")
            .unwrap(),
        "alice"
    );
    assert_eq!(
        commit
            .get_document("actor")
            .unwrap()
            .get_str("scope")
            .unwrap(),
        "plot:p1"
    );
    assert_eq!(
        commit
            .get_document("actor")
            .unwrap()
            .get_str("kind")
            .unwrap(),
        "plot"
    );
    assert_eq!(
        commit
            .get_document("author")
            .unwrap()
            .get_str("sub")
            .unwrap(),
        ORG
    );

    // 空草稿不能发布。
    let empty = draft_path(
        SPACE,
        &new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await,
    );
    let reply = app
        .org(Method::POST, &format!("{empty}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);

    // 丢弃草稿：之后 404。
    let reply = app.org(Method::DELETE, &physical_path, None).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(
        app.org(Method::GET, &physical_path, None).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn conflicts_overlay_replay_and_final_block_ids() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let drafts = format!("/api/v1/spaces/{SPACE}/drafts");
    let a = draft_path(SPACE, &new_draft(&app, &drafts).await);
    let b = draft_path(SPACE, &new_draft(&app, &drafts).await);
    let c = draft_path(SPACE, &new_draft(&app, &drafts).await);
    // A 和 B 改同一个区块，C 改另一个区块。
    assert_eq!(
        append(
            &app,
            &a,
            json!([{"op": "fill", "box": [0, 0, 0, 2, 1, 2], "block": 2}])
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        append(&app, &b, json!([
            {"op": "addBlock", "block": {"name": "brick-b", "kind": "solid", "color": [200, 50, 40]}},
            {"op": "fill", "box": [1, 0, 1, 3, 1, 3], "block": "brick-b"}
        ]))
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        append(&app, &c, json!([
            {"op": "addBlock", "block": {"name": "tile-c", "kind": "solid", "color": [240, 240, 240]}},
            {"op": "fill", "box": [64, 0, 64, 66, 1, 66], "block": "tile-c"}
        ]))
        .await
        .status,
        StatusCode::OK
    );
    let published = app.org(Method::POST, &format!("{a}/publish"), None).await;
    assert_eq!(published.status, StatusCode::OK);
    // B 与 A 冲突：409 列出冲突的键。
    let conflict = app.org(Method::POST, &format!("{b}/publish"), None).await;
    assert_eq!(conflict.status, StatusCode::CONFLICT, "{:?}", conflict.body);
    assert_eq!(conflict.body["code"], "draft_conflict");
    assert_eq!(conflict.body["conflicts"], json!(["chunk:ext:0,0,0"]));
    assert_eq!(conflict.body["baseSeq"], 2);
    assert_eq!(conflict.body["headSeq"], 3);
    assert_eq!(
        conflict.header(header::CONTENT_TYPE),
        "application/problem+json"
    );
    // C 没有交集：直接叠加发布；新增方块拿到正式编号（方块表末尾 + 1）。
    let published = app.org(Method::POST, &format!("{c}/publish"), None).await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.body);
    assert_eq!(published.body["seq"], 4);
    // B 在最新版本上重放：brick-b 的编号排在 tile-c 之后。
    let replayed = app
        .org(
            Method::POST,
            &format!("{b}/publish"),
            Some(json!({"replay": true, "message": "重放"})),
        )
        .await;
    assert_eq!(replayed.status, StatusCode::OK, "{:?}", replayed.body);
    assert_eq!(replayed.body["seq"], 5);

    let snapshot = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/snapshot"),
            None,
        )
        .await;
    let blocks = snapshot.body["palette"]["blocks"].as_array().unwrap();
    let id_of = |name: &str| {
        blocks
            .iter()
            .find(|b| b["name"] == name)
            .map(|b| b["id"].as_u64().unwrap())
            .unwrap()
    };
    let stone = id_of("stone");
    let tile = id_of("tile-c");
    let brick = id_of("brick-b");
    assert_eq!(stone, 2);
    assert_eq!(tile, blocks.len() as u64);
    assert_eq!(brick, tile + 1);
    // 区块内容用的是正式编号：A 的石头被 B 在重叠处覆盖成砖。
    let chunk_of = |cx: i64, cz: i64| {
        snapshot.body["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["cx"] == cx && c["cz"] == cz)
            .map(|c| c["hash"].as_str().unwrap().to_owned())
            .unwrap()
    };
    let origin = chunk_of(0, 0);
    let cells = decode_chunk(
        &app.org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/chunks/{origin}"),
            None,
        )
        .await
        .bytes,
        &origin,
    );
    assert_eq!(u64::from(cells[0]), stone);
    assert_eq!(u64::from(cells[1 + 32]), brick);
    assert_eq!(u64::from(cells[2 + 32 * 2]), brick);
    let far = chunk_of(2, 2);
    let cells = decode_chunk(
        &app.org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/chunks/{far}"),
            None,
        )
        .await
        .bytes,
        &far,
    );
    assert_eq!(u64::from(cells[0]), tile);

    // 草稿基于旧版本（命令行按拉取时的版本建草稿）：baseSeq 不能超过最新版本。
    let reply = app
        .org(Method::POST, &drafts, Some(json!({"baseSeq": 99})))
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let old = draft_path(
        SPACE,
        app.org(Method::POST, &drafts, Some(json!({"baseSeq": 2})))
            .await
            .body["id"]
            .as_str()
            .unwrap(),
    );
    append(&app, &old, json!([{"op": "createAnchor", "anchor": {"anchorId": "t9", "kind": "table", "box": [100, 0, 100, 110, 10, 110], "visibility": "public"}}])).await;
    let reply = app.org(Method::POST, &format!("{old}/publish"), None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);

    // 发布时按最新的区域重新校验：区域缩小后，旧草稿的操作越界返回 409。
    let late = draft_path(SPACE, &new_draft(&app, &drafts).await);
    append(
        &app,
        &late,
        json!([{"op": "fill", "box": [150, 0, 150, 151, 1, 151], "block": 2}]),
    )
    .await;
    let reply = app
        .org(
            Method::PUT,
            &format!("/api/v1/admin/spaces/{SPACE}/layout"),
            Some(json!({"regions": [{"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 100, 60, 100]]}]})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = app
        .org(Method::POST, &format!("{late}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.body["code"], "out_of_scope");
}

#[tokio::test]
async fn ops_from_upload_runs_in_process_and_publishes_with_ops_ref() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let draft_id = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path = draft_path(SPACE, &draft_id);
    // 500 条操作（超过单次 200 条），gzip 压缩的 NDJSON。
    let mut ndjson = String::new();
    for i in 0..500 {
        ndjson.push_str(
            &json!({"op": "fill", "box": [i % 100, i / 100, 0, i % 100 + 1, i / 100 + 1, 1], "block": 2})
                .to_string(),
        );
        ndjson.push('\n');
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(ndjson.as_bytes()).unwrap();
    let (upload_id, hash) = app.put_ops_upload(SPACE, &encoder.finish().unwrap()).await;

    // 请求体必须二选一。
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    // 别的空间的上传、不存在的上传：404。
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({"uploadId": "up_nothing"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({"uploadId": upload_id})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    let job_id = reply.body["jobId"].as_str().unwrap().to_owned();
    let job = app.wait_job(&job_id).await;
    assert_eq!(job.get_str("status").unwrap(), "done", "{job:?}");
    assert_eq!(job.get_str("kind").unwrap(), "ops_from_upload");
    assert_eq!(
        job.get_document("actor").unwrap().get_str("sub").unwrap(),
        ORG
    );
    let result = job.get_document("result").unwrap();
    assert_eq!(
        result
            .get_i64("opsApplied")
            .or(result.get_i32("opsApplied").map(i64::from))
            .unwrap(),
        500
    );
    let draft = app.org(Method::GET, &path, None).await;
    assert_eq!(draft.body["opsCount"], 500);
    assert_eq!(draft.body["opsRefs"][0]["assetHash"], hash.as_str());

    // 发布：提交里的操作只放资源哈希。
    let published = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.body);
    let commit = app
        .collection("commits")
        .find_one(doc! {"spaceId": SPACE, "seq": 3})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(commit.get_str("opsRef").unwrap(), hash);
    assert!(commit.get("ops").is_none());

    // 文件里有不合法的操作：任务失败，草稿不变。
    let second = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let second_path = draft_path(SPACE, &second);
    let bad = b"{\"op\":\"fill\",\"box\":[0,0,0,1,1,1],\"block\":2}\n{\"op\":\"fill\",\"box\":[300,0,0,301,1,1],\"block\":2}\n";
    let (_, bad_hash) = app.put_ops_upload(SPACE, bad).await;
    let reply = app
        .org(
            Method::POST,
            &format!("{second_path}/ops-from-upload"),
            Some(json!({"assetHash": bad_hash})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
    let job = app.wait_job(reply.body["jobId"].as_str().unwrap()).await;
    assert_eq!(job.get_str("status").unwrap(), "failed");
    // 执行器写的错误带类别：内容不合规，不重试。
    let error = job.get_document("lastError").unwrap();
    assert_eq!(error.get_str("class").unwrap(), "content");
    assert!(
        error.get_str("message").unwrap().contains("超出"),
        "{job:?}"
    );
    assert_eq!(
        app.org(Method::GET, &second_path, None).await.body["rev"],
        0
    );
}

#[tokio::test]
async fn ops_from_upload_rejects_oversized_or_missing_files_before_queueing() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let path = draft_path(
        SPACE,
        &new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await,
    );
    let ops = json!({"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}).to_string();
    // 调小上限之前传的大文件：资源长度超过 64MiB（只改登记的长度模拟），202 之前就 413。
    let (big_upload, big_hash) = app.put_ops_upload(SPACE, ops.as_bytes()).await;
    app.collection("assets.files")
        .update_one(
            doc! {"filename": &big_hash},
            doc! {"$set": {"length": (64_i64 << 20) + 1}},
        )
        .await
        .unwrap();
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({"uploadId": big_upload})),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{:?}",
        reply.body
    );
    assert_eq!(reply.body["code"], "ops_file_too_large");
    // 资源已被清理：404。
    app.collection("assets.files")
        .delete_one(doc! {"filename": &big_hash})
        .await
        .unwrap();
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({"assetHash": big_hash})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{:?}", reply.body);
    // 两次都没有建任务。
    assert_eq!(
        app.collection("jobs")
            .count_documents(doc! {"kind": "ops_from_upload"})
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn plot_ops_from_upload_job_is_visible_through_its_plot_path_with_progress() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let plot_draft = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/plots/p1/drafts")).await;
    let plot_path = plot_draft_path(SPACE, "p1", &plot_draft);
    let mut ndjson = String::new();
    for i in 0..3 {
        ndjson.push_str(
            &json!({"op": "fill", "box": [200 + i, 0, 0, 201 + i, 1, 1], "block": 2}).to_string(),
        );
        ndjson.push('\n');
    }
    let (upload_id, _) = app.put_ops_upload(SPACE, ndjson.as_bytes()).await;
    let reply = app
        .org(
            Method::POST,
            &format!("{plot_path}/ops-from-upload"),
            Some(json!({"uploadId": upload_id})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    let job_id = reply.body["jobId"].as_str().unwrap().to_owned();
    let stored = app.wait_job(&job_id).await;
    assert_eq!(stored.get_str("status").unwrap(), "done", "{stored:?}");
    // 任务记录带草稿的范围，和 create_job 存的格式相同。
    assert_eq!(stored.get_str("scope").unwrap(), "plot:p1");

    // 地块路径查得到，带进度。
    let job = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/plots/p1/jobs/{job_id}"),
            None,
        )
        .await;
    assert_eq!(job.status, StatusCode::OK, "{:?}", job.body);
    assert_eq!(job.body["kind"], "ops_from_upload");
    assert_eq!(job.body["scope"], "plot:p1");
    assert_eq!(
        job.body["progress"],
        json!({"opsApplied": 3, "opsTotal": 3})
    );
    // 地块草稿的预览带范围 plot:p1 和应用后的 rev。
    let preview = app
        .org(Method::POST, &format!("{plot_path}/preview"), None)
        .await;
    assert_eq!(preview.status, StatusCode::CREATED, "{:?}", preview.body);
    let view = app
        .public(
            "/api/public/previews",
            Some(&format!(
                "Preview {}",
                preview.body["token"].as_str().unwrap()
            )),
        )
        .await;
    assert_eq!(view.status, StatusCode::OK, "{:?}", view.body);
    assert_eq!(view.body["preview"]["scope"], "plot:p1");
    assert_eq!(view.body["preview"]["draftId"], plot_draft.as_str());
    assert_eq!(view.body["preview"]["rev"], 1);
    let list = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/plots/p1/jobs"),
            None,
        )
        .await;
    assert_eq!(list.status, StatusCode::OK);
    assert!(ids(&list.body["items"], "id").contains(&job_id));
    // 实体区路径看得到全部任务。
    let job = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/jobs/{job_id}"),
            None,
        )
        .await;
    assert_eq!(job.status, StatusCode::OK);

    // 实体区草稿的任务经地块路径查不到。
    let physical = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let ops = json!({"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}).to_string();
    let (upload_id, _) = app.put_ops_upload(SPACE, ops.as_bytes()).await;
    let reply = app
        .org(
            Method::POST,
            &format!("{}/ops-from-upload", draft_path(SPACE, &physical)),
            Some(json!({"uploadId": upload_id})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::ACCEPTED, "{:?}", reply.body);
    let physical_job = reply.body["jobId"].as_str().unwrap().to_owned();
    let stored = app.wait_job(&physical_job).await;
    assert_eq!(stored.get_str("scope").unwrap(), "physical");
    let reply = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/plots/p1/jobs/{physical_job}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let list = app
        .org(
            Method::GET,
            &format!("/api/v1/spaces/{SPACE}/plots/p1/jobs"),
            None,
        )
        .await;
    assert!(!ids(&list.body["items"], "id").contains(&physical_job));
}

#[tokio::test]
async fn admin_settings_tokens_and_deletion() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let token = app.create_space(SPACE).await;
    let space_path = format!("/api/v1/admin/spaces/{SPACE}");
    // 改成公开必须确认。
    let reply = app
        .org(
            Method::PATCH,
            &space_path,
            Some(json!({"visibility": "public"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    assert_eq!(reply.body["code"], "confirmation_required");
    let reply = app
        .org(
            Method::PATCH,
            &space_path,
            Some(json!({"visibility": "public", "confirmPublicHistory": true, "name": "公司前厅"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["name"], "公司前厅");
    let public = app
        .public(&format!("/api/public/spaces/{SPACE}/timeline"), None)
        .await;
    assert_eq!(public.status, StatusCode::OK);
    assert!(public.header(header::CACHE_CONTROL).starts_with("public"));
    // 改回凭链接查看。
    let reply = app
        .org(
            Method::PATCH,
            &space_path,
            Some(json!({"visibility": "unlisted"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    // 轮换分享令牌：旧令牌失效，新令牌可用，原文只返回一次。
    let reply = app
        .org(Method::POST, &format!("{space_path}/share-tokens"), None)
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert_eq!(reply.header(header::CACHE_CONTROL), "no-store");
    let fresh = reply.body["token"].as_str().unwrap().to_owned();
    let old_share = format!("Share {token}");
    let new_share = format!("Share {fresh}");
    assert_eq!(
        app.public(
            &format!("/api/public/spaces/{SPACE}/timeline"),
            Some(&old_share)
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.public(
            &format!("/api/public/spaces/{SPACE}/timeline"),
            Some(&new_share)
        )
        .await
        .status,
        StatusCode::OK
    );
    // 区域不合法：422；baseSeq 不一致：409。
    let reply = app
        .org(
            Method::PUT,
            &format!("{space_path}/layout"),
            Some(json!({"regions": [{"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 10, 10, 10]]}],
                        "plots": [{"id": "p1", "regionId": "hall", "boxes": [[0, 0, 0, 5, 5, 5]]}]})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let reply = app
        .org(
            Method::PUT,
            &format!("{space_path}/layout"),
            Some(json!({"regions": [], "baseSeq": 0})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    // 成员只读：管理接口 403；陌生人 404。
    for (method, path, body) in [
        (
            Method::PATCH,
            space_path.clone(),
            Some(json!({"name": "x"})),
        ),
        (Method::POST, format!("{space_path}/share-tokens"), None),
        (
            Method::PUT,
            format!("{space_path}/layout"),
            Some(json!({"regions": []})),
        ),
        (
            Method::DELETE,
            format!("{space_path}?confirm={SPACE}"),
            None,
        ),
    ] {
        let payload = || body.clone().map_or(Payload::None, Payload::Json);
        let reply = app
            .v1(
                method.clone(),
                &path,
                "bob",
                Some("member-token"),
                payload(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
        let reply = app
            .v1(
                method.clone(),
                &path,
                "eve",
                Some("stranger-token"),
                payload(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{method} {path}");
    }
    // 删除空间要确认。
    let reply = app.org(Method::DELETE, &space_path, None).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let reply = app
        .org(
            Method::DELETE,
            &format!("{space_path}?confirm={SPACE}"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(
        app.org(Method::GET, &format!("/api/v1/spaces/{SPACE}"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.collection("commits")
            .count_documents(doc! {"spaceId": SPACE})
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn public_assets_chunks_and_ranges() {
    // 缓存 1 MiB：单项上限 128 KiB，小资源走缓存，大资源按数据块流式读出。
    let Some(app) = TestApp::start_with_env(&[("PUBLIC_CACHE_BYTES", "1048576")]).await else {
        return;
    };
    app.create_space(SPACE).await;
    let png: Vec<u8> = b"\x89PNG\r\n\x1a\n"
        .iter()
        .copied()
        .chain(0..200u8)
        .collect();
    let hash = app.put_asset(&png, "image/png", "texture").await;
    let html = app
        .put_asset(b"<script>alert(1)</script>", "text/html", "texture")
        .await;
    let path = format!("/api/public/assets/{hash}.bin");
    // 没登记在 assetRefs 里：404。
    assert_eq!(app.public(&path, None).await.status, StatusCode::NOT_FOUND);
    app.register_asset_ref(SPACE, &hash).await;
    app.register_asset_ref(SPACE, &html).await;
    let reply = app.public(&path, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.bytes, png);
    assert_eq!(reply.header(header::CONTENT_TYPE), "image/png");
    assert_eq!(reply.header(header::X_CONTENT_TYPE_OPTIONS), "nosniff");
    assert_eq!(
        reply.header(header::CACHE_CONTROL),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(reply.header(header::ACCEPT_RANGES), "bytes");
    // 分段下载（第二次从缓存读）。
    let reply = app
        .send(Method::GET, &path, &[("range", "bytes=0-3")], Payload::None)
        .await;
    assert_eq!(reply.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(reply.bytes, &png[..4]);
    assert_eq!(
        reply.header(header::CONTENT_RANGE),
        format!("bytes 0-3/{}", png.len())
    );
    let reply = app
        .send(
            Method::GET,
            &path,
            &[("range", "bytes=9999-")],
            Payload::None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(reply.header(header::CACHE_CONTROL), "no-store");
    // 声明的类型不在白名单里：一律 application/octet-stream。
    let reply = app
        .public(&format!("/api/public/assets/{html}.bin"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.header(header::CONTENT_TYPE),
        "application/octet-stream"
    );
    // 大资源（超过单项缓存上限）按数据块流式读出，分段也正确。
    let big: Vec<u8> = (0..(600 * 1024)).map(|i| (i % 251) as u8).collect();
    let big_hash = app.put_asset(&big, "model/gltf-binary", "web_model").await;
    app.register_asset_ref(SPACE, &big_hash).await;
    let big_path = format!("/api/public/assets/{big_hash}.bin");
    let reply = app
        .send(
            Method::GET,
            &big_path,
            &[("range", "bytes=262140-262150")],
            Payload::None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(reply.bytes, &big[262_140..=262_150]);
    let reply = app.public(&big_path, None).await;
    assert_eq!(reply.bytes.len(), big.len());
    assert_eq!(reply.header(header::CONTENT_TYPE), "model/gltf-binary");
    // 路径格式不对：404。
    for bad in [
        format!("/api/public/assets/{hash}"),
        "/api/public/assets/XYZ.bin".to_owned(),
        format!("/api/public/chunks/{hash}"),
    ] {
        assert_eq!(
            app.public(&bad, None).await.status,
            StatusCode::NOT_FOUND,
            "{bad}"
        );
    }
    // 没有发布标记的区块：404。
    let chunk = metaverse_core::chunk::Chunk::empty();
    let mut chunk = chunk;
    chunk.set(1, 1, 1, 2).unwrap();
    let chunk_hash = chunk.hash();
    app.collection("chunks")
        .insert_one(doc! {"_id": &chunk_hash, "format": 1,
            "data": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: chunk.compress() }})
        .await
        .unwrap();
    let chunk_path = format!("/api/public/chunks/{chunk_hash}.bin");
    assert_eq!(
        app.public(&chunk_path, None).await.status,
        StatusCode::NOT_FOUND
    );
    app.collection("chunks")
        .update_one(
            doc! {"_id": &chunk_hash},
            doc! {"$set": {"publishedAt": "2026-01-01T00:00:00.000Z"}},
        )
        .await
        .unwrap();
    let reply = app.public(&chunk_path, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    decode_chunk(&reply.bytes, &chunk_hash);
}

#[tokio::test]
async fn keyframes_and_job_commits_without_keyframes() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    // 写 52 次区域提交（seq 2..=53）；seq 50 存关键帧。
    for i in 0..52 {
        let reply = app
            .org(
                Method::PUT,
                &format!("/api/v1/admin/spaces/{SPACE}/layout"),
                Some(json!({"regions": [{"id": format!("r{i}"), "kind": "physical", "boxes": [[0, 0, 0, 10 + i, 10, 10]]}]})),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    let keyframes: Vec<i64> = {
        let mut cursor = app
            .collection("commits")
            .find(doc! {"spaceId": SPACE, "keyframe": {"$type": "string"}})
            .await
            .unwrap();
        let mut seqs = Vec::new();
        while cursor.advance().await.unwrap() {
            let document = cursor.deserialize_current().unwrap();
            seqs.push(document.get_i64("seq").unwrap());
        }
        seqs
    };
    assert_eq!(keyframes, [50]);
    // 处理服务写的提交不带关键帧：直接插入一次提交，推进 head。
    let head = app
        .collection("spaces")
        .find_one(doc! {"_id": SPACE})
        .await
        .unwrap()
        .unwrap()
        .get_document("head")
        .unwrap()
        .clone();
    assert_eq!(head.get_i64("seq").unwrap(), 53);
    let at = head.get_str("at").unwrap().to_owned();
    app.collection("commits")
        .insert_one(doc! {
            "_id": "job-commit", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "seq": 54, "at": &at,
            "actor": {"sub": ORG, "nyxServiceId": "svc", "scope": "physical", "kind": "job"},
            "message": "重建", "changedChunks": [], "changedEntities": [], "changedAnchors": [],
            "jobId": "job-1",
        })
        .await
        .unwrap();
    app.collection("spaces")
        .update_one(
            doc! {"_id": SPACE},
            doc! {"$set": {"head": {"seq": 54, "at": &at, "commitId": "job-commit"}}},
        )
        .await
        .unwrap();
    // 各个版本的快照：从关键帧或从头叠加，区域都对。
    for (seq, expected) in [(49, "r47"), (50, "r48"), (53, "r51"), (54, "r51")] {
        let reply = app
            .org(
                Method::GET,
                &format!("/api/v1/spaces/{SPACE}/snapshot?seq={seq}"),
                None,
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{seq}");
        assert_eq!(reply.body["regions"][0]["id"], expected, "{seq}");
        assert_eq!(ids(&reply.body["anchors"], "anchorId"), ["_space"], "{seq}");
    }
    // 下一次接口服务写的提交接在处理服务的提交后面。
    let reply = app
        .org(
            Method::PUT,
            &format!("/api/v1/admin/spaces/{SPACE}/layout"),
            Some(json!({"regions": [], "baseSeq": 54})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 55);
}

#[tokio::test]
async fn public_rate_limit_and_space_ids() {
    let Some(app) = TestApp::start_with_env(&[
        ("PUBLIC_RATE_LIMIT_PER_MINUTE", "60"),
        ("PUBLIC_RATE_LIMIT_BURST", "3"),
    ])
    .await
    else {
        return;
    };
    let mut statuses = Vec::new();
    for _ in 0..4 {
        let reply = app.public("/api/public/spaces/no-such-space", None).await;
        statuses.push(reply.status);
        if reply.status == StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(reply.header(header::CACHE_CONTROL), "no-store");
            assert!(!reply.header(header::RETRY_AFTER).is_empty());
            assert_eq!(reply.body["code"], "rate_limited");
        }
    }
    assert_eq!(
        statuses,
        [
            StatusCode::NOT_FOUND,
            StatusCode::NOT_FOUND,
            StatusCode::NOT_FOUND,
            StatusCode::TOO_MANY_REQUESTS
        ]
    );
    // 区块和资源单独一档，不受普通公开接口额度的影响。
    let reply = app
        .public(&format!("/api/public/chunks/{}.bin", "0".repeat(64)), None)
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // /api/v1 不受公开接口限流影响。
    let reply = app
        .org(Method::GET, "/api/v1/spaces/no-such-space/timeline", None)
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn draft_assets_must_belong_to_the_space_and_become_public_on_publish() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let texture = app
        .put_checked_asset(
            SPACE,
            b"\xff\xd8\xff texture",
            "image/jpeg",
            "texture",
            image_check("jpeg", 512, 512),
        )
        .await;
    let scan = app
        .put_checked_asset(
            SPACE,
            b"raw scan bytes",
            "application/octet-stream",
            "scan",
            scan_glb_check(),
        )
        .await;
    let foreign = app
        .put_checked_asset(
            "other-space",
            b"someone else's texture",
            "image/png",
            "texture",
            image_check("png", 64, 64),
        )
        .await;
    let entity = |hash: &str| {
        json!([{"op": "placeEntity", "entity": {"entityId": "rug", "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 0.02, 1], "transform": {"position": [2, 0, 2]},
                      "material": {"texture": hash, "uv": "planar"}},
            "bounds": {"min": [1.5, 0, 1.5], "max": [2.5, 0.02, 2.5]}}}])
    };
    let path = draft_path(
        SPACE,
        &new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await,
    );
    // 原始扫描、别的空间的资源、不存在的资源：422，草稿不变。
    for hash in [scan.clone(), foreign.clone(), "b".repeat(64)] {
        let reply = append(&app, &path, entity(&hash)).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{hash}");
        assert_eq!(reply.body["code"], "unknown_asset");
    }
    let reply = append(&app, &path, entity(&texture)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["assets"], json!([texture]));
    // 发布前：公开资源地址读不到，预览地址能读到。
    let public_path = format!("/api/public/assets/{texture}.bin");
    assert_eq!(
        app.public(&public_path, None).await.status,
        StatusCode::NOT_FOUND
    );
    let token = app
        .org(Method::POST, &format!("{path}/preview"), None)
        .await
        .body["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let preview_auth = format!("Preview {token}");
    let reply = app
        .public(
            &format!("/api/public/previews/assets/{texture}"),
            Some(&preview_auth),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.header(header::CONTENT_TYPE), "image/jpeg");
    assert_eq!(reply.header(header::CACHE_CONTROL), "no-store");
    assert_eq!(
        app.public(
            &format!("/api/public/previews/assets/{scan}"),
            Some(&preview_auth)
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    // 发布后登记到 assetRefs（带提交编号），公开可读。
    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let commit_id = reply.body["commitId"].as_str().unwrap().to_owned();
    let reply = app.public(&public_path, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(&reply.bytes[..], b"\xff\xd8\xff texture");
    let registered = app
        .collection("assetRefs")
        .find_one(doc! {"hash": &texture, "spaceId": SPACE})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(registered.get_str("commitId").unwrap(), commit_id);
}

/// 预览令牌读资源只到草稿的基础版本（设计 2.8）：基础版本之后才发布的模型和贴图一律 404，
/// 令牌不记名、可转发，不能借它读到成员才看得到的新内容。
#[tokio::test]
async fn preview_assets_stop_at_the_draft_base_seq() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let older = app
        .put_checked_asset(
            SPACE,
            b"\xff\xd8\xff older texture",
            "image/jpeg",
            "texture",
            image_check("jpeg", 256, 256),
        )
        .await;
    let newer = app
        .put_checked_asset(
            SPACE,
            b"\xff\xd8\xff newer texture",
            "image/jpeg",
            "texture",
            image_check("jpeg", 256, 256),
        )
        .await;
    let entity = |id: &str, hash: &str, x: f64| {
        json!([{"op": "placeEntity", "entity": {"entityId": id, "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 0.02, 1], "transform": {"position": [x, 0, 2]},
                      "material": {"texture": hash, "uv": "planar"}},
            "bounds": {"min": [x - 0.5, 0, 1.5], "max": [x + 0.5, 0.02, 2.5]}}}])
    };
    let publish = |path: String| {
        let app = &app;
        async move {
            let reply = app
                .org(Method::POST, &format!("{path}/publish"), None)
                .await;
            assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
            reply.body["seq"].as_u64().unwrap()
        }
    };
    let drafts = format!("/api/v1/spaces/{SPACE}/drafts");
    // 第一版引用 older。
    let first = draft_path(SPACE, &new_draft(&app, &drafts).await);
    assert_eq!(
        append(&app, &first, entity("rug-a", &older, 2.0))
            .await
            .status,
        StatusCode::OK
    );
    let base = publish(first).await;
    // 草稿 D 基于这一版，生成预览令牌。
    let pending = draft_path(SPACE, &new_draft(&app, &drafts).await);
    let token = app
        .org(Method::POST, &format!("{pending}/preview"), None)
        .await
        .body["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let preview_auth = format!("Preview {token}");
    // 另一个草稿在 D 的基础版本之后发布，引用 newer。
    let second = draft_path(SPACE, &new_draft(&app, &drafts).await);
    assert_eq!(
        append(&app, &second, entity("rug-b", &newer, 4.0))
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(publish(second).await, base + 1);
    let status = |hash: String| {
        let app = &app;
        let auth = preview_auth.clone();
        async move {
            app.public(&format!("/api/public/previews/assets/{hash}"), Some(&auth))
                .await
                .status
        }
    };
    assert_eq!(status(older.clone()).await, StatusCode::OK);
    assert_eq!(status(newer.clone()).await, StatusCode::NOT_FOUND);
    // 新写的 assetRefs 带最早引用它的版本号。
    let refs = app.collection("assetRefs");
    let seq_of = |hash: String| {
        let refs = refs.clone();
        async move {
            refs.find_one(doc! {"hash": hash, "spaceId": SPACE})
                .await
                .unwrap()
                .unwrap()
                .get_i64("seq")
                .unwrap()
        }
    };
    assert_eq!(seq_of(older.clone()).await, base as i64);
    assert_eq!(seq_of(newer.clone()).await, base as i64 + 1);
    // 瘦身前写的只有 commitId：按提交的版本号判断，结果相同。
    refs.update_many(doc! {"spaceId": SPACE}, doc! {"$unset": {"seq": ""}})
        .await
        .unwrap();
    assert_eq!(status(older.clone()).await, StatusCode::OK);
    assert_eq!(status(newer.clone()).await, StatusCode::NOT_FOUND);
    // 只由事件类型登记过（既没有 seq 也没有 commitId）：不给。
    refs.update_one(
        doc! {"hash": &older, "spaceId": SPACE},
        doc! {"$unset": {"commitId": ""}, "$set": {"eventType": "visit"}},
    )
    .await
    .unwrap();
    assert_eq!(status(older.clone()).await, StatusCode::NOT_FOUND);
    // 再被一次提交引用时，`$min` 补上版本号（事件类型先登记的也一样）。
    let third = draft_path(SPACE, &new_draft(&app, &drafts).await);
    assert_eq!(
        append(&app, &third, entity("rug-c", &older, 6.0))
            .await
            .status,
        StatusCode::OK
    );
    let latest = publish(third).await;
    assert_eq!(seq_of(older.clone()).await, latest as i64);
}

/// 功能级开关打开时（`METAVERSE_REQUIRE_PERMISSIONS=true`），草稿的全部写操作和区域都要求
/// `metaverse:content:write`，事件类型和抹除要求 `metaverse:event:write`；读草稿不要求。
#[tokio::test]
async fn draft_writes_require_content_write_when_permissions_are_enforced() {
    let Some(app) = TestApp::start_with_env(&[("METAVERSE_REQUIRE_PERMISSIONS", "true")]).await
    else {
        return;
    };
    const CREATE: &str = "metaverse:space:create";
    const CONTENT: &str = "metaverse:content:write";
    const EVENTS: &str = "metaverse:event:write";
    let reply = app
        .org_with(
            &[CREATE],
            Method::POST,
            "/api/v1/admin/spaces",
            Some(json!({"id": SPACE, "name": "测试空间", "owner": {"kind": "org", "id": ORG}})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let layout = json!({
        "regions": [{"id": "hall", "kind": "physical", "boxes": [[0, 0, 0, 200, 60, 200]]}],
        "plots": []
    });
    let layout_path = format!("/api/v1/admin/spaces/{SPACE}/layout");
    let reply = app
        .org_with(&[], Method::PUT, &layout_path, Some(layout.clone()))
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app
        .org_with(&[CONTENT], Method::PUT, &layout_path, Some(layout))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);

    // 建草稿。
    let drafts = format!("/api/v1/spaces/{SPACE}/drafts");
    let reply = app.org_with(&[], Method::POST, &drafts, None).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app.org_with(&[CONTENT], Method::POST, &drafts, None).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let path = draft_path(SPACE, reply.body["id"].as_str().unwrap());
    // 读草稿不要求能力。
    assert_eq!(
        app.org_with(&[], Method::GET, &path, None).await.status,
        StatusCode::OK
    );
    // 追加、从上传应用、预览、发布、丢弃：没有 content:write 一律 403，草稿不变。
    let ops = json!({"ops": [{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}]});
    let (upload_id, _) = app
        .put_ops_upload(SPACE, ops["ops"][0].to_string().as_bytes())
        .await;
    for (method, suffix, body) in [
        (Method::POST, "/ops", Some(ops.clone())),
        (
            Method::POST,
            "/ops-from-upload",
            Some(json!({"uploadId": upload_id})),
        ),
        (Method::POST, "/preview", None),
        (Method::POST, "/publish", None),
        (Method::DELETE, "", None),
    ] {
        let reply = app
            .org_with(&[EVENTS], method.clone(), &format!("{path}{suffix}"), body)
            .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {suffix}");
    }
    assert_eq!(
        app.org_with(&[], Method::GET, &path, None).await.body["rev"],
        0
    );
    let reply = app
        .org_with(&[CONTENT], Method::POST, &format!("{path}/ops"), Some(ops))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = app
        .org_with(&[CONTENT], Method::POST, &format!("{path}/preview"), None)
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let reply = app
        .org_with(&[CONTENT], Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = app.org_with(&[CONTENT], Method::POST, &drafts, None).await;
    let second = draft_path(SPACE, reply.body["id"].as_str().unwrap());
    let reply = app
        .org_with(&[CONTENT], Method::DELETE, &second, None)
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);

    // 事件类型和抹除：要求 event:write（content:write 不够）。
    let event_types = format!("/api/v1/admin/spaces/{SPACE}/event-types");
    let definition = json!({"type": "door.open", "schema": {"type": "object"},
        "defaultVisibility": "public", "display": {"kind": "highlight"}});
    let reply = app
        .org_with(
            &[CONTENT],
            Method::POST,
            &event_types,
            Some(definition.clone()),
        )
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app
        .org_with(&[EVENTS], Method::POST, &event_types, Some(definition))
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    let redact = format!("/api/v1/admin/spaces/{SPACE}/events/ev_missing/redact");
    let reply = app.org_with(&[CONTENT], Method::POST, &redact, None).await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = app.org_with(&[EVENTS], Method::POST, &redact, None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

/// 资源按核对记录判断角色（docs/design/server-slim.md 2.5 第 4 条、4.6）：物件模型要核对记录是在物件
/// 模型上限内的 glb，贴图要是在贴图上限内的图片；不看第一次登记时记的 `kind`。资源按内容全局去重，
/// 本空间上传过或导入过的同一份内容也算本空间的；别的空间抢先以别的用途登记同一份 glb 之后，本空间
/// 照样能按物件模型引用。只有模型的物件，模型的实测包围盒要与物件 `bounds` 一致。
#[tokio::test]
async fn draft_assets_are_checked_by_role_and_by_space_ownership() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let lamp_bounds = ([-0.25, 0.0, -0.25], [0.25, 0.5, 0.25]);
    // 核对过、在物件模型上限内的 glb（登记时 kind 写成什么都无所谓）。
    let model = app
        .put_checked_asset(
            SPACE,
            b"glTF checked lamp",
            "model/gltf-binary",
            "web_model",
            glb_check(lamp_bounds.0, lamp_bounds.1, 2000),
        )
        .await;
    // 没有核对记录的旧资源（处理服务时代的模型）：不能再被新引用。
    let unchecked = app
        .put_space_asset(SPACE, b"glTF processed", "model/gltf-binary", "model")
        .await;
    // 三角形超过物件模型的上限（10 万），但在网页用模型的上限内。
    let heavy = app
        .put_checked_asset(
            SPACE,
            b"glTF heavy",
            "model/gltf-binary",
            "model",
            glb_check(lamp_bounds.0, lamp_bounds.1, 300_000),
        )
        .await;
    // 扫描用途只做了轻量检查（没有包围盒）。
    let scan_glb = app
        .put_checked_asset(
            SPACE,
            b"glTF scan",
            "model/gltf-binary",
            "scan",
            scan_glb_check(),
        )
        .await;
    let texture = app
        .put_checked_asset(
            SPACE,
            b"\x89PNG texture",
            "image/png",
            "model",
            image_check("png", 256, 256),
        )
        .await;
    // 边长超过贴图上限（4096）。
    let huge_texture = app
        .put_checked_asset(
            SPACE,
            b"\x89PNG huge",
            "image/png",
            "texture",
            image_check("png", 8192, 64),
        )
        .await;
    let place = |id: &str, model: &str| {
        json!([{"op": "placeEntity", "entity": {"entityId": id, "layer": "ext", "kind": "object",
            "assetHash": model, "bounds": {"min": [1.25, 0, 1.25], "max": [1.75, 0.5, 1.75]}}}])
    };
    let rug = |id: &str, texture: &str| {
        json!([{"op": "placeEntity", "entity": {"entityId": id, "layer": "ext", "kind": "object",
            "shape": {"type": "box", "size": [1, 0.02, 1], "transform": {"position": [2, 0, 2]},
                      "material": {"texture": texture, "uv": "planar"}},
            "bounds": {"min": [1.5, 0, 1.5], "max": [2.5, 0.02, 2.5]}}}])
    };
    let path = draft_path(
        SPACE,
        &new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await,
    );
    // 没有核对记录：422，提示重新上传。
    let reply = append(&app, &path, place("lamp", &unchecked)).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(reply.body["code"], "unknown_asset");
    assert!(
        reply.body["detail"].as_str().unwrap().contains("核对记录"),
        "{:?}",
        reply.body
    );
    // 角色表的反例：贴图、扫描的轻量 glb、超上限的 glb 当物件模型；模型、超上限的图片当贴图。
    for ops in [
        place("lamp", &texture),
        place("lamp", &scan_glb),
        place("lamp", &heavy),
        rug("rug", &model),
        rug("rug", &huge_texture),
    ] {
        let reply = append(&app, &path, ops.clone()).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{ops}");
        assert_eq!(reply.body["code"], "unknown_asset");
    }
    assert_eq!(app.org(Method::GET, &path, None).await.body["rev"], 0);
    // 模型与记录一致：模型的实测尺寸与物件 bounds 不符、原点不在底面中心都拒绝。
    let mismatched = |min: [f64; 3], max: [f64; 3]| {
        json!([{"op": "placeEntity", "entity": {"entityId": "lamp", "layer": "ext", "kind": "object",
            "assetHash": &model, "bounds": {"min": min, "max": max}}}])
    };
    for ops in [
        mismatched([1.0, 0.0, 1.0], [2.0, 0.5, 2.0]),
        mismatched([1.25, 0.0, 1.25], [1.75, 1.5, 1.75]),
    ] {
        let reply = append(&app, &path, ops).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            reply.body["code"], "model_bounds_mismatch",
            "{:?}",
            reply.body
        );
    }
    let off_center = app
        .put_checked_asset(
            SPACE,
            b"glTF off center",
            "model/gltf-binary",
            "model",
            glb_check([0.0, 0.0, 0.0], [0.5, 0.5, 0.5], 100),
        )
        .await;
    let reply = append(&app, &path, place("lamp", &off_center)).await;
    assert_eq!(
        reply.body["code"], "model_bounds_mismatch",
        "{:?}",
        reply.body
    );
    // 带偏航的物件（SHAPES 3）：按模型包围盒转过之后的外包盒和 bounds 比。长条模型 0.8 × 0.5 × 0.2 米，
    // 偏航 90° 后 x、z 对调；不带 transform 时同样的 bounds 对不上。
    let bench = app
        .put_checked_asset(
            SPACE,
            b"glTF bench",
            "model/gltf-binary",
            "model",
            glb_check([-0.4, 0.0, -0.1], [0.4, 0.5, 0.1], 100),
        )
        .await;
    let turned = |id: &str, transform: Option<Value>| {
        let mut entity = json!({"entityId": id, "layer": "ext", "kind": "object", "assetHash": &bench,
            "bounds": {"min": [3.9, 0, 0.6], "max": [4.1, 0.5, 1.4]}});
        if let Some(transform) = transform {
            entity["transform"] = transform;
        }
        json!([{"op": "placeEntity", "entity": entity}])
    };
    let reply = append(&app, &path, turned("bench", None)).await;
    assert_eq!(
        reply.body["code"], "model_bounds_mismatch",
        "{:?}",
        reply.body
    );
    let reply = append(&app, &path, turned("bench", Some(json!({"yaw": 90})))).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // 正例：核对记录合乎角色。
    let reply = append(&app, &path, place("lamp", &model)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = append(&app, &path, rug("rug", &texture)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);

    // 别的空间先登记了同一份内容（metadata.spaceId 是别的空间，kind 也是别的用途）：
    // 本空间有完成的上传或 model_import 任务就算本空间的，否则 422。
    let shared_texture = app
        .put_checked_asset(
            "other-space",
            b"\xff\xd8\xff shared",
            "image/jpeg",
            "texture",
            image_check("jpeg", 128, 128),
        )
        .await;
    let shared_model = app
        .put_checked_asset(
            "other-space",
            b"glTF shared chair",
            "model/gltf-binary",
            "texture",
            glb_check(lamp_bounds.0, lamp_bounds.1, 900),
        )
        .await;
    for ops in [place("chair", &shared_model), rug("mat", &shared_texture)] {
        let reply = append(&app, &path, ops).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            reply.body["detail"]
                .as_str()
                .unwrap()
                .contains("不属于本空间"),
            "{:?}",
            reply.body
        );
    }
    let owner = doc! {"kind": "org", "id": ORG};
    // 只凭哈希"直接复用"的上传（旧版本留下的，没有传过数据）不能确立所有权。
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_reused_texture", "spaceId": SPACE, "owner": owner.clone(),
            "purpose": "texture", "status": "done", "assetHash": &shared_texture,
            "reused": true, "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    let reply = append(&app, &path, rug("mat", &shared_texture)).await;
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        reply.body
    );
    // 真正传过数据、核对通过的上传（存储层去重后同一份内容）算本空间的：别的空间按贴图登记的
    // glb，本空间按 model 用途上传过，照样能当物件模型引用。
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_shared_texture", "spaceId": SPACE, "owner": owner.clone(),
            "purpose": "texture", "status": "done", "assetHash": &shared_texture,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_shared_model", "spaceId": SPACE, "owner": owner.clone(),
            "purpose": "model", "status": "done", "assetHash": &shared_model,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    // 失败的上传、别的空间的上传不算。
    let foreign_texture = app
        .put_checked_asset(
            "other-space",
            b"\xff\xd8\xff not ours",
            "image/jpeg",
            "texture",
            image_check("jpeg", 64, 64),
        )
        .await;
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_failed", "spaceId": SPACE, "owner": owner.clone(),
            "purpose": "texture", "status": "failed", "assetHash": &foreign_texture,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    let reply = append(&app, &path, rug("doormat", &foreign_texture)).await;
    assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY);
    let reply = append(&app, &path, place("chair", &shared_model)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = append(&app, &path, rug("mat", &shared_texture)).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);

    // 发布后登记到 assetRefs，公开可读。
    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    for hash in [&model, &texture, &shared_model, &shared_texture] {
        let reply = app
            .public(&format!("/api/public/assets/{hash}.bin"), None)
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{hash}");
    }
    assert_eq!(
        app.public(&format!("/api/public/assets/{unchecked}.bin"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

/// `/api/v1` 的资源下载（设计 8.2：原始扫描、大块操作文件和脚本只能由有权限的调用者经
/// `/api/v1` 下载；命令行 pull 用它下载网页用模型）。
#[tokio::test]
async fn v1_asset_download_is_limited_to_the_space_and_its_readers() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    let scan_bytes = b"DRACO raw scan bytes".to_vec();
    let scan = app
        .put_space_asset(SPACE, &scan_bytes, "application/x-draco", "scan")
        .await;
    let web_bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let web_model = app
        .put_asset(&web_bytes, "model/gltf-binary", "web_model")
        .await;
    app.register_asset_ref(SPACE, &web_model).await;
    let foreign = app
        .put_space_asset(
            "other-space",
            b"someone else's scan",
            "application/x-draco",
            "scan",
        )
        .await;
    // 别的空间先登记的同一份内容：本空间只凭哈希"直接复用"的上传（旧版本留下的）不算，
    // 真正传过数据的完成上传才算本空间的。
    let shared = app
        .put_space_asset(
            "other-space",
            b"ops shared by content",
            "application/x-ndjson",
            "ops",
        )
        .await;
    let path = |hash: &str| format!("/api/v1/spaces/{SPACE}/assets/{hash}");
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_reused_ops", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "purpose": "ops", "status": "done", "assetHash": &shared, "reused": true,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    assert_eq!(
        app.org(Method::GET, &path(&shared), None).await.status,
        StatusCode::NOT_FOUND
    );
    app.collection("uploads")
        .insert_one(doc! {
            "_id": "up_shared_ops", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "purpose": "ops", "status": "done", "assetHash": &shared,
            "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();

    // 主人：原始扫描（不在 assetRefs 里，公开接口读不到）。
    let reply = app.org(Method::GET, &path(&scan), None).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.bytes, scan_bytes);
    assert_eq!(
        reply.header(header::CONTENT_TYPE),
        "application/octet-stream"
    );
    assert_eq!(reply.header(header::X_CONTENT_TYPE_OPTIONS), "nosniff");
    assert_eq!(reply.header(header::CACHE_CONTROL), "private, no-store");
    assert_eq!(
        app.public(&format!("/api/public/assets/{scan}.bin"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // 网页用模型：类型按白名单固定，支持分段下载（跨数据块）。
    let reply = app.org(Method::GET, &path(&web_model), None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.bytes, web_bytes);
    assert_eq!(reply.header(header::CONTENT_TYPE), "model/gltf-binary");
    let token = timeline_support::identity(ORG);
    let reply = app
        .send(
            Method::GET,
            &path(&web_model),
            &[
                ("x-nyxid-identity-token", token.as_str()),
                ("range", "bytes=262140-262149"),
            ],
            Payload::None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(reply.bytes, web_bytes[262_140..262_150]);
    assert_eq!(
        reply.header(header::CONTENT_RANGE),
        format!("bytes 262140-262149/{}", web_bytes.len())
    );
    // 真正传过数据的上传。
    let reply = app.org(Method::GET, &path(&shared), None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(&reply.bytes[..], b"ops shared by content");
    // 本空间提交里引用过的（发布时存成资源的大块操作，内容和别的空间相同）。
    let committed = app
        .put_space_asset(
            "other-space",
            b"big ops in a commit",
            "application/x-ndjson",
            "ops",
        )
        .await;
    assert_eq!(
        app.org(Method::GET, &path(&committed), None).await.status,
        StatusCode::NOT_FOUND
    );
    app.collection("commits")
        .insert_one(doc! {
            "_id": "c_with_ops_ref", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "seq": 999_i64, "at": "2026-01-01T00:00:00.000Z", "message": "大块操作",
            "opsRef": &committed,
        })
        .await
        .unwrap();
    let reply = app.org(Method::GET, &path(&committed), None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(&reply.bytes[..], b"big ops in a commit");

    // 组织成员只读也能下载。
    let reply = app
        .v1(
            Method::GET,
            &path(&scan),
            "bob",
            Some("member-token"),
            Payload::None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    // 陌生人：404。
    let reply = app
        .v1(
            Method::GET,
            &path(&scan),
            "eve",
            Some("stranger-token"),
            Payload::None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // 别的空间的资源、不存在的资源、哈希格式不对：404。
    for hash in [foreign.clone(), "d".repeat(64), "ABC".to_owned()] {
        let reply = app.org(Method::GET, &path(&hash), None).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{hash}");
        assert_eq!(reply.header(header::CACHE_CONTROL), "no-store");
    }
    // 没有身份令牌：401。
    assert_eq!(
        app.public(&path(&scan), None).await.status,
        StatusCode::UNAUTHORIZED
    );
}

async fn publish(app: &TestApp, ops: Value) -> u64 {
    let draft_id = new_draft(app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path = draft_path(SPACE, &draft_id);
    let reply = append(app, &path, ops).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = app
        .org(Method::POST, &format!("{path}/publish"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    reply.body["seq"].as_u64().unwrap()
}

/// 锚点先改成内部级、再删除：它在历史版本里公开过的内容不能因为删除而重新出现。
#[tokio::test]
async fn deleted_internal_anchor_stays_hidden_in_history() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let share = format!("Share {}", app.create_space(SPACE).await);
    app.define_layout(SPACE).await;
    let created = publish(
        &app,
        json!([{"op": "createAnchor", "anchor": {"anchorId": "vault", "kind": "zone",
                "position": [1, 0, 1], "label": "保险柜", "visibility": "public"}}]),
    )
    .await;
    let snapshot = |seq: u64| {
        let app = &app;
        let share = share.clone();
        async move {
            let reply = app
                .public(
                    &format!("/api/public/spaces/{SPACE}/snapshot?seq={seq}"),
                    Some(&share),
                )
                .await;
            assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
            ids(&reply.body["anchors"], "anchorId")
        }
    };
    assert!(snapshot(created).await.contains(&"vault".to_owned()));
    publish(
        &app,
        json!([{"op": "updateAnchor", "anchorId": "vault", "visibility": "internal"}]),
    )
    .await;
    assert!(!snapshot(created).await.contains(&"vault".to_owned()));
    let removed = publish(&app, json!([{"op": "removeAnchor", "anchorId": "vault"}])).await;
    assert!(
        !snapshot(created).await.contains(&"vault".to_owned()),
        "删除之后历史快照重新公开了内部锚点"
    );
    let timeline = app
        .public(
            &format!("/api/public/spaces/{SPACE}/timeline"),
            Some(&share),
        )
        .await;
    assert_eq!(timeline.status, StatusCode::OK, "{:?}", timeline.body);
    for item in timeline.body["items"].as_array().unwrap() {
        assert!(
            item["changedAnchors"]
                .as_array()
                .unwrap()
                .iter()
                .all(|change| change["id"] != "vault"),
            "{item:?}"
        );
    }
    // 同一编号重新建成公开锚点：从这之后照常公开。
    let recreated = publish(
        &app,
        json!([{"op": "createAnchor", "anchor": {"anchorId": "vault", "kind": "zone",
                "position": [2, 0, 2], "label": "新展柜", "visibility": "public"}}]),
    )
    .await;
    assert!(recreated > removed);
    assert!(snapshot(recreated).await.contains(&"vault".to_owned()));
}

/// 草稿预览也不显示"现在已经是内部级"的锚点（草稿没有改动它时）。
#[tokio::test]
async fn preview_hides_anchors_made_internal_after_the_draft_base() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    publish(
        &app,
        json!([{"op": "createAnchor", "anchor": {"anchorId": "x", "kind": "zone",
                "position": [1, 0, 1], "label": "秘密标签", "visibility": "public"}}]),
    )
    .await;
    // 草稿 B 基于 x 还公开的版本，只填方块。
    let draft_b = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path_b = draft_path(SPACE, &draft_b);
    let reply = append(
        &app,
        &path_b,
        json!([{"op": "fill", "box": [0, 0, 0, 2, 1, 2], "block": 2}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let preview = app
        .org(Method::POST, &format!("{path_b}/preview"), None)
        .await;
    assert_eq!(preview.status, StatusCode::CREATED, "{:?}", preview.body);
    let auth = format!("Preview {}", preview.body["token"].as_str().unwrap());
    let view = app.public("/api/public/previews", Some(&auth)).await;
    assert!(ids(&view.body["anchors"], "anchorId").contains(&"x".to_owned()));
    // 另一次提交把 x 改成内部级：旧预览令牌不再显示它。
    publish(
        &app,
        json!([{"op": "updateAnchor", "anchorId": "x", "visibility": "internal"}]),
    )
    .await;
    let view = app.public("/api/public/previews", Some(&auth)).await;
    assert_eq!(view.status, StatusCode::OK, "{:?}", view.body);
    assert!(
        !ids(&view.body["anchors"], "anchorId").contains(&"x".to_owned()),
        "{:?}",
        view.body
    );
    // 草稿自己把 x 改回公开：预览按草稿状态显示。
    let draft_c = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path_c = draft_path(SPACE, &draft_c);
    let reply = append(
        &app,
        &path_c,
        json!([{"op": "updateAnchor", "anchorId": "x", "visibility": "public"}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let preview = app
        .org(Method::POST, &format!("{path_c}/preview"), None)
        .await;
    let auth = format!("Preview {}", preview.body["token"].as_str().unwrap());
    let view = app.public("/api/public/previews", Some(&auth)).await;
    assert!(ids(&view.body["anchors"], "anchorId").contains(&"x".to_owned()));
}

/// 百分号编码的空间编号不经过解码直接 404：路由提取路径参数时会解码，按原始字符串计数的
/// 每空间并发上限可以被同一空间的任意多种写法放大。
#[tokio::test]
async fn percent_encoded_space_ids_are_rejected_before_counting() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let share = format!("Share {}", app.create_space(SPACE).await);
    let reply = app
        .public(&format!("/api/public/spaces/{SPACE}/head"), Some(&share))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    for path in [
        "/api/public/spaces/fr%6Fnt-hall/head",
        "/api/public/spaces/%66ront-hall",
        "/api/public/spaces/FRONT-HALL/head",
    ] {
        let reply = app.public(path, Some(&share)).await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(reply.header(header::CACHE_CONTROL), "no-store");
    }
}

/// 发布在提交事务里占用草稿（rev 不变、仍是 open）：发布期间被追加、丢弃或已被别的请求
/// 发布时整个提交作废（409），草稿和它的区块不受影响。
#[tokio::test]
async fn publish_claims_the_draft_inside_the_commit_transaction() {
    use metaverse_api::repo::{CommitError, CommitPlan};
    use metaverse_core::model::{Actor, ActorKind, Owner};
    use metaverse_core::scope::PathScope;
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let draft_id = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path = draft_path(SPACE, &draft_id);
    let reply = append(
        &app,
        &path,
        json!([{"op": "fill", "box": [0, 0, 0, 2, 1, 2], "block": 2}]),
    )
    .await;
    assert_eq!(reply.body["rev"], 1);
    // 发布方读到 rev 1 之后，另一个请求又追加了一批（rev 2，碰了另一个区块）。
    let reply = append(
        &app,
        &path,
        json!([{"op": "fill", "box": [40, 0, 40, 42, 1, 42], "block": 2}]),
    )
    .await;
    assert_eq!(reply.body["rev"], 2);
    let chunks_before = app
        .collection("draftChunks")
        .count_documents(doc! {"draftId": &draft_id})
        .await
        .unwrap();
    assert!(chunks_before >= 2);
    let grant = app
        .state
        .authorizer
        .system_space(SPACE, &Owner::org(ORG.to_owned()), "测试", "publish")
        .await
        .unwrap();
    let head = app.state.repo.head_seq(&grant).await.unwrap().unwrap();
    let actor = Actor {
        sub: ORG.to_owned(),
        nyx_service_id: "svc".to_owned(),
        scope: PathScope::Physical,
        kind: ActorKind::Admin,
    };
    let plan = |rev: u64| {
        let mut plan = CommitPlan::new(head, actor.clone(), "发布");
        plan.draft_id = Some(draft_id.clone());
        plan.draft_rev = Some(rev);
        plan
    };
    let now = metaverse_core::Timestamp::from_system_time(std::time::SystemTime::now()).unwrap();
    // 按旧 rev 发布：提交作废，时间线不前进，草稿和区块原样。
    assert!(matches!(
        app.state.repo.write_commit(&grant, &plan(1), now).await,
        Err(CommitError::DraftChanged)
    ));
    assert_eq!(app.state.repo.head_seq(&grant).await.unwrap(), Some(head));
    let draft = app
        .collection("drafts")
        .find_one(doc! {"_id": &draft_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.get_str("status").unwrap(), "open");
    assert_eq!(
        app.collection("draftChunks")
            .count_documents(doc! {"draftId": &draft_id})
            .await
            .unwrap(),
        chunks_before
    );
    // 当前 rev：发布成功，草稿在同一事务里标记为已发布。
    let outcome = app.state.repo.write_commit(&grant, &plan(2), now).await;
    assert!(outcome.is_ok(), "{outcome:?}");
    let draft = app
        .collection("drafts")
        .find_one(doc! {"_id": &draft_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.get_str("status").unwrap(), "published");
    // 同一草稿再发布一次（并发的第二个发布请求）：作废，不会写出第二个提交。
    let mut again = plan(2);
    again.base_seq = head + 1;
    assert!(matches!(
        app.state.repo.write_commit(&grant, &again, now).await,
        Err(CommitError::DraftChanged)
    ));
    assert_eq!(
        app.state.repo.head_seq(&grant).await.unwrap(),
        Some(head + 1)
    );
    // 经接口：已发布的草稿再追加、再发布都是 409。
    let reply = append(
        &app,
        &path,
        json!([{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CONFLICT, "{:?}", reply.body);
    // 丢弃之后的草稿同样不能被发布。
    let discarded = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let discarded_path = draft_path(SPACE, &discarded);
    append(
        &app,
        &discarded_path,
        json!([{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}]),
    )
    .await;
    let reply = app.org(Method::DELETE, &discarded_path, None).await;
    assert!(reply.status.is_success(), "{:?}", reply.body);
    let mut gone = CommitPlan::new(head + 1, actor.clone(), "发布");
    gone.draft_id = Some(discarded);
    gone.draft_rev = Some(1);
    assert!(matches!(
        app.state.repo.write_commit(&grant, &gone, now).await,
        Err(CommitError::DraftChanged)
    ));
}

/// 草稿操作是纯计算：单次内联追加、整个草稿都有计算量（格数）上限，超出在开始计算之前就 413。
/// 复现的攻击请求是一次追加 200 条、每条 4M 格的复制区域（十几 KB 的请求体，几分钟的计算）。
#[tokio::test]
async fn draft_ops_have_a_compute_budget() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let draft_id = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path = draft_path(SPACE, &draft_id);
    let heavy: Vec<Value> = (0..200)
        .map(|_| json!({"op": "copyRegion", "source": [0, 0, 0, 128, 256, 128], "to": [128, 0, 0]}))
        .collect();
    let started = std::time::Instant::now();
    let reply = append(&app, &path, json!(heavy)).await;
    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{:?}",
        reply.body
    );
    assert!(reply.body["detail"].as_str().unwrap().contains("格"));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "没有先算就拒绝：{:?}",
        started.elapsed()
    );
    // 预算之内的照常追加，并记下累计计算量。
    let reply = append(
        &app,
        &path,
        json!([{"op": "fill", "box": [0, 0, 0, 10, 10, 10], "block": 2}]),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let draft = app
        .collection("drafts")
        .find_one(doc! {"_id": &draft_id})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(draft.get_i64("workCells").unwrap(), 1000);
    // 整个草稿的累计上限（ops-from-upload 和发布时的重放都要全部再算一遍）。
    app.collection("drafts")
        .update_one(
            doc! {"_id": &draft_id},
            doc! {"$set": {"workCells": (1_i64 << 26) - 10}},
        )
        .await
        .unwrap();
    let reply = append(
        &app,
        &path,
        json!([{"op": "fill", "box": [0, 0, 0, 10, 10, 10], "block": 2}]),
    )
    .await;
    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{:?}",
        reply.body
    );
    let reply = append(
        &app,
        &path,
        json!([{"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "table",
                "position": [1, 0, 1], "visibility": "public"}}]),
    )
    .await;
    assert_eq!(
        reply.status,
        StatusCode::OK,
        "非方块操作只算 1 格：{:?}",
        reply.body
    );
}

/// ops-from-upload 计入每空间的任务上限，草稿引用的操作文件个数有上限：不能无限次地让接口服务
/// 把整份文件读进内存解析。
#[tokio::test]
async fn ops_from_upload_is_limited_per_space_and_per_draft() {
    let Some(app) = TestApp::start_with_env(&[("JOB_MAX_PENDING_PER_SPACE", "1")]).await else {
        return;
    };
    app.create_space(SPACE).await;
    app.define_layout(SPACE).await;
    let draft_id = new_draft(&app, &format!("/api/v1/spaces/{SPACE}/drafts")).await;
    let path = draft_path(SPACE, &draft_id);
    let ops = json!({"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2}).to_string();
    let (upload_id, _) = app.put_ops_upload(SPACE, ops.as_bytes()).await;
    // 已有一个运行中的任务：429，不建新任务。
    app.collection("jobs")
        .insert_one(doc! {
            "_id": "job_busy", "spaceId": SPACE, "owner": {"kind": "org", "id": ORG},
            "kind": "scan_import", "status": "running", "params": {},
            "attempt": 1, "maxAttempts": 3, "createdAt": "2026-01-01T00:00:00.000Z",
        })
        .await
        .unwrap();
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({"uploadId": upload_id})),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{:?}",
        reply.body
    );
    assert_eq!(reply.body["code"], "too_many_jobs");
    assert_eq!(
        app.collection("jobs")
            .count_documents(doc! {"kind": "ops_from_upload"})
            .await
            .unwrap(),
        0
    );
    app.collection("jobs")
        .delete_one(doc! {"_id": "job_busy"})
        .await
        .unwrap();
    // 草稿已经引用了 20 个操作文件：413。
    let refs: Vec<mongodb::bson::Document> = (0..20)
        .map(|i| doc! {"assetHash": format!("{i:064}"), "after": 0_i64, "count": 1_i64})
        .collect();
    app.collection("drafts")
        .update_one(doc! {"_id": &draft_id}, doc! {"$set": {"opsRefs": refs}})
        .await
        .unwrap();
    let reply = app
        .org(
            Method::POST,
            &format!("{path}/ops-from-upload"),
            Some(json!({"uploadId": upload_id})),
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "{:?}",
        reply.body
    );
    assert_eq!(reply.body["code"], "too_many_ops_files");
}
