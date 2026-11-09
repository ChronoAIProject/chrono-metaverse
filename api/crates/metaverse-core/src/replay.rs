//! 按时刻回放（设计 5.2）。
//!
//! 跳到时刻 T：
//!
//! 1. 用 `(spaceId, at)` 找出 S = `at ≤ T` 的最大 seq（[`resolve_seq`]）；
//! 2. 取 `seq ≤ S` 的最近一个关键帧 K——按 seq 找，不按时间找（[`latest_keyframe`]）；
//! 3. 叠加 (K, S] 范围内各次提交的变化（[`replay`]），`hash = null` 表示删除。
//!
//! 整个过程不需要重放操作。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::chunk::ChunkKey;
use crate::model::{ChunkChange, Commit, IdChange, ScanRef};
use crate::Timestamp;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReplayError {
    #[error("提交不连续：期望 seq {expected}，实际 {actual}")]
    Gap { expected: u64, actual: u64 },
    #[error("提交在目标 seq {target} 之前就结束了（最后是 {last}）")]
    Incomplete { target: u64, last: u64 },
    #[error("关键帧 seq {keyframe} 在目标 seq {target} 之后")]
    KeyframeAfterTarget { keyframe: u64, target: u64 },
}

/// 状态清单：某个 seq 时的完整状态（关键帧存的就是它，`stateBlobs` 里按内容哈希保存）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StateManifest {
    pub chunks: BTreeMap<ChunkKey, String>,
    pub entities: BTreeMap<String, String>,
    pub anchors: BTreeMap<String, String>,
    pub regions_hash: Option<String>,
    pub palette_hash: Option<String>,
    pub scan: Option<ScanRef>,
}

/// 状态清单的存储形式：各项按键排序的列表，保证内容哈希稳定。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredManifest {
    pub chunks: Vec<ChunkChange>,
    pub entities: Vec<IdChange>,
    pub anchors: Vec<IdChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regions_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scan: Option<ScanRef>,
}

impl StateManifest {
    pub fn to_stored(&self) -> StoredManifest {
        StoredManifest {
            chunks: self
                .chunks
                .iter()
                .map(|(key, hash)| ChunkChange {
                    layer: key.layer,
                    cx: key.cx,
                    cy: key.cy,
                    cz: key.cz,
                    hash: Some(hash.clone()),
                })
                .collect(),
            entities: id_list(&self.entities),
            anchors: id_list(&self.anchors),
            regions_hash: self.regions_hash.clone(),
            palette_hash: self.palette_hash.clone(),
            scan: self.scan.clone(),
        }
    }

    pub fn from_stored(stored: &StoredManifest) -> Self {
        let mut manifest = StateManifest {
            regions_hash: stored.regions_hash.clone(),
            palette_hash: stored.palette_hash.clone(),
            scan: stored.scan.clone(),
            ..Default::default()
        };
        manifest.apply_chunks(&stored.chunks);
        apply_ids(&mut manifest.entities, &stored.entities);
        apply_ids(&mut manifest.anchors, &stored.anchors);
        manifest
    }

    fn apply_chunks(&mut self, changes: &[ChunkChange]) {
        for change in changes {
            let key = ChunkKey {
                layer: change.layer,
                cx: change.cx,
                cy: change.cy,
                cz: change.cz,
            };
            match &change.hash {
                Some(hash) => {
                    self.chunks.insert(key, hash.clone());
                }
                None => {
                    self.chunks.remove(&key);
                }
            }
        }
    }

    /// 叠加一次提交的变化。
    pub fn apply_commit(&mut self, commit: &Commit) {
        self.apply_chunks(&commit.changed_chunks);
        apply_ids(&mut self.entities, &commit.changed_entities);
        apply_ids(&mut self.anchors, &commit.changed_anchors);
        if let Some(hash) = &commit.regions_hash {
            self.regions_hash = Some(hash.clone());
        }
        if let Some(hash) = &commit.palette_hash {
            self.palette_hash = Some(hash.clone());
        }
        if let Some(scan) = &commit.scan {
            self.scan = Some(scan.clone());
        }
    }
}

fn id_list(map: &BTreeMap<String, String>) -> Vec<IdChange> {
    map.iter()
        .map(|(id, hash)| IdChange {
            id: id.clone(),
            hash: Some(hash.clone()),
        })
        .collect()
}

fn apply_ids(map: &mut BTreeMap<String, String>, changes: &[IdChange]) {
    for change in changes {
        match &change.hash {
            Some(hash) => {
                map.insert(change.id.clone(), hash.clone());
            }
            None => {
                map.remove(&change.id);
            }
        }
    }
}

/// `at ≤ t` 的最大 seq。`heads` 按 seq 升序给出 `(seq, at)`，`at` 随 seq 单调不减，
/// 所以可以二分。没有满足条件的提交时返回 `None`（T 早于第一次提交）。
pub fn resolve_seq(heads: &[(u64, Timestamp)], t: Timestamp) -> Option<u64> {
    let count = heads.partition_point(|(_, at)| *at <= t);
    count.checked_sub(1).map(|index| heads[index].0)
}

/// `seq ≤ target` 的最近一个关键帧。`keyframes` 是 `(seq, 状态清单哈希)`，顺序任意。
pub fn latest_keyframe(keyframes: &[(u64, String)], target: u64) -> Option<&(u64, String)> {
    keyframes
        .iter()
        .filter(|(seq, _)| *seq <= target)
        .max_by_key(|(seq, _)| *seq)
}

/// 从关键帧（或空状态，seq 0）叠加到 `target`。`commits` 必须恰好是
/// (关键帧 seq, target] 范围内的全部提交，按 seq 升序、不重不漏。
pub fn replay(
    base: Option<(u64, StateManifest)>,
    commits: &[Commit],
    target: u64,
) -> Result<StateManifest, ReplayError> {
    let (base_seq, mut manifest) = base.unwrap_or_default();
    if base_seq > target {
        return Err(ReplayError::KeyframeAfterTarget {
            keyframe: base_seq,
            target,
        });
    }
    let mut expected = base_seq + 1;
    for commit in commits {
        if commit.seq != expected || commit.seq > target {
            return Err(ReplayError::Gap {
                expected,
                actual: commit.seq,
            });
        }
        manifest.apply_commit(commit);
        expected += 1;
    }
    if expected - 1 != target {
        return Err(ReplayError::Incomplete {
            target,
            last: expected - 1,
        });
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Actor, ActorKind, Layer, Owner};
    use crate::scope::PathScope;

    fn ts(ms: i64) -> Timestamp {
        Timestamp::from_millis(ms).unwrap()
    }

    fn commit(seq: u64, chunks: Vec<ChunkChange>, entities: Vec<IdChange>) -> Commit {
        Commit {
            id: format!("c{seq}"),
            space_id: "s1".into(),
            owner: Owner::person("alice"),
            seq,
            at: ts(seq as i64 * 1000),
            observed_at: None,
            actor: Actor {
                sub: "alice".into(),
                nyx_service_id: "svc".into(),
                scope: PathScope::Physical,
                kind: ActorKind::Physical,
            },
            author: None,
            message: String::new(),
            ops: None,
            ops_ref: None,
            changed_chunks: chunks,
            changed_entities: entities,
            changed_anchors: vec![],
            regions_hash: None,
            palette_hash: None,
            scan: None,
            keyframe: None,
            job_id: None,
            draft_id: None,
            script_ref: None,
        }
    }

    fn chunk(cx: i32, hash: Option<&str>) -> ChunkChange {
        ChunkChange {
            layer: Layer::Ext,
            cx,
            cy: 0,
            cz: 0,
            hash: hash.map(str::to_owned),
        }
    }

    fn entity(id: &str, hash: Option<&str>) -> IdChange {
        IdChange {
            id: id.into(),
            hash: hash.map(str::to_owned),
        }
    }

    #[test]
    fn resolve_seq_uses_at_with_ties() {
        let heads = [(1, ts(10)), (2, ts(20)), (3, ts(20)), (4, ts(30))];
        assert_eq!(resolve_seq(&heads, ts(5)), None);
        assert_eq!(resolve_seq(&heads, ts(10)), Some(1));
        assert_eq!(resolve_seq(&heads, ts(25)), Some(3));
        assert_eq!(resolve_seq(&heads, ts(99)), Some(4));
    }

    #[test]
    fn keyframe_by_seq_not_time() {
        let keyframes = [(50, "k50".to_owned()), (100, "k100".to_owned())];
        assert_eq!(latest_keyframe(&keyframes, 99).unwrap().0, 50);
        assert_eq!(latest_keyframe(&keyframes, 100).unwrap().0, 100);
        assert!(latest_keyframe(&keyframes, 49).is_none());
    }

    #[test]
    fn deltas_apply_including_null_deletions() {
        let commits = vec![
            commit(
                1,
                vec![chunk(0, Some("a")), chunk(1, Some("b"))],
                vec![entity("e1", Some("h1"))],
            ),
            commit(
                2,
                vec![chunk(0, None)],
                vec![entity("e1", Some("h2")), entity("e2", Some("h3"))],
            ),
            commit(3, vec![], vec![entity("e2", None)]),
        ];
        let state = replay(None, &commits, 3).unwrap();
        assert_eq!(state.chunks.len(), 1);
        assert_eq!(state.entities.len(), 1);
        assert_eq!(state.entities["e1"], "h2");
        let at_two = replay(None, &commits[..2], 2).unwrap();
        assert_eq!(at_two.entities.len(), 2);
        // 从关键帧继续叠加，结果与从头叠加一致。
        let keyframe = StateManifest::from_stored(&at_two.to_stored());
        assert_eq!(keyframe, at_two);
        assert_eq!(
            replay(Some((2, keyframe)), &commits[2..], 3).unwrap(),
            state
        );
    }

    #[test]
    fn gaps_and_incomplete_ranges_are_errors() {
        let commits = vec![commit(1, vec![], vec![]), commit(3, vec![], vec![])];
        assert_eq!(
            replay(None, &commits, 3),
            Err(ReplayError::Gap {
                expected: 2,
                actual: 3
            })
        );
        assert_eq!(
            replay(None, &commits[..1], 2),
            Err(ReplayError::Incomplete { target: 2, last: 1 })
        );
        assert!(replay(Some((5, StateManifest::default())), &[], 4).is_err());
        assert_eq!(replay(None, &[], 0).unwrap(), StateManifest::default());
    }
}
