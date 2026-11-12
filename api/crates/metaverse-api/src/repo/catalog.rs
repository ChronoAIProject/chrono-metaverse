use super::{collections, Repo, RepoError};
use crate::auth::authorizer::BrowserCatalogGrant;
use metaverse_core::{
    model::{OrgRole, Owner, OwnerKind, Visibility},
    Timestamp,
};
use mongodb::bson::{self, doc, Document};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSpace {
    #[serde(rename(deserialize = "_id"))]
    pub id: String,
    name: String,
    description: String,
    owner: Owner,
    visibility: Visibility,
    updated_at: Timestamp,
    #[serde(default)]
    access: String,
}
impl Repo {
    pub(crate) async fn browser_spaces(
        &self,
        scope: &BrowserCatalogGrant,
        after: Option<&str>,
        limit: i64,
    ) -> Result<Vec<BrowserSpace>, RepoError> {
        let owners: Vec<Document> = scope
            .owners()
            .iter()
            .map(|(o, _)| match o.kind {
                OwnerKind::Person => {
                    doc! {"owner.kind":"person","owner.id":&o.id,"ownerEvidence":{"$exists":false}}
                }
                OwnerKind::Org => {
                    doc! {"owner.kind":"org","owner.id":&o.id,"ownerEvidence.orgId":&o.id}
                }
            })
            .collect();
        let mut filter = doc! {"$or":owners,"deletingAt":{"$exists":false}};
        if let Some(after) = after {
            filter.insert("_id", doc! {"$gt":after});
        }
        let mut cursor = self
            .collection(collections::SPACES)
            .find(filter)
            .projection(
                doc! {"_id":1,"name":1,"description":1,"owner":1,"visibility":1,"updatedAt":1},
            )
            .sort(doc! {"_id":1})
            .limit(limit.clamp(1, 41))
            .await?;
        let mut result = Vec::new();
        while cursor.advance().await? {
            let document: Document = cursor
                .deserialize_current()
                .map_err(|e| RepoError::Corrupt(e.to_string()))?;
            let mut space: BrowserSpace = bson::deserialize_from_document(document)
                .map_err(|e| RepoError::Corrupt(e.to_string()))?;
            space.access = if scope
                .owners()
                .iter()
                .any(|(owner, role)| owner == &space.owner && *role == OrgRole::Admin)
            {
                "manage"
            } else {
                "read"
            }
            .into();
            result.push(space);
        }
        Ok(result)
    }
}
