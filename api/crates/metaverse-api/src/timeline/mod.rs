//! 时间线的领域逻辑（设计第 5 节）：工作状态、草稿、提交组装、快照与公开投影。
//!
//! 这里不直接访问数据库，存取一律经 [`crate::repo`] 并带授权凭据。
//!
//! | 模块 | 内容 |
//! |---|---|
//! | [`palette`] | 通用方块表、发布时分配正式编号 |
//! | [`state`] | 工作状态（区块按需加载）、作用操作、影子重放校验范围 |
//! | [`writer`] | 关键帧、写提交、第一次提交（`_space` 锚点 + 通用方块表）、资源引用 |
//! | [`drafts`] | 草稿：追加操作、预览状态、发布（冲突检测、叠加或重放） |
//! | [`bundle_apply`] | 重建包的展开：校验清单和文件、展开成操作、作用到重建草稿 |
//! | [`snapshot`] | 快照组装、提交列表的公开投影 |
//! | [`region_text`] | 区域内容的分层文字 |
//! | [`views`] | 接口视图 |

pub mod bundle_apply;
pub mod drafts;
pub mod palette;
pub mod region_text;
pub mod snapshot;
pub mod state;
pub mod views;
pub mod writer;
