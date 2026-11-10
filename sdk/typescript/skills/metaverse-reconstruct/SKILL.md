---
name: metaverse-reconstruct
description: 当 AI 模型师逐件重建一个扫描过的实体空间（前厅、餐厅……）的"优化模型"：用本地重建工具 metaverse-recon 看图、量尺寸，每件物体先去模型库（Poly Haven、Objaverse，只要 CC0 / CC-BY）搜一个看起来差不多的现成模型摆进扫描里对照，搜不到或差太多的定制件再手写 SHAPES 参数形状，合并成 AI 物件集，在本地打成重建包，用 metaverse bundle push 推成重建草稿。做重建、替换重建层物体、写 authored.json、打包推送之前先读。
---

# 用 AI 重建一个空间（metaverse-recon）

你是**模型师**：看懂扫描里的每一件东西，给它一个"写实"的模型。计算只当你的眼睛、尺子和裁判
（渲染、测量、对齐、偏差），**理解和决定都由你来做**。

重建**全部在本地**：服务端只存储、核对和展开你推上去的重建包，不跑任何重建算法。本地工具 `metaverse-recon`
只读写本地文件、不连接服务；和服务打交道（下载扫描、上传、发布）只用命令行 `metaverse`。

做法是"先搜后写"：

1. 现成的家具（沙发、椅子、桌子、灯、绿植……）**先去模型库搜**一个看起来差不多的，摆进扫描里对照。
   已经存在的东西比手写的更"现实"：有真实的比例、圆角、缝线和材质。
2. **搜不到或差太多**（定制件：前台、LED 大屏墙、入口门框、嵌入柜、墙垛……）才自己手写参数形状。
3. 每一件都要和扫描并排看过、偏差数字过关才算完成。

## 1. 准备

```bash
# 安装本地重建工具（Python 3.13+，不需要显卡；渲染还要 node 22+）
uv tool install "git+https://github.com/ChronoAIProject/chrono-metaverse@<标签>#subdirectory=recon"
metaverse-recon doctor --install  # 查 node、three、Playwright、Chromium、中文字体，缺的装进缓存目录
# 在平台仓库里开发时：cd recon && uv sync --frozen

# 命令行工作区（metaverse init 建的目录）：本地工具从当前目录往上找 space.json 定默认值
metaverse init <空间编号> && cd <空间编号>
metaverse pull --scan             # 原始扫描 scan/scan.zip、变换 scan/transform.json、上传上限 limits.json
```

- `pull --scan` 分段下载（原始扫描可能有 1 GiB），断了再运行一次接着下。只有分享链接、还没有 NyxID 凭证时，
  `metaverse pull --share <链接> --assets` 能拿到变换、网页用模型和物件模型（只读，不能推送，也没有原始扫描）。

- 渲染找不到工具时，`doctor` 会写出缺什么、怎么装；路径都可以用环境变量指定（`METAVERSE_RECON_THREE`、
  `METAVERSE_RECON_PLAYWRIGHT`、`METAVERSE_RECON_CHROMIUM`、`METAVERSE_RECON_FONT`）。没有中文字体时图上用英文标注。
- 模型库的索引和下载的模型在 `~/.cache/metaverse-recon`（`METAVERSE_RECON_CACHE` 可改）。
- Sketchfab 只在设置了 `SKETCHFAB_TOKEN` 时可用；令牌只放环境变量，**不要写进任何文件**。

## 2. 流程

```bash
# ① 基线：对齐、算法结构和物体、候选清单 → out/recon/
#    已有空间：默认用 scan/scan.zip 和 scan/transform.json（线上的变换，不重新对齐，物件和锚点才对得上）
#    新空间第一次重建：prepare --scan <扫描文件> 自动对齐；重扫要先 align --reference 配准到参考扫描
metaverse-recon prepare --hints hints.json
export METAVERSE_RECON_BASE=$PWD/out/recon
cat out/recon/candidates.json   # 每件物体：编号、类别、尺寸、suggest（search 先搜 / author 手写）、同款 sameAs

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

# ③ 合并、整房检查
metaverse-recon assemble --entities work/ --notes work/notes.md --out out/authored
#    看 out/authored/room.jpg、逐件偏差表、"没被任何物件覆盖的扫描团块"，补漏、返工

# ④ 打包 → out/bundle/：外部模型下载并重新导出成物件模型 glb、外链贴图下载、烘焙、逐件偏差、建议锚点、
#    网页用模型（--webmodel 用线上那份就不重新生成）、扫描 zip；编号统一加 rb.，base 取 space.json
metaverse-recon bundle --authored out/authored/authored.json --webmodel assets/<网页用模型哈希>.glb
metaverse bundle check            # 清单和文件按服务端的规则检查（bundle 最后会自动调用）

# ⑤ 推送：上传（空间里已有的直接复用）、建重建草稿、交包、等展开、生成预览链接
metaverse bundle push
#    把预览链接交给人；人看过"优化模型"后发布（重建用的 agent key 默认没有发布权限）：
metaverse publish <草稿编号>
```

每件物体的工作目录建议：`work/<编号>/`（views、m.json、search、place、entity.json、notes）。assemble 会在目录里
递归找 `entity.json`。

## 3. 命令速查

| 命令       | 用途                               | 常用参数                                                                                                                      |
| ---------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `prepare`  | 扫描 → 基线目录                    | `--scan`（默认 `scan/scan.zip`）`--transform`（默认 `scan/transform.json`）`--hints` `--out`（默认 `out/recon/`）             |
| `align`    | 只算对齐（首次或重扫配准）         | `--reference <参考扫描> --reference-transform <文件>` `--max-error-cm 3`；输出 `transform.json`、误差                         |
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
| `bundle`   | 物件集 → 重建包 `out/bundle/`      | `--authored` 或 `--algorithm` `--webmodel <文件>` `--seed`（种子用，去掉内部锚点和建模记录）`--from-snapshot <工作区>`        |
|            | 单独的步骤                         | `models`（外部模型重新导出）`bake`（烘焙）`fit`（逐件偏差）`webmodel`（网页用模型）`scan-zip`（扫描打包）                     |

命令行 `metaverse` 这一侧：

| 命令                           | 用途                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `metaverse pull --scan`        | 下载原始扫描、变换、上传上限                                                                                 |
| `metaverse bundle check`       | 清单的全部规则、本地文件的大小和哈希、glb / 图片 / zip 的内容、只有模型的物件与模型包围盒一致；`--seed` 警告 |
| `metaverse bundle push`        | 上传、建重建草稿、交包、预览；`--publish` 直接发布（要有发布权限）；清单没有 `base` 时要 `--base latest`     |
| `metaverse publish <草稿编号>` | 发布（冲突时 `--replay` 在最新版本上重放）；内容没变时显示"没有变化"、不写提交                               |

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
   `{"bake": "planar" | "box" | "cylindrical", "color": [预览色]}`，`metaverse-recon bundle` 打包时把扫描颜色烘焙成贴图；
   纯色就直接写 `color`（`measure --color` 取中位色）。玻璃用 `opacity`（0–1），屏幕、灯箱用 `unlit: true`。
8. **坐标与偏航约定**：单位米，y 向上；空间坐标就是 `prepare` 的坐标（已有空间时就是线上的变换 `scan/transform.json`）。
   `yaw` 绕 y，**0 = 正面朝 +Z，90 = 朝 +X，−90 = 朝 −X**；变换顺序 缩放 → 翻滚 → 俯仰 → 偏航 → 平移。
   `box`、`cylinder`、`extrude`、`lathe` 的原点在底面中心。外部模型的 `transform` 作用于模型文件自己的坐标
   （向上轴不对时用 `pitch`/`roll` 的 90° 倍数摆正，`place` 会自动处理）。旧坐标系（`compute`）里写的东西用
   `reframe` 换算，不要手工平移。
9. **不要编造来源**。外部模型物件的 `model`（`url、sha256、size、format`）只能来自 `fetch` / `place`，`bundle` 按
   它下载、核对哈希，再把摆放的旋转、缩放、调色烘进网格，重新导出成物件模型 glb（原点在底面中心）。
10. **重建包的规矩**（服务端按这些展开，SHAPES 第 7 节）：
    - 重建层的编号以 `rb.` 开头（`bundle` 自动加，模板引用一起改）；锚点编号不变；
    - 锚点只新建、不覆盖：同编号的锚点已经存在或曾经存在，都会跳过，`bundle push` 列出跳过了哪些——可能是被
      别人占了，请人判断；重建挪了物件而锚点没动时列出"锚点漂移"，锚点要用实体区草稿去挪（`metaverse build` + `push`）；
    - 不要手改 `out/bundle/`：清单里每个文件都有大小和 sha256，改了就过不了 `bundle check`；要改就改物件集重新打包；
    - 清单的 `base` 是打包时工作区的版本；推送时时间线前进了，发布会检查冲突（重建层整体是一个冲突单位），冲突时
      `metaverse publish <草稿编号> --replay` 在最新版本上重放，或 `metaverse pull` 后重新打包。

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
`unlit: true`（灯箱、屏幕）。`fit` 是 `place` 按打包口径算的偏差（与 `bundle`、`compare` 的逐件偏差同一个
函数），留着无妨，打包时会重算。模型库的模型常用厘米单位：`place` 按扫描缩放，重新导出的物件模型按 `limits.json`
的上限检查（三角形、贴图、坐标 ±1000 米）。

**AI 物件集**（`assemble` 输出的 `authored.json`）：`{version: 1, templates: [...], entities: [...], notes, structure:
"keep"|"replace"}`。`keep` 时结构（地面、墙、玻璃）沿用算法结果，不要放 `kind: "structure"` 的物件。

## 6. 质量目标

- 每件家具：扫描→模型均值 **≤ 3 厘米**、3 厘米内 **≥ 70%**，并且**不比现有算法差**；外形、朝向在图上一眼对得上。
- 定制件：大面平整、棱角清楚，均值 ≤ 4 厘米；漏建团块（`missingFromNew`）里不能有成片的主体。
- 整房：`assemble` 的"没被任何物件覆盖的扫描团块"只剩零碎杂物；对比图里没有悬空、穿地、穿墙的东西。
- `notes.md` 写清每件是"库里的哪个模型"还是"手写"，以及为什么（换过哪些候选、偏差多少）。
- 更完整的做法（采集、多人建模与评审、贴图手册、写回上线、常见坑）见平台仓库的方法论 `docs/methodology/README.md`。

## 7. 常见问题

- 候选面朝墙：看 `place.jpg` 的俯视图，用 `--yaw` 限定到正确的一侧重摆（`measure --heightmap` 能看出靠背在哪边）。
- **别只凭"正面"图判断朝向**：贴墙家具的背面扫不到，从背后看扫描反而像正面（能看到坐垫和靠垫的里侧）。
  朝向以高度图（靠背最高的一侧）和俯视图为准；`place` 自动选的朝向和高度图一致时不要手工改。
- 候选太大或太小几十倍：`place` 会按扫描尺寸自动缩放；Poly Haven 是真实尺寸，缩放偏离 1 很多说明不是同一类东西。
- 相邻的桌子、杂物混进范围：`measure`、`compare`、`place` 都加 `--exclude 框`。
- `fetch` 提示"坐标超过 ±1000 米"：模型多半是厘米单位，`place` 会按扫描缩放，可以照常用。
- Sketchfab 模型提示"不能按地址下载"：它不在 Objaverse 镜像里，AI 物件集只收按地址下载的模型，换候选。
- `assemble` 或 `bundle` 报物件不合规：按说明改对应的物件；`metaverse bundle check` 和服务端交包时跑的是同一套规则。
- `bundle push` 报 403 `rebuild_permission_required`：令牌没有 `metaverse:rebuild:write`，请平台管理员给账号加上
  `metaverse-rebuilder` 角色（在这之前只有部署种子能写重建层）。
- `bundle push` 说某个文件"本地没有，空间里也没有可以复用的"：通常是原始扫描，先 `metaverse pull --scan`。
- 发布时 409 冲突：看冲突的键；`layer:rebuilt` 说明中途有人改过重建层，确认后 `--replay`，或重新拉取、重新打包。
