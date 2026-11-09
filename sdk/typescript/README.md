# metaverse 命令行和建造工具包（sdk/typescript）

chrono-metaverse 的本地工作区工具（设计第 10 节）：`metaverse` 命令行 + 给 AI 写建造脚本用的工具包
`@chrono-metaverse/sdk`。从检出的源码使用，不发布到包仓库。

- **工具包**：类型安全地生成高层操作（填充、空心盒、替换、复制区域、新增方块、放物件、锚点）和形状
  （box、cylinder、cone、extrude、lathe、sweep、loft、group、instance），米 / 格互换，常用家具和结构
  （桌、椅、凳、柜台、柜子、书架、墙和门窗洞）。构造时就按服务端的规则校验。
- **本地应用操作**：`metaverse-core/src/ops.rs` 的语义移植到 TypeScript，用 Rust 生成的测试向量
  （`api/crates/metaverse-core/tests/vectors/`）逐条核对区块哈希、记录哈希和影响范围。
- **命令**：`init`、`admin`、`scan`、`pull`、`build`、`dev`、`shot`、`diff`、`check`、`push`、`publish`、`voxelize`。
- **技能说明**：[skills/metaverse-builder/SKILL.md](skills/metaverse-builder/SKILL.md)，`metaverse init` 把它写进工作区。

## 安装

需要 Node 22.18 以上（直接运行 `.ts` 建造脚本靠 Node 自带的类型擦除）。

```bash
cd sdk/typescript
npm ci
npm run build
npm link            # 之后就有 metaverse 命令；不想 link 就用 node <仓库>/sdk/typescript/dist/cli.js
```

`metaverse dev` / `shot` 用网站的构建产物（和线上同一套查看器）：

```bash
cd web && npm ci && npm run build     # 生成 web/dist；dev 默认在 SDK 所在的仓库里找它
```

`shot` 用 Playwright（`playwright-core`）驱动无头 Chromium，软件渲染，不需要显卡。浏览器位置按顺序：
`--browser`、环境变量 `METAVERSE_BROWSER_PATH`、`/opt/pw-browsers/chromium`，都没有时交给 Playwright 自己找。

## 两种调用方式

|        | `nyxid`（默认，线上）                                                                                                                       | `direct`（本地开发和测试）                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地址   | `https://nyx-api.chrono-ai.fun/api/v1/proxy/s/<slug>/<路径>`，slug 默认 `chrono-metaverse`                                                  | `--api`，例如 `http://127.0.0.1:8080`                                                                                                                                       |
| 认证   | `Authorization: Bearer <令牌>`                                                                                                              | 每个请求先 `POST <取令牌地址>`（请求体 `{ sub, orgRole? }`，返回 `{ identityToken, accessToken }`），再带 `X-NyxID-Identity-Token` 和 `Authorization: Bearer <accessToken>` |
| 请求头 | 只发标准头（Authorization、Content-Type、Accept、If-Match、Idempotency-Key、Range），自定义头会被代理丢掉；基准版本放在 If-Match 或请求体里 | 同左，另加身份令牌头                                                                                                                                                        |

**nyxid 模式的令牌**按顺序取第一个有的：

1. `--token <令牌>`；
2. 环境变量 `NYXID_TOKEN`；
3. 环境变量 `NYXID_TOKEN_FILE` 指定的文件；
4. 给了 `--profile <名称>`（或 `metaverse.json` 的 `profile`）时读 `~/.nyxid/profiles/<名称>/access_token`；
5. 否则读 `~/.nyxid/access_token`。

第 4、5 条的文件位置是按 `nyxid login --agent-key --profile <名称>` 推测的，实际不同就用 `NYXID_TOKEN_FILE`。
文件内容可以是令牌原文，也可以是带 `access_token` / `accessToken` / `token` 字段的 JSON。
AI 建造时应当用它自己的 agent key 配置（由人在 NyxID 里审批和限定操作范围），不要用人的登录态。
配置名（`profile`）和 `slug` 只能用 1–64 个字母、数字、`_` 和 `-`，不能拼出别的路径。

**令牌发到哪里（NyxID 地址）**按顺序取第一个有的：`--nyx-base`、环境变量 `METAVERSE_NYX_BASE`、
`metaverse.json` 的 `nyxBase`，都没有时用 `https://nyx-api.chrono-ai.fun`。地址只能是协议、主机和端口
（不带账号密码、路径、查询参数和片段），而且必须是 https。

- `metaverse.json` 里**只能写内置的可信地址**：`https://nyx-api.chrono-ai.fun`、`https://api.nyxid.ai`，
  写别的地址（包括任何 http）时命令直接报错，一个请求都不发。工作区可能来自别人（git 仓库、压缩包），
  命令行还会从上级目录找 `metaverse.json`，不能让工作区决定令牌的去向。注意 `build`、`push`、`dev`
  会执行工作区里的建造脚本，只在你信任的工作区里运行它们。
- 别的 NyxID 地址只能由你自己用 `--nyx-base` 或 `METAVERSE_NYX_BASE` 指定（本机回环地址
  `127.0.0.1`、`localhost`、`[::1]` 可以用 http，方便本地调试）；用了不在可信列表里的地址时，
  命令行会在标准错误里提示令牌的来源和去向（不含令牌本身）。`init --nyx-base` 也只把可信地址写进工作区。

**direct 模式**的设置也可以来自环境变量：`METAVERSE_API_URL`、`METAVERSE_DEV_TOKEN_URL`、
`METAVERSE_DEV_SUB`（默认 `dev-user`）、`METAVERSE_DEV_ORG_ROLE`。

## 工作区

`metaverse init <空间编号>` 创建的普通文件夹（和平台仓库无关）：

```
metaverse.json   工作区配置（见下）
space.json       空间信息、区域、地块、基于哪个 seq
palette.json     方块表
anchors.json     锚点（含内部级）
entities.json    物件
chunks/          拉取的区块（<哈希>.bin，zlib）和清单 index.json
build/main.ts    建造脚本（可以用 git 管理）
assets/          网页用模型等资源缓存
out/             build 的输出：ops.ndjson、result.json、新区块、drafts.json、shots/
.claude/skills/metaverse-builder/SKILL.md   技能说明
tsconfig.json、node_modules/@chrono-metaverse/sdk（指向这份 SDK 的链接，编辑器和脚本里的 import 用）
```

`metaverse.json`：

| 字段                                         | 说明                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `spaceId`                                    | 空间编号                                                                |
| `mode`                                       | `nyxid`（默认）或 `direct`                                              |
| `slug`、`nyxBase`、`profile`                 | nyxid 模式：服务 slug、NyxID 地址（只能是可信地址，见上）、nyxid 配置名 |
| `api`、`devTokenUrl`、`devSub`、`devOrgRole` | direct 模式：接口服务地址、取令牌地址、sub、组织角色                    |
| `webUrl`                                     | 网站地址，拼预览链接 `<webUrl>/preview#t=<令牌>` 用                     |
| `buildScript`                                | 建造脚本，默认 `build/main.ts`                                          |
| `plot`                                       | 默认的目标地块（不给就是实体区）                                        |
| `webDist`                                    | 本地查看器用的网站构建产物目录                                          |

命令行参数（`--mode`、`--api`、`--slug`、`--profile`、`--nyx-base`、`--dev-token-url`、`--sub` 等）覆盖这里的值；`--dir` 指定工作区
（不给时从当前目录往上找 `metaverse.json`）。

## 命令

每个命令加 `--help` 看完整说明；`--json` 输出机器可读的结果。

| 命令                                                                                              | 作用                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metaverse init <空间编号> [目录]`                                                                | 建工作区：配置、示例脚本、技能说明、tsconfig、.gitignore                                                                                                                                                    |
| `metaverse admin create-space <编号> --name <名称> --owner <主体编号> [--owner-kind org\|person]` | 建空间，打印分享令牌（只显示一次）                                                                                                                                                                          |
| `metaverse admin update-space [--name] [--description] [--visibility unlisted\|public --yes]`     | 改名、说明、可见性                                                                                                                                                                                          |
| `metaverse admin rotate-share-token`                                                              | 轮换分享令牌：吊销全部现有令牌（旧链接立即失效），打印新令牌（只显示一次）                                                                                                                                  |
| `metaverse admin set-layout <layout.json>`                                                        | 定义区域和地块（先在本地按 `validate_layout` 的规则检查）                                                                                                                                                   |
| `metaverse admin register-event-type <文件>`                                                      | 登记事件类型                                                                                                                                                                                                |
| `metaverse admin redact-event <事件编号>`                                                         | 抹除事件内容                                                                                                                                                                                                |
| `metaverse scan <文件> [--observed-at] [--transform] [--no-rebuild] [--voxelize]`                 | 分片上传扫描（glb / drc / obj / zip；OBJ 带贴图时把模型和贴图打包成 zip）→ 完成 → 发起 scan_import，显示任务进度；`--transform` 走对齐接口导入，`--asset <哈希> --transform …` 重新对齐；参数在上传前先检查 |
| `metaverse pull [--seq <n>]`                                                                      | 下载快照、区块（按哈希核对）、网页用模型                                                                                                                                                                    |
| `metaverse build [--plot <地块>]`                                                                 | 运行建造脚本，本地作用，写 out/                                                                                                                                                                             |
| `metaverse dev [--port 4321]`                                                                     | 本地查看器，脚本改了自动重建                                                                                                                                                                                |
| `metaverse shot [--views extended,optimized] [--angles front,left,top] [--zoom 3]`                | 无头浏览器截图到 out/shots/，打印路径                                                                                                                                                                       |
| `metaverse diff`                                                                                  | 和拉取的版本对比：区块、物件、锚点、新方块的统计                                                                                                                                                            |
| `metaverse check [--plot <地块>]`                                                                 | 检查改动是否都落在目标范围内；超出时退出码 1                                                                                                                                                                |
| `metaverse push [--plot <地块>] [--message <说明>] [--inline]`                                    | 推成草稿，打印草稿编号、统计和预览链接                                                                                                                                                                      |
| `metaverse publish <草稿编号> [--message <说明>] [--replay]`                                      | 发布草稿（push 记下了草稿的地块和提交说明）                                                                                                                                                                 |
| `metaverse voxelize [--scan <哈希>] [--style] [--remote]`                                         | 本地试跑需要 Docker（只做参数检查和说明）；`--remote` 发起云端任务                                                                                                                                          |

**地块合作方的 agent key**（设计 9.3 的典型配置只开放 `/spaces/{space_id}/plots/{plot_id}/` 下的接口）：
`push --plot` 的上传、草稿、等任务、预览和 `publish` 都只走地块路径；push 开头读空间信息
（`GET /api/v1/spaces/{space_id}`，只为提示时间线是否前进）被拦下时跳过这项提示，发布时服务端照样检查冲突。
`pull` 要用实体区路径的查看接口（空间、快照、区块），这样的 key 需要另外开放这几个只读接口。

典型流程（AI 本地建造）：

```bash
metaverse init front-hall && cd front-hall
metaverse pull
# 编辑 build/main.ts
metaverse build --plot p1
metaverse shot --plot p1          # 看 out/shots/*.png 自查
metaverse check --plot p1
metaverse push --plot p1          # 把预览链接交给人
metaverse publish <草稿编号>      # 人确认后
```

## 建造脚本

```ts
import type { BuildBase, Kit } from '@chrono-metaverse/sdk';

export default function build(base: BuildBase, kit: Kit) {
  const { place, table, chair } = kit;
  const [x, y, z] = base.target.origin ?? [0, 0, 0];
  return {
    message: '放一张桌子',
    ops: [
      place('table-01', table({ at: [x + 1, y, z + 1] }), { label: '1 号桌' }),
      place('chair-01a', chair({ at: [x + 1, y, z + 0.45] })),
    ],
  };
}
```

- 第一个参数是拉取的基础状态（区域、地块、锚点、物件、方块表、`target` 目标范围、`blockAt`、`block(名称)` 等），
  第二个参数是工具包（也可以 `import { … } from '@chrono-metaverse/sdk'`，工作区里有指向 SDK 的链接）。
- 返回操作数组（可以嵌套，`null` / `false` 跳过）或 `{ message, ops }`，可以是 Promise。`message` 是提交说明：
  push 把它记进 `out/drafts.json`，publish 时作为提交说明发出（`--message` 优先）。
- 每次 build 都从基础状态重新生成，编号保持稳定，重复运行只会更新、不会堆出重复内容。
- 坐标、方块表、范围规则、形状要点和建造规范见技能说明。

## 用到的接口（与接口服务核对过）

命令行用到的路径和字段集中写在 `src/transport/api.ts`，与接口服务的实现（`api/crates/metaverse-api/src/routes/`，
说明见 `api/README.md`）逐项核对过。接口服务的请求体都**拒绝未知字段**（多一个字段就 422），所以命令行只发下表里的字段。
`{范围}` 是 `/api/v1/spaces/{space_id}`（实体区）或 `/api/v1/spaces/{space_id}/plots/{plot_id}`（地块）。

| 用途         | 请求                                                            | 请求体                                                                                                                                                               | 响应（命令行读取的字段）                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空间信息     | `GET /api/v1/spaces/{space_id}`                                 |                                                                                                                                                                      | `{ id, name, description, visibility, head: { seq, at }, regions, plots, anchors }`                                                                                                                                                   |
| 快照         | `GET /api/v1/spaces/{space_id}/snapshot?seq=`                   |                                                                                                                                                                      | 与公开快照同形：`{ seq, at, paletteHash?, palette: { hash?, blocks }, chunks: [{ layer, cx, cy, cz, hash }], entities: [{ id, hash?, body }], anchors（含内部级）, regions, plots, scan: { assetHash?, webModelHashes, transform } }` |
| 区块         | `GET /api/v1/spaces/{space_id}/chunks/{hash}`                   |                                                                                                                                                                      | zlib 压缩的规范字节                                                                                                                                                                                                                   |
| 资源         | `GET /api/v1/spaces/{space_id}/assets/{hash}`                   |                                                                                                                                                                      | 原始字节；404 时跳过（只用于本地"原始"视图）                                                                                                                                                                                          |
| 任务         | `GET {范围}/jobs/{job_id}`                                      |                                                                                                                                                                      | `{ id, kind, status: queued\|running\|done\|failed, attempt, maxAttempts, lastError?, resultCommitId?, result? }`；地块路径只看得到经这个地块路径发起的任务                                                                           |
| 建上传       | `POST {范围}/uploads/{purpose}`                                 | `{ size, sha256, partSize, format }`，format 按用途：scan、model `glb\|drc\|obj\|zip`，texture `png\|jpeg\|webp`，ops `ndjson\|gzip`，script `text`                  | 201 `{ uploadId, status: "open", partCount, … }`；内容已存在时 200 `{ uploadId, status: "done", reused: true, assetHash }`                                                                                                            |
| 传分片       | `PUT {范围}/uploads/{purpose}/{upload_id}/parts/{n}`            | 原始字节，`n` 从 **0** 开始，除最后一片外大小 = partSize；第 0 片按 format 核对文件头（不符 422 `format_mismatch`）                                                  | 回执                                                                                                                                                                                                                                  |
| 完成上传     | `POST {范围}/uploads/{purpose}/{upload_id}/complete`            | `{}`（服务端不读）                                                                                                                                                   | 202 `{ uploadId, status, jobId }`（upload_verify 任务）                                                                                                                                                                               |
| 导入扫描     | `POST /api/v1/spaces/{space_id}/scans`                          | `{ assetHash, observedAt?, rebuild, voxelize }`（没有 transform）                                                                                                    | 202 任务（`id`）；完成后 `result.needsAlignment / proposedTransform / errorCm`                                                                                                                                                        |
| 按变换导入   | `POST .../scans/{scan_id}/alignment`                            | `{ transform, observedAt?, rebuild, voxelize }`：给了 `--transform` 就走这里（首次导入或重新对齐都一样，只要求资源已校验）                                           | 202 任务（`id`）                                                                                                                                                                                                                      |
| 体素化       | `POST .../scans/{scan_id}/voxelize`                             | `{ style? }`                                                                                                                                                         | 202 任务（`id`）                                                                                                                                                                                                                      |
| 建草稿       | `POST {范围}/drafts`                                            | `{ baseSeq }`（只有这一个字段；提交说明在发布时给）                                                                                                                  | 201 `{ id, scope, baseSeq, rev, … }`                                                                                                                                                                                                  |
| 批量操作     | `POST {范围}/drafts/{draft_id}/ops`                             | `{ ops }`（每次 ≤ 200 条、≤ 1MB；`--inline` 时用）                                                                                                                   | 草稿                                                                                                                                                                                                                                  |
| 从上传应用   | `POST {范围}/drafts/{draft_id}/ops-from-upload`                 | `{ uploadId }` 或 `{ assetHash }` 二选一（两个都给 422；命令行有上传编号就只发它）；文件是 NDJSON，一行一个操作                                                      | 202 `{ jobId, draftId, status }`（ops_from_upload 任务）                                                                                                                                                                              |
| 预览         | `POST {范围}/drafts/{draft_id}/preview`                         | `{ ttlSeconds? }`（60–604800 秒，默认 86400；`--preview-ttl` 在建草稿之前先检查）                                                                                    | 201 `{ token, url, rev, expiresAt }`，链接 = `url` 或 `<webUrl>/preview#t=<token>`                                                                                                                                                    |
| 发布         | `POST {范围}/drafts/{draft_id}/publish`                         | `{ message?, replay? }`；不给 `--message` 时用 push 记在 `out/drafts.json` 里的说明（≤ 2000 字，本地先检查）                                                         | `{ commitId, seq, at, draftId }`；409 `draft_conflict` 时读 `conflicts`                                                                                                                                                               |
| 建空间       | `POST /api/v1/admin/spaces`                                     | `{ id, name, description?, owner: { kind, id }, visibility? }`                                                                                                       | 201 `{ space, shareToken: { id, token } }`                                                                                                                                                                                            |
| 改空间       | `PATCH /api/v1/admin/spaces/{space_id}`                         | `{ name?, description?, visibility?, confirmPublicHistory? }`；改成 public 时（命令行要求 `--yes`）带 `confirmPublicHistory: true`，否则 409 `confirmation_required` | 修改后的空间（SpaceView 本身，不是 `{ space }`）                                                                                                                                                                                      |
| 轮换分享令牌 | `POST /api/v1/admin/spaces/{space_id}/share-tokens`             | 无（服务端不读请求体，总是吊销全部现有令牌）                                                                                                                         | 201 `{ id, token }`（顶层，原文只返回这一次；缺 token 时命令行报错）                                                                                                                                                                  |
| 区域和地块   | `PUT /api/v1/admin/spaces/{space_id}/layout`                    | `{ baseSeq, regions, plots, message? }`                                                                                                                              | `{ commitId, seq, at }`                                                                                                                                                                                                               |
| 事件类型     | `POST /api/v1/admin/spaces/{space_id}/event-types`              | `{ type, schema, publicFields?, defaultVisibility, state?, maxAgeSec?, display }`                                                                                    | 201 `{ type, version, … }`                                                                                                                                                                                                            |
| 抹除事件     | `POST /api/v1/admin/spaces/{space_id}/events/{event_id}/redact` | 无（服务端不读请求体）                                                                                                                                               | `{ id, redacted, records }`                                                                                                                                                                                                           |

错误按问题文档（`code`、`detail`、`title`）解析。GET 和 PUT 遇到网络错误、5xx、429 自动重试 3 次。

## 开发

```bash
npm run lint && npm run typecheck && npm run format:check && npm test && npm run build
npm run test:coverage
```

- 跨语言向量：`tests/vectors.test.ts` 读 `api/crates/metaverse-core/tests/vectors/`（区块、规范化、形状）和
  `vectors/ops/`（操作），目录不存在时跳过，也可以用 `METAVERSE_VECTORS_DIR` 指定。操作向量由
  `api/crates/metaverse-core/tests/ops_vectors.rs` 生成，格式见 `vectors/README.md` 第 4 节。
- 接口调用的测试用本地假服务器（`tests/helpers/fakeApi.ts`），按接口服务的路径和字段回答：和接口服务一样拒绝未知字段和缺少的
  必填字段（422），核对上传格式的白名单和第 0 片的文件头，经地块路径只看得到本地块的任务，还能按路径前缀模拟 NyxID 的操作范围。
