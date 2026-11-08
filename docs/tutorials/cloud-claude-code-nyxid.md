# 开发教程：在云端用 Claude Code 连接 NyxID MCP 做实际开发

这篇教程记录的是 chrono-metaverse 项目真实的开发方式：在浏览器（或手机、桌面 App）里开一个云端 Claude Code 会话，让 Claude 写代码、跑命令、推送分支；同时通过 NyxID 的 MCP，让 Claude 直接调用公司的服务（部署服务、存储服务、我们自己写的服务），整个过程中密钥不会经过 Claude。

读完你会：

1. 把 NyxID 接到 claude.ai，在云端会话里用上 NyxID 的工具；
2. 让 Claude 通过 NyxID 查询、部署 chrono-cd 上的应用；
3. 遇到权限、网络问题时知道怎么排查；
4. 把自己写的服务变成 NyxID 服务，让任何接了 NyxID 的 AI 都能调用。

---

## 1. 整体关系

```
你（浏览器 / 手机 / 桌面 App）
        │  对话
        ▼
Claude Code 云端会话 ── 一个隔离的容器：克隆好的仓库、终端、受控的网络
        │  MCP（claude.ai 连接器，OAuth 登录 NyxID）
        ▼
NyxID 网关 ── 认证你的身份、注入凭证、把各服务的 OpenAPI 变成 AI 工具
        ├── chrono-cd（部署服务）
        ├── Chrono Storage Service（存储服务）
        └── 你自己的服务（例如 chrono-metaverse）
```

要点：

- **Claude 不拿任何服务的密钥。** Claude 只调用 NyxID 的工具，各服务的凭证由 NyxID 保存，转发请求时由 NyxID 注入。
- **云端会话是临时容器。** 代码改动要提交并推送到分支，否则容器回收后就没了。
- **云端会话的网络默认受限。** 能访问包管理器（npm、PyPI 等）和已连接的 MCP 服务；访问其他网站需要在"环境"里放行（见第 4 节）。

---

## 2. 准备

| 需要 | 说明 |
|---|---|
| NyxID 账号 | 托管版用 Google / GitHub / Apple 登录。要用公司的服务，需要加入 ChronoAI 组织 |
| claude.ai 账号 | 能使用 Claude Code 云端会话（claude.ai/code） |
| GitHub 授权 | 你的 GitHub 已连接 claude.ai，仓库已安装 Claude GitHub App |

---

## 3. 第一步：把 NyxID 加成 claude.ai 连接器

1. 打开 <https://claude.ai/customize/connectors>，添加自定义连接器：
   - 名称：`NyxID`
   - 地址：`https://nyx-api.chrono-ai.fun/mcp`
2. 按提示跳转到 NyxID 登录，并同意授权。授权时可以选择允许使用哪些服务，也可以选全部。

注意：

- **本机的配置不会带到云端。** 在自己电脑上用 `claude mcp add` 加的 MCP 只对本机的 Claude Code 生效。云端会话只认 claude.ai 的连接器，或者仓库里提交的 `.mcp.json`。
- **连接器在会话开始时读取。** 连好以后新开一个会话最稳妥（有时当前会话也会自动出现新工具）。
- **地址可能变。** NyxID 计划把接口地址迁到 `https://api.nyxid.ai`，以 NyxID 控制台上显示的 MCP 地址为准。

---

## 4. 第二步：开一个云端会话

1. 打开 <https://claude.ai/code>，选择仓库（例如 `ChronoAIProject/chrono-metaverse`）和环境，开始会话。
2. 直接用中文描述任务即可，例如"读一下仓库结构，然后……"。

### 4.1 网络放行

云端环境默认只允许访问包管理器等少数地址。需要访问其他网站时：

- Claude 碰到被拦截的请求，会提出修改环境，并说明原因；你在弹出的确认卡片上批准即可。
- 也可以自己改：会话标题栏的环境菜单 → 编辑 → 网络访问 → 允许的域名。

本项目的真实例子：为了下载 Scaniverse 上的前厅扫描，下载请求被拦截了。Claude 新建了一个个人环境 `chrono-metaverse`，只多放行 `scaniverse.com`，并把当前会话切到这个环境。没有改动所有项目共用的默认环境。

### 4.2 用到其他仓库

需要读其他仓库（例如查看 NyxID 或部署服务的源码）时，直接告诉 Claude。公开仓库可以直接只读克隆；私有仓库需要你授权 Claude 访问。本项目在设计阶段就克隆了 NyxID、chrono-cd、chrono-bucket 的源码来核实平台行为。

---

## 5. 第三步：确认 NyxID 工具可用

在会话里说："列出我在 NyxID 里已连接的服务。"

Claude 会用到这几个 NyxID 自带的工具：

| 工具 | 作用 |
|---|---|
| `nyx__list_connected_services` | 列出已连接的服务 |
| `nyx__discover_services` | 列出还没连接、可以连接的服务 |
| `nyx__connect_service` | 连接一个服务 |
| `nyx__search_tools` | 按关键字搜索工具，返回工具名和参数格式 |
| `nyx__call_tool` | 调用某个服务的工具：传入工具名和 JSON 参数 |

本项目里的真实返回（节选）：

```
chrono-cd              （组织服务，21 个工具）
Chrono Storage Service （个人连接，12 个工具）
```

调用某个服务的固定套路：

1. 用 `nyx__search_tools` 按服务名或关键字搜索，得到工具名（格式是 `服务标识__操作名`，例如 `chrono-cd__get_account`）和参数格式；
2. 用 `nyx__call_tool`，传入 `tool_name` 和 `arguments_json`（JSON 字符串）。

一般不需要你记这些，直接说想做什么，Claude 会自己搜索和调用。

---

## 6. 实战 A：查看部署服务的账号和已有应用（只读）

对 Claude 说："用 chrono-cd 看一下我的账号、配额，以及 ChronoAI 组织下有哪些项目和应用。"

Claude 实际调用的工具：

| 工具 | 参数示例 | 得到什么 |
|---|---|---|
| `chrono-cd__get_account` | `{}` | 身份、能否部署、个人配额、所属组织及角色 |
| `chrono-cd__list_projects` | `{"org_id": "<组织编号>"}` | 组织下的项目 |
| `chrono-cd__list_apps` | `{"project": "omega", "org_id": "<组织编号>"}` | 项目下的应用 |
| `chrono-cd__get_app` | `{"project": "...", "app": "...", "org_id": "..."}` | 应用的域名、配置、镜像版本、状态 |

本项目查到的信息（节选）：

- 个人配额 2 核 / 4G 内存 / 10 个容器 / 20G 存储；组织下配额更大，所以项目部署在组织下。
- 应用对外的地址形如 `https://<应用名>-<所有者>.apps.chrono-ai.fun`（新应用可能在 `apps.nyxid.ai` 下，以创建结果为准）。
- 应用可以挂 MongoDB 插件，镜像只能来自 ghcr.io。

---

## 7. 实战 B：部署一个应用

部署是写操作。建议先让 Claude 把要提交的配置给你看，确认后再执行。删除应用（`chrono-cd__delete_app`）不可恢复，务必确认。

### 7.1 镜像要求

- 只能用 `ghcr.io/...` 的镜像，最省事的是设成公开包；
- Dockerfile 里用数字形式的非 root 用户，例如 `USER 1000:1000`（写成用户名会启动失败）；
- 构建 `linux/amd64` 镜像。

### 7.2 提交应用配置

对 Claude 说："在 ChronoAI 组织下创建项目 metaverse 的应用 chrono-metaverse，先把配置给我看。"

Claude 会调用 `chrono-cd__put_app`，参数大致如下（这是本项目的规划配置）：

```json
{
  "project": "metaverse",
  "app": "chrono-metaverse",
  "org_id": "<ChronoAI 组织编号>",
  "addons": { "mongodb": {} },
  "services": {
    "web": {
      "image": "ghcr.io/chronoaiproject/chrono-metaverse-web:<版本>",
      "port": 8080, "routes": ["/"], "expose": "public"
    },
    "api": {
      "image": "ghcr.io/chronoaiproject/chrono-metaverse-api:<版本>",
      "port": 8080, "routes": ["/api"], "expose": "public",
      "health_path": "/api/healthz",
      "addon_env": { "mongodb": { "uri": "MONGODB_URI", "database": "MONGODB_DATABASE" } },
      "secret_keys": ["KEY_PEPPER"]
    }
  }
}
```

接着：

| 步骤 | 工具 |
|---|---|
| 写入密钥（值不会被返回） | `chrono-cd__set_app_secrets` |
| 查看部署状态 | `chrono-cd__get_app_status` |
| 查看日志 | `chrono-cd__get_app_logs`、`chrono-cd__query_app_logs` |
| 回滚 | `chrono-cd__list_app_revisions`，再用旧镜像版本重新 `put_app` |

返回 `422 missing_secret_keys` 是正常流程：配置已保存，等密钥写入后才会部署。

---

## 8. 实战 C：排查权限问题（真实踩坑记录）

本项目测试存储服务时，所有调用都返回：

```
Error (403): {"error":{"code":"PERMISSION_DENIED","message":"Caller lacks the required permission"}}
```

排查过程：

1. **区分 401 和 403。** 401 表示身份令牌缺失或无效（连接器没授权、令牌过期）；403 表示身份没问题，但权限不够。这里是 403，说明 NyxID 连接本身是通的。
2. **对比身份信息。** `chrono-cd__get_account` 会列出你在 NyxID 的全部角色。里面没有存储服务需要的角色。
3. **看服务源码确认。** 让 Claude 克隆存储服务的源码（chrono-bucket），查到每个接口都要求 `chrono-bucket-user` 角色带来的权限，例如 `bucket:create`。
4. **结论：** 请 NyxID 平台管理员给账号加上 `chrono-bucket-user` 角色。

这类问题让 Claude 直接读服务源码定位，通常比猜快得多。

---

## 9. 实战 D：把自己的服务变成 NyxID 服务

这样做的好处：不用自己写 MCP，任何接了 NyxID 的 AI（Claude Code、Codex、Cursor……）都能直接调用你的接口；你的服务只需要校验 NyxID 的身份令牌。

### 9.1 提供 OpenAPI 文档

- 在公网可访问、无需登录的地址提供 `/openapi.json`（OpenAPI 3.0 / 3.1）；
- 每个接口写好 `operationId`（会变成工具名 `服务标识__operationId`）和 `summary` / `description`（会变成 AI 看到的工具说明）；
- 二进制上传用 `application/octet-stream`（AI 工具里会变成 base64 字段），不要用 multipart；
- Bun + Hono 可以用 `@hono/zod-openapi` 自动生成文档。

### 9.2 校验 NyxID 身份令牌

chrono-cd 上的应用是公网直接可访问的，前面没有 NyxID 把关，所以服务要自己校验 NyxID 转发时附带的 `X-NyxID-Identity-Token`：

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const NYXID = "https://nyx-api.chrono-ai.fun";              // 以 /.well-known/openid-configuration 为准
const jwks = createRemoteJWKSet(new URL(`${NYXID}/.well-known/jwks.json`));

export async function verifyNyxIdentity(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ["RS256"],
    issuer: process.env.NYXID_ISSUER,                         // 从 openid-configuration 读取
    audience: process.env.NYXID_AUDIENCE,                     // 和注册服务时设置的受众一致
  });
  if (!payload.sub) throw new Error("missing sub");
  return payload;  // 含 sub（用户编号）、roles、permissions、nyx_service_id 等
}
```

- 令牌只有 60 秒有效，每个请求都要校验；
- 绝不要信任 `X-NyxID-User-Id` 这类明文头，公网上谁都能伪造；
- 完整参考实现：chrono-bucket 的 `src/auth/verifier.ts`、`src/middleware/nyxidAuth.ts`。

### 9.3 在 NyxID 注册服务

在自己电脑上装好 NyxID 命令行工具并登录后，注册为组织服务（需要是组织管理员）：

```bash
nyxid service add --custom \
  --slug chrono-metaverse \
  --label "chrono-metaverse" \
  --endpoint-url "https://<你的应用域名>" \
  --openapi-spec-url "https://<你的应用域名>/api/openapi.json" \
  --auth-method none \
  --org chronoai
```

然后开启身份令牌转发。命令行目前没有这个开关，需要调用 NyxID 接口 `PUT /api/v1/keys/{连接编号}`，设置：

```json
{ "identity_propagation_mode": "jwt", "identity_jwt_audience": "https://<你的应用域名>" }
```

（这一步来自 NyxID 源码，本项目会在第 0 阶段实测后更新本节。）

### 9.4 回到云端会话验证

在会话里说："搜索 chrono-metaverse 的工具，调用一个只读接口试试。" 能搜到 `chrono-metaverse__...` 开头的工具，并且返回真实数据，就说明整条链路通了。

### 9.5 经过 NyxID 代理时的限制

| 限制 | 对接口设计的影响 |
|---|---|
| 自定义请求头会被丢掉（只转发 `If-Match`、`Idempotency-Key`、`Range` 等标准头） | 参数放在路径、查询参数或请求体里 |
| 单次请求最大 100MB；走 AI 工具时要转 base64，实际约 75MB | 大文件分片上传 |
| 工具返回会被转成文本；PNG/JPEG 且不超过 5MB 时可以作为图片直接给 AI 看 | 截图接口返回小尺寸 PNG |
| 令牌里只有用户身份，没有"哪个 key / 哪个 AI" | 需要区分时，在自己的服务里发钥匙并记录 |

---

## 10. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 会话里没有 NyxID 工具 | 连接器没连上，或者是在会话开始之后才连的 | 在连接器页面确认已连接，然后新开会话 |
| 只能看到 `nyx__` 开头的工具 | 目标服务还没连接，或服务没有 OpenAPI 文档 | 用 `nyx__discover_services` 找到服务并连接；检查服务的 OpenAPI 地址 |
| `403 PERMISSION_DENIED` | NyxID 角色或权限不够 | 找平台管理员加角色（见第 8 节） |
| `401` | 身份令牌缺失、过期或受众不对 | 重新授权连接器；自己的服务检查受众配置 |
| 下载外部文件失败（`CONNECT tunnel failed, response 403` 或域名解析失败） | 云端环境的网络白名单没有放行 | 批准 Claude 提出的环境修改，或自己在环境设置里加域名 |
| 上传返回 413 | 超过 100MB | 分片上传 |
| 改了自己服务的 OpenAPI 但工具没变 | NyxID 缓存了文档（约 60 秒） | 稍等再试 |

---

## 11. 安全建议

- **不要把密钥贴进对话。** 服务的凭证保存在 NyxID 里，由 NyxID 注入；云端环境需要的密钥用环境设置里的"网络密钥"功能，不要写进环境变量或代码。
- **写操作先确认。** 部署、删除、改权限这类操作，让 Claude 先说明要做什么，确认后再执行。
- **最小权限。** 只连接需要的服务；组织服务可以设成仅组织管理员可用（`--admin-only`）。
- **代码进分支。** 云端会话的改动推送到专门的开发分支，通过合并请求合入主干。

---

## 附：本项目里用这套方式完成的事

- 读取 NyxID、chrono-cd、chrono-bucket 源码，核实平台行为，写进 [整体设计](../ARCHITECTURE.md) 第 15 节；
- 通过 NyxID 调用 chrono-cd 查询账号、组织和已有应用的配置；
- 排查存储服务 403 的原因；
- 放行 `scaniverse.com`，下载公司前厅的扫描，在云端跑通"扫描 → 方块化 → 截图对比"（见 `spikes/voxelize/`）。
