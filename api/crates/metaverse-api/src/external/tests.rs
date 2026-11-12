//! 使用确定性的上游响应验证缓存、来源边界和拒绝处理，不依赖供应商在线服务。
use super::*;
use axum::http::{HeaderValue, Response};
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicUsize, Ordering},
    time::UNIX_EPOCH,
};
use transport::Transport;

struct Stub {
    responses: Mutex<VecDeque<reqwest::Response>>,
    calls: AtomicUsize,
}
impl Transport for Stub {
    fn get<'a>(
        &'a self,
        _: &'a url::Url,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<reqwest::Response, ApiError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.responses.lock().await.pop_front().ok_or_else(upstream)
        })
    }
}
fn response(status: u16, control: &str, body: &'static str) -> reqwest::Response {
    Response::builder()
        .status(status)
        .header("cache-control", control)
        .header("content-type", "application/json")
        .body(body)
        .unwrap()
        .into()
}
fn source() -> Source {
    Source::from_entity(&json!({"props":{"background":true,"externalContent":{"version":1,"format":"3d-tiles","sources":[{"delivery":"server","url":"https://tiles.example/data/tileset.json","attribution":"测试数据","page":"https://tiles.example/","resourcePrefixes":["https://cdn.example/models/"]}]}}}), "content", 0).unwrap()
}
fn runtime(
    responses: Vec<reqwest::Response>,
    capacity: u64,
) -> (ExternalResources, Arc<Stub>, ExternalConfig) {
    let config = ExternalConfig {
        directory: std::env::temp_dir().join(format!("external-test-{}", uuid::Uuid::new_v4())),
        capacity,
    };
    let stub = Arc::new(Stub {
        responses: Mutex::new(responses.into()),
        calls: AtomicUsize::new(0),
    });
    (
        ExternalResources {
            cache: DiskCache::new(config.directory.clone(), capacity),
            inflight: Semaphore::new(8),
            locks: (0..64).map(|_| Mutex::new(())).collect(),
            transport: stub.clone(),
        },
        stub,
        config,
    )
}

#[test]
fn sources_are_scoped_to_declared_directories_and_map_templates() {
    let source = source();
    for allowed in [
        "https://tiles.example/data/0.b3dm",
        "https://cdn.example/models/texture.png",
    ] {
        assert!(source.checked(allowed).is_ok());
    }
    for denied in [
        "https://cdn.example/secret",
        "https://other.example/data/0.b3dm",
        "https://tiles.example/data/../secret",
        "https://tiles.example/data/%2e%2e/secret",
        "https://tiles.example/data/%252e/secret",
        "https://user:pass@tiles.example/data/0.b3dm",
        "http://tiles.example/data/0.b3dm",
    ] {
        assert!(source.checked(denied).is_err(), "{denied}");
    }
    let map = Source::from_entity(&json!({"props":{"background":true,"environment":{"version":1,"map":{"sources":[{"delivery":"server","urlTemplate":"https://maps.example/{z}/{x}/{y}.png","minZoom":0,"maxZoom":12,"attribution":"地图","page":"https://maps.example/"}]}}}}), "map", 0).unwrap();
    assert!(map.checked("https://maps.example/4/3/2.png").is_ok());
    for denied in [
        "https://maps.example/4/16/2.png",
        "https://maps.example/13/3/2.png",
        "https://maps.example/4/3/2.png?admin=1",
        "https://maps.example/secret",
    ] {
        assert!(map.checked(denied).is_err(), "{denied}");
    }
}

#[test]
fn network_checks_reject_local_reserved_and_transition_addresses() {
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "192.0.2.1",
        "198.19.1.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "fc00::1",
        "2002:7f00:1::",
        "2001:db8::1",
    ] {
        assert!(!public_ip(ip.parse().unwrap()), "{ip}");
    }
    for ip in ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"] {
        assert!(public_ip(ip.parse().unwrap()));
    }
}

#[test]
fn freshness_respects_shared_cache_restrictions_and_remaining_age() {
    let now = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let mut headers = HeaderMap::new();
    headers.insert(
        "cache-control",
        HeaderValue::from_static("public, max-age=600, s-maxage=300"),
    );
    headers.insert("age", HeaderValue::from_static("200"));
    assert_eq!(freshness(&headers, &CachePolicy::default(), now), 100);
    headers.insert(
        "date",
        httpdate::fmt_http_date(now - Duration::from_secs(250))
            .parse()
            .unwrap(),
    );
    assert_eq!(freshness(&headers, &CachePolicy::default(), now), 50);
    headers.insert(
        "vary",
        HeaderValue::from_static("Accept-Encoding, Authorization, Origin"),
    );
    assert_eq!(freshness(&headers, &CachePolicy::default(), now), 50);
    headers.insert("vary", HeaderValue::from_static("*"));
    assert_eq!(freshness(&headers, &CachePolicy::default(), now), 0);
    headers.remove("vary");
    for control in [
        "no-store, max-age=600",
        "private, max-age=600",
        "no-cache=\"ETag\", max-age=600",
        "max-age=0",
        "",
    ] {
        headers.insert("cache-control", control.parse().unwrap());
        assert_eq!(
            freshness(&headers, &CachePolicy::default(), now),
            0,
            "{control}"
        );
    }
}

#[tokio::test]
async fn concurrent_fetches_share_disk_cache_and_survive_runtime_restart() {
    let (runtime, stub, config) =
        runtime(vec![response(200, "public,max-age=600", "dataset")], 4096);
    let source = source();
    let url = "https://tiles.example/data/tileset.json";
    let (a, b) = tokio::join!(runtime.fetch(&source, url), runtime.fetch(&source, url));
    assert_eq!(a.unwrap().0, "dataset");
    assert!(b.unwrap().2);
    assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    let restarted = ExternalResources::new(&config);
    assert!(restarted.fetch(&source, url).await.unwrap().2);
    tokio::fs::remove_dir_all(config.directory).await.unwrap();
}

#[tokio::test]
async fn no_store_and_disabled_persistence_do_not_write_or_reuse_cache() {
    for control in ["no-store", "private,max-age=600", "no-cache", ""] {
        let (runtime, stub, config) = runtime(
            vec![
                response(200, control, "data"),
                response(200, control, "data"),
            ],
            4096,
        );
        let source = source();
        for _ in 0..2 {
            assert!(
                !runtime
                    .fetch(&source, "https://tiles.example/data/x")
                    .await
                    .unwrap()
                    .2
            );
        }
        assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
        assert!(!config.directory.exists());
    }
    let (runtime, stub, config) = runtime(
        vec![
            response(200, "max-age=600", "first"),
            response(200, "max-age=600", "second"),
        ],
        4096,
    );
    let mut source = source();
    runtime
        .fetch(&source, "https://tiles.example/data/x")
        .await
        .unwrap();
    source.cache.persist = Some(false);
    assert_eq!(
        runtime
            .fetch(&source, "https://tiles.example/data/x")
            .await
            .unwrap()
            .0,
        "second"
    );
    assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
    tokio::fs::remove_dir_all(config.directory).await.unwrap();
}

#[tokio::test]
async fn expired_cache_does_not_hide_forbidden_and_redirects_cannot_escape_scope() {
    let (runtime, _, config) = runtime(
        vec![
            response(200, "max-age=600", "data"),
            response(403, "max-age=600", "denied"),
        ],
        4096,
    );
    let mut source = source();
    let url = "https://tiles.example/data/x";
    runtime.fetch(&source, url).await.unwrap();
    source.cache.max_age_seconds = Some(0);
    assert_eq!(
        runtime.fetch(&source, url).await.unwrap_err().status,
        StatusCode::FORBIDDEN
    );
    tokio::fs::remove_dir_all(config.directory).await.unwrap();
    let redirect = Response::builder()
        .status(302)
        .header("location", "https://127.0.0.1/secret")
        .body("")
        .unwrap()
        .into();
    let (runtime, stub, _) = self::runtime(vec![redirect], 4096);
    assert_eq!(
        runtime.fetch(&source, url).await.unwrap_err().code,
        "external_scope"
    );
    assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn disk_capacity_and_streamed_size_limits_are_enforced() {
    let (runtime, _, config) = runtime(
        vec![
            response(200, "max-age=600", "dataset"),
            response(200, "max-age=600", "dataset"),
            response(200, "max-age=600", "too large"),
        ],
        180,
    );
    let mut source = source();
    runtime
        .fetch(&source, "https://tiles.example/data/a")
        .await
        .unwrap();
    runtime
        .fetch(&source, "https://tiles.example/data/b")
        .await
        .unwrap();
    let mut files = tokio::fs::read_dir(&config.directory).await.unwrap();
    let mut size = 0;
    while let Some(file) = files.next_entry().await.unwrap() {
        size += file.metadata().await.unwrap().len();
    }
    assert!(size <= config.capacity);
    source.max_bytes = 2;
    assert_eq!(
        runtime
            .fetch(&source, "https://tiles.example/data/c")
            .await
            .unwrap_err()
            .code,
        "external_size"
    );
    tokio::fs::remove_dir_all(config.directory).await.unwrap();
}
