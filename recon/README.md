# 本地重建工具（metaverse-recon）

chrono-metaverse 的重建都在本地做（人或 AI 的电脑，Mac 也行，不需要显卡）：对齐、网页用模型、结构和物体、
AI 物件集（外部模型下载和重新导出、烘焙、逐件偏差）、建议锚点，结果打成重建包，由命令行 `metaverse` 推送到
接口服务。服务端只做鉴权、存储、时间线和通用把关，不含任何"某类场景怎么重建"的知识（设计
[`docs/design/server-slim.md`](../docs/design/server-slim.md)）。

原来的处理服务（从 MongoDB 领取任务、写回提交、定期清理）已经下线：上传核对、过期清理、中断任务的回收都并进了
接口服务的后台执行器（`api/README.md`）。这个目录只剩本地部分，所有模块只读写本地文件，**不连接数据库，也不连接
本服务**，不需要任何凭证。

- `processing/`：纯计算（扫描读取与对齐、网页用模型、结构、物体、AI 物件集、体素化、物件模型），解析前检查的
  上限在 `processing/limits.py`；
- `bundle/`：重建包的本地部分——`anchors`（按类别建议锚点）、`sources`（下载外部模型）、`rebuild`（一份扫描 →
  重建结果，见"重建流程"）、`models`（外部模型找本地文件或下载、导出）、`textures`（物件集贴图的三种写法 →
  进包的贴图）、`scanzip`（按部署种子的规则打扫描 zip）、`manifest`（清单、`rb.` 编号、种子过滤）、`build` 和
  `snapshot`（打包的编排）、`limits`（上传上限 `limits.json`）；
- `bench/`：重建工作台 `metaverse-recon`（给 AI 模型师用的眼睛、尺子和裁判，见"重建工作台"）；
- `canonical`、`chunk`、`shapes`、`records`：与接口服务（Rust）、网站、命令行（TypeScript）共用的数据格式
  （[`docs/SHAPES.md`](../docs/SHAPES.md)）；`authored`：AI 物件集的解析和校验；`fetch`：按主机列表下载。

本地流水线的命令（设计 8.3）：`align`、`webmodel`、`models`、`bake`、`fit`、`scan-zip`、`bundle`（写清单
`manifest.json`、编号加 `rb.`、`--seed`、`--from-snapshot`，最后调用 `metaverse bundle check`）、`doctor --install`，
在命令行工作区里往上找 `space.json` 定默认值，见"本地流水线"；贴图工作台 `refshot`、`texture`、`texsearch`、
`texfetch` 见"贴图工作台"。

## 安装

```bash
cd recon
uv sync --frozen --extra dev        # 按 uv.lock 的锁定版本建 .venv（含开发依赖）
.venv/bin/metaverse-recon doctor    # 渲染要用的 node、three、Playwright、Chromium、中文字体在不在
```

Python 3.13；依赖 numpy、scipy、pillow、trimesh、DracoPy、fast-simplification，都有 macOS（Apple 芯片和 Intel）
和 Linux 的预编译包，不需要编译器和显卡。渲染另要 node 22、Playwright 和 Chromium。

不在平台仓库里时（AI 模型师的电脑）：

```bash
uv tool install "git+https://github.com/ChronoAIProject/chrono-metaverse@<标签>#subdirectory=recon"
metaverse-recon doctor --install    # three、playwright-core 装进 <缓存>/node/，Chromium 装进 <缓存>/ms-playwright/
metaverse-recon doctor              # "render": "可用"
```

`doctor --install` 要 node 22 以上和 npm，装固定版本的 three 0.184.0、playwright-core 1.58.2 和与它配套的 Chromium；
缓存目录里已经有的跳过（只看缓存目录，别处装的不算）。从本地路径 `uv tool install ./recon` 时 setuptools 会在
源码目录里留下 `recon/build/` 和 `recon/src/metaverse_recon.egg-info/`，装完删掉。

### 依赖锁定

`pyproject.toml` 只写版本范围，实际版本锁在 `uv.lock`（用 uv 0.11.32 生成，提交进仓库）。持续集成和本地都按
`uv sync --frozen` 装，用的是同一组经过测试的版本，回到旧提交也得到当时的依赖。

```bash
cd recon
uv lock                             # 改了 pyproject.toml 的依赖以后重新锁定，连同 uv.lock 一起提交
uv lock --upgrade-package numpy     # 只升级某一个依赖
```

`tests/test_lockfile.py` 检查 `uv.lock` 覆盖了 `pyproject.toml` 的全部依赖、锁定版本都在声明的范围内；
改了依赖范围却忘了重新锁定时，测试会失败。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `METAVERSE_RECON_MODEL_HOSTS` | `dl.polyhaven.org,huggingface.co,cdn-lfs.huggingface.co,.hf.co` | 外部模型、外链贴图、扫描成员允许下载的主机（逗号分隔；打包、`scan-zip` 和工作台的检查用同一份列表和规则）：写主机名精确匹配（只许默认的 443 端口），以点开头（如 `.hf.co`）匹配它的所有子域名，`主机:端口` 只匹配那个端口。只用 https，重定向的每一跳都要在列表里 |
| `METAVERSE_RECON_MAX_TEXTURE_BYTES` | 16 MiB | 物件集里一张外链贴图下载的大小上限 |
| `METAVERSE_RECON_*`、`SKETCHFAB_TOKEN` | — | 重建工作台的缓存、渲染工具、字体等，见"重建工作台" |

解析前检查的上限是 `processing/limits.py` 的常量（原来是处理服务的 `WORKER_MAX_*` 配置，默认值不变）：

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_SCAN_BYTES` | 1 GiB | 扫描大小上限；zip 解压后合计 ≤ 它的 2 倍 |
| `MAX_TRIANGLES` | 500 万 | 读网格前检查：三角形数 |
| `MAX_TEXTURE_PIXELS` | 8192×8192 | 读网格前检查：贴图像素 |
| `MAX_TEXTURE_SIDE` | 8192 | 贴图单边像素 |
| `MAX_GRID_CELLS` | 4 亿 | 包围盒与实体区的交集 / GRID_UNIT³ |
| `MAX_OPS_BYTES` | 256 MiB | 操作文件（NDJSON，可 gzip）解压后的大小 |
| `MAX_MODEL_BYTES` | 50 MiB | 一个外部模型（含附属文件） |
| `MODEL_MAX_TRIANGLES`、`MODEL_MAX_TEXTURE_SIDE`、`MODEL_MAX_TEXTURE_PIXELS` | 10 万、2048、4×2048² | 物件模型重新导出的三角形数、贴图长边、全部贴图的像素合计（打包时取 `limits.json` 里 `model` 的上限，没有就用这些值） |

## 本地流水线（命令）

在命令行 `metaverse init` 建的工作区里做（有 `space.json`；`metaverse pull --scan` 写 `scan/scan.zip` 和
`scan/transform.json`，`pull` 写 `limits.json`）。`metaverse-recon` 从当前目录往上找 `space.json` 定默认值
（`bench/workspace.py`）；不在工作区里时路径都要显式给。

| 参数 | 工作区里的默认值 |
|---|---|
| `--scan` | `scan/scan.zip` |
| `--transform` | `scan/transform.json`（`{transform: [16 个数], source: "pull" \| "align", seq}`） |
| `--limits` | `limits.json`（没有就用内置默认值，与服务端默认相同） |
| `--base`（基线） | `out/recon/` |
| `--out`（包目录） | `out/bundle/`，打包报告写在旁边的 `out/bundle-report.json` |
| 清单的 `base` | `space.json` 的 `{spaceId, seq}`（`--no-base` 不写） |

| 命令 | 作用 |
|---|---|
| `align` | 首次自动对齐，或 `--reference <参考扫描> --reference-transform <文件>` 重扫配准；写 `scan/transform.json`（`source: "align"`）。配准误差超过 `--max-error-cm`（默认 3）时退出码非 0，输出建议的变换和候选 |
| `prepare` | 基线（见"重建工作台"）；工作区里有 `scan/transform.json` 时默认用它，`--auto-align` 重新自动对齐 |
| `webmodel` | 两档网页用模型 `scan-0.glb`、`scan-1.glb`（保持扫描原坐标，见"重建流程"第 5 步） |
| `models` | 物件集里的外部模型：先在缓存（`fetch` 下的）和 `--models-dir` 里按 sha256 找，没有才下载（`--offline` 不下载）→ 导出 glb（见"AI 物件集"第 3 步），输出 `<哈希前 12 位>.glb` 和 `models.json`；`--render` 每个导出出一张转台对照图（导出后 \| 原文件） |
| `bake` | 物件集里带 `bake` 的部件从扫描取色写成贴图，输出新的物件集（贴图写成 `{file}` 引用） |
| `fit` | 逐件偏差（与 `compare`、打包写进记录的 `fit` 同一个函数） |
| `scan-zip` | 扫描成员按部署种子（接口服务 `pack.rs`）的规则打成 zip：不压缩、固定的时间、按给出的顺序。`--sources sources.json --hash <键>` 按来源表下载成员，`--member 名=文件` 用本地文件；打出来的哈希与 `--hash` 不同就报错 |
| `bundle` | 打包，见下 |

**`bundle`**（设计 6.1–6.4、6.8，清单格式 SHAPES 7）：

- `--authored <物件集>`（或 `--algorithm`：直接用算法的结构和物体）→ 重建流程（`bundle.rebuild`）：外部模型导出、
  外链贴图下载、`{file}` 本地贴图、烘焙、逐件偏差、建议锚点 → 网页用模型（`--webmodel <文件>` 用已有的，可以给两次；
  不给就生成）→ 扫描 zip 原样进包 → 包目录：`manifest.json` 和 `scan/`、`web/`、`models/`、`textures/`、`notes.md`；
- 编号统一加 `rb.`（模板引用一起改）；物件集里贴图的三种写法（哈希、`{url, sha256, size}`、`{file}`）都换成进包的
  贴图文件的哈希，超过上限的图缩小、重新编码；记录按规范化 JSON 写，每条 ≤ 64 KiB；
- 清单的 `report` 带逐件偏差；`notes`（建模记录）写成 `notes.md`；
- `--seed`：种子用的包（会公开，设计 6.8）：去掉内部级锚点和建模记录，`report` 只留偏差；
- `--from-snapshot <工作区>`：用 `metaverse pull --share … --assets` 拉下来的快照（重建层物件、模板、扫描元数据）生成
  整体替换的包，不读扫描、不重建；物件模型和贴图在快照的 `assets/` 和 `--textures-dir` 里按哈希找，缺了就报错；
- 文件按 `limits.json` 各用途的上限检查（大小、三角形、贴图），清单整体不超过 `bundle.maxBytes`；
- 最后调用 `metaverse bundle check <包目录> [--seed]`（`PATH` 里有 `metaverse` 时；没有就打印要运行的命令），没通过时
  退出码非 0。之后用 `metaverse bundle push` 推送。

前厅（`infra/chrono-cd/demo/lobby-authored.json`，给了现有的网页用模型）：物件 52 件、模板 1 个、建议锚点 5 个、
物件模型 8 个（10 件外部模型物件，只差偏航的共用一个）、贴图 23 张，包 24 MB，4 核约 30 秒；`metaverse bundle check`
通过。外部模型的三角形数和摆好以后的包围盒与原来处理服务写回的结果一致（最大差 0.17 毫米），逐件偏差 52 件里 51 件
完全相同（`chair-06` 的 90% 分位差 0.01 厘米）。

## 重建流程（`bundle.rebuild.rebuild_scan`）

一份扫描（zip、glb、drc、obj）→ 重建包要放的东西。步骤和原来处理服务的"导入扫描"相同，只是结果留在本地
（普通数据 + 工作目录里的文件），不写提交：

```python
from metaverse_recon.bundle.rebuild import rebuild_scan

out = rebuild_scan("scan.zip", "work/", hints=hints)  # 首次自动对齐、算法结构和物体
out = rebuild_scan("rescan.zip", "work2/", transform=transform)  # 用给定的变换
out = rebuild_scan("scan.zip", "work3/", transform=transform, authored=authored, known_textures=local)
```

1. **对齐方式**：给了 `transform`（16 个数，列主序，扫描坐标 → 空间坐标；最后一行必须是 0 0 0 1，不能镜像）就
   直接用；给了 `reference = {path, transform}`（参考扫描和它的变换）就和参考扫描配准；都没给时首次自动对齐；
2. **首次自动对齐**：朝上的面求平均法线把地面摆正（倾斜 0.05°–10° 时修正）→ 墙面法线模 90° 的面积加权
   直方图峰值（圆周平均精化）绕竖直轴旋转 → 地面高度取低处朝上面的众数 → 原点 = 顶点 x、z 的 0.05% 分位数；
3. **重扫配准**：只用地面和墙的上部（离地 1.1 米以上）；按首次的方法摆正后，主墙 4 个 90° 朝向都试：
   俯视墙占用图做 FFT 互相关得平移初值，再做只求偏航和平移的点到面 ICP（阈值 25→4 厘米、Huber 权重）；
   误差 = 每个稳定点的点到面距离（10 厘米封顶）去掉最差 20% 后的平均。误差超过 `align_max_error_cm`（默认 3）
   时**不往下做**，返回

   ```json
   {"needsAlignment": true, "proposedTransform": [16 个数], "errorCm": 4.7, "maxErrorCm": 3,
    "alignment": {…}, "candidates": [{"quarterTurns": 0, "score": …, "errorCm": …, "overlap": …}], "timings": {…}}
   ```

   人确认（或改正）以后用 `transform` 重来；
4. **解析前检查**：三角形数、贴图像素（读文件头）、对齐后包围盒与实体区交集的格数（`physical_boxes`，没给时
   是整个包围盒）。贴图像素在任何解码之前检查：glb 的每张贴图不论放在 BIN 块、`data:` 数据块还是 `data:` 图片里
   都读文件头查尺寸，引用外部文件或读不到对应位置的直接拒绝；zip 里单独给的贴图在加载模型之前就查（obj 的材质
   可能引用它）；trimesh 打开的贴图在转成数组之前再按尺寸查一次。PIL 自带的解压炸弹检查按 `MAX_TEXTURE_PIXELS`
   打开（超过两倍时 `Image.open` 直接报错），作为兜底；
5. **网页用模型**（`web_models=True`）：两档 glb（单网格、内嵌 JPEG 底色贴图、不压缩、坐标保持扫描原坐标、材质
   声明 `KHR_materials_unlit`）：`[0]` ≤ 30 万三角形、贴图 ≤ 4096²（网页加载这一档）；`[1]` ≤ 6 万三角形、
   贴图 ≤ 1024²。减面用 fast-simplification 的折叠历史，顶点取原始顶点的位置和贴图坐标。扫描网格按贴图分块，
   块与块之间的接缝在网格里是开放边界，两侧各自简化会裂出三角形小洞（网页上地面的黑斑），所以先只合并块内部
   的顶点（块边上的顶点都不动，默认档这一步就够了），还不够时把位置相同的顶点焊起来再减面（接缝两侧共用
   顶点，每个面的贴图坐标仍取它原来那块贴图里的）。贴图先按原始网格的贴图坐标标出用到的纹素，缩小时只平均
   用到的纹素，再把块外的空白都换成最近的用到的纹素的颜色（补边），双线性过滤和逐级缩小的贴图不会采到
   块外的深灰底色（见 `processing/webmodel.py`）；
6. **结构 + 物体重建**：结构见 `processing/structure.py`（地面带贴图；墙是朝房间一侧的贴图面板 + 纯色墙体，
   没扫到的墙面用同一面墙的中位色补；玻璃是浅蓝灰纯色玻璃 + 竖梃 + 窗台，不用贴图；墙顶统一高度）。提示
   `hints` 也交给结构：内点大多落在某个提示物体盒子里的大平面（LED 大屏）不当墙，靠墙放的提示物体不印进墙面
   贴图。物体调用 `processing.objects.reconstruct_objects`（见"物体重建接口"），效果见"前厅重建效果"。
   `hints` 原样传给物体模块。`hints.objects` 是逐个物体的提示（本地 AI 看图给出，最多看前 500 项，格式不对的项
   忽略）：

   ```
   {center: [x, y, z] 或 [x, z]（空间坐标，米）, kind?: chair|table|sofa|counter|cabinet|…, label?: "会议桌",
    size?: [宽, 高, 深], yaw?: 角度, anchor?: true}
   ```

   `center`、`kind`、`label`、`size`、`yaw` 由物体模块读取（改写分割和类型，`label` 成为物体的标签）；`anchor`
   由锚点建议读取，只对椅子起作用（见下面的"锚点"）。物体重建模块导入失败、只交了结构时，结果的
   `objectsSkipped` 写明原因：这时只有结构可信，打包时不能把它当成整个重建层；
7. **AI 物件集**（给了 `authored`）：重建层的物体不由算法重建，换成物件集里的物件，见下一节；
8. **核对**：每张贴图、每个处理后的模型都按内容核对哈希，网页用模型算出哈希；
9. **锚点**（`bundle/anchors.py`）：只给"有意义"的物体建议锚点，不再每个物体都建（前厅以前建了 58 个，标签把
   场景盖住了）。`kind: object`、带 `anchorId`（建议的锚点编号，就用它）的物体按类别 `props.category` 决定：

   | 类别 | 锚点类型 |
   |---|---|
   | `table`（桌子） | `table` |
   | `counter`（前台） | `counter` |
   | `sofa`（沙发） | `zone` |
   | `chair`（椅子） | 只在提示里明确要求时建 `seat`（见下） |
   | `cabinet`、`clutter`、`plant`、`lamp`、`pillar`、`round` 等，以及没有类别的物体 | 不建 |

   **椅子的座位锚点**：`hints.objects[]` 里写了 `anchor: true`（必须是布尔值 true）、没写 `kind` 或 `kind` 是
   `chair` / `armchair` / `stool` 的项，按中心点的 x、z 找椅子：中心落在椅子包围盒里或离它不超过 0.3 米的算指的
   是它，几把都符合时取离包围盒最近、再取离盒子中心最近的那把。例如
   `{"center": [2.4, 0.45, 1.0], "kind": "chair", "label": "主持人座位", "anchor": true}`。`anchor` 对别的类别
   不起作用（柜子、杂物等写了也不建）。

   `box` = 物体 `bounds` 覆盖的格子（同接口服务 `Aabb::grid_cover`），`visibility: public`，`label` 用物体的中文
   标签（提示里的 `label`，如"会议桌""前台"），物体没有标签就用类别的中文名（桌子、前台、沙发、椅子）；生成后
   按接口服务 `AnchorBody::validate` 的规则校验（不合格就失败）。这只是建议：写进重建包的 `anchors`，服务端按
   `ifNew` 只建本空间时间线上从没出现过的锚点，已经有的、曾经有过又被删掉的都不动。

返回：

```json
{"transform": [16 个数],
 "alignment": {"method": "auto|registered|given", "rotationDeg": -61.4, "tiltDeg": 0.09, "errorCm": 0.8, "overlap": 0.95},
 "boundsSpace": {"min": […], "max": […]},
 "scan": {"triangles": 335661, "vertices": 249134, "textureSide": 8192},
 "webModels": [{"hash": "…", "path": "work/task/web-0.glb", "bytes": 12431904, "triangles": 294000, "vertices": 207619, "textureSide": 4096}, {…}],
 "entities": {"floor": {…}, "chair-01": {…}}, "structureIds": […], "objectIds": […], "objectsSkipped": null,
 "metrics": {"structure": {"walls": 5, …}, "objects": {"furnitureMeanCm": 1.9, …}},
 "textures": {"<sha256>": "图片字节"}, "models": {"<sha256>": {"path": "…", "bytes": …, "triangles": …}},
 "existingTextures": ["本地已有、被物件集引用的贴图哈希"],
 "anchors": {"table-01": {"anchorId": "table-01", "kind": "table", "box": […], "label": "会议桌", "visibility": "public"}},
 "notes": "物件集的建模过程记录或 null", "authored": "物件集的统计（见下）或 null",
 "timings": {"load": 1.3, "align": 0.5, "webModels": 2.2, "rebuild": 9.2, "total": 13.2}}
```

`path` 都在工作目录里，删掉工作目录之前要拷走。

### AI 物件集（`authored`）

本地的 AI（大语言模型）逐件完成物件：先去模型库找一个看起来差不多的现成模型摆进扫描里对照，找不到或差太多
的定制件再手写参数形状；`metaverse-recon assemble` 把整套物件合并成一个 JSON（规范化后 ≤ 4MB），交给
`rebuild_scan(..., authored=物件集)`，重建层就换成这些物件。

```json
{ "version": 1,
  "templates": [ 模板物件 body（kind "template"）... ],
  "entities":  [ 物件 body ... ],
  "notes": "建模过程记录（可选，≤ 64KB）",
  "structure": "keep" }
```

| 部分 | 规则 |
|---|---|
| 坐标 | 空间坐标，与这份扫描的对齐结果相同（重建工作台 `prepare` 的坐标系） |
| 物件 | SHAPES 3 的 body，`layer` 省略时按 `rebuilt`（只能是 rebuilt）；`kind` 是 object 或 structure（模板放 `templates`）；`bounds` 可省略；`fit`、`textures` 一律重算；不能带 `assetHash`（外部模型用 `model`）；≤ 2000 个物件、≤ 200 个模板，编号不重复 |
| 烘焙指令 | 材质里 `"bake": "planar" \| "box" \| "cylindrical"`，不能和 `texture`、`uv`、`tint`、`tile`、`offset`、`rotate`、`normalMap`、`normalScale`、`roughnessMap` 同时出现（烘焙出的是一张按包围盒铺满的颜色贴图），可以带 `color` 作为后备；`opacity`、`unlit`、`shading`、`roughness`、`metalness` 烘焙后原样保留。按网站同样的投影展开 UV（同一个材质节点下的部件共用一张图），每个纹素取扫描最近表面（法线相容优先）的颜色，push-pull 补洞，编码成 JPEG 贴图，材质换成 `{texture, uv}`；附近完全没有扫描时退回后备纯色。模板里不能带（模板在局部坐标里）；≤ 500 处 |
| 外部模型 | 没有 `shape`，带 `model: {url, sha256, size, format}`、`transform`（含 `scale`）、`props.source`、可选的 `material: {tint, opacity, unlit, shading}`（`tint` 烘进模型；`opacity`、`unlit`、`shading` 原样留在处理后物件的 `material` 里，网站按它画半透明、不打光、按固有色受光，SHAPES 3）；重建工作台 `place` 写的 `fit` 可以留着（重算）。`format`：`glb`；`gltf-zip`（zip 里正好一个 `.gltf` 和它引用的文件，按相对路径安全解压）；`gltf`（`url` 指向 `.gltf`，另给 `files: {相对路径: {url, sha256, size}}`，就是 Poly Haven 文件列表里的 `include`）。gltf 只能引用模型目录里的相对文件，必需扩展只放行材质和贴图坐标类（Draco、meshopt 压缩的请换版本）。模型库里常见厘米单位的模型：±1000 米的坐标上限在旋转、缩放烘进模型之后才检查 |
| 已有贴图 | 形状里的 `material.texture`、`normalMap`、`roughnessMap` 是调用方本地有文件的贴图（`known_textures`，比如从空间拉下来的贴图）时原样引用，列进结果的 `existingTextures`（打包时带上这些文件）；本地没有的（例如本地基线用别的依赖版本算的结构贴图，字节稍有不同、哈希就不同）先不拒：本次算出了同样的贴图就直接用，`kind: structure` 的物件还可以**回退**到本次算法结构里同编号、同部件路径上的贴图（只换哈希，`uv` 等保持物件集里写的），替换清单写进`authored.textureFallback`（回退只用于 `texture`，算法结构没有法线、粗糙度贴图）；都不行时失败 |
| `structure` | `keep`（默认）：结构跑算法（地面、墙、玻璃），物件集里不能有 `kind: structure`；`replace`：结构就是物件集里 `kind: structure` 的物件，不用算法的结果（只在有待定的贴图时跑一次算法，用来核对和回退贴图） |
| 署名 | `props.source = {library, id, page, author, license, title}`：`library` 是 `polyhaven`、`objaverse`、`sketchfab`；`license` 只收 `CC0-1.0`、`CC-BY-4.0`、`CC-BY-3.0`（NC、ND、SA 一律拒绝，SA 也排除以免传染）；六个字段都是非空字符串（CC0 也写模型库标注的作者，CC-BY 署名必须有作者），`page` 是 https 来源页——与物件记录 `props.source` 的规则相同（`records.validate_model_source`，接口服务提交时也按它查）。外部模型物件必须带，形状物件可选；不是对象的 `source`（手写模型里标来源的字符串，如 `"llm-modeler"`）与物件记录一样原样放行 |

处理：

1. 读物件集并校验（`authored.py`），不合法直接失败；
2. **下载外部模型**（`bundle/sources.py` → `fetch.py`）：只用 https，主机在 `METAVERSE_RECON_MODEL_HOSTS` 里；不自动
   跟随重定向，每一跳的 `Location` 都按同样的规则检查，最多 5 跳；`Content-Length` 与声明的大小不一致就不读，边读
   边数，读完核对 sha256。同一个文件只下载一次；单个模型（含附属文件）≤ `MAX_MODEL_BYTES`，全部 ≤ 1 GiB。主机
   不在列表、不是 https、大小或哈希不符、4xx 是 `DownloadRejected`（地址或内容不对）；网络错误、超时、5xx 是
   `DownloadFailed`（可以稍后再试）。错误说明只写主机，不带完整地址；
3. 计算（`processing/authored_build.py`）：结构（keep 时跑算法；replace 时有待定的贴图也跑一次，核对和回退贴图）→
   外部模型（`processing/modelexport.py`）：按材质分开读（每个材质一组三角形，平铺贴图保留重复采样，
   `KHR_texture_transform` 烘进贴图坐标），把 `transform` 里的俯仰、横滚、缩放和 `tint` 烘进网格（缩放后的坐标超出
   ±1000 米才拒收），**偏航不烘**——写进物件记录的 `transform: {yaw}`（SHAPES 3），只差偏航的物件共用一个 glb；按物件
   模型的上限减面（多轮小步折叠，保住贴图接缝，挪过位置的角点在同一块贴图里重新取贴图坐标和法线）、缩小贴图，
   **以包围盒的底面中心为原点**写成 glb（网站把模型按记录的偏航转过以后，外包盒的底面中心对齐 `bounds` 的底面中心）；
   外部模型物件的 `material` 默认加 `shading: albedo`（按 glb 自己的材质完整受光；物件集里写了别的就照写的）→ 烘焙 → **逐件偏差**（`processing/object_fit.py`，与重建工作台 `compare`、`assemble`、`place` 用同一个
   函数，数字一致）：范围按**物件自身的朝向**取——水平朝向是物件网格水平投影的最小外接矩形，在这个局部坐标里水平
   外扩 5 厘米，竖直方向只取底面以下 2 厘米到顶面以上 2 厘米（斜放的入口门框不会把轴对齐包围盒角落里的门外走廊算
   进来，顶到天花的物件不会把天花板算进来）；范围里的扫描表面密集采样（最多 2 万点），求到物件网格和**背景**（全部
   结构：墙、玻璃、地面）的最近距离（贴墙、落地的扫描点算到墙和地面上；相邻的其他物件不当背景），**只计 10 厘米
   以内的点**（更远的是范围里别的东西），写成 `fit {meanCm, p90Cm, coverage3cm}`；离物件 10 厘米以内、离背景超过
   2 厘米的点不到 20 个（扫描里没有这件物件的证据，例如完全贴墙的饰面、扫描里没有的东西）时不写。采样的随机数按
   物件编号固定，同样的输入得到同样的贴图、偏差和记录哈希；
4. 结果：处理后的模型在 `models`（哈希 → glb 文件），烘焙的贴图在 `textures`，`notes` 原样返回（打包时写成建模
   过程记录）；锚点规则不变（按 `props.category`）。

`authored` 统计：

```json
{"structure": "keep", "entities": 24, "templates": 1,
 "fit": [{"entityId": "counter-01", "points": 20000, "meanCm": 1.8, "p90Cm": 4.2, "coverage3cm": 0.81}, …],
 "downloads": {"models": 3, "files": 9, "bytes": 5123456, "redirects": 2, "local": 0},
 "models": {"files": 3, "bytes": 1234567, "triangles": 54321},
 "bake": {"entities": 4, "parts": 6, "textured": 6, "fallback": 0},
 "textureFallback": [{"entityId": "floor", "path": "$", "from": "6fbe5e44…", "to": "0b7c19a2…"}, …]}
```

### 体素化、物件模型重新导出（本地实验）

`processing/tasks.py` 的 `voxelize_task`（按 `GRID_UNIT` 体素化、Lab 空间 k-means 量化、方块表只追加、按 `chunk.py`
编码区块）和 `model_task`（读 glb / obj / drc 或含它们的 zip → 减面、缩小贴图 → 重新导出 glb）留作本地实验：重建包
第一版没有方块，物件模型由 AI 物件集的外部模型流程（`models`、`bundle`，`processing/modelexport.py`）导出（设计 8.3）。

## 物体重建接口

物体重建模块 `metaverse_recon/processing/objects.py` 由另一个模块实现，重建流程这样调用：

```python
from metaverse_recon.processing.objects import reconstruct_objects

result = reconstruct_objects(mesh_space, structure, params=hints)
# mesh_space：已用对齐的 transform 变到空间坐标的 ScanMesh（贴图坐标左上角原点）
# structure：同一网格上 extract_structure(mesh_space, hints=hints) 的 StructureResult
# params：提示 hints（没给时是 {}）
result.entities  # {entityId: body}，SHAPES 第 3 节，layer 必须是 rebuilt，kind 是 object 或 template
#   物体的 props.category 写类别（chair、table、sofa、counter、cabinet、clutter……），决定建不建锚点；
#   props.detectedBy 写识别来源（hint 按提示、rules 按规则；旧数据写在 props.source 这个字符串里，
#   读取时一并认，见 records.detected_by——props.source 现在只用于外部模型的署名对象）；
#   anchorId 写建议的锚点编号；label 写中文标签（有提示用提示的 label）
result.textures  # {sha256 十六进制: 图片字节（jpeg/png/webp）}，被 material.texture 引用
result.metrics  # 任意 JSON，原样放进结果的 metrics.objects
```

重建流程会校验：body 合法（规则与接口服务 `EntityBody::validate` 相同，`records.py`；模板实例按同一批结果里的
模板算包围盒；`label` 不超过 200 个字符、**不能含控制字符**，如换行、制表符）、贴图字节的哈希与键一致、
引用的贴图都随结果给出、编号不和结构元素（`floor`、`wall-*`、`glazing-*`）重复。不合格 → 失败；模块导入失败 →
记录警告、只交结构（`objectsSkipped`）。规则必须和接口服务一致：接口服务交包时按同样的规则校验，不合格的包推不上去。

## 测试

```bash
cd recon
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/pytest -q
```

测试只读写临时目录，不需要数据库。`tests/fake_objects.py` 是物体重建的假实现，重建流程的测试把
`objects_target` 换成它。AI 物件集的测试用本机 https 服务（`tests/https_server.py`，用 `openssl` 命令行在临时目录里
现做自签名证书，不进仓库）当模型库，下载器换成信任这张证书、不走代理的。渲染相关的测试在找不到 node、three、
Playwright、Chromium 时跳过（`metaverse-recon doctor` 查看缺什么）。

原来要 MongoDB 的测试按内容分了两路：上传核对、清理、栅栏、空间实例、存储用量这些服务端语义已经移植成接口服务的
Rust 测试（`api/crates/metaverse-api/tests/runner*.rs`、`asset_fence.rs`）；锚点规则、物件集写回、外部模型、烘焙、
重扫配准这些重建语义改成了 `tests/test_bundle_rebuild.py`、`tests/test_anchors.py`。

## 实测：公司前厅扫描

处理服务下线之前在它里面测的（上传核对、导入扫描、体素化都是当时的任务）；计算部分的代码没变，读取、对齐、
网页用模型、结构重建的耗时在本地照样适用。

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
cd recon
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

所以部署配置种子（`infra/chrono-cd/demo-seed.json` 的 `hints`）里的是换算后的坐标：在同一份扫描上分别算两种对齐，按
`M_auto · M_compute⁻¹` 换算物体中心（尺寸不变，`yaw` 加上偏航差）。当时做这件事的 `scripts/demo_seed_hints.py` 跟着
处理服务一起删掉了（新的演示种子导入按哈希固定的重建包，不再带提示）；以后要在两种坐标系之间换算物件，用重建工作台的
`reframe`。

## 重建工作台（metaverse-recon）

给本地的 AI 模型师（Claude Code / Codex）用的命令行，`recon/src/metaverse_recon/bench/`。前厅的"优化模型"由
大模型逐件完成：每件物体**先去模型库搜一个看起来差不多的现成模型**摆进扫描里对照，搜不到或差太多的定制件
（前台、LED 大屏墙、入口门框、嵌入柜）再手写参数形状。工作台只做眼睛、尺子和裁判（渲染、测量、对齐、偏差），
结果合并成 AI 物件集，再打成重建包推送。教程见 `docs/tutorials/reconstruct-with-ai.md`，给模型师的技能说明是
`sdk/typescript/skills/metaverse-reconstruct/SKILL.md`（`metaverse init` 写进工作区）。

```bash
cd recon && uv sync --frozen
.venv/bin/metaverse-recon doctor     # 渲染要用的 node、three、Playwright、Chromium、中文字体在不在
```

| 命令 | 作用 | 输出 |
|---|---|---|
| `prepare` | 扫描（zip、glb，或 drc + 贴图）+ 可选提示 → 基线目录。**与重建流程（`bundle.rebuild`）首次自动对齐是同一条代码路径**（`processing.tasks.scan_task` → `processing.align.auto_align` → 结构 + 物体重建），坐标、结构、物体编号完全一致（也与原来处理服务首次导入同一份扫描的结果一致） | `scan.glb`、`transform.json`、`structure.json`、`objects.json`、`candidates.json`（编号、类别、标签、包围盒、点数、偏差、识别来源 `detectedBy`、建议先搜还是手写、同款）、`base.json` |
| `views` | 只渲染包围盒附近的扫描，6 个角度 + 任意相机，带米制刻度、像素 ↔ 坐标换算 | JPEG + `views.json` |
| `measure` | 外接框、最小外接矩形、按高度剖面、水平/竖直截面（网格精确求交）、俯视占用图、圆拟合、颜色；**平面拟合**（`--plane`：法向、坡度、方位、残差、可直接作 `plate` 的角点）、**高度图数字表**（`--heightmap`）、排除框（`--exclude`）、局部坐标（`--frame`） | `measure.json` + 截面图、占用图 |
| `compare` | 物件记录（形状物件或外部模型物件）与扫描、现有算法并排渲染，偏差（扫描→模型、模型→扫描、分部件、漏建团块、逐件的 `fit`——与重建流程同一个函数），校验；`--exclude`、`--color-parts`、`--scene`（多物件 / 整房） | `compare.jpg`、`compare_error.jpg`、`compare.json` |
| `search` / `index` | 模型库检索，许可硬过滤：Poly Haven（全部 CC0）、Objaverse（逐个对象读许可，只要 CC0 / CC-BY）、Sketchfab（设了 `SKETCHFAB_TOKEN` 才启用） | `candidates.json` + 带编号的缩略图拼图 `sheet.jpg` |
| `fetch` | 下载候选（Poly Haven 的 glTF 打包成 glb），记 sha256、大小、署名；上限 50 MB | `<缓存>/models/<库>/<编号>/model.glb` + `model.json` |
| `place` | 候选摆到扫描里的物体上：自动判断向上轴、按量出的尺寸缩放（等比，或逐轴 ±15%）、偏航粗搜 + 只求偏航和平移的迭代最近点 + 顶面高度图分朝向、落地；可按扫描颜色给 tint 建议 | `entity.json`（外部模型物件记录）、`place.jpg`（扫描 \| 候选）、`place.json` |
| `assemble` | 合并物件文件成 AI 物件集（模板去重、编号唯一、引用的模板存在、逐个校验、重算包围盒），最后整份跑一遍重建流程的校验 `metaverse_recon.authored.parse_authored`，通过了才算合格 | `authored.json`、`room.glb`、`room.jpg`（扫描 \| 现有算法 \| AI 重建：总览、俯视、四个角）、`report.json`（逐件偏差和 `fit`、漏建团块） |
| `reframe` | 物件在两种对齐之间换算：`compute`（`reconstruct_lobby.py`）↔ `align`（prepare 的自动对齐；旧名 `scan_import`），或任意变换文件 | 同格式的物件文件 |

**形状**：`plate`、`hull`、材质 `opacity`、`unlit` 和平铺、着色、法线、粗糙度（SHAPES 2）的校验、包围盒、网格和
贴图坐标直接用本包的 `shapes.py`、`shape_mesh.py`（与接口服务、网站、命令行逐条对过同一批测试向量，贴图坐标
对过 `uv/` 向量）；AI 物件集独有的烘焙指令 `bake` 由
`bench/shapes_ext.py` 按重建流程的规则处理（预览时按扫描颜色上色）。

**外部模型物件**（`place` 输出，AI 物件集的外部模型格式，与重建流程收的完全相同）：没有 `shape`，带 `model`
（`url`、`sha256`、`size`、`format`：`glb`、`gltf`（Poly Haven：另有 `files: {相对路径: {url, sha256, size}}` 列出
.bin 和贴图）或 `gltf-zip`）、`transform`（作用于 `processing.modelimport.load_model` 读出的模型坐标，顺序同
SHAPES，含 `scale`）、`bounds`、`props.source`（`library、id、page、author、license、title` 六个非空字符串，CC0 也写
作者；网站据此显示"模型来源"）、可选 `material: {tint, opacity, unlit, shading}`（`tint` 重建时烘进模型，其余
留在物件上，`shading` 不写时打包写成 `albedo`）。`place` 写的 `fit` 可以留着，重建时重算。地址的主机按
`METAVERSE_RECON_MODEL_HOSTS`（与打包下载同一份列表）。模型库里常见厘米单位的模型：重建流程把旋转、缩放烘进模型
之后才检查 ±1000 米的坐标上限。`place`、`compare`、`views`、`assemble` 画外部模型时走与打包相同的导出（按材质、
平铺贴图、减面以后的样子，偏航由记录转），导出结果按内容缓存在 `<缓存>/exports/`。

**提交**：`assemble` 的 `authored.json` 用 `metaverse-recon bundle --authored authored.json` 打成重建包（见"本地
流水线"），再用命令行 `metaverse bundle push` 推送。处理服务下线后，`metaverse rebuild --authored`、
`metaverse scan … --authored` 这条路不再可用。

### 贴图工作台

| 命令 | 作用 | 输出 |
|---|---|---|
| `refshot` | 从扫描对物件的一个面（`--face top\|bottom\|front\|back\|left\|right`，物件朝向 `--front`）做正交展开：面前后 `--depth`（默认 3 厘米）以内的扫描表面，每像素 `--px` 米（默认 3 毫米）；`--texture` 给扫描的原始贴图时更清楚。算去掉高光和暗斑后的中位色（sRGB 和线性）、覆盖率、建议的平铺尺寸（亮度起伏的周期；没有周期时取面的尺寸） | `refshot.png`、`refshot.json` |
| `texture` | 把颜色、法线（OpenGL 约定）、粗糙度贴图写进物件文件的一个部件（`--part`，如 `$.children[2]`）：贴图复制到物件文件旁的 `textures/`（文件名是内容哈希），材质写成 `{file}` 引用，加 `uv`、`tile`、`offset`、`rotate`、`shading`（默认 `albedo`），旧文件存成 `.bak`。`--calibrate --refshot <refshot.json>`：在网站的光照下渲染这个部件，按渲染出的中位色和扫描中位色的比例调整贴图的整体增益（各通道相对亮度比限制在 0.8–1.25 倍，3 轮），烘进贴图副本（只留最后一轮）；`--preview <图>`：扫描 \| 之前 \| 之后的正视和斜视对比图，以及色差 ΔE | 改写的物件文件、`textures/`、对比图和同名 `.json` |
| `texsearch` | 在材质库里找贴图：Poly Haven、ambientCG（只要 CC0），BM25 排序 | `candidates.json`、带编号的拼图 `sheet.jpg` |
| `texfetch` | 下载一个材质的颜色、法线（ambientCG 的 DirectX 约定翻成 OpenGL）、粗糙度，记录实际尺寸（库里有的话）和许可 | 默认 `<缓存>/textures/<库>/<编号>/`：`color.jpg`、`normal.jpg`、`roughness.jpg`、`texture.json` |

物件文件里的 `{file}` 贴图（相对物件文件的路径，不能是绝对路径、不能有 `..`）在打包时读进来，核对格式和上限，作为
`texture` 文件进包，记录里换成哈希（SHAPES 2）。

前厅会议桌台面实测：`refshot --box 2.3,0.70,10.6,6.3,0.80,11.75 --face top --texture <8K 原始贴图>`，扫描中位色 sRGB
(193, 185, 168)；`texture --part '$.children[0]' --color <概念验证提取的大理石平铺图> --tile 1.3,1.0 --calibrate --preview`：
原来的纯色台面 ΔE 13.99，贴上标定后的大理石 ΔE 0.72（增益 0.65 / 0.60 / 0.56），约 20 秒。

| 环境变量 | 用途 |
|---|---|
| `METAVERSE_RECON_BASE` | 基线目录（默认 `./base`） |
| `METAVERSE_RECON_CACHE` | 缓存目录（默认 `~/.cache/metaverse-recon`：Objaverse 索引、下载的模型、缩略图） |
| `METAVERSE_RECON_THREE`、`METAVERSE_RECON_PLAYWRIGHT`、`METAVERSE_RECON_CHROMIUM`、`METAVERSE_RECON_NODE` | 渲染工具的位置（默认在仓库 `web/node_modules`、`npm root -g`、`PLAYWRIGHT_BROWSERS_PATH`、`~/.cache/ms-playwright`、`~/Library/Caches/ms-playwright`、`/Applications` 里找） |
| `METAVERSE_RECON_FONT` | 图上标注的中文字体（默认 Mac 苹方、冬青黑体，Linux 文泉驿、Noto CJK）；找不到时图上用英文，`METAVERSE_RECON_LANG=en` 强制英文 |
| `SKETCHFAB_TOKEN` | 启用 Sketchfab 检索和下载（只放请求头，不写进任何文件） |

**Objaverse 索引**：本地 SQLite 全文索引（BM25），只收许可允许的对象。元数据按需**增量下载**（160 个分片，每个约
3.6 MB / 5000 个对象）：检索时按 LVIS 类别（chair、sofa……）匹配到的对象所在分片优先，每次最多 `--max-new-shards`
个（默认 48），不下载任何模型文件；`metaverse-recon index --all` 一次建全（约 580 MB 下载，索引约 370 MB）。
Cap3D 的描述（ODC-By 1.0，要署名）暂未接入。

### 前厅实测（2026-11-09）

`prepare`（drc + 贴图 + 部署种子里的提示，打包成和种子相同的 zip）46 秒：自动对齐 −61.423°、倾斜 0.094°，结构 6
个、物体 41 个、模板 2 个，与原来处理服务首次导入（`scan_import`）的变换一致；概念验证的四个模型用 `reframe --from compute` 换过来，沙发
在新基线上 2.87 厘米（概念验证报告 2.83）。

| 物体 | 检索 | 选中的候选 | 摆放 | 扫描→模型（候选 / 现有算法） |
|---|---|---|---|---|
| `sofa-01` 米色皮沙发 | `search --query "leather loveseat two seater sofa" --category sofa --library objaverse` | Objaverse "Sofa White Leather"（DoobiDooba，CC-BY-4.0） | `place --scale axis --tint`：+y 向上、偏航 180°、逐轴缩放、tint [184,157,121] 调成米色 | 4.12 / 4.08 厘米 |
| `chair-08` 会议椅 | `search --query "velvet tub dining armchair barrel chair metal legs" --category chair --library objaverse` | Objaverse "Black Leather Tub Armchair"（bigshape，CC-BY-4.0） | `place --exclude <桌面> --tint`：偏航 −106.6°（落到外接矩形方向）、等比 0.967 | 4.79 / 5.33 厘米 |

两件的朝向都和扫描一致（顶面高度图核对过靠背在哪一边：沙发靠背在 z 大的一边，椅背背对会议桌）。沙发的形状更贴近的是 "2-seater
Sofa"（gla_bot，两人位、枕式扶手，4.53 厘米），但它是深棕色，比扫描暗得多，tint 调不亮。

## 已知限制

- 低细节档减面时要跨过贴图块的接缝（块边上的顶点太多，只合并块内部减不到 6 万），跨过接缝的大三角形上
  贴图有拉伸（地面能看出成片的模糊三角形，但没有洞）；默认档不受影响；
- 单独的 `.drc` 扫描没有贴图（Draco 文件不带图片），网页用模型和重建贴图都是灰色；带贴图请上传 zip；
- 外部模型导出只带颜色贴图：法线贴图、金属粗糙度贴图不导出（粗糙度取系数乘粗糙度贴图的平均值，金属度一律 0），
  自发光丢掉（前台显示器的原文件是白色自发光屏幕，导出后是黑的）；
- 带偏航的模型物件，服务端按转过之后的外包盒核对尺寸，斜放的长条物件比不转的宽松（外包盒比实物大）；
- 配准只求偏航和平移：扫描本身有倾斜时先由摆正步骤修正（10° 以内）；
- 解析前检查里 Draco 的三角形数要解码后才知道（本地没有子进程内存上限，靠机器本身的内存）。
