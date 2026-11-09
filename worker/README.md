# 处理服务（metaverse-worker）

chrono-metaverse 的后台处理服务（设计第 6 节）：从 MongoDB 的 `jobs` 集合领取任务，做上传校验、扫描对齐、
网页用模型、结构 + 物体重建、体素化、物件模型导出，把结果写成时间线上的提交；同时定期清理过期上传、
过期草稿（连同草稿区块、预览令牌）和没人引用的资源。

- 只有 `store.py`、`assets.py`、`uploads.py`、`jobs/`、`handlers/` 碰数据库；`processing/` 是纯计算，在子进程里运行；
- 每个任务的重计算放进子进程（`resource.setrlimit` 内存上限 + 超时，可随时取消）；
- 写回按设计 6.4：提交带 `jobId`，同一事务里按 `{_id, attempt, leaseOwner, status: running}` 把任务标记为完成；
  事务后给新引用的区块打 `publishedAt`，没打上的由重新领取和定期清理补做（设计 5.7）。

## 启动

```bash
cd worker
uv venv .venv && uv pip install --python .venv/bin/python -e '.[dev]'

export MONGODB_URI='mongodb://127.0.0.1:27018/?replicaSet=rs0'
export MONGODB_DATABASE=metaverse
.venv/bin/metaverse-worker          # 或 .venv/bin/python -m metaverse_worker
```

启动顺序：读配置（缺必填项或不合法就以退出码 2 退出）→ 起健康检查 → 幂等地建索引（数据库暂时不可用时每
5 秒重试，2 分钟后仍失败就退出，交给平台重启）→ 主循环。收到 `SIGTERM` / `SIGINT` 后不再领取新任务，手上
的任务最多再等 `WORKER_STOP_GRACE_SECONDS` 秒，来不及就取消子进程、把任务退回队列（退还这一次的重试次数）。

数据库必须是副本集（写回用事务）。本地的 MongoDB 副本集见 `infra/dev/`。

### 依赖锁定

`pyproject.toml` 只写版本范围，实际版本锁在 `uv.lock`（用 uv 0.11.32 生成，提交进仓库）。镜像
（`infra/worker/Dockerfile`）有 `uv.lock` 时按 `uv export --frozen` 的锁定版本装，镜像、持续集成、本地用的
就是同一组经过测试的版本，回滚重建旧提交也得到当时的依赖。

```bash
cd worker
uv sync --frozen --extra dev        # 按锁定版本建 .venv（含开发依赖）
uv lock                             # 改了 pyproject.toml 的依赖以后重新锁定，连同 uv.lock 一起提交
uv lock --upgrade-package numpy     # 只升级某一个依赖
```

`tests/test_lockfile.py` 检查 `uv.lock` 覆盖了 `pyproject.toml` 的全部依赖、锁定版本都在声明的范围内；
改了依赖范围却忘了重新锁定时，测试会失败。

## 健康检查

`GET /healthz`，端口 `WORKER_HEALTH_PORT`（默认 8080），不需要鉴权：

- 200：索引已建好、主循环在运行、看门狗没有超时；
- 503：启动中（建索引）、正在停止，或主循环停滞。

```json
{"status": "ok", "service": "metaverse-worker", "version": "0.1.0", "workerId": "host-1234-ab12cd",
 "timestamp": "2026-11-09T08:00:00.000Z", "kinds": ["model_import", "rebuild", "scan_import", "upload_verify", "voxelize"],
 "currentJob": {"jobId": "…", "kind": "scan_import", "spaceId": "front-hall", "since": "…"},
 "jobs": {"done": 3, "failed": 0},
 "lastCleanup": {"at": "…", "exhaustedJobs": 0, "stuckUploads": 0, "uploads": 0, "drafts": 0, "previews": 0,
                 "draftChunks": 0, "assets": 0, "publishedChunks": 0}}
```

## 环境变量

只从环境变量读配置。日志里不输出连接串（配置摘要只有数据库主机名）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MONGODB_URI` | **必填** | `mongodb://` 或 `mongodb+srv://` 连接串（chrono-cd 的 MongoDB 插件注入） |
| `MONGODB_DATABASE` | **必填** | 数据库名 |
| `WORKER_ID` | `主机名-进程号-随机数` | 租约持有者编号，每个进程必须不同 |
| `WORKER_HEALTH_HOST` / `WORKER_HEALTH_PORT` | `0.0.0.0` / `8080` | 健康检查监听地址 |
| `WORKER_LEASE_SECONDS` | 180 | 任务租约时长 |
| `WORKER_HEARTBEAT_SECONDS` | 45 | 续约间隔（必须小于租约的一半） |
| `WORKER_WATCHDOG_SECONDS` | 150 | 主循环 / 续约多久没成功就退出进程（大于续约间隔、不超过租约） |
| `WORKER_POLL_SECONDS` | 2 | 没有任务时多久再查一次 |
| `WORKER_STOP_GRACE_SECONDS` | 20 | 收到停止信号后等手上任务的最长时间 |
| `WORKER_MAX_JOBS_PER_SPACE` | 2 | 每个空间同时运行的任务数上限 |
| `WORKER_JOB_MEMORY_MB` | 6144 | 任务子进程的内存上限（地址空间） |
| `WORKER_JOB_TIMEOUT_SECONDS` | 1800 | 任务子进程超时 |
| `WORKER_CLEANUP_INTERVAL_SECONDS` | 600 | 定期清理的间隔 |
| `WORKER_UPLOAD_TTL_HOURS` | 24 | 超过这么久没完成的上传被清理 |
| `WORKER_ASSET_GRACE_DAYS` | 7 | 超过这么久没被引用的资源被清理 |
| `WORKER_MAX_SCAN_BYTES` | 1 GiB | 扫描资源大小上限 |
| `WORKER_MAX_MODEL_BYTES` | 50 MiB | 物件模型、贴图上传的大小上限 |
| `WORKER_MAX_TRIANGLES` | 500 万 | 解析前检查：三角形数上限 |
| `WORKER_MAX_TEXTURE_PIXELS` | 8192×8192 | 解析前检查：贴图像素上限 |
| `WORKER_MAX_TEXTURE_SIDE` | 8192 | 贴图上传的单边像素上限 |
| `WORKER_MAX_GRID_CELLS` | 4 亿 | 解析前检查：包围盒与实体区的交集 / GRID_UNIT³ 上限 |
| `WORKER_MAX_OPS_BYTES` | 256 MiB | ops 上传解压后的大小上限（防压缩炸弹） |
| `WORKER_MODEL_MAX_TRIANGLES` | 10 万 | 物件模型重新导出的三角形上限 |
| `WORKER_MODEL_MAX_TEXTURE_SIDE` | 2048 | 物件模型重新导出的贴图长边上限 |
| `WORKER_ALIGN_MAX_ERROR_CM` | 3 | 重扫配准误差超过它就不自动提交，转人工 |
| `WORKER_WORKDIR` | 系统临时目录 | 下载扫描、子进程交换数据的本地目录（每个任务一个子目录，结束就删） |
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL` |

## 任务

任务文档（`jobs`）在接口服务的 `Job` 基础上带 `actor: {sub, nyxServiceId}`（发起者，写提交时作为
`actor.sub`、`actor.nyxServiceId`，`actor.scope = physical`、`actor.kind = job`）和 `result`（非提交结果）。
处理服务领取以下五种，**不领取 `ops_from_upload`**（接口服务自己处理）。

失败分类：参数不合法、输入超限 / 格式不对、子进程内存超限或超时 → 不可重试，直接 `failed`；其他错误
（数据库抖动、子进程崩溃等）→ 退回队列，`maxAttempts`（默认 3）用完后 `failed`。`lastError` 写原因。

### `upload_verify` `{uploadId}`

1. 上传已是 `done`：直接完成；状态不是 `complete`：失败；
2. 流式读出全部数据块（`assets.chunks`，`files_id` = 上传编号），核对序号连续、块大小、总长度，边算
   sha256 边写临时文件；不完整或哈希不符 → 上传标记 `failed`、删数据块、任务失败；
3. 按用途嗅探格式（子进程里）：

   | 用途 | 接受 |
   |---|---|
   | `scan`、`model` | glb、drc、obj，或 zip（里面一个 glb / drc / obj + 贴图，如 Scaniverse 导出） |
   | `texture` | png、jpeg、webp，单边 ≤ 8192 |
   | `ops` | NDJSON（每行一个 JSON 对象），可 gzip |
   | `script` | UTF-8 纯文本，不含 NUL |

   不合规同样标记失败、删数据块；
4. 登记资源（`assets.files`：`_id` = 上传编号，`filename` = 内容哈希，`metadata = {sha256, contentType,
   kind: 用途, spaceId, uploadId, format}`）。文件名冲突就删本次数据块、复用已有资源；
5. 同一个事务里：上传标记 `done` 并写 `assetHash`、`storageBytes`，空间的 `storageUsedBytes` 加上上传的大小
   （见"空间存储用量"），任务标记完成。租约丢了就一起放弃，新的持有者重新收尾，不会多计或漏计。

**任务因为别的原因最终失败**（嗅探子进程超时或内存超限、子进程反复崩溃、数据库抖动导致重试次数用完）时，
上传不能一直停在 `complete`：接口服务把 `open`、`complete` 都算作进行中的上传（每个空间的上限、存储上限的
预估），资源可用性也把 `complete` 当成"还在校验"。所以任务标记为 `failed` 以后，主循环马上按
`{_id: uploadId, status: complete}` 条件收尾（`uploads.settle_upload`）：

- 内容已经核对通过（`verifiedSha256` = 声明的哈希）并且这个哈希的资源已经存在 → 补做第 5 步，标记 `done`；
- 否则 → 标记 `failed`，`error = "校验任务失败：<原因>"`，删掉数据块。

主循环来不及做的（重试次数用完由 `reap_exhausted` 回收、进程在标记失败后退出）由定期清理兜底，见下。

`result = {assetHash, reused, bytes, format, contentType}`，`format` 是 `glb | draco | obj | zip | png | jpeg |
webp | ndjson | ndjson+gzip | text`。

**上传会话文档**（接口服务创建，处理服务读写的字段）：

```
uploads { _id: 上传编号（字符串，也是数据块的 files_id）, spaceId, owner: {kind, id},
          purpose: scan|model|texture|ops|script, size: 声明的总字节数, sha256: 声明的整体哈希, partSize,
          status: open|complete|done|failed|expired, createdAt, completedAt?, jobId?: upload_verify 任务编号,
          // 处理服务写入：
          assetHash?, format?, contentType?, verifiedAt?, verifiedSha256?, error?, failedAt?,
          storageBytes?: 计入空间用量的字节数, storageReleasedAt?: 资源被清理、用量已减回的时间 }
```

处理服务只处理 `status: complete` 的上传（接口服务"完成上传"时把 `open` 改成 `complete` 并建任务）。
读取时也接受 `totalSize`、`hash` 作为 `size`、`sha256` 的别名。

### `scan_import` `{assetHash, observedAt?, transform?, rebuild?: true, voxelize?: false, hints?: {...}}`

1. **对齐方式**：给了 `transform`（16 个数，列主序，扫描坐标 → 空间坐标；最后一行必须是 0 0 0 1，
   不能镜像）就直接用；没给时，这个扫描以前提交过就沿用它最近一次的变换；空间还没有 `frame` 就首次自动
   对齐；否则和参考扫描（`frame.referenceScan` 最近一次提交的变换）配准；
2. **首次自动对齐**：朝上的面求平均法线把地面摆正（倾斜 0.05°–10° 时修正）→ 墙面法线模 90° 的面积加权
   直方图峰值（圆周平均精化）绕竖直轴旋转 → 地面高度取低处朝上面的众数 → 原点 = 顶点 x、z 的 0.05% 分位数；
3. **重扫配准**：只用地面和墙的上部（离地 1.1 米以上）；按首次的方法摆正后，主墙 4 个 90° 朝向都试：
   俯视墙占用图做 FFT 互相关得平移初值，再做只求偏航和平移的点到面 ICP（阈值 25→4 厘米、Huber 权重）；
   误差 = 每个稳定点的点到面距离（10 厘米封顶）去掉最差 20% 后的平均。误差超过
   `WORKER_ALIGN_MAX_ERROR_CM`：**不提交**，任务 `done`，

   ```json
   {"needsAlignment": true, "scanAssetHash": "…", "referenceScan": "…", "proposedTransform": [16 个数],
    "errorCm": 4.7, "maxErrorCm": 3, "alignment": {…}, "candidates": [{"quarterTurns": 0, "score": …, "errorCm": …, "overlap": …}], "timings": {…}}
   ```

   人工确认后由接口服务用 `{assetHash, transform}` 重新发起 `scan_import`；
4. **解析前检查**：三角形数、贴图像素（读文件头）、对齐后包围盒与实体区交集的格数；
5. **网页用模型**：两档 glb（单网格、内嵌 JPEG 底色贴图、不压缩、坐标保持扫描原坐标、材质声明
   `KHR_materials_unlit`）：`[0]` ≤ 30 万三角形、贴图 ≤ 4096²（网页加载这一档）；`[1]` ≤ 6 万三角形、
   贴图 ≤ 1024²。减面用 fast-simplification 的折叠历史，顶点取原始顶点的位置和贴图坐标。扫描网格按贴图分块，
   块与块之间的接缝在网格里是开放边界，两侧各自简化会裂出三角形小洞（网页上地面的黑斑），所以先只合并块内部
   的顶点（块边上的顶点都不动，默认档这一步就够了），还不够时把位置相同的顶点焊起来再减面（接缝两侧共用
   顶点，每个面的贴图坐标仍取它原来那块贴图里的）。贴图先按原始网格的贴图坐标标出用到的纹素，缩小时只平均
   用到的纹素，再把块外的空白都换成最近的用到的纹素的颜色（补边），双线性过滤和逐级缩小的贴图不会采到
   块外的深灰底色（见 `processing/webmodel.py`）；资源 `metadata.kind = web_model`；
6. **结构 + 物体重建**（`rebuild: false` 时跳过）：结构见 `processing/structure.py`（地面带贴图；墙是朝房间
   一侧的贴图面板 + 纯色墙体，没扫到的墙面用同一面墙的中位色补；玻璃是浅蓝灰纯色玻璃 + 竖梃 + 窗台，不用贴图；
   墙顶统一高度）。任务参数里的 `hints` 也交给结构：内点大多落在某个提示物体盒子里的大平面（LED 大屏）不当墙，
   靠墙放的提示物体不印进墙面贴图。物体调用 `processing.objects.reconstruct_objects`（见下），效果见
   "前厅重建效果"。`hints` 原样传给物体模块。`hints.objects` 是逐个物体的提示
   （本地 AI 看图给出，最多看前 500 项，格式不对的项忽略）：

   ```
   {center: [x, y, z] 或 [x, z]（空间坐标，米）, kind?: chair|table|sofa|counter|cabinet|…, label?: "会议桌",
    size?: [宽, 高, 深], yaw?: 角度, anchor?: true}
   ```

   `center`、`kind`、`label`、`size`、`yaw` 由物体模块读取（改写分割和类型，`label` 成为物体的标签）；
   `anchor` 由处理服务读取，只对椅子起作用（见下面的"锚点"）；
7. **一次提交**（事务外先按内容哈希登记资源、物件记录、锚点记录）：

   ```
   scan: { assetHash, webModelHashes: [默认档, 低细节档], transform: [16 个数，列主序] }
   observedAt: 参数里的时间规范化成 UTC 毫秒（YYYY-MM-DDTHH:MM:SS.mmmZ）
   changedEntities: 重建层物件的变化（新增 / 变化写新哈希，消失的写 null）；扩展层不动
   changedAnchors: 新建的锚点（只给有意义的物体建，见下；已存在的锚点不动）
   assetRefs: 两档网页用模型、所有贴图（原始扫描不登记，见下）
   frame: 空间还没有坐标系时固定为 {fixedAt, referenceScan: assetHash}
   ```

   - **资源引用表**：`assetRefs` 是公开资源接口 `GET /api/public/assets/{hash}.bin` 的白名单（设计 8.2），
     只登记网页要用的资源。原始扫描可能含个人信息，**不登记**，只能经 `/api/v1` 下载；它被提交的
     `scan.assetHash` 引用，定期清理不会删它。本空间新登记的网页用模型、贴图计入空间存储用量（见下）；
   - **重建层替换规则**：物体重建正常运行时，重建层的全部旧物件（structure / object / template）换成这次的
     结果；物体重建模块导入失败、只交了结构时，只替换 `kind: structure` 的物件，旧物体保留；
   - **锚点**：只给"有意义"的物体建，不再每个物体都建（前厅以前建了 58 个，标签把场景盖住了）。
     `kind: object`、带 `anchorId`（建议的锚点编号，就用它）的物体按类别 `props.category` 决定：

     | 类别 | 锚点类型 |
     |---|---|
     | `table`（桌子） | `table` |
     | `counter`（前台） | `counter` |
     | `sofa`（沙发） | `zone` |
     | `chair`（椅子） | 只在提示里明确要求时建 `seat`（见下） |
     | `cabinet`、`clutter`、`plant`、`lamp`、`pillar`、`round` 等，以及没有类别的物体 | 不建 |

     **椅子的座位锚点**：`hints.objects[]` 里写了 `anchor: true`（必须是布尔值 true）、没写 `kind` 或
     `kind` 是 `chair` / `armchair` / `stool` 的项，按中心点的 x、z 找椅子：中心落在椅子包围盒里或离它
     不超过 0.3 米的算指的是它，几把都符合时取离包围盒最近、再取离盒子中心最近的那把。例如
     `{"center": [2.4, 0.45, 1.0], "kind": "chair", "label": "主持人座位", "anchor": true}`。
     `anchor` 对别的类别不起作用（柜子、杂物等写了也不建）。

     `box` = 物体 `bounds` 覆盖的格子（同接口服务 `Aabb::grid_cover`），`visibility: public`，`label` 用物体
     的中文标签（提示里的 `label`，如"会议桌""前台"），物体没有标签就用类别的中文名（桌子、前台、沙发、
     椅子）；生成后按接口服务 `AnchorBody::validate` 的规则校验（不合格 → 任务失败）。**已存在的锚点不动**：
     同编号的锚点已经有了就不再写，以前按旧规则建的锚点（例如杂物、柜子的）也不会被删掉或改掉。
     锚点当前状态写进 `anchors`（`{spaceId, id, owner, hash, body, seq}`）；
   - **体素化**：`voxelize: true` 时在**同一个事务里插入一个 `voxelize` 任务**（编号
     `<本任务编号>-voxelize`，参数 `{scanAssetHash}`，`parentJobId` 指向本任务），不在本任务里写第二次提交。

`result`（写在任务上，同一事务）：

```json
{"scanAssetHash": "…", "transform": [16 个数],
 "alignment": {"method": "auto|registered|given|reused", "rotationDeg": -61.4, "tiltDeg": 0.09, "errorCm": 0.8, "overlap": 0.95},
 "webModels": [{"hash": "…", "bytes": 12431904, "triangles": 294000, "vertices": 207619, "textureSide": 4096}, {…}],
 "scan": {"triangles": 335661, "vertices": 249134, "textureSide": 8192},
 "structure": {"entities": 7, "walls": 5, "glazing": 1, "floorM2": 128.25, "wallDirections": […]},
 "objects": {"entities": 12, "furnitureMeanCm": 1.9, …} 或 {"skipped": "原因"},
 "entities": {"structure": 7, "objects": 12, "changed": 19, "removed": 0},
 "anchorsCreated": ["counter-01", …], "voxelizeJobId": "…（可选）",
 "timings": {"load": 1.3, "align": 0.5, "webModels": 2.2, "rebuild": 9.2, "total": 13.2}}
```

提交说明形如 `导入扫描 8be81ec5ccf2（首次自动对齐）`。

### `rebuild` `{scanAssetHash?, hints?}`

对指定扫描（默认最新扫描）用它最近一次提交的变换重跑结构 + 物体重建并提交，不重新生成网页用模型。
指定的不是当前扫描时，提交里带上这个扫描的 `scan` 引用，让扫描层和重建层一致。锚点规则同上：可以用
`hints.objects[].anchor: true` 给已经导入的椅子补建座位锚点（物件没变、只有新锚点时也提交）。结果与当前
状态完全相同（物件没变、也没有要新建的锚点）时不提交，任务直接完成（`result.unchanged = true`）。
`result` 同上（没有 `webModels`）。

### `voxelize` `{scanAssetHash?, style?}`

`style` 可以是风格名（字符串，接口服务 `POST .../scans/{scan_id}/voxelize {style}` 和命令行
`metaverse voxelize --style` 传的就是它），也可以是对象 `{paletteSize?}`（直接给颜色数，1–1024，默认 64）：

| 风格名 | 颜色数 |
|---|---|
| `default`（不给 `style` 时也是它） | 64 |
| `coarse` | 16 |
| `fine` | 256 |

不认识的风格名、对象里有别的字段、颜色数超出范围 → 任务失败（不可重试），`lastError` 列出可用的风格名。

按 `GRID_UNIT`（5 厘米）体素化（每格面积约 9 个采样点、线性空间平均色、去掉少于 2 个采样点的格子和小连通块），
空间定义了实体区（`regions` 里 `kind: physical` 的盒子）时只保留实体区里的格子；Lab 空间 k-means 量化成
`paletteSize` 种颜色。方块表只追加：编号 0、1 保留，从 2 开始；当前方块表里颜色相同的
扫描方块（`tags` 含 `scan`）复用编号，否则追加 `{id, name: "扫描色 #rrggbb", kind: solid, color, tags: ["scan"]}`。
区块按 `chunk.py` 编码（32³），写到**重建层**；旧清单里有、新结果里没有的区块写 null；方块表变了才带
`paletteHash`。事务里发现方块表在计算期间变了就放弃、稍后重试。没有变化时不提交（`result.unchanged = true`）。

`result = {scanAssetHash, style?, paletteSize, newBlocks, samples, rawCells, cells, colors, chunks, seconds, paletteHash?, changedChunks}`
（`style` 只在传了风格名时出现）。

### `model_import` `{assetHash}`

读 glb / obj / drc（或含它们的 zip）→ 解析前检查（三角形数、贴图像素、坐标不超过 ±1000 米）→ 超过
`WORKER_MODEL_MAX_TRIANGLES` 就减面、贴图缩到 `WORKER_MODEL_MAX_TEXTURE_SIDE` 以内（有透明就存 PNG，否则
JPEG）→ 重新导出 glb（没有贴图时保留顶点颜色或材质底色）。登记处理后的资源（`metadata.kind = model`，
`metadata.sourceHash` = 原资源），不写提交：

`result = {modelHash, sourceHash, bytes, triangles, vertices, sourceTriangles, textureSide, bounds: {min, max}}`。

## 物体重建接口

物体重建模块 `metaverse_worker/processing/objects.py` 由另一个模块实现，处理服务这样调用（子进程里）：

```python
from metaverse_worker.processing.objects import reconstruct_objects

result = reconstruct_objects(mesh_space, structure, params=hints)
# mesh_space：已用提交里的 transform 变到空间坐标的 ScanMesh（贴图坐标左上角原点）
# structure：同一网格上 extract_structure(mesh_space, hints=hints) 的 StructureResult
# params：任务参数里的 hints（没给时是 {}）
result.entities  # {entityId: body}，SHAPES 第 3 节，layer 必须是 rebuilt，kind 是 object 或 template
#   物体的 props.category 写类别（chair、table、sofa、counter、cabinet、clutter……），决定建不建锚点；
#   anchorId 写建议的锚点编号；label 写中文标签（有提示用提示的 label）
result.textures  # {sha256 十六进制: 图片字节（jpeg/png/webp）}，被 material.texture 引用
result.metrics  # 任意 JSON，原样放进 result.objects
```

处理服务会校验：body 合法（规则与接口服务 `EntityBody::validate` 相同，`records.py`；模板实例按同一批结果里的
模板算包围盒；`label` 不超过 200 个字符、**不能含控制字符**，如换行、制表符）、贴图字节的哈希与键一致、
引用的贴图都随结果给出、编号不和结构元素（`floor`、`wall-*`、`glazing-*`）重复。不合格 → 任务失败
（不可重试）；模块导入失败 → 记录警告、只提交结构。规则必须和接口服务一致：接口服务读取记录时不校验，
但之后草稿对这些物件、锚点做任何修改都会重新校验整个 body，不合格的记录就改不动了。

## 空间存储用量

`spaces.storageUsedBytes`（设计 4.1；接口服务创建上传时按"已用 + 进行中的上传 + 本次大小 > storageLimitBytes"
返回 413）由处理服务累加，都按 `{_id, owner.kind, owner.id}` 条件更新，和引起变化的写入在同一个事务里：

| 时机 | 变化 |
|---|---|
| `upload_verify` 把上传改成 `done`（新登记或复用已有资源都算） | `+size`，上传写 `storageBytes = size` |
| 处理服务写的提交（`scan_import`、`rebuild`）在 `assetRefs` 里**新**登记本空间的派生资源（网页用模型、贴图） | `+资源字节数`（同一空间同一资源只计一次） |
| 定期清理删掉没人引用的资源 | 对每个 `assetHash` 是它、带 `storageBytes`、还没有 `storageReleasedAt` 的上传：写 `storageReleasedAt`，所属空间 `-storageBytes`（减到 0 为止，接口服务按 u64 读） |

不计入的：区块、物件记录、方块表（在各自的集合里，不在 GridFS）；`model_import` 重新导出的模型（它的来源
上传已经计入）。接口服务在"哈希已存在、直接复用"创建上传（创建即 `done`）时也应 `+size` 并写
`storageBytes`，这样资源被清理时能一并减回。

## 定期清理

后台线程每 `WORKER_CLEANUP_INTERVAL_SECONDS` 秒一次（设计 6.1），按顺序：

0. **重试次数用完的任务**：租约过期且重试次数用完的任务标记失败；
1. **上传会话**：先兜底处理停在 `complete`、但校验任务（上传的 `jobId`）已经 `failed` 的上传（任务记录
   不存在、完成上传又超过 24 小时的也算），收尾规则同 `upload_verify` 一节；然后超过
   `WORKER_UPLOAD_TTL_HOURS`（24 小时）仍 `open` 的上传先改成 `expired` 再删数据块和会话（`failed` /
   `expired` 的同样删除）；
2. **草稿、草稿区块、预览令牌**（设计 5.6、13.2）：接口服务把 `drafts`、`draftChunks`、`previews` 的
   `expiresAt` 写成 RFC 3339 字符串、不建 TTL 索引，由处理服务按 `expiresAt < 现在`（字符串比较）删除：
   过期的草稿（`open` 和已发布的都删；草稿 30 天过期）先删草稿本身，再删它的预览令牌和草稿区块
   （`{draftId, spaceId}`）；预览令牌（最长 7 天）和草稿区块再各自按自己的 `expiresAt` 扫一遍。每轮最多
   200 个草稿；
3. **没人引用的资源**：上传或最近复用超过 `WORKER_ASSET_GRACE_DAYS`（7 天）、没有被引用的资源，先删 `files`
   文档再删数据块，再把计过用量的上传从各自空间的 `storageUsedBytes` 里减回（见上）。草稿在第 2 步先删，
   过期草稿引用的资源本轮就不再算被引用；
4. **补打区块的 `publishedAt`**（设计 5.7："幂等，失败可以补做"）：最近 48 小时的提交（处理服务和接口服务
   写的都算，按空间走 `(spaceId, at)` 索引）引用、还没有 `publishedAt` 的区块，按提交的 `at` 补上。写回在
   事务提交之后才打 `publishedAt`，进程恰好在两步之间退出时，这些区块在公开接口上会一直 404。任务被重新
   领取、发现已经有提交时也先补打一次再标记完成。

处理服务启动时也幂等地建 `drafts`、`draftChunks`、`previews` 的 `expiresAt` 索引（名字和定义与接口服务相同）。
健康检查的 `lastCleanup` 带每一项处理了多少：`{at, exhaustedJobs, stuckUploads, uploads, drafts, previews,
draftChunks, assets, publishedChunks}`。

资源"被引用"指出现在下面任何一处：

| 集合 | 字段 |
|---|---|
| `assetRefs` | `hash` |
| `commits` | `scan.assetHash`、`scan.textureHash`、`scan.webModelHashes`、`opsRef`、`scriptRef` |
| `records` | `body.assetHash`、`body.textures` |
| `palettes` | `blocks.texture.top / side / bottom` |
| `drafts`（接口服务的草稿文档） | `opsRefs.assetHash`（经上传追加的操作文件）、`assets` |
| 排队中 / 运行中的 `jobs` | `params` 里任意位置的字符串 |

## 测试

```bash
cd worker
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/python -m pytest -q                 # 全部（需要本地 MongoDB 副本集的会自动跳过）
.venv/bin/python -m pytest -q -m mongo        # 只跑集成测试
METAVERSE_TEST_MONGODB_URI='mongodb://127.0.0.1:27018/?replicaSet=rs0' .venv/bin/python -m pytest -q
```

集成测试每个用例建一个随机库，结束时删除。`tests/fake_objects.py` 是物体重建的假实现，集成测试把
`handlers.scan.OBJECTS_TARGET` 换成它（其中一个用例在真实子进程里导入它）。

## 实测：公司前厅扫描

输入：Scaniverse 导出的 Draco 网格（24.9 万顶点、33.6 万三角面）+ 8192² 贴图，打成 zip（5.9MB）上传。
本地 4 核机器，真实子进程（内存上限 6144MB），物体重建模块不存在时跳过（只交结构）。

| 步骤 | 耗时 | 说明 |
|---|---|---|
| `upload_verify` | 1.1 秒 | 1 个 8MiB 分片（23 个 256KiB 数据块），格式识别为 zip（drc + 贴图） |
| `scan_import` | 14.7 秒 | 读取 1.3 秒、对齐 0.5 秒、网页用模型 2.2 秒、结构重建 9.2 秒，其余是下载、登记、提交 |
| `voxelize` | 5.6 秒 | 163,889 格、64 种颜色、195 个区块 |

- 子进程峰值内存（RSS）：1,263MB；
- 自动对齐：绕竖直轴 −61.42°，摆正倾斜 0.09°；对齐后范围约 11.7 × 3.3 × 17.4 米；
- 网页用模型：`[0]` **12.4MB**（29.4 万三角形、贴图 4096²）；`[1]` 2.4MB（5.9 万三角形、贴图 1024²）；
  改成接缝不裂开的减面 + 贴图补边以后：`[0]` 13.4MB、`[1]` 2.5MB，这一步单独测约 8 秒（原来 2.2 秒）；
  俯视渲染地面区域露出背景的像素比例 `[0]` 3.5% → 1.8%、`[1]` 13.8% → 1.7%（原始全分辨率网格本身是 1.8%，
  扫描里本来就有的洞），比原始网格同一像素明显变暗的 `[0]` 0.05% → 0.001%、`[1]` 0.45% → 0.22%
  （其中补边让 `[1]` 从 0.37% 降到 0.22%）；
- 结构物件 7 个：地面 1（128.3 平方米）、墙 5（含一段斜墙）、玻璃 1。

## 前厅重建效果（验收脚本）

```bash
cd worker
.venv/bin/python scripts/reconstruct_lobby.py --scan <mesh.drc> --texture <tex.jpg> --out <输出目录> \
    --hints scripts/lobby_hints.json --render --three <three 包目录>
```

对比图和指标在 `scripts/results/`（`compare_*.jpg` 左边是扫描、右边是重建，剖切掉 2.3 米以上；
`lobby_metrics.json`）。对比图查看页（`scripts/viewer/index.html`）里带贴图的部分不打光（贴图本身带着扫描的
烘焙光照），纯色部件按网站同样的材质、灯光和 ACES 色调映射着色，所以纯色部件的明暗就是网站上的样子。

| 指标 | 结果 | 要求 |
|---|---|---|
| 家具区平均偏差 `furnitureZone.meanCm`（第 3 轮口径） | 2.63 厘米（90% 分位 6.23，3 厘米内 70.3%） | ≤ 3 厘米 |
| 物体 + 结构合计 `sizes.allTotalBytes` | 371,720 字节（约 0.37MB；物体贴图 16 张 88KB，结构贴图 227KB） | ≤ 3MB |
| 物体重建耗时 | 约 36 秒（4 核） | — |

做得好的：

- **前台**：外壳是折面放样 + 台面 + 工作台面，踢脚线内收、黑色，白色外壳在网站灯光下是白的
  （浅色单一材质取最亮的 10%，接近白色的中性色按白色处理）；
- **LED 大屏**：正面一块贴图面板（画面完整，底下的程序坞也在），后面是深色机身，两侧音箱、底座、
  地上的盒子各是一个圆角盒；从背面看是黑色机身，不再印镜像的画面；
- **沙发**：底座 + 分块坐垫 + 分块靠背垫 + 卷边扶手，一个面料颜色；
- **会议桌**：跑道形大理石台面，两端两个规整的木头柱脚；桌上的东西底面贴着台面；
- **墙、玻璃**：墙是朝房间一侧的贴图面板 + 纯色墙体，玻璃是纯色玻璃 + 竖梃 + 窗台。

已知不足：

- **入口的门框**（`cabinet-02`：木门板 + 玻璃隔断 + 门头横条）仍是分层挤出：门头那一段按 1.3–2.6 米整段
  挤出，像一块从半空挂下来的斜板，俯视是一条灰色的 S 形带；试过按竖直平面分块，扫描里玻璃隔断的点太散，
  效果更差，没有采用；
- **展示柜**是一块纯黑的圆角盒：面上是镜子，扫描里是房间的倒影，没有分出隔板；
- **会议椅**的靠背是一圈 C 形厚带，比实物粗；一把被桌子挡住的椅子（`chair-04`）和桌边的点混在一起，
  拟合成一个怪样子（自身偏差 11 厘米）；
- **桌上的东西**是几块浅灰的多边形块，比实物（纸、袋子）规整、也更"实"；
- 窗边转角的高柜子（`cabinet-06`）是分层挤出 + 贴图，侧面有台阶状的边；
- 白色前台以外的纯色部件（沙发、椅子）用扫描的中位色，网站的灯光偏暗，背光的面会比扫描暗一些；
- 拿掉误检的墙（LED 大屏）、靠墙物体不印进墙面，都只对提示里写明的物体有效。

### 物体提示的坐标系（部署配置种子）

`scripts/lobby_hints.json` 是在 `scripts/reconstruct_lobby.py` 的坐标系里标的：那个脚本用 `processing.scan.compute_alignment`
（只绕竖直轴旋转，地面取 y 的 1% 分位，原点取 x、z 的最小值）。`scan_import` 首次导入用的是 `processing.align.auto_align`
（先摆正倾斜，地面取低处朝上面的众数，原点取 x、z 的 0.05% 分位），前厅扫描在两者之间差 (−0.286, −0.050, −0.258) 米平移和
0.09° 倾斜。提示框只向外放宽 3 厘米，直接拿来用会认领错的点。处理服务里实测（任务结果 `objects.furnitureMeanCm`，与
`lobby_metrics.json` 的 `objects.furnitureMeanCm` 同一口径；表里的 `furnitureZone.meanCm` 是另一种口径，不能拿来比）：

| 提示 | 家具平均偏差 | 90% 分位 | 物体数 | 说明 |
|---|---|---|---|---|
| `reconstruct_lobby.py` 自己的坐标系（`lobby_metrics.json`） | 3.08 厘米 | 8.12 | 41 | 基准 |
| 处理服务坐标系，换算后（部署配置种子） | 3.14 厘米 | 8.41 | 41 | 入口附近一块 13 厘米厚的薄板被规则识别成"前台"（多一个锚点） |
| 处理服务坐标系，不换算 | 4.51 厘米 | 11.51 | 59 | 沙发、桌子、前台重复识别；LED 大屏的提示没对上，又被当成墙 |

所以部署配置种子（`infra/chrono-cd/demo-seed.json` 的 `hints`）里的是换算后的坐标，由 `scripts/demo_seed_hints.py` 生成：
它在同一份扫描上分别算两种对齐，按 `M_auto · M_compute⁻¹` 换算物体中心（尺寸不变，`yaw` 加上偏航差），并打印处理服务将得到的
`transform`（导入后和任务 `result.transform` 对照，本地全流程实测完全一致）。

```bash
.venv/bin/python scripts/demo_seed_hints.py --scan mesh.drc --texture tex.jpg \
    --hints scripts/lobby_hints.json --seed ../infra/chrono-cd/demo-seed.json     # --check 只核对
```

## 已知限制

- 低细节档减面时要跨过贴图块的接缝（块边上的顶点太多，只合并块内部减不到 6 万），跨过接缝的大三角形上
  贴图有拉伸（地面能看出成片的模糊三角形，但没有洞）；默认档不受影响；
- 单独的 `.drc` 扫描没有贴图（Draco 文件不带图片），网页用模型和重建贴图都是灰色；带贴图请上传 zip；
- 多网格的 glb 物件模型由 trimesh 合并（贴图拼成图集），顶点颜色可能丢失；
- 配准只求偏航和平移：扫描本身有倾斜时先由摆正步骤修正（10° 以内）；
- 解析前检查里 Draco 的三角形数要解码后才知道（受子进程内存上限保护）。
