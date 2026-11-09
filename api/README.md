# api：Rust 后端工作区

chrono-metaverse 的后端，结构和技术栈与 CMA 的 `api/` 保持一致：一个 Cargo 工作区，axum 0.8 + tokio + mongodb 3 + utoipa（`meteroid-utoipa`），依赖版本取自 CMA 的 `api/Cargo.toml`。

```
api/
  Cargo.toml              工作区与依赖版本（与 CMA 相同的版本线）
  rust-toolchain.toml     固定 1.97.0
  deny.toml               依赖审查（照搬 CMA，只保留用得到的例外）
  crates/
    metaverse-core/       纯计算核心：无异步、无 IO
    metaverse-api/        接口服务
```

## 常用命令

与 CMA 的 CI 相同：

```bash
cd api
cargo fmt --all --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked
cargo deny --locked --all-features check advisories licenses bans sources
```

- 接口服务的集成测试需要 MongoDB 副本集，默认连 `mongodb://127.0.0.1:27018/?replicaSet=rs0`，可用 `METAVERSE_TEST_MONGODB_URI` 改；每个测试用独立的数据库（`metaverse_test_<随机>`），结束时删除。没有数据库时可设 `METAVERSE_SKIP_MONGO_TESTS=1` 跳过。
- 测试用的 RSA 密钥由 `openssl genrsa` 临时生成（与 CMA 相同），仓库里没有任何私钥。
- 重新生成跨语言测试向量：`METAVERSE_WRITE_VECTORS=1 cargo test -p metaverse-core --test vectors`。

本地运行接口服务（鉴权配置缺一项就启动失败）：

```bash
MONGODB_URI='mongodb://127.0.0.1:27018/?replicaSet=rs0' \
NYXID_BASE_URL=https://nyxid.example \
NYXID_JWKS_URL=https://nyxid.example/.well-known/jwks.json \
NYXID_JWT_ISSUER=https://nyxid.example \
NYXID_JWT_AUDIENCE=urn:chrono-metaverse:api \
ALLOWED_NYX_SERVICE_IDS=<NyxID 服务编号> \
cargo run -p metaverse-api
```

（`nyxid.example` 只是占位，换成实际的 NyxID 地址；签发方和公钥列表地址以 NyxID 的 `/.well-known/openid-configuration` 为准。）

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `MONGODB_URI` | 是 | MongoDB 连接串（chrono-cd 的 MongoDB 插件注入） |
| `MONGODB_DATABASE` | 否 | 默认 `chrono_metaverse` |
| `NYXID_BASE_URL` | 是 | 查组织角色用 |
| `NYXID_JWKS_URL` | 是 | 公钥列表 |
| `NYXID_JWT_ISSUER` | 是 | 身份令牌签发方 |
| `NYXID_JWT_AUDIENCE` | 是 | 身份令牌受众（注册服务时设置的 `identity_jwt_audience`） |
| `ALLOWED_NYX_SERVICE_IDS` | 是 | 允许的 NyxID 服务编号，逗号分隔（过渡期可同时填自定义服务和目录服务的编号） |
| `BIND` | 否 | 默认 `0.0.0.0:8080` |
| `PUBLIC_BASE_URL` | 否 | 默认 `http://localhost:8080` |
| `METAVERSE_REQUIRE_PERMISSIONS` | 否 | `true` 时启用功能级权限（`metaverse:*` 权限字符串），默认 `false` |

NyxID 地址只接受 https；明文 http 只允许本机地址（本地测试）。

## metaverse-core（无异步、无 IO）

| 模块 | 内容 | 依据 |
|---|---|---|
| `grid` | `GRID_UNIT = 0.05`、米与格互换（接近整数时吸附）、格子盒子 `[x0,y0,z0,x1,y1,z1]`（半开区间）的包含、相交、相减、并集覆盖判断；米坐标包围盒 `Aabb` | 设计 2、4.1；SHAPES 1 |
| `shape` | 形状词表（`box`、`cylinder`、`cone`、`extrude`、`lathe`、`sweep`、`loft`、`group`、`instance`），按 `type` 区分，拒绝拼错的字段；结构校验（带 JSON 路径的错误）；包围盒（规则写在模块文档里，三种语言必须一致） | SHAPES 2 |
| `record` | 物件、锚点记录的 body；声明的 `bounds` 必须包住形状的实际范围；记录内容哈希 = `{body, kind, spaceId}` 的规范化 sha256 | 设计 4.4；SHAPES 3 |
| `chunk` | 32³ 区块、规范字节（小端 u16，`x + 32·(z + 32·y)`）、`sha256(0x01 ‖ 字节)`、zlib 压缩与有上限的解压 | 设计 4.2；SHAPES 4 |
| `canonical` | 规范化 JSON（码点排序、ECMAScript 数字格式、最小转义、拒绝不安全整数）与内容哈希 | SHAPES 5 |
| `model` | 空间（主人类型、归属证据、可见性、分享令牌哈希、区域、地块）、提交、事件、事件类型、草稿、组合宇宙与修订、任务。都是存储文档，容忍未知字段（滚动更新时新旧副本共存） | 设计 4、5、6.4 |
| `ops` | 高层操作（填充、空心盒、替换、复制区域、新增方块、放物件、新建/移动/修改锚点）；作用到工作状态；每个操作的影响范围（改模板等于改所有用到它的物件）；区块变化（全 0 记为删除） | 设计 8.3 |
| `replay` | 按时刻求 seq（二分）、按 seq 找关键帧、叠加变化（含 `null` 删除），检查提交不重不漏 | 设计 5.2 |
| `events` | 更正（替换与撤回、指向最初那条、`recordedAt` 最新者胜）、先更正后按可见级别过滤、公开字段投影、状态事件（`state.key`、`clears`、`maxAgeSec`）、瞬时事件时间窗、拒收未来事件、`correlationId` 前缀规则 | 设计 5.3–5.5、12 |
| `scope` | 路径范围 `physical` / `plot:<编号>` / `source:<名称>`；操作必须落在地块或实体区内；事件请求体不能填 `source`；地块路径不能上传扫描；草稿只能走创建时的范围 | 设计 9.4 |
| `timestamp` | RFC 3339 时间戳，统一写成 `YYYY-MM-DDTHH:MM:SS.mmmZ`，字典序即时间序 | — |

`tests/vectors/` 是跨语言测试向量（区块、规范化 JSON、形状包围盒），由 Rust 实现生成，格式见其中的 README。

## metaverse-api（接口服务）

| 文件 | 内容 |
|---|---|
| `src/main.rs` | 入口：读配置、日志、先监听再后台建索引、优雅退出 |
| `src/lib.rs` | `AppState`（数据库、身份层、授权层、就绪标记）、`app()` 路由 |
| `src/config.rs` | 环境变量，鉴权配置缺失或不安全时启动失败 |
| `src/error.rs` | RFC 9457 problem+json 错误格式，错误响应 `Cache-Control: no-store` |
| `src/health.rs` | `GET /api/healthz`：索引建好前 503 |
| `src/openapi.rs` | utoipa 文档；`GET /api/openapi.json` 只含 `/api/v1/*` 非管理接口（注册给 NyxID），并去掉没被引用的结构；`operationId` 全部小写加下划线（有测试） |
| `src/auth/jwt.rs` | 身份令牌验签 |
| `src/auth/organizations.rs` | 组织角色查询 |
| `src/auth/permissions.rs` | `metaverse:*` 权限字符串 → 固定能力 |
| `src/auth/access.rs` | 访问级别表（设计 9.2）及测试矩阵 |
| `src/auth/authorizer.rs` | 资源级授权；签发授权凭据 `Grant`、`CreateGrant`、`AuthorizerKey`（字段私有，只有这里能构造） |
| `src/auth/mod.rs` | `Caller`、身份层（验签 + jti 防重放）、`/api/v1` 身份中间件 |
| `src/repo/mod.rs` | MongoDB 客户端、集合名（设计 13.2）、幂等建索引、jti 登记；测试检查 `repo/` 以外没有直接访问数据库 |
| `src/repo/spaces.rs` | 空间读写：每个方法都要求授权凭据，查询自动带上空间编号和主人 |
| `src/routes/*` | 接口实现与视图 |
| `tests/api.rs` | 集成测试：本地 MongoDB + 模拟 NyxID（公钥列表、组织授权接口） |

### 目前实现的接口（示范）

| 接口 | operationId | 说明 |
|---|---|---|
| `GET /api/healthz` | `healthz` | 索引建好前 503 |
| `GET /api/openapi.json` | `get_openapi` | 注册给 NyxID 的文档 |
| `GET /api/v1/spaces/{space_id}` | `get_space` | 主人和组织成员可读（含内部级锚点），其他人 404；ETag 是最新 seq |
| `POST /api/v1/admin/spaces` | `admin_create_space` | 个人空间由本人建；组织空间要求调用者是组织本身，或经 NyxID 现场核验是 admin，写入归属证据；返回一次性的分享令牌原文 |
| `GET /api/public/spaces/{space_id}` | `get_public_space` | 公开读；凭链接查看的空间要 `Authorization: Share <令牌>`，没带或无效一律 404；只返回公开投影 |

### 鉴权流程

1. **身份**（全部 `/api/v1/*`，在读请求体之前）：`X-NyxID-Identity-Token` 只能出现一次；RS256 + kid；公钥列表缓存 5 分钟，未知 kid 最多每 5 秒刷新一次；签发方、受众精确匹配；`nyx_service_id` 必须在允许列表里；签发到过期 ≤ 60 秒；带 `token_type` 的一律拒绝；验签全部通过后以 jti 为主键插入 `replay` 集合（TTL 索引按过期时间清理），重复就是重放。完全不读 `X-NyxID-User-*`。失败 401，拿不到公钥 503。
2. **功能级**（可选）：`METAVERSE_REQUIRE_PERMISSIONS=true` 时，建空间要求 `metaverse:space:create`。
3. **资源级**：读出主人（没有一致归属证据的组织空间按个人所有处理）→ 主人本人或组织本身直接是"管理"→ 否则用调用者转发来的 `Authorization: Bearer` 凭据调 NyxID `GET /api/v1/orgs/{id}/authorization`（转发的是 JWT 时先验签并要求 sub 一致；返回编号必须等于组织编号；401/403/404 判为不是成员，其他判为查不到；15 秒截止；不跨请求缓存；证据最多用 60 秒）→ admin 是"管理"，member/viewer 是"只读"。看不到 404，能看不能写 403，写操作查不到角色 503 `org_membership_unavailable`。

### 从 CMA 复用了什么

| 本仓库 | CMA 原文件 | 怎么用的 |
|---|---|---|
| `metaverse-api/src/auth/jwt.rs`、`jwt_tests.rs` | `api/crates/cma/src/auth/nyxid_proxy/jwt.rs`、`jwt_tests.rs` | 照搬改名。改动：服务编号改成允许列表；显式拒绝 `token_type`；去掉个人资料投影；新增"转发来的访问令牌验签并核对 sub"。测试密钥生成、JWKS 模拟服务器、缓存与刷新的测试照搬 |
| `metaverse-api/src/auth/organizations.rs` | `api/crates/cma/src/auth/organizations/{mod.rs,transport.rs}` | 照搬查询流程：`/orgs/{id}/authorization`、规范编号核对、三态结果、15 秒截止、1MB 响应上限、证据 60 秒、不跨请求缓存。改动：凭据来自 NyxID 转发的调用者令牌（本服务没有网页登录），JWT 形式的凭据先验签核对 sub |
| `metaverse-api/src/auth/permissions.rs` | `api/crates/cma/src/permissions.rs` | 参照：精确字符串映射成固定能力，未知字符串和通配不授予 |
| `metaverse-api/src/auth/access.rs`、`authorizer.rs` | `api/crates/layer2-core/src/resource_access/`（`identity.rs`、`context.rs`、`store.rs`、`policy.rs`、`tests.rs`） | 参照：主人类型显式记录、组织归属证据、无证据按个人处理、admin 等同主人、member/viewer 只读、访问级别测试矩阵 |
| `metaverse-core/src/model.rs` 的 `Space::ownership_is_consistent` | `layer2-core/src/resource_access/store.rs` 的 `ResourcePolicyRecord::validate` | 参照：主人与证据的一致性规则 |
| `metaverse-api/src/error.rs` | `api/crates/layer1-public/src/rest/problems.rs` | 参照：RFC 9457 `ProblemDocument`（`type`、`title`、`status`、`detail`、`code`） |
| `metaverse-api/src/config.rs` | `api/crates/cma/src/config.rs` | 参照：查找函数读取环境变量、启动时校验、缺失即失败 |
| `metaverse-api/src/main.rs`、`routes/mod.rs` | `api/crates/cma/src/main.rs` | 参照：日志初始化（不带颜色控制符、`RUST_LOG`）、`x-request-id`、TraceLayer、优雅退出 |
| `metaverse-api/src/health.rs` | `api/crates/cma/src/health.rs` | 参照：健康检查不在请求路径上做 IO，只读后台状态 |
| `metaverse-api/src/openapi.rs` | `api/crates/layer1-public/src/rest/openapi.rs` | 参照：utoipa `#[derive(OpenApi)]` + `#[utoipa::path]` |
| `Cargo.toml`、`deny.toml`、`rust-toolchain.toml` | `api/Cargo.toml`、`api/deny.toml`、`api/rust-toolchain.toml` | 依赖版本线、`meteroid-utoipa`、mongodb 特性、许可证例外照搬；工具链按本项目要求固定 1.97.0 |

### 还没做的（后续）

- 其余接口：草稿与发布、分片上传、事件、组合、管理接口的其余部分。核心库里的操作、回放、事件语义、范围检查已经就绪，接口按 `Grant` 模式接上即可。
- 写入事务（提交 + 空间指针 + 当前状态 + 资源引用）和迁移锁。
- 公开接口的限流与进程内缓存（设计 8.2）。
- 新建空间时自动创建 `_space` 锚点、预置通用方块表。
- 草稿、预览、上传会话的过期清理：这些集合的 `expiresAt` 是 RFC 3339 字符串，按设计由处理服务的循环清理，不用 TTL 索引；只有 `replay` 用 BSON 日期和 TTL 索引。
