//! 组合宇宙的集成测试：创建、加入（主人 / 邀请）、修改（摆放、连接、可见性、令牌）、退出、
//! 公开读（按时刻的修订和成员 seq、某次修订），以及凭组合令牌读成员空间的公开数据。

mod ingest_support;

use axum::http::{Method, StatusCode};
use ingest_support::*;
use mongodb::bson::doc;
use serde_json::{json, Value};

const U: &str = "/api/v1/universes/street";

#[tokio::test]
async fn 凭链接组合的既有分享令牌保留主题与异构成员样式并在轮换后立即吊销() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接真实数据库");
    let share = format!("Share {}", setup(&app).await);
    let mut catalogs = Vec::new();
    for (space, owner, style_id, layers) in [
        ("hall", ORG, "hall-curated", json!(["rebuilt"])),
        ("secret-shop", OTHER_ORG, "shop-curated", json!(["ext"])),
    ] {
        let styles = json!([{
            "id": style_id, "name": "成员专属策展", "visibleLayers": layers,
            "filterKinds": ["object"], "look": {"opacity": 0.5},
            "extensions": {"badge": "组合策展", "exhibition": {"zones": ["成员展区"]}}
        }]);
        let saved = app
            .call(
                who(owner),
                Method::PATCH,
                &format!("/api/v1/admin/spaces/{space}"),
                Some(json!({"styles": styles, "defaultStyleId": style_id})),
            )
            .await;
        assert_eq!(
            saved.status,
            StatusCode::OK,
            "成员样式保存失败：{:?}",
            saved.body
        );
        catalogs.push((space, owner, style_id, styles));
    }
    let joined = join(
        &app,
        who(ORG),
        "hall",
        json!({"offset": [0, 0, 0], "rotation": 0}),
    )
    .await;
    assert_eq!(
        joined.status,
        StatusCode::OK,
        "成员加入失败：{:?}",
        joined.body
    );
    invite_and_join_secret_shop(&app).await;
    let mut snapshots = Vec::new();
    for (space, owner, _, _) in &catalogs {
        // 提交发生在加入之后，使组合上下文能够授权该版本。
        let seq = app
            .insert_commit(space, json!({"kind": "org", "id": owner}), &ago(0), None)
            .await;
        snapshots.push(seq);
    }
    let mut retained = Vec::new();
    for themed in [false, true] {
        if themed {
            let changed = patch(&app, who(ORG), json!({
                "themeId": "blueprint-atlas",
                "members": [
                    {"spaceId": "hall", "offset": [0, 0, 0], "rotation": 0, "styleId": "hall-curated"},
                    {"spaceId": "secret-shop", "offset": [0, 0, 600], "rotation": 0, "styleId": "shop-curated"}
                ]
            })).await;
            assert_eq!(
                changed.status,
                StatusCode::OK,
                "组合样式配置失败：{:?}",
                changed.body
            );
        }
        let current = app
            .public("/api/public/universes/street", Some(&share), &[])
            .await;
        assert_eq!(
            current.status,
            StatusCode::OK,
            "既有令牌必须持续有效：{:?}",
            current.body
        );
        assert_eq!(current.headers["cache-control"], "no-store");
        assert_eq!(current.body["members"].as_array().unwrap().len(), 2);
        let revision_path = format!(
            "/api/public/universes/street/revisions/{}",
            current.body["seq"]
        );
        let revision = app.public(&revision_path, Some(&share), &[]).await;
        assert_eq!(
            revision.status,
            StatusCode::OK,
            "修订读取失败：{:?}",
            revision.body
        );
        assert!(revision.headers["cache-control"]
            .to_str()
            .unwrap()
            .starts_with("private"));
        for state in [&current.body, &revision.body["state"]] {
            assert_eq!(
                state.get("themeId").and_then(Value::as_str),
                themed.then_some("blueprint-atlas"),
                "组合公开视图与修订必须准确投影主题"
            );
            for (space, _, style_id, _) in &catalogs {
                let member = state["members"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|member| member["spaceId"] == *space)
                    .unwrap();
                assert_eq!(
                    member.get("styleId").and_then(Value::as_str),
                    themed.then_some(*style_id),
                    "组合公开视图与修订必须准确投影成员样式"
                );
            }
        }
        retained.push((revision_path.clone(), revision.body.clone()));
        let mut paths = vec!["/api/public/universes/street".to_owned(), revision_path];
        for ((space, _, style_id, styles), seq) in catalogs.iter().zip(&snapshots) {
            for path in [
                format!("/api/public/spaces/{space}?universe=street"),
                format!("/api/public/spaces/{space}/snapshot?seq={seq}&universe=street"),
            ] {
                let reply = app.public(&path, Some(&share), &[]).await;
                assert_eq!(
                    reply.status,
                    StatusCode::OK,
                    "组合令牌应授权成员：{path}；{:?}",
                    reply.body
                );
                assert!(reply.headers["cache-control"]
                    .to_str()
                    .unwrap()
                    .starts_with("private"));
                assert_eq!(&reply.body["styles"], styles, "成员自定义目录必须完整投影");
                assert_eq!(reply.body["defaultStyleId"], *style_id);
                paths.push(path);
            }
        }
        for path in &paths {
            for invalid in [None, Some("Share wrong-token-0123456789abcdef")] {
                let rejected = app.public(path, invalid, &[]).await;
                assert_eq!(
                    rejected.status,
                    StatusCode::NOT_FOUND,
                    "无效组合令牌不得读取：{path}"
                );
                assert_eq!(rejected.headers["cache-control"], "no-store");
            }
        }
        if themed {
            let rotated = patch(&app, who(ORG), json!({"rotateShareToken": true})).await;
            assert_eq!(
                rotated.status,
                StatusCode::OK,
                "组合令牌轮换失败：{:?}",
                rotated.body
            );
            let fresh = format!(
                "Share {}",
                rotated.body["shareToken"]["token"].as_str().unwrap()
            );
            assert_ne!(fresh, share, "轮换必须生成新的组合分享令牌");
            for path in paths.iter().chain(retained.iter().map(|(path, _)| path)) {
                let rejected = app.public(path, Some(&share), &[]).await;
                assert_eq!(
                    rejected.status,
                    StatusCode::NOT_FOUND,
                    "旧组合令牌必须立即失效：{path}"
                );
                assert_eq!(rejected.headers["cache-control"], "no-store");
                let reply = app.public(path, Some(&fresh), &[]).await;
                assert_eq!(
                    reply.status,
                    StatusCode::OK,
                    "新组合令牌必须立即有效：{path}"
                );
                if let Some((_, body)) = retained.iter().find(|(saved, _)| saved == path) {
                    assert_eq!(&reply.body, body, "轮换不得改变历史修订的主题和成员样式");
                } else if path == "/api/public/universes/street" {
                    assert_eq!(reply.body, current.body, "轮换不得改变组合样式状态");
                } else {
                    let (_, _, style_id, styles) = catalogs
                        .iter()
                        .find(|(space, _, _, _)| {
                            path.starts_with(&format!("/api/public/spaces/{space}?"))
                                || path.starts_with(&format!("/api/public/spaces/{space}/"))
                        })
                        .unwrap();
                    assert_eq!(&reply.body["styles"], styles, "轮换不得改变成员样式目录");
                    assert_eq!(reply.body["defaultStyleId"], *style_id);
                }
            }
        }
    }
}

async fn setup(app: &TestApp) -> String {
    app.create_space(who(ORG), "restaurant", "org", ORG, "public")
        .await;
    app.create_space(who(ORG), "hall", "org", ORG, "unlisted")
        .await;
    app.create_space(who(OTHER_ORG), "flower-shop", "org", OTHER_ORG, "public")
        .await;
    app.create_space(who(OTHER_ORG), "secret-shop", "org", OTHER_ORG, "unlisted")
        .await;
    for (space, owner, anchor, visibility) in [
        ("restaurant", ORG, "door", "public"),
        ("restaurant", ORG, "vault", "internal"),
        ("flower-shop", OTHER_ORG, "counter", "public"),
    ] {
        app.insert_anchor(
            space,
            json!({"kind": "org", "id": owner}),
            json!({"anchorId": anchor, "kind": "door", "box": [0, 0, 0, 2, 40, 20], "visibility": visibility}),
        )
        .await;
    }
    let reply = app
        .call(
            who(ORG),
            Method::POST,
            "/api/v1/universes",
            Some(json!({"id": "street", "name": "商业街", "owner": {"kind": "org", "id": ORG}})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    assert_eq!(reply.body["universe"]["seq"], 0);
    assert_eq!(reply.body["universe"]["visibility"], "unlisted");
    reply.body["shareToken"]["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn join(app: &TestApp, caller: Who<'_>, space: &str, body: Value) -> Reply {
    app.call(
        caller,
        Method::POST,
        &format!("{U}/members/{space}"),
        Some(body),
    )
    .await
}

async fn patch(app: &TestApp, caller: Who<'_>, body: Value) -> Reply {
    app.call(caller, Method::PATCH, U, Some(body)).await
}

#[tokio::test]
async fn create_rules() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    setup(&app).await;
    let app = &app;
    let create = |caller: Who<'static>, body: Value| async move {
        app.call(caller, Method::POST, "/api/v1/universes", Some(body))
            .await
    };
    // 编号重复、格式不对。
    assert_eq!(
        create(who(ORG), json!({"id": "street", "name": "x"}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        create(who(ORG), json!({"id": "Bad Id", "name": "x"}))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // 不给主人时就是调用者本人。
    let reply = create(who("alice"), json!({"id": "alice-u", "name": "我的组合"})).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert_eq!(
        reply.body["universe"]["owner"],
        json!({"kind": "person", "id": "alice"})
    );
    // 组织组合要求组织本身或组织 admin。
    let reply = create(
        who_with("bob", "member-token"),
        json!({"id": "bob-u", "name": "x", "owner": {"kind": "org", "id": ORG}}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    let reply = create(
        who_with("carol", "admin-token"),
        json!({"id": "carol-u", "name": "x", "owner": {"kind": "org", "id": ORG}}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    // 查看：组织成员可读（看不到令牌），陌生人 404。
    let reply = app
        .call(who_with("bob", "member-token"), Method::GET, U, None)
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.body.get("shareTokens").is_none());
    assert_eq!(reply.headers.get("etag").unwrap(), "\"0\"");
    let reply = app
        .call(who_with("eve", "stranger-token"), Method::GET, U, None)
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn membership_links_visibility_and_public_reads() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let universe_token = setup(&app).await;
    let share = format!("Share {universe_token}");

    // 组织本身既管空间也管组合：直接加入。
    let reply = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 1);
    let first_at = reply.body["at"].as_str().unwrap().to_owned();
    // 加入之后餐厅又有一次提交：现在的 seq 比加入时大 1。
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let restaurant_seq = app
        .insert_commit("restaurant", org_owner(), &ago(0), None)
        .await;
    // 已经是成员。
    let reply = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.body["code"], "already_member");
    // 只读成员不能把组织的空间加进去。
    let reply = join(
        &app,
        who_with("bob", "member-token"),
        "hall",
        json!({"offset": [0, 0, 0], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    // 别人不能把你的空间拉进他的组合：组合主人看不到花店，404。
    let reply = join(
        &app,
        who_with(ORG, "stranger-token"),
        "flower-shop",
        json!({"offset": [400, 0, 0], "rotation": 90}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{:?}", reply.body);
    // 你也不能把自己的空间硬塞进别人的组合：没有邀请时 404。
    let reply = join(
        &app,
        who(OTHER_ORG),
        "flower-shop",
        json!({"offset": [400, 0, 0], "rotation": 90}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND, "{:?}", reply.body);
    // 组合主人邀请，花店主人加入。
    let reply = patch(&app, who(ORG), json!({"invitations": ["flower-shop"]})).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        reply.body["universe"]["invitations"],
        json!(["flower-shop"])
    );
    assert_eq!(reply.body["universe"]["seq"], 1, "改邀请不产生修订");
    let reply = join(
        &app,
        who(OTHER_ORG),
        "flower-shop",
        json!({"offset": [400, 0, 0], "rotation": 90, "message": "花店加入"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 2);
    let reply = app.call(who(ORG), Method::GET, U, None).await;
    assert_eq!(reply.body["invitations"], json!([]));
    assert_eq!(reply.body["members"].as_array().unwrap().len(), 2);
    assert_eq!(
        reply.body["members"][1],
        json!({"spaceId": "flower-shop", "offset": [400, 0, 0], "rotation": 90})
    );
    // 修订文档带主人副本和发起者。
    let revision = app
        .collection("commits")
        .find_one(doc! {"spaceId": "street", "seq": 2_i64})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revision.get_str("_id").unwrap(), "composition:street:2");
    assert_eq!(
        revision.get_document("owner").unwrap(),
        &doc! {"kind": "org", "id": ORG}
    );
    assert_eq!(
        revision
            .get_document("actor")
            .unwrap()
            .get_str("sub")
            .unwrap(),
        OTHER_ORG
    );

    // 连接：两端必须是成员空间的公开锚点。
    let link = |from: (&str, &str), to: (&str, &str)| json!({"from": {"spaceId": from.0, "anchorId": from.1}, "to": {"spaceId": to.0, "anchorId": to.1}, "kind": "street"});
    for (bad, why) in [
        (
            link(("restaurant", "vault"), ("flower-shop", "counter")),
            "内部锚点",
        ),
        (link(("restaurant", "door"), ("hall", "door")), "不是成员"),
        (
            link(("restaurant", "door"), ("flower-shop", "nope")),
            "锚点不存在",
        ),
    ] {
        let reply = patch(&app, who(ORG), json!({"links": [bad]})).await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{why}: {:?}",
            reply.body
        );
    }
    let reply = patch(
        &app,
        who(ORG),
        json!({"baseSeq": 2, "message": "连上街道",
        "links": [link(("restaurant", "door"), ("flower-shop", "counter"))]}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["universe"]["seq"], 3);
    // 基于旧修订：409（请求体或 If-Match）。
    let reply = patch(&app, who(ORG), json!({"baseSeq": 2, "name": "新名字"})).await;
    assert_eq!(reply.body["code"], "universe_changed");
    let reply = app
        .call_with(
            who(ORG),
            Method::PATCH,
            U,
            &[("if-match", "\"1\"")],
            Some(json!({"name": "新名字"})),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CONFLICT);
    // 摆放：只能调整现有成员。
    let reply = patch(
        &app,
        who(ORG),
        json!({"members": [{"spaceId": "restaurant", "offset": [0, 0, 0], "rotation": 0}]}),
    )
    .await;
    assert_eq!(reply.body["code"], "members_mismatch");
    let reply = patch(
        &app,
        who(ORG),
        json!({"members": [
            {"spaceId": "restaurant", "offset": [0, 0, 0], "rotation": 0},
            {"spaceId": "flower-shop", "offset": [420, 0, 10], "rotation": 180}
        ]}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["universe"]["seq"], 4);
    // 只读成员和陌生人不能改。
    assert_eq!(
        patch(&app, who_with("bob", "member-token"), json!({"name": "x"}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        patch(
            &app,
            who_with("eve", "stranger-token"),
            json!({"name": "x"})
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    // 可见性：成员都公开时组合可以公开；公开组合不能加入凭链接查看的空间。
    let reply = patch(&app, who(ORG), json!({"visibility": "public"})).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = join(
        &app,
        who(ORG),
        "hall",
        json!({"offset": [0, 0, 300], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.body["code"], "visibility_conflict");
    // 公开组合不带令牌也能读。
    let reply = app.public("/api/public/universes/street", None, &[]).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    patch(&app, who(ORG), json!({"visibility": "unlisted"})).await;
    let reply = join(
        &app,
        who(ORG),
        "hall",
        json!({"offset": [0, 0, 300], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 5);
    let hall_joined = reply.body["at"].as_str().unwrap().to_owned();
    let reply = patch(&app, who(ORG), json!({"visibility": "public"})).await;
    assert_eq!(reply.body["code"], "visibility_conflict");

    // 公开读：凭组合令牌；T 时刻的修订 + 各成员在 T 时刻的 seq。
    assert_eq!(
        app.public("/api/public/universes/street", None, &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let reply = app
        .public("/api/public/universes/street", Some(&share), &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.headers.get("cache-control").unwrap(), "no-store");
    assert_eq!(reply.body["seq"], 5);
    assert_eq!(reply.body["name"], "商业街");
    let members = reply.body["members"].as_array().unwrap();
    assert_eq!(members.len(), 3);
    assert_eq!(members[0]["spaceId"], "restaurant");
    assert_eq!(members[0]["name"], "restaurant");
    assert_eq!(members[0]["seq"], restaurant_seq);
    // 花店只有建空间时的第一次提交。
    assert_eq!(members[1]["seq"], 1);
    assert_eq!(reply.body["links"].as_array().unwrap().len(), 1);
    // 第一次修订之前：没有成员。
    let before = metaverse_core::Timestamp::parse_rfc3339(&first_at)
        .unwrap()
        .saturating_add_millis(-1);
    let reply = app
        .public(
            &format!("/api/public/universes/street?at={before}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.body["seq"], 0);
    assert_eq!(reply.body["members"], json!([]));
    let reply = app
        .public(
            &format!("/api/public/universes/street?at={first_at}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.body["seq"], 1);
    // 加入那一刻餐厅还是加入前的版本。
    assert_eq!(reply.body["members"][0]["seq"], restaurant_seq - 1);
    // 某一次修订。
    let reply = app
        .public(
            "/api/public/universes/street/revisions/2",
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["universeId"], "street");
    assert_eq!(reply.body["message"], "花店加入");
    assert_eq!(reply.body["state"]["members"].as_array().unwrap().len(), 2);
    assert!(reply
        .headers
        .get("cache-control")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("private"));
    assert_eq!(
        app.public(
            "/api/public/universes/street/revisions/99",
            Some(&share),
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    // 凭组合令牌读成员空间（凭链接查看的 hall）的公开数据：要带 ?universe=，且 T 时刻是成员。
    let head = "/api/public/spaces/hall/head";
    assert_eq!(
        app.public(head, Some(&share), &[]).await.status,
        StatusCode::NOT_FOUND
    );
    let reply = app
        .public(&format!("{head}?universe=street"), Some(&share), &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert!(reply
        .headers
        .get("cache-control")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("private"));
    let reply = app
        .public(
            &format!("/api/public/spaces/hall/state?universe=street&at={hall_joined}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let before_hall = metaverse_core::Timestamp::parse_rfc3339(&hall_joined)
        .unwrap()
        .saturating_add_millis(-1);
    let reply = app
        .public(
            &format!("/api/public/spaces/hall/state?universe=street&at={before_hall}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::NOT_FOUND,
        "加入之前不能凭组合令牌读"
    );
    let reply = app
        .public(
            &format!(
                "/api/public/spaces/hall/events?universe=street&since={}",
                ago(60)
            ),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // 空间信息、快照、提交列表同样可以凭组合令牌读取。
    let reply = app
        .public("/api/public/spaces/hall?universe=street", Some(&share), &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["head"]["recordedAt"], Value::Null);
    assert!(reply.body["eventTypes"].is_array());
    // 现在是成员：带当前的公开锚点（第一次提交的 _space）。
    assert_eq!(reply.body["anchors"][0]["anchorId"], "_space");
    let hall_seq = reply.body["head"]["seq"].as_u64().unwrap();
    // 从来不是成员的空间：空间信息同样 404。
    assert_eq!(
        app.public(
            "/api/public/spaces/secret-shop?universe=street",
            Some(&share),
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let reply = app
        .public(
            &format!("/api/public/spaces/hall/snapshot?seq={hall_seq}&universe=street"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = app
        .public(
            &format!(
                "/api/public/spaces/hall/snapshot?at={}&universe=street",
                ago(0)
            ),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::FOUND, "{:?}", reply.body);
    assert_eq!(
        reply.headers.get("location").unwrap(),
        &format!("/api/public/spaces/hall/snapshot?seq={hall_seq}&universe=street")
    );
    let reply = app
        .public(
            "/api/public/spaces/hall/timeline?universe=street",
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(
        app.public("/api/public/spaces/hall/snapshot?seq=1", Some(&share), &[])
            .await
            .status,
        StatusCode::NOT_FOUND,
        "不带 ?universe= 时组合令牌不是这个空间的令牌"
    );
    assert_eq!(
        app.public(
            "/api/public/spaces/secret-shop/snapshot?seq=1&universe=street",
            Some(&share),
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    // 不是成员的空间、别的组合编号：404。
    assert_eq!(
        app.public(
            "/api/public/spaces/secret-shop/head?universe=street",
            Some(&share),
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.public(&format!("{head}?universe=alice-u"), Some(&share), &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // 轮换令牌：旧令牌失效，新令牌可用。
    let reply = patch(&app, who(ORG), json!({"rotateShareToken": true})).await;
    assert_eq!(reply.status, StatusCode::OK);
    let new_token = reply.body["shareToken"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        reply.body["universe"]["shareTokens"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        app.public("/api/public/universes/street", Some(&share), &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.public(&format!("{head}?universe=street"), Some(&share), &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let fresh = format!("Share {new_token}");
    assert_eq!(
        app.public("/api/public/universes/street", Some(&fresh), &[])
            .await
            .status,
        StatusCode::OK
    );

    // 退出：空间的管理者可以让自己的空间退出，连到它的连接一起去掉。
    let reply = app
        .call(
            who_with(OTHER_ORG, "stranger-token"),
            Method::DELETE,
            &format!("{U}/members/restaurant"),
            None,
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::NOT_FOUND,
        "别人不能让你的空间退出"
    );
    let reply = app
        .call(
            who(OTHER_ORG),
            Method::DELETE,
            &format!("{U}/members/flower-shop"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 6);
    let reply = app.call(who(ORG), Method::GET, U, None).await;
    assert_eq!(reply.body["links"], json!([]));
    assert_eq!(reply.body["members"].as_array().unwrap().len(), 2);
    let reply = app
        .call(
            who(OTHER_ORG),
            Method::DELETE,
            &format!("{U}/members/flower-shop"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    // 组合主人可以移除任何成员。
    let reply = app
        .call(who(ORG), Method::DELETE, &format!("{U}/members/hall"), None)
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // 退出之后凭组合令牌读不到 hall 的现在。
    assert_eq!(
        app.public(&format!("{head}?universe=street"), Some(&fresh), &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    // 但组合页回看 hall 还是成员的那段历史时要取得到空间信息（名称、事件显示规则），
    // 只是不给离开之后的区域、地块和锚点；快照按版本照常读。
    let reply = app
        .public("/api/public/spaces/hall?universe=street", Some(&fresh), &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["name"], "hall");
    assert!(reply.body["eventTypes"].is_array());
    assert_eq!(reply.body["anchors"], json!([]));
    assert_eq!(reply.body["regions"], json!([]));
    assert_eq!(reply.body["plots"], json!([]));
    assert!(reply
        .headers
        .get("cache-control")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("private"));
    assert_eq!(
        app.public(
            &format!("/api/public/spaces/hall/snapshot?seq={hall_seq}&universe=street"),
            Some(&fresh),
            &[]
        )
        .await
        .status,
        StatusCode::OK
    );
    // 令牌不对仍然 404。
    assert_eq!(
        app.public("/api/public/spaces/hall?universe=street", Some(&share), &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

// ---------------------------------------------------------------------------
// 成员期、删除空间、同编号重建、组合改公开（安全回归）
// ---------------------------------------------------------------------------

fn ts(text: &str) -> metaverse_core::Timestamp {
    metaverse_core::Timestamp::parse_rfc3339(text).unwrap()
}

/// 直接写一条公开的 seat.count 事件（事件写接口另有测试）。`at` 同时作为记录时间。
async fn insert_event(app: &TestApp, space: &str, owner: &str, id: &str, at: &str, n: i64) {
    app.collection("events")
        .insert_one(doc! {
            "_id": id, "spaceId": space, "owner": {"kind": "org", "id": owner},
            "at": at, "recordedAt": at, "source": "pos", "sourceEventId": id,
            "type": "seat.count", "typeVersion": 1_i32, "anchorId": "_space",
            "data": {"n": n}, "visibility": "public",
        })
        .await
        .unwrap();
}

/// 邀请 secret-shop（花店组织、凭链接查看）并由花店加入，返回加入时刻。
async fn invite_and_join_secret_shop(app: &TestApp) -> String {
    let reply = patch(app, who(ORG), json!({"invitations": ["secret-shop"]})).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = join(
        app,
        who(OTHER_ORG),
        "secret-shop",
        json!({"offset": [0, 0, 600], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    reply.body["at"].as_str().unwrap().to_owned()
}

fn item_ids(body: &Value) -> Vec<String> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn deleted_member_leaves_universe_and_recreated_id_is_not_a_member() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let share = format!("Share {}", setup(&app).await);
    let joined = invite_and_join_secret_shop(&app).await;
    // 花店删除空间：同时写一条退出修订，组合不再列出它。
    let reply = app
        .call(
            who(OTHER_ORG),
            Method::DELETE,
            "/api/v1/admin/spaces/secret-shop?confirm=secret-shop",
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{:?}", reply.body);
    let reply = app.call(who(ORG), Method::GET, U, None).await;
    assert_eq!(reply.body["members"], json!([]), "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 2);
    let revision = app
        .collection("commits")
        .find_one(doc! {"spaceId": "street", "seq": 2_i64})
        .await
        .unwrap()
        .unwrap();
    assert!(revision.get_str("message").unwrap().contains("已删除"));
    // 组合页（现在、回看加入时刻）都不报错；已删除的成员不出现。
    for path in [
        "/api/public/universes/street".to_owned(),
        format!("/api/public/universes/street?at={joined}"),
    ] {
        let reply = app.public(&path, Some(&share), &[]).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}: {:?}", reply.body);
        assert_eq!(reply.body["members"], json!([]), "{path}");
    }
    // 别人用同一个编号新建凭链接查看的空间：旧组合令牌读不到它的任何内容。
    app.create_space(who("alice"), "secret-shop", "person", "alice", "unlisted")
        .await;
    app.insert_anchor(
        "secret-shop",
        json!({"kind": "person", "id": "alice"}),
        json!({"anchorId": "alice-door", "kind": "door", "box": [0, 0, 0, 2, 40, 20], "visibility": "public"}),
    )
    .await;
    for path in [
        "/api/public/spaces/secret-shop?universe=street".to_owned(),
        "/api/public/spaces/secret-shop/head?universe=street".to_owned(),
        "/api/public/spaces/secret-shop/snapshot?seq=1&universe=street".to_owned(),
        "/api/public/spaces/secret-shop/timeline?universe=street".to_owned(),
        format!("/api/public/spaces/secret-shop/state?universe=street&at={joined}"),
    ] {
        let reply = app.public(&path, Some(&share), &[]).await;
        assert_eq!(
            reply.status,
            StatusCode::NOT_FOUND,
            "{path}: {:?}",
            reply.body
        );
    }
    let reply = app
        .public(
            &format!("/api/public/universes/street?at={joined}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.body["members"], json!([]));
}

#[tokio::test]
async fn dangling_member_from_old_deletion_is_skipped_not_inherited() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let share = format!("Share {}", setup(&app).await);
    // 先加入、再按旧版本的方式删除（只删空间文档，组合里还留着编号）。
    let joined = invite_and_join_secret_shop(&app).await;
    app.collection("spaces")
        .delete_one(doc! {"_id": "secret-shop"})
        .await
        .unwrap();
    // 成员空间不存在：组合页和修改都不是 500。
    let reply = app
        .public("/api/public/universes/street", Some(&share), &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["members"], json!([]));
    let reply = app
        .public(
            &format!("/api/public/universes/street?at={joined}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = patch(&app, who(ORG), json!({"links": []})).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = patch(&app, who(ORG), json!({"visibility": "public"})).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = patch(&app, who(ORG), json!({"visibility": "unlisted"})).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // 同编号被别人重建：修订里的旧编号不算新空间的成员资格。
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    app.create_space(who("alice"), "secret-shop", "person", "alice", "unlisted")
        .await;
    for path in [
        "/api/public/spaces/secret-shop?universe=street".to_owned(),
        "/api/public/spaces/secret-shop/head?universe=street".to_owned(),
        "/api/public/spaces/secret-shop/snapshot?seq=1&universe=street".to_owned(),
        format!(
            "/api/public/spaces/secret-shop/snapshot?at={}&universe=street",
            ago(0)
        ),
        format!(
            "/api/public/spaces/secret-shop/events?universe=street&since={}",
            ago(60)
        ),
    ] {
        let reply = app.public(&path, Some(&share), &[]).await;
        assert_eq!(
            reply.status,
            StatusCode::NOT_FOUND,
            "{path}: {:?}",
            reply.body
        );
    }
    let reply = app
        .public("/api/public/universes/street", Some(&share), &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["members"], json!([]), "新空间不出现在组合页");
}

#[tokio::test]
async fn universe_reads_are_clipped_to_membership_periods() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let share = format!("Share {}", setup(&app).await);
    let reply = app
        .call(
            who(OTHER_ORG),
            Method::POST,
            "/api/v1/admin/spaces/secret-shop/event-types",
            Some(
                json!({"type": "seat.count", "schema": {"type": "object"}, "publicFields": ["n"],
                        "defaultVisibility": "public", "display": {"kind": "label"}}),
            ),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let joined = invite_and_join_secret_shop(&app).await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let other = json!({"kind": "org", "id": OTHER_ORG});
    let inside = app
        .insert_commit("secret-shop", other.clone(), &ago(0), None)
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let reply = app
        .call(
            who(OTHER_ORG),
            Method::DELETE,
            &format!("{U}/members/secret-shop"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let left = reply.body["at"].as_str().unwrap().to_owned();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let after = app
        .insert_commit("secret-shop", other.clone(), &ago(0), None)
        .await;
    let (joined_t, left_t) = (ts(&joined), ts(&left));
    let mid = joined_t.saturating_add_millis(left_t.millis_since(joined_t) / 2);
    let before = joined_t.saturating_add_millis(-60_000).to_rfc3339();
    let during = mid.to_rfc3339();
    let later = left_t.saturating_add_millis(1).to_rfc3339();
    insert_event(&app, "secret-shop", OTHER_ORG, "ev_before", &before, 1).await;
    insert_event(&app, "secret-shop", OTHER_ORG, "ev_during", &during, 2).await;
    insert_event(&app, "secret-shop", OTHER_ORG, "ev_after", &later, 3).await;

    // 提交列表：只有成员期里的提交（加入前、离开后的都不出现）。
    let reply = app
        .public(
            "/api/public/spaces/secret-shop/timeline?universe=street",
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let seqs: Vec<i64> = reply.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(seqs, vec![inside], "离开后的 seq {after} 不能出现");
    assert_eq!(reply.body["nextAfter"], Value::Null);
    // 增量事件：从纪元开始也只有成员期里的事件。
    let reply = app
        .public(
            "/api/public/spaces/secret-shop/events?universe=street&since=1970-01-01T00:00:00Z",
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(
        reply.status,
        StatusCode::NOT_FOUND,
        "现在已不是成员：增量按现在判断"
    );
    let just_after = mid.saturating_add_millis(1).to_rfc3339();
    let reply = app
        .public(
            &format!(
                "/api/public/spaces/secret-shop/events?universe=street&since=1970-01-01T00:00:00Z&to={just_after}"
            ),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(item_ids(&reply.body), vec!["ev_during"]);
    // 时间窗跨过加入和离开：同样只有成员期里的。
    let window_from = joined_t.saturating_add_millis(-3_600_000).to_rfc3339();
    let window_to = left_t.saturating_add_millis(3_600_000).to_rfc3339();
    let reply = app
        .public(
            &format!("/api/public/spaces/secret-shop/events?universe=street&from={window_from}&to={window_to}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(item_ids(&reply.body), vec!["ev_during"]);
    // 密度：只数成员期里的。
    let reply = app
        .public(
            &format!("/api/public/spaces/secret-shop/events/density?universe=street&from={window_from}&to={window_to}&bucket=86400"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let total: u64 = reply.body["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|bucket| bucket["count"].as_u64().unwrap())
        .sum();
    assert_eq!(total, 1);
    // 离开之后的版本：快照 404；空间信息停在离开时的版本，不给离开后的 recordedAt。
    assert_eq!(
        app.public(
            &format!("/api/public/spaces/secret-shop/snapshot?seq={after}&universe=street"),
            Some(&share),
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    let reply = app
        .public(
            "/api/public/spaces/secret-shop?universe=street",
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["head"]["seq"], inside);
    assert_eq!(reply.body["head"]["recordedAt"], Value::Null);
    // 不经组合（空间自己的令牌）照常看得到全部。
    let own = app
        .collection("spaces")
        .find_one(doc! {"_id": "secret-shop"})
        .await
        .unwrap()
        .unwrap();
    let own_token = format!("Share {}", own_share_token(&app).await);
    let reply = app
        .public(
            "/api/public/spaces/secret-shop/timeline",
            Some(&own_token),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["items"].as_array().unwrap().len() as i64, after);
    assert!(own.get_document("head").is_ok());
}

/// 轮换 secret-shop 的分享令牌，返回新令牌原文。
async fn own_share_token(app: &TestApp) -> String {
    let reply = app
        .call(
            who(OTHER_ORG),
            Method::POST,
            "/api/v1/admin/spaces/secret-shop/share-tokens",
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{:?}", reply.body);
    reply.body["token"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn public_universe_does_not_expose_former_unlisted_members() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let share = format!("Share {}", setup(&app).await);
    let reply = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let joined = invite_and_join_secret_shop(&app).await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let reply = app
        .call(
            who(OTHER_ORG),
            Method::DELETE,
            &format!("{U}/members/secret-shop"),
            None,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // 只剩公开的餐厅：组合可以改成公开。
    let reply = patch(&app, who(ORG), json!({"visibility": "public"})).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    // 不带令牌：曾经的凭链接查看成员一律 404，组合页也不列出它。
    for path in [
        "/api/public/spaces/secret-shop?universe=street".to_owned(),
        "/api/public/spaces/secret-shop/timeline?universe=street".to_owned(),
        "/api/public/spaces/secret-shop/snapshot?seq=1&universe=street".to_owned(),
        format!("/api/public/spaces/secret-shop/state?universe=street&at={joined}"),
        format!(
            "/api/public/spaces/secret-shop/events?universe=street&since=1970-01-01T00:00:00Z&to={joined}"
        ),
    ] {
        let reply = app.public(&path, None, &[]).await;
        assert_eq!(
            reply.status,
            StatusCode::NOT_FOUND,
            "{path}: {:?}",
            reply.body
        );
    }
    let reply = app
        .public(
            &format!("/api/public/universes/street?at={joined}"),
            None,
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let members: Vec<&str> = reply.body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|member| member["spaceId"].as_str().unwrap())
        .collect();
    assert_eq!(members, vec!["restaurant"]);
    // 公开成员照常可读；带组合令牌时，曾经的成员仍按成员期可读（加入时同意过）。
    let reply = app
        .public("/api/public/spaces/restaurant?universe=street", None, &[])
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = app
        .public(
            "/api/public/spaces/secret-shop?universe=street",
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
}

#[tokio::test]
async fn snapshot_at_before_first_commit_via_universe_resolves_seq_zero() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let share = format!("Share {}", setup(&app).await);
    // 模拟第一次提交没写成：没有提交、head.seq = 0。
    app.collection("commits")
        .delete_many(doc! {"spaceId": "secret-shop"})
        .await
        .unwrap();
    app.collection("spaces")
        .update_one(
            doc! {"_id": "secret-shop"},
            doc! {"$set": {"head.seq": 0_i64}},
        )
        .await
        .unwrap();
    invite_and_join_secret_shop(&app).await;
    let reply = app
        .public(
            &format!(
                "/api/public/spaces/secret-shop/snapshot?at={}&universe=street",
                ago(0)
            ),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(reply.status, StatusCode::FOUND, "{:?}", reply.body);
    let location = reply
        .headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        location,
        "/api/public/spaces/secret-shop/snapshot?seq=0&universe=street"
    );
    let reply = app.public(&location, Some(&share), &[]).await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    assert_eq!(reply.body["seq"], 0);
    // 不是成员的空间：seq=0 同样 404。
    assert_eq!(
        app.public(
            "/api/public/spaces/hall/snapshot?seq=0&universe=street",
            Some(&share),
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn seq_zero_before_joining_stays_hidden() {
    let Some(app) = TestApp::start(&[]).await else {
        return;
    };
    let share = format!("Share {}", setup(&app).await);
    // 建空间时就有第一次提交：seq=0 只在创建那一刻之前生效，早于加入，凭组合读不到。
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    invite_and_join_secret_shop(&app).await;
    assert_eq!(
        app.public(
            "/api/public/spaces/secret-shop/snapshot?seq=0&universe=street",
            Some(&share),
            &[]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[test]
fn 可空样式设置区分省略空值空字符串与具体值() {
    use metaverse_api::routes::{
        admin_space_settings::UpdateSpaceRequest,
        universes::{MemberPlacement, UpdateUniverseRequest},
    };
    for (body, expected) in [
        (json!({}), None),
        (json!({"defaultStyleId": null, "themeId": null}), Some(None)),
        (json!({"defaultStyleId": "", "themeId": ""}), Some(None)),
        (
            json!({"defaultStyleId": "custom-room", "themeId": "custom-room"}),
            Some(Some("custom-room".to_owned())),
        ),
    ] {
        let mut space = body.clone();
        space.as_object_mut().unwrap().remove("themeId");
        let mut universe = body.clone();
        universe.as_object_mut().unwrap().remove("defaultStyleId");
        assert_eq!(
            serde_json::from_value::<UpdateSpaceRequest>(space)
                .unwrap()
                .default_style_id,
            expected
        );
        assert_eq!(
            serde_json::from_value::<UpdateUniverseRequest>(universe)
                .unwrap()
                .theme_id,
            expected
        );
        let mut member = json!({"spaceId": "restaurant", "offset": [0, 0, 0], "rotation": 0});
        if let Some(style_id) = body.get("themeId") {
            member["styleId"] = style_id.clone();
        }
        let placement = serde_json::from_value::<MemberPlacement>(member).unwrap();
        assert_eq!(placement.style_id, expected);
    }
}

#[test]
fn 组合样式接口契约使用可选可空的小驼峰字段() {
    let document = metaverse_api::openapi::full_document();
    let schemas = &document["components"]["schemas"];
    for (name, field) in [
        ("PublicRevisionState", "themeId"),
        ("MemberPlacement", "styleId"),
        ("UpdateSpaceRequest", "defaultStyleId"),
        ("UpdateUniverseRequest", "themeId"),
        ("JoinUniverseRequest", "styleId"),
    ] {
        let schema = &schemas[name];
        assert_eq!(
            schema["properties"][field]["type"],
            json!(["string", "null"]),
            "`{name}.{field}` 应为可空字符串"
        );
        assert!(schema["required"]
            .as_array()
            .is_none_or(|required| !required.contains(&json!(field))));
    }
    assert!(schemas["PublicRevisionState"]["properties"]
        .get("theme_id")
        .is_none());
}

#[tokio::test]
async fn 公开修订主题使用小驼峰字段并省略未设置主题() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接数据库");
    let share = format!("Share {}", setup(&app).await);
    for (theme, seq) in [(json!("voxel-world"), 1), (Value::Null, 2)] {
        let updated = patch(&app, who(ORG), json!({"themeId": theme})).await;
        assert_eq!(updated.status, StatusCode::OK, "{:?}", updated.body);
        assert_eq!(updated.body["universe"]["seq"], seq);
        let revision = app
            .public(
                &format!("/api/public/universes/street/revisions/{seq}"),
                Some(&share),
                &[],
            )
            .await;
        assert_eq!(revision.status, StatusCode::OK, "{:?}", revision.body);
        let state = &revision.body["state"];
        if theme.is_null() {
            assert!(
                state.get("themeId").is_none(),
                "未绑定主题时应省略 `themeId`"
            );
        } else {
            assert_eq!(state["themeId"], theme);
        }
        assert!(
            state.get("theme_id").is_none(),
            "修订不得返回蛇形字段 `theme_id`"
        );
    }
}

#[tokio::test]
async fn 首次修订之前的公开历史不包含未来主题() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接数据库");
    let share = format!("Share {}", setup(&app).await);
    let joined = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0}),
    )
    .await;
    assert_eq!(joined.status, StatusCode::OK, "{:?}", joined.body);
    let first_at =
        metaverse_core::Timestamp::parse_rfc3339(joined.body["at"].as_str().unwrap()).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let themed = patch(&app, who(ORG), json!({"themeId": "voxel-world"})).await;
    assert_eq!(themed.status, StatusCode::OK, "{:?}", themed.body);
    let themed_at =
        metaverse_core::Timestamp::parse_rfc3339(themed.body["universe"]["at"].as_str().unwrap())
            .unwrap();
    assert!(themed_at > first_at);
    for (at, seq, theme) in [
        (first_at.saturating_add_millis(-1), 0, None),
        (first_at, 1, None),
        (themed_at, 2, Some("voxel-world")),
        (themed_at.saturating_add_millis(1), 2, Some("voxel-world")),
    ] {
        let public = app
            .public(
                &format!("/api/public/universes/street?at={at}"),
                Some(&share),
                &[],
            )
            .await;
        assert_eq!(public.status, StatusCode::OK, "{:?}", public.body);
        assert_eq!(public.body["seq"], seq);
        if let Some(theme) = theme {
            assert_eq!(public.body["themeId"], theme);
        } else {
            assert!(
                public.body.get("themeId").is_none(),
                "历史时刻不得泄漏未来的 `themeId`"
            );
        }
        if seq == 0 {
            assert_eq!(public.body["members"], json!([]));
            assert_eq!(public.body["links"], json!([]));
        }
    }
}

#[tokio::test]
async fn 加入成员校验样式编号并归一化空样式() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接数据库");
    let share = format!("Share {}", setup(&app).await);
    for style_id in [
        ".hidden".to_owned(),
        "with space".to_owned(),
        "with:colon".to_owned(),
        "样式".to_owned(),
        "trailing\n".to_owned(),
        "a".repeat(129),
    ] {
        let reply = join(
            &app,
            who(ORG),
            "restaurant",
            json!({"offset": [0, 0, 0], "rotation": 0, "styleId": style_id}),
        )
        .await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "非法成员样式编号 `{style_id}` 应被拒绝：{:?}",
            reply.body
        );
    }
    let reply = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0, "styleId": "Studio_01.v2"}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    let reply = join(
        &app,
        who(ORG),
        "hall",
        json!({"offset": [160, 0, 0], "rotation": 0, "styleId": ""}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);

    let managed = app.call(who(ORG), Method::GET, U, None).await;
    let public = app
        .public("/api/public/universes/street", Some(&share), &[])
        .await;
    for reply in [managed, public] {
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        let members = reply.body["members"].as_array().unwrap();
        assert_eq!(members.len(), 2);
        let custom = members
            .iter()
            .find(|m| m["spaceId"] == "restaurant")
            .unwrap();
        assert_eq!(custom["styleId"], "Studio_01.v2");
        let cleared = members.iter().find(|m| m["spaceId"] == "hall").unwrap();
        assert!(cleared.get("styleId").is_none(), "空样式编号应被清除");
    }
    let persisted = app
        .collection("spaces")
        .find_one(doc! {"_id": "street"})
        .await
        .unwrap()
        .unwrap();
    let members = persisted.get_array("members").unwrap();
    assert_eq!(
        members[0]
            .as_document()
            .unwrap()
            .get_str("styleId")
            .unwrap(),
        "Studio_01.v2"
    );
    assert!(members[1].as_document().unwrap().get("styleId").is_none());
}

#[tokio::test]
async fn 组合更新校验成员样式与主题编号() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接数据库");
    let share = format!("Share {}", setup(&app).await);
    let reply = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0}),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    for id in [
        "arch-realistic".to_owned(),
        "voxel-world".to_owned(),
        "A".to_owned(),
        "_".to_owned(),
        "-".to_owned(),
        "a".repeat(128),
        "Studio_01.v2".to_owned(),
    ] {
        let reply = patch(
            &app,
            who(ORG),
            json!({"members": [{"spaceId": "restaurant", "offset": [0, 0, 0], "rotation": 0, "styleId": id}], "themeId": id}),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        assert_eq!(reply.body["universe"]["members"][0]["styleId"], id);
        assert_eq!(reply.body["universe"]["themeId"], id);
    }
    let managed = app.call(who(ORG), Method::GET, U, None).await;
    let seq = managed.body["seq"].clone();
    assert_eq!(managed.body["members"][0]["styleId"], "Studio_01.v2");
    assert_eq!(managed.body["themeId"], "Studio_01.v2");
    let public = app
        .public("/api/public/universes/street", Some(&share), &[])
        .await;
    assert_eq!(public.status, StatusCode::OK, "{:?}", public.body);
    assert_eq!(public.body["members"][0]["styleId"], "Studio_01.v2");
    assert_eq!(public.body["themeId"], "Studio_01.v2");

    for id in [
        ".hidden".to_owned(),
        "with space".to_owned(),
        "with:colon".to_owned(),
        "样式".to_owned(),
        "trailing\n".to_owned(),
        "a".repeat(129),
    ] {
        for body in [
            json!({"members": [{"spaceId": "restaurant", "offset": [160, 0, 0], "rotation": 90, "styleId": id}]}),
            json!({"themeId": id}),
        ] {
            let reply = patch(&app, who(ORG), body).await;
            assert_eq!(
                reply.status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "非法样式或主题编号 `{id}` 应被拒绝：{:?}",
                reply.body
            );
        }
    }
    let unchanged = app.call(who(ORG), Method::GET, U, None).await;
    assert_eq!(unchanged.body["seq"], seq, "非法请求不能新增修订");
    assert_eq!(unchanged.body["members"], managed.body["members"]);
    assert_eq!(unchanged.body["themeId"], "Studio_01.v2");
}

#[tokio::test]
async fn 组合更新清除可空设置并保留省略的成员样式() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接数据库");
    let share = format!("Share {}", setup(&app).await);
    let joined = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0, "styleId": "night-neon"}),
    )
    .await;
    assert_eq!(joined.status, StatusCode::OK, "{:?}", joined.body);
    let moved = patch(
        &app,
        who(ORG),
        json!({"members": [{"spaceId": "restaurant", "offset": [160, 0, 0], "rotation": 90}]}),
    )
    .await;
    assert_eq!(moved.status, StatusCode::OK, "{:?}", moved.body);
    assert_eq!(
        moved.body["universe"]["members"][0]["styleId"],
        "night-neon"
    );
    for clear in [Value::Null, json!("")] {
        let bound = patch(&app, who(ORG), json!({"members": [{"spaceId": "restaurant", "offset": [160, 0, 0], "rotation": 90, "styleId": "night-neon"}]})).await;
        assert_eq!(bound.status, StatusCode::OK, "{:?}", bound.body);
        let seq = bound.body["universe"]["seq"].as_u64().unwrap();
        let retained = patch(
            &app,
            who(ORG),
            json!({"members": [{"spaceId": "restaurant", "offset": [160, 0, 0], "rotation": 90}]}),
        )
        .await;
        assert_eq!(retained.status, StatusCode::OK, "{:?}", retained.body);
        assert_eq!(
            retained.body["universe"]["members"][0]["styleId"],
            "night-neon"
        );
        assert_eq!(
            retained.body["universe"]["seq"], seq,
            "省略 `styleId` 应保留原值且不新增修订"
        );

        let body = json!({"members": [{"spaceId": "restaurant", "offset": [160, 0, 0], "rotation": 90, "styleId": clear}]});
        let cleared = patch(&app, who(ORG), body.clone()).await;
        assert_eq!(cleared.status, StatusCode::OK, "{:?}", cleared.body);
        assert_eq!(
            cleared.body["universe"]["seq"],
            seq + 1,
            "清除 `styleId` 必须新增修订"
        );
        assert!(cleared.body["universe"]["members"][0]
            .get("styleId")
            .is_none());
        let managed = app.call(who(ORG), Method::GET, U, None).await;
        let public = app
            .public("/api/public/universes/street", Some(&share), &[])
            .await;
        for reply in [managed, public] {
            assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
            assert_eq!(reply.body["seq"], seq + 1);
            assert!(reply.body["members"][0].get("styleId").is_none());
        }
        let revision = app
            .public(
                &format!("/api/public/universes/street/revisions/{}", seq + 1),
                Some(&share),
                &[],
            )
            .await;
        assert_eq!(revision.status, StatusCode::OK, "{:?}", revision.body);
        assert!(revision.body["state"]["members"][0]
            .get("styleId")
            .is_none());
        let repeated = patch(&app, who(ORG), body).await;
        assert_eq!(repeated.status, StatusCode::OK, "{:?}", repeated.body);
        assert_eq!(
            repeated.body["universe"]["seq"],
            seq + 1,
            "重复清除不应新增修订"
        );
    }

    for clear in [Value::Null, json!("")] {
        let reply = patch(&app, who(ORG), json!({"themeId": "voxel-world"})).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        let reply = patch(&app, who(ORG), json!({"name": "保留主题"})).await;
        assert_eq!(reply.body["universe"]["themeId"], "voxel-world");
        let reply = patch(&app, who(ORG), json!({"themeId": clear})).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        assert!(reply.body["universe"].get("themeId").is_none());
        let persisted = app.call(who(ORG), Method::GET, U, None).await;
        assert!(persisted.body.get("themeId").is_none());

        let path = "/api/v1/admin/spaces/restaurant";
        let reply = app
            .call(
                who(ORG),
                Method::PATCH,
                path,
                Some(json!({"defaultStyleId": "voxel-blocks"})),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        let reply = app
            .call(
                who(ORG),
                Method::PATCH,
                path,
                Some(json!({"name": "保留样式"})),
            )
            .await;
        assert_eq!(reply.body["defaultStyleId"], "voxel-blocks");
        let reply = app
            .call(
                who(ORG),
                Method::PATCH,
                path,
                Some(json!({"defaultStyleId": clear})),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
        assert!(reply.body.get("defaultStyleId").is_none());
        let persisted = app
            .collection("spaces")
            .find_one(doc! {"_id": "restaurant"})
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            persisted.get("defaultStyleId"),
            None | Some(mongodb::bson::Bson::Null)
        ));
    }
}

#[tokio::test]
async fn 命名样式图层保存并投影到公开空间和快照() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接数据库");
    app.create_space(who(ORG), "layer-room", "org", ORG, "public")
        .await;
    let path = "/api/v1/admin/spaces/layer-room";
    let styles = json!([
        {"id": "extension-only", "name": "扩展展区", "visibleLayers": ["ext"], "filterKinds": ["object"]},
        {"id": "rebuilt-only", "name": "重建层", "visibleLayers": ["rebuilt"]},
        {"id": "overlay", "name": "扫描叠加", "visibleLayers": ["scan", "rebuilt", "ext"]},
        {"id": "legacy", "name": "旧模式", "mode": "optimized"},
        {"id": "empty", "name": "隐藏内容", "visibleLayers": []}
    ]);
    let saved = app
        .call(
            who(ORG),
            Method::PATCH,
            path,
            Some(json!({"styles": styles, "defaultStyleId": "extension-only"})),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{:?}", saved.body);
    assert_eq!(saved.body["styles"], styles);
    for url in [
        "/api/public/spaces/layer-room",
        "/api/public/spaces/layer-room/snapshot?seq=0",
    ] {
        let public = app.public(url, None, &[]).await;
        assert_eq!(public.status, StatusCode::OK, "{:?}", public.body);
        assert_eq!(public.body["styles"], styles);
        assert_eq!(public.body["defaultStyleId"], "extension-only");
    }
    for (field, value) in [
        ("visibleLayers", json!([""])),
        ("visibleLayers", json!(["unknown"])),
        ("visibleLayers", json!(["ext", "ext"])),
        ("filterKinds", json!([""])),
        ("filterKinds", json!(["template"])),
        ("filterKinds", json!(["object", "object"])),
    ] {
        let mut invalid = json!({"id": "invalid", "name": "非法样式"});
        invalid[field] = value;
        let reply = app
            .call(
                who(ORG),
                Method::PATCH,
                path,
                Some(json!({"styles": [invalid]})),
            )
            .await;
        assert_eq!(
            reply.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{:?}",
            reply.body
        );
    }
    let unchanged = app.public("/api/public/spaces/layer-room", None, &[]).await;
    assert_eq!(unchanged.body["styles"], styles);
}

fn assert_chinese_style_problem(reply: &Reply) {
    assert_eq!(
        reply.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        reply.body
    );
    assert_eq!(reply.body["code"], "invalid_request");
    let detail = reply.body["detail"].as_str().unwrap();
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
async fn 组合主题及更新加入成员样式的完整中文错误与逐次存储不变矩阵() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接真实数据库");
    setup(&app).await;
    let joined = join(
        &app,
        who(ORG),
        "restaurant",
        json!({"offset": [0, 0, 0], "rotation": 0, "styleId": "saved"}),
    )
    .await;
    assert_eq!(joined.status, StatusCode::OK, "{:?}", joined.body);
    let themed = patch(&app, who(ORG), json!({"themeId": "saved"})).await;
    assert_eq!(themed.status, StatusCode::OK, "{:?}", themed.body);
    let before = app
        .collection("spaces")
        .find_one(doc! {"_id": "street"})
        .await
        .unwrap()
        .unwrap();
    let revision_count = app
        .collection("commits")
        .count_documents(doc! {"spaceId": "street", "composition": {"$exists": true}})
        .await
        .unwrap();
    let mut count = 0;
    for id in [
        json!(true),
        json!(false),
        json!(42),
        json!(0.5),
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
        for (method, path, body) in [
            (Method::PATCH, U.to_owned(), json!({"themeId": id})),
            (
                Method::PATCH,
                U.to_owned(),
                json!({"members": [{"spaceId": "restaurant", "offset": [0, 0, 0], "rotation": 0, "styleId": id}]}),
            ),
            (
                Method::POST,
                format!("{U}/members/hall"),
                json!({"offset": [0, 0, 0], "rotation": 0, "styleId": id}),
            ),
        ] {
            let reply = app.call(who(ORG), method, &path, Some(body)).await;
            assert_chinese_style_problem(&reply);
            let after = app
                .collection("spaces")
                .find_one(doc! {"_id": "street"})
                .await
                .unwrap()
                .unwrap();
            assert_eq!(after, before, "每次拒绝均不得改变完整组合文档和修订序号");
            assert_eq!(
                app.collection("commits")
                    .count_documents(doc! {"spaceId": "street", "composition": {"$exists": true}})
                    .await
                    .unwrap(),
                revision_count,
                "拒绝不得新增修订文档"
            );
            count += 1;
        }
    }
    println!("组合完整中文说明及数据库不变矩阵：{count} 例");
}

#[tokio::test]
async fn 加入成员省略或空值均不绑定样式() {
    let app = TestApp::start(&[]).await.expect("本测试必须连接真实数据库");
    setup(&app).await;
    for (space, body) in [
        ("restaurant", json!({"offset": [0, 0, 0], "rotation": 0})),
        (
            "hall",
            json!({"offset": [0, 0, 0], "rotation": 0, "styleId": null}),
        ),
    ] {
        let reply = join(&app, who(ORG), space, body).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    let managed = app.call(who(ORG), Method::GET, U, None).await;
    assert_eq!(managed.body["seq"], 2);
    for member in managed.body["members"].as_array().unwrap() {
        assert!(member.get("styleId").is_none());
    }
    let stored = app
        .collection("spaces")
        .find_one(doc! {"_id": "street"})
        .await
        .unwrap()
        .unwrap();
    for member in stored.get_array("members").unwrap() {
        assert!(member.as_document().unwrap().get("styleId").is_none());
    }
}
