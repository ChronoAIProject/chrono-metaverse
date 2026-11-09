//! 规范化 JSON 与内容哈希（SHAPES 5）。
//!
//! 规则：
//!
//! - 对象的键按 Unicode 码点排序（注意：不是 JavaScript 默认的 UTF-16 码元顺序，
//!   两者在辅助平面字符上不同，测试向量里有专门的例子）；
//! - 不留空白；
//! - 数字用最短的往返表示，整数不带小数点。具体写法与 ECMAScript 的
//!   `Number.prototype.toString` 一致（也就是 RFC 8785 的写法）：
//!   `1e21` 以上和 `1e-7` 以下用指数形式，如 `1e+21`、`1.5e-7`；`-0` 写成 `0`；
//! - 整数必须在 ±(2^53 − 1) 以内，超出就拒绝，因为 JavaScript 无法精确表示；
//! - 字符串用 JSON 标准转义：只转义 `"`、`\` 和 U+0000–U+001F，控制字符优先用
//!   `\b \f \n \r \t`，其余写成小写的 `\u00xx`；其他字符原样输出 UTF-8。
//!
//! 内容哈希 = 规范化字符串的 UTF-8 字节做 `sha256`，小写十六进制。

use serde::Serialize;
use serde_json::{Number, Value};

use crate::sha256_hex;

/// JavaScript 能精确表示的最大整数。
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CanonicalError {
    #[error("整数超出 ±(2^53 − 1) 的安全范围")]
    UnsafeInteger,
    #[error("数字不是有限值")]
    NonFinite,
    #[error("不是合法的 JSON：{0}")]
    Parse(String),
    #[error("无法序列化成 JSON：{0}")]
    Serialize(String),
}

/// 把 JSON 值写成规范化字符串。
pub fn canonical_json(value: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

/// 先序列化成 JSON 值，再规范化。
pub fn canonical_json_of<T: Serialize + ?Sized>(value: &T) -> Result<String, CanonicalError> {
    let value = serde_json::to_value(value)
        .map_err(|error| CanonicalError::Serialize(error.to_string()))?;
    canonical_json(&value)
}

/// 解析 JSON 文本并规范化。
pub fn canonicalize_text(text: &str) -> Result<String, CanonicalError> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| CanonicalError::Parse(error.to_string()))?;
    canonical_json(&value)
}

/// JSON 值的内容哈希。
pub fn content_hash(value: &Value) -> Result<String, CanonicalError> {
    Ok(sha256_hex(canonical_json(value)?.as_bytes()))
}

/// 任意可序列化对象的内容哈希。
pub fn content_hash_of<T: Serialize + ?Sized>(value: &T) -> Result<String, CanonicalError> {
    Ok(sha256_hex(canonical_json_of(value)?.as_bytes()))
}

fn write_value(value: &Value, out: &mut String) -> Result<(), CanonicalError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out)?,
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // 显式排序：即使依赖图里有人打开了 serde_json 的 preserve_order，
            // 结果也不变。Rust 字符串按 UTF-8 字节比较，等价于按码点比较。
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            out.push('{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_value(item, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_number(number: &Number, out: &mut String) -> Result<(), CanonicalError> {
    if let Some(value) = number.as_u64() {
        if value > MAX_SAFE_INTEGER {
            return Err(CanonicalError::UnsafeInteger);
        }
        out.push_str(&value.to_string());
        return Ok(());
    }
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(CanonicalError::UnsafeInteger);
        }
        out.push_str(&value.to_string());
        return Ok(());
    }
    let value = number.as_f64().ok_or(CanonicalError::NonFinite)?;
    out.push_str(&format_number(value)?);
    Ok(())
}

/// 按 ECMAScript `Number.prototype.toString` 的规则写一个浮点数。
pub fn format_number(value: f64) -> Result<String, CanonicalError> {
    if !value.is_finite() {
        return Err(CanonicalError::NonFinite);
    }
    if value == 0.0 {
        return Ok("0".into());
    }
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    // Rust 的 `{:e}` 给出能往返的最短有效数字，例如 "1.2345e-7"、"5e-324"。
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("科学计数法一定含有 e");
    let exponent: i32 = exponent.parse().expect("指数是整数");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // 值 = 0.d1d2…dk × 10^n
    let n = exponent + 1;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        let e = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e >= 0 { '+' } else { '-' });
        out.push_str(&e.abs().to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_follow_ecmascript() {
        for (value, expected) in [
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (100.0, "100"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (123456.789, "123456.789"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (-0.0, "0"),
        ] {
            assert_eq!(format_number(value).unwrap(), expected, "{value}");
        }
        assert!(format_number(f64::NAN).is_err());
    }

    #[test]
    fn keys_sort_by_code_point_and_whitespace_is_removed() {
        let text = "{ \"b\": 1, \"a\": [true, null, \"x\"], \"\u{ff61}\": 1, \"\u{1f600}\": 2, \"A\": {\"z\": 1.0, \"y\": -0} }";
        assert_eq!(
            canonicalize_text(text).unwrap(),
            "{\"A\":{\"y\":0,\"z\":1},\"a\":[true,null,\"x\"],\"b\":1,\"\u{ff61}\":1,\"\u{1f600}\":2}"
        );
    }

    #[test]
    fn strings_use_minimal_standard_escapes() {
        let value = json!("q\"b\\s/\u{08}\u{0c}\n\r\t\u{01}\u{1f}\u{7f}é\u{2028}");
        assert_eq!(
            canonical_json(&value).unwrap(),
            "\"q\\\"b\\\\s/\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}é\u{2028}\""
        );
    }

    #[test]
    fn unsafe_integers_are_rejected() {
        assert!(canonical_json(&json!(9_007_199_254_740_991_u64)).is_ok());
        assert_eq!(
            canonical_json(&json!(9_007_199_254_740_992_u64)),
            Err(CanonicalError::UnsafeInteger)
        );
        assert_eq!(
            canonical_json(&json!(-9_007_199_254_740_992_i64)),
            Err(CanonicalError::UnsafeInteger)
        );
    }

    #[test]
    fn hash_is_over_canonical_bytes() {
        let left = content_hash(&json!({"a": 1, "b": [1.0, 2.5]})).unwrap();
        let right =
            content_hash(&serde_json::from_str("{\"b\":[1,2.5],\"a\":1}").unwrap()).unwrap();
        assert_eq!(left, right);
        assert_eq!(left, sha256_hex(b"{\"a\":1,\"b\":[1,2.5]}"));
    }
}
