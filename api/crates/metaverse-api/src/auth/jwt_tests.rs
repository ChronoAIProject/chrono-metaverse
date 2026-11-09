//! 改编自 CMA `auth/nyxid_proxy/jwt_tests.rs`：测试用的 RSA 密钥在内存里临时生成，
//! 不提交任何私钥。

use super::*;
use axum::{http::StatusCode, routing::get, Router};
use ring::{
    rand::SystemRandom,
    signature::{KeyPair, RsaKeyPair, RSA_PKCS1_SHA256},
};
use serde_json::{json, Value};
use std::{
    process::Command,
    sync::{
        atomic::{AtomicUsize, Ordering},
        OnceLock,
    },
};
use tokio::sync::RwLock;

pub(crate) struct Signer(RsaKeyPair);

impl Signer {
    fn generate() -> Self {
        let output = Command::new("openssl")
            .args(["genrsa", "2048"])
            .output()
            .expect("需要 openssl 生成临时测试密钥");
        assert!(output.status.success(), "生成测试 RSA 密钥失败");
        let pem = String::from_utf8(output.stdout).unwrap();
        let encoded: String = pem.lines().filter(|line| !line.starts_with('-')).collect();
        let der = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let key = if pem.starts_with("-----BEGIN PRIVATE KEY-----") {
            RsaKeyPair::from_pkcs8(&der)
        } else {
            RsaKeyPair::from_der(&der)
        };
        Self(key.unwrap())
    }

    pub(crate) fn primary() -> &'static Self {
        static SIGNER: OnceLock<Signer> = OnceLock::new();
        SIGNER.get_or_init(Self::generate)
    }

    pub(crate) fn rotated() -> &'static Self {
        static SIGNER: OnceLock<Signer> = OnceLock::new();
        SIGNER.get_or_init(Self::generate)
    }

    pub(crate) fn token(&self, claims: &Value, kid: &str) -> String {
        self.raw(
            &json!({"alg":"RS256","typ":"JWT","kid":kid}).to_string(),
            &claims.to_string(),
        )
    }

    fn raw(&self, header: &str, body: &str) -> String {
        let signed = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(body)
        );
        let mut signature = vec![0; self.0.public().modulus_len()];
        self.0
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                signed.as_bytes(),
                &mut signature,
            )
            .unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    pub(crate) fn key(&self, kid: &str) -> Value {
        let mut der = self.0.public_key().as_ref();
        let mut sequence = tlv(&mut der, 0x30);
        let n = tlv(&mut sequence, 0x02);
        let e = tlv(&mut sequence, 0x02);
        json!({"kty":"RSA","kid":kid,"alg":"RS256","use":"sig","key_ops":["verify"],
            "n":URL_SAFE_NO_PAD.encode(n.strip_prefix(&[0]).unwrap_or(n)),"e":URL_SAFE_NO_PAD.encode(e)})
    }
}

fn tlv<'a>(input: &mut &'a [u8], tag: u8) -> &'a [u8] {
    assert_eq!(input[0], tag);
    let head = input[1];
    *input = &input[2..];
    let size = if head < 128 {
        head as usize
    } else {
        let bytes = (head & 127) as usize;
        let size = input[..bytes]
            .iter()
            .fold(0_usize, |n, b| (n << 8) | usize::from(*b));
        *input = &input[bytes..];
        size
    };
    let value = &input[..size];
    *input = &input[size..];
    value
}

fn config(jwks_url: String) -> Config {
    Config {
        issuer: "https://nyx.example".into(),
        jwks_url,
        audience: "urn:chrono-metaverse:api".into(),
        service_ids: vec!["svc-custom".into(), "svc-catalog".into()],
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn claims(at: i64) -> Value {
    json!({"sub":"user-1","iss":"https://nyx.example","aud":"urn:chrono-metaverse:api",
        "iat":at,"exp":at+60,"jti":"assertion-1","nyx_service_id":"svc-custom",
        "permissions":["metaverse:space:create"],"roles":[],"groups":[],
        "name":"Alice","email":"alice@example.test"})
}

fn key_set() -> Value {
    json!({"keys":[Signer::primary().key("key-1")]})
}

fn verify_locally(raw: &str, at: i64) -> Result<VerifiedIdentity, VerifyError> {
    let claims: Claims =
        KeySet::parse(key_set().to_string().as_bytes())?.verify(&Token::parse(raw)?)?;
    claims.validate(&config("https://nyx.example/jwks".into()), at)
}

struct Fixture {
    verifier: Verifier,
    body: Arc<RwLock<String>>,
    status: Arc<RwLock<StatusCode>>,
    calls: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        let body = Arc::new(RwLock::new(key_set().to_string()));
        let status = Arc::new(RwLock::new(StatusCode::OK));
        let calls = Arc::new(AtomicUsize::new(0));
        let (returned, response_status, counter) = (body.clone(), status.clone(), calls.clone());
        let app = Router::new().route(
            "/jwks",
            get(move || {
                let (body, status, counter) =
                    (returned.clone(), response_status.clone(), counter.clone());
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    (*status.read().await, body.read().await.clone())
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/jwks", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            verifier: Verifier::new(config(url)).unwrap(),
            body,
            status,
            calls,
            server,
        }
    }

    fn requests(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    async fn permit_refresh(&self) {
        self.verifier.cache.lock().await.next_refresh = None;
    }

    async fn expire_cache(&self) {
        let mut cache = self.verifier.cache.lock().await;
        cache.next_refresh = None;
        if let Some((_, expiry)) = cache.keys.as_mut() {
            *expiry = Instant::now();
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[test]
fn verifies_identity_contract() {
    let at = now();
    let identity = verify_locally(&Signer::primary().token(&claims(at), "key-1"), at).unwrap();
    assert_eq!(identity.subject, "user-1");
    assert_eq!(identity.service_id, "svc-custom");
    assert_eq!(identity.jti, "assertion-1");
    assert_eq!(identity.permissions, ["metaverse:space:create"]);
    assert_eq!(
        identity
            .expires_at
            .duration_since(identity.issued_at)
            .unwrap(),
        Duration::from_secs(60)
    );
    // 允许列表里的第二个服务编号（目录服务）同样可用。
    let mut catalog = claims(at);
    catalog["nyx_service_id"] = json!("svc-catalog");
    assert!(verify_locally(&Signer::primary().token(&catalog, "key-1"), at).is_ok());
}

#[test]
fn destination_and_claims_are_strict() {
    let at = now();
    for (field, replacement, reason) in [
        ("iss", json!("https://wrong.example"), "token_destination"),
        ("aud", json!("https://other.example"), "token_destination"),
        ("aud", json!(["urn:chrono-metaverse:api"]), "token_claims"),
        (
            "nyx_service_id",
            json!("someone-elses-connection"),
            "service_not_allowed",
        ),
        ("sub", json!(""), "token_claims"),
        ("sub", json!("user-1\n"), "token_claims"),
        ("jti", json!(""), "token_claims"),
        ("permissions", json!("metaverse:*"), "token_claims"),
        ("permissions", json!([null]), "token_claims"),
    ] {
        let mut value = claims(at);
        value[field] = replacement;
        assert_eq!(
            verify_locally(&Signer::primary().token(&value, "key-1"), at).unwrap_err(),
            VerifyError::Rejected(reason),
            "{field}"
        );
    }
    for field in [
        "sub",
        "iss",
        "aud",
        "nyx_service_id",
        "iat",
        "exp",
        "jti",
        "permissions",
    ] {
        let mut value = claims(at);
        value.as_object_mut().unwrap().remove(field);
        assert!(
            verify_locally(&Signer::primary().token(&value, "key-1"), at).is_err(),
            "missing {field}"
        );
    }
}

#[test]
fn access_tokens_and_other_token_families_are_rejected() {
    let at = now();
    for value in [json!("access"), json!("id"), json!(null)] {
        let mut access = claims(at);
        access["token_type"] = value;
        assert_eq!(
            verify_locally(&Signer::primary().token(&access, "key-1"), at).unwrap_err(),
            VerifyError::Rejected("token_type")
        );
    }
    for (key, value) in [
        ("scope", json!("proxy")),
        ("act", json!({"sub":"svc"})),
        ("sid", json!("session")),
    ] {
        let mut other = claims(at);
        other[key] = value;
        assert_eq!(
            verify_locally(&Signer::primary().token(&other, "key-1"), at).unwrap_err(),
            VerifyError::Rejected("token_claims")
        );
    }
    let duplicate = format!("{{\"sub\":\"other\",{}", &claims(at).to_string()[1..]);
    let header = json!({"alg":"RS256","typ":"JWT","kid":"key-1"}).to_string();
    assert_eq!(
        verify_locally(&Signer::primary().raw(&header, &duplicate), at).unwrap_err(),
        VerifyError::Rejected("token_claims")
    );
}

#[test]
fn lifetime_expiry_and_clock_skew() {
    let at = now();
    for (iat, exp, nbf) in [
        (at - 60, at, None),
        (at - 61, at - 1, None),
        (at, at + 61, None),
        (at, at, None),
        (at + 6, at + 66, None),
        (-1, at + 60, None),
        (at, at + 60, Some(at + 6)),
        (at, at + 60, Some(at + 60)),
    ] {
        let mut value = claims(at);
        value["iat"] = json!(iat);
        value["exp"] = json!(exp);
        if let Some(nbf) = nbf {
            value["nbf"] = json!(nbf);
        }
        assert_eq!(
            verify_locally(&Signer::primary().token(&value, "key-1"), at).unwrap_err(),
            VerifyError::Rejected("token_time"),
            "{iat} {exp} {nbf:?}"
        );
    }
    let mut value = claims(at + 5);
    value["nbf"] = json!(at + 5);
    assert!(verify_locally(&Signer::primary().token(&value, "key-1"), at).is_ok());
}

#[test]
fn header_algorithm_and_key_source_are_fixed() {
    let at = now();
    for header in [
        json!({"alg":"none","typ":"JWT","kid":"key-1"}),
        json!({"alg":"HS256","typ":"JWT","kid":"key-1"}),
        json!({"alg":"RS256","typ":"at+jwt","kid":"key-1"}),
        json!({"alg":"RS256","typ":"JWT"}),
        json!({"alg":"RS256","typ":"JWT","kid":"key-1","jku":"https://attacker.example/jwks"}),
        json!({"alg":"RS256","typ":"JWT","kid":"key-1","crit":["custom"]}),
    ] {
        let raw = Signer::primary().raw(&header.to_string(), &claims(at).to_string());
        assert_eq!(
            verify_locally(&raw, at).unwrap_err(),
            VerifyError::Rejected("token_header")
        );
    }
}

#[test]
fn jwks_shape_is_validated() {
    let key = Signer::primary().key("key-1");
    assert!(KeySet::parse(
        json!({"keys":[key.clone(), key.clone()]})
            .to_string()
            .as_bytes()
    )
    .is_err());
    for (field, value) in [
        ("kty", json!("EC")),
        ("alg", json!("HS256")),
        ("use", json!("enc")),
        ("key_ops", json!(["sign"])),
        ("n", json!("AA")),
    ] {
        let mut key = key.clone();
        key[field] = value;
        assert!(
            KeySet::parse(json!({"keys":[key]}).to_string().as_bytes()).is_err(),
            "{field}"
        );
    }
    assert!(KeySet::parse(json!({"keys":[]}).to_string().as_bytes()).is_err());
}

#[test]
fn endpoints_and_header_multiplicity() {
    for url in [
        "http://nyx.example/jwks",
        "https://user:pass@nyx.example/jwks",
        "https://nyx.example/jwks?query=1",
        "file:///tmp/jwks",
    ] {
        assert!(Verifier::new(config(url.into())).is_err(), "{url}");
    }
    assert!(Verifier::new(config("http://127.0.0.1:10000/jwks".into())).is_ok());
    let mut empty = config("https://nyx.example/jwks".into());
    empty.service_ids.clear();
    assert!(Verifier::new(empty).is_err());
    let mut headers = axum::http::HeaderMap::new();
    assert!(identity_token(&headers).unwrap().is_none());
    headers.append(HEADER, "token-one".parse().unwrap());
    assert_eq!(identity_token(&headers).unwrap(), Some("token-one"));
    headers.append(HEADER, "token-two".parse().unwrap());
    assert_eq!(
        identity_token(&headers).unwrap_err(),
        VerifyError::Rejected("duplicate_identity_header")
    );
}

#[tokio::test]
async fn concurrent_requests_share_one_fetch_and_cache_lasts() {
    let fixture = Fixture::new().await;
    let token = Signer::primary().token(&claims(super::now().unwrap()), "key-1");
    let results =
        futures_util::future::join_all((0..16).map(|_| fixture.verifier.verify(&token))).await;
    assert!(results.into_iter().all(|result| result.is_ok()));
    assert_eq!(fixture.requests(), 1);
    fixture.expire_cache().await;
    fixture.verifier.verify(&token).await.unwrap();
    assert_eq!(fixture.requests(), 2);
}

#[tokio::test]
async fn unknown_kid_refresh_is_rate_limited() {
    let fixture = Fixture::new().await;
    let value = claims(super::now().unwrap());
    fixture
        .verifier
        .verify(&Signer::primary().token(&value, "key-1"))
        .await
        .unwrap();
    fixture.permit_refresh().await;
    for kid in ["unknown-1", "unknown-2", "unknown-3"] {
        assert_eq!(
            fixture
                .verifier
                .verify(&Signer::primary().token(&value, kid))
                .await
                .unwrap_err(),
            VerifyError::Rejected("signing_key_unknown")
        );
    }
    // 第一次未知 kid 触发一次刷新，之后 5 秒内不再刷新。
    assert_eq!(fixture.requests(), 2);
}

#[tokio::test]
async fn bad_signature_for_known_kid_never_refreshes() {
    let fixture = Fixture::new().await;
    let value = claims(super::now().unwrap());
    fixture
        .verifier
        .verify(&Signer::primary().token(&value, "key-1"))
        .await
        .unwrap();
    fixture.permit_refresh().await;
    assert_eq!(
        fixture
            .verifier
            .verify(&Signer::rotated().token(&value, "key-1"))
            .await
            .unwrap_err(),
        VerifyError::Rejected("token_signature")
    );
    assert_eq!(fixture.requests(), 1);
}

#[tokio::test]
async fn rotation_and_provider_failures() {
    let fixture = Fixture::new().await;
    let value = claims(super::now().unwrap());
    let old = Signer::primary().token(&value, "key-1");
    let new = Signer::rotated().token(&value, "key-2");
    fixture.verifier.verify(&old).await.unwrap();
    *fixture.body.write().await =
        json!({"keys":[Signer::primary().key("key-1"),Signer::rotated().key("key-2")]}).to_string();
    fixture.permit_refresh().await;
    fixture.verifier.verify(&new).await.unwrap();
    fixture.verifier.verify(&old).await.unwrap();
    // 公钥列表过期后拉取失败：不再使用过期的公钥。
    *fixture.status.write().await = StatusCode::SERVICE_UNAVAILABLE;
    fixture.expire_cache().await;
    assert!(matches!(
        fixture.verifier.verify(&old).await,
        Err(VerifyError::Unavailable(_))
    ));
}

#[tokio::test]
async fn forwarded_access_token_must_match_subject() {
    let fixture = Fixture::new().await;
    let at = super::now().unwrap();
    let access = |sub: &str, token_type: &str, exp: i64| {
        Signer::primary().token(
            &json!({"sub":sub,"iss":"https://nyx.example","aud":"nyxid","exp":exp,"iat":at,
                "jti":"a","scope":"openid","token_type":token_type,"sid":"s"}),
            "key-1",
        )
    };
    let verifier = &fixture.verifier;
    verifier
        .verify_forwarded_access_token(&access("user-1", "access", at + 900), "user-1")
        .await
        .unwrap();
    for (token, reason) in [
        (
            access("user-2", "access", at + 900),
            "forwarded_token_subject",
        ),
        (
            access("user-1", "refresh", at + 900),
            "forwarded_token_subject",
        ),
        (access("user-1", "access", at - 1), "forwarded_token_time"),
    ] {
        assert_eq!(
            verifier
                .verify_forwarded_access_token(&token, "user-1")
                .await
                .unwrap_err(),
            VerifyError::Rejected(reason)
        );
    }
    assert!(looks_like_jwt(&access("user-1", "access", at)));
    assert!(!looks_like_jwt("nyxid_ag_0123456789"));
    assert!(!looks_like_jwt("a.b.c"));
}
