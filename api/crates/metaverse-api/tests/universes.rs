//! 组合宇宙的集成测试：创建、加入（主人 / 邀请）、修改（摆放、连接、可见性、令牌）、退出、
//! 公开读（按时刻的修订和成员 seq、某次修订），以及凭组合令牌读成员空间的公开数据。

mod ingest_support;

use axum::http::{Method, StatusCode};
use ingest_support::*;
use mongodb::bson::doc;
use serde_json::{json, Value};

const U: &str = "/api/v1/universes/street";

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
        .collection("universeRevisions")
        .find_one(doc! {"universeId": "street", "seq": 2_i64})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revision.get_str("_id").unwrap(), "street:2");
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
