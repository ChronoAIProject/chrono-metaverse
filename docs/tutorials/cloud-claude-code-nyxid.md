# 开发教程：在云端用 Claude Code 连接 NyxID 做实际开发

这篇教程记录的是 chrono-metaverse 项目真实的开发方式：在浏览器（或手机、桌面 App）里开一个云端 Claude Code 会话，让 Claude 写代码、跑命令、推送分支；同时通过 NyxID 的 MCP，让 Claude 直接调用公司的服务，例如部署服务、存储服务和我们自己写的服务。

各服务的凭证由 NyxID 保存和注入，不会经过 Claude。但要注意：凡是你让 Claude 通过 AI 工具传进去的值，都会留在对话记录里。所以真实的应用密钥要按 7.3 节的方法自己写入。

读完你会：

1. 把 NyxID 接到 claude.ai，在云端会话里用上 NyxID 的工具；
2. 让 Claude 通过 NyxID 查询、部署 chrono-cd 上的应用；
3. 遇到权限、网络问题时知道怎么排查；
4. 把自己写的服务变成 NyxID 服务，让任何接了 NyxID 的 AI 都能调用。

### 几个词先说明

| 词 | 意思 |
|---|---|
| MCP | 一种让 AI 调用外部工具的标准协议。NyxID 提供一个 MCP 地址，接上后 AI 就能用 NyxID 的工具 |
| 连接器 | claude.ai 里配置的 MCP 接入，在网页、App 和云端会话里通用 |
| OpenAPI 文档 | 用 JSON 描述一个服务有哪些接口、参数是什么。NyxID 读这份文档，为每个接口生成一个 AI 工具 |
| operationId | OpenAPI 文档里每个接口的名字，会变成 AI 工具名的一部分 |
| 身份令牌 | NyxID 转发请求时附带的短期签名凭证，证明"这次调用来自哪个 NyxID 用户" |

---

## 1. 整体关系

```
你（浏览器 / 手机 / 桌面 App）
        │  对话
        ▼
Claude Code 云端会话 ── 一个隔离的容器：克隆好的仓库、终端、受控的网络
        │  MCP（claude.ai 连接器，登录 NyxID 授权）
        ▼
NyxID 网关 ── 认证你的身份、注入凭证、把各服务的 OpenAPI 变成 AI 工具
        ├── chrono-cd（部署服务）
        ├── Chrono Storage Service（存储服务）
        └── 你自己的服务（例如 chrono-metaverse）
```

要点：

- **Claude 不拿各服务的凭证**：Claude 只调用 NyxID 的工具，转发时由 NyxID 注入凭证。
- **云端会话是临时容器**：代码改动要提交并推送到分支，否则容器回收后就没了。
- **云端会话的网络默认受限**：只能访问包管理器（npm、PyPI 等）和已连接的 MCP 服务；访问其他网站要在"环境"里放行（见 4.1）。

---

## 2. 准备

| 需要 | 说明 |
|---|---|
| NyxID 账号 | 托管版用 Google / GitHub / Apple 登录 |
| 加入 ChronoAI 组织 | 请组织管理员发邀请链接（一次性，默认 24 小时内有效），在浏览器打开；或者在装了 NyxID 命令行工具的电脑上执行 `nyxid org join <邀请链接>` |
| 组织 admin 角色（部署和注册服务时才需要） | 在组织下部署应用（第 7 节）、注册组织服务（第 9 节）都要求你是组织的 admin；member、viewer 只能查看 |
| claude.ai 账号 | 能使用 Claude Code 云端会话（claude.ai/code） |
| GitHub 授权 | GitHub 已连接 claude.ai，仓库已安装 Claude GitHub App |

---

## 3. 第一步：把 NyxID 加成 claude.ai 连接器

1. 打开 <https://claude.ai/customize/connectors>，添加自定义连接器：
   - 名称：`NyxID`
   - 地址：`https://nyx-api.chrono-ai.fun/mcp`
2. 按提示跳转到 NyxID 登录。在授权页的服务权限区域，把最上面一行"全部服务"（All services）设为**允许**（Allow）；它默认是关闭的。这一行旁边会注明"以后连接的服务也适用"，所以之后新连接的服务（包括第 9 节自己注册的服务）都会自动可用。如果只给个别服务选允许，以后新加的服务就不会出现在连接器里。然后同意授权。

注意：

- **本机的配置不会带到云端**：在自己电脑上用 `claude mcp add` 加的 MCP 只对本机的 Claude Code 生效。云端会话只认 claude.ai 的连接器，或者仓库里提交的 `.mcp.json`。
- **连接器在会话开始时读取**：连好以后新开一个会话最稳妥。
- **想改授权范围，要先撤销旧授权**：NyxID 会记住上次的授权，只是在 claude.ai 断开再连，通常不会再弹出授权页。正确做法是：
  1. 到 NyxID 控制台的"访问与授权"页面（`/settings/consents`），在已授权应用里找到 Claude，点撤销；
  2. 回到 claude.ai 连接器页面重新连接 NyxID；
  3. 新开一个会话。
- **找不到"添加自定义连接器"**：可能是你所在的 claude.ai 团队只允许管理员添加，请找管理员。
- **地址可能变**：NyxID 计划把接口地址迁到 `https://api.nyxid.ai`，以 NyxID 控制台上显示的 MCP 地址为准。

---

## 4. 第二步：开一个云端会话

1. 打开 <https://claude.ai/code>，选择仓库（例如 `ChronoAIProject/chrono-metaverse`）和环境，开始会话。
2. 直接用中文描述任务即可，例如"读一下仓库结构，然后……"。

### 4.1 网络放行

云端环境默认只允许访问包管理器等少数地址。需要访问其他网站时，有两种办法：

- Claude 碰到被拦截的请求时，会提出修改环境并说明原因，你在弹出的确认卡片上批准即可；
- 也可以自己改：会话标题栏的环境菜单 → 编辑 → 网络访问 → 允许的域名。

本项目的真实例子：下载 Scaniverse 上的前厅扫描时被拦截了。Claude 新建了一个个人环境 `chrono-metaverse`，只多放行 `scaniverse.com`，并把当前会话切到这个环境，所有项目共用的默认环境没有改动。

### 4.2 用到其他仓库

需要读其他仓库（例如查看 NyxID 或部署服务的源码）时，直接告诉 Claude。公开仓库可以直接只读克隆；私有仓库需要你授权 Claude 访问。本项目在设计阶段就克隆了 NyxID、chrono-cd、chrono-bucket 的源码，用来核实平台行为。

### 4.3 云端会话里做不了的事

- **构建镜像**：容器里没有运行中的 Docker 服务，`docker build` 会失败。镜像交给 GitHub Actions 构建（见 7.2）。
- **调用 NyxID 账号级接口**：有些 NyxID 管理接口（例如 9.3 开启身份令牌）只接受你本人登录后的账号令牌，连接器和 API Key 都会被拒绝，要在自己电脑上做。

---

## 5. 第三步：确认 NyxID 工具可用

在会话里说："列出我在 NyxID 里已连接的服务。"

会话里一开始只显示 `nyx__` 开头的几个 NyxID 自带工具，这是正常的。各服务的工具要先搜索，再调用：

| 工具 | 作用 |
|---|---|
| `nyx__list_connected_services` | 列出已连接的服务 |
| `nyx__discover_services` | 列出还没连接、可以连接的服务 |
| `nyx__connect_service` | 连接一个服务 |
| `nyx__search_tools` | 按关键字搜索工具，返回工具名和参数格式（每次最多 25 条） |
| `nyx__call_tool` | 调用某个服务的工具：传入工具名和 JSON 格式的参数 |

本项目里的真实返回（节选）：

```
chrono-cd              （组织服务，21 个工具）
Chrono Storage Service （个人连接，12 个工具）
```

固定的调用套路：

1. 用 `nyx__search_tools` 按服务名或关键字搜索，得到工具名（格式是 `服务标识__操作名`，例如 `chrono-cd__get_account`）和参数格式；
2. 用 `nyx__call_tool`，传入 `tool_name` 和 `arguments_json`（JSON 字符串）。

一般不需要你记这些，直接说想做什么，Claude 会自己搜索和调用。

---

## 6. 实战 A：查看部署服务的账号和已有应用（只读）

对 Claude 说："用 chrono-cd 看一下我的账号、配额，以及 ChronoAI 组织下有哪些项目和应用。"

Claude 实际调用的工具：

| 工具 | 参数示例 | 得到什么 |
|---|---|---|
| `chrono-cd__get_account` | `{}` | 身份、能否部署、个人配额、所属组织及你在其中的角色 |
| `chrono-cd__list_projects` | `{"org_id": "<组织编号>"}` | 组织下的项目 |
| `chrono-cd__list_apps` | `{"project": "omega", "org_id": "<组织编号>"}` | 项目下的应用 |
| `chrono-cd__get_app` | `{"project": "...", "app": "...", "org_id": "..."}` | 应用的域名、完整配置、镜像版本、状态 |

**组织编号**（`org_id`）不是组织名，也不是 `chronoai` 这个简称，而是 `get_account` 返回的 `organizations` 列表里 `"slug": "chronoai"` 那一项的 `id`，形如 `52aa284c-...`。你可能属于多个组织，注意选对那一项。误填成 `chronoai` 时，chrono-cd 会返回 `503 platform_unavailable`，看起来像平台故障，其实是参数填错了。通常不用自己找：让 Claude 先调 `get_account`，它会自己取出这个编号。

本项目查到的信息（节选）：

- 个人配额是 2 核、4G 内存、10 个容器、20G 存储。组织下的配额更大，所以本项目部署在组织下（需要组织 admin）。
- 2026-10-27 之后新建的应用，域名形如 `https://<应用名>-<所有者>.apps.nyxid.ai`；更早的应用在 `apps.chrono-ai.fun` 下。不要自己拼域名，以创建后返回的 `url` 为准。
- 应用可以挂 MongoDB 插件；镜像只能来自 ghcr.io。

---

## 7. 实战 B：部署一个应用

### 7.1 先确认角色

在组织下创建、修改、删除应用，以及写密钥、重启，都要求你是该组织的 admin。先用 `chrono-cd__get_account` 看 `organizations` 里 ChronoAI 的 `role`：

- 不是 admin：写操作会返回 `403 Forbidden: organization admin role required to change projects`；
- 还没加入组织：返回 `404`。

这两种情况下，可以请组织管理员代为部署，或者先部署在个人名下（不传 `org_id`，按个人配额）。

部署是写操作，建议先让 Claude 把要提交的配置给你看，确认后再执行。删除应用（`chrono-cd__delete_app`）不可恢复，务必确认。

### 7.2 准备镜像

要求：
- 只能用 `ghcr.io/...` 的镜像；
- Dockerfile 里用数字形式的非 root 用户，例如 `USER 1000:1000`，写成用户名会启动失败；
- 建议构建 `linux/amd64`（平台目前的节点是这个架构）。

云端会话里不能 `docker build`（见 4.3）。让 Claude 在仓库里加一个 GitHub Actions 工作流，由 GitHub 构建和推送：

```yaml
# .github/workflows/image.yml
on:
  push: { branches: [main] }
  workflow_dispatch: {}          # 也可以在开发分支上手动触发
permissions: { contents: read, packages: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: ./apps/api
          platforms: linux/amd64
          push: true
          tags: ghcr.io/chronoaiproject/chrono-metaverse-api:${{ github.sha }}
```

第一次构建完成后，到 GitHub 组织的软件包页面打开这个包，进入设置把可见性改成公开（Public），否则部署时会报 `image_unauthorized`。镜像还没构建出来就部署，会报 `image_not_found`。

### 7.3 提交应用配置

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
      "env": { "NYXID_JWT_AUDIENCE": "urn:chrono-metaverse:api" },
      "addon_env": { "mongodb": { "uri": "MONGODB_URI", "database": "MONGODB_DATABASE" } }
    }
  }
}
```

本项目第一版**不需要任何应用密钥**：
- 数据库连接由 MongoDB 插件自动注入（`addon_env`）；
- 校验 NyxID 身份令牌只用公开的公钥；
- 写权限完全交给 NyxID（agent key 和操作范围）；分享令牌是高强度随机数，库里只存哈希，不需要额外的服务端密钥。

如果你的服务确实需要密钥，例如调用第三方接口的 key、NyxID 服务账号的密码，按下面的方式处理：

1. 在配置里用 `secret_keys` 声明名字。不要写进 `env`：`env` 的值会出现在 `get_app` 的返回里，组织成员都能看到。
2. 值在**自己电脑上**用 NyxID 命令行写入，**不要交给 Claude**：`chrono-cd__set_app_secrets` 要求把值放进调用参数，参数由 Claude 生成，值会留在对话记录里。

```bash
# secrets.json 内容：{"THIRD_PARTY_API_KEY":"<值>"}，不要放进仓库
nyxid proxy request chrono-cd \
  'api/v1/projects/metaverse/apps/chrono-metaverse/services/api/secrets?org_id=<组织编号>' \
  --method PUT --data @secrets.json --output json
rm secrets.json
```

返回里只有键名，例如 `{"service":"api","keys":["THIRD_PARTY_API_KEY"]}`。之后回到云端会话，让 Claude 查看部署状态。

其他常用操作：

| 步骤 | 工具 |
|---|---|
| 查看部署状态 | `chrono-cd__get_app_status` |
| 查看日志 | `chrono-cd__get_app_logs`、`chrono-cd__query_app_logs` |
| 回滚 | `chrono-cd__list_app_revisions` → `chrono-cd__get_app` → `chrono-cd__put_app`（见下方说明） |

- **缺密钥时**：`put_app` 返回 `422 missing_secret_keys`。这时配置已经保存，其他服务照常部署，只有缺密钥的那个服务要等密钥写入后才会启动。
- **回滚**：`put_app` 会用提交的内容**整份替换**原配置，AI 工具里也没有只改局部的工具。正确做法是：
  1. 用 `list_app_revisions` 找到上一个正常版本，记下对应服务的镜像（同一个标签被重新推送过时，用 `镜像名@sha256:...` 更稳）；
  2. 用 `get_app` 读出当前的完整配置；
  3. 只把对应服务的 `image` 换成旧版本，其他字段（全部服务、`env`、`secret_keys`、`addon_env`、`addons`）原样保留，一起用 `put_app` 提交；
  4. 用 `get_app_status` 确认部署完成。

  如果漏了服务，那个服务会被删掉；漏了 `addons`，MongoDB 插件会被撤掉，应用随即连不上数据库（数据会保留）。

---

## 8. 实战 C：排查权限问题（真实踩坑记录）

本项目测试存储服务时，调用都返回：

```
Error (403): {"error":{"code":"PERMISSION_DENIED","message":"Caller lacks the required permission"}}
```

排查过程：

1. **区分 401 和 403**：401 表示身份令牌缺失或无效（连接器没授权、令牌过期）；403 表示身份没问题，但权限不够。这里是 403，说明 NyxID 连接本身是通的。
2. **对比身份信息**：`chrono-cd__get_account` 会列出你在 NyxID 的全部角色，里面没有存储服务需要的角色。
3. **看服务源码确认**：让 Claude 克隆存储服务的源码（chrono-bucket），查到它的普通接口都要求 `chrono-bucket-user` 角色带来的权限，例如 `bucket:create`。列出全部存储桶、转移所有权这两个接口只给管理员角色。
4. **结论**：请 NyxID 平台管理员给账号加上 `chrono-bucket-user` 角色。

这类问题让 Claude 直接读服务源码定位，通常比猜快得多。

---

## 9. 实战 D：把自己的服务变成 NyxID 服务

这样做的好处：不用自己写 MCP，任何接了 NyxID 的 AI（Claude Code、Codex、Cursor……）都能直接调用你的接口；你的服务只需要校验 NyxID 的身份令牌。

### 9.1 提供 OpenAPI 文档

- **文档地址**：在公网可访问、无需登录的地址提供 OpenAPI 3.0 / 3.1 文档，并且和 9.3 里 `--openapi-spec-url` 填的地址一致。本项目的接口服务挂在 `/api` 下，所以是 `https://<你的应用域名>/api/openapi.json`。文档里只放给 AI 用的接口，不放管理接口。
- **路径要写完整**：NyxID 调用接口时，用注册时填的 `--endpoint-url` 拼上文档 `paths` 里的路径，**不看文档里的 `servers`**。所以 `paths` 要带上 `/api` 前缀，例如 `/api/v1/spaces`。如果 `paths` 只写 `/v1/...`、靠 `servers: [{url: "/api"}]` 补前缀，NyxID 会去请求 `https://<应用域名>/v1/...`，结果是 404。
- **接口名**：每个接口的 `operationId` 用小写加下划线（例如 `get_scan_status`）。NyxID 会把它转成小写，字母数字以外的字符换成 `_`，所以驼峰写法 `getScanStatus` 会变成难读的 `getscanstatus`。最终工具名是 `服务标识__转换后的名字`，例如 `chrono-metaverse__get_scan_status`。`summary` / `description` 会变成 AI 看到的工具说明。
- **二进制上传**：用 `application/octet-stream`，在 AI 工具里会变成 base64 文本字段；不要用 multipart 表单。
- **生成文档**：Bun + Hono 可以用 `@hono/zod-openapi` 自动生成。

### 9.2 校验 NyxID 身份令牌

chrono-cd 上的应用公网直接可访问，前面没有 NyxID 把关，所以服务要自己校验 NyxID 转发时附带的 `X-NyxID-Identity-Token`：

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

function requireEnv(name: string): string {
  const v = process.env[name];
  // 必须启动即失败：jose 在 issuer / audience 为空时会直接跳过检查，等于不校验
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

// 前两个取值以 https://nyx-api.chrono-ai.fun/.well-known/openid-configuration 为准
const jwks = createRemoteJWKSet(new URL(requireEnv("NYXID_JWKS_URL")));  // = jwks_uri
const ISSUER = requireEnv("NYXID_JWT_ISSUER");                           // = issuer
const AUDIENCE = requireEnv("NYXID_JWT_AUDIENCE");                       // = 本服务的 identity_jwt_audience（见 9.3）

export async function verifyNyxIdentity(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ["RS256"], issuer: ISSUER, audience: AUDIENCE, clockTolerance: 5,
  });
  if (!payload.sub) throw new Error("缺少 sub");
  // 只接受身份令牌：NyxID 的访问令牌带 token_type，身份令牌没有，但一定带 nyx_service_id
  if (payload.token_type !== undefined || typeof payload.nyx_service_id !== "string") {
    throw new Error("不是 NyxID 身份令牌");
  }
  return payload;  // 含 sub、roles、groups、permissions、nyx_service_id、jti
}
```

- **受众填你自己服务的值，绝不能填 NyxID 的地址。** NyxID 的访问令牌和身份令牌用同一把密钥签名，签发方也相同，只靠受众区分。
- **有效期很短**：令牌只有 60 秒有效，所以要留一点时钟容差（上面是 5 秒）。每个请求都要校验。
- **不信任明文头**：绝不信任 `X-NyxID-User-Id` 这类明文头，公网上谁都能伪造。
- **还要补的两项**：
  - 固定服务编号：令牌里的 `nyx_service_id` 必须是你注册的那条服务；
  - 防重放：按 `jti` 去重。

  做法见 [整体设计](../ARCHITECTURE.md) 9.1 节。
- **参考实现**：chrono-bucket 的 `src/auth/verifier.ts` 和 `src/middleware/nyxidAuth.ts`（它的环境变量也叫 `NYXID_JWT_ISSUER` / `NYXID_JWT_AUDIENCE`）。

### 9.3 在 NyxID 注册服务

以下在**自己电脑上**做（macOS / Linux；Windows 请在 WSL 的 Ubuntu 终端里操作）。先安装 NyxID 命令行工具并登录：

```bash
# 安装 nyxid 命令行（只装客户端，不需要 Docker）
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ChronoAIProject/NyxID/main/skills/nyxid/scripts/install.sh)"

nyxid login        # 打开浏览器登录；默认就是公司的 NyxID，不用加参数
nyxid whoami       # 确认登录的是你自己的账号
nyxid org list     # 应有 chronoai 这一行，并且你的角色是 admin
```

注册为组织服务：

```bash
nyxid service add --custom \
  --slug chrono-metaverse \
  --label "chrono-metaverse" \
  --endpoint-url "https://<你的应用域名>" \
  --openapi-spec-url "https://<你的应用域名>/api/openapi.json" \
  --auth-method none \
  --org chronoai
```

`--endpoint-url` 加上 `paths` 里的路径，就是 NyxID 实际请求的地址。

然后开启身份令牌转发。命令行和 NyxID 网页都还没有这个开关，要直接调用 NyxID 接口：

```bash
nyxid service show chrono-metaverse   # 输出里的 ID 就是要用的编号
nyxid whoami                          # 顺便刷新登录状态（账号令牌有效期较短）
curl -X PUT "https://nyx-api.chrono-ai.fun/api/v1/keys/<上面的 ID>" \
  -H "Authorization: Bearer $(cat ~/.nyxid/access_token)" \
  -H "Content-Type: application/json" \
  -d '{"identity_propagation_mode":"jwt","identity_jwt_audience":"urn:chrono-metaverse:api"}'
```

- 这一步只能用 `nyxid login` 登录后的账号令牌；NyxID API Key 和 Claude 的 NyxID 连接器都会被这个接口拒绝，所以不能交给云端会话里的 Claude 做。
- `identity_jwt_audience` 要和服务的环境变量 `NYXID_JWT_AUDIENCE` 一字不差。不设置时默认等于 `--endpoint-url`。

### 9.4 回到云端会话验证

在会话里说："搜索 chrono-metaverse 的工具，调用一个只读接口试试。"

- **链路通了**：能搜到具体接口对应的工具（例如 `chrono-metaverse__get_scan_status`），并且调用后返回真实数据，说明 NyxID 读到了 OpenAPI 文档，整条链路是通的。
- **只搜到一个 `chrono-metaverse__request`**：说明 NyxID 没读到文档，见第 10 节。

### 9.5 经过 NyxID 代理时的限制

| 限制 | 对接口设计的影响 |
|---|---|
| 自定义请求头会被丢掉（只转发 `If-Match`、`Idempotency-Key`、`Range` 等标准头） | 参数放在路径、查询参数或请求体里 |
| 单次请求最大 100MB（服务端限制）。走 AI 工具时，二进制要由 Claude 把 base64 逐字写进工具参数，受模型单次输出长度限制，实际只适合几十 KB 以内的小文件；云端容器里的文件没法直接附到 AI 工具调用上 | 大文件不要走 AI 工具：用命令行或脚本分片上传 |
| 工具返回会被转成文本；PNG、JPEG、GIF、WebP 图片不超过 5MB、状态码成功且文件头和类型一致时，可以作为图片直接给 AI 看 | 截图接口返回小尺寸 PNG，`Content-Type` 写对 |
| 令牌里只有用户身份，看不出"哪个 key、哪个 AI" | 用 NyxID agent key 的操作范围把不同 agent 限制到不同路径，按路径区分来源；同时等 NyxID 在令牌里加上 agent key 编号（见整体设计 9.5、9.6 节） |

---

## 10. 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 会话里没有任何 `nyx__` 工具 | 连接器没连上，或者是在会话开始之后才连的 | 在连接器页面确认已连接，然后新开会话 |
| `nyx__search_tools` 搜不到某个服务的工具 | 服务没连接；或授权时没把"全部服务"设为允许，只选了部分服务 | 用 `nyx__list_connected_services` 确认；没有就用 `nyx__discover_services` / `nyx__connect_service` 连接；授权范围不对就按第 3 节撤销后重新授权，再新开会话 |
| 某服务只搜到一个 `<服务标识>__request` 工具 | 服务没配 OpenAPI 地址，或者 NyxID 取不到、解析不了它的文档，于是退化成一个通用请求工具 | 检查 `--openapi-spec-url` 能否从公网访问、内容是否是合法的 OpenAPI 且至少有一个接口；改完等约 60 秒缓存过期 |
| chrono-cd 返回 `403 forbidden`（organization admin role required） | 你在该组织不是 admin | 找组织管理员（见 7.1） |
| 存储服务返回 `403 PERMISSION_DENIED` | 缺少 NyxID 角色或权限 | 找平台管理员加角色（见第 8 节） |
| `401` | 身份令牌缺失、过期或受众不对 | 重新授权连接器；自己的服务检查受众配置 |
| chrono-cd 返回 `503 platform_unavailable` | `org_id` 填成了组织名或简称 | 用组织编号（见第 6 节） |
| 下载外部文件失败（`CONNECT tunnel failed, response 403` 或域名解析失败） | 云端环境的网络白名单没有放行 | 批准 Claude 提出的环境修改，或自己在环境设置里加域名 |
| 上传返回 413 | 超过 100MB | 分片上传 |
| 改了自己服务的 OpenAPI，但工具没变 | NyxID 缓存了文档（约 60 秒） | 稍等再试 |

---

## 11. 安全建议

- **不要把密钥贴进对话**：
  - 服务的凭证保存在 NyxID 里，由 NyxID 注入；
  - 应用的密钥在自己电脑上用命令行写入（7.3）；
  - 云端环境需要的 API 密钥，用环境设置里的"网络密钥"功能保存，不要写进环境变量或代码。
- **写操作先确认**：部署、删除、改权限这类操作，让 Claude 先说明要做什么，确认后再执行。
- **最小权限**：只连接需要的服务；组织服务可以设成仅组织 admin 可用（注册时加 `--admin-only`）。
- **代码进分支**：云端会话的改动推送到专门的开发分支，通过合并请求合入主干。

---

## 附：本项目里用这套方式完成的事

- 读取 NyxID、chrono-cd、chrono-bucket 的源码核实平台行为，写进 [整体设计](../ARCHITECTURE.md) 第 15 节；
- 通过 NyxID 调用 chrono-cd，查询账号、组织和已有应用的配置；
- 排查存储服务 403 的原因；
- 放行 `scaniverse.com`，下载公司前厅的扫描，在云端跑通"扫描 → 方块化 → 截图对比"（见 `spikes/voxelize/`）。
