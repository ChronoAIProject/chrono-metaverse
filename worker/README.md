# 处理服务（metaverse-worker）

chrono-metaverse 的后台处理服务（设计第 6 节）：从 MongoDB 的 `jobs` 集合领取任务，做上传校验、扫描对齐、
网页用模型、结构 + 物体重建、体素化、物件模型导出，把结果写成时间线上的提交；同时定期清理过期上传和
没人引用的资源。

- 只有 `store.py`、`assets.py`、`jobs/`、`handlers/` 碰数据库；`processing/` 是纯计算，在子进程里运行；
- 每个任务的重计算放进子进程（`resource.setrlimit` 内存上限 + 超时，可随时取消）；
- 写回按设计 6.4：提交带 `jobId`，同一事务里按 `{_id, attempt, leaseOwner, status: running}` 把任务标记为完成。

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

## 健康检查

`GET /healthz`，端口 `WORKER_HEALTH_PORT`（默认 8080），不需要鉴权：

- 200：索引已建好、主循环在运行、看门狗没有超时；
- 503：启动中（建索引）、正在停止，或主循环停滞。

```json
{"status": "ok", "service": "metaverse-worker", "version": "0.1.0", "workerId": "host-1234-ab12cd",
 "timestamp": "2026-11-09T08:00:00.000Z", "kinds": ["model_import", "rebuild", "scan_import", "upload_verify", "voxelize"],
 "currentJob": {"jobId": "…", "kind": "scan_import", "spaceId": "front-hall", "since": "…"},
 "jobs": {"done": 3, "failed": 0}, "lastCleanup": {"at": "…", "uploads": 0, "assets": 0, "exhaustedJobs": 0}}
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
5. 上传标记 `done` 并写 `assetHash`。

`result = {assetHash, reused, bytes, format, contentType}`，`format` 是 `glb | draco | obj | zip | png | jpeg |
webp | ndjson | ndjson+gzip | text`。

**上传会话文档**（接口服务创建，处理服务读写的字段）：

```
uploads { _id: 上传编号（字符串，也是数据块的 files_id）, spaceId, owner: {kind, id},
          purpose: scan|model|texture|ops|script, size: 声明的总字节数, sha256: 声明的整体哈希, partSize,
          status: open|complete|done|failed|expired, createdAt,
          // 处理服务写入：
          assetHash?, format?, contentType?, verifiedAt?, verifiedSha256?, error?, failedAt? }
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
   贴图 ≤ 1024²。减面用 fast-simplification 的折叠历史，顶点取原始顶点的位置和贴图坐标；
   资源 `metadata.kind = web_model`；
6. **结构 + 物体重建**（`rebuild: false` 时跳过）：结构见 `processing/structure.py`，物体调用
   `processing.objects.reconstruct_objects`（见下）；
7. **一次提交**（事务外先按内容哈希登记资源、物件记录、锚点记录）：

   ```
   scan: { assetHash, webModelHashes: [默认档, 低细节档], transform: [16 个数，列主序] }
   observedAt: 参数里的时间规范化成 UTC 毫秒（YYYY-MM-DDTHH:MM:SS.mmmZ）
   changedEntities: 重建层物件的变化（新增 / 变化写新哈希，消失的写 null）；扩展层不动
   changedAnchors: 新建的锚点（物体的建议锚点编号；已存在的锚点不动）
   assetRefs: 两档网页用模型、所有贴图（原始扫描不登记，见下）
   frame: 空间还没有坐标系时固定为 {fixedAt, referenceScan: assetHash}
   ```

   - **资源引用表**：`assetRefs` 是公开资源接口 `GET /api/public/assets/{hash}.bin` 的白名单（设计 8.2），
     只登记网页要用的资源。原始扫描可能含个人信息，**不登记**，只能经 `/api/v1` 下载；它被提交的
     `scan.assetHash` 引用，定期清理不会删它；
   - **重建层替换规则**：物体重建正常运行时，重建层的全部旧物件（structure / object / template）换成这次的
     结果；物体重建模块导入失败、只交了结构时，只替换 `kind: structure` 的物件，旧物体保留；
   - **锚点**：`kind: object` 且带 `anchorId` 的物体，按编号前缀定类型（`table`/`desk` → table，
     `chair`/`seat`/`sofa`/`bench`/`stool` → seat，`counter`/`reception`/`bar` → counter，`door`、`camera`，
     其他 → zone），`box` = 物体 `bounds` 覆盖的格子（同接口服务 `Aabb::grid_cover`），`visibility: public`，
     `label` 取物体的 `label`；锚点当前状态写进 `anchors`（`{spaceId, id, owner, hash, body, seq}`）；
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
指定的不是当前扫描时，提交里带上这个扫描的 `scan` 引用，让扫描层和重建层一致。结果与当前状态完全相同
时不提交，任务直接完成（`result.unchanged = true`）。`result` 同上（没有 `webModels`）。

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
# structure：同一网格上 extract_structure 的 StructureResult
# params：任务参数里的 hints（没给时是 {}）
result.entities  # {entityId: body}，SHAPES 第 3 节，layer 必须是 rebuilt，kind 是 object 或 template
result.textures  # {sha256 十六进制: 图片字节（jpeg/png/webp）}，被 material.texture 引用
result.metrics  # 任意 JSON，原样放进 result.objects
```

处理服务会校验：body 合法（模板实例按同一批结果里的模板算包围盒）、贴图字节的哈希与键一致、
引用的贴图都随结果给出、编号不和结构元素（`floor`、`wall-*`、`glazing-*`）重复。不合格 → 任务失败
（不可重试）；模块导入失败 → 记录警告、只提交结构。

## 定期清理

后台线程每 `WORKER_CLEANUP_INTERVAL_SECONDS` 秒一次（设计 6.1）：超过 24 小时仍 `open` 的上传先改成 `expired`
再删数据块和会话（`failed` / `expired` 的同样删除）；上传或最近复用超过 7 天、没有被提交、草稿、物件记录、
方块表、资源引用表或未结束任务引用的资源，先删 `files` 文档再删数据块；租约过期且重试次数用完的任务标记失败。

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
- 结构物件 7 个：地面 1（128.3 平方米）、墙 5（含一段斜墙）、玻璃 1。

## 已知限制

- 扫描网格按贴图分块，块边界是开放边界；减面时两侧各自简化，低细节档在块缝处可能有细缝；
- 单独的 `.drc` 扫描没有贴图（Draco 文件不带图片），网页用模型和重建贴图都是灰色；带贴图请上传 zip；
- 多网格的 glb 物件模型由 trimesh 合并（贴图拼成图集），顶点颜色可能丢失；
- 配准只求偏航和平移：扫描本身有倾斜时先由摆正步骤修正（10° 以内）；
- 解析前检查里 Draco 的三角形数要解码后才知道（受子进程内存上限保护）。
