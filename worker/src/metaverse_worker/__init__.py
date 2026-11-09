"""chrono-metaverse 处理服务（设计第 6 节）。

- `canonical`、`chunk`、`shapes`、`records`：与接口服务（Rust）、网站（TypeScript）共用的数据格式（SHAPES.md）；
- `store`、`assets`：数据访问（MongoDB 集合与 GridFS 桶 `assets`），只有这两个模块直接碰数据库；
- `jobs`：任务框架（租约领取、续约、栅栏、写回、子进程、看门狗、清理）；
- `processing`：纯计算的处理模块（扫描加载与对齐、体素化、结构重建、网页用模型）。
"""

__version__ = "0.1.0"
