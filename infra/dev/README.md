# 本地开发设施

在自己电脑（或云端会话）上起一套完整的 chrono-metaverse：MongoDB 副本集、模拟 NyxID、接口服务、处理服务、网站开发服务器。全部只监听 `127.0.0.1`，不连真实的 NyxID，也不需要任何密钥。

| 文件 | 作用 |
|---|---|
| `up.sh` / `down.sh` | 一键启动 / 停止全套；日志和进程号在 `infra/dev/.run/`（不进版本库） |
| `mock-nyxid.mjs` | 模拟 NyxID（Node 22，无第三方依赖） |
| `org-roles.json` | 模拟 NyxID 用的组织角色表 |
| `call.mjs` | 调用接口服务的小工具：每次自动取新令牌、带上 NyxID 代理会带的请求头 |
| `mock-nyxid.test.mjs` | 模拟 NyxID 的测试：`node --test infra/dev/mock-nyxid.test.mjs` |

## 准备

- Node 22、npm；Rust（`rustup`，版本由 `api/rust-toolchain.toml` 固定为 1.97.0）；Python 3.13，推荐装 [uv](https://docs.astral.sh/uv/)；curl。
- MongoDB 副本集（接口服务要用事务，单机版不行）。`up.sh` 会先找 `127.0.0.1:27017`、`27018` 上已有的副本集；都没有时，如果装了 `mongod`（在 PATH 里，或设置 `MONGOD_BIN`）就在 `infra/dev/.run/mongo-data` 起一个单节点副本集 `rs0`；还没有的话按提示下载 [MongoDB 社区版](https://www.mongodb.com/try/download/community)，或用 Docker：

  ```bash
  docker run -d --name metaverse-mongo -p 127.0.0.1:27017:27017 mongo:8.0.32 --replSet rs0
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
