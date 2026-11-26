//! OAuth 凭据仅以密文持久化。授权层持有 StoreAuthority；不开放资源接口读写这些集合。
use std::time::Duration;

use mongodb::{
    bson::{doc, DateTime, Document},
    options::IndexOptions,
    IndexModel,
};

use super::{Repo, RepoError};
use crate::auth::oauth::StoreAuthority;

const GRANTS: &str = "oauthGrants";
const FLOWS: &str = "oauthFlows";
const SESSIONS: &str = "oauthSessions";

#[derive(Clone)]
pub(crate) struct OAuthGrantRecord {
    pub id: String,
    pub subject: String,
    pub incarnation: String,
    pub version: String,
    pub ciphertext: String,
}

pub(crate) struct OAuthSessionRecord {
    pub grant_id: String,
    pub subject: String,
    pub incarnation: String,
}

fn grant(doc: Document) -> Result<OAuthGrantRecord, RepoError> {
    let field = |name| {
        doc.get_str(name)
            .map(str::to_owned)
            .map_err(|_| RepoError::Corrupt("OAuth grant".into()))
    };
    Ok(OAuthGrantRecord {
        id: field("_id")?,
        subject: field("subject")?,
        incarnation: field("incarnation")?,
        version: field("version")?,
        ciphertext: field("ciphertext")?,
    })
}

impl Repo {
    pub(super) async fn ensure_oauth_indexes(&self) -> Result<(), RepoError> {
        for name in [FLOWS, SESSIONS] {
            self.collection(name)
                .create_index(
                    IndexModel::builder()
                        .keys(doc! {"expiresAt":1})
                        .options(
                            IndexOptions::builder()
                                .expire_after(Duration::ZERO)
                                .name("expiry".to_owned())
                                .build(),
                        )
                        .build(),
                )
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn oauth_flow_put(
        &self,
        _: &StoreAuthority,
        id: &str,
        browser: &str,
        sealed: &str,
        expiry: i64,
    ) -> Result<(), RepoError> {
        self.collection(FLOWS).insert_one(doc!{"_id":id,"browser":browser,"ciphertext":sealed,"expiresAt":DateTime::from_millis(expiry*1000)}).await?;
        Ok(())
    }

    pub(crate) async fn oauth_flow_take(
        &self,
        _: &StoreAuthority,
        id: &str,
        browser: &str,
        now: i64,
    ) -> Result<Option<String>, RepoError> {
        self.collection(FLOWS).find_one_and_delete(doc!{"_id":id,"browser":browser,"expiresAt":{"$gt":DateTime::from_millis(now*1000)}}).await?
            .map(|doc|doc.get_str("ciphertext").map(str::to_owned).map_err(|_|RepoError::Corrupt("OAuth flow".into()))).transpose()
    }

    pub(crate) async fn oauth_grant_get(
        &self,
        _: &StoreAuthority,
        id: &str,
    ) -> Result<Option<OAuthGrantRecord>, RepoError> {
        self.collection(GRANTS)
            .find_one(doc! {"_id":id,"active":true})
            .await?
            .map(grant)
            .transpose()
    }

    pub(crate) async fn oauth_grant_put(
        &self,
        _: &StoreAuthority,
        record: &OAuthGrantRecord,
    ) -> Result<(), RepoError> {
        self.collection(GRANTS).replace_one(doc!{"_id":&record.id},doc!{"_id":&record.id,"subject":&record.subject,"incarnation":&record.incarnation,"version":&record.version,"ciphertext":&record.ciphertext,"active":true})
            .upsert(true).await?;
        Ok(())
    }

    /// 多进程共用刷新租约，避免轮换同一 refresh token；版本围栏防止刷新覆盖重新授权/断开。
    pub(crate) async fn oauth_refresh_claim(
        &self,
        _: &StoreAuthority,
        record: &OAuthGrantRecord,
        lease: &str,
        now: i64,
    ) -> Result<bool, RepoError> {
        Ok(self.collection(GRANTS).update_one(doc!{"_id":&record.id,"version":&record.version,"active":true,
            "$or":[{"leaseUntil":{"$exists":false}},{"leaseUntil":{"$lte":DateTime::from_millis(now*1000)}}]},
            doc!{"$set":{"lease":lease,"leaseUntil":DateTime::from_millis((now+60)*1000)}}).await?.matched_count==1)
    }

    pub(crate) async fn oauth_refresh_finish(
        &self,
        _: &StoreAuthority,
        previous: &OAuthGrantRecord,
        lease: &str,
        next: &OAuthGrantRecord,
    ) -> Result<bool, RepoError> {
        Ok(self.collection(GRANTS).update_one(doc!{"_id":&previous.id,"version":&previous.version,"lease":lease,"active":true},
            doc!{"$set":{"ciphertext":&next.ciphertext,"version":&next.version},"$unset":{"lease":"","leaseUntil":""}}).await?.matched_count==1)
    }

    pub(crate) async fn oauth_refresh_release(
        &self,
        _: &StoreAuthority,
        record: &OAuthGrantRecord,
        lease: &str,
    ) -> Result<(), RepoError> {
        self.collection(GRANTS)
            .update_one(
                doc! {"_id":&record.id,"version":&record.version,"lease":lease},
                doc! {"$unset":{"lease":"","leaseUntil":""}},
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn oauth_grant_current(
        &self,
        _: &StoreAuthority,
        record: &OAuthGrantRecord,
    ) -> Result<bool, RepoError> {
        Ok(self.collection(GRANTS).find_one(doc!{"_id":&record.id,"version":&record.version,"incarnation":&record.incarnation,"active":true}).await?.is_some())
    }

    pub(crate) async fn oauth_grant_disable(
        &self,
        _: &StoreAuthority,
        record: &OAuthGrantRecord,
    ) -> Result<(), RepoError> {
        self.collection(GRANTS).update_one(doc!{"_id":&record.id,"version":&record.version,"active":true},
            doc!{"$set":{"active":false},"$unset":{"ciphertext":"","lease":"","leaseUntil":""}}).await?;
        Ok(())
    }

    pub(crate) async fn oauth_session_put(
        &self,
        _: &StoreAuthority,
        id: &str,
        record: &OAuthGrantRecord,
        expiry: i64,
    ) -> Result<(), RepoError> {
        self.collection(SESSIONS).insert_one(doc!{"_id":id,"grantId":&record.id,"subject":&record.subject,"incarnation":&record.incarnation,"expiresAt":DateTime::from_millis(expiry*1000)}).await?;
        Ok(())
    }

    pub(crate) async fn oauth_session_get(
        &self,
        _: &StoreAuthority,
        id: &str,
        now: i64,
    ) -> Result<Option<OAuthSessionRecord>, RepoError> {
        self.collection(SESSIONS)
            .find_one(doc! {"_id":id,"expiresAt":{"$gt":DateTime::from_millis(now*1000)}})
            .await?
            .map(|doc| {
                let field = |name| {
                    doc.get_str(name)
                        .map(str::to_owned)
                        .map_err(|_| RepoError::Corrupt("OAuth session".into()))
                };
                Ok(OAuthSessionRecord {
                    grant_id: field("grantId")?,
                    subject: field("subject")?,
                    incarnation: field("incarnation")?,
                })
            })
            .transpose()
    }

    pub(crate) async fn oauth_disconnect(
        &self,
        _: &StoreAuthority,
        session: &OAuthSessionRecord,
    ) -> Result<(), RepoError> {
        self.collection(GRANTS).update_one(doc!{"_id":&session.grant_id,"subject":&session.subject,"incarnation":&session.incarnation},
            doc!{"$set":{"active":false},"$unset":{"ciphertext":"","lease":"","leaseUntil":""}}).await?;
        self.collection(SESSIONS)
            .delete_many(doc! {"grantId":&session.grant_id,"incarnation":&session.incarnation})
            .await?;
        Ok(())
    }
}
