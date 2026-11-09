---
name: metaverse-reconstruct
description: 当 AI 模型师逐件重建一个扫描过的实体空间（前厅、餐厅……）的"优化模型"：用 metaverse-recon 看图、量尺寸，每件物体先去模型库（Poly Haven、Objaverse，只要 CC0 / CC-BY）搜一个看起来差不多的现成模型摆进扫描里对照，搜不到或差太多的定制件再手写 SHAPES 参数形状，最后合并成 AI 物件集交给处理服务。做重建、替换重建层物体、写 authored.json 之前先读。
---

# 用 AI 重建一个空间（metaverse-recon）

你是**模型师**：看懂扫描里的每一件东西，给它一个"写实"的模型。计算只当你的眼睛、尺子和裁判
（渲染、测量、对齐、偏差），**理解和决定都由你来做**。

做法是"先搜后写"：

1. 现成的家具（沙发、椅子、桌子、灯、绿植……）**先去模型库搜**一个看起来差不多的，摆进扫描里对照。
   已经存在的东西比手写的更"现实"：有真实的比例、圆角、缝线和材质。
2. **搜不到或差太多**（定制件：前台、LED 大屏墙、入口门框、嵌入柜、墙垛……）才自己手写参数形状。
3. 每一件都要和扫描并排看过、偏差数字过关才算完成。

## 1. 准备

```bash
# 平台仓库里装一次（Python 3.13+；渲染还要 node 22+，web/ 下 npm ci 提供 three 和 Playwright）
cd worker && uv venv .venv && uv pip install --python .venv/bin/python -e .
metaverse-recon doctor          # 看 node、three、Playwright、Chromium、中文字体、缓存目录是否就绪
```

- 渲染找不到工具时，`doctor` 会写出缺什么、怎么装；路径都可以用环境变量指定（`METAVERSE_RECON_THREE`、
  `METAVERSE_RECON_PLAYWRIGHT`、`METAVERSE_RECON_CHROMIUM`、`METAVERSE_RECON_FONT`）。没有中文字体时图上用英文标注。
- 模型库的索引和下载的模型在 `~/.cache/metaverse-recon`（`METAVERSE_RECON_CACHE` 可改）。
- Sketchfab 只在设置了 `SKETCHFAB_TOKEN` 时可用；令牌只放环境变量，**不要写进任何文件**。

## 2. 流程

```bash
# ① 基线：与处理服务 scan_import 首次导入完全相同的对齐、结构和现有算法物体
metaverse-recon prepare --scan mesh.drc --texture tex.jpg --hints hints.json --out base
export METAVERSE_RECON_BASE=$PWD/base
cat base/candidates.json        # 每件物体：编号、类别、尺寸、suggest（search 先搜 / author 手写）、同款 sameAs

# ② 每件物体循环（下面以 sofa-01 为例）
metaverse-recon views   --object sofa-01 --out work/sofa-01/views            # 先看：6 个角度
metaverse-recon measure --object sofa-01 --heightmap 0.05:1.0 --out work/sofa-01/m.json   # 再量
metaverse-recon search  --query "beige leather two seat sofa" --category sofa \
    --size 1.75,0.77,1.11 --out work/sofa-01/search                          # 看 sheet.jpg 挑候选
metaverse-recon place   --object sofa-01 --candidate work/sofa-01/search/candidates.json#3 \
    --out work/sofa-01/place                                                  # 摆进去，看 place.jpg
#    满意：work/sofa-01/place/entity.json 就是这件的记录
#    不满意：换候选再 place；都不行就手写形状，用 compare 对照
metaverse-recon compare --object counter-01 --model work/counter-01/entity.json --out work/counter-01/cmp

# ③ 合并、整房检查（最后整份跑一遍处理服务的校验，通过了处理服务就原样接受）
metaverse-recon assemble --entities work/ --notes work/notes.md --out out/authored
#    看 out/authored/room.jpg、逐件偏差表、"没被任何物件覆盖的扫描团块"，补漏、返工

# ④ 提交（工作区里的任意目录，metaverse 会往上找 metaverse.json；扫描已经导入过）：
#    处理服务下载模型、烘焙贴图、逐件算偏差，写成一次提交
metaverse rebuild --authored out/authored/authored.json
#    第一次导入扫描时改用 metaverse scan <扫描文件> --authored …；人在网站上看过"优化模型"再对外
```

每件物体的工作目录建议：`work/<编号>/`（views、m.json、search、place、entity.json、notes）。assemble 会在目录里
递归找 `entity.json`。

## 3. 命令速查

| 命令       | 用途                               | 常用参数                                                                                                                      |
| ---------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `prepare`  | 扫描 → 基线目录                    | `--scan`（zip / glb / drc）`--texture` `--hints`（处理服务坐标系）`--out`                                                     |
| `views`    | 只渲染包围盒附近的扫描，带米制刻度 | `--object`/`--box` `--front 偏航` `--only top` `--cut 高度` `--cam 名:方位,仰角`                                              |
| `measure`  | 尺寸、截面、剖面、圆、颜色         | `--hslice` `--vslice x=…/z=…/p=x,z@yaw` `--circle` `--color 名=框` `--frame x,y,z,yaw`                                        |
|            | 斜面朝向                           | `--plane 名=x0,y0,z0,x1,y1,z1`：法向、坡度、方位、残差，外接矩形角点可直接当 plate 的点                                       |
|            | 高度图数字表                       | `--heightmap y0:y1[@x0,z0,x1,z1]` `--hm-cell 0.05` `--hm-stat top/bottom`                                                     |
|            | 去掉相邻物体                       | `--exclude x0,y0,z0,x1,y1,z1`（可重复）                                                                                       |
| `search`   | 模型库检索（只有 CC0 / CC-BY）     | `--query 英文描述` `--category` `--library polyhaven/objaverse/sketchfab` `--size 宽,高,深` `--max-faces` `--limit`           |
| `fetch`    | 下载候选、记哈希和署名             | `--from candidates.json --pick 3,5`，或 `--library objaverse --id <uid>`                                                      |
| `place`    | 候选摆到扫描里的物体上             | `--candidate candidates.json#3` `--up auto/+y/+z…` `--scale uniform/axis/none` `--yaw 角 --yaw-range 20` `--tint` `--exclude` |
| `compare`  | 记录 vs 扫描 vs 现有算法           | `--model` `--front` `--exclude` `--color-parts` `--scene`（多物件/整房） `--cut`                                              |
| `assemble` | 合并成 AI 物件集 + 整房检查        | `--entities 文件或目录…` `--structure keep/replace` `--notes`                                                                 |
| `reframe`  | 物件在两种对齐之间换算             | `--scan` `--from compute --to scan_import --in … --out …`                                                                     |

**看图**：`views`、`compare`、`place` 的图都是 JPEG，直接读图看。正交图左、下两边有刻度（米），`views.json` 有像素 →
坐标换算；黄框是包围盒；地面网格 10 厘米一格（亮线 50 厘米，蓝线整米）；右上角是坐标轴指示。

**读数字**：`compare.json` / `place.json` 里

- 扫描→模型：范围内扫描点到模型的距离。均值低、3 厘米内比例高 = 扫描到的东西模型都有。
- 模型→扫描：模型表面到扫描的距离。偏大 = 模型多了东西或放错（贴墙、贴地、被挡住的背面没扫到也会偏大）。
- `parts`：按部件拆开，配合 `--color-parts` 的颜色找哪一块歪了；`missingFromNew`：漏建的扫描团块。

## 4. 规则

1. **先看再量，不靠猜**。尺寸、位置、角度都来自 `measure` 的数字（外接框、最小外接矩形的 yaw、截面顶点、
   高度图、平面拟合），不要凭印象写"常见尺寸"。先出默认 `views` 认清正面，再带 `--front` 重出。
2. **先搜库再手写**。`candidates.json` 里 `suggest: search` 的先搜。看 `sheet.jpg` 挑**外形**最像的（比例、扶手、
   靠背、腿），颜色次要（可以 tint）。`place` 后看 `place.jpg` 和数字：
   - 候选的扫描→模型均值不比现有算法差、外形对得上 → 用它；
   - 比例不对 → 试 `--scale axis`（逐轴，限 ±15%）；朝向反了 → `--yaw 角度` 限定；
   - 换 2–3 个候选都差太多 → 手写。
3. **只用许可允许的模型，保留署名**。只要 CC0、CC-BY（search 已经过滤掉 NC、ND、SA 和 Sketchfab 的
   Standard/Editorial）。外部模型物件的 `props.source` 必须完整（`library、id、page、author、license、title`
   六个非空字符串，CC0 也写作者），**不要改、不要删**——网站据此显示"模型来源"，CC-BY 不署名就是侵权。
4. **同款做模板实例**。`sameAs` 里的同款物体（8 把会议椅）只建一次：形状写成模板（`kind: "template"`），
   各处用 `{"type": "instance", "template": "tpl-…", "transform": {…}}`；外部模型就是同一个 `model` 摆多份
   （各自的 transform）。
5. **常见形状保留棱角和弧度**：圆角用 `fillet`，扶手、腿用 `sweep`、`lathe`，弧形轮廓用 `arcs`；斜面用
   `plate`（`measure --plane` 给的角点），楔形、船头用 `hull`。不要把一切都写成直角盒子。
6. **不追逐扫描噪声**。扫描有破洞、拉丝、反光和被挡住的背面；平面就写平，对称就写对称，墙角就是直角。
   偏差到 2–3 厘米以后，再贴就是在拟合噪声。
7. **烘焙指令**：手写形状想用扫描的真实颜色（木纹、印刷图案、屏幕画面）时，材质写
   `{"bake": "planar" | "box" | "cylindrical", "color": [预览色]}`，处理服务会把扫描颜色烘焙成贴图；
   纯色就直接写 `color`（`measure --color` 取中位色）。玻璃用 `opacity`（0–1），屏幕、灯箱用 `unlit: true`。
8. **坐标与偏航约定**：单位米，y 向上；空间坐标就是 `prepare` 的坐标（和处理服务 scan_import 相同）。
   `yaw` 绕 y，**0 = 正面朝 +Z，90 = 朝 +X，−90 = 朝 −X**；变换顺序 缩放 → 翻滚 → 俯仰 → 偏航 → 平移。
   `box`、`cylinder`、`extrude`、`lathe` 的原点在底面中心。外部模型的 `transform` 作用于模型文件自己的坐标
   （向上轴不对时用 `pitch`/`roll` 的 90° 倍数摆正，`place` 会自动处理）。旧坐标系（`compute`）里写的东西用
   `reframe` 换算，不要手工平移。
9. **不要编造来源**。外部模型物件的 `model`（`url、sha256、size、format`）只能来自 `fetch` / `place`，处理服务会按
   它下载、核对哈希。

## 5. 记录格式

**形状物件**（SHAPES 第 3 节；`bounds` 可以不写，assemble 会按形状算）：

```json
{ "entityId": "counter-01", "layer": "rebuilt", "kind": "object", "label": "前台", "anchorId": "counter-01",
  "shape": { "type": "group", "children": [
      { "type": "plate", "points": [[…], […], […], […]], "thickness": 0.03, "material": { "bake": "planar", "color": [230, 230, 228] } },
      { "type": "hull", "points": [[…], …] , "material": { "color": [40, 40, 44] } } ] },
  "props": { "category": "counter" } }
```

- `plate`：3–64 个共面点（偏离 ≤ 1 毫米），从法向一侧看逆时针，板从这个面沿 −法向延伸 `thickness`（≤ 1 米）。
- `hull`：4–256 个点的凸包实体（不能全部共面）。

**外部模型物件**（`place` 输出，原样用）：

```json
{ "entityId": "sofa-01", "layer": "rebuilt", "kind": "object", "label": "米色皮沙发",
  "model": { "url": "https://huggingface.co/…/<uid>.glb", "sha256": "…", "size": 3646572, "format": "glb" },
  "transform": { "position": [x, y, z], "yaw": 179.0, "pitch": 0, "roll": 0, "scale": [0.0097, 0.0097, 0.0097] },
  "bounds": { "min": […], "max": […] },
  "material": { "tint": [230, 210, 180] },
  "fit": { "meanCm": 4.12, "p90Cm": 9.8, "coverage3cm": 0.52 },
  "props": { "category": "sofa", "source": { "library": "objaverse", "id": "<uid>", "page": "https://sketchfab.com/3d-models/<uid>",
                                             "author": "…", "license": "CC-BY-4.0", "title": "…" } } }
```

Poly Haven 的模型是 `format: "gltf"`，另有 `files: {相对路径: {url, sha256, size}}`（.bin 和贴图）。`material` 可以带
`tint`（只能把模型调暗、调色，不能调亮；`place` 给出建议，`--tint` 写进记录）、`opacity`（0–1，玻璃制品）、
`unlit: true`（灯箱、屏幕）。`fit` 是 `place` 算的偏差，留着无妨，处理服务会重算。模型库的模型常用厘米单位：
`place` 按扫描缩放，处理服务按缩放后的坐标检查 ±1000 米的上限。

**AI 物件集**（`assemble` 输出的 `authored.json`）：`{version: 1, templates: [...], entities: [...], notes, structure:
"keep"|"replace"}`。`keep` 时结构（地面、墙、玻璃）沿用算法结果，不要放 `kind: "structure"` 的物件。

## 6. 质量目标

- 每件家具：扫描→模型均值 **≤ 3 厘米**、3 厘米内 **≥ 70%**，并且**不比现有算法差**；外形、朝向在图上一眼对得上。
- 定制件：大面平整、棱角清楚，均值 ≤ 4 厘米；漏建团块（`missingFromNew`）里不能有成片的主体。
- 整房：`assemble` 的"没被任何物件覆盖的扫描团块"只剩零碎杂物；对比图里没有悬空、穿地、穿墙的东西。
- `notes.md` 写清每件是"库里的哪个模型"还是"手写"，以及为什么（换过哪些候选、偏差多少）。

## 7. 常见问题

- 候选面朝墙：看 `place.jpg` 的俯视图，用 `--yaw` 限定到正确的一侧重摆（`measure --heightmap` 能看出靠背在哪边）。
- **别只凭"正面"图判断朝向**：贴墙家具的背面扫不到，从背后看扫描反而像正面（能看到坐垫和靠垫的里侧）。
  朝向以高度图（靠背最高的一侧）和俯视图为准；`place` 自动选的朝向和高度图一致时不要手工改。
- 候选太大或太小几十倍：`place` 会按扫描尺寸自动缩放；Poly Haven 是真实尺寸，缩放偏离 1 很多说明不是同一类东西。
- 相邻的桌子、杂物混进范围：`measure`、`compare`、`place` 都加 `--exclude 框`。
- `fetch` 提示"坐标超过 ±1000 米"：模型多半是厘米单位，`place` 会按扫描缩放，可以照常用。
- Sketchfab 模型提示"不能按地址写回"：它不在 Objaverse 镜像里，AI 物件集只收按地址下载的模型，换候选。
- `assemble` 报"写回路径校验不通过"：按说明改对应的物件，处理服务收到时跑的是同一套校验。
