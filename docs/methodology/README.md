# 方法论：从扫描到逼真的数字前厅

这一组文档把"用手机扫一个真实空间，在本地做成逼真的数字孪生，再发布到时间线上"的完整做法写下来。依据是公司
前厅（演示空间 `chronoai-lobby`）从第 1 版到精致模型版的全部实测：扫描、基线、六组并行逐件建模、整房评审、
精致化第二轮、贴图概念验证，以及服务端瘦身定稿（[`docs/design/server-slim.md`](../design/server-slim.md)）。

**按服务端瘦身后的流程写**：重建全部在本地（本地工具 `metaverse-recon`，代码在 `recon/`），结果打成**重建包**，
用命令行 `metaverse bundle push` 推成重建草稿、人看过预览再 `metaverse publish`；服务端只做鉴权、存储、时间线
和通用把关，不含任何场景知识；演示空间由部署种子导入按哈希固定的重建包。

## 一页纸流程

```
现场                     本地（Mac 或 Linux，不需要显卡）                                    服务端（只存储和把关）
──────                   ─────────────────────────────────────────────                       ─────────────────────
Scaniverse 扫描      →   metaverse pull --scan        原始扫描、线上变换、上传上限
+ 保留原始数据            metaverse-recon prepare      对齐、算法结构和物体、候选清单（基线）
+ 补拍照片和视频          metaverse-recon webmodel     "原始"视图用的网页用模型
                          逐件建模（多组并行）         看、量 → 先搜库摆进去 → 搜不到就手写 → 对比
                          贴图                         按表面类型：扫描提取 / 材质库 / 烘焙 / AI 生图
                          metaverse-recon assemble     合并成 AI 物件集，整房评审、返工
                          metaverse-recon bundle       重建包 out/bundle/（清单 + 文件，编号 rb.）
                          metaverse bundle check       按服务端同一套规则检查
                          metaverse bundle push    →                                      →  上传核对、重建草稿、展开
                          人看预览链接
                          metaverse publish        →                                      →  一次提交（时间线可回放）
```

## 目录

| 章 | 文件 | 内容 |
|---|---|---|
| 1 | [总览](01-overview.md) | 流程、每步的输入输出、命令、谁来做；效果数字和口径 |
| 2 | [采集](02-capture.md) | Scaniverse 怎么扫；保留原始数据、补拍照片和视频，留给以后更精细的重建 |
| 3 | [基线、对齐和结构](03-baseline-align-structure.md) | 工作区、对齐（首次、沿用线上、重扫配准）、基线、网页用模型、结构按实测改正、漏建团块怎么判断 |
| 4 | [逐件建模](04-modeling.md) | 常见物件找精致带贴图的现成模型，独特物件手写再贴图；按导入后的样子看图；摆放、缩放、调色、朝向、穿模、署名；手写形状技巧 |
| 5 | [多人建模与评审](05-team-review.md) | 怎么分组、每组交什么、怎么合并、独立评审怎么看、第二轮精致化怎么组织 |
| 6 | [贴图手册](06-textures.md) | 按表面类型选做法；扫描正交展开和清理、材质库、烘焙、贴花、AI 生图（本地和接口方案、模型许可）；无缝平铺、法线粗糙度、颜色标定、贴回去 |
| 7 | [写回与上线](07-publish.md) | 打包、检查、推送、预览、发布、冲突和重放；权限；演示种子；验证；回滚 |
| 8 | [已知限制与常见坑](08-pitfalls.md) | 按环节列出踩过的坑和处理办法 |

## 按角色读

- **第一次做的人**：第 1 章，然后第 2 章（去现场之前），第 7 章（上线之前）。
- **AI 模型师**（Claude Code、Codex）：第 3、4、6 章，配合技能说明 `metaverse-reconstruct`（`metaverse init` 写进工作区）。
- **组织多人建模、做评审的人**：第 5 章。
- **部署演示空间的人**：第 7 章"演示种子"。

## 命令现状

- 命令名、参数和目录按服务端瘦身定稿（设计第 6、8 节）写。本地工具里 `align`、`webmodel`、`models`、`bake`、`fit`、
  `scan-zip`、`bundle`、`doctor --install` 是这次改造新加的命令（设计 13.2 的 S6b），参数以
  `metaverse-recon <命令> --help` 为准。
- 贴图命令 `refshot`、`texsearch`、`texfetch`、`texture` 也已进本地工具（S6b）；提取时的清理、去光照、无缝和生成
  法线、粗糙度还没有命令，第 6 章写了怎么自己做。

## 相关文档

- [整体设计](../ARCHITECTURE.md) 第 6、10 节；[服务端瘦身定稿](../design/server-slim.md)；[形状词表](../SHAPES.md)（形状、
  材质、物件记录、重建包清单、资源核对和各用途上限）。
- [重建教程](../tutorials/reconstruct-with-ai.md)：工作台命令一步步的用法。
- [开源方案调研](../research/scan-to-model.md)：采集、重建、贴图的开源工具和许可。
- 前厅物件集和逐件清单：[`infra/chrono-cd/demo/README.md`](../../infra/chrono-cd/demo/README.md)。
