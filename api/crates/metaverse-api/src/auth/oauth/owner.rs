use crate::{error::ApiError, AppState};
use axum::http::{HeaderMap, StatusCode};

pub(super) struct Owner {
    pub(super) id: String,
    pub(super) org: bool,
}
fn requested_owner(headers: &HeaderMap, subject: &str) -> Result<Owner, ApiError> {
    let values = headers
        .get_all("x-metaverse-cma-owner")
        .iter()
        .collect::<Vec<_>>();
    let id = match values.as_slice() {
        [] => subject,
        [value] => value
            .to_str()
            .ok()
            .filter(|id| metaverse_core::ids::is_subject_id(id))
            .ok_or_else(|| ApiError::invalid("CMA 归属编号不正确"))?,
        _ => return Err(ApiError::invalid("CMA 归属编号重复")),
    };
    let org = id != subject;
    Ok(Owner { id: id.into(), org })
}
pub(super) async fn resolve(
    state: &AppState,
    headers: &HeaderMap,
    subject: &str,
) -> Result<Owner, ApiError> {
    let owner = requested_owner(headers, subject)?;
    if owner.org {
        use crate::auth::organizations::MembershipLookup;
        match state
            .authorizer
            .connection_membership(subject, &owner.id)
            .await
        {
            MembershipLookup::Member(member)
                if member.role != metaverse_core::model::OrgRole::Viewer => {}
            MembershipLookup::Unavailable => return Err(ApiError::org_membership_unavailable()),
            _ => {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "cma_owner_forbidden",
                    "当前账号没有在此组织使用空间聊天的权限",
                ))
            }
        }
    }
    Ok(owner)
}
