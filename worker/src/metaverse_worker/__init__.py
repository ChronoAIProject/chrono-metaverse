"""chrono-metaverse 处理服务（设计第 6 节）。

- `canonical`、`chunk`、`shapes`、`records`：与接口服务（Rust）、网站（TypeScript）共用的数据格式
  （SHAPES.md）；
- `store`、`assets`：数据访问（MongoDB 集合与 GridFS 桶 `assets`）；
- `jobs`：任务框架（租约领取、续约、栅栏、写回、子进程、看门狗、清理）；
- `handlers`：各任务种类的处理函数（读写数据库，重计算交给子进程）；
- `runner`、`health`、`__main__`：主循环、健康检查、命令入口；
- `processing`：纯计算的处理模块（扫描加载与对齐、网页用模型、结构重建、体素化、物件模型），在子进程里运行。

配置、任务参数和结果见 `worker/README.md`。
"""

__version__ = "0.1.0"
