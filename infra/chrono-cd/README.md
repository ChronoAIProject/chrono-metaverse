# 部署到 chrono-cd

chrono-metaverse 部署在 chrono-cd 的 ChronoAI 组织下：项目 `metaverse`，应用 `chrono-metaverse`（设计第 14 节）。
[`app.json`](app.json) 就是 `PUT /api/v1/projects/metaverse/apps/chrono-metaverse` 的请求体，也是 `chrono-cd__put_app` 工具的参数（`project`、`app`、`org_id` 另外传）。

规格格式以 chrono-cd 的接口文档为准（`docs/protocol/api.md`、技能文件 `skills/chrono-cd/SKILL.md`），并对照了组织下已有应用（`omega/mathesis`、`integrations/frigate-events-test`）的实际配置。

改 `app.json` 后先跑静态检查（持续集成里也跑）：`node infra/chrono-cd/check-app.mjs`。它检查处理服务的线程数和内存上限、接口服务的限流额度和可信地址头、README 的环境变量表和密钥是否列全、`infra/dev/up.sh` 是否设了同样的线程变量，以及演示数据的种子（[`demo-seed.json`](demo-seed.json)）和接口服务的 `METAVERSE_DEMO_SEED` 是否一致、种子本身是否合法（第 8 步）；测试在 `check-app.test.mjs`（`node --test infra/chrono-cd/*.test.mjs`）。

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

### 环境变量与密钥

只有一个应用密钥：接口服务的 `METAVERSE_DEMO_SHARE_TOKEN`（演示空间的分享令牌原文，在规格的 `secret_keys` 里声明，值用 `set_app_secrets` 设置，见第 5 步）。`env` 里没有任何密钥：数据库连接由插件注入，身份令牌只用 NyxID 公钥校验。

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
| `METAVERSE_DEMO_SEED` | [`demo-seed.json`](demo-seed.json) 压缩成的一行 | 部署配置种子：接口服务启动、建好索引后在后台建演示空间 `chronoai-lobby` 并导入前厅扫描（第 8 步）。改种子时两处一起改，`check-app.mjs` 检查一致 |
| `METAVERSE_DEMO_SHARE_TOKEN` | **密钥**（`secret_keys`，不在 `env` 里） | 演示空间的分享令牌原文，接口服务只存它的 sha256、不写日志；用 `set_app_secrets` 设置（第 5 步）。种子是凭链接查看（`unlisted`）时必须有，缺了接口服务启动失败 |
| `RUST_LOG` | `info` | |

种子要从 `scaniverse.com` 下载扫描（约 6MB），所以接口服务需要能访问公网（chrono-cd 默认 `egress` 允许）；下载的文件在内存里核对、打包，内存峰值约为文件总大小的两倍，`memory_limit` 1Gi 足够。

#### 公开接口限流（待向平台确认可信的客户端地址头）

设计 8.2 要求公开接口按来源地址限流，并在第 0 阶段向平台确认哪个请求头里是可信的客户端地址（设计 16.2）。确认之前的情况：

- **链路**：公网请求先到 Cloudflare，再到平台的 Google 负载均衡，最后到 `metaverse-api`（2026-11-09 实测 `https://chrono-metaverse-chronoai.apps.nyxid.ai/api/healthz` 的响应头：`server: cloudflare`、`cf-ray`、`via: 1.1 google`）；`/api` 走 nginx 兜底时还要再经过网站的 nginx。
- **所以限流按网关地址计**：接口服务默认用 TCP 连接地址当来源，这个地址是 Google 前端代理（`35.191.0.0/16`、`130.211.0.0/22`）或 nginx 副本的地址，所有访客落进少数几个桶，限流只能当兜底。接口服务按单个访客设计的默认额度（每分钟 1200、突发 200）在这种情况下几十个同时在线的访客就会触发 429，所以 `app.json` 显式调高了 `PUBLIC_*` 四个额度。
- **额度怎么来的**：网站"现在"模式每个访客每 5 秒带 If-None-Match 查一次 `/head`（多数 304），有变化时再拉增量事件、状态，约每分钟 24–36 次；打开一个空间约 10–20 次 JSON 请求，再加几百个区块和资源（前厅 5 厘米格约 155–195 个区块）。每分钟 12000 次按 200 个同时在线访客留了余量，突发 2000 约等于 100 个访客同时打开；区块和资源按同样的人数放大 10 倍。真正保护进程的是每个空间的并发上限（`PUBLIC_SPACE_CONCURRENCY`，默认 64）和进程内缓存，这里的额度只防一个来源把接口打满。
- **为什么暂时不设 `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`**：接口服务对配置的头无条件信任。只要有人能绕过 Cloudflare 直接连到平台的负载均衡，就可以每个请求写一个不同的 `cf-connecting-ip`，每次都拿到新额度，限流完全失效。所以要先向平台确认两件事：① 负载均衡只接受 Cloudflare 的流量（或者会覆盖外来的 `cf-connecting-ip`）；② `cf-connecting-ip` 原样到达容器。
- **`X-Forwarded-For` 不能用**：Google 负载均衡和 nginx 都会在后面追加地址，值是多个 IP；接口服务只认恰好一个 IP 的值，会退回连接地址（`check-app.mjs` 也会拒绝把它配成可信头）。要按转发链取客户端地址（只信任来自 Google 前端代理网段的连接、跳过负载均衡自己追加的那一段，参照 CMA 的 `CHRONO_SERVER_TRUSTED_PROXY_CIDRS`），需要接口服务先支持。

平台确认之后：在 `app.json` 里设 `"TRUSTED_CLIENT_IP_HEADER": "cf-connecting-ip"`，四个 `PUBLIC_*` 可以删掉（回到按单个访客的默认额度），跑一遍 `node infra/chrono-cd/check-app.mjs`，再用 `PATCH` 只改这几项（JSON 合并补丁里写 `null` 表示删除这一项；改完 `GET` 一次确认）：

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
| `WORKER_JOB_MEMORY_MB` | `6144` | 重计算子进程的内存上限，要小于容器上限 8Gi。这是**地址空间**上限（`RLIMIT_AS`），不是常驻内存，线程栈和预留的堆都算在里面（见下面"处理服务的线程数"） |
| `OPENBLAS_NUM_THREADS` | `2` | 与 `cpu_limit` 一致。numpy、scipy 各带一份 OpenBLAS，不设时按**节点**可见核数建线程 |
| `OMP_NUM_THREADS` | `2` | 同上，给 OpenMP 库（OpenBLAS 在没有自己的变量时也读它） |
| `MALLOC_ARENA_MAX` | `2` | glibc 的分配区个数上限；不设时最多 8×节点核数个，每个预留 64MB 地址空间 |
| `PYTHONUNBUFFERED` | `1` | 日志不缓冲，立即出现在 chrono-cd 日志里 |

#### 处理服务的线程数

重计算子进程用 `resource.setrlimit(RLIMIT_AS)` 限内存（`worker/src/metaverse_worker/jobs/isolate.py`），限的是虚拟地址空间。numpy 和 scipy 各自带一份 OpenBLAS，**导入时**就按可见核数建线程，每个线程约占 41MB 地址空间（8MiB 栈加缓冲区）。Kubernetes 只用 CFS 配额限 CPU，容器里看到的是整台节点的核数，与 `cpu_limit` 无关：不设线程数时，32 核节点上子进程一启动就占掉约 2.5GB，64 核节点约 5.2GB，6144MB 的额度只剩约 1GB；2 核配额下跑上百个 BLAS 线程还会被 CFS 严重限流，任务更容易撞上 1800 秒超时。

2026-11-09 在 4 核机器上实测（numpy 2.5.4、scipy 1.18.1，只导入 `numpy`、`scipy.linalg`、`scipy.spatial`，读 `/proc/self/status`）：

| 设置 | 线程数 | VmSize |
|---|---|---|
| `OPENBLAS_NUM_THREADS=1` | 1 | 227MB |
| `OPENBLAS_NUM_THREADS=2` | 3 | 307MB |
| 不设（4 核） | 7 | 471MB |
| 只设 `OMP_NUM_THREADS=2` | 3 | 307MB |

每多一个线程约 +40MB，两份 OpenBLAS 各算一次。线程数设成 `cpu_limit`（2），地址空间与节点大小无关。Dockerfile 按约定不写 `ENV`，所以这几个变量只在这里设；`infra/dev/up.sh` 本地也设同样的值，本地测的内存和线上一致。`worker/README.md` 的内存数据（RSS 1,263MB）是在 4 核机器上测的，上线后按子进程实测的 `VmPeak` 复核 `WORKER_JOB_MEMORY_MB`。改 `cpu_limit` 时同步改这两个线程数（`check-app.mjs` 会检查线程数不超过 `cpu_limit`）。

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

先跑 `node infra/chrono-cd/check-app.mjs`，再把 `app.json` 里三个镜像的标签换成要部署的提交哈希，然后提交：

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

规格里声明了密钥 `METAVERSE_DEMO_SHARE_TOKEN`：第一次提交时密钥还没设置，chrono-cd 返回 `422 missing_secret_keys`——这表示规格**已保存**、等密钥，接着做第 5 步，设置后 chrono-cd 立即应用。

### 第 5 步：密钥（演示空间的分享令牌）

只有一个：接口服务的 `METAVERSE_DEMO_SHARE_TOKEN`，演示空间 `chronoai-lobby`（凭链接查看）的分享令牌原文。接口服务只用它算 sha256 存进空间文档，不写日志；演示链接是 `/s/chronoai-lobby#share=<令牌>`（第 8 步）。

1. 在自己电脑上生成（256 位随机数，base64url，43 个字符；接口服务要求 32–256 个 `A–Z a–z 0–9 - _`），存进密码管理器：

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

2. 用 chrono-cd 的 `set_app_secrets` 设置（服务 `metaverse-api`），chrono-cd 会重新应用：

   - Claude 会话里：让它调用 `chrono-cd__set_app_secrets`，参数 `project=metaverse`、`app=chrono-metaverse`、`service=metaverse-api`、`org_id=<ORG>`、`body={"METAVERSE_DEMO_SHARE_TOKEN": "<令牌>"}`。令牌会留在对话记录里；它本来就要放进分享出去的演示链接，只能读这个演示空间，可以接受。别的密钥不要这样做；
   - 或者在自己电脑上用同一个接口（值不经过 AI）：

     ```bash
     # secrets.json：{"METAVERSE_DEMO_SHARE_TOKEN":"<令牌>"}，不要放进仓库，用完删除
     nyxid proxy request chrono-cd "$APP/services/metaverse-api/secrets?org_id=$ORG" \
       --method PUT --data @secrets.json --output json
     rm secrets.json
     ```

令牌在空间**第一次建成时**写入（只存哈希）。之后改密钥不会改已有空间的令牌：要换令牌，NyxID 注册好以后用管理接口轮换（`POST /api/v1/admin/spaces/chronoai-lobby/share-tokens`，新令牌只返回一次），或者删掉空间让种子按新密钥重建（第 8 步）。

以后再加别的密钥：在规格里用 `secret_keys` 声明名字，值同样用 `set_app_secrets` 写入，不要写进 `env` 或仓库（`get_app` 会把 `env` 原样返回给组织成员）。

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

### 第 8 步：演示数据（部署配置种子，自动完成）

写接口 `/api/v1` 只认 NyxID 身份令牌，第 7 步做完之前没法经接口建空间、上传扫描。所以演示空间由部署配置驱动（设计 9.2"部署配置种子是运维行为"）：[`demo-seed.json`](demo-seed.json) 压缩成一行放在接口服务的 `METAVERSE_DEMO_SEED`，接口服务每次启动、建好索引后在后台执行一次，**不经过任何网络接口**：

1. 空间 `chronoai-lobby` 已存在：是种子以前建的、这个导入版本（`revision`）的任务也建过 → 什么都不做；不是种子建的（例如有人经管理接口建了同名空间）→ 也不碰；
2. 从 Scaniverse 下载 `mesh.drc`、`tex.jpg`，核对大小和 sha256，打包成 zip（网格 + 贴图，和 Scaniverse 导出的一样）；不对就不建空间；
3. 建空间：主人是 ChronoAI 组织，归属证据的依据是 `operator_seed`（核验人 `system:demo-seed`），凭链接查看，分享令牌是第 5 步设置的密钥（只存哈希）；第一次提交照常写 `_space` 锚点和通用方块表；
4. 扫描登记成资源，插入 `scan_import` 任务（发起者 `system:demo-seed`）；处理服务领取后自动对齐、生成网页用模型、重建结构和物体（4 核机器实测约 1 分钟）。

失败（下载不了、数据库暂时不可用）按 10 秒、30 秒、90 秒、270 秒重试，最后记错误日志，接口服务照常提供服务。多副本同时启动也只建一次（空间编号和任务编号都是唯一键）。

**确认**（第 6 步的日志命令）：接口服务日志里有 `部署配置种子完成 … outcome=Created`（之后重启是 `AlreadyDone`），处理服务日志里有 `任务 job_… 结束：done`。然后打开演示链接：

```
https://<应用域名>/s/chronoai-lobby#share=<第 5 步的令牌>
```

不带令牌或令牌不对，公开接口一律 404。也可以只查头部（`seq` ≥ 2 说明扫描已导入）：

```bash
curl -s -H "Authorization: Share <令牌>" https://<应用域名>/api/public/spaces/chronoai-lobby/head
```

**物体提示的坐标**：种子里的 `hints`（物体中心、尺寸、类别）必须是处理服务 `scan_import` 实际对齐出来的空间坐标。`worker/scripts/lobby_hints.json` 是在 `reconstruct_lobby.py` 的坐标系里标的（对齐方法不同，前厅差约 29 厘米平移和 0.09° 倾斜），所以由 [`worker/scripts/demo_seed_hints.py`](../../worker/scripts/demo_seed_hints.py) 用处理服务的对齐换算后写进 `demo-seed.json`。本地实测：换算后家具区平均偏差 3.29 厘米（43 个物体）；不换算是 3.96 厘米，而且沙发、杂物被重复识别（61 个物体）。

**重新导入**（换扫描、改提示、处理服务的重建改进了想重跑）：

1. 改 `demo-seed.json`，把 `revision` 加一（换了扫描或对齐变了就先跑一遍 `demo_seed_hints.py`）；
2. 同步 `app.json`：`node infra/dev/demo-seed.mjs compact infra/chrono-cd/demo-seed.json` 的输出就是 `METAVERSE_DEMO_SEED` 的值，再跑 `node infra/chrono-cd/check-app.mjs`；
3. 只改这一项（滚动更新会重启接口服务，种子在同一个空间里再建一个导入任务，空间和演示链接不变）：

   ```bash
   SEED=$(node infra/dev/demo-seed.mjs compact infra/chrono-cd/demo-seed.json)
   nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH --output json \
     --data "$(jq -n --arg seed "$SEED" '{services:{"metaverse-api":{env:{METAVERSE_DEMO_SEED:$seed}}}}')"
   ```

   没改配置、只想重新执行一次种子（例如上次下载失败、重试次数用完）：`restart_app` 重启接口服务即可，已经建过的不会重复。

**从头重建**（连空间一起）：第 7 步做完以后，组织 admin 用管理接口删空间（`DELETE /api/v1/admin/spaces/chronoai-lobby?confirm=chronoai-lobby`），再重启接口服务，种子按当前配置和密钥重建（分享令牌是当时的密钥）。

**不再要演示数据**：从 `app.json` 删掉 `METAVERSE_DEMO_SEED`（连同 `demo-seed.json`、`secret_keys` 里的令牌），已建的空间留着，要删用上面的管理接口。

第 7 步做完以后，别的空间照常经接口建：以组织 admin 身份 `POST /api/v1/admin/spaces`（主人写组织的**规范编号**），再用命令行 `metaverse init <空间>`、`metaverse scan <扫描文件>`（设计 10.1、建造教程 [`docs/tutorials/build-space.md`](../../docs/tutorials/build-space.md)）。

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

- 不要把任何密钥写进 `env`（`get_app` 会原样返回给组织成员）或 `app.json`，包括演示空间的分享令牌 `METAVERSE_DEMO_SHARE_TOKEN`（它只在 `secret_keys` 里声明名字）。
- 不要 `DELETE` 应用来"重来"：删除不可恢复，带 `purge=true` 还会删掉数据库。
- 不要把 `ALLOWED_NYX_SERVICE_IDS` 改成别人的服务编号或放宽成多个不相干的编号：别人自建的连接指向本服务时，正是靠它返回 401（设计 9.1）。
