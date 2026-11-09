# 建造教程：用 Claude Code / Codex 建造空间

这篇教程写给**建造者**：你要给一个空间装修实体区、在虚拟区的地块上建东西、接入现实数据，或者把几个空间组合起来展示。动手的通常是 AI（Claude Code 或 Codex），你负责给它配权限、看预览、决定发布。

开发平台本身的教程是 [cloud-claude-code-nyxid.md](cloud-claude-code-nyxid.md)；设计依据是 [整体设计](../ARCHITECTURE.md) 第 4、5、9、10、11、12 节。命令行（`metaverse` 命令）正在实现，具体参数以 `metaverse --help` 和 `sdk/typescript` 的说明为准，本文按设计第 10 节写流程。

读完你会：

1. 给 AI 配一把只能做指定事情的 NyxID agent key；
2. 选对建造方式：小改动直接用 AI 工具，大改动走本地建造；
3. 跑通 `metaverse` 的一整轮：init → pull → build → dev → shot → check → push → 预览 → publish；
4. 往空间写现实事件；
5. 把几个空间组合成一个展示。

---

## 1. 先认识几个词

| 词 | 意思 |
|---|---|
| 空间 | 一个独立的世界，有自己的坐标系，比如"餐厅"、"公司前厅"。编号形如 `front-hall` |
| 实体区 / 虚拟区 | 与现实对应、由扫描生成的部分 / 现实中不存在的扩展部分 |
| 地块 | 虚拟区里划出的一块范围（`plot_id`），可以单独授权给某个 agent |
| 图层 | 扫描层（原始模型）、重建层（AI 按扫描轮廓重建的优化模型）、扩展层（人和 AI 的修改） |
| 物件 / 方块 | 扩展层里的两种内容：用形状词表（[SHAPES.md](../SHAPES.md)）描述的模型，和 5 厘米网格上的方块 |
| 锚点 | 现实对象在孪生里的位置：桌号、座位、门、收货台……事件挂在锚点上 |
| 草稿 → 预览 → 发布 | 所有修改先进草稿，生成预览链接，确认后发布成一次提交 |
| 时间线 | 每次发布和每条事件都按时间记录，网站可以回放到任意时刻 |

网格单位是 5 厘米，只用于定位和划边界；物件几何用连续坐标，不吸附到网格。

---

## 2. 给 AI 配一把 agent key（必须做）

**为什么**：AI 如果用你的登录态（例如 claude.ai 上的 NyxID 连接器），就拥有你在 NyxID 里的全部权限。给它一把 agent key，它就只能做你允许的事；本服务只认 NyxID 的身份，不另发钥匙（设计第 9 节）。

### 2.1 一个 agent 一把 key，范围在人手里

- 每个 agent（本机的 Claude Code、云端会话、Codex、收银系统……）用一把独立的 key（`nyxid_ag_` 开头）。
- 创建、设置范围、轮换、吊销都只能由**人**登录 NyxID 后操作。agent 不能给自己扩权。
- 能限制的：
  - **服务范围**：只允许访问 `chrono-metaverse`，其他服务一律不给；
  - **操作范围**：允许哪些接口（方法 + 路径），路径参数取什么值（`space_id = front-hall`、`plot_id = p1`、`source = pos`），请求体字段取什么值（例如事件类型）；
  - **有效期**：建议 30 天，用完就让它过期。

典型配置（设计 9.3）：

| agent | 操作范围 |
|---|---|
| AI 装修实体区 | 查看接口；`/spaces/front-hall/drafts` 下的建草稿、批量操作、"从上传应用操作"、预览，以及上传接口；**不含**发布（由人发布） |
| 地块合作方或它的 AI | `/spaces/front-hall/plots/p1/` 下的全部接口，含发布 |
| 收银数据源 | 只有 `POST /spaces/front-hall/sources/pos/events`，事件类型限定 |
| 店员分析脚本 | 只有查看接口 |

> 前提：按路径参数和请求体限制，需要本服务注册成 NyxID 的**目录服务**，并为配置的人打开"操作范围"开关（`assistant:operation-scopes`）。这两件事要找平台管理员（设计 9.6）。没做之前，key 只能按服务范围限制，等于能调本服务的全部写接口——此时只把 key 交给可信的 agent，并且让发布始终由人来做。

`/api/v1/admin/*`（建空间、轮换分享令牌、定义地块等）不要放进任何 agent key 的操作范围。

### 2.2 在 AI 的机器上登录（人审批）

在 AI 运行的那台机器上（你的电脑，或云端会话的容器里）执行：

```bash
# 没装 nyxid 的话先装（只装客户端）
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ChronoAIProject/NyxID/main/skills/nyxid/scripts/install.sh)"

nyxid login --agent-key --profile metaverse-builder \
  --key-name "前厅装修 Claude Code" --platform claude-code --expiry-days 30
```

- 命令会打印一个审批链接和一个**单独的**验证码。你在浏览器或 NyxID 手机 App 里打开链接，**手动输入**验证码，核对请求来自你的这台机器（不一致就拒绝），然后选已有的 key 或新建一把，确认它的服务范围和操作范围。
- 让 AI 自己执行这条命令时，它应该把链接和验证码分别告诉你，自己不去审批。Codex 用 `--platform codex`。
- 审批后，凭证只保存在这台机器的 `~/.nyxid/profiles/metaverse-builder/`。NyxID 服务端只存哈希，本服务完全接触不到 key。
- 不要把 key 贴进对话、写进仓库或环境变量文件。

确认能用（返回空间信息，或空间不存在时的 404）：

```bash
nyxid proxy request chrono-metaverse api/v1/spaces/front-hall --profile metaverse-builder --output json
```

### 2.3 在 Claude Code 里用这把 key

两种方式任选：

- **命令行方式**（推荐）：AI 用 `nyxid proxy request chrono-metaverse <路径> --profile metaverse-builder`（也可以设环境变量 `NYXID_PROFILE=metaverse-builder`）调接口；`metaverse` 命令行也用这个配置（具体参数见命令行说明）。
- **MCP 方式**：在 Claude Code 的 MCP 配置里，用 `x-api-key` 请求头带上 agent key 接 NyxID 的 MCP 地址（`https://nyx-api.chrono-ai.fun/mcp`）。NyxID 的 MCP 入口只从这个头读 agent key。这样 AI 看到的 `chrono-metaverse__*` 工具就只限于操作范围内的接口。

注意：claude.ai 网页上配置的 NyxID 连接器用的是**你的**身份。云端会话里如果同时有连接器，要明确告诉 AI 写操作只用 agent key 的配置。

### 2.4 轮换和吊销

都在 NyxID 网页的 key 详情页做：吊销某台机器的登录凭证（只影响那台机器），或者轮换、吊销整把 key（所有登录凭证一起失效）。AI 机器上执行 `nyxid logout --profile metaverse-builder` 只撤销它自己的那份凭证。

---

## 3. 两种建造方式

| | 只用 AI 工具（不装任何东西） | 本地建造 |
|---|---|---|
| 适合 | 小改动：几个盒子、移动锚点、写几条事件 | 大量建造、复杂物件、扫描处理调参 |
| 做法 | AI 直接调用"建草稿""批量操作"等工具 | AI 写建造脚本，脚本生成操作文件，由命令行上传 |
| 自查 | 你看预览链接 | AI 本地截图自己看，你再看预览链接 |
| 上限 | 每次批量操作 ≤ 200 条、请求体 ≤ 1MB | 操作文件分片上传，没有这个限制 |

工具参数是 AI 逐字写出来的，几千条操作无法通过工具参数传递，所以**大改动一定走本地建造**。

### 3.1 只用 AI 工具

在接了 NyxID MCP 的 Claude Code 里，直接用中文说要做什么，例如：

> 用 chrono-metaverse 的工具，在空间 front-hall 的地块 p1 上放一张 1.2 米 × 0.6 米的木纹桌子，桌面高 0.75 米，靠近地块北边；建草稿、加操作、生成预览，把预览链接给我，不要发布。

AI 的调用顺序大致是：

1. `nyx__search_tools` 搜 `chrono-metaverse`，找到工具（名字由接口的 `operationId` 生成，例如 `chrono-metaverse__get_space`）；
2. 查看空间：区域、地块、锚点和最新 seq；
3. 建草稿（实体区走 `/spaces/{space_id}/drafts`，地块走 `/spaces/{space_id}/plots/{plot_id}/drafts`）；
4. 批量操作：填充、空心盒、替换、复制区域、新增方块、放物件、新建 / 移动 / 修改锚点；服务端会检查每个操作都落在该地块或实体区内；
5. 生成预览，把链接给你；
6. 你确认后发布（地块 key 可以自己发布；实体区建议由人发布）。

### 3.2 本地建造

见下一节。

---

## 4. `metaverse` 命令：一整轮本地建造

工作区是你电脑（或云端会话）上的一个普通文件夹，和平台仓库无关。你不需要改平台代码，所有修改都经接口提交。

### 4.0 安装

命令行在平台仓库的 `sdk/typescript`，第一步只在组织内部使用、不发布到 npm。按那里的说明安装（构建后链接成全局的 `metaverse` 命令）。还需要 Node 22；截图用无头浏览器，不需要显卡。

### 4.1 init：建工作区

```bash
metaverse init front-hall
cd front-hall
```

生成的结构（设计 10.1）：

```
front-hall/
  space.json      空间信息、区域、地块、基于哪个 seq
  palette.json    方块表
  anchors.json    锚点
  entities.json   物件
  chunks/         拉取下来的区块
  build/          建造脚本（可以用 git 管理）
  assets/         网页用模型、贴图缓存
  .claude/skills/metaverse-builder/       给 AI 的建造技能说明（坐标约定、方块表、地块规则、建造规范、示例）
  .claude/skills/metaverse-reconstruct/   给 AI 的重建技能说明（扫描过的实体空间：先搜模型库、搜不到再手写，
                                          见[重建教程](reconstruct-with-ai.md)）
```

让 Claude Code 在这个目录里工作，它会读到技能说明。

### 4.2 pull：拉取当前状态

```bash
metaverse pull
```

下载空间的当前版本到工作区，并记下基于哪个 seq。

### 4.3 build：运行建造脚本

AI 把建造逻辑写在 `build/` 里。脚本每次都**从拉取的基础状态重新生成**全部操作（放物件、填方块、改锚点），所以可以反复改、反复运行，不会越叠越多：

```bash
metaverse build
```

写脚本的规矩（技能说明里有完整版）：

- 坐标单位是米，物件用形状词表（`box`、`cylinder`、`extrude`、`lathe`、`sweep`、`loft`、`instance`……），带 `transform` 和材质；
- 同款物件（比如一排椅子）先定义成模板，再放实例；
- 地块里的建造只能落在地块范围内，实体区的建造只能改实体区。

### 4.4 dev：本地查看器

```bash
metaverse dev
```

打开本地查看器（和网站同一套代码），脚本改了自动刷新。三种视图都能切换：原始 / 优化 / 优化 + 扩展。

### 4.5 shot：截图自查

```bash
metaverse shot
```

在本地用无头浏览器软件渲染出图。AI 直接看图检查：比例对不对、有没有穿模、颜色是否协调，再改脚本。截图不上传，云端也不做渲染。

### 4.6 check / diff：提交前检查

```bash
metaverse diff     # 和拉取时的版本对比：新增、修改、删除了什么
metaverse check    # 检查改动是否都落在目标地块或实体区内
```

`check` 不通过就不要推送，服务端也会拒绝越界的操作。

### 4.7 push：生成草稿和预览

```bash
metaverse push               # 实体区
metaverse push --plot p1     # 地块
```

命令行把操作写成文件 → 分片上传 → 调"从上传应用操作"生成草稿 → 打印草稿编号、统计和**预览链接**。

**冲突**：如果别人在你拉取之后发布过，推送会提示冲突。做法是重新 `pull` → `build` → `push`，脚本会在最新状态上重新生成。

### 4.8 预览

打开 push 打印的预览链接，在网站上看草稿的效果。预览链接是临时的，过期作废；预览不会进入时间线。

### 4.9 publish：发布

```bash
metaverse publish <草稿编号>
```

发布后就是时间线上的一次提交，所有人（凭分享链接）都能看到，也能回放到发布前。所用 agent key 的操作范围要包含发布接口；实体区的改动建议由人用自己的身份发布。

已发布的数据只追加、不修改：发现问题就再建一个草稿改回来。

### 4.10 其他命令

| 命令 | 作用 |
|---|---|
| `metaverse bundle check` / `metaverse bundle push` | 重建层（扫描、结构、物体）在本地用 `metaverse-recon` 做成重建包，`bundle check` 先在本地检查，`bundle push` 经 `/rebuild/` 路径上传、交包、生成预览；要求令牌带 `metaverse:rebuild:write`（见 `sdk/typescript/README.md`、[`docs/design/server-slim.md`](../design/server-slim.md) 第 6 节）。原来的 `metaverse scan`、`rebuild`、`voxelize` 已删除 |
| `metaverse pull --scan` / `--share <分享链接>` | 另外下载原始扫描和它的变换（本地重建用，分段下载、能续传）；或者不经 NyxID 只读公开快照 |
| `metaverse admin …` | 管理命令：建空间、轮换分享令牌、定义区域和地块、登记事件类型、抹除事件。要求"管理"级别（空间主人、组织本身或组织 admin），用人的身份执行，不交给 agent key |

---

## 5. 写事件（接入现实数据）

现实中发生的事（入座、出餐、送达、营业状态）挂在锚点上，按时间进入时间线，网站可以回放，也有"现在"模式。

### 5.1 先准备

1. **登记事件类型**（空间管理员）：类型名、公开字段、显示规则、是否状态类事件。没登记的类型会被拒绝。
2. **建锚点**：事件要挂在已有的锚点上（桌号、收货台……），锚点可以在草稿里新建。
3. **给数据源一把 agent key**：主人是店方组织，操作范围只允许自己那个数据源的事件接口，并限定事件类型（第 2 节）。

### 5.2 写入

```
POST /api/v1/spaces/{space_id}/sources/{source}/events
```

- 一批最多 1000 条；
- 每条带数据源自己的事件编号 `sourceEventId`：服务端按"空间 + 数据源 + 事件编号"去重，网络失败可以放心重试，轮换 key 也不影响去重；
- 数据源由路径里的 `{source}` 决定，请求体里不能另填；
- 事件时间 `at` 可以晚到，但不能是未来时间。

用 agent key 调用的样子（请求体字段以 `https://<应用域名>/api/openapi.json` 为准）：

```bash
nyxid proxy request chrono-metaverse --profile pos-source \
  api/v1/spaces/front-hall/sources/pos/events --method POST --output json --data '{
    "events": [
      {"sourceEventId": "order-20261109-0042", "type": "table.seated",
       "anchorId": "table-07", "at": "2026-11-09T12:03:00.000Z", "data": {"guests": 3}}
    ]
  }'
```

### 5.3 更正和撤回

录错了不能改原记录，追加一条更正或撤回：

```
POST /api/v1/spaces/{space_id}/sources/{source}/corrections
```

更正指向最初那条事件；回放时按更正后的结果显示。

### 5.4 隐私

只发结构化事件（某桌有人、几个人），不发画面、不发个人信息。事件分公开和内部两级，公开接口只返回事件类型登记的公开字段。

---

## 6. 组合空间

多个空间（餐厅、花店……）可以拼在一个组合里展示，跨空间事件（送花）同步回放（设计第 12 节）。

### 6.1 创建和摆放

| 操作 | 接口 | 谁能做 |
|---|---|---|
| 创建组合 | `POST /api/v1/universes` | 组织成员；创建者是组合主人 |
| 摆放、连接、可见性、分享令牌 | `PATCH /api/v1/universes/{universe_id}` | 组合主人 |
| 把空间加入组合 | `POST /api/v1/universes/{universe_id}/members/{space_id}` | **该空间的主人**（或主人组织的 admin、组织本身） |
| 让空间退出 | `DELETE` 同一路径 | 该空间的主人，随时可以 |

- 别人不能把你的空间拉进他的组合；加入组合就等于同意被凭组合链接查看。
- 组合不能比任何成员更公开：有"凭链接查看"的成员，组合也只能凭链接查看。
- 连接两端只能引用公开锚点。
- 加入、退出、摆放修改都记为组合的修订，组合也能回放。

### 6.2 跨空间事件：送花示例

1. 花店在**自己的空间**写一条 `delivery.sent`（路线起点），`correlationId = "<花店空间编号>:<编号>"`；
2. 餐厅收到后在**自己的空间**写一条 `delivery.arrived`（路线终点），用同一个 `correlationId`；
3. 组合视图里从起点锚点画到终点锚点，动画时长取两条事件的时间差。

`correlationId` 的前缀必须是写入空间的编号，所以别的空间伪造不了起点。如果终点也要花店来写，餐厅可以在 NyxID 里建一把组织 agent key 交给花店，操作范围只允许往餐厅的 `florist` 数据源写 `delivery.arrived`，锚点只能是收货台。

### 6.3 查看

组合的分享链接形如 `https://<应用域名>/u/<组合编号>#share=<分享令牌>`；单个空间是 `/s/<空间编号>#share=<分享令牌>`。分享令牌在 `#` 后面，不会随请求发给服务器或外链。

---

## 7. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 调接口返回 401 | 身份令牌没带上或过期；服务还没在 NyxID 注册好 | 确认带了 `--profile <名称>`（或 `NYXID_PROFILE`）或 MCP 配置；找平台管理员核对注册（开发教程 9.3） |
| 返回 404 | 空间不存在，或你没有查看权限（看不到的一律 404） | 核对空间编号；确认 key 的主人是空间主人或主人组织 |
| 返回 403 | 能看不能写：组织 member、viewer 只读 | 用组织的 agent key，或请组织 admin 操作 |
| 返回 503 `org_membership_unavailable` | 用个人身份写组织空间时，查不到你在组织里的角色 | 稍后重试；或改用组织的 agent key（令牌里的主体就是组织，不用查角色） |
| NyxID 直接拒绝请求 | 超出 agent key 的操作范围 | 正常现象：请人调整范围，不要换人的登录态绕过 |
| 推送提示冲突 | 拉取后别人发布过 | `pull` → `build` → `push` |
| 批量操作返回 413 | 超过 200 条或 1MB | 改走本地建造（`metaverse push` 走上传） |
| 预览链接打不开 | 预览过期 | 重新 `push` 或重新生成预览 |
