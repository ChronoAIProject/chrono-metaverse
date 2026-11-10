use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

use super::{seconds, OAuthError, OAuthService, Tokens};

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    token_type: String,
    expires_in: i64,
}
impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(refresh) = self.refresh_token.as_mut() {
            refresh.zeroize();
        }
    }
}

async fn bytes(mut response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>, OAuthError> {
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| OAuthError::Unavailable)?
    {
        if body.len() + chunk.len() > 64 * 1024 {
            return Err(OAuthError::Unavailable);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

impl OAuthService {
    async fn token(
        &self,
        fields: &[(&str, &str)],
        previous: Option<&Tokens>,
    ) -> Result<Tokens, OAuthError> {
        let response = self
            .http
            .post(self.endpoint("/oauth/token"))
            .form(fields)
            .send()
            .await
            .map_err(|_| OAuthError::Unavailable)?;
        if !response.status().is_success() {
            let status = response.status();
            let body = bytes(response).await?;
            #[derive(Deserialize)]
            struct Failure {
                error: String,
            }
            let failure = serde_json::from_slice::<Failure>(&body).ok();
            return Err(
                if status == reqwest::StatusCode::BAD_REQUEST
                    && failure.is_some_and(|f| {
                        matches!(f.error.as_str(), "invalid_grant" | "access_denied")
                    })
                {
                    OAuthError::Reconnect
                } else {
                    OAuthError::Unavailable
                },
            );
        }
        let body = bytes(response).await?;
        let token: TokenResponse =
            serde_json::from_slice(&body).map_err(|_| OAuthError::Unavailable)?;
        let valid = |value: &str| {
            !value.is_empty()
                && value.len() <= 16 * 1024
                && value.bytes().all(|b| b.is_ascii_graphic())
        };
        if !token.token_type.eq_ignore_ascii_case("bearer")
            || !valid(&token.access_token)
            || !(1..=86400).contains(&token.expires_in)
        {
            return Err(OAuthError::Unavailable);
        }
        let refresh = token
            .refresh_token
            .as_deref()
            .filter(|v| !v.is_empty())
            .or_else(|| previous.map(|p| p.refresh_token.as_str()))
            .ok_or(OAuthError::Reconnect)?;
        if !valid(refresh) {
            return Err(OAuthError::Unavailable);
        }
        Ok(Tokens {
            access_token: token.access_token.clone(),
            refresh_token: refresh.into(),
            expires_at: seconds()? + token.expires_in,
            subject_verified: false,
        })
    }

    pub(super) async fn exchange(&self, code: &str, verifier: &str) -> Result<Tokens, OAuthError> {
        self.token(
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &self.config.client_id),
                ("client_secret", &self.config.client_secret.0),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", &self.config.redirect_uri),
            ],
            None,
        )
        .await
    }

    pub(super) async fn refresh(&self, previous: &Tokens) -> Result<Tokens, OAuthError> {
        self.token(
            &[
                ("grant_type", "refresh_token"),
                ("client_id", &self.config.client_id),
                ("client_secret", &self.config.client_secret.0),
                ("refresh_token", &previous.refresh_token),
            ],
            Some(previous),
        )
        .await
    }

    pub(super) async fn subject(&self, token: &str) -> Result<String, OAuthError> {
        let response = self
            .http
            .get(self.endpoint("/oauth/userinfo"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| OAuthError::Unavailable)?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(OAuthError::Reconnect);
        }
        if !response.status().is_success() {
            return Err(OAuthError::Unavailable);
        }
        #[derive(Deserialize)]
        struct User {
            sub: String,
        }
        let user: User =
            serde_json::from_slice(&bytes(response).await?).map_err(|_| OAuthError::Unavailable)?;
        if !metaverse_core::ids::is_subject_id(&user.sub) {
            return Err(OAuthError::Unavailable);
        }
        Ok(user.sub)
    }
}
