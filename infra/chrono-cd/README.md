# 部署到 chrono-cd

chrono-metaverse 部署在 chrono-cd 的 ChronoAI 组织下：项目 `metaverse`，应用 `chrono-metaverse`（设计第 14 节）。
[`app.json`](app.json) 就是 `PUT /api/v1/projects/metaverse/apps/chrono-metaverse` 的请求体，也是 `chrono-cd__put_app` 工具的参数（`project`、`app`、`org_id` 另外传）。

规格格式以 chrono-cd 的接口文档为准（`docs/protocol/api.md`、技能文件 `skills/chrono-cd/SKILL.md`），并对照了组织下已有应用（`omega/mathesis`、`integrations/frigate-events-test`）的实际配置。

改 `app.json` 后先跑静态检查（持续集成里也跑）：`node infra/chrono-cd/check-app.mjs`。它检查规格里只有网站和接口服务两个服务（处理服务已下线，出现 `metaverse-worker` 就报错）、每个服务的镜像都按摘要固定（第 1 步"镜像按摘要固定"）、接口服务的限流额度和可信地址头、内存预算用到的上限和缓存配置都显式写出（第 1 节"内存预算"）、README 的环境变量表和密钥是否列全，以及演示数据的种子（[`demo-seed.json`](demo-seed.json)）和接口服务的 `METAVERSE_DEMO_SEED` 是否一致、种子本身是否合法、`METAVERSE_DEMO_SEED_HOSTS` 是否写出并与 `infra/dev/up.sh` 的默认值相同（第 8 步）；测试在 `check-app.test.mjs`（`node --test infra/chrono-cd/*.test.mjs`）。镜像换版本用 [`pin-images.mjs`](pin-images.mjs) 生成规格或补丁（测试在 `pin-images.test.mjs`）。

## 1. 规格要点

| 服务 | 镜像 | 路由 | 暴露 | 端口 | 健康检查 | 副本 | 资源申请 / 上限 |
|---|---|---|---|---|---|---|---|
| `metaverse-web` | `ghcr.io/chronoaiproject/chrono-metaverse-web` | `/` | 公网 | 8080 | `/healthz` | 2 | 25m / 32Mi，上限 250m / 128Mi |
| `metaverse-api` | `ghcr.io/chronoaiproject/chrono-metaverse-api` | `/api` | 公网 | 8080 | `/api/healthz` | 1 | 250m / 384Mi，上限 1 核 / 1536Mi |

再加 MongoDB 插件（`"addons": {"mongodb": {}}`）：一个库加一个只能访问这个库的用户，连接串和库名由 `addon_env` 注入接口服务的 `MONGODB_URI`、`MONGODB_DATABASE`。

**没有处理服务**（`docs/design/server-slim.md`）：上传核对、操作文件展开、重建包展开、定期清理都在接口服务的后台执行器里做；重建（对齐、结构、物件、外部模型、烘焙）全部在本地用 `metaverse-recon` 做，产出重建包再用命令行 `metaverse bundle push` 上传发布。以前的 `metaverse-worker` 从规格里删掉了（第 3 节"换成瘦身后的版本"）。

**为什么服务名带 `metaverse-` 前缀**：chrono-cd 里服务名在同一个主人（ChronoAI 组织）的所有应用之间必须唯一，否则 `409 service_name_taken`。组织里的 `omega/mathesis` 已经占用了 `web` 和 `worker`。

**服务之间怎么访问**：同一个主人的服务在集群里按服务名互相访问，地址是 `http://<服务名>:<端口>`（也可以用 `:80`）。所以网站镜像里 nginx 把 `/api/` 转给 `http://metaverse-api:8080`（[`web/nginx.conf`](../../web/nginx.conf)，地址写死，与这里的服务名一致）。公网上 `/api` 开头的请求由平台网关按最长前缀直接转给 `metaverse-api`，nginx 的转发只是兜底；页面始终同源访问接口。

**探针**：chrono-cd 用 `health_path` 同时做就绪、存活、启动探针和负载均衡健康检查（存活每 15 秒、超时 5 秒；启动最多等 300 秒）。接口服务建好索引前 `/api/healthz` 返回 503，平台不会把流量导过来。网站用 nginx 自己的 `/healthz`（不读文件、不记访问日志）。

**镜像要求**（Dockerfile 在 [`infra/`](..) 下）：只能来自 ghcr.io；数字形式的非 root 用户（api 65532、web 101）；linux/amd64。规格里的镜像**一律按摘要固定**（`仓库:<7 位提交哈希>@sha256:<摘要>`，标签只作记号），原因见第 1 步。

### 配额

组织配额由组织下所有应用共用，默认 8 核 / 16Gi / 40 个容器。chrono-cd 按"Σ 副本 × 申请 + 本应用申请最大的那个服务再算一份（滚动更新的新副本）"计算：

| | CPU | 内存 | 容器 |
|---|---|---|---|
| 本应用申请 | 2×25m + 250m = 300m | 2×32Mi + 384Mi = 448Mi | 3 |
| 滚动更新预留 | 250m（api） | 384Mi（api） | 1 |
| **合计** | **550m** | **832Mi** | **4** |

去掉处理服务以后比以前（1.3 核 / 约 6.31Gi / 5 个容器）少占 750m CPU、约 5.5Gi 内存和 8Gi 临时盘。部署前仍要按第 3 步实际查一次。

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
| `ALLOWED_NYX_SERVICE_IDS` | `362df1f5-8135-4a05-aa85-d929a5fd9f73` | ChronoAI 组织的 `chrono-metaverse` 自定义服务连接编号（第 7 步）。另建连接时换成新编号；首次部署尚未注册时可临时用 `pending-nyxid-registration`，此时 `/api/v1/*` 均无法通过鉴权 |
| `METAVERSE_REQUIRE_PERMISSIONS` | `false` | 第一步不启用功能级权限 |
| `UPLOAD_MAX_SCAN_BYTES` / `UPLOAD_MAX_MODEL_BYTES` / `UPLOAD_MAX_TEXTURE_BYTES` / `UPLOAD_MAX_OPS_BYTES` / `UPLOAD_MAX_SCRIPT_BYTES` | 1GiB / 50MiB / 50MiB / 64MiB / 4MiB | 各用途上传的大小上限（其余用途——网页用模型、重建包清单——用接口服务的默认值 64MiB、16MiB，见 [`api/README.md`](../../api/README.md)） |
| `UPLOAD_MAX_TEXTURE_SIDE` | `4096` | 贴图单边像素上限（第 0 片按文件头检查，后台核对再按全文查）。很多手机的贴图上限是 4096，本地工具打包时按同样的上限检查 |
| `UPLOAD_MODEL_MAX_TRIANGLES` / `UPLOAD_MODEL_MAX_TEXTURE_SIDE` | `100000` / `2048` | 物件模型（外部模型重新导出的 glb）接受的三角形数和单张贴图边长 |
| `UPLOAD_WEBMODEL_MAX_TRIANGLES` | `500000` | 网页用模型（"原始"视图的扫描网格）接受的三角形数 |
| `UPLOAD_MAX_OPEN_PER_SPACE` | `16` | 每个空间进行中的上传数，超过返回 429 |
| `UPLOAD_MAX_CONCURRENT_PARTS` | `4` | 每个副本同时处理的分片数（每片最多 32MiB 在内存里，见下面"内存预算"；多出的请求排队） |
| `JOB_MAX_PENDING_PER_SPACE` | `8` | 每个空间排队和运行中的任务数，超过返回 429 |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` / `PUBLIC_RATE_LIMIT_BURST` | `60000000` / `1000000` | 公开 JSON 接口的限流额度。**目前按网关地址计、所有访客共用几个桶**，额度只要是进程处理得了的速率，一台机器就能把桶耗尽、让所有访客都 429，所以设成每秒 100 万次，**等于关掉限流**（见下面"公开接口限流"；接口服务按单个访客设计的默认值是 1200 / 200） |
| `PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE` / `PUBLIC_BLOB_RATE_LIMIT_BURST` | `60000000` / `1000000` | 区块和资源（`/api/public/chunks/`、`/assets/`）的限流额度，同上（默认 12000 / 2000） |
| `TRUSTED_CLIENT_IP_HEADER` | **不设（待向平台确认）** | 可信的客户端地址请求头。确认之前不设，接口服务按 TCP 连接地址限流，连接地址是网关或 nginx 的地址（见下面"公开接口限流"） |
| `PUBLIC_CACHE_BYTES` | `134217728` | 公开接口进程内缓存的字节上限（128MiB；接口服务默认 256MiB，按"内存预算"调小） |
| `METAVERSE_DEMO_SEED` | [`demo-seed.json`](demo-seed.json) 压缩成的一行 | 部署配置种子：接口服务启动、建好索引后在后台建演示空间 `chronoai-lobby`，带重建包时导入它（第 8 步）。改种子时两处一起改，`check-app.mjs` 检查一致。现在是第 3 版、不带包（空间已存在，什么都不做） |
| `METAVERSE_DEMO_SEED_HOSTS` | `raw.githubusercontent.com,github.com,release-assets.githubusercontent.com,objects.githubusercontent.com,scaniverse.com` | 种子允许下载的主机（只用 https，重定向的每一跳都查，最多 5 跳）：清单和来源表在 `raw.githubusercontent.com`，发布页的文件从 `github.com` 重定向到 `release-assets.githubusercontent.com` 或 `objects.githubusercontent.com`，扫描成员在 `scaniverse.com`。有种子时 `check-app.mjs` 要求显式写出，并且和 `infra/dev/up.sh` 的默认值相同 |
| `METAVERSE_DEMO_SHARE_TOKEN` | **密钥**（`secret_keys`，不在 `env` 里） | 演示空间的分享令牌原文，接口服务只存它的 sha256、不写日志；用 `set_app_secrets` 设置（第 5 步）。种子是凭链接查看（`unlisted`）时必须有，缺了接口服务启动失败 |
| `NYXID_OAUTH_CLIENT_ID` | `be885bc0-94fd-4a30-bb5e-613723cd0eef` | ChronoAI 组织的 chrono-metaverse 保密 OAuth 客户端；回调为本站 `/api/auth/nyxid/callback` |
| `NYXID_OAUTH_CLIENT_SECRET` / `NYXID_OAUTH_ENCRYPTION_KEY` | **密钥** | 客户端秘密及 32 字节随机加密密钥，使用应用密钥注入；见 [OAuth 部署说明](../../docs/NYXID_OAUTH.md) |
| `RUST_LOG` | `info` | |

种子带重建包时要从 `raw.githubusercontent.com`、GitHub 发布页和 `scaniverse.com` 下载清单、来源表和包里空间还没有的文件（主机列表 `METAVERSE_DEMO_SEED_HOSTS`），所以接口服务需要能访问公网（chrono-cd 默认 `egress` 允许）；文件边下载边写进上传会话的数据块，扫描 zip 一次只有一个成员在内存里（单个成员 ≤ 128MiB）。

#### 内存预算

处理服务有子进程和内存上限做隔离；它下线以后，上传核对和包展开都在唯一的公开接口进程里做，所以按最坏情况估（设计 4.8）：

| 部分 | 最坏 | 配置 |
|---|---|---|
| 进程本身、数据库驱动 | 约 80MB | |
| 公开接口的进程内缓存 | 128MiB | `PUBLIC_CACHE_BYTES` |
| 分片上传 | 4 × 32MiB | `UPLOAD_MAX_CONCURRENT_PARTS` |
| 上传核对 × 2 | 约 2 × 16MB | 后台执行器的核对名额（`RUNNER_VERIFY_SLOTS`，默认 2） |
| 重任务 × 1 | 约 450MB | 操作文件展开、重建包导入（`RUNNER_HEAVY_SLOTS`，默认 1） |
| 合计 | 约 840MB | `memory_limit` 1536Mi |

本机实测（`api/README.md`）：分批作用、分批写记录以后重任务峰值约 0.95GB（含测试进程本身），在 1.2GB 以内。改这几项的任何一个都要重新估算；`check-app.mjs` 要求它们显式写出。

#### 公开接口限流（待向平台确认可信的客户端地址头）

设计 8.2 要求公开接口按来源地址限流，并在第 0 阶段向平台确认哪个请求头里是可信的客户端地址（设计 16.2）。确认之前的情况：

- **链路**：公网请求先到 Cloudflare，再到平台的 Google 负载均衡，最后到 `metaverse-api`（2026-11-09 实测 `https://chrono-metaverse-chronoai.apps.nyxid.ai/api/healthz` 的响应头：`server: cloudflare`、`cf-ray`、`via: 1.1 google`）；`/api` 走 nginx 兜底时还要再经过网站的 nginx。
- **所以限流按网关地址计**：接口服务默认用 TCP 连接地址当来源，这个地址是 Google 前端代理（`35.191.0.0/16`、`130.211.0.0/22`）或 nginx 副本的地址，所有访客落进少数几个桶。
- **共用的桶会变成"全站 429 开关"，所以现在等于关掉限流**：只要额度是进程处理得了的速率，任何人在一台机器上持续以略高于额度的速度请求（例如有 1–2 秒进程内缓存、服务端几乎没有成本的 `/api/public/spaces/<编号>/head`），就能耗尽这几个桶，之后所有访客打开公开链接或分享链接都得到 429，攻击停下才恢复。以前按"200 个同时在线访客"调高到每分钟 12000、突发 2000 时，模拟（与锁文件相同的 governor 0.10.4、模拟时钟，合法访客共 50 次/秒，攻击都经同一个代理地址，持续 60 秒）的结果是：攻击 400 次/秒时合法请求只有 13% 成功，2000 次/秒时 1.8%。所以 `app.json` 把四个额度设成每秒 100 万次（每分钟 6000 万、突发 100 万）：单副本、1 核的接口服务远远处理不了这么多请求，进程被打满之前限流器不会拒绝任何人；同样的模拟里攻击到 10 万次/秒（60 秒）、90 万次/秒（5 秒）合法请求仍然全部成功。`check-app.mjs` 要求没有可信地址头时四个额度不低于"每核每秒 100 万次"（按接口服务的 `cpu_limit` 放大，突发至少一秒的量），改 `cpu_limit` 时要跟着改。
- **现在靠什么兜底**：每个空间的并发上限（`PUBLIC_SPACE_CONCURRENCY`，默认 64，满了返回 503 `space_busy`，只影响那一个空间）、进程内缓存（`/head` 同一空间每秒最多读一次数据库，快照、区块、资源有字节上限）、公开空间内容不变的区块和资源（`.bin` 路径）按设计由 Cloudflare 缓存（是否命中待实测，设计 16.2），以及 Cloudflare 自带的防护。把进程本身打满仍然可能，但那要每秒几万次以上的持续洪泛，不再是每秒几百次就能做到的事。
- **为什么暂时不设 `TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip`**：接口服务对配置的头无条件信任。只要有人能绕过 Cloudflare 直接连到平台的负载均衡，就可以每个请求写一个不同的 `cf-connecting-ip`，每次都拿到新额度，限流完全失效。所以要先向平台确认两件事：① 负载均衡只接受 Cloudflare 的流量（或者会覆盖外来的 `cf-connecting-ip`）；② `cf-connecting-ip` 原样到达容器。
- **`X-Forwarded-For` 不能用**：Google 负载均衡和 nginx 都会在后面追加地址，值是多个 IP；接口服务只认恰好一个 IP 的值，会退回连接地址（`check-app.mjs` 也会拒绝把它配成可信头）。
- **不用等平台确认的做法（要接口服务先支持）**：按可信代理网段取客户端地址——只有 TCP 对端在 Google 前端代理网段（`35.191.0.0/16`、`130.211.0.0/22`）里时，才取 `X-Forwarded-For` 里负载均衡追加的客户端地址（倒数第二段）；这个地址在 Cloudflare 公布的网段里时再取 `cf-connecting-ip`，否则就用它本身；nginx 兜底路径同理只信任集群内的对端（参照 CMA 的 `CHRONO_SERVER_TRUSTED_PROXY_CIDRS`）。这样请求头不能被伪造，也不需要先确认平台配置。这是接口服务（`api/crates/metaverse-api/src/public/mod.rs` 的 `client_key`）的改动，不在部署配置里，接口服务支持之前限流保持关闭。

平台确认之后：在 `app.json` 里设 `"TRUSTED_CLIENT_IP_HEADER": "cf-connecting-ip"`，四个 `PUBLIC_*` 可以删掉（回到按单个访客的默认额度；接口服务支持按可信代理网段取地址时同理，按它的配置项设置），跑一遍 `node infra/chrono-cd/check-app.mjs`，再用 `PATCH` 只改这几项（JSON 合并补丁里写 `null` 表示删除这一项；改完 `GET` 一次确认）：

```bash
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH --output json --data '{"services":{"metaverse-api":{"env":{
  "TRUSTED_CLIENT_IP_HEADER":"cf-connecting-ip",
  "PUBLIC_RATE_LIMIT_PER_MINUTE":null,"PUBLIC_RATE_LIMIT_BURST":null,
  "PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE":null,"PUBLIC_BLOB_RATE_LIMIT_BURST":null}}}}'
```

改完用第 6 步的命令看 `metaverse-api` 的日志：被限流时会打印"公开接口限流"。

`metaverse-web`：不需要环境变量。

## 2. 首次部署

前提：操作者是 ChronoAI 组织的 admin（部署、写密钥、重启都要求）。下面的命令用本机的 `nyxid` 命令行（`nyxid login` 登录后）；在 Claude 会话里也可以用 chrono-cd 工具做同样的事（开发教程第 6、7 节），只是工具里只有整份替换的 `put_app`，没有局部修改。

```bash
ORG=52aa284c-b5b2-49bd-9d12-79f24772dbd7   # ChronoAI 组织编号（不是 slug）
APP=api/v1/projects/metaverse/apps/chrono-metaverse
```

### 第 1 步：推送镜像

推送到 `main` 或开发分支 `claude/happy-ritchie-oly5hx` 时，GitHub Actions 的 `Images` 工作流（[`.github/workflows/images.yml`](../../.github/workflows/images.yml)）构建两个镜像并推到 ghcr.io（处理服务已下线，不再构建 `chrono-metaverse-worker`）：

- `ghcr.io/chronoaiproject/chrono-metaverse-{api,web}:<7 位提交哈希>`
- `…:<分支名>`（`/` 换成 `-`，例如 `claude-happy-ritchie-oly5hx`、`main`）
- `…:latest`（只有 `main`）

#### 镜像按摘要固定

部署**只用摘要**，不用任何标签（包括 7 位提交哈希标签）：

- **标签可以被改写**：`Images` 的触发条件和 `packages: write` 权限都由被推分支自己的 `images.yml` 声明。有推送权限的人（或泄露的令牌）在任何分支里改一下这个文件，推一次就能覆盖 `:<线上的提交哈希>` 这类标签，ghcr 没有禁止改写标签的设置。
- **chrono-cd 每次 `PUT` 和 `PATCH` 都会重新解析标签**（`Put` 对每个服务调用 `resolveImages`，不管镜像字段改没改；`set_app_secrets` 和重启用已存的摘要）。按标签写的规格，下一次只改环境变量的 `PATCH`（例如第 4 步改 `PUBLIC_BASE_URL`、第 7 步改 `ALLOWED_NYX_SERVICE_IDS`）就会把标签当时指向的镜像部署上线，修订记录里标签名不变、只有摘要变了。
- **按摘要写时**：chrono-cd 在标签和摘要都有时只按摘要拉取，重新解析也还是同一个镜像。

摘要从**这次提交在部署分支上的 `Images` 运行**里取：GitHub 的 Actions 页面打开那次运行（核对分支和提交哈希），两个任务的摘要里各有一行 `api=sha256:…`、`web=sha256:…`，原样交给 [`pin-images.mjs`](pin-images.mjs)。不要按标签去 ghcr 查摘要，那查到的是标签现在指向的镜像。命令行也可以这样取（`gh` 登录后）：

```bash
gh run list -R ChronoAIProject/chrono-metaverse --workflow Images --commit <完整提交哈希> --json databaseId,headBranch,conclusion
gh run view <运行编号> -R ChronoAIProject/chrono-metaverse --log | grep -oE '(api|web)=sha256:[0-9a-f]{64}' | sort -u
```

`app.json` 里的镜像是已经上线验证过的版本（瘦身后的版本 R2：接口服务和网站都是 `413b28f`，摘要与线上第 8 次修订记录的一致，2026-11-10 上线）。`check-app.mjs` 拒绝只有标签、标签不是 7 位提交哈希、或仓库和服务对不上的镜像。

按摘要部署只保证"部署的就是那次运行构建的镜像"，管不到谁能推镜像、推代码。`main` 已经建好（2026-11-09，从开发分支 `claude/happy-ritchie-oly5hx` 的 `77bbdb8` 建出），以后作为部署分支：日常开发在开发分支，上线前开合并请求进 `main`，部署只用 `main` 上构建的镜像。还没做、要仓库管理员在 GitHub 上决定的：把默认分支改成 `main` 并加保护（禁止直接推送、必须经合并请求、CI 必须通过）；在包设置的 Manage Actions access 里收回本仓库工作流的写权限，改用只在受保护分支的 GitHub Environment 里可用的凭证推镜像（工作流自己声明的 `packages: write` 拦不住改过的工作流）；用组织规则集限制谁能改 `.github/workflows`。

#### 构建输入也固定

镜像的内容取决于构建时拉进来的东西，这些也一律固定到不可改写的引用（持续集成里 `node infra/chrono-cd/check-pins.mjs` 检查，测试在 `check-pins.test.mjs`）：

- 工作流里的 action 固定到 40 位提交哈希，注释里写版本；install-action 装的工具写明版本。上游的标签或分支被改写（例如上游被入侵）时，不会在拿着 `packages: write` 令牌的任务里跑新代码。
- `Images` 不读写 Actions 缓存：缓存按仓库和分支共用、不分工作流，同一分支上任何 CI 任务里的 action 都能写进构建层。每次从头构建，api 镜像会慢几分钟。
- 两个 Dockerfile 的 `# syntax=` 构建前端和基础镜像写成"标签@摘要"（构建时 BuildKit 只按摘要拉）。
- 处理服务已下线：它的镜像（`infra/worker/`）和"构建后端按版本和哈希固定"的检查都已删掉，`Images` 不再构建它；线上在换成瘦身后的版本之前，处理服务仍按线上规格里固定的摘要运行以前构建的镜像。

更新由 Dependabot 每周提（[`.github/dependabot.yml`](../../.github/dependabot.yml)，新版本发布满一周才提）；`# syntax=` 的摘要要手工换。

### 第 2 步：把两个包设为公开（只做一次）

第一次推送出来的包默认是私有的，chrono-cd 拉不下来（`400 image_unauthorized`）。到 GitHub 组织的 Packages 页面，分别打开 `chrono-metaverse-api`、`chrono-metaverse-web` → Package settings → Danger Zone → Change visibility → Public。

确认匿名可拉（返回 200 即可）：

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:chronoaiproject/chrono-metaverse-api:pull" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  https://ghcr.io/v2/chronoaiproject/chrono-metaverse-api/manifests/sha256:<摘要>
```

不想公开时，可以在 `PUT` 请求体里带一次 `registry_credential`（经典 PAT，`read:packages`），但这样就有一个要保管的凭证，不推荐。

### 第 3 步：查配额

```bash
nyxid proxy request chrono-cd "api/v1/account?org_id=$ORG" --output json
```

看 `quota` 和 `usage`：剩余至少要有 550m、832Mi、4 个容器（见第 1 节）。不够就先 `POST api/v1/quota-requests` 申请，由平台管理员批准。

### 第 4 步：提交应用规格

先跑 `node infra/chrono-cd/check-app.mjs`，再用 `pin-images.mjs` 把两个镜像换成要部署那次提交的摘要（第 1 步"镜像按摘要固定"；它输出整份规格，并且只有通过 `check-app` 的检查才输出），然后提交：

```bash
node infra/chrono-cd/pin-images.mjs <提交哈希> \
  api=sha256:<摘要> web=sha256:<摘要> > /tmp/chrono-metaverse.json
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PUT \
  --data "$(cat /tmp/chrono-metaverse.json)" --output json
```

部署 `app.json` 里写的那个版本时不用换，直接提交 `app.json`（瘦身前后交接的那一次除外，见第 1 步的"注意"）。

在 Claude 会话里：让它用 `chrono-cd__put_app` 提交，参数是 `project=metaverse`、`app=chrono-metaverse`、`org_id=<ORG>`，`addons` 和 `services` 取自 `pin-images.mjs` 的输出或 `app.json`（`target_org_id` 与 `org_id` 一致；镜像必须带 `@sha256:`）。先让它把要提交的内容给你看。

返回 `201`（新建）或 `200`（替换）。记下返回里的 `url`，如果和 `PUBLIC_BASE_URL` 的预估值不同，改掉它（chrono-cd 的 `PATCH` 是 JSON 合并补丁，只改这一项，其他字段不动）：

```bash
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH \
  --data '{"services":{"metaverse-api":{"env":{"PUBLIC_BASE_URL":"https://<返回的 url 主机名>"}}}}' --output json
```

常见失败：`400 image_not_found`（摘要不存在、复制错了或还没构建完）、`400 image_unauthorized`（第 2 步没做）、`409 quota_exceeded`（第 3 步）、`409 service_name_taken`（服务名被组织里别的应用占用）。

规格里声明了 `METAVERSE_DEMO_SHARE_TOKEN` 和两个 `NYXID_OAUTH_*` 密钥：第一次提交时密钥还没设置，chrono-cd 返回 `422 missing_secret_keys`——这表示规格**已保存**、等密钥，接着做第 5 步，设置后 chrono-cd 立即应用。

### 第 5 步：密钥（演示空间的分享令牌）

演示空间使用接口服务的 `METAVERSE_DEMO_SHARE_TOKEN`，演示空间 `chronoai-lobby`（凭链接查看）的分享令牌原文。接口服务只用它算 sha256 存进空间文档，不写日志；演示链接是 `/s/chronoai-lobby#share=<令牌>`（第 8 步）。

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
nyxid proxy request chrono-cd "$APP/telemetry/logs?preset=errors&service=metaverse-api&org_id=$ORG" --output json
```

`phase = ready` 表示公网入口已经能访问（新主机名的路由要几分钟才生效）。`pods[].reason` 里是容器自己的原因：`ImagePullBackOff`（镜像或权限）、`CrashLoopBackOff`（看日志，常见是环境变量不对，接口服务会打印"配置不可用：…"；旧镜像配上新格式的种子也是这样）、`OOMKilled`（调大 `memory_limit`）、`CreateContainerConfigError`（镜像用了 root 或非数字用户）。

就绪后自检：

```bash
URL=https://<应用域名>
curl -s $URL/healthz              # ok
curl -s $URL/api/healthz          # {"status":"ok"}
curl -s $URL/api/openapi.json | jq '.paths | keys'
curl -s -o /dev/null -w '%{http_code}\n' $URL/api/v1/spaces/x   # 401（没有身份令牌）
```

### 第 7 步：注册成 NyxID 服务（组织管理员，在自己电脑上）

ChronoAI 的现有部署已完成注册：组织 `chronoai`（`52aa284c-b5b2-49bd-9d12-79f24772dbd7`），服务 `chrono-metaverse`，连接编号 `362df1f5-8135-4a05-aa85-d929a5fd9f73`，地址 `https://chrono-metaverse-chronoai.apps.nyxid.ai`，OpenAPI 地址为该域名下的 `/api/openapi.json`。连接已开启 `jwt` 身份传递、受众 `urn:chrono-metaverse:api` 和 `forward_access_token`，允许组织成员使用；`app.json` 的服务编号白名单已同步。

已验证 `nyxid proxy request chrono-metaverse api/v1/spaces/chronoai-lobby --output json` 可读取前厅数据，MCP 可发现 `chrono-metaverse__get_space` 等具体工具。MCP 使用 `x-api-key` 时不会转发用户访问令牌。旧版本因此无法查询组织角色，读取组织空间返回 404；本次 OAuth 实现允许用户先在 `/connect` 授权，再以原有 Agent Key 调用。需先发布新版 API/web，并按 [NyxID OAuth 接入](../../docs/NYXID_OAUTH.md) 注册 OAuth 客户端、设置两个应用密钥和客户端 ID；本次发布同时配置该功能；每位用户仍需打开 `/connect` 授权一次。无需新建服务连接或 Agent Key。

维护现有部署时复用这条连接，无需再次创建。以下步骤用于新建或重建连接：

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

写接口 `/api/v1` 只认 NyxID 身份令牌；演示空间不依赖任何人的身份，由部署配置驱动（设计 9.2"部署配置种子是运维行为"，`docs/design/server-slim.md` 第 7 节）：[`demo-seed.json`](demo-seed.json) 压缩成一行放在接口服务的 `METAVERSE_DEMO_SEED`，接口服务每次启动、建好索引后在后台执行一次，**不经过任何网络接口，也不跑任何重建**——重建在本地完成，种子只导入一个按哈希固定的**重建包**：

```json
{"spaceId": "chronoai-lobby", "name": "ChronoAI 前厅", "description": "…",
 "owner": {"kind": "org", "id": "<组织的规范编号>"}, "visibility": "unlisted", "revision": 4,
 "bundle": {"manifest": {"url": "https://raw.githubusercontent.com/<组织>/<仓库>/<40 位提交哈希>/infra/chrono-cd/demo/lobby-r4/manifest.json",
                         "sha256": "<清单的 sha256>", "size": 312345},
            "sources":  {"url": "https://raw.githubusercontent.com/<组织>/<仓库>/<40 位提交哈希>/infra/chrono-cd/demo/lobby-r4/sources.json",
                         "sha256": "<来源表的 sha256>", "size": 4567}}}
```

清单是本地重建工具打的包（与托管位置无关，只有相对路径、用途、sha256、大小）；来源表说明清单里的文件从哪里下载（整文件的地址，或扫描 zip 的各个成员——按数组顺序打包，与线上已有的扫描字节相同）。带 `bundle` 时接口服务要设 `METAVERSE_DEMO_SEED_HOSTS`（允许下载的主机，逗号分隔，写法同本地工具：主机名只许 443 端口、`.后缀` 匹配子域名、`主机:端口` 只匹配那个端口；每一跳重定向都查），线上写 `raw.githubusercontent.com,github.com,release-assets.githubusercontent.com,objects.githubusercontent.com,scaniverse.com`。不带 `bundle` 时种子只保证空间存在。

1. 空间 `chronoai-lobby` 已存在、不是种子为这个组织建的（例如有人经管理接口建了同名空间）→ 不碰；
2. 这个导入版本（`revision`）的任务已经建过（线上第 1–3 版的 `scan_import` 任务用的是同一个编号公式）→ 什么都不做；上次因为下载失败（403、404、429、5xx、网络）重试用完而失败的 → 重新排队，修好来源以后重启接口服务就能接着导入，不用改版本号；
3. 下载清单和来源表，核对大小、sha256 和结构；不对就不建空间、不插任务（日志里有原因，下次启动再试）；
4. 建空间：主人是 ChronoAI 组织，归属证据的依据是 `operator_seed`（核验人 `system:demo-seed`），凭链接查看，分享令牌是第 5 步设置的密钥（只存哈希）；第一次提交照常写 `_space` 锚点和通用方块表；
5. 插入 `bundle_import` 任务；接口服务的后台执行器领取后：空间里没有的文件按来源表下载进上传会话、核对、登记（计入存储用量），把包展开进一个重建草稿，发布成一次提交（发布者 `system:demo-seed`、类别 `rebuild`；中途有冲突自动在最新版本上重放；内容没变就不写提交）。

**旧格式的种子**（`files`、`rebuild`、`hints`、`authored` 这些处理服务时代的字段）已不支持：接口服务记错误日志、跳过种子、照常启动；`check-app.mjs` 和 `infra/dev/demo-seed.mjs` 都会报错。

**确认**（第 6 步的日志命令）：带包的种子第一次导入时，接口服务日志里有 `部署配置种子完成 … outcome=Created`（之后重启是 `AlreadyDone`）和 `部署配置种子：已发布`。现在的种子是第 3 版、不带包：线上空间已存在，第 3 版的任务也已存在，什么都不做。然后打开演示链接：

```
https://<应用域名>/s/chronoai-lobby#share=<第 5 步的令牌>
```

不带令牌或令牌不对，公开接口一律 404。也可以只查头部：

```bash
curl -s -H "Authorization: Share <令牌>" https://<应用域名>/api/public/spaces/chronoai-lobby/head
```

**换一版演示数据**（设计 7.4，前厅第 4 版的托管方式待定，见设计第 14 节）：本地打包（种子用的包是公开的：`metaverse-recon bundle --seed` 去掉内部锚点和建模记录，`metaverse bundle check --seed` 会提示）→ 大文件按 `<sha256>.<扩展名>` 传到发布页 → 写来源表 → 清单和来源表提交进 `infra/chrono-cd/demo/` → 种子配置引用这次提交的 raw 地址和两个哈希，`revision` 加一 → `node infra/dev/demo-seed.mjs compact infra/chrono-cd/demo-seed.json` 的输出就是 `METAVERSE_DEMO_SEED` 的值，跑 `node infra/chrono-cd/check-app.mjs` → 只改这一项（滚动更新会重启接口服务，种子在同一个空间里追加一次提交，空间和演示链接不变）：

```bash
SEED=$(node infra/dev/demo-seed.mjs compact infra/chrono-cd/demo-seed.json)
# chrono-cd 的 PATCH：只改接口服务的 METAVERSE_DEMO_SEED（种子格式和镜像要在同一次部署里一起换）
--data "$(jq -n --arg seed "$SEED" '{services:{"metaverse-api":{env:{METAVERSE_DEMO_SEED:$seed}}}}')"
```

**从头重建**（连空间一起）：组织 admin 用管理接口删空间（`DELETE /api/v1/admin/spaces/chronoai-lobby?confirm=chronoai-lobby`），再重启接口服务，种子按当前配置和密钥重建（分享令牌是当时的密钥）。

**不再要演示数据**：从 `app.json` 删掉 `METAVERSE_DEMO_SEED`（连同 `demo-seed.json`、`secret_keys` 里的令牌），已建的空间留着，要删用上面的管理接口。

NyxID 注册以后，别的空间照常经接口建：以组织 admin 身份 `POST /api/v1/admin/spaces`（主人写组织的**规范编号**），再用命令行 `metaverse init <空间>`；重建层在本地用 `metaverse-recon` 打包、`metaverse bundle push --publish` 上传发布（要有 `metaverse:rebuild:write` 权限，`docs/design/server-slim.md` 第 3 节），扩展层用 `metaverse build` / `push`（建造教程 [`docs/tutorials/build-space.md`](../../docs/tutorials/build-space.md)、重建教程 [`docs/tutorials/reconstruct-with-ai.md`](../../docs/tutorials/reconstruct-with-ai.md)）。

## 3. 日常更新

新版本只换镜像，用 `PATCH`（不会动其他字段，也不会覆盖别人中途的部署）。摘要按第 1 步"镜像按摘要固定"从那次提交的 `Images` 运行里取，`pin-images.mjs --patch` 生成只含镜像的补丁：

```bash
PATCH_BODY=$(node infra/chrono-cd/pin-images.mjs --patch <新的提交哈希> \
  api=sha256:<摘要> web=sha256:<摘要>)
nyxid proxy request chrono-cd "$APP?org_id=$ORG" --method PATCH --output json --data "$PATCH_BODY"
```

上线后同步改 `app.json` 的两个镜像（同一条命令去掉 `--patch` 的输出里就是新的镜像引用），让仓库里记的是线上验证过的版本。

**线上规格还是按标签写的时候（只做一次）**：2026-11-09 部署的修订 1–3 用的是 `:b957be0`、`:aabf88f`、`:0fccf1d` 这类标签。在做任何只改环境变量的 `PATCH` 之前，先用上面的命令把镜像换成按摘要固定，摘要取 `revisions` 里**当前修订记录的** `ImageDigest`（部署时解析出来的，不受之后改写标签的影响；与那次 `Images` 运行的摘要核对一次）。之后再按需要用 `PATCH` 同步 `app.json` 里改过的环境变量（例如第 1 节"公开接口限流"的四个额度）。

改了 `app.json` 的其他内容（环境变量、资源）时用第 4 步的 `PUT` 整份提交；`PUT` 会整份替换，提交前先 `GET` 一次，把线上手工改过的值（`PUBLIC_BASE_URL`、`ALLOWED_NYX_SERVICE_IDS`）同步回来，再带上 `If-Match: <generation>`。

滚动更新时新旧副本会同时运行（`maxUnavailable 0`、`maxSurge 1`，终止宽限 30 秒）：数据库迁移必须先扩后收；后台执行器的任务靠租约和幂等重做，旧副本收到终止信号后最多等 20 秒让手上的任务写完，没写完的租约过期后由新副本接着做（`docs/design/server-slim.md` 4.2）。

### 换成瘦身后的版本（R2，只做一次）

`docs/design/server-slim.md` 第 11 节。这一次和日常更新不同：处理服务要从规格里删掉、接口服务的资源和环境变量都变了，种子格式也换了（旧镜像读不了新格式的种子），所以必须用第 4 步的 `PUT` **整份**提交，并且镜像、环境变量、删掉处理服务在**同一次**里完成：

1. 新的九步验收在本机全过（`infra/dev/README.md`），开发分支合并进 `main`，取这次提交在 `main` 上的 `Images` 运行里的两个摘要；
2. `GET` 一次线上规格，把线上手工改过的值同步进 `app.json`（目前没有：`PUBLIC_BASE_URL`、`ALLOWED_NYX_SERVICE_IDS` 都已和线上一致）；
3. `node infra/chrono-cd/pin-images.mjs <提交哈希> api=sha256:<摘要> web=sha256:<摘要>` 生成整份规格（只有通过 `check-app` 才输出），带上 `If-Match: <generation>` `PUT`；
4. 第 6 步查状态：`get_app_status` 里只剩 `metaverse-web`、`metaverse-api` 两个服务（处理服务已删除）；接口服务日志里有建索引、后台执行器和清理启动、后台迁移 `backfill-asset-check-v1` 的进度，种子什么都不做（`AlreadyDone`）；
5. 打开演示链接，确认前厅照常显示、时间线能回到第 1–3 版的任何时刻。

NyxID 已经注册，`/api/v1` 现在就能写（设计 11.2 说的"注册早于 R2"）：R2 上线以后，任何组织 admin 的一次实体区写入、一次核对不过的上传，都可能写进瘦身前的版本读不了的数据，所以退回瘦身前只在上线以后还没有任何经接口的写入时才安全（第 4 节的检查）。记下 `PUT` 成功的时刻，退回时要用。上线以后同步改 `app.json` 的两个镜像（第 3 节开头）。

## 4. 回滚

1. 找上一个正常版本：

   ```bash
   nyxid proxy request chrono-cd "$APP/revisions?org_id=$ORG&limit=10" --output json
   ```

   每个修订都带各服务的镜像和摘要（`ImageDigest`，部署时解析出来的）。回滚用这个摘要，不要用标签：标签可能已经被改写。
2. 用第 3 节的 `pin-images.mjs --patch` 生成补丁，把镜像换回旧摘要（只回滚出问题的服务也可以，只写那个服务，例如 `api=sha256:<旧摘要>`；提交哈希写旧版本的）。
3. 用第 6 步的命令确认 `phase = ready`。

在 Claude 会话里没有 `PATCH`：先 `chrono-cd__get_app` 读出当前完整配置，只把对应服务的 `image` 换成旧版本（`仓库:<旧提交哈希>@sha256:<旧摘要>`），其他字段（全部服务、`env`、`addon_env`、`addons`、`volumes`）原样保留，再用 `chrono-cd__put_app` 提交。漏了服务，那个服务会被删掉；漏了 `addons`，MongoDB 插件会被撤掉（数据保留，但应用随即连不上数据库）。

回滚不回滚数据：如果新版本已经跑过不兼容旧版本的迁移，单纯换镜像不够，先看迁移说明。

**从瘦身后的版本退回瘦身前**（`docs/design/server-slim.md` 11.5）：瘦身前的版本（R0，`77bbdb8`）按带类型、不收未知字段的结构读
提交里的操作、物件记录、草稿和任务，认不得瘦身后新加的写法，读到就报错：这个空间的草稿新建、追加、发布 500（读空间状态时
物件记录解析失败），任务列表和任务查询报错，网站把转过的模型画成没转。R2 能写出这类数据的途径有：

1. **重建路径写的一切**（要重建权限）：`actor.kind = rebuild` 的提交、范围 `rebuild` 的草稿、上传和任务；种子第 4 版
   （`bundle_import` 任务和它的提交）也算；
2. **对象形式的 `lastError`**（不要任何特别的权限）：R2 里任何失败过或重试过的任务都这样写——核对不过的上传
   （`upload_verify`，R0 就有这个种类，但 R0 只认文字形式的 `lastError`）、失败的 `ops_from_upload`、清理第 0 步收掉的
   旧种类任务（线上预计 0 条）；
3. **实体区、地块草稿和提交里的新写法**（任何组织 admin 都能写）：`removeEntity` 带 `ifPresent`、`createAnchor` 带 `ifNew`；
   物件记录带 `transform`（转过的模型）、形状材质带 `tile`、`offset`、`rotate`、`shading`、`normalMap`、`normalScale`、
   `roughnessMap`、`roughness`、`metalness`，模型物件的 `material.shading`。

第 2、3 种不经重建路径也会出现，而且逐条查全很难（操作可能在 `opsRef` 指向的文件里），所以判断标准是：**R2 上线以后
没有任何经 `/api/v1` 的写入**。设上线时刻为 `T`（与库里的写法相同：UTC、毫秒三位，例如 `"2026-11-12T08:00:00.000Z"`），
在数据库里这几条都必须是 0：

```js
db.commits.countDocuments({ at: { $gt: T } })
db.drafts.countDocuments({ createdAt: { $gt: T } })
db.uploads.countDocuments({ createdAt: { $gt: T } })
db.jobs.countDocuments({ $or: [{ createdAt: { $gt: T } }, { lastError: { $type: "object" } }] })
```

R2 自己在启动和后台写的东西 R0 都会忽略：索引、清理锁、迁移记录、资源的 `metadata.check` / `checkError`、`assetRefs.seq`；
种子第 3 版什么都不写。只要有一条不是 0，就只能前滚修正（或者先发一个能读新写法的兼容读版本 R1 再退，设计 11.2）。

退的时候不能只换镜像：处理服务、旧的环境变量和资源要一起回来，所以用 `revisions` 找到瘦身前的那份完整规格，整份 `PUT`
回去。

## 5. 不要做的事

- 不要把任何密钥写进 `env`（`get_app` 会原样返回给组织成员）或 `app.json`，包括演示空间的分享令牌 `METAVERSE_DEMO_SHARE_TOKEN`（它只在 `secret_keys` 里声明名字）。
- 不要在规格里写只有标签的镜像（`:main`、`:<提交哈希>`），也不要按标签去 ghcr 查摘要：标签可以被任何分支的工作流改写，chrono-cd 每次 `PUT` / `PATCH` 都会重新解析（第 1 步"镜像按摘要固定"）。
- 不要 `DELETE` 应用来"重来"：删除不可恢复，带 `purge=true` 还会删掉数据库。
- 不要把 `ALLOWED_NYX_SERVICE_IDS` 改成别人的服务编号或放宽成多个不相干的编号：别人自建的连接指向本服务时，正是靠它返回 401（设计 9.1）。
