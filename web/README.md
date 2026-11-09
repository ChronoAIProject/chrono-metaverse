# web：只读查看器

React 19 + Vite + TypeScript + three.js。凭分享链接打开空间或组合宇宙，查看三种视图（原始 / 优化 / 优化 + 扩展），支持剖切、时间轴回放、"现在"模式、事件可视化和草稿预览（设计第 5.4、5.5、7、8.2、12 节）。工程设施沿用 CMA 的 `web/`。

## 页面

| 地址                                 | 内容                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/s/<空间编号>#share=<分享令牌>`     | 一个空间：三种视图、形状 / 方块、剖切、时间轴（提交标记、事件密度、播放/暂停/调速/跳转、上一个/下一个提交、"现在"）、事件可视化、点选物件看属性                   |
| `/u/<组合编号>#share=<组合分享令牌>` | 组合宇宙：按 T 时刻的修订把各成员空间按摆放（先绕 y 轴旋转、再平移，单位格）放进同一场景；画出连接（点击飞到另一端）；跨空间路线按 correlationId 配对并按时间推进 |
| `/preview#t=<预览令牌>`              | 草稿预览：标明"草稿预览"，草稿的区块和资源走预览接口，不缓存，没有时间轴                                                                                          |
| `/`                                  | 首页（夹具模式下有三个夹具链接）                                                                                                                                  |

链接无效、令牌不对、空间不存在一律提示"链接无效，或者空间不存在"，不暴露是哪一种；网络或服务错误给"重试"。页面头部可以切换深浅色主题（跟随系统 / 浅色 / 深色），三维场景的背景和强调色跟着主题走。手机上单指旋转、双指缩放和平移。加载时显示进度（读取版本、下载区块 x/y、下载扫描模型 KB、生成网格 x/y）。

**三种视图**（设计 7.1）：

- 原始：T 时最新的扫描，加载 `webModelHashes[0]`（glb）并按 `scan.transform`（列主序 4×4）摆放；T 之前没有扫描时提示；
- 优化：重建层 ⊕ 扩展层，只取实体区（物件按区域、方块按实体区格子盒过滤）；
- 优化 + 扩展：全部物件和方块，虚拟区画边界光效和"虚拟"标签。

剖切对所有视图（包括扫描模型、生成的物件）生效；剖切高度以上的锚点标签隐藏，点选也点不到被切掉的部分。

**形状 / 方块**（重建层的画法）：同一次扫描既做了形状重建、又做了体素化时，快照的重建层里既有物件又有区块，叠在一起画会让地面成为马赛克。这时视图切换旁边多一个"形状 / 方块"切换（默认形状）：

- 形状：画重建层物件，不画重建层区块；扩展层的区块照画；
- 方块：画重建层区块，不画重建层物件；扩展层的物件照画。锚点高亮仍然用重建层物件的包围盒；
- 重建层只有一种内容时不显示切换，照常画；原始视图只画扫描，切换禁用；
- 选择记在查询参数里：`/s/<空间编号>?style=blocks#share=<分享令牌>`（默认的形状不写）。只换查询参数、用 `replaceState`，`#` 后面的令牌原样保留，刷新和复制链接都保留选择。组合页（任一成员两种都有时）和预览页同样适用。

**镜头取景**（`src/viewer/framing.ts`）：取景的包围盒 = 每个成员里内容（物件、方块、扫描）的包围盒和实体区盒子求交后合并（真实空间的实体区通常比房间大得多，只用实体区盒子会离得太远）；优化 + 扩展视图把虚拟区（内容和区域本身）一起纳入；没有定义实体区时用全部内容；开着剖切时顶部压到剖切高度。镜头斜上方 45° 俯视，方位角在东南方向 15°–75° 里挑能让房间显得最大的（宽屏上长边横放，竖屏手机上竖放），距离按透视投影精确算：包围盒 8 个角落在四边各留 6%（合计约 12%）的范围里，再把观察点挪到投影居中。第一次有内容时自动取景，"回到全景"用同样的取景；镜头没被拖动过时，画面大小变化（转屏、页头换行）或换视图会重新取景，时间轴换版本不重新取景。

**锚点标签**（`src/viewer/labelLayout.ts`）：真实扫描里每个重建出的物体都有锚点，标签全画出来会盖住场景，所以默认只显示有意义的：

| 优先级 | 锚点                                                     | 默认                     |
| ------ | -------------------------------------------------------- | ------------------------ |
| 最高   | 有事件状态或事件显示（高亮、图标、标签、热力、路线两端） | 显示（屏幕上再小也显示） |
| 高     | `table`、`counter`                                       | 显示                     |
| 中     | `door`                                                   | 显示                     |
| 低     | `zone`                                                   | 显示                     |
| —      | `seat`、`camera`、未分类（不认识的类型）                 | 不显示                   |

- 鼠标悬停在物件（显示它挂的锚点）或锚点附近 18 像素以内时显示；手机上点按物件或锚点（28 像素以内）时显示，选中物件时它的锚点标签一直显示；
- 屏幕空间避让：按优先级从高到低放（同级的屏幕上大的先放），和已经放下的标签重叠就不放；悬停 / 点按的那个最先放、总是显示；
- 远处的隐藏：锚点范围（盒子锚点的格子盒，点锚点用挂在上面的物件，都没有按 0.6 米估计）在屏幕上小于 28 像素时不放标签；
- 数量上限：按画面面积，宽屏 10 个，手机 4 个（悬停的不占名额）；
- 右下角"显示全部标签"打开时不做取舍（剖切掉的、画面外的仍然隐藏）；
- 标签大小按字数估计，不读 DOM；镜头移动时最多每 100 毫秒重算一次。

**渲染**：

- 形状词表全部类型（`box` 圆角/倒角、`cylinder`、`cone`、`extrude`、`lathe`、`sweep`、`loft`、`group`、`instance`）；
- 材质：颜色，或贴图（`/api/public/assets/{hash}.bin`，uv 投影 `box`/`planar`/`cylindrical`/`mesh`，`tint` 作色调，重复平铺）；
- 模板 + 实例：实例的 `material` 覆盖模板颜色（模板里的贴图保留，用实例颜色做色调）；
- 网格在 Web Worker 里生成（`src/viewer/meshWorker.ts`，两个后台线程），主线程只组装 BufferGeometry；没有 Worker 时（单元测试）在主线程分批执行；
- 物件最外层的 transform 拆出来当实例矩阵：同样的局部形状共用一份几何体，两个以上画成 `InstancedMesh`；
- 只有 `assetHash`（处理后的物件模型）没有 `shape` 的物件：加载 glb，放在 `bounds` 的底面中心；
- 方块：区块（zlib）解码并核对哈希 → 两层叠加 → 可见面网格（后台线程）；方块表支持颜色和贴图（`texture.top/side/bottom`，缺的用侧面），`glass` 半透明，`emissive` 不受光照。

**事件可视化**（设计 5.4，只实现这六种）：

| 显示方式      | 画法                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `highlight`   | 锚点上挂的物件包围盒发光（没有物件时画地面圆盘），锚点标签变色并显示 `labelTemplate`                                                          |
| `icon`        | 锚点上方的图标（自带 dish/flower/bell/star/person/box/door/cart/info，别的名字画成 info）                                                     |
| `label`       | 锚点上方的文字气泡；空间级锚点 `_space`（营业状态这类）放在左上角的状态栏里                                                                   |
| `path`        | 同一 `correlationId` 的起点和终点配对，沿连接走最短路径（经过连接两端的锚点），没有连接画弧线；按两事件时间差推进；只有起点时只在起点显示图标 |
| `spawnEntity` | 在锚点处放 `entityAsset`（处理后的 glb）                                                                                                      |
| `heat`        | 每个锚点 `heat.windowSec` 内按 `weight` 累加，按同类型最大值归一化，画成地面上的柔和圆斑                                                      |

状态事件（类型带 `state`）按 T 时刻的状态显示，超过 `maxAgeSec` 失效；瞬时事件显示 T 之前一个时间窗内的（窗口取 `durationSec` 和页面给的窗口里大的：暂停回放 15 分钟，播放时随速度放大，"现在"模式 10 秒）。起点事件必须写在 `correlationId` 前缀对应的空间里，否则不配对；单空间页只显示本空间这一侧的图标。所有事件文本、锚点标签、提交说明、物件属性一律用 `textContent` 写入（纯文本）。

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
npm run e2e            # Playwright（夹具模式）：三种视图、取景、锚点标签、形状 / 方块、剖切、时间轴、现在模式、组合、预览、错误页、浅色主题、手机
```

夹具链接（`npm run dev:fixtures` 后打开，首页也有入口）：

- 空间：`/s/demo-lobby#share=fixture-share-token-0123456789abcdef`
- 组合：`/u/demo-street#share=fixture-universe-token-00112233445566778899`
- 预览：`/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899`

夹具模式下可以模拟"现在"发生的事（端到端测试用）：`POST /__fixtures/emit?kind=event`（出餐 + 营业状态变化），`kind=commit`（新提交 seq 5），`kind=delivery`（花店送花到前厅）；`POST /__fixtures/reset` 重新生成夹具。

端到端测试的浏览器：优先用环境变量 `METAVERSE_E2E_BROWSER_PATH`；没有时，如果本机有预装的 `/opt/pw-browsers/chromium` 就用它（固定版本的 Playwright 1.58.2 要的 Chromium 版本不一定装了）。无头环境用 SwiftShader 渲染 WebGL。截图写到 `e2e/screenshots/`（不进版本库）。

## 从 CMA 复用了什么

| 内容             | CMA 位置                                                                        | 本项目                                            | 改动                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖和脚本       | `web/package.json`、`package-lock.json`                                         | `package.json`、`package-lock.json`               | 只保留需要的依赖，版本不变（react ^19.2、three 0.184.0、vite ^7.3.7、vitest 4.1.12、@playwright/test 1.58.2、testing-library、eslint 9、prettier 3、typescript 5.9）；新增 `fflate`（CMA 锁文件里已有的 0.8.3）和 `@noble/hashes`                                                              |
| Vite 配置        | `web/vite.config.ts`                                                            | `vite.config.ts`                                  | 保留构建身份和夹具插件的接法、vitest 配置；去掉 SDK 别名、文档目录和系统字号插件                                                                                                                                                                                                               |
| 构建身份         | `web/build/identity.ts`（含测试）                                               | `build/identity.ts`                               | 原样复制                                                                                                                                                                                                                                                                                       |
| 夹具模式         | `web/build/devFixtures.ts`                                                      | `build/devFixtures.ts` + `src/fixtures/server.ts` | 同样的结构（只在 `vite serve --mode fixtures` 加载、写请求拒绝、缺夹具返回带类型的 404），内容换成公开读接口                                                                                                                                                                                   |
| TypeScript       | `web/tsconfig.json`、`web/e2e/tsconfig.json`                                    | 同名                                              | 去掉 SDK 路径映射                                                                                                                                                                                                                                                                              |
| ESLint、Prettier | `web/eslint.config.js`、`.prettierrc.json`、`.prettierignore`                   | 同名                                              | 规则不变，忽略目录按本项目调整                                                                                                                                                                                                                                                                 |
| 测试设施         | `web/src/test/setup.ts`                                                         | `src/test/setup.ts`                               | 原样复制（jsdom 补丁、内存版 localStorage）                                                                                                                                                                                                                                                    |
| Playwright       | `web/e2e/*.config.ts`（webServer、只用 Chromium、关闭 trace/录像）              | `e2e/playwright.config.ts`                        | 改成起夹具模式的开发服务器                                                                                                                                                                                                                                                                     |
| 样式令牌和主题   | `web/src/styles/{tokens,design-platform,effects-typography,scrollbar,base}.css` | `src/styles/`                                     | 调色板原样复制；`tokens.css` 去掉 Agent Workspace 令牌和不用的字体，只保留 Geist / Geist Mono                                                                                                                                                                                                  |
| 深浅色主题       | `web/src/theme/appearance.ts`（含测试）、`index.html` 里的首帧脚本              | `src/theme/appearance.ts`、`index.html`           | 存储键改成 `metaverse:appearance`，标签改中文；测试照样直接运行 `index.html` 里的脚本核对                                                                                                                                                                                                      |
| 路由写法         | `web/src/routing/routes.ts`                                                     | `src/routing/routes.ts`                           | 同样的手写路由（路径和路由对象往返转换），只有 `/`、`/s/:spaceId`、`/u/:universeId`、`/preview`                                                                                                                                                                                                |
| 错误格式         | CMA 的 RFC 9457 问题文档（`code`、`detail`、`title`）                           | `src/core/api/client.ts`                          | 客户端按同样的格式解析                                                                                                                                                                                                                                                                         |
| nginx            | `web/nginx.conf`                                                                | `nginx.conf`                                      | 保留安全头、带哈希文件永久缓存、入口页不缓存、缺文件不缓存、单页应用兜底；去掉 CMA 各服务的转发（包括根路径的 `/openapi.json`），改成 `/api/` 整体原样转给 `metaverse-api`（接口说明文档是 `/api/openapi.json`，`build/nginx.test.ts` 检查）；`Referrer-Policy` 改成 `no-referrer`（设计 7.2） |

去掉的：所有 agent / 沙箱 / 事件网关 / 文档 / 用量相关的页面、组件和 e2e 检查，NyxID 登录（网站只读、不登录），CMA SDK，品牌图标。

## 目录

```
build/             vite 插件：构建身份、夹具模式
e2e/               Playwright（夹具模式）；png.ts 解码截图，确认画面不是全黑
public/            favicon
src/
  core/            与界面无关的核心代码（node、浏览器、Web Worker 都能跑）
    chunk.ts         区块编码：下标顺序、小端、sha256(0x01‖规范字节)、zlib 存储
    canonicalJson.ts 规范化 JSON 和内容哈希
    shapes/          形状词表 → 网格（全部类型）→ three.js BufferGeometry
    events.ts        更正后的有效事件、T 时刻状态、"现在"模式的状态推进、时间窗、密度、增量合并
    visuals.ts       事件可视化：六种显示方式、路线配对、连接最短路径
    scene.ts         快照 → 场景文档；三种视图的取舍（设计 7.1）；组合摆放
    voxels.ts        重建层 ⊕ 扩展层叠加、可见面网格（按颜色/贴图/玻璃/发光分块）
    api/             公开读接口（设计 8.2）的类型和客户端
  data/            空间数据运行时（与界面框架无关）：提交、按 seq 取快照、回放事件、"现在"模式轮询；React 钩子
  viewer/          three.js 场景、网格后台线程、点选信息面板、事件图标；framing.ts（镜头取景）、labelLayout.ts（锚点标签取舍）
  timeline/        时间轴组件（提交标记、事件密度、播放/暂停/调速、上一个/下一个提交、"现在"）
  space/           空间页、组合页、预览页、页面控件
  fixtures/        夹具：演示前厅、街角花店、组合、草稿预览、贴图和模型生成、夹具接口
```

## 网站实际调用的公开接口

全部是 `GET`，`credentials: omit`、`referrerPolicy: no-referrer`。凭链接查看时带 `Authorization: Share <令牌>`；组合页用组合的分享令牌，并在每个请求（包括区块和资源）上加 `?universe=<组合编号>`。

| 路径                                                                       | 查询参数 / 请求头                    | 什么时候调用                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `/api/public/spaces/{id}`                                                  | （`universe`）                       | 打开空间；组合页的每个成员                                                                 |
| `/api/public/spaces/{id}/timeline`                                         | `from`、`after`（`universe`）        | 打开时按 `nextAfter` 取完；seq 变化时从最后一次提交的时间补拉                              |
| `/api/public/spaces/{id}/snapshot`                                         | `seq`（`universe`）                  | 每个要显示的版本一次（按 seq 缓存）；不调用 `?at=`                                         |
| `/api/public/chunks/{hash}.bin`                                            | （`universe`）                       | 快照里的每个区块（解压并核对哈希）                                                         |
| `/api/public/assets/{hash}.bin`                                            | （`universe`）                       | 扫描 glb（原始视图）、贴图、物件模型、`entityAsset`；读响应流报告下载进度                  |
| `/api/public/spaces/{id}/state`                                            | `at`（`universe`）                   | 回放时按 T（节流 400 毫秒）；进入"现在"模式时取一次 `at=<当前时间>`                        |
| `/api/public/spaces/{id}/events`                                           | `from`、`to`、`after`（`universe`）  | 回放：按 6 小时一段取 T 前后的事件（每次 ≤ 24 小时，按页取完）；进入"现在"模式时取最近一段 |
| `/api/public/spaces/{id}/events`                                           | `since`、`after`（`universe`）       | "现在"模式：`/head` 变了以后增量拉，`since` = 游标 − 5 秒，按编号去重                      |
| `/api/public/spaces/{id}/head`                                             | （`universe`），`If-None-Match`      | "现在"模式每 5 秒一次；304 不处理；`recordedAt` 变了拉事件，`seq` 变了补提交               |
| `/api/public/spaces/{id}/events/density`                                   | `from`、`to`、`bucket`（`universe`） | 时间轴密度；超过 90 天分段取；组合页各成员相加                                             |
| `/api/public/universes/{id}`                                               | `at`                                 | 组合页：回放时按 T（节流 500 毫秒）；"现在"模式每 15 秒                                    |
| `/api/public/previews`                                                     | `Authorization: Preview <令牌>`      | 预览页（`cache: no-store`）                                                                |
| `/api/public/previews/chunks/{hash}`、`/api/public/previews/assets/{hash}` | `Authorization: Preview <令牌>`      | 预览里的全部区块和资源（包括草稿基于的已发布内容）                                         |

客户端里还有 `GET /api/public/universes/{id}/revisions/{seq}`，页面目前不用。

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

**接口数据**：JSON 形状以 `src/core/api/types.ts` 为准（接口服务照着实现），字段名照抄设计第 4、5 节（驼峰）。要点：

- 分页结果是 `{ items, nextAfter }`，`nextAfter` 为 null 表示没有更多；**只以 `nextAfter` 判断有没有下一页**：公开事件接口先按原始记录分页、再做公开投影，一整页都是内部级事件（或内部锚点上的事件）时 `items` 为空而 `nextAfter` 不为 null，网站照样往下翻（`allEvents`、`allTimeline` 共用同一个翻页函数；游标不前进时停，最多 200 页）；
- `GET /api/public/spaces/{id}` 带上全部事件类型 `eventTypes`（显示规则；包括默认内部级的类型，同一类型可以有多个版本），查看器据此可视化事件；
- 事件类型的 `state.value` 是 data 里的点分路径（例如 `party.size`，与接口服务的状态折叠相同；"现在"模式推进状态、本地算状态、标签模板都按同一个 `valueAtPath` 取值，取不到时状态值是 null），`state.clears: true` 表示这类事件清除状态；事件带 `typeVersion` 时按版本选显示规则；
- `state?at=` 的每条状态可以带 `data`（产生该状态的事件的公开字段）和 `typeVersion`，标签模板用它；
- 公开事件是服务端的公开投影：已经应用更正、按每条事件生效的可见级别过滤（事件自己写的 `visibility` 优先，没写才用该 `typeVersion` 版本的 `defaultVisibility`）、只留公开锚点上的事件和公开字段，**不带 `visibility`**。所以网站不再按类型的默认级别过滤（否则默认内部级、写入时显式标成公开的事件会被丢掉），只丢掉显式写了 `visibility: "internal"` 的记录；
- 事件列表可以直接返回更正记录（`corrects`、`retracted`），也可以返回已经应用更正的结果（接口服务是后者）；增量结果里的"撤下"标记是 `{ id, recordedAt, withdrawn: true }`；
- 区域和地块的显示名是 `name`（与 model.rs 一致；旧名 `label` 也认）；
- 组合成员带 `seq`（T 时刻还没有提交时为 null），可以带 `name`；
- 预览响应是快照加 `spaceName` 和 `preview: { draftId, rev, baseSeq, scope?, expiresAt? }`；预览里的全部区块和资源都走预览接口；
- 物件 `props.glass: true` 时按半透明玻璃画（形状词表的材质里没有"玻璃"）；`props.label` 是悬浮标签；
- 扫描的对齐变换 `scan.transform` 是列主序 4×4 矩阵。

## 夹具

`src/fixtures/` 按形状词表写成，贴图（PNG）和模型（glb）都是程序生成的，结果确定：

- **演示前厅**（`demo-lobby`），四次提交：
  1. 导入扫描：只有原始模型。扫描 glb 用重建场景加噪声、破洞生成，内嵌底色贴图（图集），坐标是斜着的扫描坐标，`scan.transform` 把它转回空间坐标；
  2. AI 重建：地砖地面（贴图 `planar`）、墙、玻璃隔断、天花板，木纹办公桌（`box` + `fillet`、贴图 `box` + 色调），旋转体边几（`lathe`），扫掠椅腿的椅子模板（`sweep` + `loft` 靠背）和 3 个实例（其中一把换了颜色，另两把画成 InstancedMesh），布面沙发（`extrude` 圆弧 + 圆角，贴图 `mesh` + 色调），放样花盆（`loft`），条纹灯罩落地灯（贴图 `cylindrical`），弧形正面的前台（`extrude` + 倒角），两个木纹柜子和 8 件杂物（桌上、前台上、地上的小圆角盒）。和真实扫描一样，每个重建出的物体都带锚点（杂物 `clutter-NN`、柜子 `cabinet-NN` 等按处理服务的规则归 `zone`，盒子锚点 = 包围盒覆盖的格子），共 21 个有位置的公开锚点，用来演示标签取舍。这次提交同时带重建层的体素化结果（同一个房间的方块：地砖按扫描颜色逐格取色，方块画法下是马赛克；墙、家具；没有天花板），所以从这一版起有"形状 / 方块"切换；
  3. 虚拟展区：石材平台、草地（顶面贴图）、红砖柱（侧面贴图）、柱顶的灯（发光方块）、玻璃墙，展台（扩展层物件），实体区的地毯（扩展层方块）；
  4. 挪动一把椅子。
- **街角花店**（`demo-florist`）：收银台、六个花桶（模板实例，其中一个换了颜色）、只有 `assetHash` 的花架模型。
- **组合"街角"**（`demo-street`）：修订 1 只有前厅；修订 2 花店加入（转 180°，门对着前厅的门），街道连接两扇门。
- **事件**：营业状态（`label`，空间级锚点）、入座/离座（`highlight` 状态，带一条更正）、出餐（`icon`）、客流（`heat`）、送花（花店 `delivery.sent` 起点 → 前厅 `delivery.arrived` 终点，`path`）、送到后前台摆上花束（`spawnEntity`）、内部级门磁事件 `sensor.door`（10 月 2 日凌晨一连串，公开接口不返回）、店员备注 `staff.note`（类型默认内部级：没写可见级别的那条公开接口不返回，显式标成公开的照样返回）；另有一批相对"现在"的事件，"现在"模式一打开就能看到全部显示方式（其中 2 号座位有人：座位默认不显示标签，有事件状态时显示），花店有一单正在路上（只有起点）。
- **草稿预览**：在前厅最新版本上加一张大理石长椅（新上传的贴图，只能经预览接口读取）和一座喷泉（草稿区块）。

夹具接口故意把分页做小（提交每页 3 条、事件每页 400 条），并检查每次事件查询（时间窗 `[from, to)`）不超过 24 小时、密度不超过 90 天。事件和接口服务一样先按原始记录分页（时间窗按原事件的 `(at, 编号)`，增量按全部记录的 `(recordedAt, 编号)`），再对这一页做公开投影；前厅 10 月 2 日凌晨有 450 条内部级门磁事件（`sensor.door`），这天的第一页是空页。夹具存的是原始记录（`visibility` 只在写入时显式给了才有），公开投影和接口服务一样在夹具接口里做：先应用更正，再按生效的可见级别和公开锚点过滤，`data` 只留公开字段，输出不带 `visibility`、`corrects`；空间信息返回全部事件类型。
