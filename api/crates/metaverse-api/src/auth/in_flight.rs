use std::{collections::HashMap, future::Future, hash::Hash, sync::Mutex};

use futures_util::{
    future::{BoxFuture, Shared, WeakShared},
    FutureExt,
};

type Check<T> = BoxFuture<'static, T>;

/// 合并并发的鉴权查询。查询完成后，新请求必须重新查；所有等待者取消时也释放查询。
pub(super) struct InFlight<K, T: Clone>(Mutex<HashMap<K, WeakShared<Check<T>>>>);

impl<K, T: Clone> Default for InFlight<K, T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<K: Eq + Hash, T: Clone> InFlight<K, T> {
    pub(super) fn check<F>(&self, key: K, start: impl FnOnce() -> F) -> Shared<Check<T>>
    where
        F: Future<Output = T> + Send + 'static,
    {
        let mut pending = self.0.lock().unwrap_or_else(|error| error.into_inner());
        pending.retain(|_, weak| weak.upgrade().is_some_and(|check| check.peek().is_none()));
        if let Some(check) = pending
            .get(&key)
            .and_then(WeakShared::upgrade)
            .filter(|check| check.peek().is_none())
        {
            return check;
        }
        let check = start().boxed().shared();
        pending.insert(key, check.downgrade().expect("刚创建的查询尚未完成"));
        check
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shares_only_pending_checks_for_the_same_key() {
        let checks = InFlight::default();
        let (release, wait) = tokio::sync::oneshot::channel();
        let mut first = checks.check("same", || async { wait.await.unwrap() });
        assert!(futures_util::poll!(&mut first).is_pending());
        let overlap = checks.check("same", || async { panic!("重复发起了查询") });
        assert_eq!(checks.check("other", || async { 2 }).await, 2);

        release.send(1).unwrap();
        assert_eq!(first.await, 1);
        assert_eq!(checks.check("same", || async { 3 }).await, 3);
        assert_eq!(overlap.await, 1);

        let abandoned = checks.check("same", std::future::pending);
        drop(abandoned);
        assert_eq!(checks.check("same", || async { 4 }).await, 4);
    }
}
