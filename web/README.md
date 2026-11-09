# web：只读查看器

React 19 + Vite + TypeScript + three.js。凭分享链接打开空间，查看三种视图（原始 / 优化 / 优化 + 扩展），支持剖切、时间轴回放和"现在"模式（设计第 7 节）。工程设施沿用 CMA 的 `web/`。

## 命令

```bash
npm ci                 # 安装依赖（锁文件从 CMA 的 package-lock.json 收缩而来，版本与 CMA 一致）
npm run dev            # 开发服务器，/api 转给本地接口服务（METAVERSE_API_URL，默认 http://127.0.0.1:8080）
npm run dev:fixtures   # 夹具模式：/api/public 由 src/fixtures 回答，不需要后端
npm run lint           # eslint，零警告
npm run typecheck      # tsc（源码 + e2e）
npm run format:check   # prettier
npm test               # vitest
npm run build          # 生产构建，输出 dist/（含 build-info.json）
npm run e2e            # Playwright：夹具模式下打开查看器、切三种视图、拖时间轴，并截图
```

夹具空间的链接：`/s/demo-lobby#share=fixture-share-token-0123456789abcdef`（`npm run dev:fixtures` 后打开，首页也有入口）。

端到端测试的浏览器：优先用环境变量 `METAVERSE_E2E_BROWSER_PATH`；没有时，如果本机有预装的 `/opt/pw-browsers/chromium` 就用它（固定版本的 Playwright 1.58.2 要的 Chromium 版本不一定装了）。无头环境用 SwiftShader 渲染 WebGL。截图写到 `e2e/screenshots/`（不进版本库）。

## 从 CMA 复用了什么

| 内容             | CMA 位置                                                                        | 本项目                                            | 改动                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖和脚本       | `web/package.json`、`package-lock.json`                                         | `package.json`、`package-lock.json`               | 只保留需要的依赖，版本不变（react ^19.2、three 0.184.0、vite ^7.3.7、vitest 4.1.12、@playwright/test 1.58.2、testing-library、eslint 9、prettier 3、typescript 5.9）；新增 `fflate`（CMA 锁文件里已有的 0.8.3）和 `@noble/hashes` |
| Vite 配置        | `web/vite.config.ts`                                                            | `vite.config.ts`                                  | 保留构建身份和夹具插件的接法、vitest 配置；去掉 SDK 别名、文档目录和系统字号插件                                                                                                                                                  |
| 构建身份         | `web/build/identity.ts`（含测试）                                               | `build/identity.ts`                               | 原样复制                                                                                                                                                                                                                          |
| 夹具模式         | `web/build/devFixtures.ts`                                                      | `build/devFixtures.ts` + `src/fixtures/server.ts` | 同样的结构（只在 `vite serve --mode fixtures` 加载、写请求拒绝、缺夹具返回带类型的 404），内容换成公开读接口                                                                                                                      |
| TypeScript       | `web/tsconfig.json`、`web/e2e/tsconfig.json`                                    | 同名                                              | 去掉 SDK 路径映射                                                                                                                                                                                                                 |
| ESLint、Prettier | `web/eslint.config.js`、`.prettierrc.json`、`.prettierignore`                   | 同名                                              | 规则不变，忽略目录按本项目调整                                                                                                                                                                                                    |
| 测试设施         | `web/src/test/setup.ts`                                                         | `src/test/setup.ts`                               | 原样复制（jsdom 补丁、内存版 localStorage）                                                                                                                                                                                       |
| Playwright       | `web/e2e/*.config.ts`（webServer、只用 Chromium、关闭 trace/录像）              | `e2e/playwright.config.ts`                        | 改成起夹具模式的开发服务器                                                                                                                                                                                                        |
| 样式令牌和主题   | `web/src/styles/{tokens,design-platform,effects-typography,scrollbar,base}.css` | `src/styles/`                                     | 调色板原样复制；`tokens.css` 去掉 Agent Workspace 令牌和不用的字体，只保留 Geist / Geist Mono                                                                                                                                     |
| 深浅色主题       | `web/src/theme/appearance.ts`（含测试）、`index.html` 里的首帧脚本              | `src/theme/appearance.ts`、`index.html`           | 存储键改成 `metaverse:appearance`，标签改中文；测试照样直接运行 `index.html` 里的脚本核对                                                                                                                                         |
| 路由写法         | `web/src/routing/routes.ts`                                                     | `src/routing/routes.ts`                           | 同样的手写路由（路径和路由对象往返转换），只有 `/`、`/s/:spaceId`、`/u/:universeId`                                                                                                                                               |
| 错误格式         | CMA 的 RFC 9457 问题文档（`code`、`detail`、`title`）                           | `src/core/api/client.ts`                          | 客户端按同样的格式解析                                                                                                                                                                                                            |
| nginx            | `web/nginx.conf`                                                                | `nginx.conf`                                      | 保留安全头、带哈希文件永久缓存、入口页不缓存、缺文件不缓存、单页应用兜底；去掉 CMA 各服务的转发，改成 `/api/` 整体转给 `metaverse-api`；`Referrer-Policy` 改成 `no-referrer`（设计 7.2）                                          |

去掉的：所有 agent / 沙箱 / 事件网关 / 文档 / 用量相关的页面、组件和 e2e 检查，NyxID 登录（网站只读、不登录），CMA SDK，品牌图标。

## 目录

```
build/             vite 插件：构建身份、夹具模式
e2e/               Playwright（夹具模式）
public/            favicon
src/
  core/            与界面无关的核心代码（node 和浏览器都能跑）
    chunk.ts         区块编码：下标顺序、小端、sha256(0x01‖规范字节)、zlib 存储
    canonicalJson.ts 规范化 JSON 和内容哈希
    shapes/          形状词表 → 网格（全部类型）→ three.js BufferGeometry
    events.ts        更正后的有效事件、T 时刻状态、时间窗、密度、增量合并
    scene.ts         快照 → 场景文档；三种视图的取舍（设计 7.1）
    voxels.ts        重建层 ⊕ 扩展层叠加、可见面网格
    api/             公开读接口（设计 8.2）的类型和客户端
  viewer/          three.js 场景（轨道相机、剖切、虚拟区光效、锚点标签）
  timeline/        时间轴组件（提交标记、事件密度、播放/暂停/调速、上一个/下一个提交、"现在"）
  space/           空间页面：数据加载、视图切换、剖切滑块
  fixtures/        夹具空间"演示前厅"（形状词表格式）和夹具接口
```

## 核心约定（三边要对齐的地方）

**区块和哈希**（`docs/SHAPES.md` 第 4、5 节）：`codec.test.ts` 里的内联向量是用 Python（hashlib、zlib、json）独立算出来的，网站算出的区块哈希和规范化 JSON 与之一致。规范化 JSON 的数字格式按 ECMAScript（`1e+21`、`5e-324`），整数不带小数点，`-0` 写成 `0`；Rust、Python 那边遇到指数形式要按这个格式输出。正式的跨语言向量（`api/crates/metaverse-core/tests/vectors/`）建好后，改成读那批文件。

**网格细分**（形状向量要核对三角形数时用）：

- 圆弧（bulge）和圆角按不超过 11.25° 一步采样；bulge 圆弧的步数取偶数，弧顶一定被采到；
- 转角超过 30° 的点是硬边（拆开法线），其余点平滑；
- `box`：无圆角 12 个三角形；圆角分段 n 时 12 + 16n + 16n²（默认 n = 4，共 332）；倒角按 n = 1 再平面着色（44）；
- `cylinder` / `cone` / `lathe`：绕轴分段 S（默认 32）；轮廓每段 2S 个三角形，端点在轴上的段 S 个（圆柱 128，圆锥 64）；
- `extrude`：侧面每条边 2 个三角形 × 圈数间隔；顶底边缘圆角 4 段、倒角 1 段；顶面和底面按轮廓三角化；
- `sweep`：圆截面默认 16 段，矩形 4 条边；拐角按 `smooth` 放圆弧；拐点处截面斜接；
- `loft`：各截面按归一化弧长重采样，采样点 = 48 个均匀点 + 各截面原有顶点的位置（角点精确保留）；起点是形心向 +x 的射线与轮廓的交点；
- 退化（面积为 0）的三角形一律去掉。

**接口数据**：类型照抄设计第 4、5 节的字段名（驼峰）。以下几点是网站这边的假设，接口服务定稿后要核对：

- 分页结果是 `{ items, nextAfter }`；
- `GET /api/public/spaces/{id}` 带上公开的事件类型 `eventTypes`（显示规则），查看器据此可视化事件；
- 事件类型的 `state.value` 是 data 里的字段名，`state.clears: true` 表示这类事件清除状态；
- 预览令牌放在 `Authorization: Preview <令牌>` 里；
- 物件 `props.glass: true` 时按半透明玻璃画（形状词表的材质里没有"玻璃"）；
- 扫描的对齐变换 `scan.transform` 是列主序 4×4 矩阵。

## 夹具

`src/fixtures/` 是一个按形状词表写成的小前厅，四次提交：

1. 导入扫描（只有原始模型；扫描是用重建场景加噪声、破洞生成的 glb）；
2. AI 重建：地面、墙、玻璃隔断、天花板，带圆角的办公桌（`box` + `fillet`，挡板用 `chamfer`），旋转体边几（`lathe`），扫掠椅腿的椅子模板（`sweep` + `loft` 靠背）和 3 个实例（其中一把换了颜色），轮廓带圆弧和圆角的沙发（`extrude`），放样花盆（`loft`），落地灯（`cylinder` 圆台）；
3. 虚拟展区：方块平台、红砖柱、玻璃墙（区块），展台（扩展层物件），实体区的地毯（扩展层方块）；
4. 挪动一把椅子。

另有一个多月的入座、出餐、离座事件和一条更正，用于时间轴密度和锚点状态。
