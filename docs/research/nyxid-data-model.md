# NyxID 的数据是怎么组织的，以及能不能不重新授权就改服务范围

> 依据：NyxID 源码 `/home/user/chronoaiproject/nyxid`，版本是提交 `a3e78fd`。
> - 后端路径都相对 `backend/src/`；前端路径写成 `frontend/src/...`，命令行工具写成 `cli/src/...`。
> - 数据全部存在 MongoDB 里。
> - 你账号里的实际数据（各条连接的 `_id`、你在组织里的角色）源码里看不到，下文只讲结构和规则。

---

## 1. 总览

一句话：**服务分成两层，"目录服务"是模板，"连接"是某个账号名下真正能调用的实例；组织本身也是一个账号；授权和 agent key 记录的都是"连接的 `_id`"，靠这个编号把各部分串起来。**

| 概念 | 存在哪个集合 | 是什么 |
|---|---|---|
| 目录服务 | `downstream_services` | 平台登记的服务模板，例如 chrono-cd 的目录项 |
| 连接 | `user_services` | 某个账号名下的一份服务实例。MCP 里看到的 `chrono-cd`、`Chrono Storage Service` 都是连接 |
| 组织 | `users` | 和个人共用一张表，只是 `user_type = org`；它不能登录，只当共享连接的主人 |
| 成员角色与范围 | `org_memberships`、`org_role_scopes` | 决定组织成员能用组织名下的哪些连接 |
| 授权 | `consents` | 你在授权页给某个应用（例如 claude.ai）放行了哪些连接 |
| agent key | `api_keys` | 给程序用的长期凭证，同样记着它能用哪些连接 |

---

## 2. 实体关系图

```
users（账号）  models/user.rs，集合名在第 6 行
 ├─ user_type = person   个人
 ├─ user_type = org      组织（第 8-13 行注释：不能登录，只当共享资源的主人）
 ├─ slug                 只有组织有（第 240 行）
 ├─ primary_org_id       主组织，多组织同名连接时优先用它（第 275 行）
 └─ role_ids / group_ids 本人的角色和组，身份令牌里的 roles/permissions 就从这里算（第 257、259 行）
      ▲                         ▲
      │ org_user_id             │ member_user_id（成员本人）
 org_memberships（成员关系）  models/org_membership.rs
   role: admin | member | viewer（第 12-19 行）
   scope_source: inherit | override
   allowed_service_ids: [连接 _id]，为空表示组织的全部连接
 org_role_scopes（按角色的默认范围）  models/org_role_scope.rs
   org_user_id, role, allowed_service_ids（第 13-17 行）

user_services（连接）  models/user_service.rs，集合名在第 8 行
   _id                  ← 授权、成员范围、agent key 引用的都是它
   user_id              → users._id：指向本人就是个人连接，指向组织就是组织连接（第 15 行）
   slug                 同一主人下唯一；也是 MCP 工具名前缀（第 23 行）
   endpoint_id          → user_endpoints._id（第 25 行）
   api_key_id           → user_api_keys._id，服务不需要认证时为空（第 28 行）
   catalog_service_id   → downstream_services._id，为空表示自定义服务（第 38 行）
   service_type         MCP 只列 "http"（第 50 行）
   admin_only           组织连接是否只允许组织管理员用（第 57 行）
   identity_propagation_mode / identity_jwt_audience / forward_access_token（第 66、74、77 行）
   is_active（第 106 行）
   ├─ user_endpoints  models/user_endpoint.rs
   │    label（MCP 里显示的服务名）、url、catalog_service_id、openapi_spec_url（第 11-22 行）
   └─ user_api_keys   models/user_api_key.rs
        加密的下游凭证、credential_type、status

downstream_services（目录服务）  models/downstream_service.rs，集合名在第 11 行
   _id, slug（有效行里全局唯一）, base_url, identity_* 的默认值, ...
   └─ service_endpoints（目录的接口表）  models/service_endpoint.rs
        service_id → downstream_services._id

consents（授权）  models/consent.rs，集合名在第 6 行；唯一键 {user_id, client_id}
   user_id → 你本人；client_id → OAuth 应用（claude.ai 动态注册得到的编号）
   scopes, revision
   allow_all_services: bool（第 26-28 行）
   allowed_service_ids: [连接 _id]（第 29-33 行，注释原文 "resource-owner-approved UserService allowlist"）
   这两个字段会复制进 authorization_codes、refresh_tokens 和访问令牌的声明里

api_keys（agent key）  models/api_key.rs，集合名在第 6 行
   user_id → key 的主人（本人或组织）
   key_hash（只存哈希）, scopes
   allow_all_services, allowed_service_ids: [连接 _id]（第 68-71、92-95 行）
   assistant_operation_scopes（操作范围，按连接 _id 分组）
```

**把你的两条连接放进这张图：**

| | `chrono-cd` | `Chrono Storage Service` |
|---|---|---|
| 存在哪 | `user_services` 里的一行 | `user_services` 里的一行 |
| `user_id` 指向 | ChronoAI 组织那一行 `users._id` | 你本人 |
| 名字从哪来 | `slug = chrono-cd` | 显示名来自 `user_endpoints.label`；工具名前缀用的是它的 `slug` |

你给 claude.ai 的授权，是 `consents` 里的一行：`allow_all_services = false`，`allowed_service_ids` 里只有这两条连接的 `_id`。

---

## 3. 一次调用的完整链路：AI 在 MCP 里调 `chrono-cd__list_apps`

**第 1 步：发出请求。**
- claude.ai 请求 `POST /mcp`，路由在 `routes.rs:338-370`。
- 请求头带 `Authorization: Bearer <NyxID 访问令牌>`。

**第 2 步：认证**（`handlers/mcp_transport.rs:942` 的 `authenticate_mcp_or_public`）。
- 认证顺序是 `x-api-key` → `Bearer` → MCP 会话（897-901 行）。
- Bearer 里如果是 `nyxid_ag_` 或 `nyx_` 开头的 key，直接返回 403（1117-1137 行）。agent key 只能放在 `x-api-key` 里。
- 验证 JWT 之后，调用 `validate_claims_with_user_for_route(..., "mcp")`（1144-1156 行）。它会**实时查 `consents` 那一行**：记录必须还在、`revision` 一致、没过期，否则返回 401。代码在 `services/oauth_token_authority_service.rs:350` 起，以及 `services/consent_service.rs:509` 起。
- 权限范围必须含 `proxy` 或 `proxy:*`，否则 403（1177-1179 行）。
- **能用哪些服务，直接从令牌里读**：`allow_all_services`、`allowed_service_ids`（1271-1279 行）。
- 请求里的 Bearer 原文记为 `caller_token`，后面转发时会用到（1269-1270 行）。

**第 3 步：列工具**（`handle_tools_list` 在 2243 行，调用 `services/mcp_service.rs:962` 的 `load_operation_catalog`）。每次请求都从数据库现查：
- **本人的连接**：查 `user_id = 你`、`is_active`、`service_type = "http"` 的行，再按授权过滤（2193-2203 行）。
- **组织的连接**：成员关系每次现读（`OwnerGrants::load_for_listing`，1010-1011 行）。对每个组织依次检查：
  - Viewer 角色跳过；
  - `role_can_proxy_service`，规则是 `role.can_proxy() && (!admin_only || role.can_admin())`（`services/user_service_service.rs:121-123`）；
  - `scope_allows`：成员行设成 `override` 就用成员自己的列表，设成 `inherit` 就用 `org_role_scopes` 里该角色的列表（`services/org_role_scope_service.rs:138-155`）；
  - 最后再按授权过滤（`services/mcp_service.rs:2235-2275`）。
- **同一个 `slug` 只留一条，本人名下的优先**（`select_slug_winner_indices`，2631-2657 行）。
- **授权是"部分服务"时，平台服务和内部服务一律不显示**（`ServiceScope::permits`，878-893 行；`filter_services_by_scope`，`mcp_transport.rs:1565-1584`）。
- 工具名格式是 `{slug}__{接口名}`（`mcp_service.rs:2957`）。
- 接口列表的来源：连接自己挂的 `openapi_spec_url` 优先，其次是目录的 `service_endpoints`；自定义服务没有目录，只用自己的接口描述（1691-1740 行）。

**第 4 步：调工具**（`handle_tools_call`，2559 行）。
- 先用 `ensure_service_in_scope` 再查一次授权范围（定义在 1588 行，在 3389 行调用）。
- 再**按连接 `_id` 精确解析**，不按 `slug` 选。入口是 `mcp_service.rs:5094` 附近，具体检查在 `services/proxy_service.rs:2568-2632`：
  - 连接归你本人：放行；
  - 你是组织 Admin：连接必须在你的范围内；
  - 你是组织 Member：必须能代理、`admin_only` 允许、并且在范围内；
  - 其他情况：403 `OrgRoleInsufficient`。
- 用 `build_minimal_downstream_service`（`proxy_service.rs:4146`）拼出一个临时的服务对象：
  - `id` 取 `catalog_service_id`，没有就取连接 `_id`（4168-4171 行）；
  - `base_url` 取 `user_endpoints.url`；
  - 身份传递相关的开关都取连接上的值（4201-4208 行）。

**第 5 步：加请求头并转发**（`mcp_service.rs:6272-6345`）。
- 模式是 `jwt` 或 `both`：加 `X-NyxID-Identity-Token`。
- 模式是 `headers` 或 `both`：加 `X-NyxID-User-Id`、`X-NyxID-User-Email`、`X-NyxID-User-Name`。
- 模式不是 `none` 时，`X-NyxID-User-Roles`、`X-NyxID-User-Permissions`、`X-NyxID-User-Groups` 不为空就加。
- `forward_access_token` 开着：把第 2 步记下的 Bearer 原文放进 `Authorization`（`proxy_service.rs:521-534`）。
- 再按连接配置注入下游凭证。
- 调用方自带的其他请求头，只有白名单里的会转发（`ALLOWED_FORWARD_HEADERS`，`proxy_service.rs:551` 起）。

**第 6 步：服务收到的身份令牌**（结构在 `services/identity_service.rs:76-96`，生成在 193-241 行）。

| 字段 | 取值 |
|---|---|
| `sub` | **调用者本人**。走组织连接时也是你本人，不是组织 |
| `aud` | 连接的 `identity_jwt_audience`；没设就用 `base_url` |
| `iss` | 配置项 `jwt_issuer` |
| `nyx_service_id` | 连接来自目录时是目录服务 `_id`，自定义服务是连接 `_id` |
| `roles` / `groups` / `permissions` | 由调用者自己的 `role_ids` / `group_ids` 算出，不按目标服务过滤 |
| `iat` / `exp` | 签发时间 / 签发后 60 秒 |
| `jti` | 每次新生成 |
| 签名 | RS256，头里带 `kid` |
| 不包含 | agent key 编号、`allowed_service_ids` |

chrono-cd 那条连接线上有没有开身份令牌，源码里看不到。

---

## 4. 直接回答："登录授权时只选了部分服务，能不能不重新授权就改？"

**结论：对 claude.ai 这种连接器，不能。** NyxID 没有修改已有授权服务列表的入口，唯一的办法是先撤销这个应用，再重新连接、重新选服务。

### 4.1 源码依据

1. **没有修改入口。**
   - 接口：`routes.rs:702-724` 里，`/me/consents` 只有 `GET` 列表、`GET /{client_id}/authorization`、`DELETE /{client_id}` 三个。另外的 `/{client_id}/machine-grant` 改的是"机器权限"，不是服务列表。
   - 网页：只有撤销按钮。前端钩子也只有 `useMyConsents`（查）和 `useRevokeConsent`（删），见 `frontend/src/hooks/use-consents.ts`。
   - 命令行：只有 `nyxid profile consents` 和 `nyxid profile revoke-consent`（`cli/src/cli.rs:1052-1065`）。
   - NyxID 自己的提示语（`mcp_transport.rs:5755-5773`）原文是："revoke this app, then reconnect it and choose the services to share (or all services)"。
2. **直接改数据库也不会让 claude.ai 马上拿到新范围。**
   - 服务范围写在访问令牌里（`mcp_transport.rs:1271-1279`）。
   - 刷新令牌时沿用刷新记录里存的旧列表（`services/token_service.rs:896-904`、`1057-1058`）。
3. **不撤销、直接在 claude.ai 里重连，可能不会弹授权页。**
   - 如果 claude.ai 用原来的 `client_id` 发起授权，且没带 `prompt=consent`，`consent_requires_prompt` 会返回 false（`handlers/oauth.rs:560-588`）。NyxID 就不显示授权页，直接按旧列表发授权码（1393-1412 行；2263-2292 行）。
   - 即使授权页出现了，`consents` 这一行只做"并集"合并，只会变宽（`consent_service.rs:224-245`）；这一轮发出的授权码只带这一轮勾选的服务（`oauth.rs:1159-1162`）。
   - claude.ai 重连时会不会复用 `client_id`、会不会带 `prompt=consent`，NyxID 源码里看不到。NyxID 这边的动态注册每次都新建一个应用，不去重（`oauth.rs:4007` 起）。
4. **增量授权帮不上忙。**
   - 它只能加服务，不能改成"全部服务"（`services/incremental_consent_service.rs:207-212`）。
   - 必须由应用自己带参数 `service_access_mode` / `requested_service_ids` 发起（`oauth.rs` 中 `AuthorizeQuery`）。claude.ai 会不会这样做，源码里看不到。

### 4.2 不重新授权也会变的部分

这些变化都只能在已授权的连接里收窄或改内容，不能把授权外的连接加进来：
- **组织侧改动，下次列工具就生效**（因为每次现查）：组织管理员改你的角色、成员范围、角色默认范围，或者改连接的 `admin_only`。
- **连接被停用或删除**：从 MCP 里消失。
- **删掉重建**：会生成新的 `_id`，新 `_id` 不在授权里，所以不会出现（这是从数据模型推出来的）。
- **就地修改连接**（`PUT /api/v1/keys/{key_id}`，`routes.rs:1920`）：`_id` 不变，仍在授权里。

### 4.3 具体操作

**第 1 步：看清当前授权（可选）。**
- 命令行：`nyxid profile consents`
- 或接口：`GET /api/v1/users/me/consents`（`handlers/consent.rs:86`）
- 返回里有 `allow_all_services`、`allowed_service_ids` 和服务名，也能找到 claude.ai 对应的 `client_id`。

**第 2 步：撤销旧授权（三种方式任选其一）。**
- 网页：NyxID 控制台 `/settings/consents`（`frontend/src/router.tsx:688`），页面标题是 "Access & Authorizations"，切到 "Authorized Apps" 标签，找到 claude.ai 那一项，点撤销。
- 命令行：`nyxid profile revoke-consent <CLIENT_ID> --yes`
- 接口：`DELETE /api/v1/users/me/consents/{client_id}`（`handlers/consent.rs:125-157`）

撤销会在一个事务里做这些事（`consent_service.rs:784-867`）：
- 删除 `consents` 这一行；
- 写入 `consent_revocation_fences`，防止旧的授权页提交把它恢复；
- 把这个应用下你的全部 `refresh_tokens` 标记作废。

处理函数还会撤销相关的代理绑定，并记审计日志 `oauth_consent_revoked`。之后 claude.ai 手里的访问令牌，下次请求时会得到 401。

**第 3 步：在 claude.ai 的连接器设置里重新连接 NyxID。** 这是 claude.ai 那边的操作，NyxID 源码里看不到具体按钮。因为授权记录已经删了，`consent_requires_prompt(None)` 返回 true（`oauth.rs:565-567`），授权页一定会出现，写入的是全新的一行，不做并集。

**第 4 步：在授权页选服务。** 可选范围是你本人的连接，加上你有权使用的组织连接（`frontend/src/pages/oauth-consent.tsx:397-415`；后端校验在 `services/oauth_resource_service.rs:149-171`）。
- **打开 "All services"**（默认关闭，`oauth-consent.tsx:355-357`）：令牌不带服务限制，以后新增的连接和平台服务都会自动出现。组织连接仍然受角色和范围限制。
- **继续"只允许部分服务"，把需要的连接勾上**：以后每新增一条连接，都要再走一遍这个流程。

---

## 5. 对 chrono-metaverse 的含义

### 5.1 注册成自定义服务后，它在这个模型里是什么

按 `infra/chrono-cd/README.md` 第 7 步执行：

```bash
nyxid service add --custom --slug chrono-metaverse ... --auth-method none --org chronoai
```

这条命令调用 `POST /api/v1/keys`，请求体带 `target_org_id`，要求你是该组织的 Admin（`handlers/keys.rs:920-937`）。结果如下：
- **`user_services` 新增一行**：
  - `user_id` = ChronoAI 组织的 `users._id`，所以它是组织连接；
  - `slug = chrono-metaverse`；
  - `catalog_service_id` 为空，所以是自定义服务；
  - `api_key_id` 为空，因为不需要认证（见测试 `create_key_no_auth_method_succeeds`，`handlers/keys.rs:4651` 起）；
  - `admin_only` 默认 false（`handlers/keys.rs:1078`）。
- **`user_endpoints` 新增一行**：存 `url`、`openapi_spec_url`、`label`。
- **组织范围的自动处理**：新建的组织连接不是 `admin_only` 时，如果组织给 Member 角色设了明确列表，会自动把它加进去（`user_service_service.rs:1246-1255`）。Admin 角色的列表、成员的单独设置都不会自动扩（`org_role_scope_service.rs:157-161`）。
- **MCP 工具**：来自 `openapi_spec_url`，工具名形如 `chrono-metaverse__<operationId>`（`services/openapi_parser.rs:105-165`；`mcp_service.rs:2957`）。
- **身份令牌里的值**：
  - `nyx_service_id` = **这条连接的 `_id`**，因为 `catalog_service_id` 为空（`proxy_service.rs:4168-4171`）。这就是 `ALLOWED_NYX_SERVICE_IDS` 要填的值。以后改成目录服务，它会变成目录服务的 `_id`。
  - `aud` = `urn:chrono-metaverse:api`。
  - `sub` 是调用者：经 claude.ai 是你本人；经个人 agent key 是 key 的主人；经组织 agent key 是组织的 `users._id`（`mw/auth.rs:963-964` 用的是 `key.user_id`）。

### 5.2 怎么让它出现在 Claude 的连接器里

要同时过两道检查：
1. **组织这道**（现查，改了马上生效）：
   - 你在 ChronoAI 的角色是 Admin 或 Member；
   - 连接不是 `admin_only`，或者你是 Admin；
   - 你的生效范围包含它（`mcp_service.rs:2240-2275`）。
2. **授权这道**：你现在的授权只含 `chrono-cd` 和 `Chrono Storage Service` 两条连接的 `_id`，新连接不在里面。必须按第 4.3 节撤销再重连，勾上 `chrono-metaverse`，或者选 "All services"。

### 5.3 agent key 怎么只开放它

**创建 key**（参数定义在 `cli/src/cli.rs:2262-2316`；`--allowed-services` 接受连接编号或 `slug`）：
- 个人 key：
  ```bash
  nyxid api-key create --name <名称> --scopes proxy --allowed-services chrono-metaverse
  ```
  个人 key 可以放进你有权使用的组织连接（`services/api_key_scope_service.rs:174-187`）。
- 组织 key：再加 `--org chronoai`，要求你是组织 Admin。它只能放该组织自己的连接（189-210 行），调用时 `sub` 是组织。

**几个要点：**
- **必须带 `proxy` 权限范围**：不填时默认是 `read`（`handlers/api_keys.rs:1453`），这样既进不了 MCP，也走不了代理（`mw/auth.rs:319-338`、`424-426`）。
- 只要限制了服务范围，发出的 key 以 `nyxid_ag_` 开头（`services/key_service.rs:196-200`）。
- 数据库里存成：`allow_all_services = false`，`allowed_service_ids = [chrono-metaverse 连接的 _id]`。

**改范围不用换 key。**
- 命令行 `nyxid api-key update <id> --allowed-services ...`，或接口 `PUT /api/v1/api-keys/{key_id}`（`routes.rs:746-748`）。
- 每次请求都按 `key_hash` 现查（`key_service.rs:1725` 起），所以下一次请求就按新范围走。
- 只有人的登录态能改：这组接口拒绝任何 API key（`mw/auth.rs:2030-2060`），key 改不了自己。

**操作范围（可选）。**
- 命令行：
  ```bash
  nyxid api-key operations <key> --service chrono-metaverse --allow "POST:/路径模板"
  ```
- 前提：配置的人要打开个人开关 `assistant:operation-scopes`，它默认关闭（`services/feature_flag_service.rs:251-256`）。
- 自定义服务只能用"方法 + 路径模板"规则，**不能限制路径参数或请求体的取值**，原因如下：
  - 取值限制只能挂在 `service_endpoints` 的接口行上；
  - 规则里带参数限制会被拒绝（`services/agent_operation_scope_service.rs:419-514`）；
  - `service_endpoints` 的写入以目录服务为父对象（`services/service_endpoint_service.rs:84-99`）。

  这和 chrono-metaverse 设计文档 9.3 节"需要目录服务"的判断一致。

**怎么用这把 key。**
- MCP：只认 `x-api-key` 请求头。放在 `Authorization: Bearer` 里会被 403（`mcp_transport.rs:1117-1137`）。
- 命令行：先 `nyxid login --agent-key --profile <名称>`，再用 `nyxid proxy request chrono-metaverse ...`。

### 5.4 一个要注意的事实：`forward_access_token` 转发的是什么

NyxID 转发的是"调用方请求里 `Authorization: Bearer` 后面的原文"，不检查它是不是 JWT（`proxy_service.rs:491-507`）。三种调用方式的结果不同：
- **经 claude.ai**：转发的是 claude.ai 持有的、你的 NyxID 访问令牌（`mcp_transport.rs:1269-1270`）。
- **经命令行的 agent key 配置**：命令行把 agent key 当 Bearer 发出去（`cli/src/api.rs:940-944` 的 `bearer_auth(token)`；`cli/src/auth.rs:404-411`）。REST 代理会把 `nyxid_ag_...` 原文转给 chrono-metaverse（`handlers/proxy.rs:4457`）。NyxID 自己的测试也这样断言：`handlers/proxy.rs:9277-9284`，非定时调用时返回 `nyxid_ag_example`。
- **经 MCP 的 `x-api-key`**：请求里没有 Bearer，什么都不转发。

这对 chrono-metaverse 意味着两件事：
1. 它会收到可以直接使用的 NyxID 凭证，包括 agent key 原文，必须按凭证对待，例如不能写进日志。
2. 通过 MCP `x-api-key` 调用的个人 key 不带任何令牌。按 chrono-metaverse 自己 `api/README.md` 第 390 行写的流程，这时查不到组织角色，组织空间的写操作会返回 503。

---

## 6. 附

### 6.1 几处同事说法的核实结果

- **刷新时的服务范围。** 普通刷新沿用刷新记录里的列表（`token_service.rs:896-904`、`1057-1058`）。`731-741` 行那段"令牌与授权取交集"的逻辑，只用于没有 `protected_consent` 的老记录（`legacy_upgrade`，第 691 行）。两条路径都不会让范围变宽。
- **MCP 列表遇到同名连接会去重。** 同一个 `slug` 只保留一条，本人名下的优先（`mcp_service.rs:2631-2657`）。
- **MCP 调用按连接 `_id` 解析，不按 `slug` 选。** 只有 REST 代理 `/api/v1/proxy/s/<slug>` 才走按名称选择（`services/service_pool_routing.rs:88` 的 `select_slug_metadata`）。

### 6.2 关键文件索引

路径相对 `/home/user/chronoaiproject/nyxid/`。

| 文件 | 作用 |
|---|---|
| `backend/src/models/user.rs` | 账号表；组织也是账号（`user_type`） |
| `backend/src/models/user_service.rs` | 连接（核心表） |
| `backend/src/models/user_endpoint.rs`、`user_api_key.rs` | 连接的地址、下游凭证 |
| `backend/src/models/downstream_service.rs`、`service_endpoint.rs` | 目录服务、目录接口表 |
| `backend/src/models/org_membership.rs`、`org_role_scope.rs` | 成员角色、成员范围、角色默认范围 |
| `backend/src/models/consent.rs` | 授权记录 |
| `backend/src/models/api_key.rs` | agent key |
| `backend/src/handlers/mcp_transport.rs` | MCP 入口：认证、按授权过滤、拒绝提示 |
| `backend/src/services/mcp_service.rs` | 生成工具目录、组织过滤、同名去重、调用转发、加身份头 |
| `backend/src/services/proxy_service.rs` | 按连接解析、组织权限检查、拼临时服务对象、转发调用者令牌 |
| `backend/src/services/identity_service.rs` | 身份令牌的字段和签发 |
| `backend/src/services/user_service_service.rs`、`org_role_scope_service.rs` | `admin_only` 判断、生效范围计算、新连接自动加入角色范围 |
| `backend/src/handlers/oauth.rs` | 授权页逻辑、何时弹授权页、发授权码 |
| `backend/src/services/consent_service.rs` | 授权的并集写入、撤销、令牌实时核对 |
| `backend/src/services/token_service.rs` | 刷新令牌时服务范围怎么延续 |
| `backend/src/handlers/consent.rs`、`backend/src/routes.rs:702-724` | 授权的查看和撤销接口 |
| `backend/src/handlers/keys.rs` | 建连接（含 `target_org_id` 建组织连接） |
| `backend/src/handlers/api_keys.rs`、`services/api_key_scope_service.rs`、`services/key_service.rs` | agent key 的创建、范围校验、每次请求的鉴权 |
| `backend/src/services/agent_operation_scope_service.rs` | 操作范围 |
| `frontend/src/pages/oauth-consent.tsx` | 授权页（"All services" 开关、可选服务列表） |
| `frontend/src/pages/consents.tsx`、`frontend/src/hooks/use-consents.ts` | 授权管理页，只能查看和撤销 |
| `cli/src/cli.rs` | `nyxid profile consents / revoke-consent`、`nyxid api-key create / update / operations` |