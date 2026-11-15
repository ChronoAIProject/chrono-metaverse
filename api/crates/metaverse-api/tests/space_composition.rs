//! 原生空间组合：自身内容、嵌套实例、共享历史、授权、迁移和并发图约束。
mod ingest_support;

use axum::http::{Method, StatusCode};
use ingest_support::*;
use mongodb::bson::doc;
use serde_json::json;

async fn add(app: &TestApp, parent: &str, child: &str, offset: [i64; 3], rotation: u16) -> Reply {
    app.call(
        who(ORG),
        Method::POST,
        &format!("/api/v1/spaces/{parent}/children/{child}"),
        Some(json!({"offset": offset, "rotation": rotation})),
    )
    .await
}

async fn create(app: &TestApp, id: &str) -> String {
    app.create_space(who(ORG), id, "org", ORG, "unlisted").await
}

#[tokio::test]
async fn 自身与多路径子空间共用历史并逐级变换且允许自身锚点连接() {
    let app = TestApp::start(&[]).await.expect("需要真实数据库");
    let token = create(&app, "root").await;
    for id in ["left", "right", "leaf"] {
        create(&app, id).await;
    }
    for (parent, child, offset, rotation) in [
        ("left", "leaf", [2, 3, 4], 90),
        ("right", "leaf", [0, 0, 0], 0),
        ("root", "left", [100, 20, 200], 90),
        ("root", "right", [-100, 0, 0], 0),
    ] {
        let reply = add(&app, parent, child, offset, rotation).await;
        assert_eq!(reply.status, StatusCode::OK, "{:?}", reply.body);
    }
    for id in ["root", "left"] {
        app.insert_anchor(
            id,
            json!({"kind":"org","id":ORG}),
            json!({"anchorId":"door","kind":"door","position":[0,0,0],"visibility":"public"}),
        )
        .await;
    }
    let linked = app.call(who(ORG), Method::PATCH, "/api/v1/spaces/root/composition", Some(json!({
        "links": [{"from":{"spaceId":"root","anchorId":"door"},"to":{"spaceId":"left","anchorId":"door"},"kind":"door"}]
    }))).await;
    assert_eq!(linked.status, StatusCode::OK, "{:?}", linked.body);
    let composition_seq = linked.body["composition"]["seq"].as_u64().unwrap();
    let seq = app
        .insert_commit("root", json!({"kind":"org","id":ORG}), &ago(0), None)
        .await;
    assert_eq!(
        seq as u64,
        composition_seq + 1,
        "模型和组合必须共用提交序号"
    );
    let share = format!("Share {token}");
    let snapshot = app
        .public(
            &format!("/api/public/spaces/root/snapshot?seq={seq}"),
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(snapshot.status, StatusCode::OK, "{:?}", snapshot.body);
    assert_eq!(
        snapshot.body["composition"]["members"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let view = app
        .public("/api/public/spaces/root/scene", Some(&share), &[])
        .await;
    assert_eq!(view.status, StatusCode::OK, "{:?}", view.body);
    assert_eq!(view.body["seq"], seq);
    let members = view.body["members"].as_array().unwrap();
    assert_eq!(members.len(), 5, "必须包含自身和两次独立的 leaf 实例");
    let leaf = members
        .iter()
        .find(|member| member["spaceId"] == "root/left/leaf")
        .unwrap();
    assert_eq!(leaf["sourceSpaceId"], "leaf");
    assert_eq!(leaf["accessPath"], "root/left");
    assert_eq!(leaf["offset"], json!([104, 23, 198]));
    assert_eq!(leaf["rotation"], 180);
    assert_eq!(view.body["links"][0]["from"]["spaceId"], "root");
    assert_eq!(view.body["links"][0]["to"]["spaceId"], "root/left");
    for (path, status) in [
        ("leaf?universe=root/left", StatusCode::OK),
        ("leaf?universe=root/right", StatusCode::OK),
        ("leaf?universe=root", StatusCode::NOT_FOUND),
        ("leaf?universe=root/left/root", StatusCode::NOT_FOUND),
        ("leaf?universe=root/leaf", StatusCode::NOT_FOUND),
    ] {
        let reply = app
            .public(&format!("/api/public/spaces/{path}"), Some(&share), &[])
            .await;
        assert_eq!(reply.status, status, "{path}: {:?}", reply.body);
    }
    assert_eq!(
        app.public("/api/public/spaces/root/scene", None, &[])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.collection("universes")
            .count_documents(doc! {})
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        app.collection("universeRevisions")
            .count_documents(doc! {})
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn 自引用和并发反向引用不会形成循环且不留下多余提交() {
    let app = TestApp::start(&[]).await.expect("需要真实数据库");
    for id in ["space-a", "space-b"] {
        create(&app, id).await;
    }
    let before = app
        .collection("commits")
        .count_documents(doc! {})
        .await
        .unwrap();
    assert_eq!(
        add(&app, "space-a", "space-a", [0, 0, 0], 0).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        app.collection("commits")
            .count_documents(doc! {})
            .await
            .unwrap(),
        before
    );
    let (a, b) = tokio::join!(
        add(&app, "space-a", "space-b", [0, 0, 0], 0),
        add(&app, "space-b", "space-a", [0, 0, 0], 0)
    );
    let statuses = [a.status, b.status];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1,
        "{:?} {:?}",
        a.body,
        b.body
    );
    assert!(statuses.iter().any(
        |status| *status == StatusCode::CONFLICT || *status == StatusCode::UNPROCESSABLE_ENTITY
    ));
    assert_eq!(
        app.collection("commits")
            .count_documents(doc! {})
            .await
            .unwrap(),
        before + 1
    );
}

#[tokio::test]
async fn 嵌套历史取每层成员期交集且退出后不能读取当前版本() {
    let app = TestApp::start(&[]).await.expect("需要真实数据库");
    let token = create(&app, "root").await;
    for id in ["child", "leaf"] {
        create(&app, id).await;
    }
    app.collection("spaces")
        .update_many(doc! {}, doc! {"$set":{"createdAt":ago(3600)}})
        .await
        .unwrap();
    for (parent, child, age) in [("root", "child", 300), ("child", "leaf", 200)] {
        assert_eq!(
            add(&app, parent, child, [0, 0, 0], 0).await.status,
            StatusCode::OK
        );
        app.collection("commits")
            .update_one(
                doc! {"spaceId":parent,"composition":{"$exists":true}},
                doc! {"$set":{"at":ago(age)}},
            )
            .await
            .unwrap();
    }
    let departed = app
        .call(
            who(ORG),
            Method::DELETE,
            "/api/v1/spaces/root/children/child",
            None,
        )
        .await;
    assert_eq!(departed.status, StatusCode::OK, "{:?}", departed.body);
    app.collection("commits")
        .update_one(
            doc! {"spaceId":"root","seq":departed.body["seq"].as_i64().unwrap()},
            doc! {"$set":{"at":ago(100)}},
        )
        .await
        .unwrap();
    let share = format!("Share {token}");
    for (age, count) in [(250, 2), (150, 3), (50, 1)] {
        let scene = app
            .public(
                &format!("/api/public/spaces/root/scene?at={}", ago(age)),
                Some(&share),
                &[],
            )
            .await;
        assert_eq!(scene.status, StatusCode::OK, "{:?}", scene.body);
        assert_eq!(scene.body["members"].as_array().unwrap().len(), count);
    }
    for (age, status) in [
        (250, StatusCode::NOT_FOUND),
        (150, StatusCode::OK),
        (50, StatusCode::NOT_FOUND),
    ] {
        let state = app
            .public(
                &format!(
                    "/api/public/spaces/leaf/state?universe=root/child&at={}",
                    ago(age)
                ),
                Some(&share),
                &[],
            )
            .await;
        assert_eq!(state.status, status, "{:?}", state.body);
    }
}

#[tokio::test]
async fn 旧组合迁移保留令牌修订和主人并能并发重复执行() {
    let app = TestApp::start(&[]).await.expect("需要真实数据库");
    let token = "legacy-token-0123456789abcdef01234567";
    let at = ago(100);
    app.collection("universes").insert_one(doc! {
        "_id":"legacy", "name":"旧街区", "owner":{"kind":"person","id":"alice"}, "visibility":"unlisted",
        "shareTokens":[{"id":"token","hash":metaverse_core::sha256_hex(token.as_bytes()),"createdAt":&at}],
        "head":{"seq":1_i64,"at":&at}, "createdAt":ago(200), "members":[], "links":[], "themeId":"blueprint-atlas"
    }).await.unwrap();
    app.collection("universeRevisions").insert_one(doc! {
        "_id":"legacy:1", "universeId":"legacy", "seq":1_i64, "at":&at,
        "actor":{"sub":"alice","nyxServiceId":SERVICE,"scope":"physical","kind":"admin"}, "message":"旧摆放",
        "state":{"members":[],"links":[],"themeId":"blueprint-atlas"}
    }).await.unwrap();
    let (a, b) = tokio::join!(
        app.state.repo.prepare_space_composition(),
        app.state.repo.prepare_space_composition()
    );
    a.unwrap();
    b.unwrap();
    app.state.repo.prepare_space_composition().await.unwrap();
    let share = format!("Share {token}");
    let scene = app
        .public("/api/public/spaces/legacy/scene", Some(&share), &[])
        .await;
    assert_eq!(scene.status, StatusCode::OK, "{:?}", scene.body);
    assert_eq!(scene.body["themeId"], "blueprint-atlas");
    let snapshot = app
        .public(
            "/api/public/spaces/legacy/snapshot?seq=1",
            Some(&share),
            &[],
        )
        .await;
    assert_eq!(snapshot.status, StatusCode::OK, "{:?}", snapshot.body);
    assert_eq!(snapshot.body["composition"]["themeId"], "blueprint-atlas");
    assert_eq!(
        app.collection("commits")
            .count_documents(doc! {"spaceId":"legacy"})
            .await
            .unwrap(),
        1
    );
    let stored = app
        .collection("commits")
        .find_one(doc! {"spaceId":"legacy"})
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.get_document("owner").unwrap(),
        &doc! {"kind":"person","id":"alice"}
    );
    let old = app
        .collection("universes")
        .find_one(doc! {"_id":"legacy"})
        .await
        .unwrap()
        .unwrap();
    assert!(old.get_bool("migratedToSpace").unwrap());
    // 旧链接使用的协议仍读取迁移后的同一份状态。
    assert_eq!(
        app.public("/api/public/universes/legacy", Some(&share), &[])
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn 旧组合与现有空间同名时拒绝迁移且保持双方数据() {
    let app = TestApp::start(&[]).await.expect("需要真实数据库");
    create(&app, "collision").await;
    let before = app
        .collection("spaces")
        .find_one(doc! {"_id":"collision"})
        .await
        .unwrap()
        .unwrap();
    app.collection("universes").insert_one(doc! {
        "_id":"collision", "name":"旧组合", "owner":{"kind":"person","id":"alice"}, "visibility":"unlisted",
        "head":{"seq":0_i64,"at":ago(100)}, "createdAt":ago(100), "members":[], "links":[]
    }).await.unwrap();
    let error = app
        .state
        .repo
        .prepare_space_composition()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("冲突"));
    assert_eq!(
        app.collection("spaces")
            .find_one(doc! {"_id":"collision"})
            .await
            .unwrap()
            .unwrap(),
        before
    );
    assert!(!app
        .collection("universes")
        .find_one(doc! {"_id":"collision"})
        .await
        .unwrap()
        .unwrap()
        .get_bool("migratedToSpace")
        .unwrap_or(false));
}
