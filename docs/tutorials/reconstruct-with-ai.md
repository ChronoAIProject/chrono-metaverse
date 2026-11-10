# 重建教程：用 Claude Code / Codex 把扫描重建成"优化模型"

这篇教程写给要把一个扫描过的实体空间（公司前厅、餐厅……）重建成**写实的优化模型**的人。动手的是本地的 AI
（Claude Code 或 Codex），你负责准备扫描、看对比图、决定提交。

做法一句话：**每件物体先去模型库搜一个看起来差不多的现成模型摆进去对照，搜不到或差太多的定制件再让 AI 手写
参数形状**。已经存在的东西（真实的沙发、椅子模型）比手写的更"现实"；前台、LED 大屏墙、入口门框、嵌入柜这类
定制件库里没有，才手写。计算只做眼睛、尺子和裁判（渲染、测量、对齐、偏差）。

依据：[整体设计](../ARCHITECTURE.md) 第 6.3 节（AI 重建）、[形状词表](../SHAPES.md)、
[开源方案调研](../research/scan-to-model.md)。命令的完整说明在 `recon/README.md` 的"重建工作台"一节，给 AI 的
技能说明是 `sdk/typescript/skills/metaverse-reconstruct/SKILL.md`。

完整的方法论（流程和分工、采集、基线和结构、逐件建模、多人建模与评审、贴图手册、写回上线、常见坑）见
[方法论：从扫描到逼真的数字前厅](../methodology/README.md)，本教程只讲工作台命令一步步怎么用。服务端只做鉴权、存储、
时间线和通用把关，重建全部在本地：本地工具打成重建包，命令行 `metaverse bundle push` 推送（方法论第 7 章，
[服务端瘦身设计](../design/server-slim.md)）。

读完你会：

1. 装好重建工作台 `metaverse-recon`，确认能出图；
2. 用 `prepare` 得到和线上完全一致的基线；
3. 让 AI 按"先搜后写"逐件重建，学会看它交回来的对比图和数字；
4. 合并成 AI 物件集、做整房检查，在本地打成重建包，推送到平台成为重建草稿。

---

## 1. 准备

### 1.1 装工作台

工作台是本地重建工具 `metaverse-recon`（平台仓库的 `recon/`），Mac、Linux 都可以，不需要显卡。不用拉整个仓库：

```bash
uv tool install "git+https://github.com/ChronoAIProject/chrono-metaverse@<标签>#subdirectory=recon"
metaverse-recon doctor --install    # 渲染用的 three、Playwright 和 Chromium 装进缓存目录（要 node 22 和 npm）
metaverse-recon doctor
```

在平台仓库里开发时：`cd recon && uv sync --frozen`，渲染直接用 `web/node_modules` 里的 three 和 Playwright
（`cd web && npm ci`）。另外要装命令行 `metaverse`（推送重建包用，见 `sdk/typescript/README.md`）。

`doctor` 输出每样工具找到了没有：

```json
{ "node": "/usr/local/bin/node", "three": ".../web/node_modules/three", "playwright": ".../web/node_modules/playwright",
  "chromium": "~/Library/Caches/ms-playwright/chromium-1243/chrome-mac/...", "font": "/System/Library/Fonts/PingFang.ttc",
  "cache": "~/.cache/metaverse-recon", "render": "可用" }
```

- 找不到的可以用环境变量指定：`METAVERSE_RECON_THREE`、`METAVERSE_RECON_PLAYWRIGHT`、`METAVERSE_RECON_CHROMIUM`、
  `METAVERSE_RECON_FONT`（Mac 默认苹方、冬青黑体；Linux 默认文泉驿、Noto CJK；都没有时图上用英文标注）；
- 模型库的索引和下载的模型放在 `~/.cache/metaverse-recon`（`METAVERSE_RECON_CACHE` 可改），Objaverse 的元数据
  按需增量下载，第一次检索某个类别会多花几十秒；
- 要用 Sketchfab 就设 `SKETCHFAB_TOKEN`（只放在环境变量里，不要写进任何文件）。不设也能用 Poly Haven 和 Objaverse。

### 1.2 准备扫描和工作区

- **工作区**：`metaverse init <空间编号>` 建工作区（有 `space.json`），并把技能说明
  `.claude/skills/metaverse-reconstruct/SKILL.md` 写进去，AI 打开工作区就能读到规则。`metaverse-recon` 在工作区的
  任何子目录里都会往上找 `space.json`，扫描、变换、上限、基线和包目录都有默认值（`recon/README.md` 的"本地流水线"）。
- **扫描和变换**：已经有扫描的空间，`metaverse pull --scan` 下载当前的原始扫描 `scan/scan.zip` 和它的变换
  `scan/transform.json`（扫描坐标 → 空间坐标），重建结果就落在空间的坐标系里；`pull` 还会写服务端的上传上限
  `limits.json`。新空间：把 Scaniverse 导出的 zip 放到 `scan/scan.zip`，`metaverse-recon align` 首次自动对齐，写
  `scan/transform.json`。
- **提示**（可选）：物体提示 `hints.json`（空间坐标，格式与原来导入扫描时的 `hints` 相同）。

---

## 2. 基线：prepare

```bash
cd <工作区>
metaverse-recon prepare --hints hints.json     # 默认读 scan/scan.zip、scan/transform.json，写 out/recon/
```

`prepare` 走的是打包用的同一条重建路径（对齐或工作区的变换 → 结构 → 现有算法的物体），与线上第 1–3 版导入
扫描时服务端用的代码相同（那时重建还在服务端）。基线的坐标、结构、物体编号和线上一致，AI 写的东西打包时不用换算。前厅实测 46 秒：

```
对齐：{'method': 'auto', 'rotationDeg': -61.423, 'tiltDeg': 0.094}（与线上第 1 版导入时相同）
结构 6 个，物体 41 个，模板 2 个；地面 y=-0.0029
候选（suggest = search 先搜库，author 手写）：
  cabinet-01     cabinet  LED 大屏     尺寸 [5.032, 2.605, 0.585]  author
  chair-02       chair    会议椅        尺寸 [0.79, 0.834, 0.749]  search，同款 8 个
  counter-01     counter  前台         尺寸 [2.013, 1.253, 3.811]  author
  sofa-01        sofa     米色皮沙发      尺寸 [1.754, 0.768, 1.117]  search
  …
```

`out/recon/candidates.json` 就是 AI 的任务清单：每件物体的编号、类别、尺寸、建议（`search` 先搜库 / `author` 手写）、
同款（`sameAs`：8 把会议椅只做一次）。

> 以前在 `scripts/reconstruct_lobby.py` 坐标系里写的东西（比如 `recon/scripts/llm_poc/models/`）用
> `metaverse-recon reframe --scan mesh.drc --from compute --in … --out …` 换过来（`--to` 默认 `align`，即 `prepare`
> 的自动对齐；旧名 `scan_import` 照旧认）。

---

## 3. 逐件重建：先搜后写

把任务交给 AI，比如："按 `metaverse-reconstruct` 技能，从 `sofa-01` 开始逐件重建前厅，每件放在 `work/<编号>/`"。
它每件物体的循环是：

### 3.1 看、量

```bash
metaverse-recon views   --object sofa-01 --out work/sofa-01/views
metaverse-recon measure --object sofa-01 --heightmap 0.05:1.0 --hm-cell 0.1 --out work/sofa-01/m.json
```

`views` 出 6 个角度的图（带米制刻度、黄框是包围盒）；`measure` 给尺寸、截面、高度图数字表、平面拟合。前厅的沙发
从图上看不出朝向，高度图一眼就清楚：靠背（0.77–0.80 米）在 z 大的一边，座面（0.42 米）在 z 小的一边。

### 3.2 搜、摆

```bash
metaverse-recon search --query "leather loveseat two seater sofa" --category sofa --library objaverse \
    --limit 20 --out work/sofa-01/search
metaverse-recon place --object sofa-01 --candidate work/sofa-01/search/candidates.json#17 \
    --scale axis --tint --out work/sofa-01/place
```

- `search` 只列许可允许商用的模型（CC0、CC-BY；NC、ND、SA 一律排除），输出带编号的缩略图拼图 `sheet.jpg`，AI 看图
  挑**外形**最像的；
- `place` 自动下载、判断向上轴、按扫描量出的尺寸缩放（`--scale axis` 逐轴微调，限 ±15%）、找朝向和位置、落地，
  输出外部模型物件记录 `entity.json`（带模型地址、哈希、署名）和对比图 `place.jpg`；`--tint` 按扫描颜色给模型调色
  （只能调暗）。

前厅实测：

| 物体 | 选中的候选 | 扫描→模型（候选 / 现有算法） |
|---|---|---|
| `sofa-01` 米色皮沙发 | Objaverse "Sofa White Leather"（DoobiDooba，CC-BY-4.0），tint [184,157,121] 调成米色 | 4.12 / 4.08 厘米 |
| `chair-08` 会议椅 | Objaverse "Black Leather Tub Armchair"（bigshape，CC-BY-4.0），排除桌面，tint 调深 | 4.79 / 5.33 厘米 |

### 3.3 搜不到就手写

候选的偏差明显比现有算法差、或者外形对不上（换了 2–3 个都不行），就手写 SHAPES 形状。定制件直接手写：

```bash
metaverse-recon measure --object counter-01 --plane "斜面=6.1,0.3,4.2,6.4,1.0,7.6" --out work/counter-01/m.json
# AI 按数字写 work/counter-01/entity.json（plate 斜面、hull 船头、bake 把扫描颜色烘焙成贴图……）
metaverse-recon compare --object counter-01 --model work/counter-01/entity.json --color-parts \
    --out work/counter-01/cmp
```

`compare` 出三列对比图（扫描 | 现有算法 | 新模型）、偏差上色图和分部件的数字；`--color-parts` 让每个部件一种颜色，
对着部件表找哪一块歪了；相邻的东西混进来就加 `--exclude`。改到偏差不再下降为止。逐件的"记录的偏差"就是打包时
写进记录的 `fit`（同一个函数：按物件自身朝向取范围，墙、玻璃、地面作背景，只计 10 厘米以内的点，
不看 `--box`、`--exclude`），网站信息面板和命令行显示的也是它。

### 3.4 贴图：取样、贴上、标定

纯色看着假的面（大理石台面、木纹、地毯）换成平铺贴图：

```bash
metaverse-recon refshot --object table-01 --face top --texture <扫描的原始贴图> --out work/table-01/ref
metaverse-recon texsearch --query "white marble" --out work/table-01/tex       # Poly Haven、ambientCG，只要 CC0
metaverse-recon texfetch --from work/table-01/tex/candidates.json#4
metaverse-recon texture --model work/table-01/entity.json --part '$.children[0]' --color <color.jpg> \
    --normal <normal.jpg> --roughness <roughness.jpg> --tile 1.3,1.0 \
    --refshot work/table-01/ref/refshot.json --calibrate --preview work/table-01/tex.jpg
```

- `refshot` 把扫描里这个面正交展开成一张参考图（每像素 3 毫米），给出去掉高光和暗斑后的中位色和建议的平铺尺寸；
  也可以直接从参考图里裁一块无缝的图当贴图；
- `texture` 把贴图复制到物件文件旁的 `textures/`，材质写成 `{file}` 引用（打包时作为贴图文件进包）；`--calibrate`
  在网站的光照下渲染这个部件，调贴图的整体增益，让渲染出的颜色对上扫描的中位色；`--preview` 出扫描 | 之前 | 之后
  的对比图和色差 ΔE。前厅会议桌台面：纯色 ΔE 13.99，贴上标定后的大理石 ΔE 0.72。

### 3.5 怎么判断一件做好了

- 扫描→模型均值 ≤ 3 厘米、3 厘米内 ≥ 70%（库里的模型外形和实物总有差别，**不比现有算法差**也可以接受）；
- 图上外形、朝向一眼对得上；靠背、扶手、腿的位置对；
- 外部模型的 `props.source` 完整（CC-BY 要署名，网站显示"模型来源"）。

---

## 4. 合并、整房检查

```bash
metaverse-recon assemble --entities work/ --notes work/notes.md --out out/authored
```

- 合并成 AI 物件集 `authored.json`：模板去重、编号唯一、引用的模板必须存在、逐个校验、包围盒重算，最后整份跑一遍
  打包时对物件集的校验（`parse_authored`）。有错误会列出来并以退出码 2 结束；通过了，`bundle` 就会原样接受；
- `room.jpg`：扫描 | 现有算法 | AI 重建，总览、俯视、四个角；`room.glb` 可以拖进任何 glTF 查看器；
- `report.json` 和终端输出：逐件偏差表（含打包后记录里的 `fit`），以及"没被任何物件覆盖的扫描团块"（漏建），后面
  写着现有算法里和它重叠的物体编号，照着补。

`--structure keep`（默认）沿用算法做的地面、墙、玻璃；要连结构一起换就 `--structure replace`，并把 `kind:
"structure"` 的物件也写进去。

---

## 5. 打包、推送

```bash
cd <工作区>
metaverse-recon bundle --authored out/authored/authored.json --webmodel <空间现在的网页用模型>
metaverse bundle push                       # 默认读 out/bundle/
```

`bundle` 在本地做以前服务端写回物件集时做的事：逐个校验物件；外部模型先在缓存里按哈希找，没有才按地址下载并
核对哈希和大小，按材质重新导出成受限的 glb（俯仰、横滚、缩放和调色烘进模型，偏航写进记录，只差偏航的共用一个
文件）；烘焙指令换成贴图，`{file}` 本地贴图和外链贴图换成进包的贴图；逐件算偏差，按类别建议锚点；连同扫描和
网页用模型写成重建包 `out/bundle/`（清单 `manifest.json` + 文件，重建层编号加 `rb.`），最后调用
`metaverse bundle check` 按服务端的规则检查一遍。

- `--webmodel` 给空间现在的网页用模型（`metaverse pull --share … --assets` 能下载），"原始"视图就不变；不给就重新生成；
- 种子用的包（会公开）加 `--seed`：去掉内部锚点和建模记录；
- `metaverse bundle push` 建重建草稿、上传文件和清单、等服务端展开，给出预览链接；看过预览后
  `metaverse publish <草稿编号>` 发布。令牌要带 `metaverse:rebuild:write`；
- 不通过时错误说明会指出是哪个物件、哪一条规则（例如许可不允许、哈希对不上、地址的主机不在
  `METAVERSE_RECON_MODEL_HOSTS` 里、模型和 `bounds` 的尺寸对不上）。

提交前确认：

- 对比图里没有悬空、穿地、穿墙的东西；
- 每个外部模型都来自 `fetch` / `place`，没有手改 `model` 和 `props.source`；
- `notes.md` 写清每件是哪个库的哪个模型、还是手写，以及为什么（打包时写成建模记录，随提交存成脚本资源；
  `--seed` 的包不带）。

发布后在网站上打开空间，"优化模型"视图里能看到外部模型、手写形状和烘焙的贴图；有 CC-BY 模型时画面底边常驻一行
简短署名，点"全部来源"（只有 CC0 模型时是"模型来源 · N"按钮）列出所有外部模型的标题、作者、许可和来源页，点选
物件时信息面板里也有它的来源。

---

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `doctor` 说渲染不可用 | 按提示装 node / three / Playwright，或用环境变量指定路径；不出图时 `compare`、`assemble` 加 `--no-render` 也能算数字 |
| 候选面朝墙、前后反了 | 看高度图确认靠背在哪边，`place --yaw <角度> --yaw-range 20` 限定。别只凭"正面"图：贴墙家具背面扫不到，从背后看扫描像正面（前厅实测里就把对的朝向"纠正"反了，网站上和原始扫描一对才发现） |
| 候选比例不对 | `--scale axis`；还不行就换候选 |
| 候选颜色差太多 | `place` 会提示 tint 帮不上（只能调暗）：换颜色接近或更浅的候选再 `--tint` |
| `fetch` 提示坐标超过 ±1000 米 | 模型多半是厘米单位：`place` 会按扫描缩放，打包时按缩放后的坐标检查，可以照常用 |
| `assemble` 报"打包校验不通过" | 按错误说明改对应物件（常见：署名缺字段、`material` 写了 `tint`/`opacity`/`unlit`/`shading` 以外的键） |
| `bundle` 说没有找到 `metaverse` 命令 | 包已经打好，只是没检查：装好命令行后运行它打印的 `metaverse bundle check …` |
| `metaverse bundle check` 说模型的实测尺寸与 `bounds` 相差太多 | 物件的 `bounds` 要按摆好的模型算：手改了 `transform` 以后用 `place` 或 `assemble` 重算包围盒再打包 |
| Objaverse 第一次检索很慢 | 在下载元数据分片（每个约 3.6 MB）；`metaverse-recon index --category chair` 可以提前下 |
