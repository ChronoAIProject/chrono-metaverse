# 本地开发设施

在自己电脑（或云端会话）上起一套完整的 chrono-metaverse：MongoDB 副本集、模拟 NyxID、接口服务（含后台执行器：上传核对、`ops_from_upload`、定期清理）、网站开发服务器。全部只监听 `127.0.0.1`，不连真实的 NyxID，也不需要任何密钥。

没有处理服务（[`docs/design/server-slim.md`](../../docs/design/server-slim.md)）：上传核对、操作文件和重建包的展开由接口服务的后台执行器做；重建在本地用重建工具 `metaverse-recon`（[`recon/`](../../recon/README.md)）做，产出重建包，再用命令行 `metaverse bundle push` 上传发布。`up.sh` 本身不需要 Python；本地重建工具的虚拟环境由用到它的地方准备（九步验收、[重建教程](../../docs/tutorials/reconstruct-with-ai.md)），`cd recon && uv sync --frozen`。

| 文件 | 作用 |
|---|---|
| `up.sh` / `down.sh` | 一键启动 / 停止全套；日志和进程号在 `infra/dev/.run/`（不进版本库） |
| `mock-nyxid.mjs` | 模拟 NyxID（Node 22，无第三方依赖） |
| `org-roles.json` | 模拟 NyxID 用的组织角色表和各身份的权限（重建身份 `rita`） |
| `call.mjs` | 调用接口服务的小工具：每次自动取新令牌、带上 NyxID 代理会带的请求头 |
| `mock-nyxid.test.mjs` | 模拟 NyxID 的测试 |
| `e2e.mjs` | 九步端到端验收（`docs/BUILD_PLAN.md` 5.2）：自己起全套、按九步执行并断言、收尾，见下面"九步验收" |
| `e2e-lib.mjs` / `e2e-lib.test.mjs` | 验收脚本的小工具（步骤执行、等待、请求头、截图判断）和它们的测试 |
| `demo-seed.mjs` / `demo-seed.test.mjs` | 部署配置种子的小工具（压缩成一行、换主人、生成分享令牌、拦住旧格式；`up.sh --demo-seed` 用）和它的测试 |
| `mongo.mjs` / `mongo.test.mjs` | 不用驱动的 MongoDB 小工具（查副本集名、初始化单节点副本集、删库；`up.sh` 和验收收尾用）和它的测试 |

测试：`node --test infra/dev/*.test.mjs`（持续集成的仓库检查任务也跑）。

## 准备

- Node 22、npm；Rust（`rustup`，版本由 `api/rust-toolchain.toml` 固定为 1.97.0）；curl。本地重建工具（九步验收的第 2 步、重建教程）另要 Python 3.13 和 [uv](https://docs.astral.sh/uv/)，`up.sh` 本身不需要。
- MongoDB 副本集（接口服务要用事务，单机版不行）。`up.sh` 会先找 `127.0.0.1:27017`、`27018` 上已有的副本集；都没有时，如果装了 `mongod`（在 PATH 里，或设置 `MONGOD_BIN`）就在 `infra/dev/.run/mongo-data` 起一个单节点副本集 `rs0`；还没有的话按提示下载 [MongoDB 社区版](https://www.mongodb.com/try/download/community)，或用 Docker：

  ```bash
  docker run -d --name metaverse-mongo -p 127.0.0.1:27017:27017 mongo:8.0.13 --replSet rs0
  docker exec metaverse-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
  ```

## 一键启动

```bash
infra/dev/up.sh              # 全套
infra/dev/up.sh --no-web     # 不起网站
infra/dev/up.sh --demo-seed  # 另外按部署配置种子建演示空间（见下面"演示数据"）
infra/dev/down.sh            # 停止（复用的 MongoDB 不动）
```

| 组件 | 默认地址 | 改端口 |
|---|---|---|
| MongoDB | 自动发现，库 `chrono_metaverse_dev` | `METAVERSE_MONGODB_URI`、`METAVERSE_DEV_DATABASE`、`METAVERSE_DEV_MONGO_PORT` |
| 模拟 NyxID | `http://127.0.0.1:8090` | `MOCK_NYXID_PORT`；角色表 `MOCK_NYXID_ROLES` |
| 接口服务 | `http://127.0.0.1:8080`（`cargo build` 后直接运行二进制） | `METAVERSE_API_PORT` |
| 网站 | `http://127.0.0.1:5173`（Vite 开发服务器，`/api` 转给本地接口服务） | `METAVERSE_WEB_PORT` |

`up.sh` 给接口服务设置的环境变量：

```bash
MONGODB_URI=<发现的副本集>   MONGODB_DATABASE=chrono_metaverse_dev
NYXID_BASE_URL=http://127.0.0.1:8090
NYXID_JWKS_URL=http://127.0.0.1:8090/.well-known/jwks.json
NYXID_JWT_ISSUER=http://127.0.0.1:8090
NYXID_JWT_AUDIENCE=urn:chrono-metaverse:api
ALLOWED_NYX_SERVICE_IDS=dev-service
BIND=127.0.0.1:8080   PUBLIC_BASE_URL=http://127.0.0.1:5173
UPLOAD_MAX_CONCURRENT_PARTS=4   RUNNER_POLL_SECONDS=2   CLEANUP_INTERVAL_SECONDS=600
METAVERSE_DEMO_SEED_HOSTS=raw.githubusercontent.com,github.com,release-assets.githubusercontent.com,objects.githubusercontent.com,scaniverse.com
```

`METAVERSE_DEMO_SEED_HOSTS` 的默认值与线上 `app.json` 相同（`check-app.mjs` 检查两处一致），本地 `--demo-seed` 下载的就是线上会下载的那几个主机。

后台执行器和定期清理的其余配置（`RUNNER_*`、`CLEANUP_*`、各用途的上传上限）用接口服务的默认值，见 [`api/README.md`](../../api/README.md)；都可以在运行 `up.sh` 前用同名环境变量覆盖（`up.sh` 显式传的几个也一样）。

`down.sh` 照旧会停掉旧版本 `up.sh` 起的处理服务（`worker.pid`，以前的进程号文件还在时），新起的全套里没有它。

### 演示数据（可选，部署配置种子）

`up.sh --demo-seed[=<种子.json>]`（或环境变量 `METAVERSE_DEV_DEMO_SEED=<种子.json>`）让接口服务启动后像线上一样按部署配置种子建演示空间、导入按哈希固定的重建包（种子格式见 [`api/README.md`](../../api/README.md)"部署配置种子"和 `docs/design/server-slim.md` 7.1，线上的配置是 [`infra/chrono-cd/demo-seed.json`](../chrono-cd/demo-seed.json)，不给文件时就用它）：

- 种子压缩成一行交给接口服务的 `METAVERSE_DEMO_SEED`（`node infra/dev/demo-seed.mjs compact <种子.json>`）；
- 分享令牌取 `METAVERSE_DEMO_SHARE_TOKEN`，没设时生成一个存在 `infra/dev/.run/demo-share-token`，之后复用（空间里只存第一次的哈希）；结束时打印演示链接 `http://127.0.0.1:5173/s/<空间>#share=<令牌>`；
- 主人默认是配置里的线上组织编号（公开读不受影响，但本地没人能管理它）；`METAVERSE_DEV_DEMO_SEED_OWNER=chronoai` 换成模拟 NyxID 的组织，alice 就能经 `/api/v1` 管理；
- 允许下载的主机取 `METAVERSE_DEMO_SEED_HOSTS`，没设时用线上那一组（GitHub 的 raw 地址和发布页、Scaniverse）；种子带重建包时后台执行器从来源表下载空间里还没有的文件（前厅第 4 版的新库约 23MB）；旧格式（`files`、`hints`、`authored` 等）`demo-seed.mjs` 直接报错；
- 进度看 `infra/dev/.run/api.log`（`部署配置种子完成 … outcome=Created`、`部署配置种子：已发布`）。线上现在的种子是第 3 版、不带包，本地新库只建出空间、没有内容（日志是 `outcome=Created { job_id: None }`）；第 4 版的包上线以后（设计 S10）才有内容；
- 要在本机试带包的种子：把包目录用本机 https 服务托管（自签证书，接口服务信任 `SSL_CERT_FILE` 里的根证书），写一份来源表和带 `bundle` 的种子，`METAVERSE_DEMO_SEED_HOSTS` 加上 `127.0.0.1:<端口>`；本机测试也可以用 `http://127.0.0.1:<端口>`（只有本机地址允许明文）；
- 经过会重新签发证书的出口代理时，接口服务另外信任 `SSL_CERT_FILE`（PEM）里的根证书，从环境继承即可。

接口服务只允许本机地址用明文 http 当 NyxID 地址，所以模拟 NyxID 必须跑在本机。

## 模拟 NyxID

```bash
node infra/dev/mock-nyxid.mjs [--port 8090] [--host 127.0.0.1] [--roles infra/dev/org-roles.json]
```

| 接口 | 说明 |
|---|---|
| `GET /.well-known/openid-configuration` | `issuer` 就是服务根地址（`http://127.0.0.1:8090`），`jwks_uri` 指向下一行 |
| `GET /.well-known/jwks.json` | 公钥列表。RSA 2048 密钥在启动时生成，只在内存里；每次启动 kid 都不同，接口服务遇到未知 kid 会自己刷新 |
| `POST /dev/token` | 请求体 `{sub, orgRole?, org?, permissions?}`，返回 `{identityToken, accessToken, expiresIn, serviceId, audience, issuer}`；每次一个新的 jti。不带 `permissions` 时按角色文件的 `permissions` 给（命令行取令牌只带 `sub`） |
| `GET /api/v1/orgs/{id}/authorization` | 组织角色查询：`Authorization: Bearer <accessToken>`，返回 `{id, your_role, …}`；不是成员 404，凭据无效 401 |
| `GET /healthz` | 启动检查 |

**令牌与真实 NyxID 的对应**：

- **身份令牌**（放在 `X-NyxID-Identity-Token` 请求头里）：头部只有 `{alg: RS256, typ: JWT, kid}`；声明是 `sub`、`iss`、`aud`（`urn:chrono-metaverse:api`）、`iat`、`exp`（= `iat` + 60 秒）、`jti`（随机）、`nyx_service_id`（固定 `dev-service`）、`permissions`、`roles`、`groups`，**不带** `token_type`。与接口服务的验签要求（`api/crates/metaverse-api/src/auth/jwt.rs`）逐项一致，测试里也核对了。
- **访问令牌**（放在 `Authorization: Bearer` 里，相当于 NyxID 开了"转发调用者令牌"后转发来的令牌）：同一把密钥签的 JWT，`token_type = access`、`sub` 与身份令牌相同、有效 1 小时。接口服务查组织角色前会验签并核对 `sub`，再原样转给 `/api/v1/orgs/{id}/authorization`。
- **组织角色和权限**：默认按 `org-roles.json` 查（每次查询都重新读文件，改了不用重启）：

  ```json
  {"orgs": {"chronoai": {"alice": "admin", "bob": "member", "carol": "viewer", "rita": "admin"}},
   "permissions": {"rita": ["metaverse:rebuild:write"]}}
  ```

  `/dev/token` 带 `orgRole`（`admin`/`member`/`viewer`/`none`）时，这个访问令牌查任何组织都返回该角色；再带 `org` 就只对那个组织生效。
- **重建权限**（`docs/design/server-slim.md` 第 3 节）：重建路径 `/api/v1/spaces/{space_id}/rebuild/` 上的写操作要求身份令牌的 `permissions` 里有 `metaverse:rebuild:write`，线上它挂在平台管理员建的角色 `metaverse-rebuilder` 上。本地用 `permissions` 模拟：**rita** 是带这个权限的组织 admin（重建身份，`metaverse bundle push --sub rita`）；**alice** 是没有它的组织 admin（调重建路径 403 `rebuild_permission_required`，九步验收的反例）。临时给别人加权限用 `call.mjs --permission`。
- **组织本身的 agent key**：`sub` 直接写组织编号（例如 `chronoai`），接口服务判为"组织本身"，不查角色。

本地的组织编号用 `chronoai` 这样的短字符串即可；线上是 NyxID 的组织 UUID。

**安全**：模拟 NyxID 给任何人签发任何身份，只能在本机用。监听非本机地址时会打印警告。

## 调用接口服务

身份令牌 60 秒过期、jti 只能用一次，所以每次请求都要取新令牌。`call.mjs` 帮你做这件事：

```bash
node infra/dev/call.mjs [--as <sub>] [--org-role <角色>] [--org <组织>] [--permission <权限>]… [--no-forward] [--share <分享令牌>] <方法> <路径> [JSON 或 @文件]
```

- `--permission` 可以重复，给了就不再按角色文件（例如 `--as bob --permission metaverse:rebuild:write`）；

- `/api/v1/*`：带 `X-NyxID-Identity-Token` 和 `Authorization: Bearer <访问令牌>`（`--no-forward` 不带后者）；
- `/api/public/*`：不带身份，`--share` 时带 `Authorization: Share <令牌>`；
- 地址用 `METAVERSE_API_URL`（默认 `http://127.0.0.1:8080`）和 `MOCK_NYXID_URL`（默认 `http://127.0.0.1:8090`）改。

不用这个工具时，自己取令牌再调用：

```bash
TOKENS=$(curl -s -X POST http://127.0.0.1:8090/dev/token -H 'content-type: application/json' -d '{"sub":"alice"}')
curl -s http://127.0.0.1:8080/api/v1/spaces/front-hall \
  -H "X-NyxID-Identity-Token: $(echo "$TOKENS" | jq -r .identityToken)" \
  -H "Authorization: Bearer $(echo "$TOKENS" | jq -r .accessToken)"
```

命令行（`sdk/typescript`）要在本地联调时，可以按同样的方式：从 `POST /dev/token` 取令牌，直接请求接口服务并带上这两个请求头。

## 九步验收（`e2e.mjs`）

`docs/BUILD_PLAN.md` 5.2 的端到端验收，跨接口服务、本地重建工具、命令行和网站，用真实的 MongoDB 副本集（`docs/design/server-slim.md` 10.4 改成"本地重建工具出包 → 命令行上传发布"）：

```bash
infra/dev/down.sh                                   # 先停掉自己起的全套（验收要自己起一套）
node infra/dev/e2e.mjs --scan <前厅扫描.zip|.glb> [--keep]   # 九步
node infra/dev/e2e.mjs --only 1,8,9                 # 不要扫描的三步
```

`--only` 接受逗号分隔的编号和区间（`1,8,9`、`1-9`、`2-4,8`），默认 `1-9`；选了某一步就要连同它依赖的步骤一起选（第 3 步推送第 2 步打的包，第 4 步读第 3 步的提交，第 5 步打开页面、第 6、7 步在这个页面上操作；每一步都要第 1 步建的空间），否则退出码 2。结果表保留原来的步骤编号。

| 步骤 | 做法 | 断言 |
|---|---|---|
| 1. 建组织空间 | alice（`chronoai` 的 admin）`POST /api/v1/admin/spaces`，再 `PUT .../layout` 定义实体区、虚拟区和地块 `p1`；`metaverse init`（direct 模式，从模拟 NyxID 取令牌） | 201、分享令牌、归属证据 `org_admin` |
| 2. 本地工具产出重建包 | 工作区里 `metaverse pull`（写 `space.json`、`limits.json`）；扫描复制到 `scan/`；`metaverse-recon align`（首次自动对齐，写 `scan/transform.json`）→ `prepare` → `bundle --algorithm --anchors`（`--anchors`：按类别建议的锚点也进包，默认只列出建议；最后经 `PATH` 里的 `metaverse` 调 `bundle check`）；再 `metaverse bundle check --json` | 不需要服务；包里有扫描、网页用模型和贴图；清单的 `base` 是拉取时的版本；检查通过 |
| 3. 上传并发布 | rita（带 `metaverse:rebuild:write`）`metaverse bundle push --publish --part-size 0.25 --json`；同一个包 `--publish` 再推一次（不带 `--replay`）；本空间、carol 的空间各按扫描的哈希建一次上传 | 扫描分成多片、核对完成；提交的类别 `rebuild`，带扫描和网页用模型，重建层编号 `rb.` 开头，建议锚点建好；再推一次文件全部复用、`unchanged`、不写提交；本空间直接复用，carol 的空间要完整上传 |
| 4. 公开快照 | 凭分享令牌读公开提交列表、`snapshot?seq=` 重建前后两个版本、网页用模型、原始扫描 | 重建后有物件、重建前为空；资源 `immutable`；原始扫描不公开（404）；没带或带错令牌 404 |
| 5. 三种视图 | 无头 Chromium 打开 `/s/<空间>#share=<令牌>`，依次切"优化""优化 + 扩展""原始" | 每种视图就绪；画布截图不是空白；优化有物件、扩展有"虚拟"标识、原始有扫描 |
| 6. 回到重建前 | 点重建前那次提交的标记，再点"现在" | 显示"这个时刻还没有优化模型"；回到最新版本 |
| 7. 写事件、"现在"模式 | 登记 `shop.status`（空间级状态），重开页面，alice 写一条事件 | 公开 `/head` 的 `recordedAt` 变化；公开增量事件里有它；页面状态栏出现事件文字 |
| 8. 地块建造 | 工作区里 `metaverse pull` → `build --plot p1`（示例脚本）→ `check` → `push --json` → `publish --json` | 新 seq；公开快照里有示例桌子；页面拉到新版本，扩展视图物件变多 |
| 9. 越权 | bob（member）建草稿、写事件、登记事件类型、建组织空间；dave（非成员）读和写；alice 读写 carol 的个人空间；alice（没有重建权限）建重建草稿、经重建路径上传；bob（member，带重建权限）建重建草稿；经实体区路径上传扫描；经地块路径上传重建包清单；调已下线的扫描导入；地块草稿放 `rb.` 编号；rita 再推一次包不发布，用预览令牌读资源 | member 写 403；看不到的一律 404；没有重建权限 403 `rebuild_permission_required`，member 即使有权限也 403；实体区路径传扫描 422 `purpose_not_allowed`；地块路径传清单 403 `scope_violation`；旧接口 410 `endpoint_retired`；`rb.` 编号 422 `invalid_op`；预览令牌读网页用模型 200、读原始扫描和包清单 404 |

- 端口都是临时挑的空闲端口，库名 `metaverse_e2e_<随机后缀>`；结束时运行 `down.sh` 并删除这个库，`--keep` 保留现场；
- 结果、截图（`view-*.png`、`timeline-before-rebuild.png`、`live-event.png`、`plot-build-extended.png`，失败时 `failure.png`）、工作区（含 `out/recon`、`out/bundle`）、本地工具的输出（`recon-*.log`）和 `up.sh` 的输出在 `infra/dev/.run/e2e-<后缀>/`；各服务的日志在 `infra/dev/.run/*.log`；
- 扫描文件不进版本库，用 `--scan` 或 `METAVERSE_E2E_SCAN` 指定；只接受本地工具直接读的 Scaniverse 式 zip（网格 + 贴图，例如 drc + jpg）和 glb；
- 本地工具用 `recon/.venv/bin/metaverse-recon`，没有时先 `uv sync --frozen`；命令行每次从 `sdk/typescript` 构建，第 2 步给本地工具放一个 `metaverse` 垫片（`e2e-<后缀>/bin/`），让 `bundle` 最后能调用 `metaverse bundle check`；
- 浏览器：`METAVERSE_E2E_BROWSER_PATH`，没有时用 `/opt/pw-browsers/chromium`，再没有交给网站依赖里的 Playwright 自己找；`bundle push` 等后台核对和包展开的上限 `METAVERSE_E2E_JOB_TIMEOUT`（秒，默认 600）；
- 收尾删库用 `mongo.mjs drop`；
- 退出码：0 全部通过，1 有步骤失败（后面的步骤标"未执行"），2 参数或环境不对（没开始验收）。

要跑的是本地全套和一份真实扫描，不放进每次合并请求的持续集成；持续集成只跑小工具的测试和参数检查（`e2e-lib.test.mjs`）。

**2026-11-10 实测**（4 核机器，前厅扫描 zip：Draco 网格 + 贴图共 5.9MB）：九步第一次就全部通过，验收主体约 3 分 20 秒（不含编译）。第 2 步本地出包 118 秒（`align` 2 秒、`prepare` 55 秒、`bundle --algorithm` 60 秒）：31 个文件（扫描、2 档网页用模型、28 张结构贴图），`bundle check` 通过；第 3 步推送发布 26 秒：扫描分 23 片，发布为 seq 3（`rebuild`），重建层 59 件、建议锚点 8 个，再推一次 `unchanged`；第 9 步 17 种越权和用途、编号、预览的反例都按预期返回。截图和结果另存在会话的临时目录，没有进仓库。

**历史**：处理服务还在时（2026-11-09），第 2–3 步是"`metaverse scan` 分片上传 → 处理服务对齐和 AI 重建"，九步在 4 核机器上约 2 分钟通过（导入任务约 60 秒，63 个物件）；处理服务下线到九步改完之间（设计 13.3），默认只跑第 1、8、9 步。

## 实测示例

下面是 2026-11-09 用当时的接口服务实测的完整过程（只起了模拟 NyxID 和接口服务）。

```bash
# 终端 1：模拟 NyxID
node infra/dev/mock-nyxid.mjs --port 8090

# 终端 2：接口服务
cd api
MONGODB_URI='mongodb://127.0.0.1:27018/?replicaSet=rs0' MONGODB_DATABASE=metaverse_dev \
NYXID_BASE_URL=http://127.0.0.1:8090 NYXID_JWKS_URL=http://127.0.0.1:8090/.well-known/jwks.json \
NYXID_JWT_ISSUER=http://127.0.0.1:8090 NYXID_JWT_AUDIENCE=urn:chrono-metaverse:api \
ALLOWED_NYX_SERVICE_IDS=dev-service \
cargo run -p metaverse-api
```

**1. alice（`chronoai` 的 admin）建组织空间**：接口服务先验身份令牌，再验转发来的访问令牌（`sub` 都是 alice），然后用它查组织角色，得到 admin，写入归属证据。

```bash
node infra/dev/call.mjs --as alice POST /api/v1/admin/spaces \
  '{"id":"front-hall","name":"公司前厅","description":"本地演示","owner":{"kind":"org","id":"chronoai"}}'
```

```text
201 Created
{
  "space": {
    "id": "front-hall",
    "name": "公司前厅",
    "owner": { "kind": "org", "id": "chronoai" },
    "ownerEvidence": {
      "issuer": "http://127.0.0.1:8090",
      "orgId": "chronoai",
      "verifiedBy": "alice",
      "basis": "org_admin",
      "roleAtVerification": "admin",
      …
    },
    "visibility": "unlisted",
    "head": { "seq": 0, … },
    …
  },
  "shareToken": { "id": "st_…", "token": "<分享令牌，只返回这一次>" }
}
```

模拟 NyxID 的日志：

```text
签发令牌：sub=alice
组织授权 chronoai：alice = admin
```

**2. bob（member）读回**：member 只读，能看到内部数据。

```bash
node infra/dev/call.mjs --as bob GET /api/v1/spaces/front-hall
```

```text
200 OK
{ "id": "front-hall", "name": "公司前厅", "owner": {…}, "ownerEvidence": {…}, "visibility": "unlisted", … }
```

**3. 凭分享令牌公开读回**：只返回公开投影（没有主人和归属证据）。

```bash
node infra/dev/call.mjs --share <分享令牌> GET /api/public/spaces/front-hall
```

```text
200 OK
{ "id": "front-hall", "name": "公司前厅", "description": "本地演示", "visibility": "unlisted",
  "head": { "seq": 0, … }, "regions": [], "plots": [], "anchors": [] }
```

**反例**（同一次实测）：

| 调用 | 结果 |
|---|---|
| `--as bob POST /api/v1/admin/spaces`（member 建组织空间） | 403 |
| `--as dave GET /api/v1/spaces/front-hall`（不是成员） | 404（模拟 NyxID 返回 404 → 不是成员） |
| `--as alice --no-forward POST /api/v1/admin/spaces`（没有转发令牌，查不到角色） | 503 `org_membership_unavailable` |
| `GET /api/public/spaces/front-hall`（没带分享令牌） | 404 |
| `--as chronoai POST /api/v1/admin/spaces`（组织本身，不查角色） | 201，`ownerEvidence.basis = org_subject` |

分享令牌只在创建时返回一次，库里只存哈希；示例里用占位符代替了实测时的随机值。
