"""纯计算的处理模块（不碰数据库）。

- `scan`：扫描加载（Draco + 贴图、glb、obj）、对齐（墙面法线定向、地面 y = 0、角点为原点）、表面采样；
- `bake`：从扫描贴图正交投影烘焙平面贴图（补洞用 push-pull）；
- `structure`：结构重建（地面、墙、斜墙、玻璃、墙角吸附、贴图），输出 SHAPES 物件记录；
- `voxelize`：可选的方块风格，输出 SHAPES 区块编码 + 方块表；
- `webmodel`：网页用模型（二次误差减面 + 缩小贴图，导出 glb）；
- `tasks`：给子进程调用的入口（参数和返回值都是普通数据）。

验证代码见 `spikes/voxelize/`、`spikes/parametric/`，这里是整理后的正式版本。
"""
