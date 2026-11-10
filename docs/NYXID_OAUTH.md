# NyxID 用户授权与 Agent 组织访问

Agent 继续使用已有的、绑定服务的 Agent Key。NyxID 校验 Key、服务访问权限和操作范围，再向 metaverse 签发身份令牌。metaverse 根据令牌的 `sub` 找到**同一用户**保存的 OAuth 授权，实时查询该用户在资源所属组织的角色。组织 admin 可管理，member/viewer 只读。

不需要新增 NyxID 鉴权功能，也不需要把另一把“组织 Key”交给 Agent 或存进 metaverse。组织作为资源主人，与 Key 能访问哪些服务是不同的授权维度。

```text
首次连接：
用户浏览器 → /connect → NyxID 授权（Code + PKCE）
                        ↓ 回调、userinfo 核对主体
                 metaverse 加密保存用户 OAuth 凭据

日常调用：
Agent 原有 Key → NyxID（Key / 服务 / 操作范围检查）
                     ↓ 签名身份 sub
                 metaverse（验签、防重放、功能权限）
                     ↓ 按 sub 取同一用户的 OAuth 凭据
                 NyxID /orgs/{资源主人}/authorization
                     ↓ 当前角色
                 metaverse 资源 ACL → 执行业务操作
```

OAuth 默认用于 `/oauth/userinfo`、`/oauth/token`、当前用户的组织列表和组织角色查询。用户在 `/workspace` 明确启用后，当前浏览器还可通过固定 CMA 接口创建、查看和使用本人有权使用的 worker；不增加 OAuth scope，也不开放任意代理。metaverse 业务操作仍以本次 NyxID 签名身份执行。浏览器连接 Cookie 不能认证 `/api/v1/*`。个人资源、组织主体直接访问自己的资源，以及公开/分享链接的原有规则继续生效。

## 网页管理

从首页“连接 NyxID”进入 `/connect`，可完成授权、核对账号编号、实时检查连接、读取并选择自己所属的组织、查询组织角色、重新授权和确认断开。组织列表仅供选择，查询结果及实际 Agent 调用都重新核验组织角色。页面区分“授权已保存”和“连接有效”；网络或服务故障不会被显示成“没有组织权限”。页面适配手机并可滚动阅读授权用途与权限边界。

| 接口 | 用途 |
|---|---|
| `GET /api/auth/nyxid/session` | 本浏览器的保存状态、已核验账号编号及 CSRF 令牌；不代表 provider 实时有效性 |
| `POST /api/auth/nyxid/check`，请求 `{}` | 读取同主体凭据，必要时刷新，再通过 userinfo 实时核验账号 |
| `POST /api/auth/nyxid/check`，请求 `{"orgId":"组织编号"}` | 实时核验连接及指定组织角色，返回资源访问级别；不签发业务凭据 |
| `POST /api/auth/nyxid/organizations` | 读取当前连接账号所属组织，仅返回编号、名称和角色，不转发联系邮箱等字段 |
| `POST /api/auth/nyxid/disconnect` | 确认后删除本部署授权凭据，失效该授权实例的浏览器会话 |

上述 POST 接口均要求本浏览器有效会话、同源 `Origin` 和会话绑定的 `x-csrf-token`。账号始终取服务端会话，不接受网页指定其他账号或任意 provider URL；查询完成后复核授权版本，不能越过并发断开或重新授权。浏览器不会收到 OAuth 访问令牌、刷新令牌或客户端秘密。

OAuth 回调成功后返回 `/connect?connected=1`；取消、过期、provider 故障和未启用分别返回固定错误标记，网页显示恢复入口。回调参数、授权码、state 和 provider 错误原文均不转发到网页；标记显示后从浏览器当前地址移除。断开仅影响本部署保存的授权，如需远端撤销，页面提供 NyxID 入口。

## 配置

在 NyxID 注册一个专用于此部署的**保密 OAuth 客户端**，支持 `authorization_code`、`refresh_token`、PKCE S256、`client_secret_post`，允许 scopes `openid offline_access`。不用为这个客户端授予业务服务的代理访问范围；它不代理业务请求。现有 NyxID 的普通用户组织查询接口以用户身份判定成员权限，不要求新增组织 scope。此结论根据 NyxID 源码核对；实际部署仍需完成下文的线上验收。

`openid offline_access` 是当前申请的最小 scope 集合，但 NyxID 现有普通用户组织接口没有“仅查询角色”的专用 scope。组织查询及用户明确启用后的固定 CMA 操作是 metaverse 的代码使用边界，不代表 provider 已将令牌硬限制到这些接口；令牌仍须按敏感用户凭据保护，其他接口能否接受它取决于各服务路由的身份、scope 及资源检查。

回调地址必须精确注册为：

```text
https://chrono-metaverse-chronoai.apps.nyxid.ai/api/auth/nyxid/callback
```

给 `metaverse-api` 配置以下变量，web 和 worker 不需要这些秘密：

| 变量 | 内容 |
|---|---|
| `PUBLIC_BASE_URL` | 实际站点根地址；生产必须 HTTPS，本机开发可用 HTTP |
| `NYXID_OAUTH_CLIENT_ID` | 新注册的 OAuth 客户端 ID，不是 NyxID 服务连接 ID |
| `NYXID_OAUTH_CLIENT_SECRET` | 客户端秘密，放 chrono-cd 应用密钥 |
| `NYXID_OAUTH_ENCRYPTION_KEY` | 32 字节随机密钥的标准 base64 编码，放 chrono-cd 应用密钥 |

加密密钥可用 `openssl rand -base64 32` 生成，保存在密码管理器中，不提交仓库。所有 API 副本必须使用相同的配置和密钥。备份数据库时需另行备份密钥；替换或丢失密钥后，原密文无法读取，用户需重新连接。当前没有在线密钥轮换机制。

三个 `NYXID_OAUTH_*` 变量全部缺省时功能关闭，`/connect` 显示未启用；只配部分变量会启动失败。ChronoAI 的 OAuth 客户端 ID 为 `be885bc0-94fd-4a30-bb5e-613723cd0eef`，当前 `app.json` 已声明两个秘密。迁移到其他部署时需注册自己的客户端；启用时，在**当前部署规格**的 `services.metaverse-api.env` 增加客户端 ID，在该服务的 `secret_keys` 中保留原有项并增加两个秘密的名字，再通过 chrono-cd 的应用密钥接口设置它们。不要用旧规格覆盖当前镜像或其他配置。

应用密钥请求体为：

```json
{
  "NYXID_OAUTH_CLIENT_SECRET": "<客户端秘密>",
  "NYXID_OAUTH_ENCRYPTION_KEY": "<32 字节随机密钥的 base64>"
}
```

从自己电脑的临时文件提交，避免将秘密粘贴到对话或命令行历史：

```bash
# /安全临时目录/oauth-secrets.json 权限为 0600，不在仓库内
nyxid proxy request chrono-cd "$APP/services/metaverse-api/secrets?org_id=$ORG" \
  --method PUT --data @/安全临时目录/oauth-secrets.json --output json
```

`APP`、`ORG` 的设置及更新规格的方法见 [chrono-cd 部署说明](../infra/chrono-cd/README.md)。上线需同时更新 API 和 web 镜像，随后让每位需要组织访问的用户在 `/connect` 授权一次，使用与其 Agent Key 相同的 NyxID 账号。

## 凭据生命周期与边界

- OAuth 使用随机 state、独立浏览器绑定 Cookie、一次性流程记录和 PKCE。回调以 provider 的实时 userinfo 核对主体，不信任浏览器传入的用户编号或未验证的 ID token。
- `oauthGrants` 仅保存 AES-256-GCM 密文，密文绑定部署、签发方、客户端、主体、授权实例和版本。`oauthFlows` 的 PKCE verifier 也加密；流程和浏览器会话标识只存哈希。流程 10 分钟、浏览器会话 30 天，数据库 TTL 索引负责回收，读取时仍检查实际过期时间。
- Cookie 为 HttpOnly、SameSite=Lax，HTTPS 部署加 Secure，限制到 `/api/auth/nyxid`；浏览器拿不到 access/refresh token。浏览器会话过期不会自动取消 Agent 使用的授权；可重新连接后断开，或在 NyxID 撤销该应用授权。
- 访问令牌即将过期时刷新，数据库 60 秒租约避免不同副本同时轮换。刷新任务在调用请求取消后继续落库；刷新和重新连接/断开之间以版本条件更新。userinfo 暂时失败时，轮换结果会加密保留，但核对主体成功前不可使用。凭据被撤销或主体不符时本地授权失效。进程崩溃或数据库在轮换后持续不可写，仍可能需要重新连接。
- 有显式转发 Bearer 时优先使用它，失败不回退到保存的 OAuth；无转发凭据时才查同一 `sub` 的授权。无效或重复的 Authorization 头直接拒绝。收到的 Agent Key 原文不会被持久保存。
- 组织角色每次实时查询，不缓存成员权限；查询结束再次核对授权版本。断开后，尚未通过这项核对的查询会被拒绝；已经取得资源授权并开始执行的操作不会被回滚。服务访问、路径/输入限制和审批仍由 NyxID 在转发前执行。
- 断开要求同源 Origin 和会话绑定的 CSRF 令牌，会删除本地密文、失效相关浏览器会话。它不调用 NyxID 的全局登出或远端撤销接口；如需同时撤销 provider 侧授权，请在 NyxID 中撤销此应用。
- API Trace 和网站 nginx 访问日志不记录查询参数、请求头或令牌。CD 的 `/api` 入口直接到 API，需确认外层 ingress、CDN 和日志采集也不记录 OAuth 回调查询参数。

性能上，保存授权路径相对直接转发凭据多两次数据库读取（取密文、查询后核对版本），正常仍只有一次 NyxID 组织角色请求；刷新或恢复待核对凭据时增加 token/userinfo 请求。组织查询整体 15 秒截止，失败时读取按不可见返回 404，写入返回 503 `org_membership_unavailable`。未连接、已断开时不会放宽资源权限。

## 验证

本地集成测试使用真实 MongoDB 副本集和模拟 NyxID provider，覆盖浏览器绑定/重放、PKCE、密文存储、同主体访问、实时角色降级/移除、显式凭据优先、跨副本刷新、主体不符、刷新拒绝和暂时故障、请求取消、断开与刷新/查询竞争、旧会话不能撤销新授权。命令见 [API README](../api/README.md)。

线上启用后验证：`GET /api/auth/nyxid/session` 返回 `enabled:true`；用户连接后，以原有 Agent Key 经 NyxID MCP 读取组织空间；另一用户未连接时不可借用此授权；断开后再次读取被拒绝。功能权限和 Key 操作范围的拒绝行为也应与之前一致。这些线上检查不能用本地模拟测试替代。

## ChronoAI 部署记录（2026-11-10）

- 应用：`metaverse / chrono-metaverse`，chrono-cd 修订 `10`；源码提交 `d7674fb00e9c67a3a4344f2ddb30ba753318b747`。
- [构建运行](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42825482374) 生成的 API/web 镜像按摘要固定在 `infra/chrono-cd/app.json`；保留原有双服务、数据库和资源配置。
- OAuth 客户端归 ChronoAI 组织，客户端秘密和加密密钥已通过 chrono-cd 应用密钥接口设置。
- 已在线核对：所有新副本就绪、`session` 返回 `enabled:true`、`/connect` 正常、授权跳转包含正确客户端/回调/PKCE、Cookie 为 Secure/HttpOnly/SameSite=Lax、无签名身份业务请求返回 401、无效回调拒绝且不缓存、原有 OAuth 代理可读取 `chronoai-lobby`。
- 尚需用户实际登录并同意 `/connect` 授权，才能在线验收“Agent 使用同一用户保存的授权访问组织空间”的完整链路；不将匿名入口检查当作此链路已通过。

## 网页管理部署记录（2026-11-10）

- chrono-cd 修订 `11`；源码提交 `4292d162ea126f956cc3ab5a51812dee985d8feb`，来自 `deploy/nyxid-oauth-20261110` 分支。[Images 运行](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42834883023) 成功，两个镜像按该运行的摘要固定在 `app.json`。
- 仅更新 API/web 镜像及 CD 解析出的镜像摘要；客户端、已有授权、数据库和应用配置沿用。API 单副本和 web 双副本全部更新且就绪。
- 已在线核对：新页面真实渲染、手机布局与滚动、未连接时组织查询不可操作、权限范围说明可展开、回调失败返回固定恢复页面且清理地址参数、点击授权可到 NyxID 登录页；未执行用户同意步骤。
- 新增 `check`、`organizations` 接口对无会话请求返回 401，回调错误和状态响应不缓存；授权跳转仍包含原客户端、最小 scopes、精确回调与 PKCE；业务接口仍拒绝未签名请求，既有 NyxID OAuth 代理仍能读取 `chronoai-lobby`。
- 连接后的账号检查、组织列表和角色查询、断开流程已通过本地真实 MongoDB + 模拟 NyxID 的集成测试及桌面/手机浏览器测试。线上完整连接链路仍需用户以与 Agent Key 相同的账号授权后验收。


## 在线 CMA worker 工作台

`/workspace` 提供自然语言委托、准备与执行状态、对话、追加需求、停止当前响应、结果链接及三维预览。查看预览后可明确要求同一 worker 发布。详细规划与权限边界见 [WEB_CONSOLE_PLAN.md](WEB_CONSOLE_PLAN.md)。没有手工编辑方块、坐标或业务 JSON 的控制台。

部署设置 `CMA_BASE_URL`（固定 HTTPS 根地址，生产为 `https://cma.nyxid.ai`）。现有用户 OAuth 客户端继续只请求 `openid offline_access`，不增加 proxy、broker 或 delegation scopes。浏览器会话默认 `workerEnabled:false`，必须通过工作台复选框同意。只允许固定 CMA 操作集合；每次操作要求同源 Origin、CSRF、实时 userinfo、同主体授权和当前浏览器同意版本。在发送前、收到响应头和返回正文前复核；关闭后再次启用也不能恢复旧的在途调用权限。已受理的远端工作无法回滚，关闭网页授权不等于停止 worker。

当前适配器直接把此网页客户端的用户 OAuth access token 交给 CMA。2026-11-11 已确认这个方案对后续命令有兼容缺口：NyxID 为第三方客户端显式写入服务/节点范围元数据，CMA 的独立命令过滤器会拒绝这些字段，即使列表为空；只有身份授权的令牌也不能被升级为执行授权。需要明确允许 CMA 的服务授权及受支持的命令准入方式，详见 [CMA #1638](https://github.com/ChronoAIProject/cma/issues/1638)。首条任务成功不能证明后续命令已经获得授权；当前不能将真实连续聊天记为已验收。CMA 继续校验用户与资源权限。CMA 本身托管 worker 的服务 Agent Key；网页后端不发行或传递 worker key，OAuth 凭据不会进入任务、浏览器存储或 worker 环境。新 worker 请求 `chrono-metaverse`，并由 CMA 添加自己的必需基线；复用已有 worker 不更改其已有服务范围。

| 网页私有接口（均为 POST） | 输入与行为 |
|---|---|
| `/api/auth/nyxid/worker/consent` | `{enabled}`；同意仅绑定当前浏览器和当前 OAuth 授权实例 |
| `…/agents` | `{cursor?}`；个人可访问的 CMA Agent 列表 |
| `…/create` | `{context:{spaceId,orgId?},instruction,idempotencyKey}`；创建 worker，初始任务一次入队 |
| `…/observe` | `{operationId}` 或 `{agentId}`；准备任务或 Agent 状态及对话 |
| `…/message` | `{agentId,context,instruction,idempotencyKey}`；Responses v2 接收头后返回响应与命令编号，断开流不取消任务 |
| `…/response` | `{agentId,responseId}`；响应状态及当前停止控制版本 |
| `…/cancel` | `{agentId,responseId,turnSequence,agentRevision,idempotencyKey}`；使用已观察的并发版本请求停止 |

网页在发送前保存原请求内容与幂等编号至按账号隔离的 sessionStorage；不保存令牌、CSRF 或 provider 诊断。未知结果不自动重试；用户可核对状态后重试同一请求。仅在 CMA 明确返回 `sandbox_credential_setup_required` 时，提供官方 CMA 登录入口，用户完成后显式以新编号重试同一需求。网页不代替用户完成 CMA 的可续期授权。自动状态观察串行、最多 120 次，失败或终态暂停，手动刷新可恢复。

网页取得预览绑定的空间、草稿编号、rev 和 baseSeq 后，发布委托只携带这些非秘密编号与版本，不保存或转发预览令牌至恢复记录。草稿预览链接是短期读取能力，结果链接只保留在当前页面内存。只允许本站 `/preview`、`/s/…`、`/u/…` 查看器地址进入 iframe；模型回复作为文本渲染。先草稿后发布是任务指令，不能视为 NyxID 操作范围的替代。

## 在线工作台部署记录（2026-11-10）

- chrono-cd 修订 `12`；功能源码提交 `1df1a2400e863d078595fe336e0501a5915edccb`，分支 `feat/web-console-20261110`。[CI](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42845299344) 全部成功，[Images](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42845299254) 的 API/web 镜像按摘要部署。
- 部署前后规格逐字段比对，仅更新 API/web 镜像、CD 解析摘要和 `CMA_BASE_URL`；OAuth scopes 仍为 `openid offline_access`。API 单副本、web 双副本全部更新就绪，既有组织空间 `chronoai-lobby` 可继续通过原 NyxID 用户代理读取。
- 已在线核对：`/workspace` 的桌面和手机真实渲染，无脚本错误或横向溢出；匿名状态返回 `enabled:true,connected:false,workerAvailable:true`；无会话的 CMA 同意、创建、观察调用均返回 401 且不缓存；业务 API 继续拒绝未签名请求；OAuth 回调地址、PKCE、Secure/HttpOnly/SameSite Cookie 正确。
- 本地真实 MongoDB + 模拟 NyxID/CMA 的集成测试，以及浏览器测试，覆盖同意、任务创建、异步准备、对话、版本核验、发布委托和断网恢复。线上尚未代替用户完成浏览器同意或创建真实 CMA 任务；首次使用须在网页启用，CMA 要求可续期环境授权时再以同一账号登录其官方页面。
- 后续修订 `13` 仅更新 web 镜像至 `491812f362bcab73718b49102b33cba72b5e0702`，修正连接按钮被通用链接颜色覆盖的问题；API 保留修订 12 的镜像。web 摘要来自该提交的 [Images](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42847921094)，对应 [CI](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42847781315)。最终线上按钮对比度为 `15.55:1`，桌面/手机页面与匿名鉴权检查再次通过；`app.json` 固定最终两份镜像。

## 已有空间与聊天（2026-11-11）

`/workspace` 登录后自动发现当前账号的个人和组织空间。选择空间即可读取已发布场景，不需要分享令牌，也不需要先启用 CMA。空间目录仅返回编号、名称、说明、归属、可见性、更新时间和当前只读/管理级别；每页 40 条，`{after}` 按编号继续。组织信息来自当前用户的实时 NyxID 组织列表，数据库查询按相应主人及一致的组织归属证据过滤，跳过正在删除的空间。

固定只读路径为 `POST /api/auth/nyxid/spaces` 及 `/api/auth/nyxid/view/spaces/{spaceId}` 下的查看器读取。要求当前浏览器会话、同源 Origin、CSRF、实时 userinfo 和资源 ACL；返回公开查看器投影并强制 `no-store`，不暴露内部锚点、不生成分享能力。读取结束前检查授权版本，断开不能被在途响应越过。浏览器 Cookie 仍不能认证业务 `/api/v1/*`。

启用 CMA 后在同一聊天框持续追加要求，复用当前空间的 worker；切换空间恢复它自己的记录。网页每 2 秒串行读取已产生的对话、Responses v2 输出与工具状态，并自动显示 worker 发回的新预览。它不会伪装逐 token 流，也不会自动重试写操作。发布确认绑定具体预览，更新预览后必须重新确认。完整流程和边界见 [WEB_CONSOLE_PLAN.md](WEB_CONSOLE_PLAN.md)。


## 空间聊天部署记录（2026-11-11）

- chrono-cd 修订 `14`；源码提交 `b644c7a04b2539b4631a2d6227d975ee50f4a3f4`，分支 `feat/space-chat-20261111`。[完整 CI](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42871727829) 的 8 个任务全部成功，[Images](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42871785581) 两个镜像均成功，摘要取自该运行的对应构建日志并固定到 `app.json`。
- 部署前后逐字段比对，应用规格仅改变 API/web 的镜像及 CD 解析摘要。API `1/1`、web `2/2` 全部更新并就绪。既有 `chronoai-lobby` 经原 NyxID 用户代理读取，空间响应与部署前一致。
- 线上工作台桌面/手机真实渲染，未出现脚本错误或横向溢出。匿名目录、私有查看器和 CMA 操作均返回 `401` 且 `no-store`；业务接口仍拒绝未签名请求。OAuth 客户端、最小 scopes、回调、PKCE 和安全 Cookie 已核对。
- 本地 449 个网页测试、21 个 OAuth 集成测试（包括 4 个空间发现/查看器用例）及桌面/手机工作台流程通过。全站端到端测试和 API 全量测试在该 CI 中通过。浏览器夹具验证了已有场景渲染、连续追问复用 worker、自动跟随新预览和重新确认发布。
- 未代替用户完成浏览器 OAuth 同意、CMA 同意或真实 worker 修改。线上已验证匿名入口与原有代理读取；登录后的真实空间列表和 worker 编辑仍需用户以自己的账号首次使用验收。


## 创建来源与模型上传

创建聊天在 `context.creation` 中提交 `{name,source}`，来源为 `{kind:"scaniverse",url}` 或 `{kind:"file",name,size,sha256,attachment?}`。文件先以 `prepareOnly:true` 创建环境，再经 `POST /api/auth/nyxid/worker/attachment?agentId=…&name=…` 上传二进制，核对 CMA 回执后以 `message` 提交同一 worker；链接直接以 `create` 提交。固定官方仓库版本和离线命令见 [WEB_CONSOLE_PLAN.md](WEB_CONSOLE_PLAN.md)。

附件入口要求当前浏览器会话、同源 Origin、CSRF、CMA 同意版本和幂等编号；同进程最多两次上传，单文件最大 20 MiB，读取请求体最多 30 秒，转发最多 45 秒，不落盘。成功响应前再次校验授权版本和回执的 worker、名称、路径、大小、SHA-256。CMA 继续独立检查当前用户对目标 worker 的权限。此路径不新增 OAuth scopes，也不把用户 OAuth 凭据交给 worker。


## 浮动聊天与来源创建部署记录（2026-11-11）

- chrono-cd 修订 `15`；功能提交 `d90dfe3e28b8d4870ddd85b60bdfca40de6d246b`，分支 `feat/floating-space-create-20261111`。[Images](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42882047317) 的 API/web 镜像摘要取自这次运行的构建日志，已固定到 `app.json`。
- [完整 CI](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42882030504) 的 8 个任务全部成功，包括 API 全量测试、网页测试、全站浏览器测试、重建工具、SDK 和仓库检查。
- 顶栏空间菜单、满幅场景、右下角可收起的 CMA 聊天、自动编号和来源创建聊天已经部署。Scaniverse 由 CMA 下载，GLB/ZIP 通过当前 worker 的附件上传；现有离线重建工具固定为包含 source 命令的官方提交。
- API `1/1`、web `2/2` 都已更新就绪。上线前后逐字段核对，应用规格只更新两个镜像及 CD 解析摘要；已有前厅空间通过原 NyxID 代理读取的完整响应保持一致。
- 本地网页 450 个测试、23 个真实 MongoDB 的 OAuth/CMA 集成测试、8 个来源工具测试、32 个部署检查，以及 4 个浏览器场景通过。浏览器覆盖 1280×720、手机、连续聊天、文件无文字创建、上传中断后刷新恢复原文件与请求编号。
- 线上构建身份与功能提交一致；健康、匿名会话、未授权创建/附件拒绝、OAuth 的最小 scopes/PKCE/安全 Cookie 检查通过；运行日志无 panic 或 ERROR。生产页面无浏览器脚本错误；使用模拟会话和空目录核对了发布页面的创建入口、浮动聊天和手机布局，没有由该浏览器检查创建真实 worker 或空间。
- 用户首次使用仍须连接 NyxID 并启用 CMA；如 CMA 需要运行环境续期授权，使用同一账号完成官方登录。真实用户授权后的在线重建不以浏览器夹具测试冒充验收。

## CMA 左侧聊天与启动观察部署记录（2026-11-11）

- chrono-cd 最终修订 `18`；网页源码 `d6628142fcb0d609e737ab64c583de7552fa9873`，分支 `fix/cma-left-startup-20261111`。网页镜像摘要取自 [Images 运行](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42904078948) 已成功的 web 构建任务并固定到 `app.json`。只 PATCH 网页镜像；逐字段比较确认 API 镜像、种子、OAuth、环境变量和其余应用规格未变化。API `1/1`、web `2/2` 全部就绪。
- CMA 浮窗和收起按钮移到左下角，场景仍占全宽。新增真实生命周期状态、阶段事件、失败与待连接服务提示；`sandbox_ready` 是阶段名称，不能单凭名称判断完成或失败。只有生命周期成功且有 agent_id 才转入聊天/模型上传；失败不再伪装成准备中，也不把已分配但失败的 agent 当作就绪。
- 新任务保留原始创建内容和幂等编号，完成 CMA 官方授权后由用户明确继续原请求；只有未分配 agent 的失败才能明确启动替代任务。旧标签页没有原始创建请求时，不伪造恢复内容。进度读取发生瞬时错误时最多重连四次，不重放写操作。
- 修订 `17` 的线上核对发现手机空聊天引导会把恢复任务的进度挤到下方；修订 `18` 将启动进度放进聊天记录并在阶段变化时滚动到当前状态。新增真实浏览器检查，确认提示、刷新按钮和任务编号直接处于手机聊天视口内。
- 本地 454 个网页测试通过；最终补充修正通过 13 个工作台回归测试、5 个浏览器场景、类型与 lint 检查。32 个部署检查通过。完整 [CI](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42904079252) 的 8 个任务随后全部成功；前一次被取消的运行不计入验证。
- 生产构建身份与源码一致；1280×720、375×720 布局、匿名拒绝、OAuth 最小 scopes/PKCE/安全 Cookie、启动等待授权的发布页面渲染通过，无浏览器脚本错误。登录后布局和等待授权使用模拟会话/目录/生命周期响应，未创建真实 worker。已有前厅通过原用户代理读取的完整空间响应与更新前一致，head.seq 为 `5`。
- 用户报告停留在 `sandbox_ready`。尚未取得其准备任务编号，无法确认具体生命周期的状态、事件或沙箱故障；诊断端当前 CMA 代理返回 `cma_configuration_required`，直接 OAuth 读取超时，这些观察不能直接当作用户任务根因。网页观察和恢复缺陷已修正，真实 CMA 启动成功仍待该用户任务的实际状态核查。


## 右侧聊天栏与消息恢复部署记录（2026-11-11）

- chrono-cd 修订 `19`；网页源码 `aac88194abdec5bed7d0432874a5a3743622bb86`，分支 `fix/cma-docked-recovery-20261111`。网页镜像摘要来自 [Images 运行](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42909399933) 已成功的 web 构建任务，并固定到 `app.json`。API `1/1`、web `2/2` 全部就绪，web 新副本为 `2/2`；逐字段比较确认应用规格仅更新网页镜像及其解析摘要。
- 桌面将 CMA 聊天放在右侧独立网格列，场景按剩余宽度取景；收起后恢复满宽。1280×720 下场景 900 像素、聊天 380 像素，两者不重叠。手机改为上下布局，并压缩场景工具栏和时间轴，保留可用三维画面；启动/恢复卡滚动到标题，避免错误原因被自动滚动藏起来。
- 待确认的创建、追加消息、附件和停止请求保留最后一次错误说明、错误类型与 HTTP 状态，刷新后仍可查看。旧记录继续兼容并明确说明缺少历史错误详情。重试追加消息保持同一 worker、原始请求内容和幂等编号，不自动重放写操作。
- 本地 455 个网页测试、5 个工作台浏览器场景、格式、lint、类型、生产构建及 32 个部署检查通过。新回归验证第一条成功、第二条回执失败、刷新保留具体错误、再以原请求恢复；这是模拟故障测试，不代表已确认用户实际第二条消息的上游故障原因。
- [CI](https://github.com/ChronoAIProject/chrono-metaverse/actions/runs/42909370893) 中网页、API、重建工具、SDK 和仓库检查已成功，全站三维浏览器任务在部署记录编写时仍在运行，最终状态以该运行记录为准。
- 线上构建身份与源码一致，桌面/手机独立区域、旧消息恢复记录、持久化错误显示、匿名接口拒绝、OAuth 最小 scopes/PKCE/安全 Cookie 均通过。登录后的页面检查使用模拟会话/目录/生命周期/错误，不创建真实 worker；浏览器无脚本错误。原用户代理读取的 `chronoai-lobby` 完整响应与更新前一致，head.seq 仍为 `5`。
- 用户已确认第一条 CMA 请求成功，待确认记录对应第二条追问。现有记录没有保留具体错误，且尚无该浏览器的 worker/响应编号，无法确定是 CMA 拒绝、网络超时还是回执缺失。此次修复恢复反馈与布局，不将其表述为真实第二条消息已执行成功。刷新后可明确重试原请求，取得原结果或具体错误，再依据请求详情核查。
