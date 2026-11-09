# 房间扫描 → 结构化参数模型：开源方案调研与借用建议

> 本报告给项目负责人看，调研截至 2026-11-09。
>
> - 许可、星数和提交日期取自调研时读到的仓库原文、许可证文件和模型卡。标"未核实"的内容不能当作定论。
> - 本报告说的"可商用"，只表示许可文本允许商业使用。公司内部的生产使用算不算"商用"，对非商用许可（CC-BY-NC 等）来说是灰色地带，要由法务判断。本报告一律按"不进生产"处理。
> - 项目和工具名称按项目约定放在代码格式里。

## 结论

这个领域的底层工具已经很成熟，但还没有现成工具能把整间房的扫描直接变成参数程序。

**可以直接用、许可也宽松的成熟方案**，大多只用 CPU 就能跑：
- **采集与表面重建**：开源采集应用 `Stray Scanner`、`Open3D` 的截断符号距离场融合、`COLMAP` 4.x、`PromptDA` 深度补全、`gsplat` 和 `DN-Splatter`。
- **房间外壳的几何拟合**：`Open3D`、`pyRANSAC-3D`、`PCL` 的平面拟合，`Cloud2BIM`，以及 GPL 许可、内部可用的 `CGAL` `PolyFit` 和动力学重建。
- **二维分割基础模型**：`SAM 2.1`、`SAM 3`/`3.1`、`Grounding DINO`。
- **参数化 CAD 内核**：`CadQuery`、`build123d`。
- **贴图工具**：`xatlas`、`mvs-texturing`、`Blender` 烘焙。

**"理解场景并输出结构化模型"这一层还停留在论文和研究代码阶段**：
- `SceneScript` 和 `SpatialLM` 只输出墙、门、窗加家具包围盒，权重带非商用成分。
- 点云或图像转 CAD 的小模型（`CAD-Recode`、`cadrille`、`MeshCoder`、`CADReasoner`、`Zero-to-CAD`）只会做归一化尺度下的单个零件，而且是在合成机械件上训练的。其中权重可商用的只有 `CADReasoner` 和 `Zero-to-CAD`。
- "扫描里检索现成模型再替换"这一族依赖 ShapeNet、ScanNet 这类非商用数据，也做不出前台、LED 大屏这样的定制件。
- 三维实例分割在测试集上分数很高，但用到自己的手机扫描上，要自己搭一条管线。

**"大模型写模型"目前最好的做法**，是 2026 年出现的编程智能体路线。代表是 `LiteReality-Agent`（Apache-2.0，2026-08 开源）：
- 整间房写成一个 `Room.py`，由 `Codex` 或 `Claude Code` 在"渲染比对、修改、校验"的循环里反复改。
- 规则家具用 `Articraft` 式形状库（圆角盒、倒角、扫掠、放样、组合）程序化建模，不规则家具交给 `TRELLIS.2` 生成网格。

不过有两项评测说明，大模型写出的几何不准，自评也不可靠：`LEGO-Anything` 中最好的模型室内得分只有 53.4%，`SceneActBench` 的多视图房间重建项最好成绩只有 F@5% 12.3。所以必须由确定性代码做测量裁判，每轮结果变差就回退。这正好就是本项目"大模型写程序、计算只做测量和校验"的分工。

**建议**：以 `LiteReality-Agent` 的框架和 `Articraft`、`build123d` 的形状语言为蓝本自己搭。现成方案缺的三块要自己补：
1. 读入 Scaniverse 网格；
2. 把扫描实测尺寸喂给模型，并做点到面距离校验；
3. 把扫描贴图转移到参数模型上。

---

## 一、按流水线环节的方案

流水线：采集与表面重建 → 场景结构（墙、地、门窗）→ 物体分割与识别 → 每个物体建成参数模型 → 贴图与校验

### 1. 采集与表面重建

现在的 Scaniverse 网格（约 34 万三角形，8192² 贴图）已经能当测量和贴图的来源，这一环不是瓶颈。要改进的有两点：
- 拿到原始的彩色加深度帧（RGB-D）和相机位姿，后面做分割和贴图重投影都需要；
- 让墙角、桌边倒角这类细节更准。

**① `Stray Scanner`（开源采集应用）/ `Polycam` 开发者模式**
- 链接：https://github.com/strayrobots/scanner （应用源码）、https://github.com/kekeblom/StrayVisualizer （处理脚本）、https://github.com/PolyCam/polyform
- 做什么：
  - Stray 导出 `rgb.mp4`、16 位毫米深度（256×192）、置信度、ARKit 位姿 `odometry.csv` 和内参。
  - Polycam 开发者模式导出关键帧、经过全局优化的位姿（默认只对 700 帧以下的场景做优化）、深度、置信度和 `raw.glb`。`polyform` 能把它们转成 `transforms.json`。
- 许可：Stray 应用和脚本都是 MIT，可商用；`polyform` 是 MIT；Polycam 本身是商业软件，开发者模式是否收费未核实。
- 显卡：不需要。
- 我们怎么用：作为下一阶段的采集格式。Stray 的格式最简单，方便自己写云端处理。有两点要注意：
  - Stray 自带的融合脚本会把彩色图缩到 256×192，贴图要自己用高分辨率彩色帧去投影；
  - Polycam 的 `raw.glb` 和原始数据之间差一个 `alignmentTransform` 坐标变换。

**② `Open3D`：截断符号距离场（TSDF）融合与网格测量**
- 链接：https://github.com/isl-org/Open3D
- 做什么：
  - 用原始深度加 ARKit 位姿融合出带顶点色的网格；
  - 同一个库还提供随机抽样一致（RANSAC）平面分割、迭代最近点（ICP）配准，以及射线求交和距离查询（`RaycastingScene`）。
- 许可：MIT，可商用。最新版 v0.20.0 发布于 2026-09。
- 显卡：不需要。旧版体素融合只用 CPU，张量版可以选用 CUDA。
- 我们怎么用：作为云端 CPU 的几何底座，用 1–2 cm 体素融合；后面的平面拟合和点到面校验也用它。
- 局限：手机深度分辨率低，细小棱角会被抹平；玻璃上没有有效深度。
- 同类：`VDBFusion`（MIT，只用 CPU）、`nvblox`（Apache-2.0，需要 NVIDIA 显卡）。

**③ `PromptDA`：以激光雷达深度为提示的高分辨率度量深度**
- 链接：https://github.com/DepthAnything/PromptDA
- 做什么：输入 RGB 加 192×256 的激光雷达深度，输出与 RGB 同分辨率（最高 4K）的度量深度。仓库自带处理 Stray 扫描的脚本，还有一个透明物体微调版 `Small-Transparent`。
- 许可：代码是 Apache-2.0，Hugging Face 上的 Large 和 Small 权重也标 Apache-2.0。但它基于 Depth Anything V2 构建，而后者的 Base 和 Large 权重是 CC-BY-NC，许可继承关系未核实。建议请法务确认，或者优先用 Small。
- 显卡：需要。Small 只有 2510 万参数，理论上能在 CPU 上推理，未核实。
- 我们怎么用：先补全深度再做 TSDF 融合，保住桌边倒角、扶手这类细节；透明版用于玻璃幕墙和玻璃桌面。

**④ `DN-Splatter` / `AGS-Mesh`（建在 `gsplat`、`nerfstudio` 之上）**
- 链接：https://github.com/maturk/dn-splatter 、https://github.com/nerfstudio-project/gsplat
- 做什么：用手机激光雷达深度和法线先验去约束高斯泼溅，专门针对室内场景，导出的网格更平整。
- 许可：代码是 Apache-2.0。但 README 默认的法线先验 `Omnidata` 和 `DSINE` 不可商用，要改成用传感器深度算法线（`--normal-supervision depth`），或者换成 `MoGe-2`/`MoGe-3`（MIT）。
- 显卡：需要 NVIDIA 显卡。
- 我们怎么用：放在本地显卡上做精修，得到更平的墙面、地面和更清楚的家具轮廓，作为测量依据。

补充：
- `COLMAP` 4.x（BSD-3，已并入 `GLOMAP` 全局建图，4.2.1 发布于 2026-09-29）：可以把 ARKit 位姿当先验做三角化或光束法平差，校正位姿漂移。稀疏部分在 CPU 上能跑。
- 前馈几何大模型可以用来补位姿和深度：`MapAnything`（要选 `map-anything-apache` 权重）、`Depth Anything 3`（只有 Small、Base、Metric-Large、Mono-Large 四个权重可商用）、`VGGT`（只有需人工审批的 `VGGT-1B-Commercial` 可商用）。手机采集已经有度量尺度的位姿和深度，这些只作补充。
- 不要用于生产：`2DGS`、`GOF`、`MILo`（Inria 非商用）、`PGSR`（浙大许可禁止商用）、`Neuralangelo` 和 `NeuS2`（NVIDIA 非商用，且已停更）。要 2DGS 的效果，可以用 `gsplat` 里的 Apache 版实现。

### 2. 场景结构：墙、地面、天花、门窗、玻璃幕墙

现状：
- 房间外壳用"平面检测加拼封闭多边形"的办法，在 CPU 上已经很成熟。
- "扫描转结构化场景语言"（`SceneScript`、`SpatialLM`）能跑，但只到墙、门窗加包围盒这一层，而且权重不可商用。

**① 平面检测：`Open3D` / `pyRANSAC-3D` / `PCL` / `CGAL` 形状检测**
- 链接：https://github.com/leomariga/pyRANSAC-3D 、https://github.com/PointCloudLibrary/pcl 、https://github.com/CGAL/cgal
- 做什么：拟合平面、圆柱、球、圆锥等形状的连续参数，并给出各自的内点。`CGAL` 的区域生长可以直接作用在网格面上。
- 许可：`pyRANSAC-3D` 是 Apache-2.0，`PCL` 是 BSD-3，`Open3D` 是 MIT。`CGAL` 是 GPL-3.0-or-later，内部使用没有开源义务，也可以向 GeometryFactory 购买商用许可。
- 显卡：不需要。
- 我们怎么用：从 Scaniverse 网格里抽出地面、天花、各面墙和玻璃幕墙所在的平面，得到法向和偏移量，作为大模型写墙体时的实测数据。`CGAL` 的 Python 绑定覆盖到哪些功能未核实。

**② 拼成封闭外壳：`CGAL` `PolyFit` / 动力学表面重建**
- 链接：https://github.com/LiangliangNan/PolyFit 、https://github.com/CGAL/cgal
- 做什么：用平面片拼出紧凑、封闭的分段平面网格。动力学重建从 CGAL 6.0 起提供，平面多、数据缺失时比 PolyFit 更稳。
- 许可：GPL-3.0，内部可用。`PolyFit` 有 Python 包；它的求解器推荐 Gurobi（商业软件），开源的 SCIP 也能用但较慢。
- 显卡：不需要。
- 我们怎么用：从干净的外壳上量出墙端点和墙高，写进程序，或者作为墙体校验的参照。它只处理平面，弧形墙要另做。

**③ `Cloud2BIM`**
- 链接：https://github.com/VaclavNezerka/Cloud2BIM
- 做什么：把点云转成 IFC 格式的楼板、墙（支持非正交方向）和门窗洞口。方法基于点密度直方图，作者自称比同类工具快约 7 倍。
- 许可：MIT，可商用（另有商业版出售）。
- 显卡：核心算法不需要；2026-08 新增的深度学习分割模块的硬件需求未核实。
- 我们怎么用：在云端提取地面高度、墙的位置和厚度、门洞，或者借鉴它的直方图方法自己实现。它面向建筑尺度，需要调参；玻璃幕墙点稀疏时可能漏掉墙。

**④ `SpatialLM`（只作参考和对照）**
- 链接：https://github.com/manycore-research/SpatialLM
- 做什么：把整屋点云转成类 Python 文本：`Wall(...)`、`Door/Window(wall_j, ...)`、`Bbox(class, x, y, z, angle_z, sx, sy, sz)`，共 59 类家具。
- 许可：仓库的 `LICENSE.txt` 是 Llama 3.2 社区许可；权重（包括 `Sonata`、`SceneScript` 编码器）是 CC-BY-NC-4.0，整体不可商用。Hugging Face 上 `Pointcept/Sonata` 标的是 MIT，与官方 README 冲突，以 README 为准。
- 显卡：需要 NVIDIA 显卡，模型 0.5B/1B 参数。
- 我们怎么用：在本地跑一份初稿，和我们自己的结果对照。它的文本格式可以照搬，作为我们场景描述语言里墙体和门窗部分的写法。不进生产。

补充：
- Apple `RoomPlan`（闭源，随 iOS SDK 免费）：到现场再扫一次，就能得到参数化的墙、门窗和物体框，用来交叉验证。它不能处理已有的 Scaniverse 网格。`openPlan3D`（MIT）可以导入它的结果来编辑。
- `PlanarSplatting`（CVPR 2025）直接从多视角照片重建出平面图元，最接近"干净结构"的目标。但它的光栅化子模块是 Inria 非商用许可，默认的 `VGGT` 权重也不可商用，正式用之前要先替换。
- `SceneScript` 的指令设计（`make_wall`、`make_door`、`make_bbox`，扩展版还有 `make_prim`）可以参考。它的代码和权重都是 CC-BY-NC。
- 玻璃幕墙和 LED 屏：调研到的所有方法都处理不好（激光雷达回波少、表面反光）。建议从框架竖梃、地面和天花的交线推断出平面。有原始帧之后，可以用 `PromptDA` 透明版或 `Depth Anything 3` 补洞。

### 3. 物体分割与识别

现状：在 ScanNet 测试集上已经很成熟，但有三个问题：
- 多数仓库停留在旧环境（MinkowskiEngine、CUDA 11.x）；
- 数据格式按 ScanNet 写死；
- 权重在 ScanNet 上训练。ScanNet 条款限定非商业研究，权重是否继承这条限制，法律上不明确。

我们只有一间房、几十个物体，不必追求测试集上的最优分数，自己写一条简单的管线最稳。

**① `SAM 3` / `SAM 3.1`（或 `SAM 2.1` 加 `Grounding DINO`）+ 多视角反投影**
- 链接：https://github.com/facebookresearch/sam3 、https://github.com/facebookresearch/sam2
- 做什么：在二维图像上按文本概念提示，一次分出某一类的全部实例（SAM 3）；在视频里跨帧跟踪实例编号（SAM 2）。
- 许可：
  - SAM 2.1 是 Apache-2.0。
  - SAM 3/3.1 是 SAM License：可商用，但带贸易管制条款（禁止军事等用途），Hugging Face 上的权重要人工审批才能下载。
  - `Grounding DINO` 是 Apache-2.0。
- 显卡：需要。SAM 3 要求 CUDA 12.6 以上，模型 848M 参数，显存要求未核实。
- 我们怎么用：
  1. 在 CPU 上从带贴图网格渲染几十到上百个视角（彩色图、深度和位姿都没有误差）。
  2. 在本地显卡上用 SAM 3，按大模型给的词表（椅子、沙发、会议桌、柜子、前台、屏幕、玻璃墙等）逐类分割。
  3. 把二维掩码反投影到网格面片上投票合并。
  
  合并算法借鉴 `MV3DIS`（MIT，CVPR 2026，专门解决多视角掩码不一致的问题）。"从三维渲染二维再识别"的思路来自 `OpenIns3D`。`OpenIns3D` 默认的检测器 `ODISE` 不可商用、`YOLO-World` 是 GPL，换成 SAM 3 就绕开了这两个问题。

**② `Point-SAM`**
- 链接：https://github.com/zyc00/Point-SAM
- 做什么：原生三维的可提示分割，直接读 GLB 网格，点几下就得到物体掩码。
- 许可：代码 MIT，权重 Apache-2.0，可商用。
- 显卡：需要。
- 我们怎么用：由人或大模型点击，修正自动分割出错的物体，比如前台和墙粘在一起的情况。

**③ `ConceptGraphs`（有原始 RGB-D 帧之后）**
- 链接：https://github.com/concept-graphs/concept-graphs
- 做什么：把带位姿的 RGB-D 序列转成开放词汇的物体地图，给出每个物体的文字描述和物体之间的关系（JSON 场景图）。
- 许可：代码 MIT。依赖 `ultralytics` YOLO（AGPL-3.0，需要替换掉）和 GPT-4 接口。
- 显卡：需要。
- 我们怎么用：作为大模型写程序前"读场景"的输入，比如"沙发靠墙、茶几在沙发前"。

**④ 部件分割：`SAMPart3D` / `Hunyuan3D-Part` 中的 `P3-SAM`**
- 链接：https://github.com/Pointcept/SAMPart3D 、https://github.com/Tencent-Hunyuan/Hunyuan3D-Part
- 做什么：把单件家具的网格切成桌面、腿、靠背、扶手等部件。P3-SAM 还会给出部件包围盒，并明确支持扫描网格。
- 许可：
  - SAMPart3D 的代码和权重都是 MIT，但每个网格要单独训练一次，速度较慢。
  - P3-SAM 用腾讯混元 3D-Part 社区许可：不适用于欧盟、英国、韩国，月活超过 100 万要另行授权。Hugging Face 模型卡没有许可标签，以 GitHub 上的 LICENSE 为准。
- 显卡：需要。
- 我们怎么用：为"每个部件换成一个图元"这一步提供结构骨架和测量对象。`PartField` 效果也好，但用的是 NVIDIA 非商用许可。

补充：
- 只有 CPU 时：去掉墙、地、天花的平面后，用 `PCL` 的欧氏聚类或区域生长分出物体团，再把每团的渲染截图交给多模态大模型接口命名。贴在一起的物体（比如桌下的椅子）由人工或大模型辅助拆开。
- 对照基线：`Mask3D`（MIT，点云实例分割的经典方法）、`OpenIns3D`、`Open3DIS`（BSD-3，支持 iPhone 采集的 ARKitScenes 数据）。它们的权重多在 ScanNet 上训练，不进生产。
- 没有许可证的仓库不能复用代码，只能借思路：`Open-YOLO 3D`、`SAI3D`、`MaskClustering`、`SAM2Object`。例如 SAI3D 的"网格超点加多视角 SAM 投票"思路可以借鉴。

### 4. 每个物体建成参数模型

这是整条流水线里开源方案最不成熟的一环。下面四条路线中，"大模型写代码"是主路线，其余三条只负责给初稿、参数参考或补全。

#### 4.1 大模型写代码（主路线）

**目前最好的做法**（综合下列项目）：
1. **代码是唯一真相**：整间房一个程序文件，每个物体一个模块（`LiteReality-Agent`）。
2. **先用确定性代码生成种子，再由智能体分阶段精修**：外壳 → 大件 → 墙上物体 → 小件 → 材质（`Code-as-Room`）。
3. **把实测尺寸写进提示词**：`LiteReality-Agent` 注入的是 RoomPlan 尺寸，我们注入从扫描测出的包围盒、平面和圆柱参数。
4. **只让模型调用受约束的形状库，不写裸 `bpy`**：参考 `Articraft` 和 `MeshCoder` 的接口；目标语言用 `CadQuery`/`build123d`。
5. **确定性校验加结构化反馈，变差就回退**：参考 `CADReasoner` 的几何差异反馈和 `LEGO-Anything` 的失败分析。
6. **同款物体做模板实例**：参考 `The Scene Language` 的函数复用和 `SCANnotate` 的同款克隆。
7. **必要时多候选择优**：参考 `BlenderAlchemy` 的"多候选加视觉比对"和 `DiffCAD` 的"多假设再挑选"。

**① `LiteReality-Agent`：最高优先级参考**
- 链接：https://github.com/LiteReality/LiteReality-Agent （论文 arXiv 2610.01863，2026-10）
- 做什么：
  - 整间房写成一个可执行的 `Room.py`，每个物体另有一个 `object.py`，编译成 `Room.blend` 和 `Room.glb`，也能导出 MuJoCo、URDF、MJCF。
  - 先用确定性代码生成种子房间，再由编程智能体（`Codex`，默认 GPT-6；或 `Claude Code`）在"观察、修改、渲染比对、校验"的循环里迭代。
  - 逐个物体分流：规则物体走程序化建模（盒、圆柱、旋转体、挤出体加物理材质，基于 `Articraft`）；不规则物体（沙发、椅子）走 `TRELLIS.2` 生成网格。
  - 工具有 `render`、`critic`、`select_views`、`grid`、`check_collisions`、`fetch_material`。
- 许可：代码 Apache-2.0。依赖外部大模型账号，每个场景通常不到 1 美元。`TRELLIS.2` 权重是 MIT（已核实），但它依赖的 `nvdiffrast` 不可商用。
- 显卡：
  - 主流程只用 CPU，需要 `Blender` 5.x。
  - `TRELLIS` 和 `GroundingDINO` 默认跑在 Modal 云上，扫描数据会上传给第三方；在本地跑需要 Linux 和 24GB 以上的 NVIDIA 显卡。
- 成熟度：约 655 星。0.0 版发布于 2026-08-01，到 10 月仍在密集更新，有示例扫描和单元测试。
- 我们怎么用：
  - 直接借鉴的有：单文件表示、"程序化还是生成网格"的分流器、"按类别写好物体规格再注入实测尺寸"的提示词写法、工具清单。
  - 要自己补的有四点：
    1. 输入只支持它自家的 `LiteReality Scanner` 应用（RGB、深度和 RoomPlan 的 `room.usdz`）。要读 Scaniverse 的 glb，得自己写一层转换（从网格分出墙面和物体包围盒）。能否直接改造它的读入层未核实。
    2. 它的尺寸不经测量拟合，要加上点到面距离等度量校验。
    3. 材质取自 Poly Haven，不是从扫描贴图转移过来的。
    4. 不规则物体最终仍是网格，达不到"全部用参数形状"的目标。

**② `Articraft`：现成的家具形状库**
- 链接：https://github.com/articraftresearch/Articraft （论文 arXiv 2605.15187，2026-05；另一轮调研没能核实论文标题和会议）
- 做什么：
  - 大模型针对它的 SDK 写 Python，可用的形状有：精确实体（切削、圆角、倒角），程序化网格（`RoundedBoxGeometry` 圆角盒、扫掠、放样、抽壳、布尔），以及刚体和关节。
  - `model.validate()` 和 `TestContext` 会自检重叠、支撑、尺度和运动。
  - 单位是米，Z 轴朝上，最后导出可活动的 USDZ。
- 许可：Apache-2.0。没有自带权重，调用 OpenAI、Anthropic、Gemini 或 OpenRouter 的接口。第一轮调研说它的实体部分基于 `build123d`，但复核时 README 只写了"自家的 3D 建模工具包"，这条依赖关系未核实。
- 显卡：不需要。
- 成熟度：约 150 星，373 次提交，最近提交 2026-11-02。README 声明 1.0 之前接口还会变。
- 我们怎么用：直接作为家具建模层，或者照着它设计我们自己的形状库，以及"写代码、编译、校验、结构化反馈"的循环。它只看文字和一张参考图，不处理扫描，尺寸要由我们的测量步骤喂进去。

**③ `CadQuery` / `build123d`：推荐的目标语言**
- 链接：https://github.com/CadQuery/cadquery 、https://github.com/gumyr/build123d
- 做什么：基于 Open CASCADE（OCCT）几何内核的 Python 参数化 CAD，支持草图、挤出、旋转、扫掠、放样、圆角、倒角、布尔运算和装配体。输出边界表示（B-rep）实体，可导出 STEP、STL 和 glb。
- 许可：Apache-2.0。底层 OCCT 据称是 LGPL-2.1 加例外条款，未核实。
- 显卡：不需要，可以跑在云端。
- 我们怎么用：
  - 让大模型直接写这两种代码。`CAD-Recode`、`cadrille`、`CADReasoner`、`Zero-to-CAD` 输出的都是 `CadQuery`，这个生态的现成工具和数据都是围绕它的。
  - 同款家具做成装配体里的同一个零件，放到多个位置，就是模板实例。
  - OCCT 能直接算体积、包围盒、距离和干涉，用来做校验。
- 局限：导出 glb 时要调三角化精度；不会自动生成适合烘焙的贴图坐标，要配合 `xatlas`。

**④ `blender-mcp` / `FreeCAD MCP`：交互式调试和人工把关**
- 链接：https://github.com/ahujasid/blender-mcp 、https://github.com/neka-nat/freecad-mcp
- 做什么：让大模型通过 MCP（模型上下文协议）在运行中的 `Blender` 或 `FreeCAD` 里执行 Python、读取场景、截图回看。
- 许可：都是 MIT。`blender-mcp`（约 3.37 万星，事实标准）默认收集一条最小的匿名使用记录，可以用 `DISABLE_TELEMETRY=true` 关掉。它的 `execute_blender_code` 能执行任意 Python，套接字通信既没有认证也没有加密，必须放在隔离环境里用，可以开启 `BLENDER_MCP_SAFE_MODE=1` 做脚本检查。
- 显卡：不需要。
- 我们怎么用：在本地做交互精修和人工复核。云端批处理改用无界面运行的 `Blender`，或者直接执行 `build123d` 脚本，`LiteReality-Agent` 也是这样做的。

可以借鉴设计、但代码不一定直接用的项目：
- `VIGA`（MIT，约 1300 星）：同一个智能体轮流扮演"生成者"和"校验者"，多视角渲染找差异，还有上下文记忆的组织方式（计划、代码差异、渲染历史）。它的资产依赖商业的 Meshy 接口。
- `Code-as-Room`（Apache-2.0，约 247 星）：分阶段流程，以及"确定性代码负责调度、校验、修复、记忆和代码整合，大模型只负责语义、关系图和几何代码"的分工。它的输入是房间俯视图。
- `The Scene Language`（MIT）：用函数定义实体，再用循环和实例化组合，正好对应"同款物体做模板实例"。它证明了通用大模型不经训练就能从图像写出分层场景程序。
- `LayoutVLM`（没有许可证，只借思路）："视觉语言模型给关系和初值，再做可微优化"。把它的文本约束换成"程序生成的几何到扫描点的倒角距离"，就是我们的拟合方式。
- `LEGO-Anything`（代码未公开，仓库 404）：最好的模型（GPT-6-astra）室内得分 53.4%，加上免训练的约束插件后最高 62.7%。三个典型失败是：初始化差、迭代时越改越坏、自评不可靠。

#### 4.2 点云或图像转 CAD 的专用小模型（本地显卡，给初稿）

共同局限：
- 都在合成机械零件上训练，形状只有"草图加挤出加布尔"，参数还被量化；
- 只做归一化尺度下的单个零件，不懂房间；
- 一到真实扫描就明显掉点：`CAD-Recode` v1.5 在合成数据 DeepCAD 上的交并比（IoU）是 92.0，在真实扫描 CC3D 上只有 74.2。

所以它们只适合给柜子、台面、屏幕边框这类规则件出初稿。

**① `CADReasoner`**
- 链接：https://github.com/zhemdi/CADReasoner （CVPR 2026 Findings）
- 做什么：输入多视角渲染图、点云或两者组合，输出 `CadQuery` 程序，再按"执行、渲染、比较几何差异、改程序"的循环多轮迭代。仓库带扫描模拟脚本。
- 许可：代码和三个权重（`kulibinai/cadreasoner`、`-pc`、`-cm`）都是 Apache-2.0，基座是 Qwen2-VL-2B。训练数据的许可未核实。
- 显卡：必须是 Ampere 及以上架构，并装 flash-attn。
- 成熟度：约 25 星。作者说点云模态在强化学习下不稳定、不再继续开发，图片模型效果最好。
- 我们怎么用：把分割出的家具渲染成多视角图，让它出初稿。它的迭代编辑协议可以借鉴到我们的循环里。

**② `Zero-to-CAD`（Autodesk Research，2026-04）**
- 链接：https://huggingface.co/ADSKAILab/Zero-To-CAD-Qwen3-VL-2B （没有 GitHub 仓库，按模型卡用 transformers 调用）
- 做什么：输入同一物体的 8 张渲染视图，输出 `CadQuery` 代码。
- 许可：权重和 100 万条训练数据都是 Apache-2.0，可商用。
- 显卡：需要，2B 参数，显存要求未核实。
- 效果（模型卡自报）：自家测试集成功率 82.1%，平均交并比 0.747；在训练分布之外的 ABC 数据上成功率 61.0%，平均交并比 0.377。
- 我们怎么用：和 `CADReasoner` 用途相同，可以两个都跑，取残差小的那个。

**③ `MeshCoder`（只借形状接口设计）**
- 链接：https://github.com/InternRobotics/MeshCoder （NeurIPS 2025）
- 做什么：输入点云，输出按部件拆分的 Blender 脚本。它的自定义接口有基本体、截面沿三维轨迹扫掠、截面之间放样、倒角、布尔和阵列；训练数据是 Infinigen 生成的 41 类室内物体。
- 许可：代码 MIT；权重是 CC-BY-NC-SA-4.0，还受 Llama 3.2 许可约束，不可商用。
- 显卡：推理需要；执行生成的脚本只要 bpy，CPU 就行。
- 我们怎么用：它的形状词汇和本项目最接近，可以借鉴来设计我们形状库的接口。权重只做内部评估。

其他：
- `cadrille`：代码 Apache-2.0，权重 CC-BY-NC。它的训练代码可以在我们自己的家具程序数据上重新训练，是将来自训模型的起点。
- `CAD-Recode`：代码和权重都是 CC-BY-NC，只作基线。
- `Img2CAD`：MIT，另受 Llama 3.2 许可约束。它提供椅、桌、柜三类家具的 CAD 标注数据，"语言模型定离散结构，网络回归连续参数"的拆分方式可以借鉴。

#### 4.3 模板库与检索对齐

传统的"扫描里检索现成模型再对齐"（`Scan2CAD`、`ROCA` 等）以 ShapeNet 和 ScanNet 作为模型库和训练数据，有三个问题：许可不可商用；输出只是库里"相似"的网格；定制件在库里找不到。因此不推荐直接用。

可以借的是它的流程：检索 → 9 自由度对齐（位置、旋转、各向异性缩放）→ 同款物体聚类克隆。把候选库换成"我们自己的参数模板 × 参数取值"即可。

**① 自建参数模板库，参考 `Infinigen` / `Infinigen Indoors`**
- 链接：https://github.com/princeton-vl/infinigen
- 做什么：提供沙发、桌椅、柜架等程序化生成器，参数可调，全部由数学规则生成，不用外部资产。
- 许可：BSD-3，可商用。运行依赖 GPL 许可的 Blender，内部使用不受影响。
- 显卡：未核实。
- 我们怎么用：参考它的生成器，写我们自己的 `build123d` 家具模板。它输出的是网格，不是 B-rep，参数含义要读源码才清楚。有了模板库，大模型的工作就变成"选模板、填实测尺寸、必要时加特征"。

**② `HOC-Search` / `SCANnotate` 的搜索思路**
- 链接：https://github.com/stefan-ainetter/HOC-Search 、https://github.com/stefan-ainetter/SCANnotate
- 做什么：
  - 不需要训练，用渲染比对打分，用类似蒙特卡洛树的层次搜索在候选里找形状和位姿，比穷举快 10–120 倍；
  - SCANnotate 还会把同款物体聚类"克隆"成同一个模型，再做可微的 9 自由度精修。
- 许可：GPL-3.0，内部可用，对外分发必须开源。默认模型库是 ShapeNet，不可商用。
- 显卡：作者在 RTX 4090 上测试；纯 CPU 能否跑完整流程未核实。
- 我们怎么用：照搬思路。候选换成"模板 × 参数网格"，打分改成在 CPU 上算倒角距离或比对深度图。同款聚类正好对应"模板实例"。

**③ `SuperDec`（超二次曲面分解）**
- 链接：https://github.com/elisabettafedele/superdec （ICCV 2025 Oral）
- 做什么：把已经分割好的单个物体点云压缩成少量超二次曲面，每个曲面有形状指数、三轴尺寸和姿态。超二次曲面本身就能表达圆角盒、圆柱和椭球。
- 许可：代码 MIT；权重用 ShapeNet 训练，没有单独声明许可，商用有风险。
- 显卡：训练需要；推理需求未核实。
- 我们怎么用：给大模型一份"由几块组成、每块多大、朝哪个方向"的初始部件草图，再换成 `CadQuery` 图元精修。

**④ 测量拟合：`Point2CAD` / 随机抽样一致拟合**
- 链接：https://github.com/prs-eth/point2cad
- 做什么：对已按曲面分好簇的点拟合平面、球、圆柱、圆锥和自由曲面，再让曲面两两求交，得到边和角点。
- 许可：Apache-2.0。附带的 ParSeNet 预训练权重没有声明许可。
- 显卡：可选，只用 CPU 完全可行。
- 我们怎么用：给出桌腿半径、台面厚度、圆弧半径等连续参数。前端的分簇改用随机抽样一致或区域生长，不用它默认的 ParSeNet（在合成零件上训练，且没有许可证）。

#### 4.4 生成网格（只作辅助）

单个物体的"图片生成三维"已经很成熟，但有以下局限：
- 输出都是致密网格或高斯，不是参数结构；
- 坐标大多是归一化的单位立方体，尺寸是猜出来的；
- 全部需要 NVIDIA 显卡；
- `TRELLIS` 系、`SAM 3D Objects`、`Pixal3D` 都依赖 `nvdiffrast`，它的 NVIDIA 源码许可第 3.3 条规定只能用于非商业的研究或评估。

在本项目里，它们只用来补全扫描看不到的部分、作为形状参考，或者处理图元确实表达不了的物件。

**① `Hunyuan3D-Omni`：唯一能用扫描数据约束生成的**
- 链接：https://github.com/Tencent-Hunyuan/Hunyuan3D-Omni
- 做什么：输入图片加一种控制信号（点云、体素、包围盒、骨骼四选一），输出无贴图网格。
- 许可：腾讯混元 3D Omni 社区许可，不适用于欧盟、英国、韩国，月活超过 100 万要另行授权。注意混元开源的只有 2.x 系列；3.0 和 3.1 只是付费托管服务，没有开源权重。
- 显卡：约 10GB。
- 我们怎么用：把扫描中该家具的局部点云或包围盒作为控制信号，生成比例与扫描一致、背面补全的网格，作为测量参考。

**② `SAM 3D Objects`**
- 链接：https://github.com/facebookresearch/sam-3d-objects
- 做什么：输入图片和物体掩码，输出每个物体的网格或高斯，并直接给出物体在相机坐标系下的旋转、平移和尺度；可以传入外部点图。
- 许可：SAM License，可商用但禁止军事等用途；Hugging Face 权重需人工审批；依赖 `nvdiffrast`。
- 显卡：至少 32GB。
- 我们怎么用：把激光雷达深度转成点图喂进去，得到公制尺度、和扫描对齐的物体，用于被遮挡的家具，比如会议桌下的椅子。

**③ `TRELLIS.2`**
- 链接：https://github.com/microsoft/TRELLIS.2
- 做什么：单张图片生成带物理材质（PBR）的网格；另有一条"给定网格生成 PBR 贴图"的管线。
- 许可：代码和权重都是 MIT；依赖 `nvdiffrast`、`nvdiffrec`（非商用）和 `DINOv3`（Meta 自定许可，下载需审批）。
- 显卡：至少 24GB。
- 我们怎么用：它是 `LiteReality-Agent` 处理不规则物体的后端。对我们更有用的是给参数模型补被遮挡处的贴图。商用前要请法务确认，或者替换掉渲染器。

**④ `Step1X-3D` / `Direct3D-S2`：许可较干净的备选**
- 链接：https://github.com/stepfun-ai/Step1X-3D 、https://github.com/DreamTechAI/Direct3D-S2
- 做什么：单张图片生成带贴图的网格（Step1X-3D）或高分辨率几何（Direct3D-S2）。
- 许可：Step1X-3D 的代码和权重是 Apache-2.0，但它的贴图烘焙复用了混元 2.0 的 `custom_rasterizer`，这部分许可要另外核实。Direct3D-S2 的代码和权重是 MIT。
- 显卡：Step1X-3D 约 27GB；Direct3D-S2 为 10–24GB。
- 我们怎么用：处理绿植、摆件等图元难以表达的小物件。

### 5. 贴图与校验

**贴图转移**

**① `xatlas` + `Blender` 烘焙（现在就能做）**
- 链接：https://github.com/jpcy/xatlas
- 做什么：把三角网格切块、展平，并打包成贴图坐标（UV）集。
- 许可：MIT，可商用。显卡：不需要。
- 我们怎么用：
  1. 把参数模型三角化；
  2. 用 `xatlas` 生成贴图坐标；
  3. 从参数表面沿法线发射线，采样 Scaniverse 网格的 8192² 贴图，烘焙到新贴图上（也可以用 Blender 的"选中到活动"烘焙）。
  
  整个过程可以在云端 CPU 上完成。

**② `mvs-texturing`（TexRecon，有原始帧之后）**
- 链接：https://github.com/nmoehrle/mvs-texturing
- 做什么：把带位姿的照片投影到网格上生成贴图集，带接缝平衡。
- 许可：BSD-3，可商用。显卡：推测以 CPU 为主，未核实。
- 我们怎么用：直接用原始照片给参数模型重新生成贴图，比从 Scaniverse 贴图二次烘焙更清晰。

**③ `OpenMVS` 的 `TextureMesh`**
- 链接：https://github.com/cdcseacave/openMVS
- 做什么：`--mesh-file` 参数可以给任意外部网格，用已标定的照片烘焙贴图，还支持把共面三角形合并成虚拟面片。自带 `InterfacePolycam`，能直接导入 Polycam 原始数据。
- 许可：AGPL-3.0。内部使用没有问题；如果修改后作为网络服务提供给外部用户，需要公开修改后的源码。
- 显卡：CPU 可以运行。
- 我们怎么用：和 ② 二选一。走 Polycam 路线时优先用它。

**④ 被遮挡区域补贴图**：`TRELLIS.2` 的贴图管线，或混元的 `Paint` 模型。许可问题见 4.4。

**校验**（全部用确定性代码，可以跑在云端 CPU）
1. **点到面距离和包围盒误差**：`Open3D` 的 `RaycastingScene` 和迭代最近点配准。
2. **图元回测**：用 `pyRANSAC-3D` 或 `PCL` 在对应的扫描点上重新拟合，回测半径、平面度和尺寸残差。
3. **实体检查**：用 OCCT（通过 `CadQuery`/`build123d`）算体积、包围盒和干涉碰撞。可以借鉴 `LiteReality-Agent` 的 `check_collisions` 和渲染比对工具，以及 `Articraft` 的 `validate`。
4. **整条流水线的评测**：`SceneActBench`（MIT）的"无界面 Blender 加 MCP"评测框架可以用来评估我们自己的流水线；`Scan2CAD` 的"按类别统计对齐精度"口径可以作为验收标准。

规则：每轮修改都要量化比对，结果变差就回退。模型的自评只作参考，不作裁判。

---

## 二、推荐组合方案

### 档一：现在就能做（Scaniverse 网格 + 云端 CPU + 外部大模型接口）

| 步骤 | 做法 | 工具 | 运行位置 |
|---|---|---|---|
| 1. 读入与摆正 | 读入 glb，让 Z 轴朝上、墙面与坐标轴对齐，再采样成点云 | `Open3D`，或无界面 `Blender` | 云端 CPU |
| 2. 房间外壳 | 平面检测 → 拼封闭外壳 → 量出墙端点、墙高、墙厚和门洞；玻璃幕墙从框架和交线推断 | `Open3D`/`pyRANSAC-3D`/`PCL`；`CGAL` `PolyFit` 或动力学重建；参考 `Cloud2BIM` | 云端 CPU |
| 3. 分出物体并命名 | 去掉外壳平面后聚类成物体团；渲染每团的截图，交给多模态大模型命名并判断是否同款；粘连的物体人工拆开 | `PCL` 欧氏聚类或区域生长 + 大模型接口 | 云端 CPU + 接口 |
| 4. 测量包 | 为每个物体算出有向包围盒、主要平面和圆柱的拟合参数、截面轮廓、关键尺寸（截面思路借鉴 `CAD-Assistant` 的"截面生成器"，自己实现，它的代码不可商用） | `Open3D`、`pyRANSAC-3D`、`Point2CAD` | 云端 CPU |
| 5. 写程序 | 大模型按我们自定义的形状库写 `build123d`/`CadQuery`：墙体部分借用 `SpatialLM` 的文本格式；家具写成模板函数加实例；测量包写进提示词 | `build123d`/`CadQuery`；形状库接口照 `Articraft`、`MeshCoder` 设计 | 接口 + 云端执行 |
| 6. 校验循环 | 执行程序 → 算点到面距离、包围盒误差、碰撞、渲染比对 → 把结构化反馈交给模型改代码，变差就回退；按"外壳、大件、小件"分阶段 | `Open3D`、OCCT；参照 `LiteReality-Agent` 的工具清单和 `Code-as-Room` 的分阶段流程 | 云端 CPU + 接口 |
| 7. 贴图 | 三角化 → `xatlas` 展开 → 从 Scaniverse 贴图烘焙 | `xatlas`、`Blender` | 云端 CPU |
| 8. 人工把关 | 本地交互检查和精修 | `blender-mcp`（隔离环境） | 本地 |

同时可以做一次基线对照：用免费的 `LiteReality Scanner` 再扫一次前厅，原样跑一遍 `LiteReality-Agent`，看它的效果和我们的差距。要注意，它默认会把数据传到 Modal 和大模型服务商，先确认公司的数据政策；也可以在本地 24GB 显卡上跑。另外，大模型接口在档一里也会收到前厅的渲染图，这一点也要符合数据政策。

### 档二：有本地显卡、改采原始帧之后（在档一的基础上替换或增强）

- **采集**：用 `Stray Scanner`（开源）或 `Polycam` 开发者模式，拿到 RGB-D 帧和 ARKit 位姿。
- **几何**：用 `PromptDA` 补全深度 → `Open3D` 融合；用 `COLMAP` 以 ARKit 位姿为先验做校正；需要时用 `DN-Splatter` 精修（法线用传感器深度算，或用 `MoGe-3`）。
- **结构**：仍以 CPU 几何拟合为主。`SpatialLM` 在本地出一份对照稿，不进生产。想试 `PlanarSplatting`，要先处理掉它的非商用子模块。
- **分割识别**：
  - 在真实帧上用 `SAM 3.1` 文本提示分割，再反投影投票（合并算法借鉴 `MV3DIS`），用 `Point-SAM` 点击修正；
  - 用 `ConceptGraphs`（去掉 `ultralytics`）给大模型提供场景图；
  - 用 `SAMPart3D` 或 `P3-SAM` 给出部件骨架。
- **建模初稿**：
  - 规则件：用 `CADReasoner` 或 `Zero-to-CAD` 出 `CadQuery` 初稿，再由大模型加测量精修；
  - 被遮挡的家具：用 `Hunyuan3D-Omni`（以扫描点云为约束）或 `SAM 3D Objects`（以点图为输入）补全背面，作为测量参考；
  - 实在无法用图元表达的小物件：用 `Step1X-3D` 或 `Direct3D-S2`。
- **贴图**：用 `mvs-texturing` 或 `OpenMVS` `TextureMesh`，以原始照片给参数模型重新生成贴图；遮挡区域在许可确认后用 `TRELLIS.2` 的贴图管线补。
- **长期**：积累"扫描片段 ↔ 我们形状库程序"的配对数据后，可以用 `cadrille`（训练代码 Apache-2.0）或 `CADReasoner` 的训练代码，在家具数据上微调我们自己的模型。

### 明确不推荐的路线

1. **把 `SpatialLM`、`SceneScript` 的输出直接当生产用的结构**。它们只到包围盒，没有圆角和弧度；权重带 CC-BY-NC；`SceneScript` 的输入还绑定 Aria 眼镜的点云。
2. **在生产中使用以下非商用权重**：`CAD-Recode`、`cadrille`、`MeshCoder`、`Text2CAD`、`Cubify Anything` 的权重，`CAD-Assistant` 的代码，以及 `Pointcept` 的预训练权重。许可不可商用，训练分布也不对（机械零件、合成数据）。
3. **只靠大模型写几何、让模型自评**。`LEGO-Anything` 和 `SceneActBench` 的结果都说明几何不准、自评不可靠，迭代时还会越改越坏。
4. **把生成网格（`TRELLIS` 系、混元等）当成最终模型**。它们不是参数模型，坐标是归一化的，尺寸靠猜；`nvdiffrast` 也不可商用。
5. **用 Scan2CAD 式的模型库检索替换**（`Scan2CAD`、`ROCA`、`SPARC`、`DiffCAD`、`ACDC`、`MetaScenes`，以及 `Phone2Proc` 的家具随机替换）。模型库和权重受 ShapeNet、ScanNet、BEHAVIOR 等条款限制；定制件不在库里；输出不是参数模型。
6. **单图场景生成**（`MIDI-3D`、`SceneGen`、`Gen3DSR`、`CAST`、`Mira-Scene`、`Diorama`）。它们的布局只有相对尺度，而我们已经有度量扫描。`SceneGen` 还依赖不可商用的 `VGGT-1B`。
7. **主流高斯泼溅和神经隐式表面重建代码**（`2DGS`、`GOF`、`MILo`、`PGSR`、`Neuralangelo`、`NeuS2`，以及 `Gaussian Grouping` 的光栅器）。都是非商用许可，后两个还已停更。改用 `gsplat` 或 `DN-Splatter`。
8. **直接复用没有许可证的仓库代码**：`BlenderAlchemy`、`BlenderGym`、`3D-GPT`、`LayoutVLM`、`PolyRoom`、`SPARC`、`MetaScenes`、`Open-YOLO 3D`、`SAI3D`、`MaskClustering`、`SAM2Object`、`ParSeNet`、`HPNet`、`SED-Net`。没有许可证等于保留所有权利，只能借思路。
9. **`LL3M`**。它只允许学术评估，作者也已停掉服务端，仓库基本无法直接使用。
10. **把 `blender-mcp` 暴露在云端**。它能执行任意代码，套接字没有认证。
11. **把 `Hunyuan3D` 3.0 和 3.1 当成开源方案**。它们只是付费托管服务。
12. **楼层平面学习方法**（`RoomFormer`、`PolyRoom`、`CAGE`）。我们只有一个前厅，用不上；`PolyRoom` 没有许可证，`CAGE` 商用需授权。

---

## 三、许可要点

1. **非商用许可一律不进生产**：CC-BY-NC、NVIDIA 源码许可、Inria 许可、S-Lab 许可等都属于这一类。公司内部使用是否算"商用"由法务判断。
2. **GPL 和 AGPL 内部使用没有问题**（`CGAL`、`PolyFit`、`HOC-Search`、`PrimitiveAnything`、`OpenMVS`）。对外分发，或者把修改过的 AGPL 程序作为网络服务对外提供时，才会触发开源义务。
3. **隐性的非商用依赖**，最容易踩坑：
   - `nvdiffrast`（`TRELLIS` 系、`SAM 3D Objects`、`Pixal3D`）
   - Inria 光栅器（`PlanarSplatting` 子模块、`Gaussian Grouping`）
   - `VGGT-1B` 和 `VGGT-Omega`
   - `Omnidata` 和 `DSINE`
   - `Depth Anything V2` 的 Base 和 Large 权重
   - `ultralytics`（AGPL）、`ODISE`
   - 在 ScanNet 或 ShapeNet 上训练的权重（法律上不明确）
4. **Hugging Face 标签和官方 README 冲突时，以 README 为准**：`Pointcept/Sonata` 标 MIT（官方为 CC-BY-NC）、`DA3-LARGE-1.1` 标 Apache（README 列为非商用）、`yyfz233/Pi3` 标 BSD-2（README 为 CC-BY-NC）。`Amodal3R` 的代码许可和权重许可也互相冲突，整体按不可商用处理。
5. **有条件可商用**：
   - 腾讯混元系列：排除欧盟、英国、韩国，月活超过 100 万需另行授权；
   - Stability 的 `SF3D`、`SPAR3D`：年收入低于 100 万美元才免费；
   - SAM License：有贸易管制条款，禁止军事用途；
   - 受 Llama 3.2 许可约束的模型：`MeshCoder`、`Img2CAD`、`SpatialLM`；
   - `VGGT-1B-Commercial`：需要人工审批。
6. **没有许可证文件就等于保留所有权利**，不能当作开源代码使用。

---

## 四、全部调研项目总表

说明：
- "许可"一栏的结论分为：可商用、不可商用、有条件、无许可证。
- 标"（未核实）"的是本次没能确认的信息。
- 星数和日期取自调研时读到的页面，可能滞后几周。

| 名称 | 链接 | 方向 | 许可（商用结论） | 显卡 | 一句话 |
|---|---|---|---|---|---|
| `Stray Scanner` 应用 + `StrayVisualizer` | https://github.com/strayrobots/scanner ；https://github.com/kekeblom/StrayVisualizer | 采集 | MIT，可商用 | 否 | 开源 iOS 采集应用，导出 RGB、毫米深度、置信度、ARKit 位姿 |
| `Polycam` 开发者模式 + `polyform` | https://github.com/PolyCam/polyform | 采集 | `polyform` MIT；Polycam 应用是商业软件，开发者模式是否收费（未核实） | 否 | 导出原始帧、全局优化位姿、深度和 `raw.glb` |
| Apple `RoomPlan` | https://developer.apple.com/augmented-reality/roomplan | 采集/场景结构 | 专有，随 iOS SDK 免费；商用以开发者协议为准 | 否（在手机上运行） | 设备上实时得到参数化墙、门窗、物体框，不能处理已有网格 |
| `COLMAP` 4.x（含已并入的 `GLOMAP`） | https://github.com/colmap/colmap | 位姿/重建 | BSD-3，可商用；4.x 学习特征权重的许可（未核实） | 稀疏部分只用 CPU；稠密部分需 CUDA | 公认的位姿与稀疏重建标准，4.2.1 发布于 2026-09；`GLOMAP` 仓库已于 2026-03-09 归档 |
| `Open3D` | https://github.com/isl-org/Open3D | 融合/测量 | MIT，可商用 | 否 | TSDF 融合、平面拟合、迭代最近点配准、距离查询 |
| `VDBFusion` | https://github.com/PRBonn/vdbfusion | 融合 | MIT，可商用 | 否 | CPU 版 TSDF 融合，最后提交 2025-01 |
| `nvblox` | https://github.com/nvidia-isaac/nvblox | 融合 | Apache-2.0，可商用 | 需要 NVIDIA | 显卡版 TSDF 融合，2026-10 仍活跃 |
| `nerfstudio` | 调研未单列链接（nerfstudio-project 组织） | 高斯泼溅/NeRF 框架 | Apache-2.0，可商用 | 需要 | 能直接导入 Polycam 数据，活跃度在下降 |
| `gsplat` | https://github.com/nerfstudio-project/gsplat | 高斯泼溅 | Apache-2.0，可商用 | 需要 | 自带 Apache 版 2DGS，是避开 Inria 许可的基础设施 |
| `DN-Splatter` / `AGS-Mesh` | https://github.com/maturk/dn-splatter | 室内表面重建 | 代码 Apache-2.0；默认法线先验不可商用，需替换 | 需要 | 用手机激光雷达深度和法线约束，网格更平整 |
| `2DGS` | https://github.com/hbb1/2d-gaussian-splatting | 表面重建 | Inria 许可，不可商用 | 需要 | 高斯类表面重建的基准，只作对照 |
| `PGSR` | https://github.com/zju3dv/PGSR | 表面重建 | 浙大许可，不可商用 | 需要 | 平面高斯，对墙地友好，已停更 |
| `GOF` | https://github.com/autonomousvision/gaussian-opacity-fields | 表面重建 | Inria 许可，不可商用 | 需要 | 无界场景网格提取的代表作，已停更 |
| `MILo` | https://github.com/Anttwo/MILo | 表面重建 | Inria 许可，不可商用 | 需要 | 2025 年最新工作，网格轻而干净 |
| `Neuralangelo` | https://github.com/NVlabs/neuralangelo | 神经隐式 | NVIDIA 许可，不可商用（且限 NVIDIA 硬件） | 默认 24GB | 已停更，被高斯类方法取代 |
| `NeuS2` | https://github.com/19reborn/NeuS2 | 神经隐式 | NVIDIA 许可，不可商用 | 需要 | 单物体快速重建，已停更 |
| `OpenMVS` | https://github.com/cdcseacave/openMVS | 稠密重建/贴图 | AGPL-3.0，内部可用 | CPU 可运行 | `TextureMesh` 能给外部网格烘焙贴图，可导入 Polycam 数据 |
| `PromptDA` | https://github.com/DepthAnything/PromptDA | 深度补全 | 代码和权重 Apache-2.0；对 DAv2 许可的继承关系（未核实） | 需要（Small 能否在 CPU 上跑，未核实） | 以激光雷达深度为提示出 4K 度量深度，有透明物体版 |
| `MapAnything` | https://github.com/facebookresearch/map-anything | 前馈几何 | 代码 Apache-2.0；`map-anything-apache` 权重可商用，默认权重不可商用 | 需要 | 能融合已知位姿和深度，可导出 COLMAP 格式 |
| `VGGT` | https://github.com/facebookresearch/vggt | 前馈几何 | 代码可商用（军事除外）；只有 `VGGT-1B-Commercial`（需审批）可商用，`VGGT-1B` 和 `VGGT-Omega` 不可商用 | 需要 | 补位姿、深度、点图，CVPR 2025 最佳论文 |
| `Depth Anything 3` | https://github.com/ByteDance-Seed/Depth-Anything-3 | 深度/位姿 | 代码 Apache-2.0；Small、Base、Metric-Large、Mono-Large 可商用，Large、Giant、Nested 不可商用 | 需要 | 给深度去噪、补玻璃和暗处空洞 |
| `π³`（`Pi3`/`Pi3X`） | https://github.com/yyfz/Pi3 | 前馈几何 | 代码 BSD-3；权重 CC-BY-NC（HF 标签与 README 冲突，以 README 为准） | 需要 | VGGT 的替代，只作内部评估 |
| `MoGe` / `MoGe-2` / `MoGe-3` | https://github.com/microsoft/MoGe | 单目几何/法线 | 代码和权重 MIT，可商用 | 建议使用 | 可商用的法线先验；`MoGe-3` 发布于 2026-08-18 |
| `Omnidata`、`DSINE` | 调研未给链接 | 法线先验 | 不可商用 | 需要 | `DN-Splatter` 的默认先验，需要替换 |
| `Depth Anything V2` | 调研未给链接 | 深度 | Base 和 Large 权重 CC-BY-NC | 需要 | `PromptDA` 的基础模型、`MILo` 的可选先验 |
| `SpatialLM` | https://github.com/manycore-research/SpatialLM | 场景结构语言 | 仓库为 Llama 3.2 社区许可；权重含 CC-BY-NC 成分，不可商用 | 需要 | 点云转 Wall/Door/Window/Bbox 文本；1.5 版未找到（未核实） |
| `SceneScript` | https://github.com/facebookresearch/scenescript | 场景结构语言 | CC-BY-NC-4.0，不可商用 | 需要 | "扫描转指令语言"的开创性工作，输入绑定 Aria 设备 |
| `openPlan3D` | https://github.com/laanlabs/openPlan3D | 平面编辑 | MIT，可商用 | 未说明 | 可导入 RoomPlan 结果的平面编辑器 |
| `Cubify Anything` | https://github.com/apple/ml-cubifyanything | 物体框检测 | 权重仅限研究，不可商用；CA-1M 数据为 CC-BY-NC-ND | CUDA、MPS 或 CPU（速度未核实） | RGB-D 帧上的类别无关物体框 |
| `PolyFit` | https://github.com/LiangliangNan/PolyFit | 外壳重建 | GPL-3.0（CGAL 版可买商用许可），内部可用 | 否 | 把平面片拼成封闭多边形网格 |
| `CGAL` 动力学表面重建/空间剖分 | https://github.com/CGAL/cgal | 外壳重建 | GPL-3.0-or-later 或商业许可 | 否 | 平面多、数据缺失时比 PolyFit 稳；Python 绑定覆盖（未核实） |
| `CGAL` 形状检测 | https://github.com/CGAL/cgal | 测量拟合 | 同上 | 否 | 拟合平面、球、圆柱、圆锥、圆环 |
| `Cloud2BIM` | https://github.com/VaclavNezerka/Cloud2BIM | 外壳转 BIM | MIT，可商用 | 核心不需要；新的深度学习模块（未核实） | 点云转 IFC 格式的墙、板、洞口 |
| `RoomFormer` | https://github.com/ywyue/RoomFormer | 楼层平面 | 代码 MIT；Structured3D 数据条款（未核实） | 需要 | 多房间平面重建基线，已停更 |
| `PolyRoom` | https://github.com/3dv-casia/PolyRoom | 楼层平面 | 无许可证 | 需要 | 只能借思路 |
| `CAGE` | 调研未给链接 | 楼层平面 | MIT 附加 Commons Clause，商用需授权 | 未说明 | `RoomFormer` 的后继工作 |
| `PlanarSplatting` | https://github.com/ant-research/PlanarSplatting | 平面重建 | 主仓库 Apache-2.0；光栅化子模块和默认 VGGT 权重不可商用 | 需要 | 从多视角照片直接出平面图元 |
| `AirPlanes` | https://github.com/nianticlabs/airplanes | 平面重建 | 不可商用 | 未说明 | 效果不如 `PlanarSplatting` |
| `City3D` | 调研未给链接 | 建筑外壳 | GPL-3 | 未说明 | 针对室外机载激光雷达，不适合室内 |
| `LayoutVLM` | https://github.com/sunfanyunn/LayoutVLM | 布局生成 | 无许可证 | 需编译 CUDA 算子 | "视觉语言模型给初值、再可微优化"，只借思路 |
| `Holodeck` | https://github.com/allenai/Holodeck | 布局生成 | 代码 Apache-2.0；Objaverse 资产需逐个核对许可 | 不要求 | 大模型给约束、求解器摆放 |
| `LayoutGPT` | 调研未给链接 | 布局生成 | MIT | 未说明 | 已被 `Holodeck`、`LayoutVLM` 取代 |
| `The Scene Language` | https://github.com/zzyunzhi/scene-language | 场景程序 | MIT，可商用 | 未提及 | 函数加实例化的分层场景程序 |
| `Infinigen` / `Infinigen Indoors` | https://github.com/princeton-vl/infinigen | 程序化家具 | BSD-3，可商用（运行依赖 GPL 的 Blender） | （未核实） | 参数可调的家具生成器，可作模板参考 |
| `SAM 2` / `SAM 2.1` | https://github.com/facebookresearch/sam2 | 二维分割 | Apache-2.0，可商用 | 需要 | 视频里跨帧跟踪实例 |
| `SAM 3` / `SAM 3.1` | https://github.com/facebookresearch/sam3 | 二维分割 | SAM License，有条件可商用（贸易管制），权重需审批 | 需要（显存未核实） | 用文本概念提示一次分出全部实例 |
| `Grounding DINO` | 调研未给链接 | 二维检测 | Apache-2.0，可商用 | 需要 | 文本提示检测，可配合 SAM 2.1 |
| `Mask3D` | https://github.com/JonasSchult/Mask3D | 三维实例分割 | 代码 MIT；ScanNet 训练的权重能否商用不明确 | 需要 | 点云实例分割的经典基线 |
| `OpenMask3D` | https://github.com/OpenMask3D/openmask3d | 开放词汇三维实例 | 代码 MIT；权重有 ScanNet 条款风险 | 需要 | 三维候选加多视角 CLIP 特征 |
| `Open3DIS` | https://github.com/VinAIResearch/Open3DIS | 开放词汇三维实例 | BSD-3；是否提供权重（未核实） | 需要 | 二维引导找回小物体，支持 ARKitScenes |
| `Open-YOLO 3D` | https://github.com/aminebdj/OpenYOLO3D | 开放词汇三维实例 | 无许可证 | 需要 | 速度快，只借思路 |
| `OpenIns3D` | https://github.com/Pointcept/OpenIns3D | 开放词汇三维实例 | 代码 MIT；`ODISE` 不可商用，`YOLO-World` 为 GPL | 需要 | 从三维渲染二维再识别，最适合只有网格的情况 |
| `SAI3D` | https://github.com/yd-yin/SAI3D | 零样本三维实例 | 无许可证 | 需要 | 网格超点加多视角 SAM 投票 |
| `MV3DIS` | https://github.com/zybjn/MV3DIS | 零样本三维实例 | MIT，可商用 | 生成二维掩码时需要 | CVPR 2026，解决多视角掩码不一致，约 8 星 |
| `SAM2Object` | https://github.com/jihuaizhaohd/SAM2Object | 零样本三维实例 | 无许可证 | 需要 | 用 SAM2 跨帧跟踪 |
| `Segment3D` | https://github.com/LeapLabTHU/Segment3D | 类别无关三维分割 | 代码 Apache-2.0；权重未声明许可（有 ScanNet 风险） | 需要 | 只需网格，切分很细 |
| `OpenScene` | https://github.com/pengsongyou/openscene | 开放词汇语义 | 代码 Apache-2.0；权重未单独声明 | 需要 | 逐点语义，不给实例 |
| `ConceptGraphs` | https://github.com/concept-graphs/concept-graphs | 三维场景图 | 代码 MIT；依赖 AGPL 的 `ultralytics` 和 GPT-4 接口 | 需要 | 输出物体清单、描述和关系 |
| `Gaussian Grouping` | https://github.com/lkeab/gaussian-grouping | 高斯分组 | Apache-2.0，但光栅器不可商用 | 需要 | 每个场景都要训练，偏向渲染编辑 |
| `Point-SAM` | https://github.com/zyc00/Point-SAM | 三维可提示分割 | 代码 MIT，权重 Apache-2.0，可商用 | 需要 | 直接读 GLB，点击修正 |
| `OVIR-3D` | 调研未给链接 | 开放词汇三维实例 | MIT | 需要 | 已被后来的方法超越 |
| `MaskClustering` | 调研未给链接 | 零样本三维实例 | 无许可证 | 需要 | 3090 上每个场景约 2.6 分钟 |
| `OneFormer3D` | 调研未给链接 | 三维分割 | CC-BY-NC-4.0，不可商用 | 需要 | 封闭类别 |
| `Pointcept` `SAM3D` | 调研未给链接 | 零样本三维分割 | MIT | 需要 | ICCV 2023 研讨会工作 |
| `ESAM`（EmbodiedSAM） | 调研未给链接 | 流式三维分割 | MIT | 需要 | 处理流式 RGB-D，支持自定义数据 |
| `Mosaic3D` | 调研未给链接 | 三维基础模型 | 代码 Apache-2.0；HF 权重没有许可标签 | 需要 | NVIDIA 的大规模开放词汇模型 |
| `PanSt3R` | 调研未给链接 | 前馈全景分割 | NAVER 非商用许可 | 需要 | 从无位姿图像直接出全景分割 |
| `IGGT` | 调研未给链接 | 前馈分割与几何 | （未核实） | （未核实） | arXiv 2510.22706 |
| `Pointcept`（PTv3/Sonata/Concerto/Utonia） | https://github.com/Pointcept/Pointcept | 点云骨干网络 | 代码 MIT；预训练权重不可商用 | 需要 | 自训分割可以用它的代码，预训练权重不进生产 |
| `PartField` | https://github.com/nv-tlabs/PartField | 部件分割 | NVIDIA 许可，不可商用 | 需要 | 输出层级部件树，效果好 |
| `SAMPart3D` | https://github.com/Pointcept/SAMPart3D | 部件分割 | 代码和权重 MIT，可商用 | 需要 | 每个网格要单独训练 |
| `Hunyuan3D-Part`（`P3-SAM`、`X-Part`） | https://github.com/Tencent-Hunyuan/Hunyuan3D-Part | 部件分割/生成 | 腾讯社区许可，有条件；HF 无许可标签，以 GitHub 为准 | 需要（显存未核实） | 在扫描网格上出部件和部件包围盒 |
| `LiteReality-Agent` | https://github.com/LiteReality/LiteReality-Agent | 智能体重建房间 | Apache-2.0，可商用；需要外部大模型 | 主流程只用 CPU；TRELLIS 等默认跑在 Modal，本地需 24GB 以上 | 整屋写成 `Room.py`，渲染比对迭代，最接近本项目 |
| `LiteReality` | https://github.com/LiteReality/LiteReality | 扫描转可编辑场景 | 代码 Apache-2.0；约 200GB 资产库的许可未写明 | 24GB 以上 | NeurIPS 2025，检索替换物体并恢复材质；星数两轮不一致（约 350 或 440） |
| `Articraft` | https://github.com/articraftresearch/Articraft | 大模型写物体程序 | Apache-2.0，可商用；是否基于 build123d（未核实） | 否 | 圆角盒、扫掠、放样、倒角形状库，带自检 |
| `CadQuery` | https://github.com/CadQuery/cadquery | 参数化 CAD 内核 | Apache-2.0，可商用；OCCT 许可（未核实） | 否 | 推荐的目标语言 |
| `build123d` | https://github.com/gumyr/build123d | 参数化 CAD 内核 | Apache-2.0，可商用 | 否 | 推荐的目标语言 |
| `blender-mcp` | https://github.com/ahujasid/blender-mcp | 大模型操作 Blender | MIT，可商用；遥测可关，需隔离运行；条款更新日期（未核实） | 否 | 事实标准，约 3.37 万星 |
| `FreeCAD MCP` | https://github.com/neka-nat/freecad-mcp | 大模型操作 FreeCAD | MIT；同类的两个服务许可（未核实） | 否 | 在带特征树的 CAD 里交互建模 |
| `VIGA` | https://github.com/Fugtemypt123/VIGA | 单图转 Blender 程序 | MIT；依赖商业 Meshy 接口 | 三维模式建议 NVIDIA | 生成者与校验者的闭环 |
| `Code-as-Room` | https://github.com/YxuanAr/Code-as-Room | 俯视图转 Blender 程序 | Apache-2.0，可商用 | 否 | 分阶段流程，约 247 星 |
| `LEGO-Anything` | https://xirui-li.github.io/lego-anything-website/ | 单图转场景代码（评测） | 代码未公开（仓库 404） | （未核实） | 结论是几何差、自评不可靠 |
| `SceneActBench` | https://github.com/Feinaldo2/SceneActBench | 评测基准 | 代码 MIT；数据来源的条款（未核实） | 否 | 多视图房间重建最好成绩只有 12.3 |
| `LL3M` | https://github.com/threedle/ll3m | 文字转 Blender 脚本 | 只限学术评估，不可商用 | 推荐 8GB 以上 | 服务端已停，基本无法使用 |
| `BlenderAlchemy` | https://github.com/ianhuang0630/BlenderAlchemyOfficial | 视觉语言模型编辑 Blender | 无许可证 | 否 | 多候选加视觉择优，已停更 |
| `BlenderGym` | https://github.com/richard-guyunqi/BlenderGym-Open | 评测 | 无许可证 | 否 | 已停更 |
| `3D-GPT` | https://github.com/Chuny1/3DGPT | 文字转程序化参数 | 无许可证 | 未说明 | 调的是 Infinigen 参数，不是重建 |
| `BlenderLLM` | 调研未给链接 | 文字转 bpy | 代码和权重 Apache-2.0 | 未说明 | 只会写简单 bpy，2024-12 起停更 |
| `CADCodeVerify` | https://github.com/Kamel773/CAD_Code_Generation | 评测数据 | 无许可证 | 不涉及 | 只放了 CADPrompt 数据集，没有方法代码 |
| `CAD-Assistant` | https://github.com/dimitrismallis/CAD-Assistant | 智能体写 FreeCAD 代码 | CC-BY-NC-4.0，不可商用 | 否 | "截面生成器"这类测量思路可以复刻 |
| `CADReasoner` | https://github.com/zhemdi/CADReasoner | 图像或点云转 CadQuery | 代码和权重 Apache-2.0，可商用；训练数据许可（未核实） | Ampere 及以上 | 用几何差异反馈迭代改程序 |
| `Zero-to-CAD` | https://huggingface.co/ADSKAILab/Zero-To-CAD-Qwen3-VL-2B | 8 张视图转 CadQuery | 权重和数据 Apache-2.0，可商用 | 需要（显存未核实） | 100 万条可商用训练数据 |
| `cadrille` | https://github.com/col14m/cadrille | 多模态转 CadQuery | 代码 Apache-2.0；权重 CC-BY-NC | 需要 | 可以用它的代码自己训练 |
| `CAD-Recode` | https://github.com/filaPro/cad-recode | 点云转 CadQuery | 代码和权重 CC-BY-NC，不可商用 | 建议使用 | 领域标杆，真实扫描上掉点明显 |
| `MeshCoder` | https://github.com/InternRobotics/MeshCoder | 点云转分部件 Blender 脚本 | 代码 MIT；权重 CC-BY-NC-SA，另受 Llama 3.2 约束 | 需要 | 形状接口和本项目最接近 |
| `PrimitiveAnything` | https://github.com/PrimitiveAnything/PrimitiveAnything | 网格转基本体装配 | GPL-3.0（编码器 LGPL-3.0） | 需要 | 只有盒、椭圆柱、椭球三类，参数离散 |
| `Img2CAD` | https://github.com/qq456cvb/Img2CAD | 单图转家具 CAD | MIT，另受 Llama 3.2 约束 | 需要（11B） | 只覆盖椅、桌、柜三类 |
| `CAD-Coder` | https://github.com/anniedoris/CAD-Coder | 单图转 CadQuery | 代码 Apache-2.0；权重没有许可标签（未核实） | 需要（13B） | 图像转 CadQuery 的基线 |
| `Point2CAD` | https://github.com/prs-eth/point2cad | 解析曲面拟合 | Apache-2.0，可商用 | 可选 | 在 CPU 上能跑的曲面拟合与求交 |
| `ParSeNet` / `HPNet` / `SED-Net` | https://github.com/Hippogriff/parsenet-codebase ；https://github.com/SimingYan/HPNet ；https://github.com/yuanqili78/SED-Net | 基本体分割 | 无许可证 | 需要 | 在合成零件上训练，只借思路 |
| `ComplexGen` | https://github.com/guohaoxiang/ComplexGen | 点云转 B-rep | MIT | 需要（CUDA 10.1 老环境） | "网络给概率、约束优化恢复合法拓扑"的思路 |
| `SECAD-Net` / `ExtrudeNet` / `CAPRI-Net` / `Point2Cyl` | https://github.com/BunnySoCrazy/SECAD-Net ；https://github.com/kimren227/ExtrudeNet ；https://github.com/FENGGENYU/CAPRI-Net ；https://github.com/mikacuy/point2cyl | 反推草图加挤出 | MIT | 需要 | 要逐个形状微调，多数输出隐式场 |
| `DeepCAD` | https://github.com/ChrisWu1997/DeepCAD | CAD 命令序列/数据集 | 代码 MIT；权重未单独声明 | 需要 | 领域数据格式的源头；最近提交日期（未核实） |
| `Text2CAD` | https://github.com/SadilKhan/Text2CAD | 文本转 CAD | CC-BY-NC-SA-4.0，不可商用 | 需要 | 不接受扫描输入 |
| `SuperDec` | https://github.com/elisabettafedele/superdec | 超二次曲面分解 | 代码 MIT；权重（ShapeNet 训练）未声明许可 | 训练需要；推理（未核实） | 给出部件初始草图 |
| `pyRANSAC-3D` | https://github.com/leomariga/pyRANSAC-3D | 测量拟合 | Apache-2.0，可商用 | 否 | 轻量的图元拟合与回测工具 |
| `PCL` | https://github.com/PointCloudLibrary/pcl | 测量拟合/聚类 | BSD-3，可商用 | 否 | 工业界常用的 C++ 点云底座 |
| `shape2prog` | 调研未给链接 | 形状转程序 | BSD-2 | 需要（PyTorch 0.4） | 环境太旧 |
| `Marching-Primitives` | 调研未给链接 | 超二次曲面 | MIT | 否（MATLAB） | 只有 MATLAB 实现 |
| `Scan2CAD` | https://github.com/skanti/Scan2CAD | 检索加 9 自由度对齐 | CC-BY-NC-SA 3.0，不可商用 | 未写明 | 价值在问题定义和评测口径 |
| `ROCA` | https://github.com/cangumeli/ROCA | 单图检索对齐 | CC-BY-NC-SA 3.0，不可商用 | 需要 | 经典基线，依赖版本很老 |
| `SPARC` | https://github.com/florianlanger/SPARC | 渲染比对求位姿 | 无许可证 | 需要 | 迭代渲染比对的思路 |
| `CAD-Estate` | https://github.com/google-research/cad-estate | 数据集 | 代码 Apache-2.0；标注数据许可（未核实） | 可视化需要 | 结构和家具统一标注的格式 |
| `DiffCAD` | https://github.com/DaoyiG/DiffCAD | 单图概率检索 | 代码 CC0；权重许可未写明 | 需要 | 先出多个候选再挑选 |
| `FastCAD` | https://github.com/florianlanger/FastCAD | 扫描检索对齐 | 没有代码 | 不涉及 | 只能参考论文 |
| `HOC-Search` / `SCANnotate` | https://github.com/stefan-ainetter/HOC-Search ；https://github.com/stefan-ainetter/SCANnotate | 免训练搜索对齐 | GPL-3.0（SCANnotate 按页面标注） | 作者用 4090；纯 CPU（未核实） | 渲染比对搜索加同款克隆 |
| `SUFLECA` | https://github.com/snt-arg/SUFLECA | 单图 CAD 对齐 | 代码 Apache-2.0；权重许可未写明；性能数字来自二手报道（未核实） | 需要 | 2026 年新作，约 4 星，很不成熟 |
| `Diorama` | https://github.com/3dlg-hcvc/diorama | 单图零样本场景建模 | 代码 MIT；DuoduoCLIP 无许可证；需要 GPT-4 | 需要 | 大模型出场景图、优化器出数值 |
| `ACDC`（数字表亲） | https://github.com/cremebrule/digital-cousins | 单图检索相似资产 | 代码 Apache-2.0；BEHAVIOR 资产受限 | 24GB 以上 | 替换成同类相似资产，定制件无解 |
| `Phone2Proc` | https://github.com/allenai/phone2proc | RoomPlan 转 ProcTHOR | 代码 Apache-2.0；AI2-THOR 资产许可（未核实） | 未写明 | 墙必须首尾闭合；家具随机替换 |
| `MetaScenes` / `Scan2Sim` | https://github.com/meta-scenes/MetaScenes | 扫描转资产复刻 | 无许可证 | 需要 | 布局、对齐、物理消穿插的流程 |
| `OpenShape` / `Uni3D` | 调研未给链接 | 形状嵌入 | 代码 Apache-2.0 / MIT；权重许可（未核实） | 需要 | 可用于模板检索的嵌入 |
| `TRELLIS` | https://github.com/microsoft/TRELLIS | 图片生成三维 | 代码和权重 MIT；依赖的 nvdiffrast 不可商用 | 16GB 以上 | 生态最大 |
| `TRELLIS.2` | https://github.com/microsoft/TRELLIS.2 | 图片生成三维/贴图 | MIT；依赖 nvdiffrast 和 DINOv3（需审批） | 24GB 以上 | 有"给定网格生成 PBR 贴图"的管线 |
| `Pixal3D` | https://github.com/TencentARC/Pixal3D | 像素对齐生成 | MIT；继承 TRELLIS.2 的依赖 | 需要（低显存模式数值未核实） | 多视角版接受相机位姿 |
| `Hunyuan3D 2.0 / 2.1` | https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1 | 图片生成三维加贴图 | 腾讯社区许可，有条件 | 6–29GB | 3.0、3.1 没有开源 |
| `Hunyuan3D-Omni` | https://github.com/Tencent-Hunyuan/Hunyuan3D-Omni | 可控生成 | 腾讯社区许可，有条件 | 约 10GB | 可用点云或包围盒约束生成 |
| `SAM 3D Objects` | https://github.com/facebookresearch/sam-3d-objects | 单图物体三维加位姿 | SAM License，有条件可商用；依赖 nvdiffrast | 32GB 以上 | 直接给出位姿和尺度，可输入点图 |
| `TripoSR` | https://github.com/VAST-AI-Research/TripoSR | 快速前馈重建 | MIT，可商用 | 约 6GB | 质量已经落后 |
| `SF3D` / `SPAR3D` | https://github.com/Stability-AI/stable-fast-3d ；https://github.com/Stability-AI/stable-point-aware-3d | 快速前馈重建 | Stability 社区许可（年收入低于 100 万美元免费） | 6GB / 10.5GB；SF3D 可在 CPU 上跑（慢） | 唯一可能在纯 CPU 上跑的生成模型 |
| `TripoSG` | https://github.com/VAST-AI-Research/TripoSG | 几何生成 | MIT，可商用 | 8GB 以上 | 许可干净，只出几何 |
| `PartCrafter` | https://github.com/wgsxm/PartCrafter | 部件级生成 | MIT，可商用 | 需要（显存未核实） | 一次生成多个部件网格 |
| `MIDI-3D` | https://github.com/VAST-AI-Research/MIDI-3D | 单图组合场景 | Apache-2.0，可商用 | 约 30GB（带贴图） | 布局只有相对尺度 |
| `SceneGen` | https://github.com/Mengmouxu/SceneGen | 单图或多图场景 | MIT；依赖的 VGGT-1B 不可商用 | 16GB 以上 | 尺度是相对的 |
| `Mira-Scene` | https://github.com/VAST-AI-Research/Mira-Scene | 单图场景重建 | MIT（网格后端各自许可） | 需要（显存未核实） | 2026-11 仍在更新；换成激光雷达深度的效果未实测 |
| `Gen3DSR` | https://github.com/AndreeaDogaru/Gen3DSR | 分治式单图场景 | CC-BY-4.0（依赖的模型各自许可） | 20GB 以上 | 只参考流程设计 |
| `CAST` | https://sites.google.com/view/cast4 （非官方复现 https://github.com/FishWoWater/CAST） | 单图场景 | 官方未开源；非官方版 MIT，但依赖付费接口 | 非官方版 12GB 以上 | 物理修正的思路可借鉴 |
| `Step1X-3D` | https://github.com/stepfun-ai/Step1X-3D | 图片生成三维 | Apache-2.0；`custom_rasterizer` 部分许可待核 | 约 27GB | 可商用的备选 |
| `Direct3D-S2` | https://github.com/DreamTechAI/Direct3D-S2 | 几何生成 | MIT，可商用 | 10–24GB | 可商用的高精度几何 |
| `Amodal3R` | https://github.com/Sm0kyWu/Amodal3R | 遮挡补全 | 代码为 S-Lab 非商用许可（权重标 CC-BY-4.0，两者冲突），按不可商用处理 | 需要 | 只适合内部研究 |
| `xatlas` | https://github.com/jpcy/xatlas | 贴图坐标展开 | MIT，可商用 | 否 | 贴图转移的关键一步 |
| `mvs-texturing`（TexRecon） | https://github.com/nmoehrle/mvs-texturing | 照片投影贴图 | BSD-3，可商用 | 推测以 CPU 为主（未核实） | 用原始帧给参数模型重新出贴图 |

**只有论文、没找到代码或代码未发布的工作**（未列入上表）：
- 大模型写三维程序：SceneCraft（谷歌，没有官方代码；GitHub 上同名仓库是另一篇论文）、Thinking in Blender（arXiv 2606.02580）
- 点云或图像转 CAD：MegaParts（MeshCoder 1.5，代码待发布）、PrimitiveCAD（arXiv 2610.08698）、PLLM（arXiv 2602.12561）、京东工业的 VisCAD（arXiv 2609.03811，没找到公开权重）、基准 RealCADBench（只在引用中见到）、CAD-MLLM（只发布了数据集和评测代码，仓库没有 LICENSE）、ShapeLib、Point2Primitive
- 扫描转场景程序：ReScene（2026-06）、Scenix（2026-08）、SimRecon（2026-03）
- 分割：OpenTrack3D（arXiv 2512.03532）
- 场景补全：CODA（arXiv 2609.25654）
- 检索对齐：ZeroCAD（仓库只有 README 和 LICENSE）；SimFoundry（NVlabs，只针对桌面场景，未列入）

---

## 五、未核实信息与调研局限

**需要后续确认的关键点**（按对决策的影响排序）：
1. `LiteReality-Agent` 能否读入 Scaniverse、Polycam 或 Stray 的数据。README 只写了它自家的扫描应用，改造读入层的工作量未知。
2. `Articraft` 是否基于 `build123d`：第一轮调研这样写，复核时 README 没有提到。它的论文信息只在一轮调研里核对过。
3. 公司内部生产使用算不算"商用"，以及在 ScanNet、ShapeNet 上训练的权重是否继承这些数据的非商用限制。需要法务判断。另外，ScanNet 条款原文没能访问，内容引自检索摘要。
4. `PromptDA` 权重对 Depth Anything V2 许可的继承关系；OCCT 的许可条款；`Step1X-3D` 中 `custom_rasterizer` 的许可；`CAD-Coder` 和 `Mosaic3D` 的权重许可；`CADReasoner` 训练数据的许可。
5. 多项显存或硬件需求未核实：`SAM 3`、`Zero-to-CAD`、`CADReasoner`、`P3-SAM`、`PartCrafter`、`Mira-Scene`、`Pixal3D` 低显存模式、`Infinigen`、`mvs-texturing`、`HOC-Search` 纯 CPU 运行、`PromptDA` Small 在 CPU 上的速度。
6. 以下"换成扫描数据会更好"的设想都没有实测：`Mira-Scene` 换用激光雷达深度、`Pixal3D` 用扫描位姿、`SPAR3D` 换用扫描点云。`SpatialLM`、`Cloud2BIM` 对玻璃幕墙的效果也未验证。
7. `SpatialLM` 1.5 和 `SpatialLM-Chat` 是否已发布；`Polycam` 开发者模式是否收费；`SUFLECA` 的性能数字（来自二手报道）；`blender-mcp` 条款的更新日期；`CGAL` Python 绑定的覆盖范围。
8. 两轮调研数字不一致的地方：`LiteReality` 星数（约 350 或约 440）、`Code-as-Room` 星数（以更正后的约 247 为准）。

**调研方式和局限**：
- 仓库是否存在、最后提交日期和许可证原文，多数通过浅克隆仓库或读取原始 LICENSE 文件核对；权重许可通过 Hugging Face 接口的标签核对。
- 部分会话访问不了 arxiv.org、huggingface.co 网页、*.github.io、doc.cgal.org，相关细节改用仓库原文和检索摘要核对。
- 星数取自 ecosyste.ms 镜像或 GitHub 页面，可能滞后几周。部分仓库读不到最后提交日期。