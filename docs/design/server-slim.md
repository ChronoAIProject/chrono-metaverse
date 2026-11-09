# 服务端瘦身：重建挪到本地，服务端只做存储和把关

> 状态：定稿（第二稿）。第一稿经两位复核者（接口安全与迁移、本地工具与通用性）复核，逐条处理的记录见第 15 节。改造后的系统写在 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)（第四版）；本文讲改什么、按什么顺序改、怎么从现在的线上状态迁过去。第 13 节的每一步都可以直接交给实现者。
>
> 依据：用户的决定——"重建都在本地，服务端只是存储"；"上传有鉴权，服务端要通用，服务端代码里不能有处理前厅的代码"；"新开一项权限：有权限的人或 agent 可以直接写重建层"。

## 0. 结论

| 决定 | 内容 | 理由 |
|---|---|---|
| 服务端只做通用的事 | NyxID 鉴权；存储（分片上传、哈希核对、按文件内容的轻量格式和上限检查）；时间线（提交、回放、分享链接、"现在"模式、事件）；写入校验（记录和形状符合 [`SHAPES.md`](../SHAPES.md)、引用的资源属于本空间且核对结果合乎用途、请求内容不越出路径范围） | 服务端不再含任何"某类场景怎么重建"的知识 |
| 重建全部在本地 | 对齐、网页用模型、结构和物体、AI 物件集、外部模型下载和重新导出、外链贴图下载、烘焙、逐件偏差、建议锚点，产出一个**重建包** | 调参和换算法不用发版；不需要显卡 |
| 处理服务整个下线 | 上传核对、过期清理、中断任务的回收并进接口服务的**后台执行器**；执行器按任务种类分名额，每个空间同时只跑一个任务 | 少一个服务、少 3Gi 内存申请；状态和租约照旧存库 |
| 重建层单独一条路径 | `/api/v1/spaces/{space_id}/rebuild/` 下有上传、草稿、任务查询；**重建草稿只收一个重建包**，由服务端按固定规则展开成操作，调用方给不了零散的 `clearRebuilt` | NyxID 能按路径单独授权；AI 工具拿不到零散的破坏性操作 |
| 新权限，失败即拒绝 | 重建路径上的写操作**一律**要求令牌带 `metaverse:rebuild:write`，不受总开关 `METAVERSE_REQUIRE_PERMISSIONS` 影响，也没有关掉它的配置；NyxID 里配好这个权限之前，只有部署种子能写重建层 | 用户要"有权限的人或 agent 才能写"，而组织的任何一把 key 在服务端都是"管理"级别 |
| 一个包 = 一次提交 | 清单与托管位置无关（相对路径、用途、sha256、大小）；可选的 `base` 写明"基于哪个空间的第几版"，命令行拿它当草稿的基础版本；重建层整体是一个冲突单位；内容没变不写提交 | 长时间的重建也能查出中途的冲突；幂等、可追溯 |
| 写入规则补强（所有草稿） | 重建层新放的物件编号以 `rb.` 开头，扩展层不能用这个前缀；模板只能被同一层的物件引用；`createAnchor` 的 `ifNew` 只在编号**从没出现过**时新建；`removeEntity` 可带 `ifPresent`；资源能不能按某个用途引用，看服务端**实测的核对结果**，不看第一次登记时记的种类；glb 的包围盒按顶点数据实测；没定义实体区时，实体区和重建路径都可以写"虚拟区和地块以外"的地方 | 堵住跨层卡死、编号抢占、跨空间抢注、包围盒伪造，前厅的锚点也有人能改 |
| 预览不泄露 | 草稿里的资源分两类：可预览的（网页用模型、物件模型、贴图）和只为防清理而持有的（原始扫描、包清单、建模记录）；预览接口只给前一类 | 预览令牌不记名，本来就是给人转发看的 |
| 演示种子导入重建包 | 配置按哈希固定两份小文件：**清单**和**来源表**（哪个哈希从哪里下载）；执行器下载、核对、登记，再走与命令行相同的展开和发布；下载类失败在下次启动时自动重新排队 | 线上不跑任何重建；第 1–3 版的提交原样保留 |
| 包文件放哪里 | 清单和来源表进本仓库；大文件放本仓库的发布页 `demo-assets`，文件名就是 sha256；扫描原件继续用 Scaniverse 地址 | 不让 git 历史每版涨十几 MB（**待用户确认**，第 14 节） |
| 本地工具改名 | `worker/` → `recon/`，包 `metaverse_worker` → `metaverse_recon`，工作台子包 `recon` → `bench`；`processing` 不改名 | 名字和职责一致，改动最少 |
| 上线两次 | **R2 瘦身**（自带兼容读；NyxID 注册前线上不写新格式数据）→ **R3 前厅第 4 版**（同一镜像，只换种子配置）；如果 NyxID 注册早于 R2，先单独发一次兼容读 R1 | 每一步都能退回；线上数据一直能看、能回放 |

---

## 1. 现状与目标

### 1.1 现在服务端做的事

| 谁 | 做什么 | 代码 |
|---|---|---|
| 接口服务 | 鉴权、上传分片（第 0 片查文件头）、草稿和发布、时间线、公开读、事件、组合、管理；`ops-from-upload` 在请求里另起协程处理（每进程 1 个）；部署种子下载扫描并建 `scan_import` 任务 | `api/crates/metaverse-api` |
| 接口服务 | 发起处理任务：`POST .../scans`、`.../scans/{scan_id}/alignment`、`/rebuild`、`/voxelize`、`POST .../models` | `routes/jobs.rs` |
| 处理服务 | 领取任务：`upload_verify`、`scan_import`、`rebuild`、`voxelize`、`model_import`；AI 物件集写回；定期清理 | `worker/src/metaverse_worker/` |

### 1.2 改造后

```
本地（人或 AI 的电脑，Mac 也行，不需要显卡）；在命令行工作区里做
  metaverse pull [--share <链接>] [--scan]   → space.json、scan/、limits.json
  metaverse-recon prepare / align / webmodel / 逐件重建 / assemble / bundle → out/bundle/（manifest.json + 文件）
  metaverse bundle check / bundle push [--publish]
        │ NyxID 代理（身份令牌 + 操作范围）
        ▼
接口服务（唯一的后端服务）
  鉴权 · 分片上传 · 时间线 · 公开读 · 事件 · 组合 · 管理
  写入校验：形状词表、记录、资源归属和核对结果、路径范围、重建权限
  后台执行器（进程内，租约存库）：upload_verify（2 个名额）· ops_from_upload / bundle_import（1 个名额）
  定期清理（进程内，带租约锁）
        │
        ▼
MongoDB（普通集合 + GridFS）
```

### 1.3 离开服务端的"场景知识"

下面这些都是对着前厅调出来的，改造后只在本地工具里，服务端一行都不留：

- `processing/fit_counter.py`（前台：折面外壳、台面、踢脚线）；
- `processing/objects.py` 的分类规则和阈值，`fit_segment.py`、`fit_templates.py`、`fit_texture.py`；
- `processing/structure.py` 的结构算法常量（墙顶统一高度、玻璃的颜色和竖梃、提示里的大屏不当墙……）；
- `jobs/writeback.py` 的锚点规则（按 `props.category` 建 `table`、`counter`、`zone`……）；
- AI 物件集写回里的结构贴图回退、烘焙指令 `bake`、外部模型的 `model: {url, ...}` 写法；
- 接口服务里跟着这些走的东西：任务参数 `hints`（`MAX_HINTS_BYTES`）、`authored` / `authoredAsset`、核心库 `metaverse_core::authored`。

**留在服务端的通用词表**（与场景无关，写进 SHAPES）：

- 形状（SHAPES 2）、物件和锚点记录（SHAPES 3）；
- 锚点类型是固定枚举 `table`、`seat`、`zone`、`door`、`camera`、`counter`、`space`：它是现实接入的通用词表（事件挂在锚点上），不是前厅专用。加一种类型算协议变更，按"先能读、再去写"分两次发布；
- 外部模型署名的结构、许可白名单和模型库白名单：属于产品策略，服务端只校验格式，署名内容是写入方的声明（SHAPES 3）；
- 资源格式和各用途的上限（4.4）。

---

## 2. 接口与写入规则

### 2.1 删除

| 删除 | 原来做什么 | 改成 |
|---|---|---|
| `POST /api/v1/spaces/{space_id}/scans`（`import_scan`） | 建 `scan_import` 任务 | 本地 `prepare` + `bundle`，命令行 `bundle push` |
| `POST .../scans/{scan_id}/alignment`（`align_scan`） | 按给定变换重新导入 | 本地 `align`，变换写进包的 `scan.transform` |
| `POST .../scans/{scan_id}/rebuild`（`rebuild_scan`） | 重跑重建或写 AI 物件集 | 本地 `bundle`，命令行 `bundle push` |
| `POST .../scans/{scan_id}/voxelize`（`voxelize_scan`） | 体素化 | 不再提供（重建包第一版没有方块，2.4） |
| `POST .../models`、`POST .../plots/{plot_id}/models` | 重新导出物件模型 | 本地导出 glb，上传核对后直接引用 |
| `POST .../uploads/authored`、`.../plots/{plot_id}/uploads/authored` | 上传 AI 物件集 | 物件集只在本地 |
| 实体区路径上传 `scan` | 上传扫描 | 扫描只经重建路径上传（2.3） |
| 任务种类 `scan_import`、`align`、`rebuild`、`voxelize`、`web_model`、`model_import` | 处理服务执行 | 不再新建；已有记录只读 |
| 请求字段 `hints`、`authored`、`authoredAsset`；核心库 `metaverse_core::authored` | — | 删除 |

上表前六行的路由在 R2 里统一返回 **410** `endpoint_retired`（说明改用重建包，指向本文），不写进 OpenAPI；保留一个版本后删掉路由本身。实体区路径上传 `scan` 返回 422 `purpose_not_allowed`，说明"扫描改经 `/rebuild/uploads/scan` 上传"。

### 2.2 保留与小改

| 接口 | 变化 |
|---|---|
| 分片上传（实体区、地块两组路径） | 用途只剩 `model`、`texture`、`ops`、`script`；`model` 只收 glb；"完成"仍返回 202 和 `upload_verify` 任务编号，由接口服务自己执行；查询结果多一项 `check`（4.6） |
| 实体区、地块草稿全套 | 2.4、2.5 的新规则；`removeEntity` 可带 `ifPresent`、`createAnchor` 可带 `ifNew`；`ops-from-upload` 的 202 返回里 `status` 是 `queued`（原来是 `running`，写进接口变更说明） |
| 草稿预览 | 只返回草稿里可预览的资源（2.8） |
| 时间线、快照、区域内容、资源和区块下载（`/api/v1`） | 快照的内部投影多 `scan.alignment` |
| `GET /api/v1/spaces/{space_id}` | 多 `uploadLimits`（各用途的上限，命令行写进工作区的 `limits.json`，本地工具据此提前检查） |
| 公开读接口 | 不变 |
| 事件、更正、事件类型、组合、管理接口 | 不变 |
| `GET .../jobs`、`GET .../jobs/{job_id}`（实体区、地块） | 种类多 `bundle_import`；旧种类的记录照样能查；实体区路径照旧能看到本空间所有范围的任务 |
| `GET /api/healthz` | 只返回是否就绪，不带任何后台状态（它是公开的） |

### 2.3 重建路径

路径范围记作 `rebuild`（核心库 `PathScope::Rebuild`）。全部写进注册给 NyxID 的 OpenAPI：

| 方法与路径（前缀 `/api/v1/spaces/{space_id}/rebuild`） | `operationId` | 说明 |
|---|---|---|
| `POST /uploads/{purpose}` | `create_rebuild_upload` | 用途：`scan`、`webmodel`、`model`、`texture`、`script`、`bundle` |
| `PUT /uploads/{purpose}/{upload_id}/parts/{n}` | `upload_rebuild_part` | 与实体区相同 |
| `POST /uploads/{purpose}/{upload_id}/complete` | `complete_rebuild_upload` | 202 + `upload_verify` 任务 |
| `GET /uploads/{purpose}/{upload_id}` | `get_rebuild_upload` | 状态、`assetHash`、`check` |
| `POST /drafts` | `create_rebuild_draft` | 请求体 `{baseSeq?}`，与实体区相同 |
| `GET /drafts/{draft_id}` | `get_rebuild_draft` | |
| `POST /drafts/{draft_id}/bundle` | `apply_rebuild_bundle` | 请求体 `{uploadId}` 或 `{assetHash}`（用途 `bundle`、核对通过的清单）；202 + 展开任务（2.6） |
| `POST /drafts/{draft_id}/preview` | `create_rebuild_draft_preview` | |
| `POST /drafts/{draft_id}/publish` | `publish_rebuild_draft` | 2.7 |
| `DELETE /drafts/{draft_id}` | `discard_rebuild_draft` | |
| `GET /jobs`、`GET /jobs/{job_id}` | `list_rebuild_jobs`、`get_rebuild_job` | 只看得到 `rebuild` 范围的任务（上传核对、包展开、种子导入） |

- **重建草稿只收一个包**：没有内联的 `ops` 接口，也不收 `ops` 操作文件；交第二个包返回 409 `bundle_already_applied`。交过包以后只能预览、发布、丢弃。
- **草稿属于创建时的范围**：重建草稿只能经 `/rebuild/` 路径操作，经别的路径一律 404（现有规则）；实体区、地块草稿也不能经 `/rebuild/` 操作。
- **上传的范围**：重建路径的上传会话范围是 `rebuild`。交包时按 `uploadId` 只认本空间 `rebuild` 范围、用途 `bundle` 的上传；按 `assetHash` 时清单必须属于本空间、核对通过。
- **权限**：写操作（建上传、传片、完成上传、建草稿、交包、预览、发布、丢弃）要"管理"级别**并且**令牌带 `metaverse:rebuild:write`；读操作按访问级别（第 3 节）。

### 2.4 操作

| 操作 | 实体区 / 地块草稿（调用方给出的操作） | 重建草稿（只由重建包展开产生） |
|---|---|---|
| `fill`、`hollowBox`、`replace`、`copyRegion`、`addBlock` | 可以（只写扩展层） | 不出现 |
| `placeEntity` | 扩展层；编号不能以 `rb.` 开头 | 重建层（`layer: "rebuilt"`）；编号必须以 `rb.` 开头 |
| `removeEntity`（可带 `ifPresent`） | 只能删扩展层 | 只能删重建层（含旧编号） |
| `setScan`、`clearRebuilt`（新） | 不可以（422 `op_not_allowed`） | 可以 |
| `createAnchor`（可带 `ifNew`） | 可以 | 可以（一律带 `ifNew`） |
| `moveAnchor`、`updateAnchor`、`removeAnchor` | 可以 | 不出现 |

核心库在重建范围的工作状态里拒绝"不出现"的操作（防御），在实体区和地块范围里拒绝 `setScan`、`clearRebuilt`。

**`setScan`**：设置这次提交的扫描层。

```json
{ "op": "setScan",
  "scan": { "assetHash": "<扫描资源>", "webModelHashes": ["<默认档>", "<低细节档>"],
            "transform": [16 个数，列主序，扫描坐标 → 空间坐标],
            "alignment": { "method": "auto", "rotationDeg": -61.42, "errorCm": 0.8 } },
  "observedAt": "2026-10-20T00:00:00.000Z" }
```

- `assetHash` 按角色 `Scan` 检查，`webModelHashes` 是 1 到 2 个、不重复，按角色 `WebModel` 检查（[0] 是网站加载的那一档）；
- `transform`：规则就是现在 `routes/jobs.rs` 的 `check_transform`（16 个有限数、最后一行 `0 0 0 1`、行列式 > 1e-6 不镜像、平移绝对值 ≤ 100000 米），移到核心库 `model::check_transform`；
- `alignment`：可选，任意 JSON 对象，规范化后 ≤ 4 KiB，原样存进提交的 `scan.alignment`，只在 `/api/v1` 的快照里返回；服务端不解释它；
- `observedAt`：可选（发布时怎么取见 2.7）；
- 一个草稿最多一次 `setScan`，第二次 422。草稿的 `touched.scan` 记为 true。

**`clearRebuilt`**：`{"op": "clearRebuilt"}`。把工作状态里重建层的全部物件（结构、物体、模板）删掉；扩展层、锚点、区块都不动（重建包第一版不写方块；历史上处理服务写过的重建层区块原样保留，网站照旧可以按"画法"切换）。被删的编号记进 `touched.entities`，`touched.rebuiltLayer` 记为 true。之后的 `placeEntity` 再放进新的重建层，所以"`clearRebuilt` + 全部物件"就是"重建层整体换成这一份"；发布时按与最新版本的差异算 `changedEntities`，内容没变的物件不进提交。

**`removeEntity` 的 `ifPresent`**（所有草稿都能用）：`{"op": "removeEntity", "entityId": "…", "ifPresent": true}`。这个编号的物件不存在就什么都不做，也不记进 `touched`；不写或写 false 时与现在相同（不存在 422）。

**`createAnchor` 的 `ifNew`**（所有草稿都能用）：`{"op": "createAnchor", "anchor": {...}, "ifNew": true}`。这个编号在本空间的时间线上（草稿基础版本及更早，重放时是最新版本及更早）**出现过**——不论现在还在不在——就什么都不做，也不记进 `touched`；从没出现过才新建。不写或写 false 时与现在相同（已存在 422）。所以重建包不会让人删掉的锚点复活，同一个包重推也不会多写东西。"出现过"的集合按 `commits.distinct("changedAnchors.id", {spaceId, seq: {$lte: 基础版本}})` 取，只在这一批操作里有 `ifNew` 时才查；核心库的工作状态带一个 `anchor_history` 集合（TypeScript 那份由调用方传入）。

**不做方块**：重建包第一版没有方块化，`putChunk` 和 `clearRebuilt` 的 `chunks` 参数都不定义；清单里出现 `chunks` 按不认识的字段拒绝。以后要做，按清单版本 2 另行设计。

### 2.5 所有草稿通用的新规则

1. **编号分区**：重建层新放的物件（含模板）编号必须以 `rb.` 开头；扩展层新放的物件编号不能以 `rb.` 开头。已有的旧编号不受影响：扩展层的照常可以改；重建层的旧编号（处理服务写的）只能删（`clearRebuilt` 或 `removeEntity`），要重新放就换成 `rb.` 开头。物件和模板仍共用一个编号空间（现有规则），但两层各用一段，地块合作方抢不走重建包要用的编号。锚点不分区（锚点编号有现实含义，数据源按它写事件）；重建包里与已有锚点同编号的锚点按 `ifNew` 跳过，展开结果和命令行都会列出跳过了哪些（2.6），由人判断是不是被别人占了。
2. **模板只能被同一层引用**：物件形状里引用的模板必须是同一层的模板（`EntityBody::validate` 拿到的模板表按层过滤：`WorkingState::templates_of(layer)`）；模板的影响范围也只算同一层的使用者（`users_of_template` 按层）。扩展层要用重建层的款式，就复制一份成扩展层模板。线上前厅只有处理服务写的重建层，没有扩展层物件，所以没有跨层引用的旧数据（S1 用公开快照核对一遍，记在合并请求里）。
3. **完整性检查**：每次追加（一批内联操作、一个操作文件、一个重建包）全部作用完之后，工作状态里每个物件引用的模板都要存在；发布时在"最新版本 + 本次变化"上再查一遍：本次放进去的物件引用的模板都在，本次删掉的模板没有被合并后状态里的任何物件引用。不满足返回 409 `broken_template_ref`，列出编号（叠加发布时可能遇到，用 `replay` 在最新版本上重放可以得到准确的错误或结果）。
4. **资源按核对结果判断用途**：引用的每个哈希先要属于本空间（现有的 `Foreign` 规则），再看资源的 `metadata.check`（服务端从内容实测的核对结果）是否满足这个角色的条件（4.6）。不再看 `metadata.kind`——它是第一次登记的人写的，别的空间可以抢先用别的用途登记同一份字节。
5. **模型与记录一致**：只有模型、没有形状的物件，引用的模型的实测包围盒（`check.bounds`）三边长与物件 `bounds` 三边长之差不超过 max(2 厘米, 1%)，模型原点在底面中心（`|min.y|`、x 和 z 的中点都 ≤ 2 厘米）；否则 422 `model_bounds_mismatch`。网站按 `bounds` 的底面中心摆放只有模型的物件，这条保证摆出来和记录一致，也就保证范围检查用的 `bounds` 是真实的。
6. **没有实体区时的范围**：空间没有定义实体区（`regions` 里没有 `kind: physical`）时，实体区路径和重建路径的允许范围都是"不与任何虚拟区、地块的盒子相交"（核心库 `AllowedArea` 加一种"除去"模式）。这与网站现在的理解一致（`web/src/core/scene.ts`："没有定义任何实体区时，整个空间都算实体区"）；前厅这样没定义区域的空间，锚点就能经实体区草稿修改。定义了实体区以后与现在相同。空间级锚点 `_space` 仍只允许实体区路径。

### 2.6 重建包的展开（任务）

`POST .../rebuild/drafts/{draft_id}/bundle` 只插入任务、通知执行器，返回 202 `{jobId, status: "queued"}`。任务种类沿用 `ops_from_upload`，参数 `{draftId, source: "bundle", manifestHash}`，范围 `rebuild`。执行器（第 4 节）领取后：

1. 读草稿：必须是 `open`、范围 `rebuild`。`opsRefs` 里已有本任务的 `jobId` → 已经做过，直接标记完成；草稿已经有 `bundleRef`、但不是本任务写的（两个交包请求并发时可能出现）→ 失败（`content`，`bundle_already_applied`）。
2. 读清单（≤ 16 MiB），按 6.3 完整校验。解析方式是"外层带类型、记录逐条"：`rebuilt.templates`、`rebuilt.entities`、`anchors` 先解析成原始 JSON 片段（不展开），再一条一条解析成记录、校验、写出操作，内存里不会出现整份清单的通用 JSON 树。不合格 → 失败（`content`，说明写到具体字段）。
3. `files[]` 的每个文件：属于本空间、`metadata.check` 满足这个用途对应的角色（`scan` → `Scan`、`webmodel` → `WebModel`、`model` → `Model`、`texture` → `Texture`、`script` → 文本）、长度等于 `size`。不满足的列出前 20 个，失败（`content`，"这些文件还没上传、不属于本空间，或核对结果不合用途"）。
4. 按 6.4 展开成操作，写成规范的 NDJSON，按内容哈希登记成本空间的 `ops` 资源（已有就复用，计量按 4.7）。
5. 在草稿的工作状态上作用这些操作（范围 `rebuild`，2.4、2.5 的规则全部生效）。
6. 写回：一个多文档事务里，按 `{_id, rev, status: open}` 更新草稿（按字段 `$set`：`opsRefs` 加 `{assetHash: <展开文件>, count, after, source: <清单哈希>, jobId}`，`bundleRef`、`assets`、`heldAssets`、`touched`、结果记录、`defaultMessage`（清单的 `note`）、`defaultScriptRef`（清单的 `notes`）、`rev + 1`），同时按 `{_id, attempt, leaseOwner, status: running}` 把任务标记完成。任何一个匹配不到就中止。中止后重读草稿：已经有本任务的 `jobId` → 按完成处理；草稿已发布或已丢弃 → 失败（`content`）；其他情况 → 退回队列（`transient`）。
7. 任务结果：`{applied, entities: {placed, removed}, anchors: {created, skipped: [{id, reason: "exists" | "existed"}]}, anchorDrift: [{anchorId, entityIds}], files}`。`anchorDrift` 是"关联物件（`entity.anchorId`）的包围盒合起来与锚点的盒子不相交"的锚点——重建换了物件位置，锚点没动，命令行提示人用实体区草稿去挪。

### 2.7 发布

发布接口、`replay`、`rev`、`message`、`scriptRef` 的用法与实体区草稿相同。重建草稿不同的地方：

- **提交内容**：`actor = {sub, nyxServiceId, scope: "rebuild", kind: "rebuild"}`；`scan` 取草稿的 `setScan`（没有，或与最新版本的扫描完全相同，就不写，回放沿用上一次）——`CommitPlan` 加 `scan`，关键帧的状态清单也要带上扫描（`timeline/writer.rs` 的 `manifest_after` 现在不管扫描）；`bundleRef` 取草稿的；`message` 先取请求的，再取草稿的 `defaultMessage`；`scriptRef` 先取请求的，再取 `defaultScriptRef`。
- **`observedAt`**：先取请求的，再取 `setScan.observedAt`；都没有、而 `setScan` 的扫描资源与最近一次带扫描的提交相同，就沿用那次提交的 `observedAt`（同一扫描重新打包时，快照照样显示拍摄时间）。
- **资源引用 `assetRefs`**：只登记可预览的资源（网页用模型、物件模型、贴图）；原始扫描、包清单、建模记录、展开的操作文件都不登记，只被提交引用（所以不会被清理，也不会公开）。
- **坐标系**：提交带 `scan`、而空间还没有 `frame` 时，在提交事务里按 `{_id, frame: 不存在}` 条件写 `frame = {fixedAt: 提交的 at, referenceScan: scan.assetHash}`。
- **冲突**：重建草稿的冲突键是
  - `layer:rebuilt`：每个重建草稿都登记。(baseSeq, head] 里任何**改过重建层**的提交都与它冲突——`actor.scope = rebuild` 的提交，以及旧的 `actor.kind = job` 的提交（处理服务写的）。所以重建层整体是一个冲突单位：A 整体替换和 B 合并新增交错时，后发布的那个一定 409，不会出现"本包 + 中途别人加的物件"这种混合结果；
  - `scan`：草稿有 `setScan`，而中途有提交带了 `scan`；
  - `anchor:<编号>`：草稿新建的锚点在中途被别人建过、改过或删过。

  实体区草稿只改扩展层和锚点；它和重建草稿只在"同一个锚点编号"上才会冲突。
- **重放**：`replay: true` 时在最新版本上重新作用展开的操作（`clearRebuilt` 在最新版本上执行，`ifNew` 按最新版本的历史判断）。种子发布遇到冲突时自动重放（7.2）。
- **完整性检查**：2.5 第 3 条。
- **没有变化就不提交**（只对重建草稿）：`changedEntities`、`changedAnchors` 都是空，`scan` 不需要写——不写提交，草稿照样标记为已发布，记 `unchanged: true`，返回 200 `{unchanged: true, seq: <最新 seq>}`。同一个草稿再发布还是这个结果。
- **事务**：与现在相同（插入提交、推进 `head`、物件和锚点当前状态、`assetRefs`、资源栅栏），另加 `frame` 的条件写入；由后台任务发布时（部署种子），再加任务状态的条件更新，提交带 `jobId`（`commits.jobId` 已有部分唯一索引）。

### 2.8 草稿里的资源与预览

- **两类资源字段**：`drafts.assets` 只放可预览的资源——按角色 `WebModel`、`Model`、`Texture` 引用的哈希；新加 `drafts.heldAssets`，放只为防清理而持有的资源——包清单、原始扫描、建模记录。展开的操作文件照旧在 `opsRefs[].assetHash`。两者都先过清理的栅栏（刷新 `touchedAt`），发布时在提交事务里再确认一次（现有规则，缺了 409 `asset_gone`）。
- **预览资源接口**（`routes/previews.rs`）只认 `assets` 和"基础版本及更早已登记的 `assetRefs`"（现有规则），`heldAssets` 永远拿不到。拿预览令牌请求原始扫描、包清单、建模记录、操作文件，一律 404。
- **预览快照**：草稿有 `setScan` 时，预览快照的 `scan` 用草稿的（与公开快照一样只给网页用模型和变换）。
- **保存草稿改成按字段 `$set`**（`repo/drafts.rs` 的 `save_draft`，原来是整份 `replace_one`）：以后再给草稿加字段时，滚动更新期间的旧副本不会把新字段抹掉。

### 2.9 核心库的数据结构

| 位置 | 变化 |
|---|---|
| `scope::PathScope` | 加 `Rebuild`，存储写 `rebuild` |
| `scope::UploadPurpose`、`model::UploadFormat` | `UploadPurpose` 加 `WebModel`（路径里写 `webmodel`）、`Bundle`；`Authored` 只留着读旧记录。`check_upload_purpose`：实体区和地块 `{model, texture, ops, script}`；重建 `{scan, webmodel, model, texture, script, bundle}`。`UploadFormat` 不用加新值：网页用模型是 glb，清单是 json，都已有 |
| `scope::AllowedArea` | 加"除去"模式（2.5 第 6 条）；`for_scope(Rebuild)` |
| `model::ActorKind` | 加 `Rebuild`；`Job` 留给旧提交和后台任务 |
| `model::JobKind` | 加 `BundleImport`；旧种类留着反序列化 |
| `model::ScanRef` | 加可选 `alignment`（JSON 对象） |
| `model::Commit` | 加可选 `bundle_ref` |
| `model::Touched` | 加 `scan: bool`、`rebuilt_layer: bool` |
| `model::check_transform` | 从 `metaverse-api/src/routes/jobs.rs` 移过来 |
| `check`（新模块） | `metadata.check` 的类型（4.6）和"某个核对结果能不能当某个角色用"的判断 |
| `limits`（新模块） | 各用途的默认上限（服务端配置的默认值、`uploadLimits` 的默认值都取这里） |
| `ops::Op` | 加 `SetScan`、`ClearRebuilt`；`RemoveEntity` 加 `if_present`；`CreateAnchor` 加 `if_new` |
| `ops::WorkingState` | 带范围种类（扩展 / 重建，按 2.4 决定可用的操作和写哪一层）、`anchor_history`、按层的模板表 |
| `bundle`（新模块，只在 Rust） | 清单的类型、逐条解析、校验（6.3）、展开成操作（6.4）；接口服务和种子共用 |
| `authored` | 删除（S4） |

TypeScript 核心库（`sdk/typescript/src/core/`）实现扩展层用得到的规则（编号前缀、同层模板、`ifPresent`、`ifNew`——历史集合由调用方传入）和清单的结构校验，**不实现展开**。本地工具（Python）不实现清单校验和展开，只在生成时守住上限（6.5）。

---

## 3. 权限

### 3.1 四层

1. **NyxID 操作范围**（agent key 在转发前就被拦下）：重建的全部写接口都在 `/api/v1/spaces/{space_id}/rebuild/` 下，可以单独授给某把 key、钉死 `space_id`；实体区和地块路径的 key 动不了重建层，也上传不了扫描。前提是本服务注册成目录服务、为配置者打开 `assistant:operation-scopes`（设计 9.3，都还没做）。
2. **服务端访问级别**（设计 9.2 的表，不变）：重建路径与实体区路径一样要求"管理"级别。
3. **重建权限**（新，始终生效）：重建路径上的写操作（建上传、传片、完成上传、建草稿、交包、预览、发布、丢弃）要求令牌的 `permissions` 里有 `metaverse:rebuild:write`（→ `Capability::WriteRebuild`），精确匹配，不认前缀通配；没有就 403 `rebuild_permission_required`。这一条**不看** `METAVERSE_REQUIRE_PERMISSIONS`，也没有关掉它的配置。重建路径上的读操作按访问级别，不要求这个权限。
4. **其他功能级权限**（可选，总开关 `METAVERSE_REQUIRE_PERMISSIONS`，不变）：打开时实体区、地块的写入要 `metaverse:content:write`；重建路径只要第 3 层的权限。

### 3.2 权限从哪里来

- NyxID 的权限挂在角色上，自定义角色只能由平台管理员建（设计 15）。请平台管理员建角色 `metaverse-rebuilder`（只含 `metaverse:rebuild:write`），分给要写重建层的人。
- **在这之前，通过接口谁都写不了重建层，只有部署种子能写**（系统范围，3.5）。这是有意的：先关着，权限配好再开。
- 第 0 阶段要实测（加进设计 16.2）：一个人的 agent key 调用时，身份令牌的 `permissions` 里是否带这个人的角色权限；组织主体能不能挂角色。组织主体挂不了角色的话，组织的 agent key 永远写不了重建层，重建由组织 admin 本人（或他的 agent key）做——组织 admin 本人写入要查组织角色，依赖设计 9.2 的"转发调用者令牌"。
- 同一个人名下的所有 key 都带这个权限；要再按 key 细分，靠第 1 层的操作范围。
- 不在本服务里维护"谁能写重建层"的名单：本服务只存"资源归哪个主体"这一个事实（设计 9.2）。

### 3.3 人的登录态与 AI 工具

有重建角色的人用 claude.ai 连接器登录 NyxID 时，AI 拿到的是人的全部权限，也能调重建路径。缓解：重建草稿只收重建包——要先分片上传清单和文件、再交包，不是一个工具调用就能做完的，也没有内联的 `clearRebuilt`；角色只给真要写重建层的人；AI 一律用自己的 agent key 并配操作范围（设计 9.3）。

### 3.4 典型配置（加进设计 9.3 的表）

| agent | key 的主人 | 操作范围 |
|---|---|---|
| 本地重建（重建工具 + 命令行） | 有 `metaverse-rebuilder` 角色的人（组织 admin） | 查看接口；`/spaces/restaurant/rebuild/` 下的上传、建草稿、交包、预览、任务查询；**发布默认不给**——人看过预览链接后自己发布（店方也可以给） |
| AI 装修（实体区） | 店方 | 不变；**不含** `/rebuild/` 路径 |
| 地块合作方 | 店方组织 | 不变；地块路径不能上传扫描、网页用模型和重建包，编号不能用 `rb.` |

### 3.5 部署种子

种子没有调用者，用授权层签发的显式系统范围（`Authorizer::seed_space`，写审计日志）：在这个范围里建上传会话、建重建草稿、展开包、发布，`actor = {sub: "system:demo-seed", nyxServiceId: "", scope: "rebuild", kind: "rebuild"}`。依据和限制与现在相同（设计 9.2"部署配置种子是运维行为"）：只碰自己建的空间。系统范围不经过第 3 层的权限检查（它不是令牌），这是唯一的例外，写在审计日志里。

---

## 4. 上传核对与后台执行器

### 4.1 流程

创建、传片、完成的接口和语义都不变（设计 6.1）：完成时全部分片到齐 → 上传改成 `complete`、建 `upload_verify` 任务、返回 202 和任务编号；调用方照旧用 `GET .../jobs/{job_id}` 或 `GET .../uploads/{purpose}/{upload_id}` 等结果。变的只是谁来执行：完成上传后，接口服务通知本进程的后台执行器立即开始（进程内通知，不等轮询）；状态全在库里，进程重启、换副本后照样接着做。

### 4.2 后台执行器

接口服务进程里一个常驻的异步循环（`api/crates/metaverse-api/src/runner/`），执行三种任务。规则从处理服务的 `jobs/lease.py`、`jobs/writeback.py` 照搬到 Rust，并按复核意见补强：

- **名额**：两类，各有进程内的信号量。**核对**（`upload_verify`）`RUNNER_VERIFY_SLOTS`，默认 2；**重任务**（`ops_from_upload`、`bundle_import`）`RUNNER_HEAVY_SLOTS`，默认 1（与现在 `MAX_CONCURRENT_OPS_JOBS = 1` 相同）。哪一类有空名额才去领那一类的任务，核对先领；两个长任务占不住核对的名额。
- **每个空间同时一个**：领取条件排除"已有运行中、租约未过期任务的空间"（照搬 `lease.py` 的 `saturated_spaces`，`RUNNER_MAX_JOBS_PER_SPACE`，默认 1）。一个空间连传 8 个大扫描也只占一个名额；每空间排队上限 `JOB_MAX_PENDING_PER_SPACE` 不变（创建时 429）。
- **领取**：一次 `findOneAndUpdate` 原子领取——种类在这一类里，并且状态是 `queued`（`notBefore` 不存在或已到），或状态是 `running`、租约已过期、`attempt < maxAttempts`；按 `createdAt` 先后；同时写 `status = running`、`leaseOwner`、`leaseUntil = 现在 + RUNNER_LEASE_SECONDS`、第一次领取时写 `startedAt`，`attempt` 加 1。
- **续约**：每 `RUNNER_HEARTBEAT_SECONDS` 秒按 `{_id, leaseOwner, attempt, status: running}` 续一次；匹配不到说明租约丢了，立刻取消这个任务。
- **写回一律带栅栏**：任务的**任何**写入——中间的草稿保存、上传状态、登记资源后的用量、提交、任务完成——都放在多文档事务里，事务里同时按 `{_id, attempt, leaseOwner, status: running}` 更新任务（中间写入只更新 `progress`）；任务匹配不到就中止事务、丢弃结果。所以丢了租约的执行器什么都写不进去，不会出现"它先写成功、后来者反而把任务标成失败"。GridFS 的数据块写入在事务外（按上传编号幂等，失败只留下由清理收走的孤儿）。
- **重试**：失败分三类，写进 `lastError = {class, message, at}`：
  - `content`（内容不合规、哈希或大小不符、参数不对、主机不在列表）：直接 `failed`；
  - `fetch`（下载的 403、404、408、429、5xx，网络错误、超时）：按退避退回队列；
  - `transient`（数据库抖动、草稿在处理期间被别人改了）：按退避退回队列。

  退避 `notBefore = 现在 + 30 秒 × 2^(attempt−1)`。`maxAttempts`：`upload_verify` 3、`ops_from_upload` 2（重任务反复失败多半是资源问题，少试）、`bundle_import` 5。用完由清理第 0 步标记 `failed`，`class` 保留最后一次的。
- **停止**：收到停止信号后不再领取；手上的任务等最多 20 秒，做不完就按栅栏退回 `queued` 并把 `attempt` 减 1；进程被直接杀掉时，租约过期后由别的进程重新领取。
- **多副本**：每个进程有自己的编号（`METAVERSE_INSTANCE_ID`，默认"主机名-进程号-随机数"）；领取是原子的，写回带栅栏，滚动更新时新旧副本并存也只有一个能写回成功。
- **空间实例**：执行器读写 `spaces` 时，除了主人，还要求空间的 `createdAt` 不晚于任务或上传的 `createdAt`（照搬处理服务的 `store.space_filter`）；对不上的任务直接失败，上传标记 `failed`，不登记、不计用量。
- **计算不卡请求**：运行时显式至少 2 个工作线程（`main.rs` 改用运行时构建器，`max(2, 可用核数)`；`cpu_limit = 1` 时默认只有 1 个）；哈希、gzip 解压、JSON 解析（glb 的 JSON 块、清单、NDJSON）、zip 目录解析、记录校验都放进阻塞线程池；`apply_ops` 除了按格子数让出，每 64 条操作至少让出一次（放物件、模板这类 0 格操作现在一路都不让出）。
- **健康检查**：`/api/healthz` 只返回是否就绪，不因执行器出错而失败，也不带任何后台状态（它是公开接口，不能暴露上传活动的时间规律）。执行器和清理的状态写结构化日志（每次领取、完成、失败、每轮清理各一条，带任务种类、空间、耗时）；执行器循环异常退出时记错误日志、5 秒后重启循环。
- **数据访问**：执行器和清理都通过 `repo/` 的方法、用显式系统范围读写，写审计日志（设计 9.4，持续集成的数据访问边界检查照旧）。

### 4.3 `upload_verify` 的步骤

1. 上传已是 `done`：直接完成；不是 `complete`：失败；空间实例对不上：上传 `failed`、任务失败。
2. 只对 zip：先按序号读文件末尾的数据块（≤ 1 MiB），解析中央目录（4.4）。
3. 从头按序号流式读出全部数据块（`files_id` = 上传编号，按 `n` 升序），核对序号连续、除最后一块外每块 256 KiB、总长度等于声明的大小；边读边算 sha256，同时把字节交给这个用途的检查器（glb：JSON 块、`POSITION` 访问器的数据、图片头；zip：在中央目录给出的偏移处核对本地头；图片：头和段；ops：流式解压、逐行检查；script：UTF-8）。内存只有一批数据块加上检查器留的少量状态。
4. 哈希不符或检查不通过：上传 `failed`、写原因（`content`）、删数据块，任务失败。
5. 登记资源：插入 GridFS `files` 文档（`_id` = 上传编号，`filename` = 内容哈希，`metadata = {sha256, contentType, kind, spaceId, uploadId, format, touchedAt, check}`）。文件名唯一键冲突说明同一内容已存在：删本次的数据块、复用已有资源（先刷新它的 `touchedAt`；它没有 `check`、版本比现在低，或者只是扫描用途的轻量检查（glb 的 `triangles`、`bounds` 为空）而本次做了完整检查时，按条件 `$set` 补写本次算出的 `check`——检查结果只取决于文件内容，谁算都一样）。
6. 同一个事务里：上传 `done` 并写 `assetHash`、`format`、`storageBytes`，空间 `storageUsedBytes` 加上大小，任务完成（带租约条件）。

任务最终失败、上传停在 `complete` 时的收尾（`settle_upload`：内容已核对通过且资源存在就补做第 6 步，否则 `failed` 并删数据块）照搬，由执行器在标记失败后立即做，清理第 1 步兜底。

### 4.4 各用途的检查

**不解码网格、不解码图片**：只读文件头、glb 的 JSON 块、`POSITION` 访问器的数据（算真实的包围盒）和图片头。唯一要解压的是 `ops` 的 gzip（有上限，在阻塞线程池里流式解压），不需要子进程。

| 用途 | 经哪条路径 | 接受的格式 | 大小上限 | 检查 |
|---|---|---|---|---|
| `scan` | 重建 | glb、drc、obj、zip | `UPLOAD_MAX_SCAN_BYTES`（1 GiB） | glb：头、JSON 块（≤ 8 MiB）的结构、没有外部引用，不限三角形；drc：`DRACO` 魔数、版本、编码类型是网格；obj：文本、首个关键字；zip：见下 |
| `webmodel`（新） | 重建 | glb | `UPLOAD_MAX_WEBMODEL_BYTES`（64 MiB） | glb 完整检查（4.5），JSON 块 ≤ 4 MiB；三角形 ≤ `UPLOAD_WEBMODEL_MAX_TRIANGLES`（50 万；现在默认档是 30 万）；贴图边长 ≤ `UPLOAD_WEBMODEL_MAX_TEXTURE_SIDE`（4096）；全部贴图像素合计 ≤ `UPLOAD_WEBMODEL_MAX_TEXTURE_PIXELS`（2 × 4096²）；坐标绝对值 ≤ 100000 米（保持扫描原坐标） |
| `model` | 全部 | glb（不再收 drc、obj、zip） | `UPLOAD_MAX_MODEL_BYTES`（50 MiB） | glb 完整检查，JSON 块 ≤ 2 MiB；三角形 ≤ `UPLOAD_MODEL_MAX_TRIANGLES`（10 万）；贴图边长 ≤ `UPLOAD_MODEL_MAX_TEXTURE_SIDE`（2048）；像素合计 ≤ `UPLOAD_MODEL_MAX_TEXTURE_PIXELS`（4 × 2048²）；坐标绝对值 ≤ 1000 米 |
| `texture` | 全部 | png、jpeg、webp | `UPLOAD_MAX_TEXTURE_BYTES`（50 MiB） | 魔数与格式一致；读图片头拿宽高（4.5 第 5 步，读不到就拒绝）；边长 ≤ `UPLOAD_MAX_TEXTURE_SIDE`（默认从 8192 改成 4096：贴图是给网站显示的，很多手机的贴图上限是 4096），像素 ≤ `UPLOAD_MAX_TEXTURE_PIXELS`（4096²） |
| `ops` | 实体区、地块 | NDJSON，可 gzip | `UPLOAD_MAX_OPS_BYTES`（64 MiB） | 流式解压，解压后 ≤ 256 MiB；每行 ≤ 64 KiB、UTF-8、去掉空白后以 `{` 开头（完整解析在追加时做） |
| `script` | 全部 | UTF-8 文本 | `UPLOAD_MAX_SCRIPT_BYTES`（4 MiB） | 流式 UTF-8 校验（跨数据块的多字节字符要接上），不含 NUL |
| `bundle`（新） | 重建 | JSON | `UPLOAD_MAX_BUNDLE_BYTES`（16 MiB） | 外层带类型解析：`format`、`version` 对得上，`files` 是数组（完整校验在交包时做） |

**zip**（扫描）：先读文件末尾的中央目录（≤ 1 MiB、≤ 64 个成员，不收 zip64），再在流式读取经过各成员的本地头时核对：文件名与中央目录一致、压缩方式只能是存储或 deflate、没有加密标志、大小与中央目录一致、各成员的数据区间都在文件内且互不重叠。成员名不能是绝对路径、不能含 `..` 段；`__MACOSX/` 下的成员和 `.DS_Store` 忽略（仍查路径安全）；其余必须正好一个网格成员（glb、drc、obj），别的只能是 jpg、png、mtl。服务端不解压成员；本地工具读扫描 zip 时自己限制成员解压后的大小和路径（8.3）。

第 0 片的文件头检查（`ingest/formats.rs`）保留，只作提前拒绝；读不到的信息（比如 JPEG 的尺寸段在第 0 片之后）留给后台核对，后台核对读不到就拒绝。

**创建上传时的复用**：本空间已拥有这个哈希、并且它的 `check` 是当前版本且满足这个用途的上限，就直接复用（返回 `done`、`reused: true`），不收数据；没有 `check` 的旧资源不算，照常要求完整上传，登记时撞名就补写 `check`（4.3 第 5 步）。

### 4.5 glb 检查细则

glb 的头和 JSON 块在文件开头，访问器的数据和图片在 BIN 块里的位置都能由 JSON 算出来，所以整个检查跟着哈希的流式读取一次做完：

1. **头**：魔数 `glTF`、版本 2、头里的总长度等于文件大小；第一个块是 JSON（长度不超过这个用途的上限），第二个块（可选）是 `BIN`，没有别的块。
2. **JSON**：用带类型的结构解析（不认识的字段跳过、不建通用 JSON 树），数组长度有上限：节点 ≤ 10000、网格 ≤ 1000、每个网格的图元 ≤ 256、访问器 ≤ 20000、缓冲区视图 ≤ 20000、材质 ≤ 256、贴图 ≤ 256、图片 ≤ 64、场景 ≤ 16。
   - `asset.version` 是 `"2.0"`；
   - `buffers` 至多 1 个，不能有 `uri`（就是 BIN 块），`byteLength` ≤ BIN 块长度；
   - `images` 只能用 `bufferView` + `mimeType`（`image/png` 或 `image/jpeg`），不能有 `uri`（外部地址和 `data:` 都不收）；
   - 缓冲区视图的范围在 BIN 块里；访问器的范围在各自的缓冲区视图里，不收稀疏访问器；
   - 图元只收三角形（`mode` 不写或为 4）；`POSITION` 必须是 `VEC3`，分量类型是浮点数，或在声明了 `KHR_mesh_quantization` 时是有符号 / 无符号的字节或短整数（可以归一化）；必须有有限的 `min`、`max`；
   - 不收骨骼（`skins`）、动画（`animations`）、变形目标（`targets`）、相机（`cameras` 必须为空）；
   - **扩展用白名单**：`extensionsUsed` 只能是 `KHR_texture_transform`、`KHR_mesh_quantization`、`KHR_materials_unlit`、`KHR_materials_emissive_strength`；`extensionsRequired` 只能是前两个；任何对象上出现白名单以外的 `extensions` 键也拒绝。灯光（`KHR_lights_punctual`）、透射之类加重渲染的材质扩展、网站没有解码器的压缩扩展都因此被拒。
3. **三角形数**：从场景（`scene`，没写就是 0）的根节点往下走，节点不能成环、不能有两个父节点；每个引用网格的节点，三角形数 =（有 `indices` 时是它的 `count`，否则是 `POSITION` 的 `count`）/ 3，必须是整数；同一个网格被几个节点引用就算几次。
4. **实测包围盒**：对场景里用到的每个 `POSITION` 访问器，按"缓冲区视图偏移 + 访问器偏移、步长（`byteStride` 或元素大小）、个数、分量类型"算出它在 BIN 块里的字节位置；流式读到这些位置时逐个元素解码（浮点数，或按规范把量化整数还原），累计每个访问器的实际最小、最大值。只保留每个访问器的两个三维点和一个跨数据块的小缓冲（小于一个步长），不缓存数据。
   - 实测值与 JSON 声明的 `min`、`max` 相差超过 max(1e-4 × |值|, 1e-6) 就拒绝（`glb_bounds_mismatch`）；
   - 世界包围盒 = 每个访问器的实测盒子的 8 个角点经所在节点的世界变换后取外包。节点带旋转时这个盒子会偏大，所以物件模型的导出工具要把节点变换烘进顶点、节点用单位变换（本地工具 `models` 就这样导出，SHAPES 3 写明）；
   - 坐标上限按世界包围盒查。
5. **图片头**：按 JSON 算出每张图片在文件里的位置，流式读到时解析：PNG 读 `IHDR`；JPEG 从 `SOI` 起按段长度逐段跳过（EXIF、ICC、XMP 段多长都行，跨数据块接着走），直到 `SOF0`–`SOF2` 拿宽高——走完这张图的范围还没找到就拒绝；魔数必须与 `mimeType` 一致。单张边长、全部像素合计按用途的上限查。贴图用途的 webp 读 `VP8`、`VP8L`、`VP8X` 头。
6. **记下**：`metadata.check`（4.6）。

### 4.6 核对记录与按角色判断

`metadata.check` 只取决于文件内容：

| 格式 | `check` |
|---|---|
| glb | `{v: 1, format: "glb", triangles, nodes, meshes, materials, images: [{w, h, mime}], maxTextureSide, texturePixels, extensions: [...], bounds: {min, max}}`（`bounds` 是实测的世界包围盒；扫描用途的 glb 不算三角形和包围盒时这两项为空） |
| png、jpeg、webp | `{v: 1, format, width, height}` |
| zip | `{v: 1, format: "zip", mesh: "<网格成员名>", members}` |
| drc、obj | `{v: 1, format}` |
| ndjson、text、json | `{v: 1, format}` |

引用时按角色判断（都要先属于本空间）：

| 角色 | 引用的地方 | `check` 要满足 |
|---|---|---|
| `Scan` | `setScan.scan.assetHash` | `format` 是 glb、drc、obj，或是有 `mesh` 的 zip |
| `WebModel` | `setScan.scan.webModelHashes[]` | `format = glb`，三角形、贴图边长、像素合计、坐标都在网页用模型的上限内 |
| `Model` | 物件的 `assetHash`、事件显示的 `entityAsset` | `format = glb`，都在物件模型的上限内；另有 2.5 第 5 条 |
| `Texture` | 形状材质的 `texture`、`normalMap`、`roughnessMap`，物件的 `textures`，方块贴图 | `format` 是 png、jpeg、webp，在贴图上限内 |

- 上限按**当前配置**判断：调低上限以后，旧资源也可能不能再被新引用（已有提交不受影响）。
- `metadata.kind` 仍由第一次登记的人写，只用于旧数据和日志，不再参与授权；资源响应的 Content-Type 按 `check.format` 定（没有 `check` 的旧资源按原来的 `contentType`）。
- 没有 `check` 的旧资源由 R2 的后台迁移补上（11.4）；补不上的旧资源不能再被新引用。

### 4.7 资源登记与存储用量

"GridFS 里的每一份资源都由一次上传产生，在核对通过时计入空间用量，在被清理时减回"——上传会话文档带 `storageBytes`，清理时成对减回。种子下载的文件也走上传这条路（用系统身份建上传会话，7.2）。接口服务自己生成的资源（发布时合并的操作文件、2.6 里由包展开的操作文件）按现在发布草稿合并操作文件的规则计入。旧数据里处理服务派生资源和 `model_import` 的计量记录保留，清理时照旧减回。

### 4.8 内存和计算预算

处理服务有子进程和内存上限做隔离，并进来以后被内存打爆的是唯一的公开接口进程，所以按最坏情况算：

| 部分 | 最坏 | 说明 |
|---|---|---|
| 进程本身、数据库驱动 | 约 80 MB | |
| 公开接口的进程内缓存 | 128 MiB | `PUBLIC_CACHE_BYTES` 在 `app.json` 里从默认 256 MiB 调成 128 MiB |
| 分片上传 | 4 × 32 MiB | `UPLOAD_MAX_CONCURRENT_PARTS` 从 8 调成 4，多出的请求排队 |
| 核对 × 2 | 约 2 × 16 MB | 一批数据块（4 MiB）+ glb 的 JSON 块（≤ 4 MiB，带类型解析）+ 访问器计划 |
| 重任务 × 1 | 约 450 MB | `ops_from_upload`：边读边解压、逐行解析，不留压缩原文和解压后的全文；解析出的操作（解压后 ≤ 256 MiB 的文本，按 1.5 倍算）+ 工作状态。`bundle_import`：清单原文 ≤ 16 MiB + 原始片段 + 当前一条记录；成员打包一次只有一个成员（≤ 128 MiB） |
| 合计 | 约 840 MB | |

`metaverse-api` 的内存改成申请 384Mi、上限 1536Mi（原来 256Mi / 1Gi；去掉处理服务省下 3Gi 申请，组织配额足够）。CPU 不变（250m / 1）。上线前在本机按"2 个最坏的核对 + 1 个最坏的重任务 + 4 片并发上传 + 缓存装满"实测峰值，写进 `api/README.md` 和设计 16.2；峰值超过 1.2 GB 就先调低上面的上限再上线。

### 4.9 配置项对照

| 处理服务（删除） | 接口服务（新的或已有的） | 默认 |
|---|---|---|
| `WORKER_LEASE_SECONDS` | `RUNNER_LEASE_SECONDS` | 180 |
| `WORKER_HEARTBEAT_SECONDS` | `RUNNER_HEARTBEAT_SECONDS` | 45 |
| `WORKER_POLL_SECONDS` | `RUNNER_POLL_SECONDS`（另有完成上传时的进程内通知） | 2 |
| `WORKER_STOP_GRACE_SECONDS` | 固定 20 秒（平台终止宽限 30 秒） | — |
| `WORKER_MAX_JOBS_PER_SPACE` | `RUNNER_MAX_JOBS_PER_SPACE` | 1 |
| — | `RUNNER_VERIFY_SLOTS`、`RUNNER_HEAVY_SLOTS` | 2、1 |
| `WORKER_ID` | `METAVERSE_INSTANCE_ID` | 主机名-进程号-随机数 |
| `WORKER_CLEANUP_INTERVAL_SECONDS` | `CLEANUP_INTERVAL_SECONDS` | 600 |
| `WORKER_UPLOAD_TTL_HOURS` | 核心库常量 `UPLOAD_TTL_SECONDS` | 24 小时 |
| `WORKER_ASSET_GRACE_DAYS` | `CLEANUP_ASSET_GRACE_DAYS` | 7 |
| `WORKER_MAX_SCAN_BYTES`、`WORKER_MAX_MODEL_BYTES` | 已有 `UPLOAD_MAX_SCAN_BYTES`、`UPLOAD_MAX_MODEL_BYTES` | 1 GiB、50 MiB |
| `WORKER_MAX_TEXTURE_SIDE`、`WORKER_MAX_TEXTURE_PIXELS` | 已有 `UPLOAD_MAX_TEXTURE_SIDE`（默认改成 4096）、新 `UPLOAD_MAX_TEXTURE_PIXELS` | 4096、4096² |
| `WORKER_MODEL_MAX_TRIANGLES`、`WORKER_MODEL_MAX_TEXTURE_SIDE` | `UPLOAD_MODEL_MAX_TRIANGLES`、`UPLOAD_MODEL_MAX_TEXTURE_SIDE`（含义从"重新导出的上限"变成"接受的上限"） | 10 万、2048 |
| — | `UPLOAD_MODEL_MAX_TEXTURE_PIXELS` | 4 × 2048² |
| — | `UPLOAD_MAX_WEBMODEL_BYTES`、`UPLOAD_WEBMODEL_MAX_TRIANGLES`、`UPLOAD_WEBMODEL_MAX_TEXTURE_SIDE`、`UPLOAD_WEBMODEL_MAX_TEXTURE_PIXELS`、`UPLOAD_MAX_BUNDLE_BYTES` | 64 MiB、50 万、4096、2 × 4096²、16 MiB |
| `WORKER_MAX_OPS_BYTES` | 已有的常量（解压后 256 MiB） | — |
| 已有 `PUBLIC_CACHE_BYTES`、`UPLOAD_MAX_CONCURRENT_PARTS` | 代码默认不变，`app.json` 显式写 128 MiB、4 | — |
| `WORKER_MAX_TRIANGLES`、`WORKER_MAX_GRID_CELLS`、`WORKER_JOB_MEMORY_MB`、`WORKER_JOB_TIMEOUT_SECONDS`、`WORKER_ALIGN_*`、线程数变量 | 服务端不再解析网格，删除；对齐误差阈值进本地工具 `align` 的参数 | — |
| `WORKER_MODEL_HOSTS` | 本地工具的 `METAVERSE_RECON_MODEL_HOSTS`（已有） | — |
| `UPLOAD_MODEL_FORMATS` | 保留，但只允许 `glb` | `glb` |

glb JSON 块的上限（扫描 8 MiB、网页用模型 4 MiB、物件模型 2 MiB）、zip 中央目录的上限是核心库常量，不开放配置。

### 4.10 `ops_from_upload` 进执行器

现在它在请求里另起协程，租约 30 分钟，进程中途退出时由处理服务回收成失败。改成：请求只插入 `queued` 的任务并通知执行器，返回 202（`status: "queued"`）；执行器按 4.2 领取（重任务名额）。在阻塞线程池里边解压边逐行解析；作用到草稿后按 2.6 第 6 步的事务写回（草稿按 `rev` 条件、任务按租约条件，一起成功或一起中止），`opsRefs` 记 `jobId`；中止后重读草稿，已经有本任务的 `jobId` 就按完成处理，草稿被别人改过就退回队列在新的草稿状态上重做。

---

## 5. 过期清理

接口服务进程里另一个常驻循环，每 `CLEANUP_INTERVAL_SECONDS` 秒一轮，步骤照搬处理服务的 `jobs/cleanup.py`：

0. **任务**：(a) 租约过期且 `attempt ≥ maxAttempts` 的标记 `failed`，`upload_verify` 接着收尾上传（4.3），`ops_from_upload` 也在这里回收；(b) **已下线种类**（`scan_import`、`align`、`rebuild`、`voxelize`、`web_model`、`model_import`）中状态是 `queued`、`running` 的，标记 `failed`，`lastError = {class: "content", message: "处理服务已下线：重建改在本地完成，见 docs/design/server-slim.md"}`。(b) 每轮都做、幂等，所以回滚期间旧接口新建的这类任务，升回来以后也会被收掉。
1. **上传会话**：停在 `complete`、校验任务已失败（或任务记录不存在且完成超过 24 小时）的，按 4.3 收尾；超过 24 小时仍 `open` 的先改成 `expired`，再删数据块和会话；`failed`、`expired` 的同样删除；用途是 `authored`、还没完成的上传标记 `failed` 后照此删除。
2. **草稿、草稿区块、预览令牌**：按 `expiresAt < 现在` 删除；每轮最多 200 个草稿。
3. **没人引用的资源**：上传或最近复用超过 `CLEANUP_ASSET_GRACE_DAYS` 天、没被引用的，先删 `files` 文档再删数据块，再按 4.7 减回用量。"被引用"= 现有的定义（`assetRefs`；提交的 `scan.assetHash`、`scan.webModelHashes`、`opsRef`、`scriptRef`；记录的 `assetHash`、`textures`；方块表的贴图；草稿的 `opsRefs[].assetHash`、`assets`；未结束任务的参数里出现的字符串）**加上**：提交的 `bundleRef`；草稿的 `heldAssets`、`bundleRef`。旧的"等人工对齐的 `scan_import` 结果"仍算引用，保留一个版本后删掉这条。
4. **补打区块的 `publishedAt`**：最近 48 小时的提交引用、还没打上的区块按提交的 `at` 补上。

**只让一个副本跑**：每轮开始前在 `migrations` 集合里抢一把带租约的锁：`updateOne({_id: "lock:cleanup", $or: [{until < 现在}, {owner: 本进程}]}, {$set: {owner, until: 现在 + 15 分钟}}, upsert)`，插入时撞唯一键就算没抢到；每做完一步续一次。各步本来就幂等，锁只是避免重复劳动。

**栅栏**：不变。删除仍带"`metadata.touchedAt` 早于截止时间"的条件；引用一个已有资源的一方（草稿追加、交包、发布、复用上传、执行器登记）先刷新 `touchedAt` 并要求匹配到。每步每轮处理的数量有上限（资源每轮最多 500 个）。

---

## 6. 重建包

### 6.1 目录

默认在命令行工作区的 `out/bundle/` 下（8.4）：

```
out/bundle/
  manifest.json            清单（6.2）
  scan/scan.zip            原始扫描
  web/scan-0.glb           网页用模型默认档（网站加载这一档；可以直接用线上已有的那份）
  web/scan-1.glb           低细节档（可选）
  models/<哈希前 12 位>.glb 物件模型（节点变换和调色烘进网格，原点在底面中心）
  textures/<哈希前 12 位>.jpg 烘焙贴图、结构贴图、下载的外链贴图
  notes.md                 建模过程记录（可选，作为提交的 scriptRef）
```

清单里列出的文件，本地可以没有（典型的是 1 GiB 的原始扫描，线上已经有）：`bundle check` 把它记成"依赖空间里已有"，`bundle push` 用创建上传的复用探测确认（6.6），不能复用就停下报错。

### 6.2 清单格式

清单与托管位置无关：不写任何下载地址，同一个包在本地、命令行推送和部署种子里是同一份字节、同一个哈希。

```json
{
  "format": "chrono-metaverse-rebuild-bundle",
  "version": 1,
  "tool": { "name": "metaverse-recon", "version": "0.2.0", "source": "git:<40 位提交哈希>" },
  "note": "前厅第 4 版：AI 物件集 52 件，结构按实测替换",
  "createdAt": "2026-11-20T08:00:00.000Z",
  "base": { "spaceId": "chronoai-lobby", "seq": 4 },
  "scan": {
    "assetHash": "<扫描 zip 的 sha256>",
    "webModelHashes": ["<scan-0.glb>"],
    "transform": [16 个数],
    "observedAt": "2026-10-20T00:00:00.000Z",
    "alignment": { "method": "given", "rotationDeg": -61.42, "tiltDeg": 0.09 }
  },
  "rebuilt": {
    "mode": "replace",
    "templates": [ { "entityId": "rb.chair-a", "layer": "rebuilt", "kind": "template", "shape": { … } } ],
    "entities":  [ { "entityId": "rb.counter-01", "layer": "rebuilt", "kind": "object", "shape": { … }, "bounds": { … }, "fit": { … }, "anchorId": "counter-01" } ],
    "remove": []
  },
  "anchors": [ { "anchorId": "counter-01", "kind": "counter", "box": [ … ], "label": "前台", "visibility": "public" } ],
  "notes": "<notes.md 的 sha256>",
  "report": { "fit": { "meanCm": 4.31, "p90Cm": 8.71, "within3cm": 0.67 }, "entities": 52 },
  "files": [
    { "path": "scan/scan.zip",      "purpose": "scan",     "sha256": "…", "size": 5901234 },
    { "path": "web/scan-0.glb",     "purpose": "webmodel", "sha256": "…", "size": 13800000 },
    { "path": "models/3f9a….glb",   "purpose": "model",    "sha256": "…", "size": 412345 },
    { "path": "textures/8be8….jpg", "purpose": "texture",  "sha256": "…", "size": 51234 },
    { "path": "notes.md",           "purpose": "script",   "sha256": "…", "size": 9876 }
  ]
}
```

### 6.3 规则

| 字段 | 规则 |
|---|---|
| `format`、`version` | 必须正好是 `chrono-metaverse-rebuild-bundle` 和 1；不认识的字段一律拒绝（以后加字段就升版本） |
| `tool` | `name`、`version` 1–64 个字符；`source` 可选，只能是 `git:` 加 40 位小写十六进制 |
| `note` | 1–2000 字，规则同提交说明（不含换行以外的控制字符） |
| `createdAt` | RFC 3339，只为追溯 |
| `base` | 可选；`spaceId` 按空间编号的格式，`seq` ≥ 1。命令行拿它当基础版本（6.6），种子不用（7.2） |
| `scan` | 可选；字段规则同 `setScan`（2.4），另有 `observedAt`、`alignment` |
| `rebuilt` | 可选；`mode` 是 `replace`（重建层整体换成这一份）或 `merge`（只放、改列出的物件，再删 `remove` 里的编号）；`remove` 只在 `merge` 时能给，不能与 `templates`、`entities` 的编号重复；物件 ≤ 2000、模板 ≤ 200，编号不重复，都必须以 `rb.` 开头（`remove` 可以是旧编号）；`layer` 必须是 `rebuilt`；形状里引用的模板只能是本包的模板或目标空间重建层已有的模板；出现 `chunks` 字段按不认识的字段拒绝 |
| `anchors` | 可选，≤ 2000，编号不重复，不能是 `_space`，锚点 body 按 `AnchorBody::validate` |
| `notes` | 可选，必须是 `files` 里用途为 `script` 的文件的哈希 |
| `report` | 可选，任意 JSON 对象，规范化后 ≤ 64 KiB，服务端不解释；字符串不能以 `/`、`~`、`file:` 开头，也不能是 `C:\` 这样的盘符路径 |
| 至少有一项 | `scan`、`rebuilt`、`anchors` 至少给一个 |
| 每条记录 | 原始 JSON ≤ 64 KiB（逐条解析的上限，与 NDJSON 每行的上限相同） |
| `files[]` | ≤ 4096 项；只有 `path`、`purpose`、`sha256`、`size` 四个字段；`path` 是相对路径：`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`，≤ 200 个字符，没有 `.`、`..` 段，不重复；`purpose` 是 `scan`、`webmodel`、`model`、`texture`、`script` 之一；`sha256` 64 位小写十六进制，同一哈希只出现一次；`size` ≥ 1 且不超过该用途的上传上限 |
| 引用 | 记录里引用的**每个**哈希（`scan.assetHash`、`webModelHashes`、物件的 `assetHash`、形状材质的 `texture`、`normalMap`、`roughnessMap`、物件的 `textures`、`notes`）都必须在 `files` 里、用途对得上。包是完整的：在任何空间里，只要这些文件都在或能上传，就能展开 |
| 没有本地路径 | 由上面的 `path`、`report` 规则和"记录里的贴图只能是哈希"保证（工作台的 `{file}`、`{url}` 写法在打包时都已换成哈希） |

### 6.4 展开成操作

```
1. 有 scan：             {"op": "setScan", "scan": {assetHash, webModelHashes, transform, alignment?}, "observedAt"?}
2. rebuilt.mode = replace：{"op": "clearRebuilt"}
3. 每个模板（按清单顺序）：{"op": "placeEntity", "entity": 模板}
4. 每个物件（按清单顺序）：{"op": "placeEntity", "entity": 物件}
5. rebuilt.mode = merge：  每个 remove 编号 {"op": "removeEntity", "entityId": 编号, "ifPresent": true}
6. 每个锚点：             {"op": "createAnchor", "anchor": 锚点, "ifNew": true}
```

只在 Rust 实现（`metaverse_core::bundle::to_ops`），接口服务的交包和部署种子共用。测试向量 `tests/vectors/bundle/` 给出清单和期望的操作序列（Rust 跑展开，TypeScript 只跑其中的结构校验）。

### 6.5 校验分工

| 在哪 | 查什么 | 实现 |
|---|---|---|
| 本地工具 `metaverse-recon bundle` | 生成时就按上限导出（减面、缩小贴图、烘节点变换、编号加 `rb.`、扫描 zip 按固定规则打包），上限取工作区的 `limits.json`，没有就用与服务端相同的默认值；最后调用 `metaverse bundle check`（`PATH` 里有就调，没有就打印要运行的命令） | Python；不实现清单校验和展开 |
| 命令行 `metaverse bundle check [目录] [--seed]` | 6.3 的结构规则；本地有的文件：大小、sha256、按用途的文件检查（glb、图片、zip，规则同 4.4、4.5，上限取 `limits.json` 或默认值）；记录按 SHAPES 校验；只有模型的物件与模型实测包围盒一致；`--seed` 时含内部锚点或建模记录给出警告（6.8） | TypeScript；跑 `tests/vectors/bundle/` 的结构部分和 `tests/vectors/check/` 的二进制样本 |
| 接口服务：上传 | 4.4、4.5 | Rust（权威） |
| 接口服务：交包 | 6.3 全部；文件属于本空间且核对结果合乎用途；展开后每条按 2.4、2.5 | Rust |
| 接口服务：发布 | 冲突、范围（按最新区域）、模板完整性、资源栅栏、没有变化不提交 | Rust |

二进制样本 `api/crates/metaverse-core/tests/vectors/check/`：一批小文件（几 KB）和 `expected.json`（每个文件应该通过还是被拒、拒绝码、通过时的 `check`），至少有：外部 `uri`、`data:` 图片、Draco 扩展、灯光扩展、不在白名单的对象级扩展、相机、节点成环、两个父节点、骨骼、三角形数不是整数、声明的 `min`/`max` 与数据不符、量化坐标、旋转节点的包围盒、坐标越界、JPEG 的 EXIF 段超过 64 KiB、JPEG 没有 SOF、PNG/JPEG 魔数与 `mimeType` 不符、zip 里的 `..`、绝对路径、加密、zip64、两个网格成员、本地头与中央目录不符、`__MACOSX/`。Rust（S2）和 TypeScript（S5）都跑这一批。

### 6.6 上传与发布（命令行）

`metaverse bundle push [目录，默认 out/bundle] [--message <说明>] [--publish] [--replay] [--no-preview] [--base latest] [--part-size <MiB>]`：

1. 跑一遍 `bundle check`，不过就停。
2. **基础版本**：清单没有 `base` 时拒绝推送，除非给了 `--base latest`（打印警告"冲突检查只覆盖从现在起的变化"）；`base.spaceId` 与工作区的空间不同就拒绝。读空间信息（最新 seq、当前扫描）：最新 seq 大于 `base.seq` 时提示"时间线已经前进到第 N 版，发布时会检查冲突"；包的 `scan.assetHash` 与当前扫描相同、`transform` 却不同时提示（重扫要先对齐）。
3. 逐个上传 `files`（同时 4 个），经 `/rebuild/uploads/{purpose}`：创建上传时本空间已拥有、核对结果合乎用途就直接复用，不传数据；本地没有这个文件又不能复用 → 停下报错；其余分片上传、完成、等核对。
4. 上传清单本身（用途 `bundle`）。
5. 建重建草稿（`baseSeq = base.seq`，`--base latest` 时取最新 seq），交包，等展开任务；打印放置和删除的物件数、新建的锚点、跳过的锚点（写明"已存在"或"曾经存在"）、锚点漂移（建议用实体区草稿挪锚点）。
6. 生成预览链接（除非 `--no-preview`）。
7. `--publish` 时直接发布（`message` 取 `--message` 或清单的 `note`）；否则把草稿记进工作区的 `out/drafts.json`（范围 `rebuild`），人看过预览后用 `metaverse publish <草稿编号>` 发布。冲突时打印冲突的键，人确认后用 `--replay` 在最新版本上重放，或重新拉取、重新打包。

### 6.7 幂等

- **文件**：按哈希复用，重复上传不重复存储。
- **包展开**：同一份清单展开得到同一个操作文件哈希。
- **发布**：同一个草稿重复发布返回同一个结果（现有规则）。同一个包在内容没变时再推一次，发布结果是 `unchanged: true`，不写新提交：整体替换是"清掉再放同样的内容"，差异为空；合并模式的删除带 `ifPresent`，第二次删不存在的编号什么都不做；锚点带 `ifNew`，已经建过（或建过又被删了）都跳过。先后发布 A、B、A 时第二次的 A 是真正的变化，照常提交——所以不按包哈希做唯一键，而按"内容有没有变化"判断。
- **锚点不复活**：实体区草稿删掉的锚点，之后任何重建包都不会再把它建出来。
- **种子**：任务编号由（空间、空间创建时间、版本）算出，同一版本只导入一次（7.2）。

### 6.8 种子用的包是公开的

种子包的清单和来源表进公开仓库，大文件放公开的发布页，**里面的一切都会公开**：全部锚点（包括内部级锚点的名称和位置）、`report`、建模记录。所以：

- `metaverse-recon bundle --seed` 生成种子用的包：去掉内部级锚点和建模记录（`notes`），`report` 只留偏差统计；
- `metaverse bundle check --seed` 发现内部级锚点或建模记录时给出警告；
- 以后给别的空间做种子时照此办理；非公开的内容用命令行直接推送，不进种子。

---

## 7. 演示种子

### 7.1 配置

`METAVERSE_DEMO_SEED`（JSON，压缩成一行放进 `app.json`）：

```json
{
  "spaceId": "chronoai-lobby",
  "name": "ChronoAI 前厅",
  "description": "ChronoAI 办公室前厅：Scaniverse 扫描 + AI 重建的演示空间（由部署配置自动导入）",
  "owner": { "kind": "org", "id": "52aa284c-b5b2-49bd-9d12-79f24772dbd7" },
  "visibility": "unlisted",
  "revision": 4,
  "bundle": {
    "manifest": { "url": "https://raw.githubusercontent.com/ChronoAIProject/chrono-metaverse/<40 位提交哈希>/infra/chrono-cd/demo/lobby-r4/manifest.json",
                  "sha256": "<清单的 sha256>", "size": 312345 },
    "sources":  { "url": "https://raw.githubusercontent.com/ChronoAIProject/chrono-metaverse/<40 位提交哈希>/infra/chrono-cd/demo/lobby-r4/sources.json",
                  "sha256": "<来源表的 sha256>", "size": 4567 }
  }
}
```

**来源表**（`sources.json`，≤ 1 MiB）说明清单里的文件从哪里下载：

```json
{
  "format": "chrono-metaverse-bundle-sources",
  "version": 1,
  "files": {
    "<网页用模型的 sha256>": { "url": "https://github.com/ChronoAIProject/chrono-metaverse/releases/download/demo-assets/<sha256>.glb" },
    "<扫描 zip 的 sha256>": { "zip": [
      { "name": "mesh.drc", "url": "https://scaniverse.com/api/media/…/mesh.drc", "sha256": "…", "size": 1003301 },
      { "name": "tex.jpg",  "url": "https://scaniverse.com/api/media/…/tex.jpg",  "sha256": "…", "size": 4897711 } ] }
  }
}
```

- 键是清单 `files[]` 里的 sha256；值要么是 `url`（https），要么是 `zip`（1–32 个成员，按**数组顺序**用 `demo_seed/pack.rs` 的规则打包：存储不压缩、时间固定）。目标空间已经有的文件可以不列。
- `bundle` 可选：不给时种子只保证空间存在（建空间、写第一次提交），不导入任何内容。
- **旧格式**（出现 `files`、`rebuild`、`voxelize`、`hints`、`authored`、`observedAt`）：记错误日志"旧格式的种子要处理服务，已不支持，改成 bundle"，跳过种子，接口服务照常启动。`check-app` 负责在部署前拦住旧格式。
- `METAVERSE_DEMO_SEED_HOSTS`：允许下载的主机，逗号分隔，写法同本地工具的主机列表（主机名精确匹配且只许 443 端口，以点开头匹配子域名，`主机:端口` 只匹配那个端口）。线上写 `raw.githubusercontent.com,github.com,release-assets.githubusercontent.com,objects.githubusercontent.com,scaniverse.com`；部署规格检查要求显式写出。只用 https（本机测试可用 `http://127.0.0.1`），不自动跟随重定向，每一跳都按同一个列表检查，最多 5 跳。
- `METAVERSE_DEMO_SHARE_TOKEN` 不变。

### 7.2 流程

**启动时**（索引建好之后在后台执行，失败按退避重试几次，不影响就绪）：

1. 空间已存在、不是种子为同一组织建的 → 什么都不做。
2. 任务编号 = `seed_job_id(空间, revision)`（公式不变：空间编号、空间创建时间、版本）。这个编号的任务已经存在时：
   - `done`、`queued`、`running` → 什么都不做（线上第 1–3 版的 `scan_import` 任务用的就是这个公式，所以换格式、版本不变时不会重做）；
   - `failed` 且 `lastError.class = fetch` → **重新排队**：`status = queued`、`attempt = 0`、去掉 `notBefore`，把上一次的错误追加进 `history`（最多留 10 条），记日志。GitHub 发布页刚上传的文件短时间 404、匿名访问被限流，修好以后重启就能接着导入，不用改版本号；
   - `failed` 的其他类别 → 什么都不做（内容或配置有问题，改好后把 `revision` 加一）。
3. 配置里没有 `bundle`：空间存在就什么都不做，不存在就只做第 5 步。
4. 下载清单和来源表，核对大小和 sha256，按 6.3、7.1 校验结构。不合格或下载失败 → 记错误日志，不建空间、不插任务（下次启动再试）。
5. 空间不存在就按现在的代码路径建（主人、归属证据 `operator_seed`、分享令牌只存哈希），并补写第一次提交。
6. 插入任务 `{kind: "bundle_import", params: {manifest: {url, sha256, size}, sources: {url, sha256, size}, revision}, actor: {sub: "system:demo-seed"}, scope: "rebuild", maxAttempts: 5}`，编号是第 2 步的编号（唯一键，多副本同时启动也只有一个）。

**执行器做 `bundle_import`**（重任务名额）：

1. 下载清单和来源表并核对（都很小，不缓存）。
2. 逐个 `files[]` 条目：本空间已拥有、核对结果合乎用途 → 刷新 `touchedAt`，跳过；否则在来源表里找：
   - `url`：流式下载进一个系统身份的上传会话（边下边算哈希，超过声明大小就停）；
   - `zip`：逐个下载成员到内存（单个 ≤ 128 MiB）、核对成员的哈希和大小，按 `pack.rs` 的布局把本地头和数据写进上传会话的数据块，然后释放；最后写中央目录。同一时刻只有一个成员在内存里，整个 zip 不在内存里；
   - 来源表里没有 → 失败（`content`，"文件 X 空间里没有，来源表也没给"）。

   然后调用与 `upload_verify` 相同的核对和登记（4.3 第 3–6 步，计入存储用量）。资源已经被别的空间按别的用途登记过不算错：角色按核对结果判断（4.6）。
3. 草稿：编号由任务编号算出，不存在就建（基础版本取最新 seq，种子不看清单的 `base`）；草稿的 `bundleRef` 已经是这份清单 → 跳过展开；否则按 2.6 展开、追加（事务里带本任务的租约条件）。
4. 发布：说明是清单的 `note` 加"（部署配置种子第 N 版）"；遇到冲突**自动在最新版本上重放**（种子没有人工确认这一步，内容由部署配置钉死）；提交带 `jobId`，同一个事务里把任务标记完成；没有变化就不写提交，草稿标记已发布，任务结果写 `unchanged: true`。
5. 结果：`{manifest, files: {total, reused, downloaded, bytes}, draftId, commitId?, unchanged?, anchors: {created, skipped}}`。
6. 失败分类按 4.2：清单、来源表、文件的哈希或大小不符，清单不合规，展开或校验不过，主机不在列表 → `content`；403、404、408、429、5xx、网络错误、超时 → `fetch`（重试用完后 `failed`，下次启动按第 2 步重新排队）；数据库 → `transient`。错误说明只写主机和文件路径，不写完整地址（重定向后的地址带签名）。

**重做是安全的**：下载和登记按哈希幂等；草稿按 `bundleRef` 判断是否已经展开；发布带 `jobId`（唯一索引）且与任务完成在同一个事务里；所有写入都带租约栅栏。

### 7.3 与线上空间的兼容（第 4 版）

线上 `chronoai-lobby` 现在有：第一次提交、第 1–3 版 `scan_import` 写的提交（最新一次的重建层是 AI 物件集）、它们的资源和锚点、`jobs` 里的任务记录。第 4 版这样追加：

- 版本 1–3 的任务还在，换格式不会重做；版本改成 4 才导入。
- **扫描**：`scan.assetHash` 就是线上已有的扫描 zip（来源表的 `zip` 指向同样的两个 Scaniverse 文件、同样的顺序，打包结果字节相同、哈希相同），已存在，不下载。本地工具用 `metaverse-recon scan-zip` 按同样的规则打包（测试向量 `api/crates/metaverse-api/tests/vectors/demo_seed_zip.json`，Rust 和 Python 都跑）。
- **变换**：从公开快照取（`metaverse pull --share <演示链接>`，NyxID 注册前 `/api/v1` 一律 401，所以不能用普通的 `pull`），写进 `scan/transform.json`，`prepare --transform` 用它，不重新自动对齐；扫描层的坐标不变。
- **网页用模型**：直接用线上第 3 版的那份（`pull --share --assets` 下载，哈希不变），"原始"视图与第 3 版完全相同。它要有 `check`：R2 的后台迁移会补上（11.4）；补不上（比如用了白名单以外的扩展）就由本地工具重新生成一份。
- **重建层**：`mode: replace`；物件和模板的编号都是 `rb.` 开头（第 1–3 版的旧编号由 `clearRebuilt` 删掉），时间线上这一版是一次整层替换。编号没有现实含义，物件按 `anchorId` 与锚点关联。
- **锚点**：`ifNew`；第 1–3 版建的锚点（前台、桌子、沙发……）全部跳过；包里新加的才建。
- **拍摄时间**：扫描没变，提交沿用第 3 版的 `observedAt`（2.7）。
- 提交追加在最新 seq 之后，`actor.kind` 是 `rebuild`。时间线上能看到第 1–4 版。

### 7.4 包文件放哪里

前厅第 4 版要托管的文件（新库，比如本地开发的 `--demo-seed`，要从这里下载；线上已有的不会下载）：

| 文件 | 大小 | 来源 |
|---|---|---|
| 清单、来源表 | 约 0.3 MB | 进本仓库 `infra/chrono-cd/demo/lobby-r4/` |
| 扫描 zip（drc 1.0 MB + 贴图 4.9 MB） | 5.9 MB | 不重新托管：来源表的 `zip` 指向 Scaniverse 原地址 |
| 网页用模型 | 约 13.8 MB | 线上第 3 版那份，托管一次，以后各版不变就不用再传 |
| 外部模型（10 个 glb） | 2.44 MB | 本地重新导出 |
| 烘焙贴图、结构贴图 | 约 0.4 MB | 本地生成 |
| 合计要托管的 | 首次约 17 MB；之后每版只传变化的几 MB | |

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 全部放进本仓库，按提交哈希的 raw 地址引用 | 一个地方 | git 数据现在 27 MB，一版就涨 17 MB，之后每版再涨，永远删不掉 |
| B. 清单和来源表进本仓库，大文件放本仓库的发布页 `demo-assets`，文件名就是 `<sha256>.<扩展名>` | 清单可评审、可追溯；大文件不进 git 历史；按哈希命名，新版本只传新文件；公开仓库的发布页可以匿名下载；内容由 sha256 钉死 | 多两个下载主机；发布页的文件能被有权限的人删掉——删了种子会明确失败（`fetch` 类，修好后重启自动重来），不会读到错的内容 |
| C. 对象存储（chrono-bucket） | 平台内 | 之前已决定不用（设计 15） |
| D. NyxID 注册后直接用命令行把包发布到线上 | 不需要托管 | 注册前做不到；新库还是要能下载 |

**推荐 B**（待用户确认，第 14 节）。做法：本地生成种子用的包（`bundle --seed`）→ 文件改名成 `<sha256>.<扩展名>`，`gh release upload demo-assets`（同名已存在就跳过）→ 写来源表 → 清单和来源表提交进 `infra/chrono-cd/demo/lobby-r4/` → 种子配置引用这个提交的 raw 地址和两个哈希。包里的一切都会公开（6.8）。

### 7.5 能不能让网站直接用 Scaniverse 原始文件

不推荐作为默认（与第一稿相同）：原始扫描默认不公开（设计 8.2、17.5）；8192² 的贴图在手机上容易崩；扫描贴图分块有接缝；要加 Draco 解码器；每个访客都去请求外部主机。以后要缩小体积，本地工具可以输出"Draco 压缩网格 + 4096² 贴图"的 glb（估计 3–5 MB），这要网站带上本站托管的 Draco 解码器、glb 检查的扩展白名单加上 `KHR_draco_mesh_compression`（三角形数仍从访问器的 `count` 读，包围盒改由解码器之外的声明值加抽样核对另行设计）。作为单独的增强，不放在这次改造里。

---

## 8. 本地工具

### 8.1 改名

| 现在 | 改成 |
|---|---|
| 目录 `worker/` | `recon/` |
| 项目名 `metaverse-worker` | `metaverse-recon` |
| 包 `metaverse_worker` | `metaverse_recon` |
| 子包 `metaverse_worker.processing` | `metaverse_recon.processing`（不改名） |
| 子包 `metaverse_worker.recon`（工作台） | `metaverse_recon.bench`（避免 `metaverse_recon.recon`） |
| 命令 `metaverse-worker`、`metaverse-recon` | 只留 `metaverse-recon` |

用**一次只做改名的提交**完成（S7），清单：

- `git mv worker recon`，`git mv` 包和工作台子包；导入路径、文档里的路径；
- `recon/pyproject.toml`：项目名、命令入口、`package-data` 的键；
- `uv lock` 重新生成 `recon/uv.lock`（持续集成的 `uv sync --frozen` 才过得去）；
- `bench/env.py` 的 `repo_root()`：`(root / "worker").is_dir()` 改成 `recon`（按目录名机械替换改不到它，改漏了渲染会找不到 `web/node_modules`）；
- `.github/workflows/ci.yml` 的 `working-directory` 和缓存路径；`.github/dependabot.yml` 加 `/recon` 的 pip（uv）一项（worker 的两项在 S6a 已删）；`infra/dev/up.sh`；`infra/dev/README.md`；`docs/` 里的路径。

不改任何逻辑。git 按内容识别改名，`git log --follow`、`git blame -M` 都能追到之前的历史。

### 8.2 留下和删掉的模块

| 删掉（只有服务端用） | 留下（变成本地流水线） |
|---|---|
| `__main__.py`（服务入口）、`runner.py`、`health.py`、`config.py`（服务的环境变量） | `processing/` 整个：`align`、`scan`、`sniff`、`webmodel`、`structure`、`objects`、`fit_*`、`object_fit`、`bake`、`modelimport`、`glb`、`preview_glb`、`shape_mesh`、`voxelize`、`authored_build`、`tasks`、`rebuild` |
| `store.py`、`assets.py`、`uploads.py`（MongoDB、GridFS） | `shapes.py`、`records.py`、`canonical.py`、`chunk.py`、`ids.py`、`timeutil.py`、`errors.py` |
| `jobs/`（租约、续约、写回、清理、子进程隔离） | `authored.py`（物件集的解析和校验，`assemble` 用） |
| `handlers/`（`upload_verify`、`scan`、`authored`、`model_import`、`voxelize`、`context`） | `fetch.py`（https 下载，主机列表、逐跳检查重定向、核对大小和哈希）→ 给 `models`、`bundle` 下载外部模型和外链贴图，给 `scan-zip` 下载成员 |
| 依赖 `pymongo`；`scripts/demo_seed_hints.py` | 工作台 `recon/` 整个（S7 改名 `bench/`）；`scripts/` 里的验收脚本、提示、结果图 |

- `config.py` 删掉之前，工作台 `prepare.py`、`reframe.py` 从 `config.Config` 取的解析上限搬到 `processing/limits.py` 的常量（默认值不变）。
- `handlers/scan.py` 里"导入扫描"的编排、`jobs/writeback.py` 里的锚点规则、`handlers/authored.py` 里的物件集写回（下载外部模型、烘焙、逐件偏差、结构贴图回退），去掉数据库部分后搬进新的 `bundle/` 子包，输出从"写提交"变成"写重建包"。
- 测试：用到 MongoDB 的测试（约 60 个）按内容分两路：服务端语义（核对、清理、栅栏、空间实例、用量）移植成接口服务的 Rust 测试（S2）；重建语义（锚点规则、物件集写回、外部模型、烘焙）改成本地 `bundle` 的测试，不再需要数据库。`.github/scripts/pytest_require_mongo.py` 和它的测试删掉。

### 8.3 本地命令（`metaverse-recon`）

| 命令 | 作用 | 来自 |
|---|---|---|
| `doctor [--install]` | 检查渲染要用的 node、three、Playwright、Chromium、字体；`--install` 把 three 和 Playwright 装进缓存目录（不在平台仓库里时用） | 现有；`--install` 是新的 |
| `prepare` | 扫描 + 可选提示 → 基线目录（对齐、算法结构和物体、候选清单）；`--transform <文件>` 用给定变换（已有空间重建时不重新对齐） | 现有；变换参数是新的 |
| `align` | 只算对齐：首次自动对齐；或重扫配准到参考扫描（`--reference <参考扫描> --reference-transform <文件>`），输出 `transform.json`、误差和候选；误差超过 `--max-error-cm`（默认 3）时退出码非 0 | `processing/align.py` |
| `webmodel` | 生成网页用模型（接缝不裂开的减面、贴图补边） | `processing/webmodel.py` |
| `views`、`measure`、`compare`、`search`、`index`、`fetch`、`place`、`reframe` | 不变 | 现有 |
| `assemble` | 合并成 AI 物件集 | 现有 |
| `models` | 外部模型：下载、核对，把摆放的旋转、缩放、调色烘进网格（节点用单位变换），按物件模型的上限减面、缩小贴图，只用白名单里的扩展，原点放在底面中心，写成 glb；多材质、平铺贴图、相同偏航的去重导出在这里修（第 12 节） | 原物件集写回 |
| `bake`、`fit` | 烘焙贴图；逐件偏差（与 `compare` 同一个函数） | 原物件集写回 |
| `scan-zip` | 新：把扫描成员按 `pack.rs` 的规则打成 zip（成员列表来自来源表或命令行参数，先下载、核对）；读别人的扫描 zip 时限制成员解压后 ≤ 2 GiB、拒绝 `..` 和绝对路径 | 新 |
| `bundle` | 打包：物件集（或 `--algorithm`：直接用基线里的算法结构和物体）→ `models`、外链贴图下载、`bake`、`fit`、按类别建议锚点、网页用模型（`--webmodel <文件>` 用已有的，否则生成）、`scan-zip` → `out/bundle/`；编号统一加 `rb.`；`base` 取工作区 `space.json`；`--seed` 去掉内部锚点和建模记录；`--from-snapshot <工作区>` 用拉下来的快照（重建层物件、模板、扫描元数据）生成整体替换的包（编号改成 `rb.` 开头，模板引用一起改）；最后调用 `metaverse bundle check` | 原 `scan_import` + 物件集写回的编排 |
| `voxelize` | 保留为本地实验命令，结果不能进包（重建包第一版没有方块） | `processing/voxelize.py` |

所有命令只读写本地文件，**不连接本服务**，也不需要任何凭证；只有 `search`、`fetch`、`models`、`bundle`、`scan-zip` 会去模型库、贴图地址和扫描地址下载（主机列表 `METAVERSE_RECON_MODEL_HOSTS`）。

### 8.4 安装与交接

- **安装**：平台仓库是公开的。仓库外：`uv tool install "git+https://github.com/ChronoAIProject/chrono-metaverse@<标签>#subdirectory=recon"`，再 `metaverse-recon doctor --install`（`bench/env.py` 已经支持缓存位置，不再依赖仓库的 `web/node_modules`）。在仓库里开发：`cd recon && uv sync --frozen`。
- **在命令行工作区里做**：`metaverse init` 建的目录（有 `space.json`）。`metaverse-recon` 从当前目录往上找 `space.json` 来定默认值：
  - `--scan` 默认 `scan/scan.zip`（`metaverse pull --scan` 写的）；
  - `--transform` 默认 `scan/transform.json`（`pull` 写的，格式与 `align` 的输出相同：`{transform: [16 个数], source: "pull" | "align", seq}`）；
  - `--limits` 默认 `limits.json`（`pull` 写的服务端上限；没有就用内置默认值，与服务端默认相同）；
  - 基线默认 `out/recon/`，包默认 `out/bundle/`，包的 `base` 取 `space.json` 的 `{spaceId, seq}`。
- `metaverse bundle push` 默认读 `out/bundle/`。不在工作区里时，所有路径都要显式给。

### 8.5 命令行（`metaverse`）的分工

TypeScript 命令行负责一切和本服务打交道的事（NyxID 凭证只在这一处）：

| 命令 | 变化 |
|---|---|
| `scan`、`rebuild`、`voxelize` | 删除（连同 `commands/authored.ts`、传输层里调这些接口的方法） |
| `bundle check [目录] [--seed]` | 新（6.5） |
| `bundle push [目录]` | 新（6.6） |
| `publish <草稿编号>` | 认得范围是 `rebuild` 的草稿（走 `/rebuild/drafts/...`），显示 `unchanged` |
| `pull` | 多写 `limits.json`（来自 `GET /api/v1/spaces/{space_id}` 的 `uploadLimits`） |
| `pull --scan` | 新：经 `/api/v1/spaces/{space_id}/assets/{hash}` **分段下载**当前的原始扫描（每段 64 MiB 的 `Range` 请求，能断点续传，避开 NyxID 代理约 100 秒的断开），写 `scan/scan.zip` 和 `scan/transform.json` |
| `pull --share <分享链接> [--seq N] [--assets]` | 新：只读公开快照（`/api/public`），不需要 NyxID：写 `space.json`（带只读标记，不能 `push`）、`entities.json`、`anchors.json`（只有公开锚点）、`scan/transform.json`；`--assets` 另外下载网页用模型和物件模型。分享令牌只在内存里用，不写进工作区（也可以用环境变量 `METAVERSE_SHARE_TOKEN` 给） |
| `init` | 技能说明 `metaverse-reconstruct` 改成本地工具 + `bundle push` 的流程 |
| 其余（`admin`、`build`、`dev`、`shot`、`diff`、`check`、`push`） | 不变；扩展层的编号不能用 `rb.`（核心库规则） |

### 8.6 依赖与平台

Python 3.13；numpy、scipy、pillow、trimesh、DracoPy、fast-simplification（去掉 pymongo），都有 macOS（Apple 芯片和 Intel）和 Linux 的预编译包，不需要编译器和显卡。渲染另要 node 22、Playwright 和 Chromium（`doctor` 会查）。前厅这样的扫描，`prepare` 在 4 核机器上约 46 秒，内存峰值约 1.3 GB。

---

## 9. 网站

- 网站不调用任何任务接口，也没有"处理中"的状态，这次不用改结构。
- **模型的兜底摆放**（`web/src/viewer/sceneView.ts`）：只有模型的物件，模型加载后用 three.js 算实际包围盒（精确模式）；尺寸超出记录 `bounds` 的尺寸超过 max(2 厘米, 1%) 时，整体等比缩小、平移进 `bounds`（底面中心对齐），并在控制台记警告。服务端已经按顶点数据实测包围盒，这一层只是兜底。
- **改动说明**：`ModelSources.tsx` 的 `MODIFIED_NOTE` 现在写"经本服务处理后重新导出"，改成不依赖工具的说法："这些模型可能经过调整（摆放烘进模型、减面、调色、缩小贴图）后重新导出，与原文件不同"；同步改它的测试和 SHAPES 3（并写明署名是写入方的声明，服务端只校验格式）。
- 公开提交列表的 `actor.kind` 会出现新值 `rebuild`，网站按字符串处理，不用改。
- 剖切默认高度（`a8e49d3`、`45befcb`）与谁写重建层无关。

---

## 10. 部署

### 10.1 `infra/chrono-cd/app.json` 与资源

- 删掉 `metaverse-worker` 服务（用完整规格 `PUT`，部署后用 `get_app_status` 确认服务已删除）。
- `metaverse-api` 的 `env`：`METAVERSE_DEMO_SEED` 换成 7.1 的格式；加 `METAVERSE_DEMO_SEED_HOSTS`；显式写出 `UPLOAD_MODEL_MAX_TRIANGLES`、`UPLOAD_MODEL_MAX_TEXTURE_SIDE`、`UPLOAD_WEBMODEL_MAX_TRIANGLES`、`UPLOAD_MAX_TEXTURE_SIDE`、`PUBLIC_CACHE_BYTES=134217728`、`UPLOAD_MAX_CONCURRENT_PARTS=4`（部署规格检查核对）。
- 资源：`metaverse-api` 内存申请 384Mi、上限 1536Mi，CPU 250m / 1（4.8）。去掉处理服务后组织配额少占 500m CPU 申请、3Gi 内存申请和 8Gi 临时盘。

### 10.2 镜像、工作流、持续集成、检查脚本

| 文件 | 变化 |
|---|---|
| `infra/worker/`（`Dockerfile`、`build-requirements.txt`） | 删除 |
| `infra/api/Dockerfile` | 不变（种子下载用内置根证书） |
| `.github/workflows/images.yml` | 镜像只剩 `api`、`web` |
| `.github/workflows/ci.yml` | `worker` 任务改成本地工具：不再起 MongoDB，`uv sync --frozen --extra dev`、ruff、pytest；删掉"持续集成插件的测试"；hadolint 只查两个 Dockerfile |
| `.github/dependabot.yml` | 删掉 docker 的 `/infra/worker` 和 pip 的 `/infra/worker`（S6a）；加 `/recon`（S7） |
| `.github/scripts/pytest_require_mongo.py`、`test_pytest_require_mongo.py` | 删除 |
| `infra/chrono-cd/check-app.mjs` 及测试 | 删掉处理服务的检查；加：`METAVERSE_DEMO_SEED_HOSTS` 显式写出且每项合法；种子是新格式（旧字段报错）；清单和来源表的地址是 https、主机在列表里、sha256 和大小齐全；上面列出的上限和缓存配置显式写出且是正整数；不允许出现 `metaverse-worker` |
| `infra/chrono-cd/pin-images.mjs`、`check-pins.mjs` 及测试 | 只认 `api=`、`web=`；删掉处理服务构建后端的检查 |
| `infra/chrono-cd/README.md`、`demo/README.md` | 删掉处理服务、线程数一节；"演示数据"一节改成重建包（7.4）；回滚一节按 11.5；更新镜像时注意种子格式和镜像要在同一次 `PUT` 里一起换 |

### 10.3 本地开发设施（`infra/dev/up.sh`）

- 不再起处理服务，去掉 `--no-worker`、`WORKER_HEALTH_PORT`、`worker.log`（S2 就改，见 13.3）。
- 模拟 NyxID（`mock-nyxid.mjs`）给验收用的重建身份签发带 `metaverse:rebuild:write` 的令牌；另留一个不带这个权限的身份做反例。
- 接口服务的环境变量加 `METAVERSE_DEMO_SEED_HOSTS`（本地种子默认用 `infra/chrono-cd/demo-seed.json`；第 4 版上线后它带包，新库要从 GitHub 和 Scaniverse 下载约 23 MB）。
- 本地工具的虚拟环境由需要它的地方准备（九步验收、重建教程），`up.sh` 只在最后打印"本地重建工具：`recon/.venv/bin/metaverse-recon`（没有就 `cd recon && uv sync --frozen`）"。
- `infra/dev/README.md` 同步。

### 10.4 九步验收（`infra/dev/e2e.mjs`）

| 步 | 现在 | 改成 |
|---|---|---|
| 1 | 建组织空间（实体区、虚拟区、地块 p1） | 不变 |
| 2 | 分片上传前厅扫描 | **本地工具产出重建包**：在一个工作区里 `metaverse pull`，`metaverse-recon prepare --scan <扫描>` → `metaverse-recon bundle --algorithm` → `metaverse bundle check` 通过；不需要服务，前厅约 1 分钟 |
| 3 | 处理服务完成对齐和 AI 重建 | **上传并发布**（带重建权限的身份）：`metaverse bundle push --publish`——分片上传（0.25 MiB 一片），等后台核对；在另一个空间验证按哈希复用只在本空间成立；发布一次提交（重建层、扫描、锚点，`actor.kind = rebuild`）；同一个包再推一次得到 `unchanged` |
| 4–9 | 快照、三种视图、回到重建前、"现在"模式、地块建造、越权 | 不变；第 9 步的越权加：不带重建权限调重建路径 403；组织 member 调重建路径 403；实体区路径上传 `scan` 被拒；地块路径上传 `bundle` 被拒；地块草稿放 `rb.` 编号被拒；预览令牌下载原始扫描、清单、建模记录都是 404 |

`--voxelize` 选项去掉。`METAVERSE_E2E_JOB_TIMEOUT` 改成等上传核对和包展开（默认 600 秒）。

---

## 11. 线上数据迁移与回滚

### 11.1 线上现在有什么

NyxID 服务还没注册（`ALLOWED_NYX_SERVICE_IDS` 是占位值，`/api/v1` 一律 401），所以线上的写入**全部来自部署种子**：

- `spaces`：`chronoai-lobby` 一个空间，`frame` 已固定，没有定义区域；
- `commits`：第一次提交 + 第 1–3 版 `scan_import` 写的提交（`actor.kind = job`，带 `jobId`、`scan`、`scriptRef`）；
- GridFS：扫描 zip（`kind: scan`）、网页用模型（`web_model`）、贴图（`texture`）、处理后的外部模型（`model`，带 `sourceHash`）、脚本；`assetRefs` 登记了网页要用的那些；
- `jobs`：三个 `scan_import`（`done`），可能还有派生的任务；`uploads` 基本为空。

### 11.2 上线顺序

| 次 | 内容 | 线上写不写新格式的数据 |
|---|---|---|
| R2 瘦身 | S1–S9 全部合并、新的九步验收通过后发布：接口服务带上执行器、核对、清理、重建路径、新用途、410 的旧接口；规格里删掉处理服务；种子换成新格式、**版本仍是 3、不带包**（空间已存在，什么都不做） | 基本不写：`/api/v1` 一律 401，种子什么都不做；只写清理锁、迁移记录、旧任务退役（预计 0 条）和旧资源补上的 `metadata.check` |
| R3 前厅第 4 版 | **同一镜像**，只把种子改成版本 4、带包 | 写一次 `actor.kind = rebuild` 的提交 |

R2 读得了它自己和 R3 写的一切，所以不需要单独的"兼容读"版本。**前提**是 NyxID 注册晚于 R2：注册以后 `/api/v1` 能写，R2 上线当天就可能写进 R0（现在的版本）读不了的数据。如果注册早于 R2，先发 **R1**：核心库能读新枚举和新字段（`rebuild`、`bundle_import`、`webmodel`、`bundle`、`bundleRef`、`alignment`、新操作、草稿的新字段）；保存草稿改成按字段 `$set`；处理服务的清理认得 `heldAssets`、`bundleRef`（R1 照样运行处理服务，这一处是小改动）。

### 11.3 第一次部署 R2 时发生什么

1. 启动：幂等地建索引（`commits` 加 `(spaceId, changedAnchors.id)`，供 `ifNew` 查历史；`migrations` 放锁），建完才就绪。
2. 执行器开始领取 `upload_verify`、`ops_from_upload`、`bundle_import`；清理开始按锁运行，第 0 步把已下线种类的未完成任务标记失败（线上预计 0 条）。
3. 后台迁移 `backfill-asset-check-v1` 开始（11.4）。
4. 种子：版本 3 的任务已存在 → 什么都不做。
5. 读路径（快照、回放、公开资源）完全不碰任务和处理服务，线上前厅照常能看、能回放到第 1–3 版的任何时刻。

### 11.4 后台迁移

- **旧任务退役**：不是一次性迁移，而是清理第 0 步的固定内容（第 5 节），每轮幂等执行。
- **`backfill-asset-check-v1`**：给没有当前版本 `check` 的旧资源补上核对结果。范围是 `metadata.kind` 为 `scan`、`web_model`、`model`、`texture` 的资源；用与 `upload_verify` 相同的检查器流式读一遍（也核对 sha256），按条件 `$set metadata.check`；检查不过就写 `metadata.checkError = {v, reason}` 并记日志（这些资源不能再被新引用，已有提交不受影响）。用 `migrations` 里带租约的锁保证只有一个副本在跑，进度游标存在迁移记录里，可重入；每轮限量，不阻塞请求。线上约 1 个扫描、2 个网页用模型、10 个外部模型和若干贴图。
- 提交、记录、`assetRefs`、`frame` 都不用改。不需要单独的迁移脚本。

### 11.5 回滚

| 从 | 退到 | 条件和做法 |
|---|---|---|
| R3 | R2 | 随时可以：把种子配置退回版本 3（同一镜像）。第 4 版的提交只追加，R2 读得了。内容有问题就发布第 5 版包修正；要让重建层和扫描回到第 3 版的样子：`metaverse pull --share <链接> --seq <第 3 版>`，`metaverse-recon bundle --from-snapshot` 打成整体替换的包，再发布（编号会换成 `rb.` 开头）。**包不能删锚点**：第 4 版新建的锚点要用实体区草稿另外删 |
| R2 | R0（现在） | 只在**还没写过新格式数据**时可以：R3 还没发、NyxID 还没注册。在 chrono-cd 把应用规格退回 R0 的版本（`list_app_revisions` 找到、`put_app` 那一份；镜像、环境变量、处理服务一起回来）。R2 写的 `metadata.check`、`checkError`、迁移记录，R0 都会忽略 |
| R3 之后 | R0 | **不可以**：R0 读不了 `actor.kind = rebuild` 的提交，回放会坏。只能前滚修正，或退到 R2 |

镜像都按摘要固定，处理服务的旧镜像仍在 ghcr.io。如果走了 R1 路线：R2 → R1 时，R1 的处理服务不领取 `bundle_import`，R2 建的、还在排队的 `ops_from_upload`（`attempt = 0`）在 R1 里没人执行也不会被回收——退回前先确认没有这类任务，或退回后用一次运维操作把它们标记失败。

---

## 12. 贴图能力那一轮怎么接上

三条没合并的分支（上一轮"贴图能力"做了一半）这样处理：

| 分支 | 留下 | 去掉或改写 |
|---|---|---|
| `worktree-wf_b3d9c6a7-d50-1`（规格和测试向量） | SHAPES 2 新增的材质字段（`tile`、`offset`、`rotate`、`shading`、`normalMap`、`normalScale`、`roughnessMap`、`roughness`、`metalness`）、外部模型物件的 `material.shading`、全部 `shape_material_*`、`shape_invalid_material_*`、`uv/` 向量和 `texture_vectors.py` | ARCHITECTURE 6.3 那段改动整段丢掉；SHAPES 和向量 README 里"由处理服务下载外链贴图、登记后换成哈希"改成"由本地工具 `bundle` 下载、核对后作为 `texture` 文件进包，记录里换成哈希"；`WORKER_MODEL_HOSTS` 改成 `METAVERSE_RECON_MODEL_HOSTS`，`WORKER_MAX_AUTHORED_TEXTURE_BYTES` 改成本地工具的 `METAVERSE_RECON_MAX_TEXTURE_BYTES`；`authored/authored_texture_urls_*.json` 改由本地工具使用 |
| `worktree-wf_b3d9c6a7-d50-2`（接口服务实现了一半） | `9f29ba9`（形状材质的新字段）、`a339d2c`（外部模型的 `shading`）；`ba63f93` 里的资源引用收集（`normalMap`、`roughnessMap` 进贴图收集、草稿资源检查、清理的引用） | `ba63f93` 里对物件集外链贴图的浅层校验（`metaverse_core::authored` 整个删除） |
| `worktree-wf_b3d9c6a7-d50-3`（命令行实现了一半） | `8204018`（形状材质校验、`shading`）、`71cac06`（工具包的材质选项） | `ba1463b` 里 `commands/authored.ts`、`rebuild.ts` 的改动（这两个文件删除） |

本地工具这边：外链贴图 `{url, sha256, size}` 只出现在物件集（本地文件）里，`bundle` 按外部模型同样的下载规则下载，按贴图用途的上限（4096）检查，作为 `texture` 文件进包，记录里换成哈希。外部模型的导入修正在 `processing/modelimport.py` 和 `models` 命令里做，接口服务只看导出的 glb 合不合 4.5 的检查。

T 做完后的状态（实施记录）：

- 三边的形状校验（Rust、命令行、本地工具的 `shapes.py`）都认新字段，错误路径一致；资源引用（`Shape::texture_refs`、本地工具的 `material_textures`）都算上 `normalMap`、`roughnessMap`。
- 贴图坐标：网站（`web/src/core/shapes/`）和本地工具（`processing/shape_mesh.py`）都按 SHAPES 算平铺，跑 `uv/` 向量；本地工具查看用的 glb 按 SHAPES 2"glb 导出"写采样器、法线和粗糙度。
- `authored/` 向量现在没有运行器：接口服务的物件集浅层校验（S4 连同 `metaverse_core::authored` 一起删）和命令行的 `commands/authored.ts`（S5 删）都不接；S6b 的 `bundle` 下载外链贴图时接上，物件集里外部模型的 `shading` 默认写成 `albedo` 也在那里做（现在物件集里写了就原样保留）。
- **网站的画法没有接上**：`shading`（`albedo` 完整受光、不加自发光）、`normalMap`、`roughnessMap`、`roughness`、`metalness` 以及物件模型的 `material.shading`，网站现在都按原来的看法画（`sceneView.ts` 的形状材质和模型材质；贴图缓存要按（哈希，用途）区分颜色空间）。这次改造的各步都不包括它，列进第 14 节"以后的增强"；前厅第 4 版的物件集不用这些字段，不受影响。

---

## 13. 实施计划

### 13.1 总览

| 编号 | 内容 | 依赖 | 改动量（估） |
|---|---|---|---|
| T | 贴图能力收尾：-1、-2、-3 按第 12 节裁剪后合并 | — | 新写 300–600 行 + 合并 |
| S1 | 核心库（Rust + TypeScript）和规格文档：新类型、新操作、通用新规则、`check`、`limits`、`bundle` 模块（Rust） | T（最好） | Rust +1,500；TypeScript +700；向量 30+ 个 |
| S2 | 接口服务后台执行器、上传核对、清理、后台迁移；`ops_from_upload` 进执行器；本地 `up.sh` 不再起处理服务 | S1 | Rust +4,000（其中测试约 1,700） |
| S3 | 重建路径：路由、重建权限、草稿两类资源和预览、发布规则、按核对结果判断角色、没有实体区时的范围、OpenAPI | S1；与 S2 可并行（测试里直接登记资源） | Rust +2,000 / −300 |
| S4 | 演示种子改成重建包；删除旧接口和旧代码（410、`authored`、`hints`、`scan_params`） | S2、S3 | Rust +1,000 / −2,600 |
| S5 | 命令行：删旧命令；`bundle check`、`bundle push`、`publish` 认重建草稿、`pull --scan`、`pull --share`、`limits.json`；技能说明 | S1；联调要 S3 | TypeScript +1,300 / −900 |
| S6a | 本地工具去掉服务端部分；删 `infra/worker/`；工作流和 Dependabot 去掉处理服务 | S2 | Python −4,000 / +600 |
| S7 | 改名 `worker/` → `recon/`（8.1，纯机械） | S6a | 约 120 个文件改路径 |
| S6b | 本地工具新命令：`align`、`webmodel`、`models`、`bake`、`fit`、`scan-zip`、`bundle`、`doctor --install`、工作区交接 | S1（清单格式）、S7 | Python +2,200 |
| S8 | 网站：改动说明、模型兜底摆放 | — | 约 80 行 |
| S9 | 部署与开发设施、九步验收、各 README 和教程 | S2–S8（含 S6b） | +900 / −1,200 |
| S10 | 前厅第 4 版：本地打包 → 托管 → 清单和来源表进仓库 → 种子版本 4 | S4、S6b、S9；用户确认托管方式 | 数据 + 配置 |

```
T ──► S1 ──┬──► S2 ──┬──► S4 ──────────────┐
           │         └──► S6a ──► S7 ──► S6b ─┤
           ├──► S3 ──────► (S4)              ├──► S9 ──► R2 ──► S10 ──► R3
           └──► S5 ──────────────────────────┤
S8 ──────────────────────────────────────────┘
```

可以同时开工的：Rust 一路（S1 → S2 ‖ S3 → S4）、TypeScript 一路（S5，等 S1）、Python 一路（S2 合并后 S6a → S7 → S6b）、网站（S8，随时）。S6a、S7 不能和其他改 `worker/` 的工作同时进行（改名会让并行的改动全部冲突）。

### 13.2 各步明细

#### T 贴图能力收尾

- **改哪些文件**：按第 12 节从三条分支挑提交；`docs/SHAPES.md`、`api/crates/metaverse-core/tests/vectors/`（`shape_material_*`、`uv/`）、`api/crates/metaverse-core/src/shape*.rs`、`sdk/typescript/src/core/shape.ts`、`worker/` 的 `texture_vectors.py`。
- **验收**：三边都跑新的 `shape_material_*`、`uv/` 向量；`cargo test`、`npm test`（sdk、web）、pytest 全过。

#### S1 核心库与规格文档

- **改哪些文件**：
  - `api/crates/metaverse-core/src/scope.rs`：`PathScope::Rebuild`；上传用途表（2.9）；`AllowedArea` 的"除去"模式和 `for_scope(Rebuild)`；新错误 `ScanOutsideRebuild`、`RebuildPurposeOutsideRebuild`。
  - `model.rs`：`ActorKind::Rebuild`、`JobKind::BundleImport`、`ScanRef.alignment`、`Commit.bundle_ref`、`Touched.scan`/`rebuilt_layer`、`check_transform`（从 `metaverse-api/src/routes/jobs.rs` 移来，原处改为调用它）、`UploadPurpose`/`UploadFormat` 的新值。
  - `ops.rs`：`SetScan`、`ClearRebuilt`、`RemoveEntity.if_present`、`CreateAnchor.if_new`；工作状态的范围种类、`anchor_history`、`templates_of(layer)`、`users_of_template` 按层；`existing_ext_entity` 改成按范围种类判断层。
  - `record.rs`：编号前缀规则（`rb.`）、同层模板（`validate` 接按层的模板表）。
  - 新 `check.rs`（`AssetCheck` 类型、角色判断函数 `fits(role, check, limits)`）、`limits.rs`（各用途默认上限）、`bundle.rs`（清单类型、逐条解析、6.3 校验、`to_ops`）；`lib.rs` 导出。
  - 测试：`tests/ops_vectors.rs`（新向量）、新 `tests/bundle_vectors.rs`；向量 `tests/vectors/ops/`（新操作、编号前缀、同层模板、`ifPresent`、`ifNew` 带历史、重建范围里不许的操作、"除去"范围，约 16 个）、`tests/vectors/bundle/`（合法、不合法、展开结果，约 14 个，含"合并包推两次"的期望操作序列）、`tests/vectors/README.md`。
  - TypeScript：`sdk/typescript/src/core/{ops.ts, scope.ts, record.ts}`（扩展层用到的新规则）、新 `bundle.ts`（清单结构校验，不展开）及测试。
  - 文档：`docs/SHAPES.md`——第 3 节加编号前缀、同层模板、署名是写入方的声明、物件模型 glb 的要求（节点用单位变换、原点在底面中心、扩展白名单）；新第 7 节"重建包清单"（6.2、6.3）；新第 8 节"资源核对记录与各用途上限"（4.4–4.6）；新操作写进操作说明。
- **接口与数据**：2.4、2.5、2.9、4.6、6.2–6.4。不改任何路由。
- **验收**：新操作和规则的 `ops/` 向量 Rust、TypeScript 结果一致；`bundle/` 向量 Rust 展开结果与期望相同，TypeScript 对合法、不合法的判断与 Rust 相同；旧的提交、任务、草稿文档（取自现有测试夹具）往返读写不变；`metaverse-api` 全部测试照过；用公开快照确认线上前厅没有扩展层物件、没有 `rb.` 开头的编号（写进合并请求说明）。

S1 做完后的状态（实施记录）：

- 核心库（Rust）：`scope`（`PathScope::Rebuild`、上传用途表、"除去"模式）、`model`（新取值和新字段、`check_transform`、
  `check_alignment`）、`ops`（`setScan`、`clearRebuilt`、`ifPresent`、`ifNew`、范围种类、锚点历史、草稿的扫描、
  `broken_template_refs`）、`record`（`rb.` 前缀）、新模块 `limits`、`check`、`bundle`；接口服务只跟着改到能编译，
  路由不变。TypeScript 核心库：`scope.ts`、`ops.ts`、`record.ts`、`shape.ts`（`textureRefs`），新 `bundle.ts`（结构校验，
  不展开）、`limits.ts`、`timestamp.ts`。向量：`ops/` 新增 22 个（共 48 个），`bundle/` 29 个；`tests/compat.rs` 核对旧文档往返。
  SHAPES 第 3 节加了图层与编号、草稿的种类与操作、物件模型的要求，新第 7、8 节。
- 实现时补上的细节（设计没写到，按最小的写法定下）：
  1. 新错误类别 `OpError::NotAllowed`（接口返回 422 `op_not_allowed`），向量里的错误类别 `notAllowed`；
  2. 重建草稿里 `createAnchor` 不带 `ifNew` 也拒绝（防御，展开时一律带上）；`setScan` 没有格子上的影响范围；
     `clearRebuilt` 的影响范围是被删的非模板物件；带 `ifNew` 被跳过的锚点、带 `ifPresent` 而不存在的物件影响范围为空；
  3. 模板引用的完整性按"同一层存在"判断，跨层的旧引用也算缺；
  4. 清单的 `rebuilt.remove` 上限 2000；字段为 `null` 等于没给（数组字段除外）；每条记录 64 KiB 按清单原文算，
     本地工具写清单时记录不缩进（命令行按记录的紧凑 JSON 算）；
  5. `uploadLimits` 的形状（`{v, scan, webmodel, model, texture, ops, script, bundle}`）定在 SHAPES 8；
  6. 扫描用途的 glb 只做轻量检查，`check.triangles`、`check.bounds` 为空，不能当网页用模型或物件模型；同一份字节再按
     完整用途上传时补写 `check`（4.3 第 5 步已改）；
  7. RFC 3339 的写法按 Rust `time` 库（`T`、`t` 或空格，时区偏移 ≤ 23:59，只认 23:59:60 这个闰秒），TypeScript 照着实现。
- 与设计的偏离（都是多做或提前生效）：
  1. TypeScript 的工作状态也实现了重建范围的操作（`setScan`、`clearRebuilt` 的作用），`ops/` 向量两边全部一致；
     清单仍只做结构校验，不展开；
  2. 通用新规则对现有的实体区、地块草稿已经生效：编号不能以 `rb.` 开头、模板只能同层引用、没定义实体区的空间实体区路径
     是"除去"模式（2.5 第 6 条原定随 S3 的验收）；命令行的本地建造目标同样按"除去"模式算，建造脚本只拿到扩展层的模板；
  3. 上传用途表已是瘦身后的规则，但旧的扫描导入和物件集导入删掉之前（S4），接口服务的实体区上传照旧收 `scan`、
     `authored`（`routes/uploads.rs` 的 `check_legacy_upload_purpose`，S4 删掉）；`webmodel`、`bundle` 在实体区、地块
     路径上仍是 404，S3 的重建路径接上；
  4. 线上前厅的核对没有用公开快照（分享令牌是部署密钥，拿不到），改用线上第 3 版的来源：`lobby-authored.json` 的 52 个
     物件和 1 个模板都在重建层、没有 `rb.` 开头的编号，结构由处理服务的结构算法写入（编号如 `floor`，也不用 `rb.`）；NyxID 注册之前线上只有种子
     能写，扩展层没有物件，也就没有跨层的模板引用。R2 上线前用分享链接的快照再核对一次（S10 的工作区 `pull --share`）。

#### S2 后台执行器、上传核对、清理

- **改哪些文件**：
  - 新 `api/crates/metaverse-api/src/runner/`：`mod.rs`（循环、两类名额、进程内通知、停止）、`claim.rs`（领取、续约、带栅栏的事务写回、重试分类）、`verify/{mod.rs, glb.rs, zip.rs, image.rs, ndjson.rs, text.rs}`、`ops_job.rs`、`cleanup.rs`、`migrations.rs`（`backfill-asset-check-v1`）。
  - `repo/jobs.rs`（领取条件、`saturated_spaces`、`lastError.class`、`history`）、`repo/uploads.rs`（登记、补写 `check`、复用按 `check` 判断）、`repo/blobs.rs`（`AssetRole` 加 `Scan`、`WebModel`，`kind_fits` 改成按 `check` 判断，Content-Type 按 `check.format`）、`repo/drafts.rs`（`save_draft` 改按字段 `$set`；带任务栅栏的保存）、新 `repo/migrations.rs`（锁和迁移记录）。
  - `routes/drafts.rs`（`ops-from-upload` 只插 `queued` 任务并通知；删掉 `MAX_CONCURRENT_OPS_JOBS` 和请求里的协程）、`routes/uploads.rs`（完成时通知执行器）、`health.rs`（只返回就绪）、`ingest/formats.rs`（JPEG 按段走，读不到交给后台）、`ingest/mod.rs` 和 `config.rs`（4.9 的配置）、`lib.rs`（启动执行器和清理）、`main.rs`（运行时至少 2 个工作线程）。
  - 测试：`api/crates/metaverse-api/tests/runner_*.rs`；二进制样本 `api/crates/metaverse-core/tests/vectors/check/`（由测试里的生成器写出并提交，附 `expected.json` 和说明）。
  - 本地设施：`infra/dev/up.sh` 不再起处理服务（13.3）；`infra/dev/e2e.mjs` 加 `--only <步骤>`，在 S9 之前默认只跑第 1、8、9 步。
- **接口与数据**：4.2–4.10、第 5 节；任务文档加 `lastError.class`、`history`，按种类的 `maxAttempts`；`migrations` 集合 `{_id: "lock:cleanup" | "backfill-asset-check-v1", owner, until, cursor?, finishedAt?}`；GridFS `metadata.check`、`metadata.checkError`；`commits` 新索引 `(spaceId, changedAnchors.id)`。
- **验收**：
  - 从处理服务移植的场景全部通过：哈希不符、缺片、块大小不对、复用已有资源、并发上传同一内容、空间删了又建、任务失败后收尾、租约丢失后不写回、两个执行器抢同一个任务只有一个写回、停止时退回队列；
  - **僵尸执行器**：A 的租约过期后 B 领取，A 再尝试写草稿和完成任务，事务中止、草稿不变；B 正常完成；
  - 名额：两个重任务排队时核对仍能领到；同一空间第二个任务等第一个做完；
  - 重试分类：`content` 不重试、`fetch` 和 `transient` 按退避重试、用完后失败；
  - 清理：过期上传和草稿、栅栏（引用和删除交错）、用量成对减回、补打 `publishedAt`、两个进程抢锁、已下线种类的排队任务每轮被收掉、`heldAssets` 和 `bundleRef` 引用的资源不被删；
  - glb、图片、zip、NDJSON 检查跑完 `tests/vectors/check/` 全部样本；拿一份真实的 Scaniverse 导出 zip 和一份 macOS"压缩"生成的 zip 各试一次（结果记进 `api/README.md`）；
  - 补核对迁移：中途停止后从游标继续；检查不过的写 `checkError`；
  - 预算：本机实测"2 个最坏核对 + 1 个最坏重任务 + 4 片并发上传 + 缓存装满"的峰值和 1 GiB 扫描核对的耗时，记进 `api/README.md`；核对期间 `/api/healthz` 的响应都在 1 秒内。

#### S3 重建路径

- **改哪些文件**：
  - 路由：`routes/drafts.rs`、`routes/uploads.rs`、`routes/jobs.rs` 按现有"实体区一组、地块一组"的写法加重建一组（或集中到新 `routes/rebuild.rs`），`routes/mod.rs` 注册；`routes/previews.rs`（只认 `assets`）；`openapi.rs`（2.3 的 12 个 `operationId`）。
  - 鉴权：`auth/permissions.rs`（`metaverse:rebuild:write` → `Capability::WriteRebuild`）、`auth/access.rs`（重建路径的写操作始终检查它）。
  - 时间线：`timeline/drafts.rs`（交包任务的作用和写回、`heldAssets`、冲突键 `layer:rebuilt` 和 `scan`、没有变化、发布时的模板完整性、`observedAt`、默认说明和脚本）、`timeline/writer.rs`（`CommitPlan` 加 `scan`、`bundle_ref`；`manifest_after` 带扫描；`frame` 条件写）、`timeline/state.rs`（工作状态带范围种类、按需加载锚点历史）、`timeline/snapshot.rs`（内部投影带 `alignment`）。
  - 数据访问：`repo/drafts.rs`（`DraftDoc` 加 `heldAssets`、`bundleRef`、`unchanged`、`defaultMessage`、`defaultScriptRef`）、`repo/commits.rs`（锚点历史、最近一次带扫描的提交）、`repo/spaces.rs`（`frame` 条件写）。
  - `routes/spaces.rs`：`GET /api/v1/spaces/{space_id}` 加 `uploadLimits`。
- **接口与数据**：2.3–2.8、第 3 节。旧代码（`routes/jobs.rs` 的发起接口、`authored`、`hints`）这一步**不删**，种子还在用。
- **验收**：
  - 重建路径全套接口的成功和失败路径；没有重建权限 403（总开关开和关两种配置都是 403）；member 403；
  - 实体区草稿不能写重建层、不能放 `rb.` 编号、不能用 `setScan`；重建草稿只能交一个包、不能写扩展层；
  - 跨层引用模板被拒；发布时"模板被删、另一个草稿刚加了使用者"返回 409 `broken_template_ref`；
  - `setScan` 首次固定 `frame`、之后不变；`observedAt` 沿用；
  - 冲突：**两个重建草稿交错**——A 整体替换、B 合并新增，先发布 A 后 B 得 409（键 `layer:rebuilt`），B 重放后结果是"A 的层 + B 新增的"；实体区草稿与重建草稿只在同一锚点编号上冲突；
  - 没有变化返回 `unchanged`；合并包推两次第二次 `unchanged`；被实体区草稿删掉的锚点不会被重建包重新建出来；
  - 资源角色表每一行的正反例；**别的空间抢先以别的用途登记同一份 glb 之后**，本空间照样能按 `model` 引用；模型一致性检查；
  - **预览**：拿预览令牌下载原始扫描、清单、建模记录、操作文件都是 404，网页用模型、物件模型、贴图能下载；
  - 没定义实体区的空间：实体区草稿能挪锚点，虚拟区和地块里的操作被拒；
  - OpenAPI 里出现 12 个新 `operationId`。

#### S4 演示种子 + 删除旧代码

- **改哪些文件**：
  - `demo_seed/mod.rs`（启动流程 7.2、失败任务重新排队）、`demo_seed/config.rs`（新格式；旧格式记错误、跳过）、新 `demo_seed/sources.rs`（来源表）、`demo_seed/fetch.rs`（流式下载进上传会话，不再整份读进内存）、`demo_seed/pack.rs`（逐个成员写进数据块）；新 `runner/bundle_import.rs`。
  - 删除：`routes/jobs.rs` 的发起接口（6 个路由改成 410，新 `routes/retired.rs`）、`authored` 上传用途（410）、`hints`、`scan_params`、`AUTHORED_KIND`、`MAX_HINTS_BYTES`；`api/crates/metaverse-core/src/authored.rs` 和 `tests/demo_authored.rs`；OpenAPI 里对应的说明和标签 `scans`。
  - `infra/chrono-cd/demo-seed.json`：新格式，版本 3，不带 `bundle`；`infra/dev/demo-seed.mjs` 跟着改。
  - 测试 `api/crates/metaverse-api/tests/demo_seed_*.rs`；`tests/vectors/demo_seed_zip.json` 保留。
- **接口与数据**：第 7 节；任务参数 `{manifest, sources, revision}`。
- **验收**：本机 https 测试服务器当 GitHub 和 Scaniverse：新库全流程（建空间、下载、打包扫描、登记、展开、发布）；已有旧任务的版本什么都不做；版本加一在同一空间追加；**第一次 404、重启后成功**（重新排队）；403、429 先重试；**租约丢失后在"追加"和"发布"之间重做**，结果只有一个提交；发布时有冲突自动重放；没有变化写 `unchanged`；主机不在列表、重定向到列表外、哈希不符、清单不合规、来源表缺文件各自失败且不重试；空间不是种子建的不碰；旧格式配置只记错误、服务照常就绪；6 个旧路由和 `authored` 上传返回 410。

#### S5 命令行

- **改哪些文件**：`sdk/typescript/src/commands/`：删 `scan.ts`、`rebuild.ts`、`voxelize.ts`、`authored.ts`；新 `bundle.ts`（`check`、`push`）；改 `publish`（在 `common.ts` 或所在文件）认重建草稿；改 `pull.ts`（`--scan` 分段下载、`--share`、`limits.json`）；`index.ts` 注册。`src/transport/api.ts`（重建路径、`Range` 分段下载、公开快照）、`src/transport/upload.ts`（重建上传）；新 `src/core/check/{glb.ts, image.ts, zip.ts}`；技能说明 `metaverse-reconstruct`；`sdk/typescript/README.md`。
- **接口与数据**：6.5、6.6、8.4、8.5。
- **验收**：`bundle check` 跑 `tests/vectors/bundle/` 的结构部分和 `tests/vectors/check/` 全部样本，结果与 Rust 相同；`bundle push` 对着模拟接口跑通：没有 `base` 拒绝、空间不符拒绝、复用、上传、等待、交包、预览、发布、`unchanged`、冲突后 `--replay`、本地缺文件且不能复用时停下；`pull --scan` 断点续传；`pull --share` 不写令牌进工作区；sdk 的 lint、typecheck、format、测试、构建全过。

#### S6a 本地工具去掉服务端部分

- **改哪些文件**：`worker/src/metaverse_worker/` 按 8.2 删左列；`worker/src/metaverse_worker/processing/limits.py`（新，接住 `config.Config` 里的解析上限），工作台的 `recon/prepare.py`、`recon/reframe.py` 改用它；Mongo 测试按 8.2 分流；`worker/pyproject.toml` 去掉 pymongo 和服务入口；删 `infra/worker/`、`.github/scripts/pytest_require_mongo.py` 及测试；`.github/workflows/images.yml` 去掉 worker；`.github/workflows/ci.yml` 的 worker 任务不再起 MongoDB、hadolint 只查两个 Dockerfile；`.github/dependabot.yml` 删 worker 两项；`infra/chrono-cd/check-pins.mjs` 去掉处理服务构建后端的检查。`app.json`、`check-app` 留到 S9。
- **验收**：剩下的 pytest 不连数据库全过；`metaverse-recon prepare` 在前厅上的结果（变换、结构、物体编号）与改动前完全相同；持续集成全绿。

#### S7 改名

- **改哪些文件**：8.1 的清单。
- **验收**：`git diff -M --stat` 除清单里列出的几处外全是改名；全部测试和持续集成通过；在仓库外的临时目录 `uv tool install ./recon` 后跑 `metaverse-recon doctor --install` 和一次 `prepare`。

#### S6b 本地工具新命令

- **改哪些文件**：`recon/src/metaverse_recon/bundle/`（新子包：编排、清单写出、`rb.` 编号、`--seed`、`--from-snapshot`、`base`）、`processing/` 下 `align`、`webmodel`、`modelimport` 的命令入口和导出修正、`bench/cli.py`（新命令注册：`align`、`webmodel`、`models`、`bake`、`fit`、`scan-zip`、`bundle`、`doctor --install`）、`bench/env.py`（往上找 `space.json`、缓存安装）、`recon/README.md`、`docs/tutorials/reconstruct-with-ai.md`。
- **接口与数据**：6.1–6.4、6.8、8.3、8.4。
- **验收**：用现在的 `lobby-authored.json` 打出的包：外部模型 glb 的三角形数、包围盒与处理服务现在写回的一致（容差 1 毫米），逐件偏差与现在一致；所有模型过 4.5 的检查（`metaverse bundle check` 通过）；`scan-zip` 跑 `demo_seed_zip.json` 向量；`--from-snapshot` 打出的包展开后，重建层与快照的形状一致（编号除外）；`--seed` 的包里没有内部锚点和建模记录。

#### S8 网站

- **改哪些文件**：`web/src/viewer/sceneView.ts`（只有模型的物件按实际包围盒兜底摆放）、`ModelSources.tsx` 及测试。
- **验收**：网站测试里改动说明的断言更新后通过；新测试：一个实际比 `bounds` 大很多的模型被缩进 `bounds`，符合的模型不动。

#### S9 部署与开发设施

- **改哪些文件**：10.1–10.4 列出的全部；`infra/dev/mock-nyxid.mjs`（重建权限的身份）；`infra/dev/e2e.mjs` 九步改完、去掉 `--only` 的默认值；各 README；教程 `docs/tutorials/build-space.md`、`reconstruct-with-ai.md`；`docs/SHAPES.md` 里"处理服务"的说法；`docs/PROGRESS.md`。
- **验收**：新的九步验收在本机全过；`check-app`、`check-pins`、`pin-images` 的测试过；持续集成全绿；`up.sh --demo-seed` 在新库里只建演示空间（R2 的种子不带包）。

#### S10 前厅第 4 版

- **做法**：在一个工作区里 `metaverse pull --share <演示链接> --assets`（变换、网页用模型）→ `metaverse-recon scan-zip`（按来源表的成员打包，哈希应等于线上的扫描）→ `metaverse-recon bundle --seed --webmodel <线上那份> --authored infra/chrono-cd/demo/lobby-authored.json` → `metaverse bundle check --seed` → 上传发布页 → 写来源表 → `infra/chrono-cd/demo/lobby-r4/{manifest.json, sources.json}` 提交 → 本机 `up.sh --demo-seed`（新库）用新配置全流程跑一遍 → `app.json` 种子改成版本 4，更新 `infra/chrono-cd/demo/README.md`。
- **验收**：本机新库从 Scaniverse 和发布页下载约 23 MB，导入成功；线上：时间线有第 1–4 版，能回到第 1–3 版的任何时刻；"优化"视图是第 4 版；"原始"视图与第 3 版完全相同（网页用模型哈希不变）；第 4 版提交的 `observedAt` 是扫描拍摄日；分享链接不变；接口服务日志里种子任务 `done`。

### 13.3 中间状态

- **S2 合并后到 S9**：本地 `up.sh` 不再起处理服务（否则两个执行者都领 `upload_verify`，旧处理服务不认识新用途会判失败）。旧的"上传扫描 → 处理服务重建"流程在本地不再可用，九步验收只跑第 1、8、9 步（第 4–7 步依赖第 3 步的重建结果），其余由各步自己的测试覆盖；`--demo-seed` 时旧种子建的 `scan_import` 任务会被清理第 0 步标记失败。线上不受影响（线上一直跑按摘要固定的旧镜像，直到 R2）。
- **S3 到 S4**：重建路径已经可用，旧的发起接口和旧种子代码还在，S4 一起删，保证每一步都能编译、测试全过。
- **S6a 依赖 S2**：接口服务能自己核对上传以后，才删处理服务。

---

## 14. 待定

**需要用户拍板**：

1. **演示包大文件的托管**：推荐本仓库的发布页 `demo-assets`（7.4 方案 B，清单和来源表进仓库），需要确认可以用发布页放演示数据，并确认种子包里的一切都会公开（6.8）。S10 之前要定。

**外部依赖（不需要拍板，但决定了能力什么时候生效）**：

- NyxID 服务注册：注册前线上只能靠种子写入；注册后命令行可以直接把包发布到线上。
- 平台管理员建角色 `metaverse-rebuilder`：建好之前，通过接口谁都写不了重建层（3.2）。
- 目录服务注册和操作范围开关：建好之前，没法按 key 细分重建权限。

**以后的增强（不在这次改造里）**：网站按 SHAPES 2 画着色方式、法线和粗糙度（第 12 节）；网页用模型的体积优化（7.5）；扩展层"隐藏或替换"重建层的某件物体（`hides`，另行设计）；重建包里的方块化（清单版本 2）。

---

## 15. 复核意见处理

第一稿经两位复核者复核：**甲**（接口安全与迁移）16 条、**乙**（本地工具与通用性）15 条，另有几处文档小问题和对待定项的意见。问题全部采纳；只有一处选了复核者没推荐的方案（乙5），两处备选建议没有采用（乙8 的"命令行本地展开"、乙14 的 `modified` 字段），理由写在表里。

### 15.1 甲：接口安全与迁移

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| 甲1 | 高 | 预览链接会公开原始扫描、包清单和建模记录 | 采纳。草稿资源分成 `assets`（只放网页用模型、物件模型、贴图）和 `heldAssets`；预览只认前者；清理的"被引用"加上后者（2.8、第 5 节）；S3 验收加"预览令牌下载这些都是 404" |
| 甲2 | 高 | glb 的包围盒和坐标上限只看声明的 `min`/`max`，可以伪造 | 采纳。上传核对时流式读 `POSITION` 数据实测包围盒，与声明不符就拒绝，`check.bounds` 只记实测值（4.5 第 4 步）；网站加兜底摆放（第 9 节）；S2 样本加"声明与数据不符" |
| 甲3 | 高 | 新权限默认不生效，组织的任何 key 都能写重建层 | 采纳（选"单独失败即拒绝"并做得更彻底）：重建路径的写操作一律要求 `metaverse:rebuild:write`，不看总开关，也没有关掉它的配置；NyxID 配好之前只有种子能写（3.1、3.2）。同时采纳其余几项：重建要用的上传和任务查询都在 `/rebuild/` 下（2.3）；重建草稿只收重建包，没有内联的 `clearRebuilt`（2.3、3.3） |
| 甲4 | 中高 | 内存和 CPU 预算估低了 | 采纳。按种类分名额（核对 2、重任务 1）、每空间同时 1 个；带类型解析、记录逐条解析、数组设上限；glb JSON 上限按用途分（2/4/8 MiB）；种子打包一次只有一个成员；运行时至少 2 个工作线程，重计算进阻塞线程池，每 64 条操作让出一次；缓存调到 128 MiB、并发分片调到 4、内存上限调到 1536Mi；重算预算并列为上线前实测项（4.2、4.8） |
| 甲5 | 中 | `clearRebuilt` 叠加发布达不到整层替换 | 采纳。每个重建草稿登记 `layer:rebuilt`，与中途任何改过重建层的提交冲突（2.7）；S3 验收加 A 整体替换、B 合并新增的交错用例 |
| 甲6 | 中 | 跨层模板引用、共用编号空间让地块合作方能卡住重建层 | 采纳。模板只能被同一层引用；发布时在合并后的状态上查模板完整性；重建层新编号用保留前缀 `rb.`，扩展层不能用；锚点被抢占时在展开结果里列出（2.5）。线上没有跨层引用的旧数据，S1 用公开快照核对 |
| 甲7 | 中 | 资源种类按内容哈希全局唯一，别的空间可以抢先登记 | 采纳（与乙12 合并）。角色不再看第一次登记的 `kind`，而看服务端实测的 `check` 是否满足这个用途的上限，归属仍按空间（4.6）；种子遇到"已按别的用途登记"不算错（7.2） |
| 甲8 | 中 | 种子先插任务再下载，一次下载失败就永久占掉版本号 | 采纳。失败分类；`fetch` 类（含 403、404、408、429）按退避重试，用完后下次启动自动重新排队（7.2）；S4 验收加"第一次 404、重启后成功" |
| 甲9 | 中 | R2 退回 R1 不完全安全 | 采纳，并按乙10 调整上线方式：R1 并进 R2，前提是 NyxID 注册晚于 R2；回滚到 R0 只在还没写过新格式数据时允许，R3 之后只能前滚（11.2、11.5）。同时采纳几项通用修正：保存草稿改按字段 `$set`（2.8）；已下线种类的任务每轮清理都收（第 5 节）；走 R1 路线时处理服务的清理要认得新引用字段、回退前处理排队中的新任务（11.2、11.5） |
| 甲10 | 中 | 写回的栅栏没覆盖草稿写入 | 采纳。任务的所有写入（含中间的草稿保存）都在带租约条件的事务里；中止后重读草稿判断是否已做过；`bundle_import` 按 `bundleRef` 跳过展开，发布冲突自动重放（4.2、2.6、7.2）；S2 验收加僵尸执行器 |
| 甲11 | 中 | 轻量检查的其他漏项 | 全部采纳：扩展改白名单，拒收灯光和相机，对象级扩展也查；按用途限每个 glb 的贴图像素合计，贴图用途边长默认降到 4096；JPEG 跨数据块按段走，找不到 SOF 就拒绝；修正"不解压"的说法，gzip 放进阻塞线程池；zip 核对本地头，本地工具读 zip 自己设上限；R2 后台迁移给旧资源补 `check`，之后统一按 `check` 判断（4.4、4.5、4.6、8.3、11.4） |
| 甲12 | 中低 | `ifAbsent` 会让删掉的锚点复活 | 采纳。改名 `ifNew`，含义是"本空间时间线上从没出现过"（2.4）；6.7 和 11.5 改成准确的说法：回到第 3 版只恢复重建层和扫描，锚点另外处理 |
| 甲13 | 低 | 去掉了每个空间的并发上限 | 采纳。领取时排除已有运行中任务的空间，每空间同时 1 个（4.2） |
| 甲14 | 低 | 运维和兼容的小问题 | 全部采纳：`/api/healthz` 只返回就绪；旧格式种子记错误、跳过，服务照常启动，`check-app` 拦旧格式；`/uploads/authored` 也返回 410；`queued` 写进接口变更说明；OpenAPI 的旧说明和标签 `scans` 在 S4 删掉（2.1、2.2、7.1） |
| 甲15 | 低 | 实施顺序和上线前提对不上 | 采纳。前厅第 4 版从公开快照取变换和网页用模型（`pull --share`）；`pull --scan` 分段下载（8.5），经代理下载大文件列为实测项；S6a 改成依赖 S2，S2 同时改本地设施（13.1、13.3） |
| 甲16 | 低 | 演示包里的内部内容也公开了 | 采纳。写明种子包的一切都会公开；`bundle --seed` 去掉内部锚点和建模记录，`bundle check --seed` 给出警告（6.8）。`check-app` 是离线检查、不下载清单，所以警告放在 `bundle check` |
| 文档 | — | 9.4 的草稿范围没加重建；10.3 说成员能写入；6.1 没写复用要有 `check`；两类草稿"互不冲突"不准确；同一扫描重新打包时拍摄时间丢失 | 全部采纳：ARCHITECTURE 9.4、10.3、6.1 已改；2.7 改成"只在同一锚点编号上冲突"；`observedAt` 沿用最近一次带扫描的提交（2.7） |

甲对待定项的意见：重建 agent 默认不给发布——采纳，写进典型配置（3.4），不再待定；没有实体区时的范围——见乙5；410 保留一个版本——采纳。

### 15.2 乙：本地工具与通用性

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| 乙1 | 高 | `bundle push` 用推送时的最新 seq 当基础版本 | 采纳。清单加可选 `base: {spaceId, seq}`，由本地工具从工作区写入；命令行拿它当基础版本，空间不符就拒绝，没有 `base` 要显式 `--base latest`；种子不用 `base`（6.2、6.6、7.2） |
| 乙2 | 中 | 整体替换在并发和跨层模板引用下不成立 | 采纳（同甲5、甲6）。第一稿 2.3 的"追加后的整体检查"和 S3 对应的验收去掉，改成通用的模板完整性检查 |
| 乙3 | 中 | 第 4 版和回滚依赖的 `metaverse pull` 在注册前是 401 | 采纳。命令行加 `pull --share`（读公开快照）；`bundle --from-snapshot` 写进命令表；扫描哈希由来源表的成员按固定规则打包得到（7.3、8.3、8.5、S10） |
| 乙4 | 中 | 合并包重推不幂等；种子重做撞上"一个草稿只有一个包" | 采纳。`removeEntity` 加 `ifPresent`，展开时一律带上，向量加"合并包推两次"；种子按 `bundleRef` 跳过展开（2.4、6.4、7.2）；S4 验收加"在追加和发布之间重做" |
| 乙5 | 中 | 没有实体区时锚点谁也改不了；"扩展层优先"没有实现 | **采纳问题，方案另选**。复核者推荐"写重建层前必须先定义实体区"；本稿改为：没定义实体区时，实体区路径和重建路径都可以写"虚拟区和地块以外"的地方（2.5 第 6 条）。理由：这与网站现在的理解（"没有实体区时整个空间都算实体区"）一致；前厅不用先补定义区域（NyxID 注册前要靠种子才能改区域），网站的取景也不会因此变化；实体区草稿从此能改前厅的锚点。同时采纳另一个建议：展开结果列出"锚点漂移"，命令行提示人去挪（2.6）。"扩展层优先"从 ARCHITECTURE 4.2、6.3 删掉，`hides` 列为以后的增强（第 14 节） |
| 乙6 | 中 | 执行器的全局并发取消了"重任务每进程 1 个" | 采纳（同甲4）。按种类分名额，核对先领 |
| 乙7 | 中 | 有几步单独合并时编译不过或本地跑不起来 | 采纳。删旧接口和 `authored` 挪到 S4；S6a 依赖 S2，S2 同时让 `up.sh` 不再起处理服务；S2–S9 之间九步验收只跑第 1、8、9 步（13.3） |
| 乙8 | 中 | 清单校验、展开、glb 检查三边各写一份太重 | 采纳。展开只在 Rust；TypeScript 做结构检查和文件检查；Python 只在生成时守住上限并调用 `metaverse bundle check`；加二进制样本 `tests/vectors/check/`，Rust 和 TypeScript 都跑；上限由服务端经 `uploadLimits` 给出，写进 `limits.json`；清单格式和新操作在 S1 写进 SHAPES（6.5、13.2）。**没有采纳**"命令行本地展开成操作、服务端只认操作"：部署种子在服务端，Rust 反正要有展开；服务端展开才能让重建草稿只收包（甲3），并把包清单作为提交的出处保存下来 |
| 乙9 | 中 | 清单里混进了托管地址 | 采纳。清单只有相对路径、用途、sha256、大小；下载地址放在种子的来源表里，由配置按哈希固定；`zip` 成员写死"按数组顺序"打包，`demo_seed_zip.json` 由 Rust 和 Python 跑（TypeScript 不打包）（6.2、7.1） |
| 乙10 | 低 | R1 可能没必要；回滚时旧清理会删清单；旧格式种子让服务起不来 | 采纳。R1 并进 R2（附前提和例外，11.2）；回滚规则写明（11.5）；旧格式种子记错误、跳过 |
| 乙11 | 低 | 改名清单有遗漏 | 采纳。加 Dependabot、`env.py` 写死的目录名、`config.Config` 的解析上限搬到 `processing/limits.py`、重新生成 `uv.lock`；`processing` 不改名，只改外层包名和工作台 `recon` → `bench`；验收加"仓库外安装后跑 `doctor`"（8.1、8.2） |
| 乙12 | 低 | 资源只记一个全局 `kind` | 采纳（同甲7）。"同一份 glb 两种用途"写进 S3 验收 |
| 乙13 | 低 | 本地工具没有仓库外的安装方式，交接没定义 | 采纳。`uv tool install` 从仓库子目录安装、`doctor --install`；约定 `scan/transform.json`、`limits.json`、`out/recon/`、`out/bundle/` 和往上找 `space.json`（8.4） |
| 乙14 | 低 | 服务端不再核实外部模型的来源 | 采纳。SHAPES 3 和风险表写明署名是写入方的声明；改动说明改成不依赖工具的说法（第 9 节）。没有加 `modified` 字段：说明本来就写"可能经过调整"，加字段只是又一个自报值 |
| 乙15 | 低 | 锚点类型是固定枚举 | 采纳。写明锚点类型和模型库白名单属于通用词表，服务端保留，扩充按协议变更处理（1.3） |
| 小问题 | — | 写重建层要不要 `content:write`、上传要哪项权限；带地址的文件条目怎么查；旋转节点的包围盒偏大；zip64 规则要拿真实文件试；410 过渡期 | 重建路径（含上传）只要 `metaverse:rebuild:write`（3.1）；清单不再有地址，本地缺的文件由复用探测确认（6.1、6.6）；物件模型的导出要求节点用单位变换（4.5、SHAPES 3）；S2 验收拿真实的 Scaniverse 导出和 macOS 压缩的 zip 各试一次，`__MACOSX/` 忽略（4.4）；410 保留一个版本 |

乙对待定项的意见：没有实体区时的范围——见乙5；方块化二期不做的话从第一版清单里删干净——采纳，`putChunk` 和 `chunks` 参数都不定义（2.4）；改名同意但 `processing` 保持原名——采纳（8.1）。
