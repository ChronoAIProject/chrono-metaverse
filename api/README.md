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
| `PUBLIC_BASE_URL` | 否 | 默认 `http://localhost:8080`；也用来拼草稿预览链接（`<地址>/preview#t=<令牌>`） |
| `METAVERSE_REQUIRE_PERMISSIONS` | 否 | `true` 时启用功能级权限（`metaverse:*` 权限字符串），默认 `false` |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | 否 | 公开接口每个来源地址每分钟的请求数，默认 1200 |
| `PUBLIC_RATE_LIMIT_BURST` | 否 | 公开接口的突发额度，默认 200 |
| `PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE` | 否 | 区块和资源（`/api/public/chunks/`、`/assets/` 及预览的）单独一档，默认 12000 |
| `PUBLIC_BLOB_RATE_LIMIT_BURST` | 否 | 区块和资源的突发额度，默认 2000 |
| `PUBLIC_SPACE_CONCURRENCY` | 否 | 每个空间同时处理的公开请求数，默认 64，满了返回 503 `space_busy` |
| `PUBLIC_CACHE_BYTES` | 否 | 进程内缓存（快照、区块、资源）总字节数，默认 268435456；单项超过八分之一不缓存；0 表示不缓存 |
| `TRUSTED_CLIENT_IP_HEADER` | 否 | 可信的客户端地址请求头（例如 `cf-connecting-ip`）。默认不设：不信任任何请求头，按 TCP 连接地址限流 |

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
| `src/repo/commits.rs` | 提交写入事务（见下文"提交与时间线"）、内容寻址对象的幂等写入、按关键帧叠加求状态清单、时间线读取 |
| `src/repo/drafts.rs` | 草稿、草稿区块、预览令牌、`ops_from_upload` 任务记录 |
| `src/repo/blobs.rs` | 已发布区块、GridFS 资源（登记检查、分段流式读取、按内容哈希写入） |
| `src/repo/space_admin.rs` | 名称和可见性、分享令牌轮换、删除空间 |
| `src/timeline/*` | 时间线领域逻辑：工作状态（区块按需加载）、草稿追加与发布（冲突、叠加、重放、方块正式编号）、关键帧、第一次提交、快照与公开投影、区域内容文字、通用方块表 |
| `src/public/*` | 公开接口基础设施：限流与每空间并发中间件、进程内缓存、分享/预览令牌解析和缓存头（见下文"公开接口的公共设施"） |
| `src/routes/*` | 接口实现与视图 |
| `tests/api.rs` | 集成测试：本地 MongoDB + 模拟 NyxID（公钥列表、组织授权接口） |
| `tests/timeline.rs`、`tests/timeline_support/` | 时间线、草稿、公开读、管理接口的集成测试（同样的设施，另加直接写库模拟上传和处理服务） |

### 目前实现的接口

`/api/v1/*`（经 NyxID，写进注册给 NyxID 的 OpenAPI）：

| 接口 | operationId | 说明 |
|---|---|---|
| `GET /api/v1/spaces/{space_id}` | `get_space` | 主人和组织成员可读（含内部级锚点），其他人 404；ETag 是最新 seq |
| `GET /api/v1/spaces/{space_id}/timeline?from=&to=&after=&limit=` | `list_timeline` | 提交列表（含发布者、追溯信息，不含操作内容），每页 ≤ 500，`nextAfter` 翻页 |
| `GET /api/v1/spaces/{space_id}/snapshot?seq=` | `get_snapshot` | 某版本（默认最新）的完整状态，含内部级锚点和原始扫描哈希；给 AI 和命令行 `pull` |
| `GET /api/v1/spaces/{space_id}/chunks/{hash}` | `get_chunk` | 区块的 zlib 字节（含未打发布标记的）；哈希必须出现在本空间的提交里 |
| `GET /api/v1/spaces/{space_id}/regions/{region_id}/content?seq=` | `get_region_content` | 区域内容的分层文字（范围、地块、重建层/扩展层物件和方块用量、锚点、方块表） |
| `POST /api/v1/spaces/{space_id}/drafts` | `create_draft` | 实体区草稿；可选 `{baseSeq}` |
| `POST /api/v1/spaces/{space_id}/plots/{plot_id}/drafts` | `create_plot_draft` | 地块草稿 |
| `GET .../drafts/{draft_id}`（两组路径） | `get_draft` / `get_plot_draft` | 草稿状态 |
| `POST .../drafts/{draft_id}/ops` | `append_draft_ops` / `append_plot_draft_ops` | 批量操作 `{ops, rev?}`，每次 ≤ 200 条、≤ 1MB，超出 413 |
| `POST .../drafts/{draft_id}/ops-from-upload` | `draft_ops_from_upload` / `plot_draft_ops_from_upload` | `{uploadId}` 或 `{assetHash}`，202 + 任务编号，接口服务进程内处理 |
| `POST .../drafts/{draft_id}/preview` | `create_draft_preview` / `create_plot_draft_preview` | `{ttlSeconds?}`，返回预览令牌（只返回一次）和链接 |
| `POST .../drafts/{draft_id}/publish` | `publish_draft` / `publish_plot_draft` | `{message?, replay?, rev?, observedAt?, scriptRef?}`；冲突 409 `draft_conflict` 带 `conflicts` |
| `DELETE .../drafts/{draft_id}` | `discard_draft` / `discard_plot_draft` | 丢弃草稿，预览令牌立即失效 |

`/api/v1/admin/*`（经 NyxID，**不**写进注册给 NyxID 的 OpenAPI，服务端照样要求"管理"级别）：

| 接口 | operationId | 说明 |
|---|---|---|
| `POST /api/v1/admin/spaces` | `admin_create_space` | 个人空间由本人建；组织空间要求调用者是组织本身，或经 NyxID 现场核验是 admin，写入归属证据；返回一次性的分享令牌原文；随即写第一次提交（`_space` 锚点 + 通用方块表） |
| `PATCH /api/v1/admin/spaces/{space_id}` | `admin_update_space` | `{name?, description?, visibility?, confirmPublicHistory?}`；凭链接查看 → 公开必须 `confirmPublicHistory: true`，否则 409 `confirmation_required` |
| `POST /api/v1/admin/spaces/{space_id}/share-tokens` | `admin_rotate_share_token` | 吊销全部现有分享令牌，新令牌原文只返回一次 |
| `PUT /api/v1/admin/spaces/{space_id}/layout` | `admin_set_layout` | `{regions, plots, message?, baseSeq?}`，写成一次提交（`regionsHash`） |
| `DELETE /api/v1/admin/spaces/{space_id}?confirm=<空间编号>` | `admin_delete_space` | 删除空间及其子集合（区块是全局内容寻址的，不删） |

`/api/public/*`（不经过 NyxID；JSON 形状按 `web/src/core/api/types.ts`）：

| 接口 | operationId | 缓存 |
|---|---|---|
| `GET /api/public/spaces/{space_id}` | `get_public_space` | 名称、区域、地块（`label`）、公开锚点；`max-age=5` |
| `GET /api/public/spaces/{space_id}/snapshot?seq=` | `get_public_snapshot` | `Snapshot`；`max-age=600`，进程内按 (空间, seq, 最新 seq) 缓存 |
| `GET /api/public/spaces/{space_id}/snapshot?at=` | 同上 | 换算成 seq 后 302 到 `?seq=`，`no-store` |
| `GET /api/public/spaces/{space_id}/timeline?from=&to=&after=&limit=` | `get_public_timeline` | `Page<CommitSummary>`，每页 ≤ 500；`max-age=5` |
| `GET /api/public/chunks/{hash}.bin` | `get_public_chunk` | 只返回有 `publishedAt` 的；`public, max-age=31536000, immutable` |
| `GET /api/public/assets/{hash}.bin` | `get_public_asset` | 只返回登记在 `assetRefs` 的；`Range`；类型白名单 + `nosniff`；immutable |
| `GET /api/public/previews` | `get_preview` | `Authorization: Preview <令牌>`；`Snapshot`（seq = 草稿基础版本）；`no-store` |
| `GET /api/public/previews/chunks/{hash}` | `get_preview_chunk` | 草稿区块或基础版本的已发布区块；`no-store` |
| `GET /api/public/previews/assets/{hash}` | `get_preview_asset` | 草稿引用的资源或本空间已登记的资源；`Range`；`no-store` |

其他：`GET /api/healthz`（`healthz`，索引建好前 503）、`GET /api/openapi.json`（`get_openapi`，注册给 NyxID 的文档）。

凭链接查看的空间：没带令牌或令牌无效一律 404；成功响应凭令牌访问时是 `private`，只有公开空间才是 `public`；拒绝响应一律 `no-store`。

### 提交与时间线（与处理服务 `jobs/writeback.py` 一致）

**事务外**（按内容哈希幂等写入，重复键忽略）：

| 集合 | 文档 |
|---|---|
| `chunks` | `{_id: 区块哈希, data: zlib 压缩的规范字节, format: 1, createdAt}`，事务后加 `publishedAt` |
| `records` | `{_id: 内容哈希, kind: entity\|anchor, spaceId, owner, body}`，哈希 = `{body, kind, spaceId}` 的规范化 sha256 |
| `palettes` | `{_id: content_hash({blocks, spaceId}), spaceId, owner, blocks: [{id, name, kind, color?, texture?, tags}]}` |
| `stateBlobs` | `{_id: content_hash({body, kind, spaceId}), kind: manifest\|regions, spaceId, owner, body}`；`manifest` 的 body 是 `{chunks: [{layer,cx,cy,cz,hash}], entities: [{id,hash}], anchors: [{id,hash}], regionsHash?, paletteHash?, scan?}`，`regions` 的 body 是 `{regions, plots}` |

**事务内**（`Repo::write_commit`，写冲突自动重试）：读空间（带主人）→ 要求 `head.seq == 基于的版本` → 插入提交（`seq = head.seq + 1`，`at = max(当前时间, head.at)`）→ 按 `head.seq == 旧值` 推进 `spaces.head = {seq, at, commitId}`、`updatedAt`（改区域时同时写 `regions`、`plots`）→ 更新 `entities` / `anchors` 当前状态 `{spaceId, id, owner, hash, body, seq}`（null 删除）→ `assetRefs` upsert `{hash, spaceId}` + `$setOnInsert {owner, createdAt, commitId}`。**事务后**给新引用的区块打 `publishedAt`。

**提交文档**（`commits`）：`_id`（32 位十六进制）、`spaceId`、`owner`、`seq`、`at`、`observedAt?`、`actor {sub, nyxServiceId, scope: physical|plot:<编号>, kind: admin|physical|plot|job}`、`author? {sub}`（草稿创建者与发布者不同时）、`message`、`ops?`（≤ 1MB 内联）或 `opsRef?`（ops 资源哈希）、`changedChunks [{layer, cx, cy, cz, hash|null}]`、`changedEntities [{id, hash|null}]`、`changedAnchors [{id, hash|null}]`、`regionsHash?`、`paletteHash?`、`scan?`（只有处理服务写）、`keyframe?`、`jobId?`（只有处理服务写）、`draftId?`、`scriptRef?`。

**关键帧**：`seq` 是 50 的倍数，或离上一个关键帧已满 50 次提交时（处理服务写的提交不带关键帧），写一份完整状态清单（`stateBlobs.kind = manifest`），哈希写在提交的 `keyframe`。读任意版本：取 `seq ≤ 目标` 的最近关键帧（没有就从头），叠加之后各提交的变化。

**第一次提交**：建空间时（失败时在第一次建草稿或改区域时补写）写 seq 1：`_space` 锚点（`kind: space`、公开）、通用方块表（`stone` 是 2，共 20 种，见 `timeline/palette.rs`）、当前的区域清单。

### 草稿

```
drafts { _id: "d_<32 位十六进制>", spaceId, owner, scope, baseSeq, rev, createdBy {sub}, status: open|published,
         ops, opsRefs [{assetHash, after, count}], touched {chunks, entities, anchors, regions, plots, palette},
         resultChunks [{layer,cx,cy,cz,hash}], resultEntities [{id,hash|null}], resultAnchors [{id,hash|null}],
         provisionalBlocks [{name, id, block}], assets, commitId?, createdAt, updatedAt, expiresAt(30 天) }
draftChunks { _id: "<草稿编号>:<哈希>", draftId, spaceId, owner, hash, data, expiresAt }
previews    { _id: sha256(令牌), spaceId, owner, draftId, rev, createdBy, createdAt, expiresAt }
```

- 草稿属于创建时的路径范围，经别的路径访问一律 404；地块路径下每个操作都必须落在地块内、实体区路径只能改实体区，越界 403 `out_of_scope`（整批不生效）；
- 追加操作时只加载用得到的区块，一个草稿最多涉及 1024 个区块（413 `too_many_chunks`）；内联操作累计 ≤ 4MB，草稿总操作 ≤ 10 万条；物件模型和贴图（含形状材质、新增方块的贴图）必须是本空间的资源——`assets.files.metadata.spaceId` 是本空间或本空间已在 `assetRefs` 里引用过——且 `metadata.kind` 不是 `scan`、`ops`、`script`，否则 422 `unknown_asset`（发布后这些资源登记到 `assetRefs`，公开可读）；
- 发布：(baseSeq, head] 的变化与草稿碰过的键求交集——没有交集就叠加到最新版本（按最新区域和地块重新校验全部操作，越界 409 `out_of_scope`；新增方块按最新方块表分配正式编号，编号变了就改写草稿区块）；有交集 409 `draft_conflict`，`conflicts` 形如 `chunk:ext:0,0,0`、`entity:<编号>`、`anchor:<编号>`、`palette:<方块名>`；`replay: true` 时在最新版本上重放全部操作；
- 预览令牌 256 位随机数，只存哈希，绑定 {空间, 草稿, rev}，默认 24 小时、最长 7 天（不超过草稿过期时间）；追加操作（rev 变）、发布、丢弃后失效；预览只显示草稿状态里的公开锚点；
- **`ops_from_upload` 任务**（接口服务进程内处理，处理服务不领取）：`jobs { _id, spaceId, owner, kind: "ops_from_upload", params {draftId, assetHash, uploadId}, status: running→done|failed, leaseOwner: "api", leaseUntil(30 分钟), attempt: 1, maxAttempts: 1, actor {sub, nyxServiceId}, progress {opsApplied, opsTotal}, result {draftId, rev, opsApplied, opsTotal, touched {chunks, entities, anchors}}, lastError?, createdAt, startedAt, finishedAt }`。读的上传必须是本空间的 `uploads {purpose: "ops", status: "done", assetHash}`。后台处理用显式系统范围（`Authorizer::system_space`，写审计日志）。

### 公开接口的公共设施（`src/public/`，其他公开接口也用）

- `public::guard` 中间件已经套在整个 `/api/public` 路由上：按来源地址限流（区块和资源单独一档），`/api/public/spaces/{id}/...` 每空间并发上限；拒绝一律 `no-store`（429 带 `Retry-After`）。
- `public::headers::{share_token, preview_token, cache_control, IMMUTABLE, NO_STORE}`：令牌解析与缓存头（`cache_control(&grant, 秒)` 按授权依据给 `public` / `private` / `no-store`）。
- `state.public.cache`（`ByteCache`）：按 `CacheKey`（`Snapshot`、`Chunk`、`Asset`、`Other {purpose, space_id, key}`）存编码好的响应体；**先拿到授权凭据再查缓存**；`invalidate_space` 清掉某空间的全部缓存。

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

- 其余接口（另一分工）：分片上传、任务查询、事件、组合、`/head`、事件密度、状态、登记事件类型、抹除事件。
- 迁移锁（`migrations` 集合）。
- 草稿、草稿区块、预览、上传会话的过期清理：这些集合的 `expiresAt` 是 RFC 3339 字符串，按设计由处理服务的循环清理，不用 TTL 索引；只有 `replay` 用 BSON 日期和 TTL 索引。
- 没有区分"放物件"引用的是原始模型上传还是处理服务重新导出的模型（只按上面的规则校验）；等处理服务的 `model_import` 定下输出资源的 `metadata.kind` 后补上。
