//! 空间子空间关系的迁移和事务栅栏。所有图变化共用版本号，避免两个并发加入各自检查通过后形成循环。

use std::collections::{BTreeMap, BTreeSet};

use metaverse_core::model::{Universe, UniverseRevision, UniverseState};
use mongodb::bson::{doc, Document};

use super::transactions::{TxnOp, TxnOutcome};
use super::universes::{native_revision_document, native_space_document};
use super::{collections, Repo, RepoError};

pub const MAX_COMPOSITION_DEPTH: usize = 8;
pub const MAX_COMPOSITION_INSTANCES: usize = 256;

type Graph = BTreeMap<String, Vec<String>>;

fn validate_graph(graph: &Graph) -> Result<(), RepoError> {
    fn visit<'a>(
        id: &'a str,
        graph: &'a Graph,
        path: &mut BTreeSet<&'a str>,
        count: &mut usize,
    ) -> Result<(), RepoError> {
        if !path.insert(id) {
            return Err(RepoError::InvalidComposition(
                "空间不能直接或间接引用自身".into(),
            ));
        }
        if path.len() > MAX_COMPOSITION_DEPTH + 1 {
            return Err(RepoError::InvalidComposition(format!(
                "子空间最多嵌套 {MAX_COMPOSITION_DEPTH} 层"
            )));
        }
        *count += 1;
        if *count > MAX_COMPOSITION_INSTANCES {
            return Err(RepoError::InvalidComposition(format!(
                "展开后最多 {MAX_COMPOSITION_INSTANCES} 个空间实例"
            )));
        }
        for child in graph.get(id).into_iter().flatten() {
            visit(child, graph, path, count)?;
        }
        path.remove(id);
        Ok(())
    }
    for root in graph.keys() {
        visit(root, graph, &mut BTreeSet::new(), &mut 0)?;
    }
    Ok(())
}

impl Repo {
    /// 在首次接收请求前迁移旧组合。旧集合保留供核对，之后所有读写只使用 spaces 和 commits。
    pub async fn prepare_space_composition(&self) -> Result<(), RepoError> {
        let initialized = self
            .collection(collections::MIGRATIONS)
            .update_one(
                doc! {"_id": "space-composition-graph"},
                doc! {"$setOnInsert": {"version": 0_i64}},
            )
            .upsert(true)
            .await;
        if let Err(error) = initialized {
            let error = RepoError::from(error);
            if !matches!(error, RepoError::Duplicate) {
                return Err(error);
            }
        }
        let mut cursor = self
            .collection(collections::UNIVERSES)
            .find(doc! {"migratedToSpace": {"$ne": true}})
            .await?;
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|e| RepoError::Corrupt(e.to_string()))?;
            let id = document
                .get_str("_id")
                .map_err(|e| RepoError::Corrupt(e.to_string()))?
                .to_owned();
            self.migrate_universe(&id).await?;
        }
        Ok(())
    }

    async fn migrate_universe(&self, id: &str) -> Result<(), RepoError> {
        for _ in 0..8 {
            let Some(document) = self
                .collection(collections::UNIVERSES)
                .find_one(doc! {"_id": id})
                .await?
            else {
                return Ok(());
            };
            if document.get_bool("migratedToSpace").unwrap_or(false) {
                return Ok(());
            }
            let universe: Universe = mongodb::bson::deserialize_from_document(document)
                .map_err(|e| RepoError::Corrupt(e.to_string()))?;
            if self
                .collection(collections::SPACES)
                .find_one(doc! {"_id": id})
                .await?
                .is_some()
            {
                // 标记和新空间同事务提交；另一个副本完成迁移后再次读取标记即可。
                if self
                    .collection(collections::UNIVERSES)
                    .find_one(doc! {"_id": id, "migratedToSpace": true})
                    .await?
                    .is_some()
                {
                    return Ok(());
                }
                return Err(RepoError::Corrupt(format!(
                    "旧组合 {id} 与空间编号冲突，需先重命名后迁移"
                )));
            }
            let mut space = native_space_document(&universe)?;
            space.insert("migratedFromUniverse", true);
            let mut ops = vec![TxnOp::Insert {
                collection: collections::SPACES,
                document: space,
            }];
            let mut revisions = self
                .collection(collections::UNIVERSE_REVISIONS)
                .find(doc! {"universeId": id})
                .sort(doc! {"seq": 1})
                .await?;
            while revisions.advance().await? {
                let document: Document = revisions
                    .deserialize_current()
                    .map_err(|e| RepoError::Corrupt(e.to_string()))?;
                let mut revision: UniverseRevision =
                    mongodb::bson::deserialize_from_document(document)
                        .map_err(|e| RepoError::Corrupt(e.to_string()))?;
                revision.owner = Some(universe.owner.clone());
                ops.push(TxnOp::Insert {
                    collection: collections::COMMITS,
                    document: native_revision_document(&revision)?,
                });
            }
            ops.push(TxnOp::Update { collection: collections::UNIVERSES,
                filter: doc! {"_id": id, "head.seq": universe.head.seq as i64, "migratedToSpace": {"$ne": true}},
                update: doc! {"$set": {"migratedToSpace": true}} });
            ops.push(TxnOp::Update {
                collection: collections::MIGRATIONS,
                filter: doc! {"_id": "space-composition-graph"},
                update: doc! {"$inc": {"version": 1}},
            });
            match self.run_transaction(&ops).await {
                Ok(TxnOutcome::Committed) => {
                    tracing::info!(space = id, "旧组合已迁入空间");
                    return Ok(());
                }
                Ok(TxnOutcome::NotMatched(_)) | Err(RepoError::Duplicate) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(RepoError::Unavailable)
    }

    pub(super) async fn validate_composition_graph(
        &self,
        id: &str,
        next: &UniverseState,
    ) -> Result<i64, RepoError> {
        let version = self
            .collection(collections::MIGRATIONS)
            .find_one(doc! {"_id": "space-composition-graph"})
            .await?
            .and_then(|document| document.get_i64("version").ok())
            .ok_or(RepoError::Unavailable)?;
        let mut cursor = self
            .collection(collections::SPACES)
            .find(doc! {"deletingAt": {"$exists": false}})
            .projection(doc! {"_id": 1, "members.spaceId": 1})
            .await?;
        let mut graph = Graph::new();
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|e| RepoError::Corrupt(e.to_string()))?;
            let children = document
                .get_array("members")
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|value| {
                    value
                        .as_document()?
                        .get_str("spaceId")
                        .ok()
                        .map(str::to_owned)
                })
                .collect();
            graph.insert(
                document
                    .get_str("_id")
                    .map_err(|e| RepoError::Corrupt(e.to_string()))?
                    .to_owned(),
                children,
            );
        }
        graph.insert(
            id.to_owned(),
            next.members.iter().map(|m| m.space_id.clone()).collect(),
        );
        validate_graph(&graph)?;
        Ok(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(edges: &[(&str, &[&str])]) -> Graph {
        edges
            .iter()
            .map(|(id, children)| ((*id).into(), children.iter().map(|s| (*s).into()).collect()))
            .collect()
    }

    #[test]
    fn shared_descendants_are_instances_but_ancestor_cycles_are_rejected() {
        assert!(
            validate_graph(&graph(&[("a", &["b", "c"]), ("b", &["d"]), ("c", &["d"])])).is_ok()
        );
        assert!(validate_graph(&graph(&[("a", &["b"]), ("b", &["a"])])).is_err());
        assert!(validate_graph(&graph(&[("a", &["a"])])).is_err());
    }

    #[test]
    fn depth_and_expansion_are_bounded() {
        let chain: Graph = (0..10)
            .map(|i| (i.to_string(), vec![(i + 1).to_string()]))
            .collect();
        assert!(validate_graph(&chain).is_err());
        let mut tree = Graph::new();
        tree.insert("root".into(), (0..64).map(|i| format!("p{i}")).collect());
        for i in 0..64 {
            tree.insert(
                format!("p{i}"),
                (0..4).map(|j| format!("leaf{j}")).collect(),
            );
        }
        assert!(validate_graph(&tree).is_err());
    }
}
