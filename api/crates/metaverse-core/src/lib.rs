//! chrono-metaverse 的纯计算核心。
//!
//! 这里只有数据类型和确定性的计算：没有异步、没有网络、没有数据库。接口服务、
//! 测试向量生成都用这一份实现；TypeScript（网站、命令行）和 Python（本地工具）
//! 各自实现用得到的规则，靠 `tests/vectors/` 下的测试向量核对。
//!
//! 模块对应的设计章节：
//!
//! | 模块 | 内容 | 依据 |
//! |---|---|---|
//! | [`grid`] | 网格单位、米与格互换、轴对齐盒子运算 | 设计 2、4.1；SHAPES 1 |
//! | [`shape`] | 形状词表、校验、包围盒 | SHAPES 2 |
//! | [`record`] | 物件、锚点记录，编号分区 | 设计 4.4；SHAPES 3 |
//! | [`chunk`] | 区块编码、哈希、压缩 | 设计 4.2；SHAPES 4 |
//! | [`canonical`] | 规范化 JSON 与内容哈希 | SHAPES 5 |
//! | [`model`] | 空间、提交、事件、草稿、组合、任务等数据模型 | 设计 4、5、6.4 |
//! | [`ops`] | 高层操作、作用到工作状态、影响范围 | 设计 8.3；SHAPES 3 |
//! | [`replay`] | 按时刻求 seq、关键帧、叠加变化 | 设计 5.2 |
//! | [`events`] | 事件更正、可见性、状态事件、瞬时事件 | 设计 5.3–5.5 |
//! | [`scope`] | 请求内容必须落在路径范围内、上传用途表 | 设计 9.4 |
//! | [`limits`] | 各用途的上传上限（默认值、`uploadLimits` 的形状） | SHAPES 8 |
//! | [`check`] | 资源核对记录 `metadata.check`、按角色判断能不能引用 | SHAPES 8 |
//! | [`bundle`] | 重建包清单：逐条解析、校验、展开成操作 | SHAPES 7 |

pub mod bundle;
pub mod canonical;
pub mod check;
pub mod chunk;
pub mod events;
pub mod grid;
mod hex;
pub mod ids;
pub mod limits;
pub mod model;
pub mod ops;
pub mod record;
pub mod replay;
pub mod scope;
pub mod shape;
pub mod timestamp;

pub use hex::{is_sha256_hex, sha256_hex, to_hex};
pub use timestamp::Timestamp;
