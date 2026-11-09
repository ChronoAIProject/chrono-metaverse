# 服务端瘦身：重建挪到本地，服务端只做存储和把关

> 状态：设计稿，可以照着实现。改造后的系统写在 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)（第四版）；本文讲清楚改什么、按什么顺序改、怎么从现在的线上状态迁过去。
>
> 依据：用户的决定——"重建都在本地，服务端只是存储"；"上传有鉴权，服务端要通用，服务端代码里不能有处理前厅的代码"。

## 0. 结论

| 决定 | 内容 | 理由 |
|---|---|---|
| 服务端只做通用的事 | NyxID 鉴权；存储（分片上传、哈希核对、按文件头的格式和上限检查）；时间线（提交、回放、分享链接、"现在"模式、事件）；写入校验（记录和形状符合 [`SHAPES.md`](../SHAPES.md)、引用的资源属于本空间、用途对得上） | 服务端不再含任何"某类场景怎么重建"的知识 |
| 重建全部在本地 | 对齐、网页用模型、结构和物体算法、AI 物件集组装、外部模型下载和重新导出、外链贴图下载、烘焙、逐件偏差、建议锚点、方块化，产出一个**重建包** | 调参和换算法不用发版；算力在本地，不需要显卡 |
| 处理服务整个下线 | 上传的哈希核对和轻量检查、过期清理、中断任务的回收，都并进接口服务的**后台执行器** | 少一个服务、少 3Gi 内存申请；任务状态和租约照旧存库 |
| 写重建层复用草稿 | 新路径范围 `rebuild`：`/api/v1/spaces/{space_id}/rebuild/drafts...`；新操作 `setScan`、`clearRebuilt`，重建层的 `placeEntity` / `removeEntity`，`createAnchor` 加 `ifAbsent`；重建包经现有的 `ops-from-upload` 提交 | 不另开一套写接口；NyxID 能按路径单独授权 |
| 新权限 | NyxID 操作范围按 `/rebuild/` 路径单独给；功能级权限 `metaverse:rebuild:write` | 只给组织管理员和指定的 agent key |
| 一个包 = 一次提交 | `manifest.json`（版本、生成工具、说明、扫描元数据、重建层记录、锚点、文件清单）+ 文件；文件按哈希复用；重复发布、内容没有变化时不写提交 | 幂等、可追溯，包里没有本地路径 |
| 演示种子导入重建包 | 配置指向一个按哈希固定的包；接口服务后台下载、核对、登记资源，走一遍和命令行相同的重建草稿发布 | 线上不再跑任何重建；第 1–3 版的提交原样保留 |
| 包文件放哪里 | 清单进本仓库、按提交哈希引用；大文件放本仓库的发布页 `demo-assets`，文件名就是 sha256；扫描原件继续用 Scaniverse 地址 | 不让 git 历史每版涨 17 MB 以上 |
| 本地工具改名 | `worker/` → `recon/`，包 `metaverse_worker` → `metaverse_recon`，只留命令 `metaverse-recon` | 名字和职责一致；用一次纯改名的提交完成，历史可追 |
| 上线分三次 | 先发"兼容读"版本，再发瘦身版本（同时去掉处理服务），最后换种子第 4 版 | 每一步都能退回上一步，线上数据一直能看、能回放 |

---

## 1. 现状与目标

### 1.1 现在服务端做的事

| 谁 | 做什么 | 代码 |
|---|---|---|
| 接口服务 | 鉴权、上传分片（第 0 片查文件头）、草稿和发布、时间线、公开读、事件、组合、管理；`ops-from-upload` 在进程内处理；部署种子下载扫描并建 `scan_import` 任务 | `api/crates/metaverse-api` |
| 接口服务 | 发起处理任务：`POST .../scans`、`.../scans/{scan_id}/alignment`、`/rebuild`、`/voxelize`、`POST .../models` | `routes/jobs.rs` |
| 处理服务 | 领取任务：`upload_verify`（流式哈希、嗅探格式、登记资源）、`scan_import`（对齐、网页用模型、结构和物体重建、建锚点、写提交）、`rebuild`、`voxelize`、`model_import`（重新导出物件模型）；AI 物件集写回（下载外部模型、烘焙、逐件偏差、结构贴图回退）；定期清理（过期上传、草稿、预览、没人引用的资源、补打 `publishedAt`、回收重试用完的任务） | `worker/src/metaverse_worker/` |

### 1.2 改造后

```
本地（人或 AI 的电脑，Mac 也行，不需要显卡）
  metaverse-recon：prepare / align / webmodel / 逐件重建 / assemble / bundle  →  重建包（manifest.json + 文件）
  metaverse（命令行）：bundle check / bundle push [--publish]  →  上传文件、建重建草稿、提交包、预览、发布
        │ NyxID 代理（身份令牌 + 操作范围）
        ▼
接口服务（唯一的后端服务）
  鉴权 · 分片上传 · 时间线 · 公开读 · 事件 · 组合 · 管理
  写入校验：形状词表、记录、资源归属和用途、路径范围
  后台执行器（进程内，租约存库）：upload_verify · ops_from_upload · bundle_import（部署种子）
  定期清理（进程内，带租约锁）
        │
        ▼
MongoDB（普通集合 + GridFS）
```

### 1.3 离开服务端的"场景知识"

下面这些都是对着前厅调出来的，改造后只在本地工具里，服务端一行都不留：

- `processing/fit_counter.py`（前台：折面外壳、台面、踢脚线）；
- `processing/objects.py` 的分类规则和阈值（椅子、桌子、沙发、前台……），`fit_segment.py`、`fit_templates.py`（同款合并成模板），`fit_texture.py`；
- `processing/structure.py` 的结构算法常量（墙顶统一高度、玻璃的颜色和竖梃、提示里的大屏不当墙……）；
- `jobs/writeback.py` 的锚点规则（按 `props.category` 建 `table`、`counter`、`zone`，椅子只在提示要求时建 `seat`）；
- AI 物件集写回里的结构贴图回退（`textureFallback`）、烘焙指令 `bake`、外部模型的 `model: {url, ...}` 写法；
- 接口服务里跟着这些走的东西：任务参数 `hints`（`MAX_HINTS_BYTES`）、`authored` / `authoredAsset`、核心库 `metaverse_core::authored`（物件集浅层校验）。

服务端认的只有通用词表：形状（SHAPES 2）、物件和锚点记录（SHAPES 3、设计 4.4）、署名许可的通用规则、资源格式和上限。

---

## 2. 接口变化

### 2.1 删除

| 删除 | 原来做什么 | 改成 |
|---|---|---|
| `POST /api/v1/spaces/{space_id}/scans`（`import_scan`） | 建 `scan_import` 任务 | 本地 `prepare` + `bundle`，命令行 `bundle push` |
| `POST .../scans/{scan_id}/alignment`（`align_scan`） | 按给定变换重新导入 | 本地 `align`，变换写进包的 `scan.transform` |
| `POST .../scans/{scan_id}/rebuild`（`rebuild_scan`） | 重跑重建或写 AI 物件集 | 本地 `bundle`，命令行 `bundle push` |
| `POST .../scans/{scan_id}/voxelize`（`voxelize_scan`） | 体素化 | 本地 `voxelize`（二期，见 6.4 末尾） |
| `POST .../models`、`POST .../plots/{plot_id}/models`（`import_model`、`import_plot_model`） | 重新导出物件模型 | 本地导出 glb，上传后接口服务核对，直接引用（4.3） |
| 上传用途 `authored` | AI 物件集 JSON | 物件集只在本地；交给服务端的是重建包（用途 `bundle`） |
| 任务种类 `scan_import`、`align`、`rebuild`、`voxelize`、`web_model`、`model_import` | 处理服务执行 | 不再新建；已有记录只读，留作历史 |
| 请求字段 `hints`、`authored`、`authoredAsset`；核心库 `metaverse_core::authored` | — | 删除 |

删掉的五个路由在瘦身版里先保留一版，统一返回 410 `endpoint_retired`（说明改用重建包，指向本文），不写进 OpenAPI；下一版再删掉路由本身。这样旧版命令行拿到的是能看懂的错误，而不是 404。

### 2.2 保留（含小改）

| 接口 | 变化 |
|---|---|
| 分片上传（创建、传片、完成、查询；实体区和地块两组路径） | 用途改为 `scan`、`webmodel`、`model`、`texture`、`ops`、`script`、`bundle`；`model` 只收 glb；"完成"仍返回 202 和 `upload_verify` 任务编号，只是由接口服务自己执行（第 4 节）；查询结果多一项 `check`（核对出的三角形数、贴图尺寸等） |
| 实体区、地块草稿全套 | 不变；`createAnchor` 多一个可选的 `ifAbsent`；`ops-from-upload` 在重建草稿里还接受重建包（2.4） |
| 时间线、快照、区域内容、资源和区块下载（`/api/v1`） | 快照的内部投影多 `scan.alignment` |
| 公开读接口 | 不变 |
| 事件、更正、事件类型、组合、管理接口 | 不变 |
| `GET .../jobs`、`GET .../jobs/{job_id}`（实体区和地块） | 保留：现在的种类是 `upload_verify`、`ops_from_upload`、`bundle_import`；旧种类的记录照样能查 |

### 2.3 新增：重建草稿

#### 路径

与实体区草稿一一对应，路径范围记作 `rebuild`（核心库 `PathScope::Rebuild`）：

| 方法与路径 | `operationId` |
|---|---|
| `POST /api/v1/spaces/{space_id}/rebuild/drafts` | `create_rebuild_draft` |
| `GET .../rebuild/drafts/{draft_id}` | `get_rebuild_draft` |
| `POST .../rebuild/drafts/{draft_id}/ops` | `append_rebuild_draft_ops` |
| `POST .../rebuild/drafts/{draft_id}/ops-from-upload` | `rebuild_draft_ops_from_upload` |
| `POST .../rebuild/drafts/{draft_id}/preview` | `create_rebuild_draft_preview` |
| `POST .../rebuild/drafts/{draft_id}/publish` | `publish_rebuild_draft` |
| `DELETE .../rebuild/drafts/{draft_id}` | `discard_rebuild_draft` |

请求体、返回、上限（每批 ≤ 200 条、请求体 ≤ 1MB、一个草稿 ≤ 10 万条操作、≤ 20 个操作文件）都与实体区草稿相同。草稿属于创建时的范围：重建草稿只能经 `/rebuild/` 路径操作，经别的路径一律 404（现有规则）。这组接口写进注册给 NyxID 的 OpenAPI。

#### 允许的操作

| 操作 | 实体区 / 地块草稿 | 重建草稿 |
|---|---|---|
| `fill`、`hollowBox`、`replace`、`copyRegion`、`addBlock` | 可以（只写扩展层） | 不可以（二期方块化另加 `putChunk`，见 6.4 末尾） |
| `placeEntity`、`removeEntity` | 只能是扩展层物件（现有规则） | 只能是重建层物件（`layer: "rebuilt"`，`kind` 是 `structure`、`object` 或 `template`） |
| `setScan`、`clearRebuilt`（新） | 不可以 | 可以 |
| `createAnchor` | 可以 | 可以 |
| `moveAnchor`、`updateAnchor`、`removeAnchor` | 可以 | 不可以（改锚点走实体区草稿） |

不允许的操作整批拒绝，422 `op_not_allowed`，说明里写第几条、为什么。

#### 新操作

**`setScan`**：设置这次提交的扫描层。

```json
{ "op": "setScan",
  "scan": { "assetHash": "<扫描资源>", "webModelHashes": ["<默认档>", "<低细节档>"],
            "transform": [16 个数，列主序，扫描坐标 → 空间坐标],
            "alignment": { "method": "auto", "rotationDeg": -61.42, "errorCm": 0.8 } },
  "observedAt": "2026-10-20T00:00:00.000Z" }
```

- `assetHash`：本空间资源种类为 `scan` 的资源；
- `webModelHashes`：1 到 2 个、不重复，种类为 `web_model`（[0] 是网站加载的那一档）；
- `transform`：规则就是现在 `routes/jobs.rs` 的 `check_transform`（16 个有限数、最后一行 `0 0 0 1`、行列式 > 1e-6 不镜像、平移绝对值 ≤ 100000 米），移到核心库 `model::check_transform`；
- `alignment`：可选，任意 JSON 对象，规范化后 ≤ 4KB，原样存进提交的 `scan.alignment`，只在 `/api/v1` 的快照里返回（公开快照仍只给网页用模型和变换）；服务端不解释它；
- `observedAt`：可选，发布请求没给 `observedAt` 时用它；
- 一个草稿最多一次 `setScan`，第二次 422。草稿的 `touched.scan` 记为 true。

**`clearRebuilt`**：`{"op": "clearRebuilt"}`。把工作状态里重建层的全部物件（结构、物体、模板）删掉，扩展层不动，锚点不动。被删的编号都记进 `touched.entities`。之后的 `placeEntity` 再把新的重建层放进去，所以"`clearRebuilt` + 全部物件"就是"重建层整体换成这一份"；发布时按与基准的差异算 `changedEntities`，内容没变的物件不会出现在提交里。二期加 `"chunks": true`：同时清掉重建层的区块。

**重建层的 `placeEntity` / `removeEntity`**：`placeEntity` 的 `entity.layer` 必须是 `rebuilt`；编号已经是扩展层物件时 422（物件和模板共用一个编号空间）；`removeEntity` 只能删重建层的物件，模板仍被引用时不能删（现有规则）。物件 body 按 `EntityBody::validate` 完整校验（形状、包围盒、`fit`、`props.source` 署名、模板引用），与现在草稿里的扩展层物件同一套。

**`createAnchor` 的 `ifAbsent`**（所有草稿都能用）：`{"op": "createAnchor", "anchor": {...}, "ifAbsent": true}`。同编号的锚点已经存在就什么都不做，也不记进 `touched`；不写或写 false 时与现在相同（已存在 422）。重建包里的锚点一律带 `ifAbsent: true`："只建不改"，与现在 `scan_import` 的锚点规则一致。

#### 范围检查

重建草稿的允许范围（`AllowedArea::for_scope(Rebuild)`）：

- 空间定义了实体区（`regions` 里 `kind: physical`）：每个重建层物件和新建锚点的影响范围都必须落在实体区的盒子里（与实体区草稿相同）；
- 还没有实体区：不能与任何虚拟区或地块的盒子相交，其余位置不限（前厅现在就没有定义区域，这样与现在的导入行为一致）；
- `setScan`、`clearRebuilt` 没有几何范围，只经重建路径允许。

发布时按最新的区域和地块重新检查（现有规则），越界 409 `out_of_scope`。

#### 资源检查

追加操作时，每个引用的哈希都要过两关：属于本空间（现有的 `Foreign` 规则：本空间上传过、登记过或提交引用过），以及资源种类与用途对得上（扩展 `repo/blobs.rs` 的 `AssetRole`）：

| 引用的地方 | 角色 | 资源种类（`metadata.kind`） | 另外要求 |
|---|---|---|---|
| `setScan.scan.assetHash` | `Scan`（新） | `scan` | — |
| `setScan.scan.webModelHashes[]` | `WebModel`（新） | `web_model` | 接口服务核对过（`metadata.check`），或者是处理服务以前生成的 |
| 物件的 `assetHash`、事件显示的 `entityAsset` | `Model` | `model` | 接口服务核对过的 glb（`metadata.check.format = glb`），或者是处理服务以前重新导出的（带 `sourceHash`，旧数据）；只上传过、没核对过的旧上传不行 |
| 形状材质的 `texture`、`normalMap`、`roughnessMap`，物件的 `textures`，方块贴图 | `Texture` | `texture` | — |

通过后先过清理的栅栏（刷新 `touchedAt`），哈希记进草稿的 `assets`；发布时在提交事务里再确认一次（现有规则，缺了 409 `asset_gone`）。

**模型和记录要一致**（新，所有草稿）：引用的模型带 `metadata.check.bounds` 时，物件 `bounds` 的三边长与模型包围盒的三边长之差不超过 max(2 厘米, 1%)，模型的原点在底面中心（`|min.y|`、x 和 z 的中点都 ≤ 2 厘米）；否则 422 `model_bounds_mismatch`。网站按 `bounds` 的底面中心摆放只有模型的物件，这条保证摆出来和记录一致。旧的处理后模型没有 `check`，不查。

#### 追加后的整体检查

每次追加（内联一批、一个操作文件、一个重建包）全部作用完之后，再查一遍工作状态：所有物件引用的模板都存在。扩展层物件引用了重建层的模板时，`clearRebuilt` 之后包里必须再放一个同编号的模板，否则整批不生效（422，列出断了的引用）。

#### 发布

发布接口、冲突判断、`replay`、`rev`、`message`、`observedAt`、`scriptRef` 都与实体区草稿相同。不同的地方：

- **提交内容**：`actor = {sub, nyxServiceId, scope: "rebuild", kind: "rebuild"}`；`scan` 取草稿的 `setScan`（没有就不写，回放沿用上一次）——`CommitPlan` 要加 `scan`，关键帧的状态清单也要带上扫描（`timeline/writer.rs` 的 `manifest_after` 现在不管扫描，因为接口服务以前从不写扫描）；`bundleRef` 取草稿的 `bundleRef`（2.4）；`observedAt` 先取请求的，再取 `setScan` 的；`scriptRef` 先取请求的，再取包清单的 `notes`。
- **资源引用 `assetRefs`**：网页用模型、物件模型、贴图登记进 `assetRefs`（公开资源接口的白名单）；原始扫描、包清单、脚本不登记，只被提交引用，所以不会被清理，也不会公开。
- **坐标系**：提交带 `scan`、而空间还没有 `frame` 时，在提交事务里按 `{_id, frame: 不存在}` 条件写 `frame = {fixedAt: 提交的 at, referenceScan: scan.assetHash}`（与处理服务现在的写法相同）。
- **冲突**：重建草稿的 `touched` 是它碰过的重建层编号、新建的锚点、`scan`。(baseSeq, head] 之间的提交改了同样的编号或带了 `scan`，就是冲突（键 `entity:<编号>`、`anchor:<编号>`、`scan`）。实体区草稿只改扩展层，两者的编号不重叠，互不冲突。
- **没有变化就不提交**（只对重建草稿）：算出的 `changedEntities`、`changedAnchors`、`changedChunks` 都是空，`scan` 与最新版本相同（或没有 `setScan`），方块表没变——不写提交，草稿照样标记为已发布，记 `unchanged: true`，返回 200 `{unchanged: true, seq: <最新 seq>}`。同一个草稿再发布还是这个结果。
- **事务**：与现在的提交事务相同（插入提交、推进 `head`、物件和锚点当前状态、`assetRefs`、资源栅栏），另加 `frame` 的条件写入；由后台任务发布时（部署种子），再加任务状态的条件更新（`{_id, attempt, leaseOwner, status: running}` → `done`、`resultCommitId`），提交带 `jobId`（`commits.jobId` 已有部分唯一索引）。

#### 预览

重建草稿的预览与实体区草稿相同，另外：草稿有 `setScan` 时，预览快照的 `scan` 用草稿的（"原始"视图看的是新的网页用模型），草稿的 `assets` 里有网页用模型，所以预览资源接口能读到它。

### 2.4 重建包经 `ops-from-upload` 提交

不新开接口。`POST .../rebuild/drafts/{draft_id}/ops-from-upload` 的请求体仍是 `{uploadId}` 或 `{assetHash}`；服务端按资源种类分流：`ops` 照旧解析 NDJSON；`bundle`（用途 `bundle` 上传、核对通过的清单）按下面处理。实体区和地块草稿收到 `bundle` 返回 422 `bundle_not_allowed`。

后台任务（种类仍是 `ops_from_upload`，参数多 `"source": "bundle"`）：

1. 读清单（≤ 16 MiB），按 6.3 完整校验结构，不合格任务失败（说明写到具体字段）；
2. 清单 `files` 里的每个文件：本空间必须已有这个哈希、种类与用途对得上、长度等于 `size`；缺的列出前 20 个，任务失败（"这些文件还没上传或不属于本空间"）。记录里引用、但不在 `files` 里的哈希，按 2.3 的资源检查（本空间已有就行）；
3. 按 6.4 的固定规则把清单展开成操作；
4. 展开的操作写成规范的 NDJSON，按内容哈希登记成本空间的 `ops` 资源（已有就复用），作为一个操作文件追加进草稿（`opsRefs` 记 `{assetHash, count, source: <清单哈希>, jobId}`）——之后的预览、发布、冲突、重放都走现有的操作文件路径，不需要再改；
5. 草稿记 `bundleRef = 清单哈希`，清单哈希和全部引用的资源都记进 `assets`；清单的 `note`、`notes` 记成发布时默认的提交说明和 `scriptRef`（发布请求给了就用请求的）。一个草稿只能有一个包（第二个 409 `bundle_already_applied`）；包后面还可以追加内联操作。

清单、包里的文件和 `ops` 文件都经实体区路径上传（上传会话的范围是 `physical`，设计 6.1）；重建草稿认本空间实体区范围的上传，地块范围的上传不认。

### 2.5 核心库的数据结构

| 位置 | 变化 |
|---|---|
| `scope::PathScope` | 加 `Rebuild`，存储写 `rebuild` |
| `scope::UploadPurpose`、`model::UploadFormat` | 加用途 `WebModel`（路径里写 `webmodel`）、`Bundle`；`Authored` 只留着读旧记录；`bundle` 用途的格式是已有的 `Json`。地块路径只能上传 `model`、`texture`、`ops`、`script` |
| `model::ActorKind` | 加 `Rebuild`；`Job` 留给旧提交和后台任务 |
| `model::JobKind` | 加 `BundleImport`；旧种类留着反序列化 |
| `model::ScanRef` | 加可选 `alignment`（JSON 对象） |
| `model::Commit` | 加可选 `bundle_ref` |
| `model::Touched` | 加 `scan: bool` |
| `ops::Op` | 加 `SetScan`、`ClearRebuilt`；`CreateAnchor` 加 `if_absent`；`WorkingState` 带上"本草稿的范围"，按 2.3 的表决定哪些操作可用、`placeEntity` 写哪一层 |
| `bundle`（新模块） | 清单的类型、解析、校验（6.3）、展开成操作（6.4） |
| `authored` | 删除 |

TypeScript（`sdk/typescript/src/core/`）和本地工具（Python）各实现一份同样的规则，用新增的测试向量核对（`tests/vectors/ops/` 加新操作，`tests/vectors/bundle/` 放清单的合法、不合法写法和展开结果）。

---

## 3. 权限

### 3.1 三层，与设计第 9 节相同

1. **NyxID 操作范围**（agent key 在转发前就被拦下）：重建是一组单独的路径 `/api/v1/spaces/{space_id}/rebuild/...`，可以单独授给某把 key、钉死 `space_id`。上传仍走实体区路径 `/api/v1/spaces/{space_id}/uploads/{purpose}`，用途是路径参数，可以限定成 `scan`、`webmodel`、`model`、`texture`、`script`、`bundle`。
2. **服务端访问级别**（9.2 的表不变）：重建路径和实体区路径一样要求"管理"级别——个人空间的主人本人，组织空间的组织本身（组织的 agent key）或组织 admin。组织 member、viewer 只读。
3. **功能级权限**（可选，`METAVERSE_REQUIRE_PERMISSIONS=true` 时生效）：新增 `metaverse:rebuild:write` → `Capability::WriteRebuild`，重建路径的写操作要求它（实体区、地块草稿仍只要 `metaverse:content:write`）。精确匹配，不认前缀通配。

人的登录态不受操作范围约束，所以组织 admin 本人能写重建层；agent 一律用自己的 key，"谁能写重建层"由人在 NyxID 里决定给哪几把 key 开 `/rebuild/` 路径。

### 3.2 典型配置（加进设计 9.3 的表）

| agent | key 的主人 | 操作范围 |
|---|---|---|
| 本地重建（重建工具 + 命令行） | 店方组织 | 查看接口；`POST/PUT/GET /spaces/restaurant/uploads/{purpose}…`（`purpose` 限 `scan`、`webmodel`、`model`、`texture`、`script`、`bundle`）；`/spaces/restaurant/rebuild/drafts` 下的建草稿、追加、`ops-from-upload`、预览；`GET .../jobs/{job_id}`；**发布**按店方习惯决定：默认不给，人看过预览链接后自己发布 |
| AI 装修（实体区） | 店方 | 不变；**不含** `/rebuild/` 路径，所以动不了重建层 |
| 地块合作方 | 店方组织 | 不变；地块路径不能上传扫描、网页用模型和重建包 |

### 3.3 部署种子

种子没有调用者，用授权层签发的显式系统范围（`Authorizer::seed_space`，写审计日志）：在这个范围里建重建草稿、展开包、发布，`actor = {sub: "system:demo-seed", nyxServiceId: "", scope: "rebuild", kind: "rebuild"}`。依据和限制与现在相同（9.2"部署配置种子是运维行为"）：只碰自己建的空间。NyxID 服务注册完成之前，线上只能这样写入；注册之后也可以用命令行直接发布包。

---

## 4. 上传核对挪进接口服务

### 4.1 流程

创建、传片、完成的接口和语义都不变（设计 6.1）：完成时全部分片到齐 → 上传改成 `complete`、建 `upload_verify` 任务、返回 202 和任务编号；调用方照旧用 `GET .../jobs/{job_id}` 或 `GET .../uploads/{purpose}/{upload_id}` 等结果。变的只是谁来执行：

- 完成上传后，接口服务通知本进程的后台执行器立即开始（进程内通知，不等轮询）；
- 1GB 的扫描不能在请求里同步算完：核对一律在后台做，状态全在库里（`uploads.status`、`jobs`），进程重启、换副本后照样接着做。

### 4.2 后台执行器

接口服务进程里一个常驻的异步循环（`api/crates/metaverse-api/src/runner/`），执行三种任务：`upload_verify`、`ops_from_upload`、`bundle_import`。规则就是设计 6.4 的租约，从处理服务的 `jobs/lease.py`、`jobs/writeback.py` 照搬到 Rust：

- **领取**：一次 `findOneAndUpdate` 原子领取——种类在上面三种里，并且状态是 `queued`（`notBefore` 不存在或已到），或状态是 `running`、租约已过期、`attempt < maxAttempts`；按 `createdAt` 先后；同时写 `status = running`、`leaseOwner = 本进程编号`、`leaseUntil = 现在 + RUNNER_LEASE_SECONDS`、第一次领取时写 `startedAt`，`attempt` 加 1。时间字段的写法与现有任务文档相同。
- **续约**：每 `RUNNER_HEARTBEAT_SECONDS` 秒按 `{_id, leaseOwner, attempt, status: running}` 续一次；匹配不到说明租约丢了，立刻取消这个任务，不写回任何结果。
- **写回**：结果和"任务完成"在同一个事务里，条件同上；匹配数为 0 就中止事务、丢弃结果。
- **重试**：不可重试的失败（内容不合规、哈希不符、参数不合法）直接 `failed`；可重试的（数据库抖动、下载 5xx、网络错误）按 `{status: queued, notBefore: 现在 + 30 秒 × 2^(attempt−1)}` 退回队列；`attempt` 用完由清理第 0 步标记 `failed`。
- **并发**：本进程同时最多 `RUNNER_MAX_CONCURRENT` 个任务（默认 2）；每个空间排队和运行中的任务数仍受 `JOB_MAX_PENDING_PER_SPACE` 限制（创建时 429）。
- **停止**：收到停止信号后不再领取；手上的任务等最多 20 秒，做不完就按栅栏把它退回 `queued` 并把 `attempt` 减 1（与处理服务现在的做法相同），新进程马上能接着做。进程被直接杀掉时，租约 3 分钟后过期，下一个进程重新领取。
- **单副本和多副本**：每个进程有自己的编号（`METAVERSE_INSTANCE_ID`，默认"主机名-进程号-随机数"）。领取是原子的，写回带栅栏，所以多副本、滚动更新时新旧副本同时运行，同一个任务也只会被一个进程写回成功。现在线上是 1 个副本，以后加副本不用改代码。
- **空间实例**：接口服务删除空间时不清理任务和上传，同一个编号可能被重建。执行器读写 `spaces` 时，除了主人，还要求空间的 `createdAt` 不晚于任务或上传的 `createdAt`（照搬处理服务 `store.space_filter`）；对不上的任务直接失败，上传标记 `failed`，不登记、不计用量。
- **健康检查**：`/api/healthz` 不因执行器出错而失败（否则整个接口服务会被重启）；执行器循环异常退出时记错误日志并在 5 秒后重启循环；`/api/healthz` 的响应里多一项 `background: {runner: {running, lastClaimAt}, cleanup: {lastRunAt, ...}}` 方便排查。
- **数据访问**：执行器和清理都通过 `repo/` 的方法、用显式系统范围读写，写审计日志（设计 9.4，持续集成的数据访问边界检查照旧）。

**`upload_verify` 的步骤**（与处理服务现在的 `handlers/upload_verify.py` 对应）：

1. 上传已是 `done`：直接完成；不是 `complete`：失败；空间实例对不上：上传 `failed`、任务失败；
2. 按序号流式读出全部数据块（`assets.chunks`，`files_id` = 上传编号，按 `n` 升序，`(files_id, n)` 是 GridFS 的标准索引），核对序号连续、除最后一块外每块 256KiB、总长度等于声明的大小，边读边算 sha256，同时把字节交给这个用途的检查器（4.3）；哈希计算放进阻塞线程池（每批几 MB），不占异步线程。内存只有一批数据块加上检查器要留的东西（4.4），1GB 的扫描也只有几 MB；
3. 哈希相符后写 `uploads.verifiedSha256`；不符或检查不通过：上传 `failed`、写原因、删数据块，任务失败（不可重试）；
4. 登记资源：插入 GridFS `files` 文档（`_id` = 上传编号，`filename` = 内容哈希，`metadata = {sha256, contentType, kind, spaceId, uploadId, format, touchedAt, check}`）。文件名唯一键冲突说明同一内容已存在：删本次的数据块、复用已有资源（先刷新它的 `touchedAt`；已有资源缺 `check` 而这个用途需要时，按条件补写 `metadata.check`）；
5. 同一个事务里：上传 `done` 并写 `assetHash`、`format`、`storageBytes`，空间 `storageUsedBytes` 加上大小，任务完成。

任务最终失败、上传停在 `complete` 时的收尾（`settle_upload`：内容已核对通过且资源存在就补做第 5 步，否则 `failed` 并删数据块）照搬，由执行器在标记失败后立即做，清理第 1 步兜底。

### 4.3 各用途的轻量检查

只读文件头、glb 的 JSON 块和图片头；不解码网格、不解码图片、不解压任何东西，所以不怕解压炸弹，也不需要子进程。

| 用途 | 接受的格式 | 大小上限 | 检查 | 资源种类、`check` |
|---|---|---|---|---|
| `scan` | glb、drc、obj、zip | `UPLOAD_MAX_SCAN_BYTES`（1 GiB） | glb：头和 JSON 块（4.4，只查结构和外部引用，不限三角形数）；drc：`DRACO` 魔数、版本、编码类型是网格；obj：文本、首个关键字；zip：读文件末尾的中央目录（≤ 1 MiB、≤ 64 个成员），成员名不能是绝对路径、不能含 `..`、不能加密、不用 zip64，压缩方式只能是存储或 deflate，正好一个网格成员（glb、drc、obj），其余是 jpg、png、mtl | `scan`；`check = {format, members?}` |
| `webmodel`（新） | glb | `UPLOAD_MAX_WEBMODEL_BYTES`（64 MiB） | glb 完整的轻量检查（4.4）；三角形 ≤ `UPLOAD_WEBMODEL_MAX_TRIANGLES`（50 万；现在默认档是 30 万）、贴图边长 ≤ `UPLOAD_WEBMODEL_MAX_TEXTURE_SIDE`（4096）、坐标绝对值 ≤ 100000 米（网页用模型保持扫描原坐标，与形状坐标上限相同） | `web_model`；`check` 见 4.4 |
| `model` | glb（不再收 drc、obj、zip：服务端不再重新导出，网站只加载 glb） | `UPLOAD_MAX_MODEL_BYTES`（50 MiB） | glb 完整的轻量检查；三角形 ≤ `UPLOAD_MODEL_MAX_TRIANGLES`（10 万）、贴图边长 ≤ `UPLOAD_MODEL_MAX_TEXTURE_SIDE`（2048）、坐标绝对值 ≤ 1000 米；记下包围盒 | `model`；`check` 见 4.4 |
| `texture` | png、jpeg、webp | `UPLOAD_MAX_TEXTURE_BYTES`（50 MiB） | 魔数与格式一致；读图片头拿宽高：边长 ≤ `UPLOAD_MAX_TEXTURE_SIDE`（8192），像素数 ≤ `UPLOAD_MAX_TEXTURE_PIXELS`（8192²） | `texture`；`check = {format, width, height}` |
| `ops` | NDJSON，可 gzip | `UPLOAD_MAX_OPS_BYTES`（64 MiB） | 流式解压，解压后 ≤ 256 MiB；每行 ≤ 64 KiB、UTF-8、去掉空白后以 `{` 开头（完整解析在追加时做） | `ops` |
| `script` | UTF-8 文本 | `UPLOAD_MAX_SCRIPT_BYTES`（4 MiB） | 流式 UTF-8 校验（跨数据块的多字节字符要接上），不含 NUL | `script` |
| `bundle`（新） | JSON | `UPLOAD_MAX_BUNDLE_BYTES`（16 MiB） | 整份读入解析成 JSON 对象，`format`、`version` 对得上，`files` 是数组（完整校验在追加进草稿时做） | `bundle` |

第 0 片的文件头检查（`ingest/formats.rs`）保留，作为提前拒绝；后台检查用同一批函数，再加上面的细则。

**复用和核对结果**：创建上传时"本空间已有同一用途的这个哈希，直接复用"，只在已有资源带着这个用途需要的 `check`（`webmodel`、`model`、`texture`）时成立；处理服务以前登记、没有 `check` 的同哈希资源不算，照常要求完整上传，核对通过、登记时撞上同名资源，就按条件给它补写 `metadata.check`（4.2 第 4 步）。

### 4.4 glb 检查细则

glb 的头和 JSON 块都在文件开头，图片在 BIN 块里的位置由 JSON 算出来，所以整个检查跟着哈希的流式读取一次做完：

1. **头**：魔数 `glTF`、版本 2、头里的总长度等于文件大小；第一个块是 JSON（长度 ≤ 8 MiB），第二个块（可选）是 `BIN`，没有别的块；
2. **JSON**：`asset.version` 是 `"2.0"`；
   - `buffers` 至多 1 个，不能有 `uri`（就是 BIN 块），`byteLength` ≤ BIN 块长度；
   - `images` 只能用 `bufferView` + `mimeType`（`image/png` 或 `image/jpeg`），**不能有 `uri`**（外部地址和 `data:` 都不收）；
   - `bufferViews` 的范围在 BIN 块里；`accessors` 的范围在各自的 `bufferView` 里，不收稀疏访问器；
   - 网格的图元只收三角形（`mode` 不写或为 4），`POSITION` 必须有 `min`、`max`（glTF 本身就要求），都是有限数；
   - 不收骨骼（`skins`）、动画（`animations`）、变形目标（`targets`）；
   - `extensionsRequired` 只能是 `KHR_texture_transform`、`KHR_mesh_quantization`；`extensionsUsed` 里出现 `KHR_draco_mesh_compression`、`EXT_meshopt_compression`、`KHR_texture_basisu`、`EXT_texture_webp` 时拒绝（网站没有这些解码器；以后网站支持了再放开，见 7.5）；
   - 数量上限：节点 ≤ 10000、网格 ≤ 1000、材质 ≤ 256、图片 ≤ 64；
3. **三角形数和包围盒**：从场景（`scene`，没写就是 0）的根节点往下走，节点不能成环、不能有两个父节点；每个引用网格的节点，三角形数 =（有 `indices` 时是它的 `count`，否则是 `POSITION` 的 `count`）/ 3，必须是整数；同一个网格被几个节点引用就算几次；包围盒 = 各图元 `POSITION` 的 `min`、`max` 八个角点经节点的世界变换后取外包；
4. **图片头**：按 JSON 算出每张图片在文件里的绝对位置，流式读取时截下每张图的前 64 KiB，读 PNG 的 IHDR、JPEG 的 SOF 拿宽高，魔数必须与 `mimeType` 一致；边长、像素数按用途的上限查；
5. **记下**：`metadata.check = {v: 1, format: "glb", triangles, nodes, meshes, materials, images: [{w, h, mime}], maxTextureSide, bounds: {min, max}}`。

### 4.5 资源登记与存储用量

规则简化成一条："GridFS 里的每一份资源都由一次上传产生，在核对通过时计入空间用量，在被清理时减回"——上传会话文档带 `storageBytes`，清理时成对减回（处理服务现在的规则）。重建包里的文件、种子下载的文件都走上传这条路（种子用系统身份建上传会话，见 7.2），不再有"处理服务派生资源单独计量"的情况。接口服务自己生成的资源（发布时合并的操作文件、2.4 里由包展开的操作文件）按现在发布草稿合并操作文件的规则在提交事务里计入。旧数据里处理服务派生资源和 `model_import` 的计量记录保留，清理时照旧减回。

### 4.6 配置项对照

| 处理服务（删除） | 接口服务（新的或已有的） | 默认 |
|---|---|---|
| `WORKER_LEASE_SECONDS` | `RUNNER_LEASE_SECONDS` | 180 |
| `WORKER_HEARTBEAT_SECONDS` | `RUNNER_HEARTBEAT_SECONDS` | 45 |
| `WORKER_POLL_SECONDS` | `RUNNER_POLL_SECONDS`（另有完成上传时的进程内通知） | 2 |
| `WORKER_STOP_GRACE_SECONDS` | 固定 20 秒（平台终止宽限 30 秒） | — |
| `WORKER_MAX_JOBS_PER_SPACE` | 不需要（全进程 `RUNNER_MAX_CONCURRENT`，每空间排队上限 `JOB_MAX_PENDING_PER_SPACE`） | — |
| `WORKER_ID` | `METAVERSE_INSTANCE_ID` | 主机名-进程号-随机数 |
| `WORKER_CLEANUP_INTERVAL_SECONDS` | `CLEANUP_INTERVAL_SECONDS` | 600 |
| `WORKER_UPLOAD_TTL_HOURS` | 核心库常量 `UPLOAD_TTL_SECONDS`（接口服务已经用它算 `expiresAt`） | 24 小时 |
| `WORKER_ASSET_GRACE_DAYS` | `CLEANUP_ASSET_GRACE_DAYS` | 7 |
| `WORKER_MAX_SCAN_BYTES`、`WORKER_MAX_MODEL_BYTES` | 已有 `UPLOAD_MAX_SCAN_BYTES`、`UPLOAD_MAX_MODEL_BYTES` | 1 GiB、50 MiB |
| `WORKER_MAX_TEXTURE_PIXELS` | `UPLOAD_MAX_TEXTURE_PIXELS` | 8192² |
| `WORKER_MAX_TEXTURE_SIDE` | 已有 `UPLOAD_MAX_TEXTURE_SIDE` | 8192 |
| `WORKER_MODEL_MAX_TRIANGLES` | `UPLOAD_MODEL_MAX_TRIANGLES`（含义从"重新导出的上限"变成"接受的上限"） | 10 万 |
| `WORKER_MODEL_MAX_TEXTURE_SIDE` | `UPLOAD_MODEL_MAX_TEXTURE_SIDE` | 2048 |
| `WORKER_MAX_OPS_BYTES` | 接口服务已有的常量（解压后 256 MiB） | — |
| — | `UPLOAD_MAX_WEBMODEL_BYTES`、`UPLOAD_WEBMODEL_MAX_TRIANGLES`、`UPLOAD_WEBMODEL_MAX_TEXTURE_SIDE`、`UPLOAD_MAX_BUNDLE_BYTES` | 64 MiB、50 万、4096、16 MiB |
| — | `RUNNER_MAX_CONCURRENT` | 2 |
| `WORKER_MAX_TRIANGLES`、`WORKER_MAX_GRID_CELLS`、`WORKER_JOB_MEMORY_MB`、`WORKER_JOB_TIMEOUT_SECONDS`、`WORKER_ALIGN_MAX_ERROR_CM`、`WORKER_ALIGN_HOLD_DAYS`、线程数变量 | 服务端不再解析网格，删除；对齐误差阈值进本地工具 `align` 的参数 | — |
| `WORKER_MODEL_HOSTS` | 本地工具的 `METAVERSE_RECON_MODEL_HOSTS`（已有） | — |
| `UPLOAD_MODEL_FORMATS` | 保留，但只允许 `glb` | `glb` |

### 4.7 `ops_from_upload` 进执行器

现在它在请求里 `tokio::spawn`，租约 30 分钟，进程中途退出时由处理服务回收成失败。改成：请求只插入 `queued` 的任务并通知执行器，返回 202（接口不变）；执行器按 4.2 领取。为了能安全重做：追加操作按草稿的 `rev` 条件写入，`opsRefs` 里记 `jobId`；重做时发现草稿里已经有这个 `jobId` 的操作文件，就直接把任务标记完成。

---

## 5. 过期清理挪进接口服务

接口服务进程里另一个常驻循环，每 `CLEANUP_INTERVAL_SECONDS` 秒一轮，步骤和规则照搬处理服务的 `jobs/cleanup.py`：

0. **重试次数用完的任务**：租约过期且 `attempt ≥ maxAttempts` 的标记 `failed`；`upload_verify` 接着收尾上传（4.2）。`ops_from_upload` 的任务也在这里回收（原来处理服务回收）；
1. **上传会话**：停在 `complete`、校验任务已失败（或任务记录不存在且完成超过 24 小时）的，按 4.2 收尾；超过 24 小时仍 `open` 的先改成 `expired`，再删数据块和会话；`failed`、`expired` 的同样删除；
2. **草稿、草稿区块、预览令牌**：按 `expiresAt < 现在` 删除；过期草稿先删草稿本身，再删它的预览令牌和草稿区块；每轮最多 200 个草稿；
3. **没人引用的资源**：上传或最近复用超过 `CLEANUP_ASSET_GRACE_DAYS` 天、没被引用的，先删 `files` 文档再删数据块，再按 4.5 减回用量。"被引用"的定义在现在的基础上加两处：提交的 `bundleRef`，草稿的 `bundleRef` 和 `opsRefs[].source`。等人工对齐的旧 `scan_import` 结果（`needsAlignment`、`retainUntil` 未到）仍算引用，保留一个版本后删掉这条；
4. **补打区块的 `publishedAt`**：最近 48 小时的提交引用、还没打上的区块按提交的 `at` 补上。

**只让一个副本跑**：每轮开始前在 `migrations` 集合里抢一把带租约的锁：`updateOne({_id: "lock:cleanup", $or: [{until < 现在}, {owner: 本进程}]}, {$set: {owner, until: 现在 + 15 分钟}}, upsert)`，插入时撞唯一键就算没抢到；每做完一步续一次。抢不到就跳过这一轮。各步本来就是幂等的，锁只是避免重复劳动。

**与 `touchedAt` 栅栏的关系**：不变。删除仍带"`metadata.touchedAt` 早于截止时间"的条件，这是唯一的栅栏；引用一个已有资源的一方（草稿追加、发布、复用上传、执行器登记）先刷新 `touchedAt` 并要求匹配到。清理和引用现在都在接口服务里，但不同请求、不同副本之间仍然并发，栅栏照样需要。

每一步每轮处理的数量有上限（资源每轮最多 500 个），单步都很小，不阻塞请求。

---

## 6. 重建包

### 6.1 目录

```
bundle/
  manifest.json          清单（6.2）
  scan/scan.zip          原始扫描（空间里已有同一哈希时可以不带文件，只在清单里写哈希）
  web/scan-0.glb         网页用模型默认档（网站加载这一档）
  web/scan-1.glb         低细节档（可选）
  models/<哈希前 12 位>.glb   外部模型和其他物件模型（已把摆放的旋转、缩放、调色烘进网格，原点在底面中心）
  textures/<哈希前 12 位>.jpg 烘焙贴图、结构贴图、下载的外链贴图
  notes.md               建模过程记录（可选，作为提交的 scriptRef）
```

### 6.2 清单格式

```json
{
  "format": "chrono-metaverse-rebuild-bundle",
  "version": 1,
  "tool": { "name": "metaverse-recon", "version": "0.2.0", "source": "git:<40 位提交哈希>" },
  "note": "前厅第 4 版：AI 物件集 52 件，结构按实测替换",
  "createdAt": "2026-11-20T08:00:00.000Z",
  "scan": {
    "assetHash": "<扫描 zip 的 sha256>",
    "webModelHashes": ["<scan-0.glb>", "<scan-1.glb>"],
    "transform": [16 个数],
    "observedAt": "2026-10-20T00:00:00.000Z",
    "alignment": { "method": "given", "rotationDeg": -61.42, "tiltDeg": 0.09 }
  },
  "rebuilt": {
    "mode": "replace",
    "templates": [ { "entityId": "chair-a", "layer": "rebuilt", "kind": "template", "shape": { … } } ],
    "entities":  [ { "entityId": "counter-01", "layer": "rebuilt", "kind": "object", "shape": { … }, "bounds": { … }, "fit": { … } } ],
    "remove": []
  },
  "anchors": [ { "anchorId": "counter-01", "kind": "counter", "box": [ … ], "label": "前台", "visibility": "public" } ],
  "notes": "<notes.md 的 sha256>",
  "report": { "fit": { "meanCm": 4.31, "p90Cm": 8.71, "within3cm": 0.67 }, "entities": 52 },
  "files": [
    { "path": "scan/scan.zip", "purpose": "scan", "sha256": "…", "size": 5901234,
      "members": [ { "name": "mesh.drc", "url": "https://scaniverse.com/api/media/…/mesh.drc", "sha256": "…", "size": 1003301 },
                   { "name": "tex.jpg",  "url": "https://scaniverse.com/api/media/…/tex.jpg",  "sha256": "…", "size": 4897711 } ] },
    { "path": "web/scan-0.glb", "purpose": "webmodel", "sha256": "…", "size": 13800000,
      "url": "https://github.com/ChronoAIProject/chrono-metaverse/releases/download/demo-assets/<sha256>.glb" },
    { "path": "models/3f9a…glb", "purpose": "model", "sha256": "…", "size": 412345 },
    { "path": "textures/8be8….jpg", "purpose": "texture", "sha256": "…", "size": 51234 },
    { "path": "notes.md", "purpose": "script", "sha256": "…", "size": 9876 }
  ]
}
```

### 6.3 规则

| 字段 | 规则 |
|---|---|
| `format`、`version` | 必须正好是 `chrono-metaverse-rebuild-bundle` 和 1；不认识的字段一律拒绝（以后加字段就升版本） |
| `tool` | `name`、`version` 1–64 个字符；`source` 可选，只能是 `git:` 加 40 位小写十六进制 |
| `note` | 1–2000 字，规则同提交说明（不含换行以外的控制字符）；发布时没给 `--message` 就用它 |
| `createdAt` | RFC 3339，只为追溯 |
| `scan` | 可选；字段规则同 `setScan`（2.3），另有 `observedAt`、`alignment` |
| `rebuilt` | 可选；`mode` 是 `replace`（重建层整体换成这一份）或 `merge`（只放、改列出的物件，再删 `remove` 里的编号）；`remove` 只在 `merge` 时能给；物件 ≤ 2000、模板 ≤ 200（与现在物件集的上限相同），编号不重复；物件和模板的 `layer` 必须是 `rebuilt` |
| `anchors` | 可选，≤ 2000，锚点 body 按 `AnchorBody::validate` |
| `notes` | 可选，必须是 `files` 里用途为 `script` 的文件的哈希 |
| `report` | 可选，任意 JSON 对象，规范化后 ≤ 64 KiB，原样保存在清单里，服务端不解释 |
| 至少有一项 | `scan`、`rebuilt`、`anchors` 至少给一个 |
| `files[]` | ≤ 4096 项；`path` 是相对路径：`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`，≤ 200 个字符，没有 `.`、`..` 段，不重复；`purpose` 是 `scan`、`webmodel`、`model`、`texture`、`script` 之一；`sha256` 64 位小写十六进制，同一哈希只出现一次；`size` ≥ 1 且不超过该用途的上传上限；`url` 可选，只能是 https（只有部署种子用）；`members` 只能出现在 `scan` 上（≤ 32 个，各有 `name`、`url`、`sha256`、`size`，按 `name` 打包成 zip 后的哈希和大小必须等于这一项的 `sha256`、`size`，打包规则就是现在种子的 `demo_seed/pack.rs`） |
| 引用 | 记录里引用的每个哈希（`scan.assetHash`、`webModelHashes`、物件的 `assetHash`、形状材质的 `texture`、`normalMap`、`roughnessMap`、物件的 `textures`、`notes`）要么在 `files` 里且用途对得上，要么发布到的空间里已有可用的资源（2.3 的资源检查） |
| 没有本地路径 | 由上面的 `path`、`url`、`source` 规则保证；记录里的贴图只能是哈希（形状校验本来就这样要求，重建工作台的 `{file}`、`{url}` 写法在打包时都已换成哈希）；`report` 里的字符串不能以 `/`、`~`、`file:` 开头，也不能是 `C:\` 这样的盘符路径 |

### 6.4 展开成操作（服务端和本地用同一个规则）

```
1. 有 scan：           {"op": "setScan", "scan": {assetHash, webModelHashes, transform, alignment?}, "observedAt"?}
2. rebuilt.mode = replace： {"op": "clearRebuilt"}
3. 每个模板（按清单顺序）：  {"op": "placeEntity", "entity": 模板}
4. 每个物件（按清单顺序）：  {"op": "placeEntity", "entity": 物件}
5. rebuilt.mode = merge：   每个 remove 编号 {"op": "removeEntity", "entityId": 编号}
6. 每个锚点：              {"op": "createAnchor", "anchor": 锚点, "ifAbsent": true}
```

Rust（`metaverse_core::bundle::to_ops`）、TypeScript、Python 各实现一份，测试向量 `tests/vectors/bundle/bundle_*.json` 给出清单和期望的操作序列。

**二期：方块化**（第一版不做，清单里出现 `chunks` 先按不认识的字段拒绝）。`rebuilt` 里可以再给 `chunks: {ops: "<哈希>"}`，指向 `files` 里一份用途为 `ops` 的 NDJSON，里面只有 `addBlock`（用临时名称新增方块）和新操作 `putChunk`：

```json
{"op": "putChunk", "layer": "rebuilt", "chunk": [0, 0, 1], "blocks": [2, "scan-7f3a2c"],
 "cells": "<base64url：zlib 压缩的 32768 个小端 u16>"}
```

`cells` 里 0 表示空，k ≥ 1 表示 `blocks[k−1]`（方块表的正式编号，或草稿里新增方块的临时名称）。服务端换成编号写进草稿区块，发布时临时编号按现有规则换成正式编号；`mode: replace` 时第 2 步写成 `{"op": "clearRebuilt", "chunks": true}`，旧清单里有、新结果里没有的重建层区块写 null（设计 4.2）。这份操作文件接在第 4 步之后展开。只有重建草稿能用 `putChunk`。

### 6.5 校验分工

| 在哪 | 查什么 |
|---|---|
| 本地 `metaverse-recon bundle-check`（Python）、`metaverse bundle check`（命令行） | 6.3 的全部结构规则；文件存在、大小和 sha256 对得上；glb、图片按 4.3、4.4 同样的上限检查（提前发现会被服务端拒绝的文件）；记录按 SHAPES 的规则校验（三边的实现用同一批向量）；模型和记录一致（2.3） |
| 接口服务：上传 | 4.3、4.4 |
| 接口服务：`ops-from-upload` | 6.3 的结构规则；文件已上传且属于本空间；展开后每条操作按 2.3 校验（记录、范围、资源用途、整体检查） |
| 接口服务：发布 | 冲突、范围（按最新区域）、资源栅栏、没有变化就不提交 |

### 6.6 上传与发布（命令行）

`metaverse bundle push <目录> [--message <说明>] [--publish] [--replay] [--no-preview] [--part-size <MiB>]`：

1. 跑一遍 `bundle check`，不过就停；
2. 读空间信息（最新 seq、当前扫描）；包的 `scan.assetHash` 与当前扫描相同、`transform` 却不同时提示（重扫要先对齐，见 8.3 `align`）；
3. 逐个上传 `files`（同时 4 个）：创建上传时本空间已有同一哈希、同一用途就直接复用，不传数据；其余分片上传、完成、等 `upload_verify`；
4. 上传清单本身（用途 `bundle`）；
5. 建重建草稿（`baseSeq` = 第 2 步看到的最新 seq），`ops-from-upload {assetHash: <清单哈希>}`，等任务完成，打印碰过的物件数、锚点数；
6. 生成预览链接（除非 `--no-preview`）；
7. `--publish` 时直接发布（`message` 取 `--message` 或清单的 `note`）；否则把草稿记进工作区的 `out/drafts.json`（范围 `rebuild`），人看过预览后用 `metaverse publish <草稿编号>` 发布。冲突时打印冲突的键，`--replay` 在最新版本上重放。

### 6.7 幂等

- **文件**：按哈希复用，重复上传不重复存储；
- **包展开**：展开的操作文件按内容哈希登记，同一个包展开两次得到同一个哈希；
- **发布**：同一个草稿重复发布返回同一个结果（现有规则）；同一个包在已经发布过、之后重建层没再变的情况下再推一次，发布结果是 `unchanged: true`，不写新提交。先后发布 A、B、A 时第二次的 A 是真正的变化（回到 A），照常提交——所以不按包哈希做唯一键，而按"内容有没有变化"判断；
- **种子**：任务编号由（空间、空间创建时间、版本）算出，同一版本只导入一次（7.2）。

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
    "url": "https://raw.githubusercontent.com/ChronoAIProject/chrono-metaverse/<40 位提交哈希>/infra/chrono-cd/demo/lobby-r4.bundle.json",
    "sha256": "<清单的 sha256>",
    "size": 312345
  }
}
```

- `bundle` 可选：不给时种子只保证空间存在（建空间、写第一次提交），不导入任何内容；
- 旧字段 `files`、`rebuild`、`voxelize`、`hints`、`authored`、`observedAt` 一律拒绝（启动失败，说明"旧格式的种子要处理服务，已不支持，改成 bundle"）。镜像和规格在同一次 `PUT` 里更新，回滚时整份规格一起回到上一个版本，所以不需要兼容旧格式；
- `METAVERSE_DEMO_SEED_HOSTS`：允许下载的主机，逗号分隔，写法同本地工具的主机列表（主机名精确匹配且只许 443 端口，以点开头匹配子域名，`主机:端口` 只匹配那个端口）。线上写 `raw.githubusercontent.com,github.com,release-assets.githubusercontent.com,objects.githubusercontent.com,scaniverse.com`；部署规格检查要求显式写出。只用 https（本机测试可用 `http://127.0.0.1`），不自动跟随重定向，每一跳都按同一个列表检查，最多 5 跳（GitHub 发布页的下载会 302 到 `release-assets.githubusercontent.com` 的临时签名地址）；
- `METAVERSE_DEMO_SHARE_TOKEN` 不变。

### 7.2 流程

**启动时**（索引建好之后，后台执行一次，失败按退避重试几次，不影响就绪）：

1. 空间已存在：不是种子为同一组织建的就什么都不做；
2. 任务编号 = `seed_job_id(空间, revision)`（公式不变）。这个编号的任务已经存在就什么都不做——线上第 1–3 版的 `scan_import` 任务用的就是这个公式，所以换成新格式、版本号不变时不会重做。配置里没有 `bundle` 时，空间存在就什么都不做，不存在就只做第 4 步；
3. 下载清单（≤ 16 MiB），核对大小和 sha256，按 6.3 校验结构。不合格就停，不建空间；
4. 空间不存在就按现在的代码路径建（主人、归属证据 `operator_seed`、分享令牌只存哈希），并补写第一次提交；
5. 插入任务 `{kind: "bundle_import", params: {bundle: {url, sha256, size}, revision}, actor: {sub: "system:demo-seed"}, scope: "rebuild"}`，编号是第 2 步的编号（唯一键，多副本同时启动也只有一个）。

**执行器做 `bundle_import`**：

1. 再下载一次清单并核对（清单很小，不缓存）；
2. 逐个文件：本空间已有同一哈希、种类对得上的可用资源 → 刷新 `touchedAt`，跳过；否则下载（有 `url` 的边下边数、超过声明大小就停、读完核对 sha256；有 `members` 的下载各成员，按 `pack.rs` 打包，核对打包后的哈希和大小；都没有就失败），用系统身份建一个上传会话、把字节按上传的布局写进 GridFS，调用与 `upload_verify` 相同的核对和登记函数（4.2 第 2–5 步，计入存储用量）；
3. 建重建草稿（编号由任务编号算出，已存在就接着用），用与 `ops-from-upload` 相同的函数把包展开、追加（2.4）；
4. 发布：提交带 `jobId`，说明是清单的 `note` 加"（部署配置种子第 N 版）"，同一个事务里把任务标记完成；没有变化就不写提交，任务结果写 `unchanged: true`；
5. 结果：`{manifest, files: {total, reused, downloaded, bytes}, draftId, commitId? , unchanged?}`。
6. 失败：清单或文件的哈希、大小不符，主机不在列表，4xx，包不合规 → 不可重试；网络错误、超时、5xx、429 → 退回队列稍后重试（4.2）。错误说明只写主机和文件路径，不写完整地址（重定向后的地址带签名）。

文件逐个流式下载写进 GridFS，内存里只有一个分片；`members` 打包在内存里做，总大小 ≤ 256 MiB（现在的种子上限）。

### 7.3 与线上空间的兼容

线上 `chronoai-lobby` 现在有：第一次提交、第 1–3 版 `scan_import` 写的提交（最新一次的重建层是 AI 物件集）、它们的资源和锚点、`jobs` 里的任务记录。第 4 版这样追加：

- 版本 1–3 的任务还在，换格式不会重做；版本改成 4 才导入；
- 包的 `scan.assetHash` 就是线上已有的扫描 zip（`members` 指向同样的两个 Scaniverse 文件，打包结果字节相同，哈希相同），已存在，不下载。本地工具打包扫描必须用与 `demo_seed/pack.rs` 相同的规则（存储不压缩、时间固定、按给定顺序），测试向量 `api/crates/metaverse-api/tests/vectors/demo_seed_zip.json` 已经在 Python 测试里核对（`test_demo_seed_zip.py`），改名后保留；`transform` 用线上最新提交的变换（本地工具从 `metaverse pull` 的结果读，不重新自动对齐），扫描层的坐标不变；
- 网页用模型：本地工具重新生成的字节多半与线上不同（依赖版本不同），就是两个新资源，提交里换成新的；旧的仍被旧提交引用，回放到旧版本时照样能看；
- 重建层：`mode: replace`，第 3 版的物件按差异换掉，内容相同的物件不进 `changedEntities`；
- 锚点：`ifAbsent`，第 1–3 版建的锚点（前台、桌子、沙发……）原样保留；
- 提交追加在最新 seq 之后，`actor.kind` 是 `rebuild`。时间线上能看到第 1–4 版。

### 7.4 包文件放哪里

前厅第 4 版的包大致有这些文件：

| 文件 | 大小 | 来源 |
|---|---|---|
| 清单 | 约 0.3 MB | 本地工具生成 |
| 扫描 zip（drc 1.0 MB + 贴图 4.9 MB） | 5.9 MB | 不重新托管：`members` 指向 Scaniverse 原地址；线上已有，不会下载 |
| 网页用模型 [0] | 约 13.8 MB | 本地工具生成 |
| 网页用模型 [1] | 约 2.5 MB | 网站不加载，可以不带 |
| 外部模型（10 个 glb） | 2.44 MB | 本地重新导出；以后的空间几 MB 到几十 MB |
| 烘焙贴图、结构贴图 | 约 0.4 MB | 本地生成 |
| 合计要托管的 | 约 17–19.5 MB / 版 | |

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 全部放进本仓库，按提交哈希的 raw 地址引用 | 和现在 `authored` 的做法一样；一个地方 | 仓库的 git 数据现在 27 MB，一版就涨 17 MB 以上，之后每版再涨，永远删不掉；所有人克隆都要背 |
| B. 清单进本仓库（按提交哈希引用），大文件放本仓库的发布页 `demo-assets`，文件名就是 `<sha256>.<扩展名>` | 清单可评审、可追溯；大文件不进 git 历史；按哈希命名，新版本只传新文件（天然去重）；单文件上限 2 GiB；公开仓库的发布页可以匿名下载；地址固定、内容由 sha256 钉死 | 多两个下载主机（`github.com` 和重定向后的 `release-assets.githubusercontent.com`）；发布页的文件能被有权限的人删掉——删了种子会明确失败，不会读到错的内容 |
| C. 对象存储（chrono-bucket） | 平台内 | 之前已决定不用（设计 15）：需要角色，有覆盖问题 |
| D. NyxID 注册后直接用命令行把包发布到线上 | 不需要托管 | 注册前做不到；新库（本地开发 `--demo-seed`）还是要能下载 |

**推荐 B**。做法：本地生成包 → `gh release upload demo-assets <文件>`（文件先改名成 `<sha256>.<扩展名>`；同名文件已存在就跳过）→ 清单里每个文件写对应的发布页地址 → 清单提交进 `infra/chrono-cd/demo/lobby-r4.bundle.json` → 种子的 `bundle.url` 写这个提交的 raw 地址。扫描继续用 Scaniverse 原地址（`members`），不重新托管。

### 7.5 能不能让网站直接用 Scaniverse 原始文件

"原始"视图要是直接加载 Scaniverse 的 `mesh.drc`（1 MB）+ `tex.jpg`（4.9 MB），只有 5.9 MB，比现在的网页用模型（13.8 MB）小。评估下来**不推荐作为默认**：

| 问题 | 说明 |
|---|---|
| 原始扫描默认不公开 | 设计 8.2、17.5：原始扫描可能含个人信息，只公开网页用模型。直接用原始文件等于把它公开 |
| 贴图 8192² | 解码后 256 MB 显存，加多级缩小贴图约 340 MB；很多手机的贴图上限是 4096，three.js 会先在内存里缩小（再要 256 MB），手机上容易崩 |
| 贴图接缝 | 扫描贴图分块，块外是深灰底色；网页用模型补了边、按块合并顶点，原文件直接显示会有黑斑和小洞（处理服务实测过） |
| 要加 Draco 解码 | 网站要带解码器（wasm，约 300 KB，放在本站，不用第三方地址） |
| 依赖外部主机 | 每个访客都去请求 Scaniverse，跨域、可用性、隐私都不受控 |

**推荐**：默认仍是本地工具生成的网页用模型（与现在相同，网站不用改）。以后要缩小体积，本地工具可以输出"Draco 压缩网格 + 4096² 贴图"的 glb（估计 3–5 MB），这需要网站加上 Draco 解码器（放在本站）、接口服务的 glb 检查放开 `KHR_draco_mesh_compression`（三角形数仍从访问器的 `count` 读）。作为单独的增强，不放在这次改造里。

---

## 8. 本地工具

### 8.1 改名

| 现在 | 改成 |
|---|---|
| 目录 `worker/` | `recon/` |
| 项目名 `metaverse-worker` | `metaverse-recon` |
| 包 `metaverse_worker` | `metaverse_recon` |
| 子包 `metaverse_worker.processing` | `metaverse_recon.pipeline` |
| 子包 `metaverse_worker.recon`（工作台） | `metaverse_recon.bench` |
| 命令 `metaverse-worker`、`metaverse-recon` | 只留 `metaverse-recon` |

权衡：不改名，目录叫 `worker/` 却没有任何服务，以后的人和 AI 都会被误导；改名的代价是一次大的路径变化。推荐改，并且用**一次只做改名的提交**完成：`git mv worker recon`、`git mv` 包和两个子包，`sed` 改导入和文档里的路径，不改任何逻辑，跑全部测试确认。git 按内容识别改名，`git log --follow`、`git blame -M` 都能追到改名之前的历史。同一次提交里改 `.github/workflows/ci.yml` 的 `working-directory` 和缓存路径、`infra/dev/up.sh`、文档里的路径。改名放在删除服务端部分之后（8.2），要搬的文件少；放在新增命令之前，新代码直接写在新路径下。

### 8.2 留下和删掉的模块

| 删掉（只有服务端用） | 留下（变成本地流水线） |
|---|---|
| `__main__.py`（服务入口）、`runner.py`、`health.py`、`config.py`（服务的环境变量） | `processing/` 整个 → `pipeline/`：`align`、`scan`、`sniff`、`webmodel`、`structure`、`objects`、`fit_*`、`object_fit`、`bake`、`modelimport`、`glb`、`preview_glb`、`shape_mesh`、`voxelize`、`authored_build`、`tasks`、`rebuild` |
| `store.py`、`assets.py`、`uploads.py`（MongoDB、GridFS） | `shapes.py`、`records.py`、`canonical.py`、`chunk.py`、`ids.py`、`timeutil.py`、`errors.py`（与接口服务同一套规则的实现） |
| `jobs/`（租约、续约、写回、清理、子进程隔离） | `authored.py`（物件集的解析和校验，`assemble` 用） |
| `handlers/`（`upload_verify`、`scan`、`authored`、`model_import`、`voxelize`、`context`） | `fetch.py`（https 下载，主机列表、逐跳检查重定向、核对大小和哈希）→ 给 `bundle` 下载外部模型和外链贴图 |
| 依赖 `pymongo`；`scripts/demo_seed_hints.py`（种子提示的坐标换算，种子不再有提示） | `recon/`（工作台）整个 → `bench/`；`scripts/` 里的验收脚本、提示、结果图 |

`handlers/scan.py` 里"导入扫描"的编排（对齐 → 网页用模型 → 重建 → 建锚点）和 `jobs/writeback.py` 里的锚点规则、`handlers/authored.py` 里的物件集写回（下载外部模型、烘焙、逐件偏差、结构贴图回退），不是删掉，而是去掉数据库部分后搬进新的 `bundle/` 子包，输出从"写提交"变成"写重建包"。

测试：用到 MongoDB 的测试（`test_pipeline_mongo`、`test_authored_mongo`、`test_cleanup_mongo`、`test_asset_fence`、`test_model_storage`、`test_service`、`test_space_instances`，约 60 个）按内容分两路：服务端语义（核对、清理、栅栏、空间实例、用量）移植成接口服务的 Rust 测试（第 4、5 节）；重建语义（锚点规则、物件集写回、外部模型、烘焙）改成本地 `bundle` 的测试，不再需要数据库。`.github/scripts/pytest_require_mongo.py` 和它的测试删掉。

### 8.3 本地命令（`metaverse-recon`）

| 命令 | 作用 | 来自 |
|---|---|---|
| `doctor` | 检查渲染要用的 node、three、Playwright、Chromium、字体 | 现有 |
| `prepare` | 扫描（zip、glb，或 drc + 贴图）+ 可选提示 → 基线目录（对齐、算法结构和物体、候选清单）；`--transform <文件>` 用给定变换（已有空间重建时用线上的变换，不重新对齐） | 现有；变换参数是新的 |
| `align` | 只算对齐：首次自动对齐；或者重扫配准到参考扫描（`--reference <参考扫描> --reference-transform <文件>`），输出 `transform.json`、误差和候选，误差超过 `--max-error-cm`（默认 3）时退出码非 0，由人决定 | `processing/align.py`（原 `scan_import` 第 1–3 步） |
| `webmodel` | 生成网页用模型两档（接缝不裂开的减面、贴图补边） | `processing/webmodel.py` |
| `views`、`measure`、`compare`、`search`、`index`、`fetch`、`place`、`reframe` | 不变 | 现有 |
| `assemble` | 合并成 AI 物件集；最后的整体校验改成"打包能不能过" | 现有 |
| `models` | 外部模型：下载、核对，把摆放的旋转、缩放、调色烘进网格，按物件模型的上限减面、缩小贴图，原点放在底面中心，写成 glb；多材质、平铺贴图、相同偏航的去重导出在这里修（第 12 节） | 原处理服务物件集写回 |
| `bake` | 按烘焙指令从扫描烘焙贴图 | 原处理服务物件集写回 |
| `fit` | 逐件偏差（与 `compare` 同一个函数） | 原处理服务物件集写回 |
| `bundle` | 打包：物件集（或 `--algorithm`：直接用基线里的算法结构和物体）→ 下载并导出外部模型（`models`）、下载外链贴图、烘焙（`bake`）、逐件偏差（`fit`）、按类别建议锚点、生成或带上网页用模型、打包扫描 → `manifest.json` + 文件；最后跑一遍 `bundle-check` | 原 `scan_import` + 物件集写回的编排 |
| `bundle-check` | 按 6.5 校验一个包 | 新 |
| `voxelize` | 方块化（二期）：输出 `addBlock` + `putChunk` 的操作文件，作为包的 `chunks` 部分 | `processing/voxelize.py` |

所有命令只读写本地文件，**不连接本服务**，也不需要任何凭证；只有 `search`、`fetch`、`models`、`bundle` 会去模型库和贴图地址下载（主机列表 `METAVERSE_RECON_MODEL_HOSTS`）。

### 8.4 命令行（`metaverse`）的分工

TypeScript 命令行负责一切和本服务打交道的事（NyxID 凭证只在这一处）：

| 命令 | 变化 |
|---|---|
| `scan`、`rebuild`、`voxelize` | 删除（连同 `commands/authored.ts`、传输层里调这些接口的方法） |
| `bundle check <目录>` | 新：6.5 的本地校验（用 TypeScript 核心库校验记录） |
| `bundle push <目录>` | 新：6.6 |
| `publish <草稿编号>` | 认得范围是 `rebuild` 的草稿（走 `/rebuild/drafts/...` 路径），显示 `unchanged` |
| `pull --scan` | 新选项：经 `/api/v1/spaces/{space_id}/assets/{hash}` 下载当前的原始扫描到工作区（本地重建、重扫配准要用），并把扫描的哈希和变换写进 `space.json` |
| `init` | 技能说明 `metaverse-reconstruct` 改成本地工具 + `bundle push` 的流程 |
| 其余（`admin`、`pull`、`build`、`dev`、`shot`、`diff`、`check`、`push`） | 不变 |

### 8.5 依赖与平台

Python 3.13；numpy、scipy、pillow、trimesh、DracoPy、fast-simplification（去掉 pymongo），都有 macOS（Apple 芯片和 Intel）和 Linux 的预编译包，不需要编译器，不需要显卡。渲染另要 node 22、Playwright 和 Chromium（与现在相同，`doctor` 会查）。前厅这样的扫描，`prepare` 在 4 核机器上约 46 秒，内存峰值约 1.3 GB。用 `uv sync --frozen` 按 `uv.lock` 装。

---

## 9. 网站

- 网站不调用任何任务接口，也没有"处理中"的状态（时间线只显示已发布的提交），这次不用改结构；
- "模型来源"面板的改动说明 `ModelSources.tsx` 的 `MODIFIED_NOTE` 现在写"经本服务处理后重新导出"，改成"经重建工具处理后重新导出（摆放的旋转、缩放烘进模型，按需调色、减面、缩小贴图），与原文件不同"，同步改它的测试和 SHAPES 3 的说法（CC BY 要求注明改动，事实没变，只是改动的一方变了）；
- 公开提交列表的 `actor.kind` 会出现新值 `rebuild`，网站按字符串处理，不用改；
- 剖切默认高度（`a8e49d3`）按结构墙算，与谁写重建层无关。

---

## 10. 部署

### 10.1 `infra/chrono-cd/app.json` 与资源

- 删掉 `metaverse-worker` 服务（用完整规格 `PUT`，部署后用 `get_app_status` 确认服务已删除）；
- `metaverse-api` 的 `env`：`METAVERSE_DEMO_SEED` 换成 7.1 的格式；加 `METAVERSE_DEMO_SEED_HOSTS`；4.6 的新变量用默认值时可以不写，但 `UPLOAD_MODEL_MAX_TRIANGLES`、`UPLOAD_MODEL_MAX_TEXTURE_SIDE`、`UPLOAD_WEBMODEL_MAX_TRIANGLES` 显式写出（部署规格检查核对），方便以后调；
- 资源：核对是流式的，每个任务只多几 MB；种子打包 `members` 最多 256 MiB；分片上传最多 8 片并发 × 32 MiB。最坏约 600 MB，现在的上限 1Gi 够用。保持 `cpu_request 250m / cpu_limit 1`、`memory_request 256Mi / memory_limit 1Gi`；上线后按 1GB 扫描的核对实测峰值再调（第 0 阶段要测，见设计 16.2）。去掉处理服务后组织配额少占 500m CPU 申请、3Gi 内存申请（上限 2 核 / 8Gi）和 8Gi 临时盘。

### 10.2 镜像、工作流、持续集成、检查脚本

| 文件 | 变化 |
|---|---|
| `infra/worker/`（`Dockerfile`、`build-requirements.txt`） | 删除 |
| `infra/api/Dockerfile` | 不变（还是一个 Rust 二进制；种子下载用内置根证书） |
| `.github/workflows/images.yml` | 镜像只剩 `api`、`web`；注释里的"三个镜像"改成两个 |
| `.github/workflows/ci.yml` | `worker` 任务改成 `recon`（本地工具）：`working-directory: recon`，`uv sync --frozen --extra dev`、ruff、pytest，不再起 MongoDB；删掉"持续集成插件的测试"；hadolint 只查两个 Dockerfile |
| `.github/scripts/pytest_require_mongo.py`、`test_pytest_require_mongo.py` | 删除 |
| `infra/chrono-cd/check-app.mjs` 及测试 | 删掉处理服务的检查（线程数、`WORKER_MODEL_HOSTS`）；加：`METAVERSE_DEMO_SEED_HOSTS` 必须显式写出且每项合法、种子是新格式、种子和清单地址是 https 且主机在列表里、上面三个上限显式写出且是正整数；不允许出现 `metaverse-worker` |
| `infra/chrono-cd/pin-images.mjs` 及测试 | 只认 `api=`、`web=` |
| `infra/chrono-cd/check-pins.mjs` 及测试 | 删掉处理服务构建后端的固定检查 |
| `infra/chrono-cd/README.md`、`demo/README.md` | 删掉处理服务、线程数一节；"演示数据"一节改成重建包（7.4 的发布页做法）；回滚一节按 11.5 |

### 10.3 本地开发设施（`infra/dev/up.sh`）

- 不再起处理服务，去掉 `--no-worker`、`WORKER_HEALTH_PORT`、`worker.log`；
- 接口服务的环境变量里加 `METAVERSE_DEMO_SEED_HOSTS`（本地种子默认用 `infra/chrono-cd/demo-seed.json`；第 4 版上线后它带包，新库要从 GitHub 和 Scaniverse 下载约 25 MB）；
- 本地工具的虚拟环境由需要它的地方准备（九步验收、重建教程），`up.sh` 只在最后打印"本地重建工具：`recon/.venv/bin/metaverse-recon`（没有就 `cd recon && uv sync --frozen`）"；
- `infra/dev/README.md` 同步。

### 10.4 九步验收（`infra/dev/e2e.mjs`）

| 步 | 现在 | 改成 |
|---|---|---|
| 1 | 建组织空间（实体区、虚拟区、地块 p1） | 不变 |
| 2 | 分片上传前厅扫描（验证本空间按哈希复用、别的空间不能） | **本地工具产出重建包**：`metaverse-recon prepare --scan <扫描>` → `metaverse-recon bundle --algorithm`（算法结构和物体、网页用模型、建议锚点）→ `metaverse bundle check` 通过。不需要服务，前厅约 1 分钟 |
| 3 | 处理服务完成对齐和 AI 重建，写入提交 | **上传并发布**：`metaverse bundle push --publish`——分片上传包里的文件（0.25 MiB 一片），等接口服务后台核对完成；再在另一个空间验证按哈希复用只在本空间成立；发布一次提交（重建层、扫描、锚点，`actor.kind = rebuild`）；同一个包再推一次得到 `unchanged` |
| 4–9 | 快照、三种视图、回到重建前、"现在"模式、地块建造、越权 | 不变；第 9 步的越权情况加两种：组织 member 调重建路径 403（NyxID 操作范围在本地模拟不了，服务端这一层按访问级别判）、地块路径上传 `bundle` 403 |

`--voxelize` 选项在二期方块化做完之前先去掉。`METAVERSE_E2E_JOB_TIMEOUT` 改成等上传核对和包展开（默认 600 秒）。

---

## 11. 线上数据迁移与回滚

### 11.1 线上现在有什么

NyxID 服务还没注册（`ALLOWED_NYX_SERVICE_IDS` 是占位值，`/api/v1` 一律 401），所以线上的写入**全部来自部署种子**：

- `spaces`：`chronoai-lobby` 一个空间，`frame` 已固定；
- `commits`：第一次提交 + 第 1–3 版 `scan_import` 写的提交（`actor.kind = job`，带 `jobId`、`scan`、`scriptRef`）；
- GridFS：扫描 zip（`kind: scan`）、网页用模型（`web_model`）、贴图（`texture`）、处理后的外部模型（`model`，带 `sourceHash`）、脚本、物件集（`authored`，没被提交引用的已过宽限期被清理）；`assetRefs` 登记了网页要用的那些；
- `jobs`：三个 `scan_import`（`done`），可能还有它们派生的任务；`uploads` 基本为空。

### 11.2 上线顺序（三次发布，每次都能退回上一次）

| 次 | 内容 | 写不写新格式的数据 |
|---|---|---|
| R1 兼容读 | 核心库能读新值：`PathScope::Rebuild`、`ActorKind::Rebuild`、`JobKind::BundleImport`、`UploadPurpose::{WebModel, Bundle}`、`Commit.bundleRef`、`ScanRef.alignment`、`Touched.scan`、新操作（`setScan`、`clearRebuilt`、`createAnchor.ifAbsent`，提交里内联的操作会读到）、草稿的 `bundleRef` 和 `unchanged`。接口、处理服务都不变 | 不写 |
| R2 瘦身 | 接口服务带上执行器、核对、清理、重建草稿、新用途、410 的旧接口；规格里删掉处理服务；种子换成新格式、**版本仍是 3、不带 `bundle`**（空间已存在，什么都不做，也不下载） | 只有新上传会写 `metadata.check`、新任务种类 |
| R3 前厅第 4 版 | 种子版本改成 4，指向新包 | 写一次 `actor.kind = rebuild` 的提交 |

为什么要 R1：滚动更新时新旧副本会同时运行几十秒；回滚时旧版本要读新版本写的数据。旧代码遇到不认识的枚举值（`rebuild`、`bundle_import`）会读不出整条提交或任务。R1 只加"能读"，先上线，之后 R2、R3 写的东西 R1 都能读。

### 11.3 第一次部署瘦身版（R2）时发生什么

1. 启动：幂等地建索引（`jobs` 现有索引够用；`migrations` 集合放锁）；
2. 后台迁移 `retire-worker-jobs-v1`（用 `migrations` 里带租约的锁，只跑一次）：
   - `queued`、`running` 状态、种类是 `scan_import`、`align`、`rebuild`、`voxelize`、`web_model`、`model_import` 的任务 → `failed`，`lastError = "处理服务已下线：重建改在本地完成，见 docs/design/server-slim.md"`，写 `finishedAt`；线上预计 0 条；
   - 用途是 `authored`、还在 `open` / `complete` 的上传 → `failed`（数据块由清理删）；线上预计 0 条；
   - 已完成的旧任务不动，`GET .../jobs` 照样能查；
3. 执行器开始领取 `upload_verify`、`ops_from_upload`、`bundle_import`；清理开始按锁运行；
4. 种子：版本 3 的任务已存在 → 什么都不做；
5. 读路径（快照、回放、公开资源）完全不碰任务和处理服务，线上前厅照常能看、能回放到第 1–3 版的任何时刻。

### 11.4 要不要迁移脚本

不要单独的脚本。需要改的只有上面第 2 步的任务状态，放在接口服务启动后的后台迁移里（设计 13.1：耗时迁移不放在启动路径上，带锁、可重入、新旧版本兼容）。提交、记录、资源、`assetRefs`、`frame` 都不用改；旧的处理后模型（带 `sourceHash`）继续可以被引用（2.3）。

### 11.5 回滚

| 从 | 退到 | 做法 | 数据 |
|---|---|---|---|
| R3 | R2 | 不需要退：第 4 版的提交只追加，R2 读得了。内容有问题就发布第 5 版包修正（要回到第 3 版的样子，可以用 `metaverse pull` 拉下第 3 版的快照，`metaverse-recon bundle --from-snapshot` 打成包再发布） | 时间线只追加，不删 |
| R2 | R1 | 在 chrono-cd 把应用规格退回 R1 的版本（`list_app_revisions` 找到，`put_app` 那一份；镜像、环境变量、处理服务一起回来） | R2 写的 `bundle_import` 任务、带 `check` 的资源、新用途的上传，R1 都读得了；处理服务只领取自己认识的种类，不会碰 `bundle_import` |
| R1 | 现在 | 同上 | R1 不写新数据，退回无影响 |

镜像都按摘要固定，处理服务的旧镜像仍在 ghcr.io，退回时能拉到。

---

## 12. 贴图能力那一轮怎么接上

三条没合并的分支（上一轮"贴图能力"做了一半）这样处理：

| 分支 | 留下 | 去掉或改写 |
|---|---|---|
| `worktree-wf_b3d9c6a7-d50-1`（规格和测试向量） | SHAPES 2 新增的材质字段（`tile`、`offset`、`rotate`、`shading`、`normalMap`、`normalScale`、`roughnessMap`、`roughness`、`metalness`）、外部模型物件的 `material.shading`、全部 `shape_material_*`、`shape_invalid_material_*`、`uv/` 向量和 `texture_vectors.py` | ARCHITECTURE 6.3 那段改动整段丢掉（第 6 节已按本文重写）；SHAPES 和向量 README 里"由处理服务下载外链贴图、登记后换成哈希"改成"由本地工具 `bundle` 下载、核对后作为 `texture` 文件进包，记录里换成哈希"；`WORKER_MODEL_HOSTS` 改成 `METAVERSE_RECON_MODEL_HOSTS`，`WORKER_MAX_AUTHORED_TEXTURE_BYTES` 改成本地工具的 `METAVERSE_RECON_MAX_TEXTURE_BYTES`；`authored/authored_texture_urls_*.json` 改由本地工具（`assemble`、`bundle`）使用，接口服务不再读 |
| `worktree-wf_b3d9c6a7-d50-2`（接口服务实现了一半） | `9f29ba9`（形状材质的新字段）、`a339d2c`（外部模型的 `shading`）；`ba63f93` 里的资源引用收集（`normalMap`、`roughnessMap` 进 `collect_textures` 和草稿资源检查、清理的引用） | `ba63f93` 里对物件集外链贴图的浅层校验（`metaverse_core::authored` 整个删除） |
| `worktree-wf_b3d9c6a7-d50-3`（命令行实现了一半） | `8204018`（形状材质校验、`shading`）、`71cac06`（工具包的材质选项） | `ba1463b` 里 `commands/authored.ts`、`rebuild.ts` 的改动（这两个文件删除）；`bundle check` 校验记录时自然用上新字段 |

本地工具这边：外链贴图 `{url, sha256, size}` 只出现在物件集（本地文件）里，`bundle` 按外部模型同样的下载规则（https、主机列表、逐跳检查重定向、核对大小和哈希）下载，按 4.3 的图片上限检查，作为 `texture` 文件进包，记录里换成哈希；工作台的 `{file}` 写法在 `bundle` 时同样换成文件和哈希。外部模型的导入修正（多材质、平铺贴图、按偏航去重导出）在 `pipeline/modelimport.py` 和 `bundle` 的 `models` 步骤里做，接口服务只看导出的 glb 合不合 4.4 的检查。

顺序：先把 -2、-3 按上表裁剪后合并（它们改的是核心库和命令行的形状校验，第 13 节 S1 也要改核心库，先合并冲突最少）；-1 的文档改写跟 S1 一起提交。

---

## 13. 实施计划

### 13.1 步骤

| 编号 | 内容 | 依赖 | 改动量（估） |
|---|---|---|---|
| T | 贴图能力收尾：-1、-2、-3 按第 12 节裁剪后合并 | — | 新写 300–600 行 + 合并 |
| S1 | 核心库扩展（兼容读）：2.5 的全部类型；新操作在核心库里的作用、范围和校验；`bundle` 模块（解析、校验、展开）；`check_transform` 移到核心库；TypeScript 核心库的同样实现；测试向量（`ops/` 新操作约 12 个、`bundle/` 约 10 个）。Python 那份放进 S6b，避开改名 | T（最好） | Rust +1,200；TypeScript +600；向量 20+ 个 |
| S2 | 接口服务后台执行器：领取、续约、写回、停止、空间实例；`upload_verify`（流式哈希、glb、zip、图片头、NDJSON、文本、JSON 检查）；`ops_from_upload` 进执行器；清理五步和锁；旧任务退役迁移；4.6 的配置；健康检查的 `background` | S1 | Rust +3,500（其中测试约 1,500）；处理服务的核对、清理测试场景逐条移植 |
| S3 | 重建草稿：路由、`PathScope::Rebuild` 的访问和范围、新操作接进草稿、`setScan` → 提交的 `scan` 和 `frame`、`ops-from-upload` 收包、没有变化不提交、`AssetRole` 扩展和模型一致性检查、`metaverse:rebuild:write`、OpenAPI；删掉任务接口（改 410）、`authored` 用途、`hints`、`metaverse_core::authored` | S1；与 S2 可并行（测试里直接登记资源） | Rust +1,800 / −2,200 |
| S4 | 演示种子改成重建包：配置格式（`bundle` 可选）、主机列表、`bundle_import`、成员打包复用 `pack.rs`、系统身份的上传和发布；`demo-seed.json` 新格式（版本仍是 3、不带 `bundle`） | S2、S3 | Rust +900 / −700 |
| S5 | 命令行：删 `scan`、`rebuild`、`voxelize`、`authored.ts`；加 `bundle check`、`bundle push`；`publish` 认重建草稿；`pull --scan`；技能说明 `metaverse-reconstruct` | S1；联调要 S3 | TypeScript +900 / −900 |
| S6a | 本地工具去掉服务端部分（8.2 左列），Mongo 测试按 8.2 分流；同时删 `infra/worker/`、`images.yml` 去掉 worker、`check-pins` 去掉处理服务构建后端的检查、`ci.yml` 的 worker 任务改成不连数据库、hadolint 只查两个 Dockerfile（`app.json` 和 `check-app` 留到 S9） | —（线上在 R2 之前一直用按摘要固定的旧处理服务镜像，不受影响） | Python −4,000 / +600 |
| S7 | 改名 `worker/` → `recon/`（8.1，纯机械） | S6a | 约 120 个文件改路径，零逻辑 |
| S6b | 本地工具新命令：`align`、`webmodel`、`models`、`bake`、`fit`、`bundle`、`bundle-check`、`prepare --transform`、`bundle --from-snapshot`；清单和新操作的 Python 实现（跑 S1 的向量）；外链贴图下载；外部模型导入修正 | S1（清单格式和向量）、S7 | Python +2,400 |
| S8 | 网站：`ModelSources` 的改动说明 | — | 约 10 行 |
| S9 | 部署与开发设施：`app.json`、`check-app`、`pin-images`、`up.sh`、`e2e.mjs` 九步、各 README、教程（`reconstruct-with-ai.md`、`build-space.md`）、`SHAPES.md` 里"处理服务"的说法、`PROGRESS.md` | S2–S8（含 S6b） | +800 / −1,200 |
| S10 | 前厅第 4 版：用现在的物件集 `lobby-authored.json` 在本地 `bundle`（变换取线上的）→ 文件传到发布页 `demo-assets` → 清单进仓库 → 种子版本 4 | S4、S6b、S9 | 数据 + 配置 |

### 13.2 依赖与并行

```
T ──► S1 ──┬──► S2 ──┬──► S4 ──┐
           ├──► S3 ──┘         │
           ├──► S5 ────────────┤
           └────────► S6b ─────┼──► S9 ──► S10
S6a ──► S7 ─────────► (S6b)    │
S8 ────────────────────────────┘
```

可以同时开工的：Rust 一路（S1 → S2 ‖ S3 → S4）、Python 一路（S6a → S7 → S6b，S6b 等 S1 的向量）、TypeScript 一路（S5，等 S1）、网站（S8，随时）。S6a 和 S7 不能和其他改 `worker/` 的工作同时进行（改名会让并行的改动全部冲突）。

线上发布：S1 合并后发 R1；S2–S9 全部合并、新的九步验收通过后发 R2（种子换成新格式，版本仍是 3）；S10 完成后发 R3。

### 13.3 每步的验收

| 编号 | 验收 |
|---|---|
| T | 三边都跑新的 `shape_material_*`、`uv/` 向量；`cargo test`、`npm test`（sdk、web）、pytest 全过 |
| S1 | 新操作和 `bundle/` 向量三边结果一致；旧的提交、任务、草稿文档（取自现有测试夹具）往返读写不变；接口服务全部测试照过；部署 R1 后线上前厅照常 |
| S2 | 移植自处理服务的场景全部通过：哈希不符、缺片、块大小不对、复用已有资源、并发上传同一内容、空间删了又建、任务失败后收尾、租约丢失后不写回、两个执行器抢同一个任务只有一个写回、停止时退回队列；清理：过期上传和草稿、栅栏（引用和删除交错）、用量成对减回、补打 `publishedAt`、两个进程抢锁；glb 检查：外部 `uri`、`data:` 图片、Draco 扩展、三角形超限、贴图超限、节点成环、骨骼、坐标越界、包围盒和原点（测试里现做最小的 glb）；zip 检查：多个网格、`..` 路径、加密、zip64；1 GiB 扫描的核对内存峰值 < 100 MB（本地实测记进 `api/README.md`） |
| S3 | 重建草稿全套接口的成功和失败路径；实体区草稿不能写重建层、重建草稿不能写扩展层；`clearRebuilt` 后扩展层引用的模板断了要拒绝；`setScan` 首次固定 `frame`、之后不变；两类草稿互不冲突、两个重建草稿冲突；没有变化返回 `unchanged`；资源用途表每一行的正反例；模型一致性检查；`metaverse:rebuild:write` 开关；旧任务接口返回 410；OpenAPI 里出现 7 个新 `operationId`、没有旧的 |
| S4 | 本机 https 测试服务器当 GitHub 和 Scaniverse：新库全流程建空间、下载、打包扫描、发布；已有旧任务的版本什么都不做；版本加一在同一空间追加；主机不在列表、重定向到列表外、哈希不符、清单不合规各自失败且不可重试；5xx 重试；空间不是种子建的不碰 |
| S5 | `bundle check` 的合法和不合法包（复用 `bundle/` 向量）；`bundle push` 对着模拟接口跑通复用、上传、等待、展开、预览、发布、`unchanged`、冲突；sdk 的 lint、typecheck、format、测试、构建全过 |
| S6a | 剩下的 pytest 不连数据库全过；`metaverse-recon prepare` 在前厅上的结果（变换、结构、物体编号）与改动前完全相同 |
| S7 | 只有路径变化（`git diff -M --stat` 全是改名）；全部测试和持续集成通过 |
| S6b | 用现在的 `lobby-authored.json` 打出的包：外部模型 glb 的三角形数、包围盒与处理服务现在写回的一致（容差 1 毫米），逐件偏差与处理服务现在的结果一致；`bundle-check` 与接口服务对同一批坏包给出同样的拒绝 |
| S8 | 网站测试里改动说明的断言更新后通过 |
| S9 | 新的九步验收在本机全过（默认模式）；`check-app`、`check-pins`、`pin-images` 测试过；持续集成全绿；`up.sh --demo-seed` 在新库里只建演示空间（R2 的种子不带包），重建包的上传发布由九步验收覆盖 |
| S10 | 本地全流程（`up.sh --demo-seed`，新库从 Scaniverse 和发布页下载约 25 MB）和线上：时间线有第 1–4 版，能回到第 1–3 版的任何时刻；"优化"视图是第 4 版，"原始"视图的扫描位置与第 3 版重合；分享链接不变；`/api/healthz` 的 `background` 正常 |

---

## 14. 待定

1. **包文件托管**：推荐本仓库发布页 `demo-assets`（7.4 方案 B），需要确认可以用发布页放演示数据。
2. **谁发布重建层**：重建 agent 的 key 默认不含发布（人看过预览再发布），还是也给发布（3.2）。
3. **没有实体区时的范围**：现在定为"不碰虚拟区和地块就行"（2.3），还是要求先定义实体区才能写重建层（那样前厅要先补定义实体区）。
4. **方块化**：二期的 `putChunk` 是否还要做；不做的话"重建层方块"这个概念可以从设计里去掉，方块只留给扩展层。
5. **改名**：`worker/` → `recon/` 是否同意（8.1）。
6. **旧接口的 410 过渡**：保留一个版本是否够。
7. **网页用模型的体积优化**（Draco + 4096² 贴图，7.5）放在什么时候做。
8. **NyxID 服务注册**：注册后命令行就能直接把包发布到线上，种子只用于新库和演示。
