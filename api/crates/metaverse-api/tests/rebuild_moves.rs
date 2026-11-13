mod timeline_support;

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};
use timeline_support::TestApp;

const REBUILD: &str = "metaverse:rebuild:write";
const BASE: &str = "/api/v1/spaces/moving";

async fn call(app: &TestApp, path: &str, body: Value) -> timeline_support::Reply {
    app.org_with(&[], Method::POST, path, Some(body)).await
}

async fn fixture(app: &TestApp) -> Value {
    fixture_with_model(app, false).await
}

async fn fixture_with_model(app: &TestApp, model: bool) -> Value {
    app.create_space("moving").await;
    let mut entity = json!({"entityId":"rb.robot","layer":"rebuilt","kind":"object","label":"机器狗",
        "shape":{"type":"box","size":[1,1,1],"transform":{"position":[0,0,0]}},
        "bounds":{"min":[-0.5,0,-0.5],"max":[0.5,1,0.5]},"props":{"testAttribution":"original attribution"}});
    let mut files = vec![];
    if model {
        let bytes =
            include_bytes!("../../metaverse-core/tests/vectors/check/glb_model_triangle.glb");
        let hash = app
            .put_checked_asset(
                "moving",
                bytes,
                "model/gltf-binary",
                "model",
                timeline_support::glb_check([-0.5, 0.0, -0.5], [0.5, 1.0, 0.5], 1),
            )
            .await;
        entity.as_object_mut().unwrap().remove("shape");
        entity["assetHash"] = json!(hash);
        entity["transform"] = json!({"yaw":82});
        entity["material"] = json!({"shading":"albedo"});
        // The measured triangle's X/Z extent after the preserved 82 degree yaw.
        entity["bounds"] = json!({"min":[-0.565,0,-0.565],"max":[0.565,1,0.565]});
        entity["props"] = json!({"source":{"library":"objaverse","id":"model-test",
            "page":"https://sketchfab.com/3d-models/model-test","author":"Test author",
            "license":"CC-BY-4.0","title":"Robot model"}});
        files.push(
            json!({"path":"models/robot.glb","purpose":"model","sha256":hash,"size":bytes.len()}),
        );
    }
    let manifest = json!({"format":"chrono-metaverse-rebuild-bundle","version":1,
        "tool":{"name":"test","version":"1"},"note":"original","createdAt":"2026-11-01T00:00:00.000Z",
        "rebuilt":{"mode":"merge","entities":[entity],"templates":[
            {"entityId":"rb.template","layer":"rebuilt","kind":"template",
             "shape":{"type":"box","size":[1,1,1]},
             "bounds":{"min":[-0.5,0,-0.5],"max":[0.5,1,0.5]}}
        ]},"files":files});
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let hash = app
        .put_checked_asset(
            "moving",
            &bytes,
            "application/json",
            "bundle",
            mongodb::bson::doc! {"v":1,"format":"json"},
        )
        .await;
    let d = call(app, &format!("{BASE}/rebuild/drafts"), json!({})).await;
    assert_eq!(d.status, StatusCode::CREATED);
    let path = format!("{BASE}/rebuild/drafts/{}", d.body["id"].as_str().unwrap());
    let j = call(app, &format!("{path}/bundle"), json!({"assetHash":hash})).await;
    assert_eq!(j.status, StatusCode::ACCEPTED);
    let job = app.wait_job(j.body["jobId"].as_str().unwrap()).await;
    assert_eq!(job.get_str("status").unwrap(), "done", "{job:?}");
    let p = call(
        app,
        &format!("{path}/publish"),
        json!({"rev":1,"replay":false}),
    )
    .await;
    assert_eq!(p.status, StatusCode::OK, "{:?}", p.body);
    app.org(Method::GET, &format!("{BASE}/snapshot"), None)
        .await
        .body
}

fn moving(snapshot: &Value) -> Value {
    json!({"rev":0,"moves":[{"entityId":"rb.robot","expectedHash":snapshot["entities"][0]["hash"],"offset":[2,0,3]}]})
}

async fn draft(app: &TestApp) -> String {
    let d = call(app, &format!("{BASE}/rebuild/drafts"), json!({})).await;
    assert_eq!(d.status, StatusCode::CREATED, "{:?}", d.body);
    format!("{BASE}/rebuild/drafts/{}", d.body["id"].as_str().unwrap())
}

#[tokio::test]
async fn rebuilt_moves_preserve_data_preview_before_publish_and_reject_duplicate() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let snapshot = fixture(&app).await;
    let path = draft(&app).await;
    let input = moving(&snapshot);
    let r = call(&app, &format!("{path}/moves"), input.clone()).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{:?}", r.body);
    let job = app.wait_job(r.body["jobId"].as_str().unwrap()).await;
    assert_eq!(job.get_str("status").unwrap(), "done", "{job:?}");
    let again = call(&app, &format!("{path}/moves"), input).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    let unchanged = app
        .org(Method::GET, &format!("{BASE}/snapshot"), None)
        .await
        .body;
    assert_eq!(unchanged, snapshot);
    let p = call(&app, &format!("{path}/preview"), json!({"ttlSeconds":3600})).await;
    assert_eq!(p.status, StatusCode::CREATED, "{:?}", p.body);
    let preview = app
        .public(
            "/api/public/previews",
            Some(&format!("Preview {}", p.body["token"].as_str().unwrap())),
        )
        .await;
    assert_eq!(preview.status, StatusCode::OK);
    let mut expected = snapshot["entities"][0]["body"].clone();
    expected["bounds"] = json!({"min":[1.5,0.0,2.5],"max":[2.5,1.0,3.5]});
    expected["shape"]["transform"]["position"] = json!([2.0, 0.0, 3.0]);
    assert_eq!(preview.body["entities"][0]["body"], expected);
    assert_eq!(p.body["rev"], 1);
    // A read-only member cannot publish even with the legacy platform permission.
    let token = timeline_support::identity_with("bob", &[REBUILD]);
    let denied = app
        .send(
            Method::POST,
            &format!("{path}/publish"),
            &[
                ("x-nyxid-identity-token", token.as_str()),
                ("authorization", "Bearer member-token"),
            ],
            timeline_support::Payload::Json(json!({"rev":1})),
        )
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    let stale = call(
        &app,
        &format!("{path}/publish"),
        json!({"rev":0,"replay":false}),
    )
    .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    let published = call(
        &app,
        &format!("{path}/publish"),
        json!({"rev":1,"replay":false,"message":"confirmed test preview"}),
    )
    .await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.body);
    let after = app
        .org(Method::GET, &format!("{BASE}/snapshot"), None)
        .await
        .body;
    assert_eq!(after["entities"][0]["body"], expected);
    let old = app
        .public(
            "/api/public/previews",
            Some(&format!("Preview {}", p.body["token"].as_str().unwrap())),
        )
        .await;
    assert_eq!(old.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rebuilt_moves_reject_stale_expanded_and_cross_space_requests() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let snapshot = fixture(&app).await;
    let path = draft(&app).await;
    let input = moving(&snapshot);
    let mut bad = input.clone();
    bad["rev"] = json!(3);
    assert_eq!(
        call(&app, &format!("{path}/moves"), bad).await.status,
        StatusCode::CONFLICT
    );
    let mut bad = input.clone();
    bad["moves"][0]["expectedHash"] = json!("a".repeat(64));
    assert_eq!(
        call(&app, &format!("{path}/moves"), bad).await.status,
        StatusCode::CONFLICT
    );
    let mut bad = input.clone();
    bad["moves"][0]["layer"] = json!("ext");
    assert_eq!(
        call(&app, &format!("{path}/moves"), bad).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut bad = input.clone();
    bad["moves"]
        .as_array_mut()
        .unwrap()
        .push(input["moves"][0].clone());
    assert_eq!(
        call(&app, &format!("{path}/moves"), bad).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // A draft id from another space cannot be used, even with rebuild permission.
    app.create_space("other").await;
    let cross = path.replace("/moving/", "/other/");
    assert_eq!(
        call(&app, &format!("{cross}/moves"), input.clone())
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let d = app
        .org(Method::POST, &format!("{BASE}/drafts"), Some(json!({})))
        .await;
    assert_eq!(d.status, StatusCode::CREATED);
    let ext = format!(
        "{BASE}/rebuild/drafts/{}/moves",
        d.body["id"].as_str().unwrap()
    );
    assert_eq!(call(&app, &ext, input).await.status, StatusCode::NOT_FOUND);
    let current = app.org(Method::GET, &path, None).await;
    assert_eq!(current.body["rev"], 0);
    assert_eq!(
        app.org(Method::GET, &format!("{BASE}/snapshot"), None)
            .await
            .body,
        snapshot
    );
}

#[tokio::test]
async fn rebuilt_model_move_preserves_asset_rotation_material_and_attribution() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let snapshot = fixture_with_model(&app, true).await;
    let path = draft(&app).await;
    let moved = call(&app, &format!("{path}/moves"), moving(&snapshot)).await;
    assert_eq!(moved.status, StatusCode::ACCEPTED, "{:?}", moved.body);
    let job = app.wait_job(moved.body["jobId"].as_str().unwrap()).await;
    assert_eq!(job.get_str("status").unwrap(), "done", "{job:?}");
    let p = call(&app, &format!("{path}/preview"), json!({})).await;
    assert_eq!(p.status, StatusCode::CREATED, "{:?}", p.body);
    let preview = app
        .public(
            "/api/public/previews",
            Some(&format!("Preview {}", p.body["token"].as_str().unwrap())),
        )
        .await;
    assert_eq!(preview.status, StatusCode::OK);
    let mut expected = snapshot["entities"][0]["body"].clone();
    expected["bounds"] = json!({"min":[1.435,0.0,2.435],"max":[2.565,1.0,3.565]});
    assert_eq!(preview.body["entities"][0]["body"], expected);
    assert!(expected.get("shape").is_none());
    assert_eq!(
        app.org(Method::GET, &format!("{BASE}/snapshot"), None)
            .await
            .body,
        snapshot
    );
}

#[tokio::test]
async fn rebuild_moves_reject_members_and_moves_outside_physical_space() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let snapshot = fixture(&app).await;
    let path = draft(&app).await;
    let token = timeline_support::identity_with("bob", &[REBUILD]);
    let denied = app
        .send(
            Method::POST,
            &format!("{path}/moves"),
            &[
                ("x-nyxid-identity-token", token.as_str()),
                ("authorization", "Bearer member-token"),
            ],
            timeline_support::Payload::Json(moving(&snapshot)),
        )
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    app.define_layout("moving").await;
    let path = draft(&app).await;
    let mut outside = moving(&snapshot);
    outside["moves"][0]["offset"] = json!([15, 0, 3]);
    let rejected = call(&app, &format!("{path}/moves"), outside).await;
    assert_eq!(
        rejected.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{:?}",
        rejected.body
    );
    assert_eq!(app.org(Method::GET, &path, None).await.body["rev"], 0);
}

#[tokio::test]
async fn rebuild_moves_cannot_change_templates_or_extension_entities() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let snapshot = fixture(&app).await;
    let path = draft(&app).await;
    let template = snapshot["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "rb.template")
        .unwrap();
    let input = json!({"rev":0,"moves":[{"entityId":"rb.template","expectedHash":template["hash"],"offset":[1,0,0]}]});
    assert_eq!(
        call(&app, &format!("{path}/moves"), input).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let d = app
        .org(Method::POST, &format!("{BASE}/drafts"), Some(json!({})))
        .await;
    let extpath = format!("{BASE}/drafts/{}", d.body["id"].as_str().unwrap());
    let entity = json!({"entityId":"ext.object","layer":"ext","kind":"object",
        "shape":{"type":"box","size":[1,1,1],"transform":{"position":[2,0,2]}},
        "bounds":{"min":[1.5,0,1.5],"max":[2.5,1,2.5]}});
    let added = app
        .org(
            Method::POST,
            &format!("{extpath}/ops"),
            Some(json!({"rev":0,"ops":[{"op":"placeEntity","entity":entity}]})),
        )
        .await;
    assert_eq!(added.status, StatusCode::OK, "{:?}", added.body);
    let published = app
        .org(
            Method::POST,
            &format!("{extpath}/publish"),
            Some(json!({"rev":1,"replay":false})),
        )
        .await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.body);
    let snapshot = app
        .org(Method::GET, &format!("{BASE}/snapshot"), None)
        .await
        .body;
    let ext = snapshot["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "ext.object")
        .unwrap();
    let path = draft(&app).await;
    let input = json!({"rev":0,"moves":[{"entityId":"ext.object","expectedHash":ext["hash"],"offset":[1,0,0]}]});
    assert_eq!(
        call(&app, &format!("{path}/moves"), input).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(app.org(Method::GET, &path, None).await.body["rev"], 0);
}
