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
        .collection("universeRevisions")
        .find_one(doc! {"universeId": "street", "seq": 2_i64})
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
