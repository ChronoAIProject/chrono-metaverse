# 概念验证：大语言模型看图写模型

验证"让大语言模型理解物体、直接手写参数化形状模型，计算只做测量和校验"这条路线（2026-11-09）。

当时用的重建工作台已经做成正式命令 `metaverse-recon`（`worker/src/metaverse_worker/recon/`，用法见
`worker/README.md` 的"重建工作台"一节和 `docs/tutorials/reconstruct-with-ai.md`），并加上了"先去模型库搜现成
模型、搜不到再手写"的流程。这里只保留四个手写模型和结论。

- `models/<物体>/`：模型手写的物件记录（`model.json`，SHAPES 格式）、建模过程记录（`notes.md`）、对比图
  （`compare.jpg`，三列：扫描 | 现有算法 | 新模型）。

**坐标系**：这四个模型是在 `scripts/reconstruct_lobby.py` 的对齐（`compute_alignment`）里写的，和处理服务
`scan_import` 的对齐（也就是 `metaverse-recon prepare` 的基线）差约 (−0.29, −0.05, −0.26) 米。要在新基线上用，
先换算：

```bash
metaverse-recon reframe --scan mesh.drc --from compute --to scan_import \
    --in scripts/llm_poc/models/*/model.json --out out/poc-reframed
```

| 物体 | 模型的理解 | 扫描→模型偏差（新 / 现有算法） | 3 厘米内（新 / 现有） |
|---|---|---|---|
| counter-01 前台 | 折纸式折面接待台：V 形双斜面主体 + 斜切船头 + 倒五边形翼板 | 3.68 / 4.27 厘米 | 70.9% / 64.0% |
| chair-08 会议椅 | 桶形扶手椅，四条外撇锥形腿（不是转椅），8 把同款共用模板 | 1.93 / 2.89 厘米（去掉混入范围的桌面后） | 83.8% / 63.5% |
| sofa-01 米色皮沙发 | 双人位：枕式扶手、整块坐垫、后仰靠背垫、短腿 | 2.83 / 4.07 厘米 | 69.5% / 47.1% |
| cabinet-02 | 实为玻璃门入口：木饰面墙 + 斜玻璃侧板 + 三段门头 + EXIT 灯 | 3.05 / 2.94 厘米 | 76.1% / 80.3% |

每个物体 3 轮"看 → 量 → 写 → 对比 → 改"。模型师反馈缺的工具（斜面朝向测量、高度图数字表、平面多边形 →
板件、对比时排除相邻物体、按部件着色）都已经加进 `metaverse-recon`（`measure --plane`、`measure --heightmap`、
形状 `plate` / `hull`、`compare --exclude`、`compare --color-parts`）。
