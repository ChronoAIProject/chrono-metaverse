# 前厅 AI 物件集（演示空间 `chronoai-lobby`）

[`lobby-authored.json`](lobby-authored.json) 是 ChronoAI 办公室前厅的 **AI 物件集**（设计 6.3"AI 逐件建模"，格式见
[`recon/README.md`](../../../recon/README.md)"AI 物件集"）：本地的 AI 对着 Scaniverse 扫描逐件做出来的前厅，
线上第 3 版的重建层就是它（"优化模型"视图里看到的），不再用物体重建算法的结果。第 3 版是处理服务还在时由部署配置种子
导入的；服务端瘦身以后（[`docs/design/server-slim.md`](../../../docs/design/server-slim.md)），物件集只在本地用：
`metaverse-recon bundle --authored` 把它打成重建包，再由命令行推送或由种子导入（下面"如何更新线上"）。

| 内容 | 数量 |
|---|---|
| 模板 | 1 个（会议椅 `tpl-meeting-chair`，8 把会议椅共用） |
| 物件 | 52 个：手写形状 36 个（其中 8 个是模板实例、13 个带烘焙指令）、外部模型 10 个（Objaverse，8 个不同的模型，全部 CC-BY-4.0）、结构 6 个 |
| 结构 | `structure: "replace"`：地面、4 面墙、南面玻璃幕墙用物件集里的（算法结果按扫描实测改了 3 件的几何） |
| `notes` | 整房评审与合并报告（每件怎么来的、改了什么、偏差、遗留问题），打包时写成建模记录 `notes.md`，提交的 `scriptRef` 指向它（种子用的包 `--seed` 不带） |
| 大小 | 285,415 字节（上限 4MB） |

**效果**（整房 91,110 个扫描点，剖切掉 2.2 米以上；扫描点到模型的距离，厘米）：

| | 均值 | 90% 分位 | 3 厘米以内 |
|---|---|---|---|
| 现有算法（算法物体 + 算法结构） | 7.11 | 15.13 | 51.3% |
| 六组产出直接合并、结构沿用算法（评审前） | 5.74 | 13.18 | 54.3% |
| 合并稿（结构改正 + 补漏建 + 穿插修正） | 4.31 | 8.71 | 67.0% |
| **本物件集**（合并稿再经独立评审修正 5 处，线上第 3 版） | **4.19** | **8.18** | **68.2%** |

（以前这里写的 4.31 / 8.71 / 67.0% 是合并稿的数；独立评审修正后的定稿就是本目录的 `lobby-authored.json`，按同样的口径
重算是 4.19 / 8.18 / 68.2%，见 [`docs/PROGRESS.md`](../../../docs/PROGRESS.md) 第 6 节、方法论第 1 章。）

展示图（`showcase/`）：下面"本地全流程验证"里网站"优化"视图的截图（去掉了页面的标题栏和底部控件），烘焙贴图、
灯光和网站上看到的一样：

| | |
|---|---|
| ![总览](showcase/6-overview.jpg) | ![入口的 LED 大屏墙（烘焙贴图）](showcase/1-entry.jpg) |
| ![前台](showcase/2-reception.jpg) | ![会议区](showcase/3-meeting.jpg) |
| ![休息区](showcase/4-lounge.jpg) | |

## 怎么做出来的

用的是重建工作台 `metaverse-recon`（[重建教程](../../../docs/tutorials/reconstruct-with-ai.md)），规则是技能说明
`metaverse-reconstruct`（`metaverse init` 写进工作区）：

1. **基线**：`metaverse-recon prepare` 用线上的同一份扫描和提示，走线上第 1 版导入扫描时的同一条代码路径（对齐 →
   结构 → 现有算法的物体），坐标、结构编号和线上完全一致，物件集写的坐标提交时不用换算；`base/candidates.json`
   是任务清单（41 个物体，每件建议先搜库还是直接手写）。
2. **先搜后写**：每件物体先 `views`、`measure` 看图量尺寸，再去模型库（Objaverse、Poly Haven，只列 CC0、CC-BY
   的）`search`、`place` 摆进扫描对照；偏差比现有算法差、或者外形对不上（换了 2–3 个候选都不行）才手写 SHAPES
   形状（`compare` 出"扫描 | 现有算法 | 新模型"对比图和分部件的偏差，改到不再下降）。定制件（前台、LED 大屏墙、
   入口门框、玻璃隔断、展示柜）直接手写；扫描颜色有用的部件写烘焙指令 `bake`，打包时从扫描烘焙成贴图。
3. **六组并行**：入口、前台、会议区、休息区、东侧隔断与柜子、桌上和地上的杂物，各组按同样的规则做自己那一片，
   每件写明用了哪个库的哪个模型、试过哪些候选、为什么手写。
4. **评审**：合并六组（编号冲突、两组认领同一件时按同一范围的偏差取好的），整房出"扫描 | 现有算法 | AI 重建"
   对比图逐区看，另查部件之间的穿插：
   - **结构改正**：南面玻璃幕墙按竖梃、窗台、玻璃三类特征一起拟合（幕墙不平行于坐标轴，转 1.49°）、竖梃按实测
     位置；西侧木饰面墙按扫描平面转 −0.77°、起止点让开入口斜接板和幕墙；LOGO 墙在门边截断。墙面贴图面板保持
     原来的贴图和投影范围（截短的面板旁边放两个 2 毫米的定位小块，贴图坐标不挪位）；
   - **补漏建**：前台背后的打印桌、打印机（模型库）、棕色木门、两个袋子，玻璃隔断南端的白色墙垛和通道口的深色
     立柱（六组都没认领）；
   - **穿插和悬空**：沙发靠背伸进窗台、会议椅座面伸进桌脚、几件东西悬空 2–6 厘米等，逐一改掉。

   每件的过程、改动和偏差见 `notes`（物件集里的 `notes` 字段，也就是评审报告）。

## 逐件清单

路线："手写"是 AI 按扫描实测写的参数形状（本仓库的内容）；"+ 烘焙贴图"表示有部件写了 `bake`，打包时从扫描烘焙成
贴图；"模型库"是外部模型，打包时本地工具按地址下载、核对 sha256 和大小，把俯仰、横滚、缩放、调色烘进网格（偏航写进
记录，只差偏航的共用一个文件），重新导出成受限的 glb。线上第 3 版是处理服务按当时同样的规则做的。

| 区域 | 编号 | 名称 | 路线 | 来源与许可 |
|---|---|---|---|---|
| 入口 | `cabinet-01` | LED 大屏墙 | 手写 + 烘焙贴图 | 本仓库手写 |
| 入口 | `cabinet-02` | 入口玻璃门 | 手写 + 烘焙贴图 | 本仓库手写 |
| 入口 | `entrance-side-wall` | 入口内侧深色横墙 | 手写 + 烘焙贴图 | 本仓库手写 |
| 前台 | `counter-01` | 前台 | 手写 + 烘焙贴图 | 本仓库手写 |
| 前台 | `reception-bottle` | 水杯 | 模型库（Objaverse） | 《Water Bottle Simple Textures》ethan.kowalchuk，CC-BY-4.0 |
| 前台 | `reception-keyboard-1` | 键盘 | 模型库（Objaverse） | 《Keyboard》Arnau Rocher Alcayde，CC-BY-4.0 |
| 前台 | `reception-keyboard-2` | 紧凑键盘 | 模型库（Objaverse） | 《Keyboard 75%》Kenny Pang，CC-BY-4.0 |
| 前台 | `reception-monitor-1` | 显示器 | 模型库（Objaverse） | 《Computer Monitor 16:9 (Low Poly, Game Ready)》Skript47，CC-BY-4.0 |
| 前台 | `reception-monitor-2` | 显示器 | 模型库（Objaverse） | 《Computer Monitor 16:9 (Low Poly, Game Ready)》Skript47，CC-BY-4.0 |
| 前台 | `reception-office-chair` | 办公椅 | 模型库（Objaverse），调色 [141, 149, 151] | 《Office (home) black chair.》Nik Vega，CC-BY-4.0 |
| 会议区 | `tpl-meeting-chair` | 会议椅（桶形扶手椅，四条外撇细腿） | 手写（模板，8 把会议椅共用） | 本仓库手写 |
| 会议区 | `chair-02` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-03` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-04` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-05` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-07` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-08` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-09` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-10` | 会议椅 | 手写（模板 `tpl-meeting-chair` 的实例） | 本仓库手写 |
| 会议区 | `chair-11` | 灰色桶形会议椅 | 手写 | 本仓库手写 |
| 会议区 | `meeting-notebook` | 桌上的灰色笔记本 | 手写 | 本仓库手写 |
| 会议区 | `table-01` | 长会议桌 | 手写 | 本仓库手写 |
| 休息区 | `chair-06` | 休闲椅（高背行政椅） | 模型库（Objaverse），调色 [232, 220, 204] | 《Low Poly Executive Conference Room Chair》Jeremy E. Grayson，CC-BY-4.0 |
| 休息区 | `chair-12` | 休闲椅（高背行政椅） | 模型库（Objaverse），调色 [232, 220, 204] | 《Low Poly Executive Conference Room Chair》Jeremy E. Grayson，CC-BY-4.0 |
| 休息区 | `clutter-08` | 行李箱 | 手写 | 本仓库手写 |
| 休息区 | `clutter-09` | 机器狗 | 手写 | 本仓库手写 |
| 休息区 | `lounge-robot` | 人形机器人（斜靠在米色沙发上） | 手写 | 本仓库手写 |
| 休息区 | `sofa-01` | 米色皮沙发 | 手写 | 本仓库手写 |
| 休息区 | `sofa-02` | 灰色布艺沙发 | 手写 | 本仓库手写 |
| 休息区 | `table-02` | 圆形边几 | 手写 | 本仓库手写 |
| 东侧隔断与柜子 | `cabinet-03` | 东侧玻璃隔断 | 手写 | 本仓库手写 |
| 东侧隔断与柜子 | `cabinet-04` | 杂物（布袋） | 手写 | 本仓库手写 |
| 东侧隔断与柜子 | `cabinet-05` | 镜面玻璃展示柜 | 手写 | 本仓库手写 |
| 东侧隔断与柜子 | `cabinet-06` | 东南角白色墙垛（挂灭火器） | 手写 | 本仓库手写 |
| 东侧隔断与柜子 | `cabinets-se-curved-window` | 东南角弧形窗（窗台 + 玻璃） | 手写 | 本仓库手写 |
| 杂物 | `clutter-01` | 黑色背包 | 模型库（Objaverse），调色 [227, 227, 255] | 《Plain Backpack》eeelabvisual，CC-BY-4.0 |
| 杂物 | `clutter-02` | 蓝色购物袋 | 手写 + 烘焙贴图 | 本仓库手写 |
| 杂物 | `clutter-04` | 桌上的白色袋子和包装盒 | 手写 + 烘焙贴图 | 本仓库手写 |
| 杂物 | `clutter-05` | 桌上的白色纸袋和蓝色文件夹 | 手写 + 烘焙贴图 | 本仓库手写 |
| 杂物 | `clutter-table-pouch` | 桌上的格纹手拿包 | 手写 + 烘焙贴图 | 本仓库手写 |
| 评审补建 | `pillar-01` | 白色墙垛（玻璃隔断南端） | 手写 + 烘焙贴图 | 本仓库手写 |
| 评审补建 | `pillar-02` | 深色立柱（通道口南侧） | 手写 + 烘焙贴图 | 本仓库手写 |
| 评审补建 | `reception-black-bag` | 黑色袋子（打印桌角、靠门） | 手写 + 烘焙贴图 | 本仓库手写 |
| 评审补建 | `reception-door` | 前台后的棕色木门 | 手写 + 烘焙贴图 | 本仓库手写 |
| 评审补建 | `reception-print-desk` | 打印桌（深色矮桌） | 手写 | 本仓库手写 |
| 评审补建 | `reception-printer` | 打印机 | 模型库（Objaverse），调色 [50, 50, 52] | 《Printer- Low Poly》CG Buzz，CC-BY-4.0 |
| 评审补建 | `reception-red-bag` | 红白花纹袋子（靠门立在打印桌上） | 手写 + 烘焙贴图 | 本仓库手写 |
| 结构 | `floor` | 地面 | 结构，算法原样，扫描贴图 | 基线的结构算法 |
| 结构 | `glazing-z15.38-1` | 玻璃（南面幕墙：窗台、玻璃、5 根竖梃） | 结构，算法结果按实测改几何 | 基线的结构算法 + 本仓库手改 |
| 结构 | `wall-a211-1` | 墙面（前台后的 LOGO 墙） | 结构，算法结果按实测改几何，扫描贴图 | 基线的结构算法 + 本仓库手改 |
| 结构 | `wall-x1.14-1` | 墙面（西侧木饰面墙） | 结构，算法结果按实测改几何，扫描贴图 | 基线的结构算法 + 本仓库手改 |
| 结构 | `wall-x3.03-1` | 墙面（入口右侧木墙） | 结构，算法原样，扫描贴图 | 基线的结构算法 |
| 结构 | `wall-x9.55-1` | 墙面（东墙北段，大屏和 LOGO 墙之间） | 结构，算法原样，扫描贴图 | 基线的结构算法 |

锚点：打包时按类别建议（`props.category`，第 3 版是处理服务按同样的规则建的）——长会议桌 `table-01`、圆形边几 `table-02`（桌子）、前台 `counter-01`、
两张沙发 `sofa-01`、`sofa-02`（区域）；椅子没有在提示里要求座位锚点，不建。

## 模型来源与署名

10 个外部模型物件用了 Objaverse 里的 8 个模型，都是 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
（署名即可商用，不传染）。文件经 Objaverse 在 Hugging Face 上的数据集（`allenai/objaverse`）下载，来源页是作者在
Sketchfab 上发布的原页面。**改动**：把物件集里的摆放和调色（`tint`）烘进网格、按物件模型的限制减面、缩小贴图后
重新导出 glb（第 3 版由处理服务做，以后由本地工具 `bundle` 做）；没有改动模型的外形设计。署名随每个物件记录的 `props.source` 保存，网站在场景里有 CC-BY
模型时画面底边常驻一行简短署名，"全部来源"列出完整的标题、作者、许可和来源页，并注明模型经处理后重新导出（与原文件
不同），点选物件时信息面板里也有。

| 标题 | 作者 | 来源页 | 许可 | 用在 | 原文件字节数 |
|---|---|---|---|---|---|
| Low Poly Executive Conference Room Chair | Jeremy E. Grayson | <https://sketchfab.com/3d-models/2d5349cf3aec4578ad94568aedc56eab> | CC-BY-4.0 | `chair-06`、`chair-12` | 55,452 |
| Plain Backpack | eeelabvisual | <https://sketchfab.com/3d-models/e67e1b3c67804122b70eef386ebdc0be> | CC-BY-4.0 | `clutter-01` | 852,064 |
| Water Bottle Simple Textures | ethan.kowalchuk | <https://sketchfab.com/3d-models/910cf7e424e6433abc8a7763bcf9f323> | CC-BY-4.0 | `reception-bottle` | 405,020 |
| Keyboard | Arnau Rocher Alcayde | <https://sketchfab.com/3d-models/e0d3de544b824070925f28a191c789a9> | CC-BY-4.0 | `reception-keyboard-1` | 696,192 |
| Keyboard 75% | Kenny Pang | <https://sketchfab.com/3d-models/d859eb1b182d46dbad4e1cdefd8255b4> | CC-BY-4.0 | `reception-keyboard-2` | 679,588 |
| Computer Monitor 16:9 (Low Poly, Game Ready) | Skript47 | <https://sketchfab.com/3d-models/336de680dd9a4d84943d05d9c7dde1b0> | CC-BY-4.0 | `reception-monitor-1`、`reception-monitor-2` | 310,624 |
| Office (home) black chair. | Nik Vega | <https://sketchfab.com/3d-models/fa8b3412aa10480f9a38aedadd0fbac8> | CC-BY-4.0 | `reception-office-chair` | 2,576,732 |
| Printer- Low Poly | CG Buzz | <https://sketchfab.com/3d-models/8a3a68f84f4d4a34973b527875a7314b> | CC-BY-4.0 | `reception-printer` | 915,264 |

下载地址（`model.url`）都在 `huggingface.co`，会重定向到 `hf.co` 的 CDN 子域名（实测 `us.aws.cdn.hf.co`），本地工具的
主机列表 `METAVERSE_RECON_MODEL_HOSTS`（默认含 `huggingface.co` 和后缀 `.hf.co`）覆盖了这两跳。

## 结构贴图

结构物件里的地面和墙面贴图面板引用的是本地基线（`prepare`）算出的贴图哈希。打包时这些贴图从基线目录（`--base`）按
哈希找到，作为 `texture` 文件进包，和物件一起上传，服务端只核对它们属于本空间、合乎贴图的上限，不再重跑结构算法。
处理服务时期的"哈希对不上就按编号和部件路径回退到线上算出的贴图"（`authored.textureFallback`）也就不需要了。
`wall-x1.14-1`、`wall-a211-1` 截短后保留了原投影范围的定位块，贴图坐标不挪位。

## 如何复现

需要本地重建工具（`cd recon && uv sync --frozen`，或仓库外 `uv tool install …#subdirectory=recon` 再
`metaverse-recon doctor --install`，见[重建教程](../../../docs/tutorials/reconstruct-with-ai.md)）和命令行 `metaverse`。
在命令行的工作区里做（`metaverse init`；只读的话 `metaverse pull --share <演示链接> --assets` 也能建出工作区）：

```bash
# 扫描：线上的扫描 zip 是种子按来源表把两个 Scaniverse 文件按固定规则打成的，本地照样打包，哈希与线上相同
metaverse-recon scan-zip --member mesh.drc=<下载的 mesh.drc> --member tex.jpg=<下载的 tex.jpg>   # 写 scan/scan.zip
# 提示是线上第 1–3 版种子里的 hints（git show 77bbdb8:infra/chrono-cd/demo-seed.json | jq .hints）
metaverse-recon align                                 # 首次自动对齐，写 scan/transform.json（已有空间用 pull 写的）

# 1. 基线（与线上第 1 版导入扫描时同一条代码路径）
metaverse-recon prepare --hints hints.json            # 写 out/recon/

# 2. 逐件：看、量 → 搜、摆 → 搜不到就手写、对比（每件一个目录）
metaverse-recon views   --object sofa-01 --out work/sofa-01/views
metaverse-recon measure --object sofa-01 --heightmap 0.05:1.0 --hm-cell 0.1 --out work/sofa-01/m.json
metaverse-recon search  --query "<英文描述>" --category chair --library objaverse --limit 20 --out work/<编号>/search
metaverse-recon place   --object <编号> --candidate work/<编号>/search/candidates.json#<候选号> \
    --scale axis --tint --out work/<编号>/place      # 外部模型：entity.json 带地址、哈希、署名
metaverse-recon compare --object counter-01 --model work/counter-01/entity.json --color-parts \
    --out work/counter-01/cmp                     # 手写：扫描 | 现有算法 | 新模型

# 3. 合并、整房检查（连结构一起换）
metaverse-recon assemble --entities work/set/*.json --structure replace --notes report.md --out out

# 4. 打包、检查（--seed：种子用的公开包；--webmodel 用线上那份网页用模型，"原始"视图不变）
metaverse-recon bundle --authored out/authored.json --webmodel <网页用模型.glb>
metaverse bundle check
```

`assemble` 最后跑一遍打包时对物件集的校验（`parse_authored`），通过了就是 `out/authored.json`，`room.jpg` 是
整房三列对比、`report.json` 是逐件偏差和漏建的扫描团块。要直接核对本目录的定稿：

```bash
cd recon && .venv/bin/python -c "import json; from metaverse_recon.authored import parse_authored; \
p = parse_authored(json.load(open('../infra/chrono-cd/demo/lobby-authored.json'))); \
print(len(p['templates']), len(p['entities']), len(p['models']))"      # 1 52 10
```

本地全流程（打包 → 推送发布 → 网站看效果）：`infra/dev/up.sh` 起全套，工作区 `metaverse init <空间> --mode direct …`，
打好包后 `metaverse bundle push --publish --sub rita`（本地的重建身份，[`infra/dev/README.md`](../../dev/README.md)）。

## 如何更新线上

线上演示空间由部署配置种子驱动（[`../README.md`](../README.md) 第 8 步"演示数据"）。物件集改了以后有两条路：

1. **种子导入重建包**（设计 7.3、7.4，前厅第 4 版按这条走，托管方式待用户确认，设计第 14 节）：`metaverse-recon bundle --seed`
   打种子用的包（会公开：去掉内部锚点和建模记录）→ 大文件按 `<sha256>.<扩展名>` 传到发布页 → 写来源表
   （扫描 zip 写成两个 Scaniverse 成员）→ 清单和来源表提交进本目录的 `lobby-r<版本>/` → 种子配置的 `bundle` 引用这次
   提交的 raw 地址（按 40 位提交哈希固定）和两个文件的 sha256、大小，`revision` 加一 → `node infra/dev/demo-seed.mjs
   compact infra/chrono-cd/demo-seed.json` 的输出就是 `METAVERSE_DEMO_SEED` 的值，跑 `node infra/chrono-cd/check-app.mjs`，
   再按 [`../README.md`](../README.md) 第 8 步只改这一项。接口服务重启后在同一个空间里导入这个包、发布一次
   `actor.kind = rebuild` 的提交（重建层整体替换、锚点只新建），空间和演示链接不变；
2. **命令行直接推送**（NyxID 已注册）：有 `metaverse:rebuild:write` 的人（平台管理员建的角色 `metaverse-rebuilder`，
   还没建）在工作区里 `metaverse bundle push`，看过预览后 `metaverse publish <草稿编号>`。这条路不用托管文件，但新库
   （本地 `--demo-seed`）就没有内容了，所以演示空间仍以第 1 条为准。

## 本地全流程验证

**服务端瘦身以后**（2026-11-10，`docs/design/server-slim.md` S9 的本地全流程，4 核）：

- **本地打包 → 推送发布**：精致模型版物件集（外部模型物件 26 件，第 3 版之后的第二轮，还没上线）在新空间的工作区里
  `metaverse-recon align` → `bundle --authored`（模型从本地缓存按哈希取，40 秒）→ `metaverse bundle push --publish`
  （重建身份，28 秒）：52 件物件、5 个建议锚点、物件模型 17 个文件（8 把会议椅只差偏航，共用一个 glb）、贴图 20 张；
  网站优化视图的接口数据 18.7 MB（物件模型 18.3 MB），以前按处理服务的导出估计约 47.6 MB（物件模型 38.2 MB）；
- **种子导入同一个包**：包放在本机 https 服务（自签证书），新库里种子建空间、下载 41 个文件、核对、展开、发布用了
  4.8 秒，结果与命令行发布的逐项相同（物件、锚点、扫描、网页用模型）；重启后 `AlreadyDone`，不再下载；
- **第 4 版演练**：在用改造前的代码（处理服务）按旧种子写出第 1–3 版的库上换成新代码，`metaverse pull --scan` 取回扫描
  和变换，本目录的 `lobby-authored.json` 按线上的两档网页用模型重新打包、推送：扫描、网页用模型和 23 张贴图按哈希复用，
  只重新上传了 8 个物件模型，锚点 5 个全部跳过（编号已存在），发布为第 4 次提交；第 1–3 版的快照照常回放，逐字节不变。


**处理服务时期**（2026-11-09，第 3 版上线前）：在本机（4 核）用 `infra/dev/up.sh --demo-seed=<种子>` 起全套：种子照抄 `demo-seed.json`，`authored` 指向
本机 http 服务提供的本文件，扫描照常从 scaniverse.com 下载。一个全新的空间里，种子建的 `scan_import` 任务一次完成
导入扫描和写入物件集（提交 #2"导入扫描 bfda42ee4c47（首次自动对齐，AI 物件集）"），用时 61 秒（读取 1 秒、网页用
模型 9 秒、物件集 44 秒）：

| 项目 | 结果 |
|---|---|
| 物件 | 53 条重建层记录（结构 6、物体 46、模板 1），与物件集一致 |
| 外部模型 | 8 个文件全部下载并核对（6,490,936 字节，每个都从 `huggingface.co` 重定向一跳到 `us.aws.cdn.hf.co`，`WORKER_MODEL_HOSTS` 覆盖）；重新导出成 10 个 glb、合计 2,444,636 字节、66,396 个三角形，都登记成资源 |
| 烘焙贴图 | 13 个物件的 18 处烘焙全部生成贴图、没有退回后备纯色：LED 大屏（27.9 KB，桌面画面清楚）、入口门头的 EXIT 灯箱、前台、门、袋子、柱子等 |
| 结构贴图 | 物件集引用的 5 张结构贴图本空间原来没有，本次任务的结构算法算出了完全相同的哈希，直接登记（`textureFallback` 为空）；另把这 5 个哈希改成别的再提交一次重建，处理服务按编号和部件路径换成本次算出的贴图，替换清单列出 5 处 |
| 逐件偏差 | 52 件都有 `fit`：均值 1.11–4.78 厘米（中位数 2.29），46 件 ≤ 3 厘米，3 厘米内比例的中位数 71.5%；最大的是前台两台显示器（3.83、4.78，深色屏幕扫成一团）和办公椅（3.78） |
| 锚点 | 前台 `counter-01`、长会议桌 `table-01`、圆形边几 `table-02`（桌子），两张沙发 `sofa-01`、`sofa-02`（区域） |

网站（无头浏览器打开 `/s/chronoai-lobby#share=<令牌>`）：优化视图 52 个物件（8 个模板实例、23 处贴图）、13.7 万个
三角形，约 3 秒画出；接口数据合计 2.85 MB（外部模型 glb 2.44 MB，最大的是键盘 0.51 MB、背包 0.45 MB、紧凑键盘
0.44 MB；贴图 0.29 MB；快照等 JSON 0.11 MB），远低于 40 MB，不用换更小的模型。画面底边常驻"模型来源：…，共 8 项"，
"全部来源"列出 8 个模型的标题、作者、CC BY 4.0 和来源页。原始视图加载的是扫描的网页用模型（13.4 MB）。
