"""chrono-metaverse 的本地重建工具（处理服务已下线，重建都在本地做，结果交给命令行打包推送）。

- `canonical`、`chunk`、`shapes`、`records`：与接口服务（Rust）、网站（TypeScript）共用的数据格式
  （SHAPES.md）；
- `processing`：纯计算的处理模块（扫描加载与对齐、网页用模型、结构和物体重建、AI 物件集、体素化、物件模型），
  解析前检查的上限在 `processing.limits`；
- `bundle`：重建包的本地部分（建议锚点、下载外部模型、一份扫描 → 重建结果）；
- `recon`：重建工作台 `metaverse-recon`（给 AI 模型师用的眼睛、尺子和裁判）；
- `authored`、`fetch`：AI 物件集的解析校验、按主机列表下载。

所有模块只读写本地文件，不连接数据库，也不连接本服务。用法见 `worker/README.md`。
"""

__version__ = "0.1.0"
