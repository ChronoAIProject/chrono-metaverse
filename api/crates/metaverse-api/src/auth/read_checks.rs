use std::{
    collections::HashMap,
    future::{ready, Future},
    hash::Hash,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{
    future::{BoxFuture, Shared, WeakShared},
    FutureExt,
};
use tokio::time::Instant;

type Check<T> = BoxFuture<'static, T>;
const TTL: Duration = Duration::from_secs(5);
const CAPACITY: usize = 1024;

struct Cached<T> {
    value: T,
    expires_at: Instant,
}

struct Checks<K, T> {
    pending: HashMap<K, WeakShared<Check<T>>>,
    cached: HashMap<K, Cached<T>>,
}

/// 合并正在进行的鉴权查询，并短时保留成功的结果供工作台场景读取复用。
pub(super) struct ReadChecks<K, T> {
    checks: Arc<Mutex<Checks<K, T>>>,
    cacheable: fn(&T) -> bool,
    capacity: usize,
}

impl<K, T> ReadChecks<K, T> {
    pub(super) fn new(cacheable: fn(&T) -> bool) -> Self {
        Self {
            checks: Arc::new(Mutex::new(Checks {
                pending: HashMap::new(),
                cached: HashMap::new(),
            })),
            cacheable,
            capacity: CAPACITY,
        }
    }
}

impl<K: Eq + Hash + Clone + Send + 'static, T: Clone + Send + Sync + 'static> ReadChecks<K, T> {
    pub(super) fn check<F>(
        &self,
        key: K,
        reuse_cached: bool,
        start: impl FnOnce() -> F,
    ) -> Shared<Check<T>>
    where
        F: Future<Output = T> + Send + 'static,
    {
        let mut checks = self
            .checks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(check) = checks
            .pending
            .get(&key)
            .and_then(WeakShared::upgrade)
            .filter(|check| check.peek().is_none())
        {
            return check;
        }
        if reuse_cached {
            if let Some(cached) = checks
                .cached
                .get(&key)
                .filter(|c| Instant::now() < c.expires_at)
            {
                return ready(cached.value.clone()).boxed().shared();
            }
        }
        checks
            .pending
            .retain(|_, weak| weak.upgrade().is_some_and(|check| check.peek().is_none()));
        checks.cached.remove(&key);
        let state = Arc::downgrade(&self.checks);
        let cacheable = self.cacheable;
        let capacity = self.capacity;
        let cache_key = key.clone();
        let lookup = start();
        let check = async move {
            let expires_at = Instant::now() + TTL;
            let value = lookup.await;
            let now = Instant::now();
            if now < expires_at && cacheable(&value) {
                if let Some(state) = state.upgrade() {
                    let mut checks = state.lock().unwrap_or_else(|error| error.into_inner());
                    checks.cached.retain(|_, c| now < c.expires_at);
                    if checks.cached.len() == capacity {
                        let oldest = checks
                            .cached
                            .iter()
                            .min_by_key(|(_, c)| c.expires_at)
                            .map(|(key, _)| key.clone());
                        if let Some(oldest) = oldest {
                            checks.cached.remove(&oldest);
                        }
                    }
                    checks.cached.insert(
                        cache_key,
                        Cached {
                            value: value.clone(),
                            expires_at,
                        },
                    );
                }
            }
            value
        }
        .boxed()
        .shared();
        checks
            .pending
            .insert(key, check.downgrade().expect("刚创建的查询尚未完成"));
        check
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn joins_pending_checks_and_only_reuses_completed_checks_for_reads() {
        let checks = ReadChecks::new(|_| true);
        let (release, wait) = tokio::sync::oneshot::channel();
        let mut first = checks.check("same", true, || async { wait.await.unwrap() });
        assert!(futures_util::poll!(&mut first).is_pending());
        let overlap = checks.check("same", true, || async { panic!("重复发起了查询") });
        assert_eq!(checks.check("other", true, || async { 2 }).await, 2);

        release.send(1).unwrap();
        assert_eq!(first.await, 1);
        assert_eq!(checks.check("same", true, || async { 3 }).await, 1);
        assert_eq!(checks.check("same", false, || async { 3 }).await, 3);
        assert_eq!(overlap.await, 1);

        let abandoned = checks.check("same", false, std::future::pending);
        drop(abandoned);
        assert_eq!(checks.check("same", true, || async { 4 }).await, 4);
    }

    #[tokio::test(start_paused = true)]
    async fn expires_from_lookup_start_and_ignores_failed_results() {
        let checks = ReadChecks::new(Result::is_ok);
        let load = || async {
            tokio::time::sleep(Duration::from_secs(2)).await;
            Ok(1)
        };
        assert_eq!(checks.check(0, true, load).await, Ok(1));
        tokio::time::advance(Duration::from_secs(2)).await;
        assert_eq!(checks.check(0, true, || async { Err(429) }).await, Ok(1));
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(checks.check(0, true, || async { Err(429) }).await, Err(429));
        assert_eq!(checks.check(0, true, || async { Ok(2) }).await, Ok(2));
        assert_eq!(
            checks.check(0, false, || async { Err(401) }).await,
            Err(401)
        );
        assert_eq!(checks.check(0, true, || async { Ok(3) }).await, Ok(3));
    }

    #[tokio::test(start_paused = true)]
    async fn bounds_completed_entries_and_isolates_credentials_and_organizations() {
        let mut checks = ReadChecks::new(|_| true);
        checks.capacity = 2;
        let key = ("user", "version", "org");
        let other_credential = ("user", "new-version", "org");
        let other_org = ("user", "version", "other-org");
        assert_eq!(checks.check(key, true, || async { 1 }).await, 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        assert_eq!(
            checks.check(other_credential, true, || async { 2 }).await,
            2
        );
        assert_eq!(checks.check(other_org, true, || async { 3 }).await, 3);
        assert_eq!(
            checks.check(other_credential, true, || async { 4 }).await,
            2
        );
        assert_eq!(checks.check(key, true, || async { 5 }).await, 5);
        assert_eq!(checks.checks.lock().unwrap().cached.len(), 2);
    }
}
