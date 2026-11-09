//! 进程内缓存（设计 8.2）：快照、区块、资源共用一份有字节上限的缓存，满了按最久未用淘汰。
//!
//! - 键是字符串，按用途加前缀（[`CacheKey`]），方便按空间整体失效；
//! - 值是 [`Bytes`]（已经编码好的响应体），复制只是增加引用计数；
//! - **必须在校验令牌之后才能查缓存**：缓存里没有任何授权信息，调用方先拿到授权凭据再来取。

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use axum::body::Bytes;

/// 缓存键。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CacheKey {
    /// 公开快照：空间、版本、读取时空间的最新 seq（锚点可见性只会随新提交改变）。
    Snapshot {
        space_id: String,
        seq: u64,
        head_seq: u64,
    },
    /// 已发布的区块（压缩后的存储字节）。
    Chunk(String),
    /// 登记过的资源（整份内容；只缓存不大的资源）。
    Asset(String),
    /// 其他分工自己的用途：`(用途, 空间编号, 附加键)`。
    Other {
        purpose: &'static str,
        space_id: String,
        key: String,
    },
}

impl CacheKey {
    fn encode(&self) -> String {
        match self {
            CacheKey::Snapshot {
                space_id,
                seq,
                head_seq,
            } => format!("space:{space_id}:snapshot:{seq}:{head_seq}"),
            CacheKey::Chunk(hash) => format!("chunk:{hash}"),
            CacheKey::Asset(hash) => format!("asset:{hash}"),
            CacheKey::Other {
                purpose,
                space_id,
                key,
            } => format!("space:{space_id}:{purpose}:{key}"),
        }
    }
}

struct Entry {
    value: Bytes,
    tick: u64,
}

struct Inner {
    entries: HashMap<String, Entry>,
    /// 最近使用的先后：tick → 键。
    order: BTreeMap<u64, String>,
    total: usize,
    tick: u64,
}

/// 有字节上限的缓存。
pub struct ByteCache {
    capacity: usize,
    max_item: usize,
    inner: Mutex<Inner>,
}

impl ByteCache {
    /// `capacity` 是总字节上限；单项超过 `capacity / 8` 的不缓存，避免一项挤掉全部。
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            max_item: capacity / 8,
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                order: BTreeMap::new(),
                total: 0,
                tick: 0,
            }),
        }
    }

    /// 单项最大字节数。
    pub fn max_item_bytes(&self) -> usize {
        self.max_item
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn get(&self, key: &CacheKey) -> Option<Bytes> {
        let encoded = key.encode();
        let mut inner = self.lock();
        inner.tick += 1;
        let tick = inner.tick;
        let entry = inner.entries.get_mut(&encoded)?;
        let old = std::mem::replace(&mut entry.tick, tick);
        let value = entry.value.clone();
        inner.order.remove(&old);
        inner.order.insert(tick, encoded);
        Some(value)
    }

    pub fn insert(&self, key: &CacheKey, value: Bytes) {
        if value.len() > self.max_item || self.capacity == 0 {
            return;
        }
        let encoded = key.encode();
        let mut inner = self.lock();
        inner.tick += 1;
        let tick = inner.tick;
        if let Some(old) = inner.entries.remove(&encoded) {
            inner.order.remove(&old.tick);
            inner.total -= old.value.len();
        }
        inner.total += value.len();
        inner.order.insert(tick, encoded.clone());
        inner.entries.insert(encoded, Entry { value, tick });
        while inner.total > self.capacity {
            let Some((_, oldest)) = inner.order.pop_first() else {
                break;
            };
            if let Some(evicted) = inner.entries.remove(&oldest) {
                inner.total -= evicted.value.len();
            }
        }
    }

    /// 清掉某个空间的全部缓存（快照和其他按空间分的项）。锚点改成内部级时调用。
    pub fn invalidate_space(&self, space_id: &str) {
        let prefix = format!("space:{space_id}:");
        let mut inner = self.lock();
        let doomed: Vec<(String, u64)> = inner
            .entries
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(key, entry)| (key.clone(), entry.tick))
            .collect();
        for (key, tick) in doomed {
            inner.order.remove(&tick);
            if let Some(entry) = inner.entries.remove(&key) {
                inner.total -= entry.value.len();
            }
        }
    }

    /// 当前占用的字节数。
    pub fn used_bytes(&self) -> usize {
        self.lock().total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(n: usize) -> Bytes {
        Bytes::from(vec![7u8; n])
    }

    #[test]
    fn evicts_least_recently_used_within_capacity() {
        let cache = ByteCache::new(800);
        let a = CacheKey::Chunk("a".into());
        let b = CacheKey::Chunk("b".into());
        let c = CacheKey::Chunk("c".into());
        cache.insert(&a, bytes(100));
        cache.insert(&b, bytes(100));
        // 太大的项不缓存。
        cache.insert(&c, bytes(101));
        assert!(cache.get(&c).is_none());
        // 用过 a，满了以后先淘汰 b。
        assert!(cache.get(&a).is_some());
        for i in 0..7 {
            cache.insert(&CacheKey::Asset(format!("x{i}")), bytes(100));
        }
        assert!(cache.used_bytes() <= 800);
        assert!(cache.get(&b).is_none());
        assert!(cache.get(&a).is_some());
        // 同一个键覆盖时不重复计数。
        cache.insert(&a, bytes(50));
        assert!(cache.used_bytes() <= 800);
    }

    #[test]
    fn invalidates_one_space_only() {
        let cache = ByteCache::new(1 << 20);
        let snapshot = |space: &str| CacheKey::Snapshot {
            space_id: space.into(),
            seq: 1,
            head_seq: 2,
        };
        cache.insert(&snapshot("front-hall"), bytes(10));
        cache.insert(&snapshot("front-hall-2"), bytes(10));
        cache.insert(&CacheKey::Chunk("h".into()), bytes(10));
        cache.invalidate_space("front-hall");
        assert!(cache.get(&snapshot("front-hall")).is_none());
        assert!(cache.get(&snapshot("front-hall-2")).is_some());
        assert!(cache.get(&CacheKey::Chunk("h".into())).is_some());
        assert_eq!(cache.used_bytes(), 20);
    }
}
