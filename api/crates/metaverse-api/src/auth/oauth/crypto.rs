use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::OAuthError;

pub(super) struct Vault(aead::LessSafeKey);

impl Vault {
    pub fn new(encoded: &str) -> Result<Self, OAuthError> {
        let key = Zeroizing::new(
            STANDARD
                .decode(encoded)
                .map_err(|_| OAuthError::Unavailable)?,
        );
        Ok(Self(aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| OAuthError::Unavailable)?,
        )))
    }

    pub fn seal(&self, plaintext: &[u8], aad: &str) -> Result<String, OAuthError> {
        let mut nonce = [0_u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| OAuthError::Unavailable)?;
        let mut bytes = Zeroizing::new(plaintext.to_vec());
        self.0
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad.as_bytes()),
                &mut *bytes,
            )
            .map_err(|_| OAuthError::Unavailable)?;
        Ok(format!(
            "v1.{}.{}",
            URL_SAFE_NO_PAD.encode(nonce),
            URL_SAFE_NO_PAD.encode(&*bytes)
        ))
    }

    pub fn open(&self, ciphertext: &str, aad: &str) -> Result<Zeroizing<Vec<u8>>, OAuthError> {
        let mut parts = ciphertext.split('.');
        if parts.next() != Some("v1") {
            return Err(OAuthError::Unavailable);
        }
        let nonce = URL_SAFE_NO_PAD
            .decode(parts.next().ok_or(OAuthError::Unavailable)?)
            .map_err(|_| OAuthError::Unavailable)?;
        let nonce: [u8; 12] = nonce.try_into().map_err(|_| OAuthError::Unavailable)?;
        let mut bytes = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(parts.next().ok_or(OAuthError::Unavailable)?)
                .map_err(|_| OAuthError::Unavailable)?,
        );
        if parts.next().is_some() {
            return Err(OAuthError::Unavailable);
        }
        let len = self
            .0
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad.as_bytes()),
                &mut bytes,
            )
            .map_err(|_| OAuthError::Unavailable)?
            .len();
        bytes.truncate(len);
        Ok(bytes)
    }
}

pub(super) fn random() -> Result<String, OAuthError> {
    let mut bytes = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| OAuthError::Unavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(super) fn digest(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ciphertext_binds_record_and_rejects_tampering() {
        let vault = Vault::new(&STANDARD.encode([7_u8; 32])).unwrap();
        let encrypted = vault
            .seal(b"private-refresh-token", "issuer/client/alice/v1")
            .unwrap();
        assert!(!encrypted.contains("private-refresh-token"));
        assert_eq!(
            &*vault.open(&encrypted, "issuer/client/alice/v1").unwrap(),
            b"private-refresh-token"
        );
        assert!(vault.open(&encrypted, "issuer/client/bob/v1").is_err());
        assert!(vault
            .open(&encrypted, "other-issuer/client/alice/v1")
            .is_err());
        let other = Vault::new(&STANDARD.encode([8_u8; 32])).unwrap();
        assert!(other.open(&encrypted, "issuer/client/alice/v1").is_err());
    }
}
