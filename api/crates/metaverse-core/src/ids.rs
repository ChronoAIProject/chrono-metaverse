//! 编号格式。编号会出现在路径参数里（NyxID 操作范围按路径参数限制），
//! 所以只允许不需要转义的字符，并且不含 `:`（作用范围写成 `plot:<编号>`）。

/// 空间、组合编号：3–64 个字符，小写字母、数字和 `-`，首尾不能是 `-`。
pub fn is_space_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=64).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

/// 物件、锚点、区域、地块、数据源、模板、草稿等编号：1–128 个字符，
/// 字母、数字、`-`、`_`、`.`；不能以 `.` 开头。以 `_` 开头的编号是保留的
/// （目前只有 [`SPACE_ANCHOR_ID`]），由调用方单独判断。
pub fn is_object_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && bytes[0] != b'.'
}

/// NyxID 主体编号（用户、组织）。与 CMA `organizations/transport.rs` 的
/// `canonical_segment` 相同：只认规范编号，不认 slug。
pub fn is_subject_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// 空间级保留锚点（设计 4.4）：营业状态这类针对整个空间的事件挂在它上面。
pub const SPACE_ANCHOR_ID: &str = "_space";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_ids() {
        for ok in ["abc", "restaurant-xyz", "a1b", &"a".repeat(64)] {
            assert!(is_space_id(ok), "{ok}");
        }
        for bad in [
            "ab",
            "-abc",
            "abc-",
            "Abc",
            "a_b",
            "a b",
            "a:b",
            &"a".repeat(65),
        ] {
            assert!(!is_space_id(bad), "{bad}");
        }
    }

    #[test]
    fn object_ids() {
        for ok in ["p1", "chair-a", "counter_01", "_space", "v1.2"] {
            assert!(is_object_id(ok), "{ok}");
        }
        for bad in ["", ".x", "a:b", "a/b", "a b", &"x".repeat(129)] {
            assert!(!is_object_id(bad), "{bad}");
        }
    }

    #[test]
    fn subject_ids() {
        assert!(is_subject_id("0b6f6a8e-6c1c-4d5b-9b55-3f8d5d1f2a10"));
        assert!(!is_subject_id(""));
        assert!(!is_subject_id("org/slug"));
        assert!(!is_subject_id("a.b"));
    }
}
