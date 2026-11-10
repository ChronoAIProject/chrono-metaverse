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

OAuth 凭据只用于 `/oauth/userinfo`、`/oauth/token` 和组织角色查询；业务操作仍以本次 NyxID 签名身份执行。浏览器连接 Cookie 不能认证 `/api/v1/*`。个人资源、组织主体直接访问自己的资源，以及公开/分享链接的原有规则继续生效。

## 配置

在 NyxID 注册一个专用于此部署的**保密 OAuth 客户端**，支持 `authorization_code`、`refresh_token`、PKCE S256、`client_secret_post`，允许 scopes `openid offline_access`。不用为这个客户端授予业务服务的代理访问范围；它不代理业务请求。现有 NyxID 的普通用户组织查询接口以用户身份判定成员权限，不要求新增组织 scope。此结论根据 NyxID 源码核对；实际部署仍需完成下文的线上验收。

`openid offline_access` 是当前申请的最小 scope 集合，但 NyxID 现有普通用户组织接口没有“仅查询角色”的专用 scope。本文所说的“只用于查询”是 metaverse 的代码使用边界，不代表 provider 已将令牌硬限制到这一个接口；令牌仍须按敏感用户凭据保护，其他接口能否接受它取决于 NyxID 各路由的身份、scope 及资源检查。

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
