# 本地开发设施

在自己电脑（或云端会话）上起一套完整的 chrono-metaverse：MongoDB 副本集、模拟 NyxID、接口服务、处理服务、网站开发服务器。全部只监听 `127.0.0.1`，不连真实的 NyxID，也不需要任何密钥。

| 文件 | 作用 |
|---|---|
| `up.sh` / `down.sh` | 一键启动 / 停止全套；日志和进程号在 `infra/dev/.run/`（不进版本库） |
| `mock-nyxid.mjs` | 模拟 NyxID（Node 22，无第三方依赖） |
| `org-roles.json` | 模拟 NyxID 用的组织角色表 |
| `call.mjs` | 调用接口服务的小工具：每次自动取新令牌、带上 NyxID 代理会带的请求头 |
| `mock-nyxid.test.mjs` | 模拟 NyxID 的测试 |
| `e2e.mjs` | 九步端到端验收（`docs/BUILD_PLAN.md` 5.2）：自己起全套、按九步执行并断言、收尾，见下面"九步验收" |
| `e2e-lib.mjs` / `e2e-lib.test.mjs` | 验收脚本的小工具（步骤执行、等待、请求头、截图判断）和它们的测试 |

测试：`node --test infra/dev/*.test.mjs`（持续集成的仓库检查任务也跑）。

## 准备

- Node 22、npm；Rust（`rustup`，版本由 `api/rust-toolchain.toml` 固定为 1.97.0）；Python 3.13，推荐装 [uv](https://docs.astral.sh/uv/)；curl。
- MongoDB 副本集（接口服务要用事务，单机版不行）。`up.sh` 会先找 `127.0.0.1:27017`、`27018` 上已有的副本集；都没有时，如果装了 `mongod`（在 PATH 里，或设置 `MONGOD_BIN`）就在 `infra/dev/.run/mongo-data` 起一个单节点副本集 `rs0`；还没有的话按提示下载 [MongoDB 社区版](https://www.mongodb.com/try/download/community)，或用 Docker：

  ```bash
  docker run -d --name metaverse-mongo -p 127.0.0.1:27017:27017 mongo:8.0.13 --replSet rs0
  docker exec metaverse-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
  ```

## 一键启动

```bash
infra/dev/up.sh              # 全套
infra/dev/up.sh --no-worker  # 不起处理服务
infra/dev/up.sh --no-web     # 不起网站
infra/dev/down.sh            # 停止（复用的 MongoDB 不动）
```

| 组件 | 默认地址 | 改端口 |
|---|---|---|
| MongoDB | 自动发现，库 `chrono_metaverse_dev` | `METAVERSE_MONGODB_URI`、`METAVERSE_DEV_DATABASE`、`METAVERSE_DEV_MONGO_PORT` |
| 模拟 NyxID | `http://127.0.0.1:8090` | `MOCK_NYXID_PORT`；角色表 `MOCK_NYXID_ROLES` |
| 接口服务 | `http://127.0.0.1:8080`（`cargo build` 后直接运行二进制） | `METAVERSE_API_PORT` |
| 处理服务 | 健康检查 `http://127.0.0.1:8082/healthz` | `WORKER_HEALTH_PORT` |
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
```

给处理服务设置的环境变量（线程数与线上 `infra/chrono-cd/app.json` 一致，本地测的子进程内存才和线上一样；原因见 [`infra/chrono-cd/README.md`](../chrono-cd/README.md) 的"处理服务的线程数"）：

```bash
MONGODB_URI=<发现的副本集>   MONGODB_DATABASE=chrono_metaverse_dev   WORKER_HEALTH_PORT=8082
OPENBLAS_NUM_THREADS=2   OMP_NUM_THREADS=2   MALLOC_ARENA_MAX=2   PYTHONUNBUFFERED=1
```

三个线程变量都可以在运行 `up.sh` 前用同名环境变量覆盖。

接口服务只允许本机地址用明文 http 当 NyxID 地址，所以模拟 NyxID 必须跑在本机。处理服务第一次启动前会在 `worker/.venv` 建虚拟环境（`pyproject.toml` 变了会重装）。

## 模拟 NyxID

```bash
node infra/dev/mock-nyxid.mjs [--port 8090] [--host 127.0.0.1] [--roles infra/dev/org-roles.json]
```

| 接口 | 说明 |
|---|---|
| `GET /.well-known/openid-configuration` | `issuer` 就是服务根地址（`http://127.0.0.1:8090`），`jwks_uri` 指向下一行 |
| `GET /.well-known/jwks.json` | 公钥列表。RSA 2048 密钥在启动时生成，只在内存里；每次启动 kid 都不同，接口服务遇到未知 kid 会自己刷新 |
| `POST /dev/token` | 请求体 `{sub, orgRole?, org?, permissions?}`，返回 `{identityToken, accessToken, expiresIn, serviceId, audience, issuer}`；每次一个新的 jti |
| `GET /api/v1/orgs/{id}/authorization` | 组织角色查询：`Authorization: Bearer <accessToken>`，返回 `{id, your_role, …}`；不是成员 404，凭据无效 401 |
| `GET /healthz` | 启动检查 |

**令牌与真实 NyxID 的对应**：

- **身份令牌**（放在 `X-NyxID-Identity-Token` 请求头里）：头部只有 `{alg: RS256, typ: JWT, kid}`；声明是 `sub`、`iss`、`aud`（`urn:chrono-metaverse:api`）、`iat`、`exp`（= `iat` + 60 秒）、`jti`（随机）、`nyx_service_id`（固定 `dev-service`）、`permissions`、`roles`、`groups`，**不带** `token_type`。与接口服务的验签要求（`api/crates/metaverse-api/src/auth/jwt.rs`）逐项一致，测试里也核对了。
- **访问令牌**（放在 `Authorization: Bearer` 里，相当于 NyxID 开了"转发调用者令牌"后转发来的令牌）：同一把密钥签的 JWT，`token_type = access`、`sub` 与身份令牌相同、有效 1 小时。接口服务查组织角色前会验签并核对 `sub`，再原样转给 `/api/v1/orgs/{id}/authorization`。
- **组织角色**：默认按 `org-roles.json` 查（每次查询都重新读文件，改了不用重启）：

  ```json
  {"orgs": {"chronoai": {"alice": "admin", "bob": "member", "carol": "viewer"}}}
  ```

  `/dev/token` 带 `orgRole`（`admin`/`member`/`viewer`/`none`）时，这个访问令牌查任何组织都返回该角色；再带 `org` 就只对那个组织生效。
- **组织本身的 agent key**：`sub` 直接写组织编号（例如 `chronoai`），接口服务判为"组织本身"，不查角色。

本地的组织编号用 `chronoai` 这样的短字符串即可；线上是 NyxID 的组织 UUID。

**安全**：模拟 NyxID 给任何人签发任何身份，只能在本机用。监听非本机地址时会打印警告。

## 调用接口服务

身份令牌 60 秒过期、jti 只能用一次，所以每次请求都要取新令牌。`call.mjs` 帮你做这件事：

```bash
node infra/dev/call.mjs [--as <sub>] [--org-role <角色>] [--org <组织>] [--no-forward] [--share <分享令牌>] <方法> <路径> [JSON 或 @文件]
```

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

`docs/BUILD_PLAN.md` 5.2 的端到端验收，跨接口服务、处理服务、网站和命令行，用真实的 MongoDB 副本集：

```bash
infra/dev/down.sh                                   # 先停掉自己起的全套（验收要自己起一套）
node infra/dev/e2e.mjs --scan <前厅扫描.drc|.glb|.obj> [--voxelize] [--keep]
```

| 步骤 | 做法 | 断言 |
|---|---|---|
| 1. 建组织空间 | alice（`chronoai` 的 admin）`POST /api/v1/admin/spaces`，再 `PUT .../layout` 定义实体区、虚拟区和地块 `p1`；`metaverse init`（direct 模式，从模拟 NyxID 取令牌） | 201、分享令牌、归属证据 `org_admin` |
| 2. 分片上传扫描 | `metaverse scan <文件> --part-size 0.25 --no-wait --json` | 分成多片、有资源哈希和 `scan_import` 任务 |
| 3. 对齐与 AI 重建 | 轮询任务直到 `done`，再等全部任务完成 | 不要求人工对齐；seq 前进；快照有物件和网页用模型 |
| 4. 公开快照 | 凭分享令牌读公开提交列表、`snapshot?seq=` 重建前后两个版本、网页用模型（和区块） | 重建后有物件、重建前为空；资源 `immutable`；没带或带错令牌 404 |
| 5. 三种视图 | 无头 Chromium 打开 `/s/<空间>#share=<令牌>`，依次切"优化""优化 + 扩展""原始" | 每种视图就绪；画布截图不是空白；优化有物件、扩展有"虚拟"标识、原始有扫描 |
| 6. 回到重建前 | 点重建前那次提交的标记，再点"现在" | 显示"这个时刻还没有优化模型"；回到最新版本 |
| 7. 写事件、"现在"模式 | 登记 `shop.status`（空间级状态），重开页面，alice 写一条事件 | 公开 `/head` 的 `recordedAt` 变化；公开增量事件里有它；页面状态栏出现事件文字 |
| 8. 地块建造 | 工作区里 `metaverse pull` → `build --plot p1`（示例脚本）→ `check` → `push --json` → `publish --json` | 新 seq；公开快照里有示例桌子；页面拉到新版本，扩展视图物件变多 |
| 9. 越权 | bob（member）建草稿、写事件、登记事件类型、建组织空间；dave（非成员）读和写；alice 读写 carol 的个人空间 | member 写 403；看不到的一律 404 |

- 端口都是临时挑的空闲端口，库名 `metaverse_e2e_<随机后缀>`；结束时运行 `down.sh` 并删除这个库，`--keep` 保留现场；
- 结果、截图（`view-*.png`、`timeline-before-rebuild.png`、`live-event.png`、`plot-build-extended.png`，失败时 `failure.png`）、工作区和 `up.sh` 的输出在 `infra/dev/.run/e2e-<后缀>/`；各服务的日志在 `infra/dev/.run/*.log`；
- 扫描文件不进版本库，用 `--scan` 或 `METAVERSE_E2E_SCAN` 指定；只接受 `metaverse scan` 支持的 glb、drc、obj；
- 浏览器：`METAVERSE_E2E_BROWSER_PATH`，没有时用 `/opt/pw-browsers/chromium`，再没有交给网站依赖里的 Playwright 自己找；处理任务的等待上限 `METAVERSE_E2E_JOB_TIMEOUT`（秒，默认 1800）；
- 退出码：0 全部通过，1 有步骤失败（后面的步骤标"未执行"），2 参数或环境不对（没开始验收）。

要跑的是本地全套和一份真实扫描，不放进每次合并请求的持续集成；持续集成只跑小工具的测试和参数检查（`e2e-lib.test.mjs`）。

**2026-11-09 实测**（4 核机器，前厅扫描的 Draco 网格 1.0MB，不带贴图）：

- 按当时的代码，第 2 步失败：命令行建上传时发 `contentType`、`fileName`，接口服务只认 `size`/`totalSize`、`sha256`、`partSize`、`format`（拒收未知字段，422）。命令行和接口服务对不上的地方还有两处，都在第 8 步：建草稿时多发了 `message`（接口服务只认 `baseSeq`），"从上传应用操作"同时发了 `uploadId` 和 `assetHash`（接口服务要求只给一个）。这三处要命令行改（或接口服务放宽），改之前验收停在第 2 步；
- 在本地临时把这三处请求体改成接口服务的写法（不提交）后，九步全部通过：上传 4 片；重建 30 秒左右（64 个物件、2 档网页用模型）；三种视图截图都不是空白；回到版本 #2 显示"还没有优化模型"；事件写入后约 5 秒内页面状态栏出现；地块建造 3 个操作发布为 seq 4，扩展视图能看到虚拟区里的桌椅；9 个越权请求全部按预期返回 403 / 404。全程约 2 分钟（不含首次编译）。
- 页面只在打开时读一次事件类型，打开之后才登记的类型，它的事件要重新打开页面才显示；所以第 7 步登记类型后先重开页面再写事件。

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
