# chrono-metaverse

实体空间的数字孪生 + 虚拟扩展，按一条时间线记录和回放。

- 导入 Scaniverse 扫描模型，自动生成方块化的优化模型
- 网站只读，所有人可看：原始 / 优化 / 优化 + 虚拟扩展三种视图，时间轴回放
- 所有更新走接口：NyxID 鉴权 + 空间钥匙；AI（Claude Code / Codex）经 NyxID 调用
- 多个空间可组合展示，跨空间事件同步回放
- 部署在 chrono-cd，数据存 MongoDB

整体设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
