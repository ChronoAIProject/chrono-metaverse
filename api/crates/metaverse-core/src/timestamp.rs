//! 时间戳。与 CMA 一样以 RFC 3339 字符串存储和传输。
//!
//! 统一写成 `YYYY-MM-DDTHH:MM:SS.mmmZ`（UTC、毫秒、四位年份），这样字符串的
//! 字典序就是时间先后，MongoDB 上的 `(spaceId, at)` 范围查询可以直接用。

use std::fmt;

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

/// 0000-01-01T00:00:00.000Z
const MIN_MILLIS: i64 = -62_167_219_200_000;
/// 9999-12-31T23:59:59.999Z
const MAX_MILLIS: i64 = 253_402_300_799_999;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(i64);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TimestampError {
    #[error("时间戳不是合法的 RFC 3339 时间")]
    Format,
    #[error("时间戳超出 0000–9999 年的范围")]
    Range,
}

impl Timestamp {
    /// Unix 纪元以来的毫秒数。超出 0000–9999 年时返回错误。
    pub fn from_millis(millis: i64) -> Result<Self, TimestampError> {
        if (MIN_MILLIS..=MAX_MILLIS).contains(&millis) {
            Ok(Self(millis))
        } else {
            Err(TimestampError::Range)
        }
    }

    pub fn millis(self) -> i64 {
        self.0
    }

    /// 由调用方传入的系统时间（核心库自己不读时钟）。
    pub fn from_system_time(time: std::time::SystemTime) -> Result<Self, TimestampError> {
        let millis = match time.duration_since(std::time::UNIX_EPOCH) {
            Ok(after) => i64::try_from(after.as_millis()).map_err(|_| TimestampError::Range)?,
            Err(before) => {
                let before = i64::try_from(before.duration().as_millis())
                    .map_err(|_| TimestampError::Range)?;
                -before
            }
        };
        Self::from_millis(millis)
    }

    /// 加上若干毫秒，结果钳在合法范围内。
    pub fn saturating_add_millis(self, millis: i64) -> Self {
        Self(self.0.saturating_add(millis).clamp(MIN_MILLIS, MAX_MILLIS))
    }

    pub fn saturating_add_seconds(self, seconds: i64) -> Self {
        self.saturating_add_millis(seconds.saturating_mul(1000))
    }

    /// 两个时间相差的毫秒数（`self - earlier`）。
    pub fn millis_since(self, earlier: Timestamp) -> i64 {
        self.0 - earlier.0
    }

    pub fn to_rfc3339(self) -> String {
        let datetime = OffsetDateTime::from_unix_timestamp_nanos(i128::from(self.0) * 1_000_000)
            .expect("毫秒数已在合法范围内");
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            datetime.year(),
            u8::from(datetime.month()),
            datetime.day(),
            datetime.hour(),
            datetime.minute(),
            datetime.second(),
            datetime.millisecond()
        )
    }

    /// 接受任意时区偏移的 RFC 3339 时间，换算成 UTC 毫秒（不足一毫秒的部分舍去）。
    pub fn parse_rfc3339(value: &str) -> Result<Self, TimestampError> {
        if value.len() > 64 {
            return Err(TimestampError::Format);
        }
        let parsed = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| TimestampError::Format)?;
        let millis = parsed.unix_timestamp_nanos().div_euclid(1_000_000);
        let millis = i64::try_from(millis).map_err(|_| TimestampError::Range)?;
        Self::from_millis(millis)
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_rfc3339())
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_rfc3339())
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse_rfc3339(&raw).map_err(de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_format_and_round_trip() {
        let at = Timestamp::from_millis(1_762_603_200_123).unwrap();
        assert_eq!(at.to_rfc3339(), "2025-11-08T12:00:00.123Z");
        assert_eq!(Timestamp::parse_rfc3339(&at.to_rfc3339()).unwrap(), at);
        assert_eq!(
            Timestamp::parse_rfc3339("2025-11-08T20:00:00.123+08:00").unwrap(),
            at
        );
        assert_eq!(
            serde_json::to_string(&at).unwrap(),
            "\"2025-11-08T12:00:00.123Z\""
        );
    }

    #[test]
    fn lexicographic_order_matches_time_order() {
        let a = Timestamp::from_millis(-1).unwrap();
        let b = Timestamp::from_millis(0).unwrap();
        let c = Timestamp::from_millis(999).unwrap();
        let d = Timestamp::from_millis(1000).unwrap();
        let strings: Vec<_> = [a, b, c, d].iter().map(|t| t.to_rfc3339()).collect();
        let mut sorted = strings.clone();
        sorted.sort();
        assert_eq!(strings, sorted);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(Timestamp::parse_rfc3339("yesterday").is_err());
        assert!(Timestamp::parse_rfc3339("2025-11-08T12:00:00").is_err());
        assert!(Timestamp::parse_rfc3339("2025-13-08T12:00:00Z").is_err());
        assert!(Timestamp::from_millis(MAX_MILLIS + 1).is_err());
        assert_eq!(
            Timestamp::from_millis(MAX_MILLIS)
                .unwrap()
                .saturating_add_seconds(10)
                .millis(),
            MAX_MILLIS
        );
    }
}
