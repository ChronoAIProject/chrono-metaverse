# 部署到 chrono-cd

chrono-metaverse 部署在 chrono-cd 的 ChronoAI 组织下：项目 `metaverse`，应用 `chrono-metaverse`（设计第 14 节）。
[`app.json`](app.json) 就是 `PUT /api/v1/projects/metaverse/apps/chrono-metaverse` 的请求体，也是 `chrono-cd__put_app` 工具的参数（`project`、`app`、`org_id` 另外传）。

规格格式以 chrono-cd 的接口文档为准（`docs/protocol/api.md`、技能文件 `skills/chrono-cd/SKILL.md`），并对照了组织下已有应用（`omega/mathesis`、`integrations/frigate-events-test`）的实际配置。

## 1. 规格要点

| 服务 | 镜像 | 路由 | 暴露 | 端口 | 健康检查 | 副本 | 资源申请 / 上限 |
|---|---|---|---|---|---|---|---|
| `metaverse-web` | `ghcr.io/chronoaiproject/chrono-metaverse-web` | `/` | 公网 | 8080 | `/healthz` | 2 | 25m / 32Mi，上限 250m / 128Mi |
| `metaverse-api` | `ghcr.io/chronoaiproject/chrono-metaverse-api` | `/api` | 公网 | 8080 | `/api/healthz` | 1 | 250m / 256Mi，上限 1 核 / 1Gi |
| `metaverse-worker` | `ghcr.io/chronoaiproject/chrono-metaverse-worker` | — | 集群内（`internal`） | 8080 | `/healthz` | 1 | 500m / 3Gi，上限 2 核 / 8Gi；`/tmp` 挂 8Gi 临时盘 |

再加 MongoDB 插件（`"addons": {"mongodb": {}}`）：一个库加一个只能访问这个库的用户，连接串和库名由 `addon_env` 注入接口服务和处理服务的 `MONGODB_URI`、`MONGODB_DATABASE`。

**为什么服务名带 `metaverse-` 前缀**：chrono-cd 里服务名在同一个主人（ChronoAI 组织）的所有应用之间必须唯一，否则 `409 service_name_taken`。组织里的 `omega/mathesis` 已经占用了 `web` 和 `worker`。

**服务之间怎么访问**：同一个主人的服务在集群里按服务名互相访问，地址是 `http://<服务名>:<端口>`（也可以用 `:80`）。所以网站镜像里 nginx 把 `/api/` 转给 `http://metaverse-api:8080`（[`web/nginx.conf`](../../web/nginx.conf)，地址写死，与这里的服务名一致）。公网上 `/api` 开头的请求由平台网关按最长前缀直接转给 `metaverse-api`，nginx 的转发只是兜底；页面始终同源访问接口。

**探针**：chrono-cd 用 `health_path` 同时做就绪、存活、启动探针和负载均衡健康检查（存活每 15 秒、超时 5 秒；启动最多等 300 秒）。接口服务建好索引前 `/api/healthz` 返回 503，平台不会把流量导过来。网站用 nginx 自己的 `/healthz`（不读文件、不记访问日志）。处理服务不对外，`expose: internal` 只建集群内地址，不进公网路由。

**镜像要求**（Dockerfile 在 [`infra/`](..) 下）：只能来自 ghcr.io；数字形式的非 root 用户（api 65532、web 101、worker 10001）；linux/amd64。chrono-cd 每次应用规格都把标签解析成摘要并固定下来。

### 配额

组织配额由组织下所有应用共用，默认 8 核 / 16Gi / 40 个容器。chrono-cd 按"Σ 副本 × 申请 + 本应用申请最大的那个服务再算一份（滚动更新的新副本）"计算：

| | CPU | 内存 | 容器 |
|---|---|---|---|
| 本应用申请 | 2×25m + 250m + 500m = 800m | 2×32Mi + 256Mi + 3Gi ≈ 3.31Gi | 4 |
| 滚动更新预留 | 500m（worker） | 3Gi（worker） | 1 |
| **合计** | **1.3 核** | **约 6.31Gi** | **5** |

按 2026-11-09 查到的组织现有应用估算，已用约 2.8 核 / 5.3Gi / 11 个容器，放得下。部署前仍要按第 3 步实际查一次。

### 环境变量（不含任何密钥）

第一版**没有应用密钥**（没有 `secret_keys`）：数据库连接由插件注入，身份令牌只用 NyxID 公钥校验。

`metaverse-api`（完整说明见 [`api/README.md`](../../api/README.md)）：

| 变量 | 值 | 说明 |
|---|---|---|
| `MONGODB_URI`、`MONGODB_DATABASE` | 插件注入 | `addon_env` |
| `BIND` | `0.0.0.0:8080` | |
| `PUBLIC_BASE_URL` | `https://chrono-metaverse-chronoai.apps.nyxid.ai` | **预估值**：以第一次部署返回的 `url` 为准，不一致就改（第 4 步） |
| `NYXID_BASE_URL` | `https://nyx-api.chrono-ai.fun` | 查组织角色用 |
| `NYXID_JWKS_URL` | `https://api.nyxid.ai/.well-known/jwks.json` | 取自 NyxID `/.well-known/openid-configuration` 的 `jwks_uri` |
| `NYXID_JWT_ISSUER` | `https://nyx-api.chrono-ai.fun` | 同上的 `issuer`（两个 NyxID 域名返回的都是它） |
| `NYXID_JWT_AUDIENCE` | `urn:chrono-metaverse:api` | 必须和 NyxID 注册时的 `identity_jwt_audience` 一字不差 |
| `ALLOWED_NYX_SERVICE_IDS` | `pending-nyxid-registration` | **占位值**：NyxID 注册要先有应用地址，所以第一次部署时还没有服务编号。占位值能让服务正常启动（网站和公开读接口可用），但所有 `/api/v1/*` 都会 401，直到第 7 步换成真实编号 |
| `METAVERSE_REQUIRE_PERMISSIONS` | `false` | 第一步不启用功能级权限 |
| `UPLOAD_MAX_SCAN_BYTES` / `UPLOAD_MAX_MODEL_BYTES` / `UPLOAD_MAX_TEXTURE_BYTES` / `UPLOAD_MAX_OPS_BYTES` / `UPLOAD_MAX_SCRIPT_BYTES` | 1GiB / 50MiB / 50MiB / 256MiB / 4MiB | 各用途上传的大小上限（与处理服务的上限一致；改大时处理服务的 `WORKER_MAX_*` 也要改） |
| `UPLOAD_MAX_TEXTURE_SIDE` | `8192` | 图片单边像素上限（第 0 片按文件头检查） |
| `UPLOAD_MAX_OPEN_PER_SPACE` | `16` | 每个空间进行中的上传数，超过返回 429 |
| `UPLOAD_MAX_CONCURRENT_PARTS` | `8` | 每个副本同时处理的分片数（每片最多 32MiB 在内存里，与 `memory_limit` 一起考虑） |
| `JOB_MAX_PENDING_PER_SPACE` | `8` | 每个空间排队和运行中的任务数，超过返回 429 |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` / `PUBLIC_RATE_LIMIT_BURST` | `12000` / `2000` | 公开 JSON 接口的限流额度。**目前按网关地址计、所有访客共用**（见下面"公开接口限流"），所以比接口服务按单个访客设计的默认值（1200 / 200）高 10 倍 |
| `PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE` / `PUBLIC_BLOB_RATE_LIMIT_BURST` | `120000` / `20000` | 区块和资源（`/api/public/chunks/`、`/assets/`）的限流额度，同上（默认 12000 / 2000） |
| `TRUSTED_CLIENT_IP_HEADER` | **不设（待向平台确认）** | 可信的客户端地址请求头。确认之前不设，接口服务按 TCP 连接地址限流，连接地址是网关或 nginx 的地址（见下面"公开接口限流"） |
| `RUST_LOG` | `info` | |

#### 公开接口限流（待向平台确认可信的客户端地址头）

设计 8.2 要求公开接口按来源地址限流，并在第 0 阶段向平台确认哪个请求头里是可信的客户端地址（设计 16.2）。确认之前的情况：

- **链路**：公网请求先到 Cloudflare，再到平台的 Google 负载均衡，最后到 `metaverse-api`（2026-11-09 实测 `https://chrono-metaverse-chronoai.apps.nyxid.ai/api/healthz` 的响应头：`server: cloudflare`、`cf-ray`、`via: 1.1 google`）；`/api` 走 nginx 兜底时还要再经过网站的 nginx。
- **所以限流按网关地址计**：接口服务默认用 TCP 连接地址当来源，这个地址是 Google 前端代理（`35.191.0.0/16`、`130.211.0.0/22`）或 nginx 副本的地址，所有访客落进少数几个桶，限流只能当兜底。接口服务按单个访客设计的默认额度（每分钟 1200、突发 200）在这种情况下几十个同时在线的访客就会触发 429，所以 `app.json` 显式调高了 `PUBLIC_*` 四个额度。
- **额度怎么来的**：网站"现在"模式每个访客每 5 秒带 If-None-Match 查一次 `/head`（多数 304），有变化时再拉增量事件、状态，约每分钟 24–36 次；打开一个空间约 10–20 次 JSON 请求，再加几百个区块和资源（前厅 5 厘米格约 155–195 个区块）。每分钟 12000 次按 200 个同时在线访客留了余量，突发 2000 约等于 100 个访客同时打开；区块和资源按同样的人数放大 10 倍。真正保护进程的是每个空间的并发上限（`PUBLIC_SPACE_CONCURRENCY`，默认 64）和进程内缓存，这里的额度只防一个来源把接口打满。
- **为什么暂时不设 `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`**：接口服务对配置的头无条件信任。只要有人能绕过 Cloudflare 直接连到平台的负载均衡，就可以每个请求写一个不同的 `cf-connecting-ip`，每次都拿到新额度，限流完全失效。所以要先向平台确认两件事：① 负载均衡只接受 Cloudflare 的流量（或者会覆盖外来的 `cf-connecting-ip`）；② `cf-connecting-ip` 原样到达容器。
- **`X-Forwarded-For` 不能用**：Google 负载均衡和 nginx 都会在后面追加地址，值是多个 IP；接口服务只认恰好一个 IP 的值，会退回连接地址。要按转发链取客户端地址（只信任来自 Google 前端代理网段的连接、跳过负载均衡自己追加的那一段，参照 CMA 的 `CHRONO_SERVER_TRUSTED_PROXY_CIDRS`），需要接口服务先支持。

平台确认之后：在 `app.json` 里设 `"TRUSTED_CLIENT_IP_HEADER": "cf-connecting-ip"`，四个 `PUBLIC_*` 可以删掉（回到按单个访客的默认额度），再用 `PATCH` 只改这几项（JSON 合并补丁里写 `null` 表示删除这一项；改完 `GET` 一次确认）：

```bash
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH --output json --data '{"services":{"metaverse-api":{"env":{
  "TRUSTED_CLIENT_IP_HEADER":"cf-connecting-ip",
  "PUBLIC_RATE_LIMIT_PER_MINUTE":null,"PUBLIC_RATE_LIMIT_BURST":null,
  "PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE":null,"PUBLIC_BLOB_RATE_LIMIT_BURST":null}}}}'
```

改完用第 6 步的命令看 `metaverse-api` 的日志：被限流时会打印"公开接口限流"。

`metaverse-worker`（完整说明见 `worker/src/metaverse_worker/config.py`）：

| 变量 | 值 | 说明 |
|---|---|---|
| `MONGODB_URI`、`MONGODB_DATABASE` | 插件注入 | `addon_env` |
| `WORKER_HEALTH_PORT` | `8080` | 健康检查端口（`/healthz`），与 `port` 一致 |
| `WORKER_JOB_MEMORY_MB` | `6144` | 重计算子进程的内存上限，要小于容器上限 8Gi |
| `PYTHONUNBUFFERED` | `1` | 日志不缓冲，立即出现在 chrono-cd 日志里 |

`metaverse-web`：不需要环境变量。

## 2. 首次部署

前提：操作者是 ChronoAI 组织的 admin（部署、写密钥、重启都要求）。下面的命令用本机的 `nyxid` 命令行（`nyxid login` 登录后）；在 Claude 会话里也可以用 chrono-cd 工具做同样的事（开发教程第 6、7 节），只是工具里只有整份替换的 `put_app`，没有局部修改。

```bash
ORG=52aa284c-b5b2-49bd-9d12-79f24772dbd7   # ChronoAI 组织编号（不是 slug）
APP=api/v1/projects/metaverse/apps/chrono-metaverse
```

### 第 1 步：推送镜像

推送到 `main` 或开发分支 `claude/happy-ritchie-oly5hx` 时，GitHub Actions 的 `Images` 工作流（[`.github/workflows/images.yml`](../../.github/workflows/images.yml)）构建三个镜像并推到 ghcr.io：

- `ghcr.io/chronoaiproject/chrono-metaverse-{api,web,worker}:<7 位提交哈希>`
- `…:<分支名>`（`/` 换成 `-`，例如 `claude-happy-ritchie-oly5hx`、`main`）
- `…:latest`（只有 `main`）

部署时**用提交哈希标签**，回滚和排查都能对上代码。

### 第 2 步：把三个包设为公开（只做一次）

第一次推送出来的包默认是私有的，chrono-cd 拉不下来（`400 image_unauthorized`）。到 GitHub 组织的 Packages 页面，分别打开 `chrono-metaverse-api`、`chrono-metaverse-web`、`chrono-metaverse-worker` → Package settings → Danger Zone → Change visibility → Public。

确认匿名可拉（返回 200 即可）：

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:chronoaiproject/chrono-metaverse-api:pull" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  https://ghcr.io/v2/chronoaiproject/chrono-metaverse-api/manifests/<提交哈希>
```

不想公开时，可以在 `PUT` 请求体里带一次 `registry_credential`（经典 PAT，`read:packages`），但这样就有一个要保管的凭证，不推荐。

### 第 3 步：查配额

```bash
nyxid proxy request chrono-cd "api/v1/account?org_id=$ORG" --output json
```

看 `quota` 和 `usage`：剩余至少要有 1.3 核、6.4Gi、5 个容器（见第 1 节）。不够就先 `POST api/v1/quota-requests` 申请，由平台管理员批准。

### 第 4 步：提交应用规格

把 `app.json` 里三个镜像的标签换成要部署的提交哈希，然后提交：

```bash
SHA=<7 位提交哈希>
sed "s/:main\"/:$SHA\"/" infra/chrono-cd/app.json > /tmp/chrono-metaverse.json
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PUT \
  --data "$(cat /tmp/chrono-metaverse.json)" --output json
```

在 Claude 会话里：让它用 `chrono-cd__put_app` 提交，参数是 `project=metaverse`、`app=chrono-metaverse`、`org_id=<ORG>`，`addons` 和 `services` 取自 `app.json`（`target_org_id` 与 `org_id` 一致）。先让它把要提交的内容给你看。

返回 `201`（新建）或 `200`（替换）。记下返回里的 `url`，如果和 `PUBLIC_BASE_URL` 的预估值不同，改掉它（chrono-cd 的 `PATCH` 是 JSON 合并补丁，只改这一项，其他字段不动）：

```bash
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH \
  --data '{"services":{"metaverse-api":{"env":{"PUBLIC_BASE_URL":"https://<返回的 url 主机名>"}}}}' --output json
```

常见失败：`400 image_not_found`（标签不存在或还没构建完）、`400 image_unauthorized`（第 2 步没做）、`409 quota_exceeded`（第 3 步）、`409 service_name_taken`（服务名被组织里别的应用占用）。

### 第 5 步：密钥

第一版不需要，跳过。以后确实要加密钥时：在规格里用 `secret_keys` 声明名字，值在**自己电脑上**写入，不要交给 AI（参数会留在对话记录里）：

```bash
# secrets.json：{"SOME_KEY":"<值>"}，不要放进仓库，用完删除
nyxid proxy request chrono-cd "$APP/services/metaverse-api/secrets?org_id=$ORG" \
  --method PUT --data @secrets.json --output json
rm secrets.json
```

### 第 6 步：查状态和日志

```bash
nyxid proxy request chrono-cd "$APP/status?org_id=$ORG" --output json            # 每 15 秒查一次，直到 phase = ready
nyxid proxy request chrono-cd "$APP/logs?service=metaverse-api&tail=200&org_id=$ORG" --output json
nyxid proxy request chrono-cd "$APP/logs?service=metaverse-worker&tail=200&org_id=$ORG" --output json
nyxid proxy request chrono-cd "$APP/telemetry/logs?preset=errors&service=metaverse-api&org_id=$ORG" --output json
```

`phase = ready` 表示公网入口已经能访问（新主机名的路由要几分钟才生效）。`pods[].reason` 里是容器自己的原因：`ImagePullBackOff`（镜像或权限）、`CrashLoopBackOff`（看日志，常见是环境变量不对，接口服务会打印"配置不可用：…"）、`OOMKilled`（调大 `memory_limit`）、`CreateContainerConfigError`（镜像用了 root 或非数字用户）。

就绪后自检：

```bash
URL=https://<应用域名>
curl -s $URL/healthz              # ok
curl -s $URL/api/healthz          # {"status":"ok"}
curl -s $URL/api/openapi.json | jq '.paths | keys'
curl -s -o /dev/null -w '%{http_code}\n' $URL/api/v1/spaces/x   # 401（没有身份令牌）
```

### 第 7 步：注册成 NyxID 服务（组织管理员，在自己电脑上）

完整命令见开发教程 [`docs/tutorials/cloud-claude-code-nyxid.md`](../../docs/tutorials/cloud-claude-code-nyxid.md) 第 9.3 节。要点：

1. `nyxid service add --custom --slug chrono-metaverse --endpoint-url "$URL" --openapi-spec-url "$URL/api/openapi.json" --auth-method none --org chronoai`；
2. 开启身份令牌（`identity_propagation_mode = jwt`，受众 `urn:chrono-metaverse:api`）和转发调用者令牌（`forward_access_token = true`，查组织角色要用，设计 9.2）；
3. 把服务编号填进接口服务的允许列表：

```bash
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH \
  --data '{"services":{"metaverse-api":{"env":{"ALLOWED_NYX_SERVICE_IDS":"<NyxID 服务编号>"}}}}' --output json
```

然后经 NyxID 调一个读接口确认链路（返回 404 `not_found` 说明身份校验已通过、空间还不存在；401 说明服务编号或受众不对）：

```bash
nyxid proxy request chrono-metaverse api/v1/spaces/front-hall --output json
```

要用 agent key 的路径参数限制时，还要请平台管理员注册成目录服务并同步接口列表，再把目录服务的编号加进 `ALLOWED_NYX_SERVICE_IDS`（逗号分隔，过渡期新旧都留着）。

### 第 8 步：导入演示数据（前厅）

1. 以组织 admin 身份建空间（管理接口，不进 AI 工具）。主人写组织的**规范编号**，不写 slug：

   ```bash
   nyxid proxy request chrono-metaverse api/v1/admin/spaces --method POST --output json \
     --data '{"id":"front-hall","name":"公司前厅","description":"演示空间","owner":{"kind":"org","id":"52aa284c-b5b2-49bd-9d12-79f24772dbd7"}}'
   ```

   返回里的 `shareToken.token` 只出现这一次，库里只存哈希。把它存进密码管理器，不要贴进对话或提交。
2. 上传前厅扫描并导入：`metaverse init front-hall` 建工作区，再在工作区里 `metaverse scan <扫描文件>`（命令行见设计 10.1 和建造教程 [`docs/tutorials/build-space.md`](../../docs/tutorials/build-space.md)）。命令行会分片上传、发起 `scan_import` 任务；在 `GET /api/v1/spaces/front-hall/jobs/{job_id}` 看进度，处理服务的日志在第 6 步的命令里看。
3. 打开 `https://<应用域名>/s/front-hall#share=<分享令牌>`，确认三种视图和时间轴。

## 3. 日常更新

新版本只换镜像标签，用 `PATCH`（不会动其他字段，也不会覆盖别人中途的部署）：

```bash
SHA=<新的 7 位提交哈希>
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH --output json --data "{\"services\":{
  \"metaverse-web\":{\"image\":\"ghcr.io/chronoaiproject/chrono-metaverse-web:$SHA\"},
  \"metaverse-api\":{\"image\":\"ghcr.io/chronoaiproject/chrono-metaverse-api:$SHA\"},
  \"metaverse-worker\":{\"image\":\"ghcr.io/chronoaiproject/chrono-metaverse-worker:$SHA\"}}}"
```

改了 `app.json` 的其他内容（环境变量、资源）时用第 4 步的 `PUT` 整份提交；`PUT` 会整份替换，提交前先 `GET` 一次，把线上手工改过的值（`PUBLIC_BASE_URL`、`ALLOWED_NYX_SERVICE_IDS`）同步回来，再带上 `If-Match: <generation>`。

滚动更新时新旧副本会同时运行（`maxUnavailable 0`、`maxSurge 1`，终止宽限 30 秒）：数据库迁移必须先扩后收，处理服务的任务靠租约和幂等重做（设计 6.4、13.1）。

## 4. 回滚

1. 找上一个正常版本：

   ```bash
   nyxid proxy request chrono-cd "$APP/revisions?org_id=$ORG&limit=10" --output json
   ```

   每个修订都带各服务的镜像和摘要。同一个标签被重新推送过时，用 `镜像名@sha256:<摘要>` 更稳。
2. 用第 3 节的 `PATCH` 把镜像换回旧标签或旧摘要（只回滚出问题的服务也可以）。
3. 用第 6 步的命令确认 `phase = ready`。

在 Claude 会话里没有 `PATCH`：先 `chrono-cd__get_app` 读出当前完整配置，只把对应服务的 `image` 换成旧版本，其他字段（全部服务、`env`、`addon_env`、`addons`、`volumes`）原样保留，再用 `chrono-cd__put_app` 提交。漏了服务，那个服务会被删掉；漏了 `addons`，MongoDB 插件会被撤掉（数据保留，但应用随即连不上数据库）。

回滚不回滚数据：如果新版本已经跑过不兼容旧版本的迁移，单纯换镜像不够，先看迁移说明。

## 5. 不要做的事

- 不要把任何密钥写进 `env`（`get_app` 会原样返回给组织成员）或 `app.json`。
- 不要 `DELETE` 应用来"重来"：删除不可恢复，带 `purge=true` 还会删掉数据库。
- 不要把 `ALLOWED_NYX_SERVICE_IDS` 改成别人的服务编号或放宽成多个不相干的编号：别人自建的连接指向本服务时，正是靠它返回 401（设计 9.1）。
