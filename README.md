# chrono-metaverse

实体空间的数字孪生 + 虚拟扩展，按一条时间线记录和回放。

- 导入 Scaniverse 扫描模型，AI 按扫描轮廓重建出干净的优化模型；虚拟区可以用方块建造
- 网站只读，凭分享链接查看：原始 / 优化 / 优化 + 虚拟扩展三种视图，时间轴回放
- 所有更新走接口，鉴权和权限完全使用 NyxID：每个 agent 一把 NyxID agent key，能做什么由人在 NyxID 里配置
- 多个空间可组合展示，跨空间事件同步回放
- 部署在 chrono-cd，数据存 MongoDB

## 目录

```
api/          接口服务：Rust 工作区（axum + mongodb + utoipa）
  crates/metaverse-core   区块编码、内容哈希、回放、操作、形状词表（纯计算）
  crates/metaverse-api    公开读、写、管理接口；NyxID 身份令牌校验与组织角色查询
web/          只读查看器：React + Vite + three.js（沿用 CMA 前端工程），nginx 托管
recon/        本地重建工具：Python（扫描对齐、网页用模型、结构和物体、AI 物件集、重建工作台 metaverse-recon）
sdk/typescript  metaverse 命令行与建造脚本工具包
infra/
  api/ web/           两个镜像的 Dockerfile（构建上下文是仓库根目录）
  chrono-cd/          chrono-cd 应用规格（app.json）与部署说明
  dev/                本地全套：模拟 NyxID、一键启动脚本
docs/         整体设计、建设计划、形状词表、教程
spikes/       第 0 阶段验证代码与结果
.github/      持续集成（ci.yml）与镜像构建（images.yml）
```

## 快速开始（本地全套）

需要 Node 22、Rust（`rustup`，版本由 `api/rust-toolchain.toml` 固定）、Python 3.13（推荐 [uv](https://docs.astral.sh/uv/)）和一个 MongoDB 副本集（没有的话脚本会提示怎么装）。

```bash
infra/dev/up.sh       # MongoDB（复用或新起）+ 模拟 NyxID + 接口服务 + 网站
# 网站      http://127.0.0.1:5173/
# 接口服务  http://127.0.0.1:8080/api/healthz
# 模拟 NyxID http://127.0.0.1:8090（组织角色见 infra/dev/org-roles.json）

# 以 chronoai 组织的 admin（alice）身份建一个空间，返回里有分享令牌
node infra/dev/call.mjs --as alice POST /api/v1/admin/spaces \
  '{"id":"front-hall","name":"公司前厅","owner":{"kind":"org","id":"chronoai"}}'
# 然后打开 http://127.0.0.1:5173/s/front-hall#share=<分享令牌>

infra/dev/down.sh     # 停止
```

不连后端只看网站：`cd web && npm ci && npm run dev:fixtures`，打开首页上的演示空间。各部分的单独命令见 [api/README.md](api/README.md)、[web/README.md](web/README.md)、[infra/dev/README.md](infra/dev/README.md)。

## 部署

- 镜像：推送到 `main` 或开发分支时由 GitHub Actions 构建，推到 `ghcr.io/chronoaiproject/chrono-metaverse-{api,web}`（标签：7 位提交哈希、分支名；`latest` 只给 `main`；部署一律按摘要固定）。
- 部署：chrono-cd 的 ChronoAI 组织下，项目 `metaverse`、应用 `chrono-metaverse`，服务 `metaverse-web` / `metaverse-api` 加 MongoDB 插件（处理服务已下线，重建在本地做，见 [docs/design/server-slim.md](docs/design/server-slim.md)）。规格和完整步骤（设为公开、提交、NyxID 注册、导入演示数据、回滚）见 [infra/chrono-cd/README.md](infra/chrono-cd/README.md)。

## 文档

- [整体设计](docs/ARCHITECTURE.md)、[建设计划](docs/BUILD_PLAN.md)、[进度报告](docs/PROGRESS.md)、[形状词表](docs/SHAPES.md)、[重建开源方案调研](docs/research/scan-to-model.md)
- [建造教程](docs/tutorials/build-space.md)：用 Claude Code / Codex 建造空间、给 AI 配 agent key、写事件、组合空间
- [开发教程](docs/tutorials/cloud-claude-code-nyxid.md)：在云端用 Claude Code 连接 NyxID 开发、部署、注册 NyxID 服务
- [重建教程](docs/tutorials/reconstruct-with-ai.md) 和[方法论](docs/methodology/README.md)：从扫描到逼真的数字孪生——采集、本地重建、逐件建模、多人评审、贴图、写回上线
