//! 后台执行器和定期清理的配置（docs/design/server-slim.md 4.9）。
//!
//! | 变量 | 默认 | 说明 |
//! |---|---|---|
//! | `RUNNER_LEASE_SECONDS` | 180 | 任务租约 |
//! | `RUNNER_HEARTBEAT_SECONDS` | 45 | 续约间隔，必须小于租约 |
//! | `RUNNER_POLL_SECONDS` | 2 | 没有进程内通知时多久查一次队列 |
//! | `RUNNER_MAX_JOBS_PER_SPACE` | 1 | 每个空间同时运行的任务数 |
//! | `RUNNER_VERIFY_SLOTS` | 2 | 上传核对（`upload_verify`）的名额 |
//! | `RUNNER_HEAVY_SLOTS` | 1 | 重任务（`ops_from_upload`、`bundle_import`）的名额 |
//! | `METAVERSE_INSTANCE_ID` | 主机名-进程号-随机数 | 本进程的编号（租约持有者） |
//! | `CLEANUP_INTERVAL_SECONDS` | 600 | 定期清理的间隔 |
//! | `CLEANUP_ASSET_GRACE_DAYS` | 7 | 资源上传或最近复用多少天以后、没人引用就清理 |
//!
//! 停止时等手上任务的时间固定 20 秒（平台终止宽限 30 秒），没完成的上传按核心库常量
//! `UPLOAD_TTL_SECONDS`（24 小时）清理。

use crate::config::ConfigError;

/// 停止时等手上任务的时间（秒）。
pub const STOP_GRACE_SECONDS: u64 = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerConfig {
    pub lease_seconds: u64,
    pub heartbeat_seconds: u64,
    pub poll_seconds: u64,
    pub max_jobs_per_space: u64,
    pub verify_slots: usize,
    pub heavy_slots: usize,
    pub instance_id: String,
    pub cleanup_interval_seconds: u64,
    pub asset_grace_days: u64,
}

/// 默认的进程编号：主机名-进程号-随机数。
fn default_instance_id() -> String {
    let host = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "api".to_owned());
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{host}-{}-{}", std::process::id(), &random[..8])
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            lease_seconds: 180,
            heartbeat_seconds: 45,
            poll_seconds: 2,
            max_jobs_per_space: 1,
            verify_slots: 2,
            heavy_slots: 1,
            instance_id: default_instance_id(),
            cleanup_interval_seconds: 600,
            asset_grace_days: 7,
        }
    }
}

impl RunnerConfig {
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let defaults = Self::default();
        let optional = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let number = |name: &'static str, default: u64, min: u64, max: u64| match optional(name) {
            None => Ok(default),
            Some(text) => text
                .parse::<u64>()
                .ok()
                .filter(|value| (min..=max).contains(value))
                .ok_or(ConfigError::Invalid(name, text)),
        };
        let lease_seconds = number("RUNNER_LEASE_SECONDS", defaults.lease_seconds, 10, 3600)?;
        let heartbeat_seconds = number(
            "RUNNER_HEARTBEAT_SECONDS",
            defaults.heartbeat_seconds,
            1,
            3600,
        )?;
        if heartbeat_seconds >= lease_seconds {
            return Err(ConfigError::Invalid(
                "RUNNER_HEARTBEAT_SECONDS",
                format!("{heartbeat_seconds}（必须小于 RUNNER_LEASE_SECONDS = {lease_seconds}）"),
            ));
        }
        let instance_id = match optional("METAVERSE_INSTANCE_ID") {
            None => defaults.instance_id,
            Some(id)
                if id.len() <= 128
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b)) =>
            {
                id
            }
            Some(other) => return Err(ConfigError::Invalid("METAVERSE_INSTANCE_ID", other)),
        };
        Ok(Self {
            lease_seconds,
            heartbeat_seconds,
            poll_seconds: number("RUNNER_POLL_SECONDS", defaults.poll_seconds, 1, 300)?,
            max_jobs_per_space: number(
                "RUNNER_MAX_JOBS_PER_SPACE",
                defaults.max_jobs_per_space,
                1,
                64,
            )?,
            verify_slots: number("RUNNER_VERIFY_SLOTS", defaults.verify_slots as u64, 1, 16)?
                as usize,
            heavy_slots: number("RUNNER_HEAVY_SLOTS", defaults.heavy_slots as u64, 1, 8)? as usize,
            instance_id,
            cleanup_interval_seconds: number(
                "CLEANUP_INTERVAL_SECONDS",
                defaults.cleanup_interval_seconds,
                10,
                86_400,
            )?,
            asset_grace_days: number(
                "CLEANUP_ASSET_GRACE_DAYS",
                defaults.asset_grace_days,
                1,
                365,
            )?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn load(values: &[(&str, &str)]) -> Result<RunnerConfig, ConfigError> {
        let map: BTreeMap<String, String> = values
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        RunnerConfig::from_lookup(&|name: &str| map.get(name).cloned())
    }

    #[test]
    fn defaults_follow_the_design() {
        let config = load(&[]).unwrap();
        assert_eq!(config.lease_seconds, 180);
        assert_eq!(config.heartbeat_seconds, 45);
        assert_eq!(config.poll_seconds, 2);
        assert_eq!(config.max_jobs_per_space, 1);
        assert_eq!((config.verify_slots, config.heavy_slots), (2, 1));
        assert_eq!(config.cleanup_interval_seconds, 600);
        assert_eq!(config.asset_grace_days, 7);
        // 主机名-进程号-随机数：两个进程（这里是两次加载）不会撞。
        assert_ne!(config.instance_id, load(&[]).unwrap().instance_id);
    }

    #[test]
    fn overrides_and_rejections() {
        let config = load(&[
            ("RUNNER_VERIFY_SLOTS", "3"),
            ("METAVERSE_INSTANCE_ID", "api-7f9c-1"),
        ])
        .unwrap();
        assert_eq!(config.verify_slots, 3);
        assert_eq!(config.instance_id, "api-7f9c-1");
        for (name, value) in [
            ("RUNNER_LEASE_SECONDS", "0"),
            ("RUNNER_VERIFY_SLOTS", "0"),
            ("RUNNER_HEAVY_SLOTS", "lots"),
            ("METAVERSE_INSTANCE_ID", "两个 字"),
            ("CLEANUP_ASSET_GRACE_DAYS", "0"),
        ] {
            assert!(
                matches!(load(&[(name, value)]), Err(ConfigError::Invalid(n, _)) if n == name),
                "{name}={value}"
            );
        }
        // 续约间隔必须小于租约。
        assert!(matches!(
            load(&[
                ("RUNNER_LEASE_SECONDS", "30"),
                ("RUNNER_HEARTBEAT_SECONDS", "30")
            ]),
            Err(ConfigError::Invalid("RUNNER_HEARTBEAT_SECONDS", _))
        ));
    }
}
