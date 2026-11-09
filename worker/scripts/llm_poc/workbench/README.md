# 重建工作台（给"AI 模型师"用）

模型师是大语言模型：**看图理解物体、用尺子拿准尺寸、自己手写 SHAPES 形状 JSON**（见
`/home/user/chrono-metaverse/docs/SHAPES.md`）。工作台不替它建模，只提供三样东西：

| 命令 | 作用 | 产出 |
|---|---|---|
| `views` | 眼睛：只渲染物体包围盒附近的扫描，6 个角度，带米制刻度 | 6 张 JPEG + `views.json`（像素 ↔ 坐标换算） |
| `measure` | 尺子：在范围内对扫描表面采样 / 求截面，给出数字 | `measure.json` + 截面图、俯视占用图（PNG）+ 终端摘要 |
| `compare` | 对照：把模型师写的物件记录生成网格，与扫描、现有算法并排比 | 并排图、偏差分布图、`compare.json` + 终端摘要 |

三个命令都是单条命令，在 4 核机器上各跑 5–15 秒。

## 环境

```bash
PY=worker/.venv/bin/python        # 装了 worker 包的虚拟环境
WB=worker/scripts/llm_poc/workbench/wb.py
```

- Python：上面的虚拟环境（装有 `metaverse_worker`、numpy、scipy、pillow）。
- 渲染：`node` + three（默认 `/home/user/chrono-metaverse/web/node_modules/three`）+ Playwright
  （默认 `/opt/node22/lib/node_modules/playwright`，浏览器在 `PLAYWRIGHT_BROWSERS_PATH`）。
  可用环境变量 `WB_THREE`、`WB_PLAYWRIGHT`、`WB_FONT`（中文字体，默认文泉驿正黑）改路径。
- 数据默认取 `../base/`：`scan.glb`（已对齐到空间坐标）、`objects.json`（现有算法结果）、`textures/`。
  用 `--scan`、`--objects` 换别的文件。

## 约定（三个命令通用）

- 单位米，y 向上，与 SHAPES 相同。
- **范围**：`--object <entityId>` 取 `objects.json` 里该物体的 `bounds`；或 `--box x0,y0,z0,x1,y1,z1`
  直接给包围盒（两者都给时以 `--box` 为准）。`--margin` 是外扩边距（views/compare 默认 0.3，measure 默认 0.02）。
- **方位角 az**（度）：相机绕 y 轴的位置，0 = 相机在 +Z 侧，90 = 在 +X 侧，−90 = 在 −X 侧，180 = 在 −Z 侧。
  **仰角 el**：0 = 平视，90 = 正上方。
- **`--front`**：物体正面朝向，用 SHAPES 的 yaw 约定（0 = 正面朝 +Z，90 = 朝 +X，−90 = 朝 −X）。
  正面/背面/左/右/俯视/斜 45° 都相对它：

  | 视图 | 名字 | 相机方位角 | 仰角 | 投影 |
  |---|---|---|---|---|
  | 正面 | `front` | front | 0 | 正交 |
  | 背面 | `back` | front+180 | 0 | 正交 |
  | 左面（站在正面看，左手边） | `left` | front−90 | 0 | 正交 |
  | 右面 | `right` | front+90 | 0 | 正交 |
  | 俯视（正面朝画面下方） | `top` | front | 90 | 正交 |
  | 斜 45°（前右上方） | `oblique` | front+45 | 30 | 透视 |
  | 斜后 45°（只在 `--only`/`--angles` 里用） | `oblique-back` | front+225 | 30 | 透视 |

  不知道正面在哪就先用默认 0 出图，看懂后再带 `--front` 重出。
- **地面**：从包围盒四周朝上的面估一个地面高度（打印为 `地面 y=…`），另外做 5 厘米一格的**局部地面高度图**
  （地面不平、有台阶时用）。measure/compare 去掉离局部地面 `--floor-gap`（默认 2 厘米）以内的点；
  `--floor <y>` 强制用平地面。
- 扫描颜色是贴图颜色（含烘焙光照）；新模型的纯色部件按网站同样的灯光和色调映射渲染。

## 1. views —— 只看这一块的 6 张图

```bash
$PY $WB views --object counter-01 --front -90 --out out/views
$PY $WB views --object counter-01 --front -90 --only top --cut 0.95 --prefix cut095_ --out out/views
$PY $WB views --box 6.12,0.08,3.96,8.11,1.32,7.78 --margin 0.2 --cam "低角度:200,15" --cam "顶斜:-45,60,ortho" --out out/views2
```

| 参数 | 说明 |
|---|---|
| `--out` | 输出目录（必填） |
| `--front` | 正面朝向（见上表），默认 0 |
| `--only` | 只出这些视图，逗号分隔，如 `front,top` |
| `--cam 名字:az,el[,ortho\|persp]` | 追加任意相机（**空间**方位角，不随 `--front` 转）；可重复 |
| `--cut Y` | 剖切高度：去掉 y > Y 的部分（配 `--only top` 就是水平截面俯视） |
| `--margin` | 外扩边距，默认 0.3；周围东西太多时调小 |
| `--size` | 图片尺寸，默认 `900x700`；`--max-bytes` 每张上限，默认 200000 |
| `--prefix` | 文件名前缀；图片叫 `<前缀><视图名>.jpg`，说明叫 `<前缀>views.json` |
| `--no-grid` | 正交图不画整幅淡网格；`--no-near-clip` 不裁视线近侧 |
| `--floor`、`--floor-keep` | 强制地面高度；地面以下保留的厚度（默认 0.03） |

**裁剪**：扫描只保留"包围盒 + 边距"这个盒子里的部分（剖切平面精确裁），地面只留薄薄一层；
另外**视线近侧**裁到包围盒外 2 厘米，前面挡着的东西不会进画面。

**图上有什么**（每张约 900×700，JPEG ≤ 200KB）：
- 顶部两行：视图名、投影、相机在哪一侧看向哪、画面右/上分别是哪个坐标轴方向、`1 像素 = x 毫米`（正交图）；
  包围盒范围、地面高度（及附近地面 5%–95% 范围）、剖切高度。
- 正交图：左边、下边的米制刻度尺（10 厘米小刻度，50 厘米或整米标数字），整幅淡网格（10 厘米细线、50 厘米亮线、
  整米蓝线），左下角写坐标增大的方向（如 `Z→`、`X↓`、`Z←`）。画面轴不沿坐标轴时（`--front` 不是 90° 的倍数），
  刻度改为相对画面中心的距离 Δ，不画整幅网格。
- 俯视、透视图：**贴着地面**的 10 厘米网格（白亮线 50 厘米，蓝线整米）。
- 黄框 = 包围盒；正交图标注两个方向的尺寸和起止坐标，透视图在最近的三条棱上标 X/Y/Z 尺寸。
- 右上角坐标轴指示（红 X、绿 Y、蓝 Z；沿视线的轴画成 ⊙ 朝你 / ⊗ 背离你）。

**`views.json`**：每张图的文件、相机方位角/仰角、画面右/上对应的轴，以及正交图的像素 → 坐标换算：
`pxx: {axis: "Z", at0: 3.4174, perPixel: 0.005265}` 表示第 `px` 列的 z = 3.4174 + px × 0.005265；
`pxy` 同理（第 `py` 行）。

## 2. measure —— 数字

```bash
$PY $WB measure --object counter-01 --out out/measure/measure.json \
    --occ 0.8:0.95 --occ 0.95:1.35 \
    --vslice "p=6.7,5.07@-37.3" --vslice x=7.115 \
    --circle "0.3:0.9@6.0,3.9,7.2,5.2" \
    --color "外侧面板=6.08,0.3,6.0,6.2,1.0,7.7" --color "工作台面=6.3,0.85,4.8,7.6,0.92,7.4"
$PY $WB measure --object table-02 --circle 0.38:0.45 --out out/measure_table/m.json
$PY $WB measure --object counter-01 --frame 7.0612,0.0769,5.8994,-90 --out out/measure_local/m.json
```

| 参数 | 说明 |
|---|---|
| `--out` | 输出 JSON 路径（图片写在同一目录，文件名以 JSON 的文件名开头） |
| `--margin` | 范围 = 包围盒外扩多少，默认 0.02 |
| `--density` | 表面采样密度（点/平方米），默认 6000（约 1.3 厘米间距） |
| `--floor-gap` | 去掉离局部地面这么高以内的点，默认 0.02 |
| `--hslice y1,y2,…` | 水平截面高度；默认取物体高度的 20%、50%、80%、97% |
| `--vslice` | 竖直截面：`x=7.0`（垂直于 X 轴的面，横轴是 z）、`z=5.9`（横轴是 x）、`p=x,z@yaw`（过点 (x,z)、法线方位角 yaw 的竖直面，横轴 u 沿 (cos yaw, −sin yaw)）；可重复；默认过中心的 `x=`、`z=` 两刀 |
| `--tol` | 截面折线简化容差，默认 0.005 |
| `--close` | 截面填充轮廓的闭合半径，默认 0.02 |
| `--band` | >0 时截面改用这么厚的采样点带（默认 0 = 在网格上精确求交） |
| `--step` | 高度剖面表的层厚，默认 0.05 |
| `--occ y0:y1` | 俯视占用图的高度区间，可重复；默认整个高度 |
| `--circle y0:y1[@x0,z0,x1,z1]` | 圆拟合：高度区间内（可再限一个水平矩形）**侧面**的点；可重复 |
| `--color 名字=x0,y0,z0,x1,y1,z1` | 子区域颜色中位数；可重复 |
| `--frame x,y,z,yaw` | 局部坐标系：输入位置和输出坐标都按 `Ry(−yaw)·(p − 原点)`，与 SHAPES 的 `transform` 相同，写 `group` 的子形状时直接可用 |

**输出 JSON**（终端同时打印摘要）：
- `bbox`：点的外接框（最值，及 0.5%–99.5% 分位的"去离群"版）。
- `minRect`：水平面最小外接矩形（凸包旋转卡壳；`robust` 版用 1%–99% 分位）。`size = [沿局部 x（长边）, 沿局部 z]`，
  `yaw` 按 SHAPES 约定可直接填进 `transform.yaw`，`corners` 是 4 个角点。
- `profile.rows`：按高度每 5 厘米一层：点数、x/z 范围（2%–98%）、宽 `w`、深 `d`、相对最小外接矩形中心沿其局部轴的范围
  `u`/`v`、占用面积、朝上法线占比 `upFacing`（大 = 台面/顶面）、颜色中位数。
- `hslices` / `vslices`：每个截面
  - `chains`：扫描表面与截面平面的**精确交线**（按网格边求交、相邻线段连起来、1.5 厘米内的小缺口接上），
    简化后的折线顶点；水平截面是 `[x, z]`，竖直截面是 `[横轴, y]`；`closed` 表示闭合；按长度排序。
  - `footprint`：交线闭合 `--close` 半径后填洞的外轮廓（逆时针，可直接作 `extrude` 的 `outline`）和洞；
    精确求交时只列平均厚度 ≥ 4 厘米、面积 ≥ 0.01 平方米的块（细长的交线带只看 `chains`）；`--band` 模式没有交线，列出全部轮廓。
  - `png`：截面图——每条交线一种颜色、标 `#序号`（就是 `chains` 的下标），带刻度和网格。
- 水平截面图、占用图固定为 X 向右、Z 向下（不随 `--front` 转；有 `--frame` 时是局部 x 向右、z 向下）。
- `occupancy`：俯视占用图 PNG（2 厘米一格，颜色 = 该格区间内最高点的高度，带色条；黄框 = 包围盒，品红 = 最小外接矩形）。
- `circles`：圆心、半径、残差（厘米）、内点占比、圆弧覆盖角度；点基本共线时报"不是圆弧"。
- `colors`：整体中位色、k 均值分出的 4 种主要颜色（占比和所在的 x/y/z 范围）、各子区域的中位色和 25%–75% 分位。

## 3. compare —— 对照

```bash
$PY $WB compare --object counter-01 --model my_counter.json --front -90 --out out/compare
$PY $WB compare --object chair-10 --model samples/chair-10-template.json --front 155.85 --cut 0.8 --out out/compare_chair
$PY $WB compare --box 6.12,0.08,3.96,8.11,1.32,7.78 --model my_counter.json --base-id counter-01 \
    --angles "oblique-back,left,top" --out out/compare2
```

| 参数 | 说明 |
|---|---|
| `--model` | 模型师写的物件记录 JSON（必填，格式见下） |
| `--out` | 输出目录（必填） |
| `--object` / `--box` | 范围；都不给时用现有算法里同 `entityId` 物体的包围盒，再没有就用模型自己的包围盒 |
| `--base-id` | 现有算法里对应物体的编号（默认同 `--object` 或记录里的 `entityId`） |
| `--front` | 正面朝向（同 views） |
| `--angles` | 3 个角度：视图名逗号分隔（默认 `oblique,front,top`），或 `az,el[,ortho]` 用 `;` 分隔 |
| `--cut` | 剖切高度（三列都剖） |
| `--fit-margin` | 算偏差的扫描点范围 = 包围盒外扩多少，默认 0.02 |
| `--density` | 算偏差的扫描采样密度，默认 3000 点/平方米 |
| `--floor-gap` | 去掉离局部地面这么高以内的扫描点，默认 0.02 |
| `--cell` | 并排图每格尺寸，默认 `600x460` |

**记录文件格式**（都可以）：
- 单个 body：`{"entityId": "counter-01", "kind": "object", "shape": {...}, ...}`；
- body 列表 `[ {...}, {...} ]`，或 `{entityId: body}`；
- `{"templates": {"tpl-x": 形状}, "bodies": [ ... ]}`；列表里 `kind: "template"` 的 body 也算模板；
- 裸形状 `{"type": "group", ...}`（按 `entityId = model` 处理）。

`instance` 引用的模板先在文件里找，找不到再用 `objects.json` 里的模板（如 `tpl-chair-01`）。
`samples/counter-01-draft.json`、`samples/chair-10-template.json` 是格式示例（随手写的粗稿，只用来演示工具）。

**输出**：
- `compare.jpg`：3 列（扫描 | 现有算法 | 新模型）× 3 行（3 个角度），同一相机、同一贴地网格和黄框；
  正交行带刻度尺；底部两行写两个模型的偏差数字。
- `compare_error.jpg`：范围内的扫描点按到模型表面的距离上色（绿 ≤1 厘米、黄 1–3、橙 3–6、红 >6），
  俯视 / 正面（从 +Z 看）/ 侧面（从 −X 看）三个投影，现有算法一行、新模型一行。红色成片的地方就是没贴上的地方。
- `compare.json` 和终端摘要：
  - `validation`：每个物件的 SHAPES 结构校验（`metaverse_worker.shapes.validate_shape`）、算出的包围盒、
    按接口服务规则校验整条记录（`validate_entity_body`；缺的 `layer`/`kind`/`bounds`/`props` 先按默认补上再校验，
    并提示提交前写全）；记录里的 `bounds` 和算出的不一致也会提示。
  - `new` / `base`：
    - `scanToModel`：范围内扫描点到模型表面的精确距离——均值、P90、3 厘米内比例（`coverage3cm`）、1 厘米内、5 厘米内；
    - `modelToScan`：模型表面采样点到扫描的距离（数值大 = 模型有扫描里没有的部分；贴墙贴地、被挡住的背面没扫到也会偏大）；
    - `parts`：按叶子形状拆开（路径如 `counter-01.children[3]`、`chair-10<tpl>.children[0]`，类型、颜色、包围盒、
      离它最近的扫描点数和均距、部件→扫描的均值/P90/3 厘米内比例），找哪一块放歪了用这个。
  - `base.recordedFit`：`objects.json` 里现有算法自己记的 fit（在它分割出的点上算，口径不同，仅作参考）。
  - `missingFromNew`：离新模型超过 5 厘米的扫描点按 5 厘米体素连成的块（点数、范围、平均距离）——漏建或放错的地方。

## 建议的工作流程

1. `views`（先默认 `--front 0`）看懂物体，确定正面朝向，再带 `--front` 重出；需要时 `--cut` 看内部、`--cam` 补角度。
2. `measure` 拿尺寸：`minRect` 定朝向和外形，`profile` 看高度方向怎么变，`hslices`/`vslices` 拿轮廓顶点，
   `circles` 拿圆，`colors` 拿颜色；可用 `--frame` 直接拿到局部坐标。
3. 手写形状 JSON（坐标直接用空间坐标、`group` 放原点最省事；或用 `--frame` 的局部坐标 + `group.transform`）。
4. `compare` 看并排图和偏差图，按 `parts` 和 `missingFromNew` 改，再 `compare`，直到偏差不再下降。

## 文件

- `wb.py`：命令行入口；`wbviews.py`、`wbmeasure.py`、`wbcompare.py`：三个命令；`wbcore.py`：公共部分
  （扫描 glb 读写与裁剪、地面估计与高度图、表面采样、记录读取、渲染调度、画刻度的二维图底板、JPEG 控制大小）。
- `render/index.html`、`render/render.js`：无头渲染（three.js + Playwright + Chromium SwiftShader），
  每次起一个只读本地服务，一个页面加载一次模型、依次渲染所有视图。
- 中间文件（裁剪后的扫描 `_scan_crop.glb`、模型 glb `_new.glb`/`_base.glb`）写在输出目录里，
  `_scan_crop.glb` 用完即删，模型 glb 保留，可以拿去别的查看器看。

## counter-01 实跑结果（上面 README 里的命令原样跑出）

输出在 `out/`（当前目录下）：

- `views/`：`front|back|left|right|top|oblique.jpg`（`--front -90`，各 100–175 KB）、`cut095_top.jpg`（剖到 0.95 米的俯视）、
  `views.json`；`views2/`：`--box`、`--cam` 自定义相机的例子。每次约 5 秒。
- `measure/`：`measure.json`、`measure_h1..4.png`（水平截面）、`measure_v1..2.png`（竖直截面）、`measure_occ1..2.png`（占用图）；
  终端摘要存在 `measure_stdout.txt`。约 4 秒。`measure_local/` 是 `--frame` 局部坐标的例子。
- `compare/`：`compare.jpg`、`compare_error.jpg`、`compare.json`（输入是 `samples/counter-01-draft.json` 粗稿）；
  终端摘要存在 `compare_stdout.txt`。约 12 秒。`compare_chair/` 是模板 + 实例的例子，`compare2/` 是自定义角度的例子。
