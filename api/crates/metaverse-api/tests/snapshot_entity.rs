mod timeline_support;

use axum::http::{header, Method, StatusCode};
use serde_json::json;
use timeline_support::{Payload, TestApp};

#[tokio::test]
async fn single_entity_read_matches_pinned_snapshot_and_enforces_space_access() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_space("entity-read").await;
    let base = "/api/v1/spaces/entity-read";
    let d = app
        .org(Method::POST, &format!("{base}/drafts"), Some(json!({})))
        .await;
    assert_eq!(d.status, StatusCode::CREATED);
    let draft = format!("{base}/drafts/{}", d.body["id"].as_str().unwrap());
    let entity = json!({"entityId":"ext.target","layer":"ext","kind":"object","label":"目标",
        "shape":{"type":"box","size":[1,1,1]},"bounds":{"min":[-0.5,0,-0.5],"max":[0.5,1,0.5]}});
    let r = app
        .org(
            Method::POST,
            &format!("{draft}/ops"),
            Some(json!({"rev":0,"ops":[{"op":"placeEntity","entity":entity}]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.body);
    let published = app
        .org(
            Method::POST,
            &format!("{draft}/publish"),
            Some(json!({"rev":1,"replay":false})),
        )
        .await;
    assert_eq!(published.status, StatusCode::OK, "{:?}", published.body);
    let seq = published.body["seq"].as_u64().unwrap();
    let path = format!("{base}/entities/ext.target");
    let full = app
        .org(Method::GET, &format!("{base}/snapshot?seq={seq}"), None)
        .await;
    let single = app
        .org(Method::GET, &format!("{path}?seq={seq}"), None)
        .await;
    assert_eq!(single.status, StatusCode::OK);
    assert_eq!(
        single.body,
        json!({"spaceId":"entity-read","seq":seq,"entity":full.body["entities"][0]})
    );
    assert_eq!(single.headers[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(app.org(Method::GET, &path, None).await.body, single.body);
    // Read access is sufficient: an org viewer does not need rebuild/write permissions.
    let viewer = app
        .v1(
            Method::GET,
            &path,
            "bob",
            Some("viewer-token"),
            Payload::None,
        )
        .await;
    assert_eq!(viewer.status, StatusCode::OK);
    assert_eq!(viewer.body, single.body);
    let outsider = app
        .v1(Method::GET, &path, "outsider", None, Payload::None)
        .await;
    assert_eq!(outsider.status, StatusCode::NOT_FOUND);
    assert_eq!(
        app.public(&path, None).await.status,
        StatusCode::UNAUTHORIZED
    );
    for suffix in [
        "entities/ext.missing",
        "entities/bad:id",
        "entities/ext.target?seq=1",
        "entities/ext.target?seq=999",
    ] {
        assert_eq!(
            app.org(Method::GET, &format!("{base}/{suffix}"), None)
                .await
                .status,
            StatusCode::NOT_FOUND,
            "{suffix}"
        );
    }
    assert_eq!(
        app.org(Method::GET, &format!("{path}?seq=-1"), None)
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    app.create_space("entity-other").await;
    assert_eq!(
        app.org(
            Method::GET,
            "/api/v1/spaces/entity-other/entities/ext.target",
            None
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    let d = app
        .org(Method::POST, &format!("{base}/drafts"), Some(json!({})))
        .await;
    let draft = format!("{base}/drafts/{}", d.body["id"].as_str().unwrap());
    let removed = app
        .org(
            Method::POST,
            &format!("{draft}/ops"),
            Some(json!({"rev":0,"ops":[{"op":"removeEntity","entityId":"ext.target"}]})),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{:?}", removed.body);
    assert_eq!(
        app.org(
            Method::POST,
            &format!("{draft}/publish"),
            Some(json!({"rev":1,"replay":false}))
        )
        .await
        .status,
        StatusCode::OK
    );
    assert_eq!(
        app.org(Method::GET, &path, None).await.status,
        StatusCode::NOT_FOUND
    );
    // The pinned record stays readable after deletion from the current version.
    assert_eq!(
        app.org(Method::GET, &format!("{path}?seq={seq}"), None)
            .await
            .body,
        single.body
    );
}
