//! 小事务（设计 5.7、13.3）：按顺序执行几条插入和条件更新，任何一条条件更新匹配不到就
//! 中止整个事务。遇到暂时性错误（`TransientTransactionError`）时整体重试，提交结果未知
//! （`UnknownTransactionCommitResult`）时重试提交。
//!
//! 用于"完成上传 = 上传状态 open→complete + 插入任务"、"组合修订 = 插入修订 + 按
//! head.seq 推进组合"这类两三条写入的事务。

use mongodb::bson::Document;
use mongodb::error::{TRANSIENT_TRANSACTION_ERROR, UNKNOWN_TRANSACTION_COMMIT_RESULT};

use super::{Repo, RepoError};

/// 事务里的一步。
pub(super) enum TxnOp {
    Insert {
        collection: &'static str,
        document: Document,
    },
    /// 必须恰好匹配一条，否则中止事务。
    Update {
        collection: &'static str,
        filter: Document,
        update: Document,
    },
    /// 同上，更新写成聚合管道（例如用量减到 0 为止）。
    UpdatePipeline {
        collection: &'static str,
        filter: Document,
        pipeline: Vec<Document>,
    },
}

/// 事务结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TxnOutcome {
    Committed,
    /// 第几步（从 0 开始）的条件更新没有匹配到，事务已中止。
    NotMatched(usize),
}

const MAX_ATTEMPTS: usize = 5;

impl Repo {
    pub(super) async fn run_transaction(&self, ops: &[TxnOp]) -> Result<TxnOutcome, RepoError> {
        let client = self.database.client();
        let mut last_error = None;
        for _ in 0..MAX_ATTEMPTS {
            let mut session = client.start_session().await?;
            session.start_transaction().await?;
            let mut outcome: Result<TxnOutcome, mongodb::error::Error> = Ok(TxnOutcome::Committed);
            for (index, op) in ops.iter().enumerate() {
                let step = match op {
                    TxnOp::Insert {
                        collection,
                        document,
                    } => self
                        .collection(collection)
                        .insert_one(document.clone())
                        .session(&mut session)
                        .await
                        .map(|_| true),
                    TxnOp::Update {
                        collection,
                        filter,
                        update,
                    } => self
                        .collection(collection)
                        .update_one(filter.clone(), update.clone())
                        .session(&mut session)
                        .await
                        .map(|result| result.matched_count == 1),
                    TxnOp::UpdatePipeline {
                        collection,
                        filter,
                        pipeline,
                    } => self
                        .collection(collection)
                        .update_one(filter.clone(), pipeline.clone())
                        .session(&mut session)
                        .await
                        .map(|result| result.matched_count == 1),
                };
                match step {
                    Ok(true) => {}
                    Ok(false) => {
                        outcome = Ok(TxnOutcome::NotMatched(index));
                        break;
                    }
                    Err(error) => {
                        outcome = Err(error);
                        break;
                    }
                }
            }
            match outcome {
                Ok(TxnOutcome::Committed) => {
                    let mut commit = session.commit_transaction().await;
                    let mut retries = 0;
                    while let Err(error) = &commit {
                        if error.contains_label(UNKNOWN_TRANSACTION_COMMIT_RESULT) && retries < 3 {
                            retries += 1;
                            commit = session.commit_transaction().await;
                        } else {
                            break;
                        }
                    }
                    match commit {
                        Ok(()) => return Ok(TxnOutcome::Committed),
                        Err(error) if error.contains_label(TRANSIENT_TRANSACTION_ERROR) => {
                            last_error = Some(error);
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                Ok(not_matched) => {
                    let _ = session.abort_transaction().await;
                    return Ok(not_matched);
                }
                Err(error) => {
                    let _ = session.abort_transaction().await;
                    if error.contains_label(TRANSIENT_TRANSACTION_ERROR) {
                        last_error = Some(error);
                    } else {
                        return Err(error.into());
                    }
                }
            }
        }
        Err(last_error.map_or(RepoError::Unavailable, RepoError::from))
    }
}
