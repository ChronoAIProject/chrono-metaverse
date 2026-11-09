//! 十六进制和 SHA-256 的小工具。所有哈希都用小写十六进制。

use sha2::{Digest, Sha256};

const HEX: &[u8; 16] = b"0123456789abcdef";

/// 小写十六进制编码。
pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[usize::from(byte >> 4)] as char);
        out.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    out
}

/// `sha256(bytes)` 的小写十六进制。
pub fn sha256_hex(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// 是否是 64 位小写十六进制（区块哈希、内容哈希、资源哈希都用这个格式）。
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_digest_and_format() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(is_sha256_hex(&sha256_hex(b"")));
        assert!(!is_sha256_hex(&sha256_hex(b"").to_uppercase()));
        assert!(!is_sha256_hex("abc"));
        assert_eq!(to_hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }
}
