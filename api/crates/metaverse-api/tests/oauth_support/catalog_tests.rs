use super::*;
async fn browser(app: &TestApp, cookie: &str, path: &str, body: Option<Value>) -> Reply {
    let s = session(app, cookie).await;
    app.send(
        Method::POST,
        &format!("{ROOT}/{path}"),
        &[
            ("cookie", cookie),
            ("origin", ORIGIN),
            ("x-csrf-token", s.body["csrfToken"].as_str().unwrap()),
        ],
        body,
    )
    .await
}
#[tokio::test]
async fn browser_catalog_is_scoped_paginated_and_never_discloses_other_owners_or_secrets() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    for (space, owner) in [("a-mine", "browser-owner"), ("z-other", "another-owner")] {
        assert_eq!(
            app.create(&identity(owner), None, space_body(space, "person", owner))
                .await
                .status,
            StatusCode::CREATED
        );
    }
    let cookie = connect(&app, "browser-owner", 3600).await;
    let listed = browser(&app, &cookie, "spaces", Some(json!({}))).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    assert_eq!(listed.headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        listed.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a-mine", "oauth-hall"]
    );
    assert_eq!(listed.body["items"][0]["access"], "manage");
    for secret in [
        "shareTokens",
        "ownerEvidence",
        "contact_email",
        "oauth-access",
    ] {
        assert!(!listed.body.to_string().contains(secret));
    }
    let page = browser(&app, &cookie, "spaces", Some(json!({"after":"a-mine"}))).await;
    assert_eq!(page.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        browser(
            &app,
            &cookie,
            "spaces",
            Some(json!({"subject":"another-owner"}))
        )
        .await
        .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let bad = app
        .send(
            Method::POST,
            &format!("{ROOT}/spaces"),
            &[("cookie", &cookie)],
            Some(json!({})),
        )
        .await;
    assert_eq!(bad.status, StatusCode::FORBIDDEN);
    app.nyx.oauth.0.lock().unwrap().role = Some("member".into());
    let member = browser(&app, &cookie, "spaces", Some(json!({}))).await;
    assert_eq!(member.body["items"][1]["access"], "read");
    app.nyx.oauth.0.lock().unwrap().role = None;
    let removed = browser(&app, &cookie, "spaces", Some(json!({}))).await;
    assert_eq!(removed.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        browser(&app, &cookie, "view/spaces/oauth-hall", None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    disconnect(&app, &cookie).await;
    assert_eq!(
        app.send(
            Method::POST,
            &format!("{ROOT}/spaces"),
            &[("cookie", &cookie), ("origin", ORIGIN)],
            Some(json!({}))
        )
        .await
        .status,
        StatusCode::FORBIDDEN
    );
}
#[tokio::test]
async fn browser_viewer_reads_unlisted_space_without_issuing_shares_or_authenticating_mutations() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    let cookie = connect(&app, "browser-owner", 3600).await;
    let initial = app.read("oauth-hall", &identity(ORG), None).await;
    assert_eq!(
        app.public("oauth-hall", None).await.status,
        StatusCode::NOT_FOUND
    );
    let base = "view/spaces/oauth-hall";
    for path in [
        base.to_owned(),
        format!("{base}/head"),
        format!("{base}/timeline"),
        format!("{base}/snapshot?seq=0"),
        format!("{base}/snapshot?at=2026-01-01T00:00:00Z"),
        format!("{base}/state?at=2026-01-01T00:00:00Z"),
        format!("{base}/events?from=2026-01-01T00:00:00Z&to=2026-01-01T01:00:00Z"),
        format!(
            "{base}/events/density?from=2026-01-01T00:00:00Z&to=2026-01-01T01:00:00Z&bucket=60"
        ),
    ] {
        let r = browser(&app, &cookie, &path, None).await;
        assert_eq!(r.status, StatusCode::OK, "{path}: {}", r.body);
        assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
        assert!(!r.body.to_string().contains("shareTokens"));
    }
    let wrong = browser(&app, &cookie, &format!("{base}?universe=other"), None).await;
    assert_eq!(wrong.status, StatusCode::NOT_FOUND);
    let unsigned = app
        .send(
            Method::GET,
            "/api/v1/spaces/oauth-hall",
            &[("cookie", &cookie)],
            None,
        )
        .await;
    assert_eq!(unsigned.status, StatusCode::UNAUTHORIZED);
    let mutation = app
        .send(
            Method::POST,
            "/api/v1/admin/spaces",
            &[("cookie", &cookie)],
            Some(space_body("bad-space", "person", "browser-owner")),
        )
        .await;
    assert_eq!(mutation.status, StatusCode::UNAUTHORIZED);
    let after = app.read("oauth-hall", &identity(ORG), None).await;
    assert_eq!(initial.body, after.body);
    app.nyx.oauth.0.lock().unwrap().userinfo_down = true;
    assert_eq!(
        browser(&app, &cookie, base, None).await.status,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
#[tokio::test]
async fn browser_viewer_cannot_outlive_disconnect_during_membership_lookup() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    let cookie = connect(&app, "browser-owner", 3600).await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let entered = Arc::new(tokio::sync::Notify::new());
    {
        let mut s = app.nyx.oauth.0.lock().unwrap();
        s.role_gate = Some(gate.clone());
        s.role_entered = Some(entered.clone());
    }
    let read = browser(&app, &cookie, "view/spaces/oauth-hall", None);
    let disconnecting = async {
        entered.notified().await;
        assert_eq!(
            disconnect(&app, &cookie).await.status,
            StatusCode::NO_CONTENT
        );
        gate.notify_one();
    };
    let (reply, _) = tokio::join!(read, disconnecting);
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
}

#[tokio::test]
async fn browser_catalog_bounds_pages_and_skips_tombstones_and_inconsistent_org_evidence() {
    let Some(app) = TestApp::start_with_options(true, true).await else {
        return;
    };
    create_org(&app).await;
    let cookie = connect(&app, "browser-owner", 3600).await;
    let client = mongodb::Client::with_uri_str(&app.uri).await.unwrap();
    let spaces = client
        .database(&app.database)
        .collection::<mongodb::bson::Document>("spaces");
    let template = spaces
        .find_one(doc! {"_id":"oauth-hall"})
        .await
        .unwrap()
        .unwrap();
    for n in 0..42 {
        let mut row = template.clone();
        row.insert("_id", format!("page-{n:02}"));
        spaces.insert_one(row).await.unwrap();
    }
    let mut invalid = template.clone();
    invalid.insert("_id", "invalid-evidence");
    invalid.remove("ownerEvidence");
    spaces.insert_one(invalid).await.unwrap();
    let mut deleted = template;
    deleted.insert("_id", "deleted-space");
    deleted.insert("deletingAt", "2026-01-01T00:00:00Z");
    spaces.insert_one(deleted).await.unwrap();
    let page = browser(&app, &cookie, "spaces", Some(json!({}))).await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.body);
    assert_eq!(page.body["items"].as_array().unwrap().len(), 40);
    assert_eq!(page.body["items"][0]["id"], "oauth-hall");
    assert_eq!(page.body["next"], "page-38");
    let next = browser(
        &app,
        &cookie,
        "spaces",
        Some(json!({"after":page.body["next"]})),
    )
    .await;
    assert_eq!(next.body["items"].as_array().unwrap().len(), 3);
    assert!(next.body["next"].is_null());
}
