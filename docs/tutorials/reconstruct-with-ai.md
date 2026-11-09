# 重建教程：用 Claude Code / Codex 把扫描重建成"优化模型"

这篇教程写给要把一个扫描过的实体空间（公司前厅、餐厅……）重建成**写实的优化模型**的人。动手的是本地的 AI
（Claude Code 或 Codex），你负责准备扫描、看对比图、决定提交。

做法一句话：**每件物体先去模型库搜一个看起来差不多的现成模型摆进去对照，搜不到或差太多的定制件再让 AI 手写
参数形状**。已经存在的东西（真实的沙发、椅子模型）比手写的更"现实"；前台、LED 大屏墙、入口门框、嵌入柜这类
定制件库里没有，才手写。计算只做眼睛、尺子和裁判（渲染、测量、对齐、偏差）。

依据：[整体设计](../ARCHITECTURE.md) 第 6.3 节（AI 重建）、[形状词表](../SHAPES.md)、
[开源方案调研](../research/scan-to-model.md)。命令的完整说明在 `worker/README.md` 的"重建工作台"一节，给 AI 的
技能说明是 `sdk/typescript/skills/metaverse-reconstruct/SKILL.md`。

读完你会：

1. 装好重建工作台 `metaverse-recon`，确认能出图；
2. 用 `prepare` 得到和线上完全一致的基线；
3. 让 AI 按"先搜后写"逐件重建，学会看它交回来的对比图和数字；
4. 合并成 AI 物件集、做整房检查，提交给处理服务。

---

## 1. 准备

### 1.1 装工作台

工作台是处理服务（`worker/`）里的一个命令，从平台仓库的源码装（Mac、Linux 都可以）：

```bash
git clone <平台仓库> chrono-metaverse && cd chrono-metaverse
cd worker && uv venv .venv && uv pip install --python .venv/bin/python -e . && cd ..
cd web && npm ci && cd ..           # 渲染用网站同一份 three.js 和 Playwright
npx playwright install chromium     # 已经有 Chromium 就不用
export PATH=$PWD/worker/.venv/bin:$PATH   # 之后直接用 metaverse-recon
metaverse-recon doctor
```

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

- **扫描**：Scaniverse 导出的 zip（Draco 网格 + 贴图），或者 `mesh.drc` + `tex.jpg`，或者 glb。必须是这个空间**首次
  导入**用的那一份（重建结果要落在空间的坐标系里）。
- **提示**（可选）：空间导入时用过物体提示（`scan_import` 的 `hints`，处理服务坐标系），这里也用同一份。
- **工作区**：`metaverse init <空间编号>` 会把技能说明 `.claude/skills/metaverse-reconstruct/SKILL.md` 写进工作区，
  AI 打开工作区就能读到规则。重建的中间文件建议放在工作区的 `recon/` 下。

---

## 2. 基线：prepare

```bash
cd <工作区>/recon
metaverse-recon prepare --scan mesh.drc --texture tex.jpg --hints hints.json --out base
export METAVERSE_RECON_BASE=$PWD/base
```

`prepare` 调用的就是处理服务首次导入扫描的那条代码路径（对齐 → 结构 → 现有算法的物体），只是不写数据库。
所以基线的坐标、结构、物体编号和线上完全一致，AI 写的东西提交时不用换算。前厅实测 46 秒：

```
对齐：{'method': 'auto', 'rotationDeg': -61.423, 'tiltDeg': 0.094}（与 scan_import 首次导入相同）
结构 6 个，物体 41 个，模板 2 个；地面 y=-0.0029
候选（suggest = search 先搜库，author 手写）：
  cabinet-01     cabinet  LED 大屏     尺寸 [5.032, 2.605, 0.585]  author
  chair-02       chair    会议椅        尺寸 [0.79, 0.834, 0.749]  search，同款 8 个
  counter-01     counter  前台         尺寸 [2.013, 1.253, 3.811]  author
  sofa-01        sofa     米色皮沙发      尺寸 [1.754, 0.768, 1.117]  search
  …
```

`base/candidates.json` 就是 AI 的任务清单：每件物体的编号、类别、尺寸、建议（`search` 先搜库 / `author` 手写）、
同款（`sameAs`：8 把会议椅只做一次）。

> 以前在 `scripts/reconstruct_lobby.py` 坐标系里写的东西（比如 `worker/scripts/llm_poc/models/`）用
> `metaverse-recon reframe --scan mesh.drc --from compute --to scan_import --in … --out …` 换过来。

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
对着部件表找哪一块歪了；相邻的东西混进来就加 `--exclude`。改到偏差不再下降为止。

### 3.4 怎么判断一件做好了

- 扫描→模型均值 ≤ 3 厘米、3 厘米内 ≥ 70%（库里的模型外形和实物总有差别，**不比现有算法差**也可以接受）；
- 图上外形、朝向一眼对得上；靠背、扶手、腿的位置对；
- 外部模型的 `props.source` 完整（CC-BY 要署名，网站显示"模型来源"）。

---

## 4. 合并、整房检查

```bash
metaverse-recon assemble --entities work/ --notes work/notes.md --out out/authored
```

- 合并成 AI 物件集 `authored.json`：模板去重、编号唯一、引用的模板必须存在、逐个校验、包围盒重算。有错误会列出来
  并以退出码 2 结束；
- `room.jpg`：扫描 | 现有算法 | AI 重建，总览、俯视、四个角；`room.glb` 可以拖进任何 glTF 查看器；
- `report.json` 和终端输出：逐件偏差表，以及"没被任何物件覆盖的扫描团块"（漏建），后面写着现有算法里和它重叠的
  物体编号，照着补。

`--structure keep`（默认）沿用算法做的地面、墙、玻璃；要连结构一起换就 `--structure replace`，并把 `kind:
"structure"` 的物件也写进去。

---

## 5. 提交

`authored.json` 交给处理服务的 `rebuild`（写回路径）：处理服务逐个校验物件、按地址下载外部模型并核对哈希和大小、
重新导出成受限的 glb 登记成资源、把烘焙指令换成贴图，然后替换重建层写成一次提交。具体的上传和发起命令以
`metaverse --help` 和接口说明为准（重建接口 `POST /api/v1/spaces/{space_id}/scans/{scan_id}/rebuild`）。

提交前确认：

- 对比图里没有悬空、穿地、穿墙的东西；
- 每个外部模型都来自 `fetch` / `place`，没有手改 `model` 和 `props.source`；
- `notes.md` 写清每件是哪个库的哪个模型、还是手写，以及为什么。

提交后在网站上打开空间，"优化模型"视图里点物件能看到"模型来源"。

---

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `doctor` 说渲染不可用 | 按提示装 node / three / Playwright，或用环境变量指定路径；不出图时 `compare`、`assemble` 加 `--no-render` 也能算数字 |
| 候选面朝墙、前后反了 | 看高度图确认靠背在哪边，`place --yaw <角度> --yaw-range 20` 限定 |
| 候选比例不对 | `--scale axis`；还不行就换候选 |
| 候选颜色差太多 | `place` 会提示 tint 帮不上（只能调暗）：换颜色接近或更浅的候选再 `--tint` |
| `fetch` 提示坐标超过 ±1000 米 | 处理服务会拒收这个模型，换候选 |
| Objaverse 第一次检索很慢 | 在下载元数据分片（每个约 3.6 MB）；`metaverse-recon index --category chair` 可以提前下 |
