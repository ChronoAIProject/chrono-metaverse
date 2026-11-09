//! `/api/public/spaces/{id}/head` 的进程内短缓存（设计 8.2：缓存 1–2 秒，同一空间每秒最多
//! 读一次数据库）。
//!
//! 缓存里同时保存空间的授权信息（主人、可见性、分享令牌哈希），命中时先用它校验分享令牌，
//! 校验通过才返回缓存的数据（"进程内缓存必须在校验令牌之后才能命中"）。所以吊销的令牌
//! 最多还能用一个缓存周期。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use metaverse_core::Timestamp;

use crate::repo::SpacePolicy;

/// 缓存时长。
pub const HEAD_CACHE_TTL: Duration = Duration::from_millis(1500);
/// 最多缓存的空间数，超过时先清掉过期项，仍然超过就全部清空。
const MAX_ENTRIES: usize = 10_000;

/// `/head` 返回的数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadData {
    pub seq: u64,
    pub at: Timestamp,
    /// 最新的公开可见变化的记录时间；没有公开事件时为空。
    pub recorded_at: Option<Timestamp>,
}

#[derive(Clone)]
pub struct CachedHead {
    pub policy: SpacePolicy,
    pub head: HeadData,
    fetched: Instant,
}

#[derive(Default)]
pub struct HeadCache {
    entries: Mutex<HashMap<String, CachedHead>>,
}

impl HeadCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 没过期的缓存项。
    pub fn get(&self, space_id: &str) -> Option<CachedHead> {
        let entries = self.entries.lock().ok()?;
        entries
            .get(space_id)
            .filter(|entry| entry.fetched.elapsed() < HEAD_CACHE_TTL)
            .cloned()
    }

    pub fn put(&self, space_id: &str, policy: SpacePolicy, head: HeadData) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if entries.len() >= MAX_ENTRIES {
            entries.retain(|_, entry| entry.fetched.elapsed() < HEAD_CACHE_TTL);
            if entries.len() >= MAX_ENTRIES {
                entries.clear();
            }
        }
        entries.insert(
            space_id.to_owned(),
            CachedHead {
                policy,
                head,
                fetched: Instant::now(),
            },
        );
    }

    /// 空间的事件或可见性变了：丢掉缓存。
    pub fn invalidate(&self, space_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(space_id);
        }
    }
}
