#!/usr/bin/env bash
# 一键起本地全套（只监听 127.0.0.1）：
#   MongoDB 副本集（已有就复用）→ 模拟 NyxID → 接口服务 → 处理服务 → 网站开发服务器（/api 转给本地接口服务）
#
# 用法：infra/dev/up.sh [--no-worker] [--no-web]
# 停止：infra/dev/down.sh
# 日志和进程号：infra/dev/.run/
#
# 可用环境变量改端口和库名（默认值在括号里）：
#   METAVERSE_MONGODB_URI（自动找 127.0.0.1:27017 / 27018 上的 rs0 副本集）
#   METAVERSE_DEV_DATABASE（chrono_metaverse_dev）
#   MOCK_NYXID_PORT（8090）、METAVERSE_API_PORT（8080）、METAVERSE_WEB_PORT（5173）、WORKER_HEALTH_PORT（8082）
#   METAVERSE_DEV_MONGO_PORT（27017，本脚本自己起 mongod 时用）、MONGOD_BIN（mongod 可执行文件）
#   UPLOAD_MAX_SCAN_BYTES、UPLOAD_MAX_OPEN_PER_SPACE、UPLOAD_MAX_CONCURRENT_PARTS、JOB_MAX_PENDING_PER_SPACE
#     （传给接口服务的上传和任务上限，其余 UPLOAD_* 用接口服务的默认值）
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
run="$repo/infra/dev/.run"
mkdir -p "$run"

mock_port=${MOCK_NYXID_PORT:-8090}
api_port=${METAVERSE_API_PORT:-8080}
web_port=${METAVERSE_WEB_PORT:-5173}
worker_health_port=${WORKER_HEALTH_PORT:-8082}
database=${METAVERSE_DEV_DATABASE:-chrono_metaverse_dev}
mongo_port=${METAVERSE_DEV_MONGO_PORT:-27017}

with_worker=1
with_web=1
for arg in "$@"; do
  case "$arg" in
    --no-worker) with_worker=0 ;;
    --no-web) with_web=0 ;;
    -h | --help)
      sed -n '2,15p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "不认识的参数：$arg（可用 --no-worker、--no-web）" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1m[up]\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m[up] %s\033[0m\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "缺少 $1：$2"
}

# 端口上已经有人在听就返回 0。
port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

alive() {
  [[ -f "$run/$1.pid" ]] && kill -0 "$(cat "$run/$1.pid")" 2>/dev/null
}

# 每个进程放进自己的进程组（set -m），down.sh 按进程组整体停止（npm 会再起 vite 子进程）。
set -m
start() {
  local name=$1
  shift
  nohup "$@" >"$run/$name.log" 2>&1 &
  echo $! >"$run/$name.pid"
}

# 等某个地址返回 2xx；进程提前退出就打印日志并失败。
wait_http() {
  local name=$1 url=$2 seconds=$3
  for _ in $(seq 1 "$seconds"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    if ! alive "$name"; then
      tail -n 40 "$run/$name.log" >&2 || true
      die "$name 启动失败（日志：$run/$name.log）"
    fi
    sleep 1
  done
  tail -n 40 "$run/$name.log" >&2 || true
  die "$name 在 $seconds 秒内没有就绪（$url，日志：$run/$name.log）"
}

need node "需要 Node 22（https://nodejs.org）"
need npm "需要 npm（随 Node 安装）"
need cargo "需要 Rust 工具链（https://rustup.rs），版本由 api/rust-toolchain.toml 固定"
need curl "需要 curl"

for name in mongod mock-nyxid api worker web; do
  if alive "$name"; then
    die "$name 已经在运行（进程号 $(cat "$run/$name.pid")），先运行 infra/dev/down.sh"
  fi
done

# ---------------------------------------------------------------------------
# 处理服务的虚拟环境（也用它的 pymongo 检查 MongoDB）
# ---------------------------------------------------------------------------
venv="$repo/worker/.venv"
python="$venv/bin/python"
stamp_file="$venv/.metaverse-dev-stamp"
stamp=$({
  cat "$repo/worker/pyproject.toml"
  cat "$repo/worker/uv.lock" 2>/dev/null || true
} | cksum)
if [[ ! -x "$python" || "$(cat "$stamp_file" 2>/dev/null)" != "$stamp" ]]; then
  say "准备处理服务的虚拟环境 worker/.venv（第一次要下载 numpy、scipy 等，稍等）"
  if command -v uv >/dev/null 2>&1; then
    uv venv --quiet --allow-existing --python 3.13 "$venv"
    uv pip install --quiet --python "$python" -e "$repo/worker[dev]"
  else
    need python3.13 "需要 Python 3.13（或安装 uv：https://docs.astral.sh/uv/）"
    python3.13 -m venv "$venv"
    "$python" -m pip install --quiet --upgrade pip
    "$python" -m pip install --quiet -e "$repo/worker[dev]"
  fi
  echo "$stamp" >"$stamp_file"
fi

# 打印副本集名；连不上或不是副本集时返回非 0。
replica_set_name() {
  "$python" - "$1" <<'PY' 2>/dev/null
import sys
import pymongo

client = pymongo.MongoClient(sys.argv[1], directConnection=True, serverSelectionTimeoutMS=1500)
name = client.admin.command("hello").get("setName")
if not name:
    sys.exit(2)
print(name)
PY
}

# ---------------------------------------------------------------------------
# MongoDB 副本集：先找已有的，没有再自己起
# ---------------------------------------------------------------------------
mongo_uri=""
if [[ -n "${METAVERSE_MONGODB_URI:-}" ]]; then
  mongo_uri=$METAVERSE_MONGODB_URI
  say "使用 METAVERSE_MONGODB_URI：$mongo_uri"
else
  for port in 27017 27018; do
    if port_busy "$port"; then
      if name=$(replica_set_name "mongodb://127.0.0.1:$port/"); then
        mongo_uri="mongodb://127.0.0.1:$port/?replicaSet=$name"
        say "复用已有的 MongoDB 副本集：$mongo_uri"
        break
      fi
      say "127.0.0.1:$port 上的 MongoDB 不是副本集（需要 --replSet），跳过"
    fi
  done
fi

if [[ -z "$mongo_uri" ]]; then
  mongod_bin=${MONGOD_BIN:-$(command -v mongod || true)}
  if [[ -z "$mongod_bin" ]]; then
    cat >&2 <<EOF
[up] 没找到可用的 MongoDB 副本集，也没有 mongod 可执行文件。任选一种：
  1. 下载 MongoDB 8 社区版压缩包：https://www.mongodb.com/try/download/community
     解压后把 bin 目录加进 PATH，或设置 MONGOD_BIN=<解压目录>/bin/mongod，再运行本脚本
     （本脚本会在 infra/dev/.run/mongo-data 起一个单节点副本集 rs0）。
  2. 有 Docker 的话：
       docker run -d --name metaverse-mongo -p 127.0.0.1:27017:27017 mongo:8.0.13 --replSet rs0
       docker exec metaverse-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
  3. 已有副本集在别的地址：METAVERSE_MONGODB_URI='mongodb://…/?replicaSet=…' infra/dev/up.sh
EOF
    exit 1
  fi
  port_busy "$mongo_port" && die "端口 $mongo_port 已被占用，换一个：METAVERSE_DEV_MONGO_PORT=<端口>"
  mkdir -p "$run/mongo-data"
  say "启动 mongod（副本集 rs0，端口 $mongo_port，数据在 infra/dev/.run/mongo-data）"
  start mongod "$mongod_bin" --dbpath "$run/mongo-data" --port "$mongo_port" --bind_ip 127.0.0.1 --replSet rs0
  "$python" - "$mongo_port" <<'PY' || die "mongod 没有选出主节点（日志：$run/mongod.log）"
import sys
import time

import pymongo
from pymongo.errors import OperationFailure, PyMongoError

port = int(sys.argv[1])
client = pymongo.MongoClient(f"mongodb://127.0.0.1:{port}/", directConnection=True, serverSelectionTimeoutMS=1000)
deadline = time.time() + 60
while time.time() < deadline:
    try:
        hello = client.admin.command("hello")
        if hello.get("isWritablePrimary"):
            sys.exit(0)
        if not hello.get("setName"):
            try:
                client.admin.command(
                    "replSetInitiate", {"_id": "rs0", "members": [{"_id": 0, "host": f"127.0.0.1:{port}"}]}
                )
            except OperationFailure:
                pass
    except PyMongoError:
        pass
    time.sleep(1)
sys.exit(1)
PY
  mongo_uri="mongodb://127.0.0.1:$mongo_port/?replicaSet=rs0"
fi

# ---------------------------------------------------------------------------
# 模拟 NyxID
# ---------------------------------------------------------------------------
for port in "$mock_port" "$api_port"; do
  port_busy "$port" && die "端口 $port 已被占用（用 MOCK_NYXID_PORT / METAVERSE_API_PORT 换一个）"
done
nyx="http://127.0.0.1:$mock_port"
say "启动模拟 NyxID：$nyx"
start mock-nyxid node "$repo/infra/dev/mock-nyxid.mjs" --port "$mock_port" --roles "${MOCK_NYXID_ROLES:-$repo/infra/dev/org-roles.json}"
wait_http mock-nyxid "$nyx/healthz" 15

# ---------------------------------------------------------------------------
# 接口服务
# ---------------------------------------------------------------------------
say "编译接口服务（第一次要几分钟）"
(cd "$repo/api" && cargo build --locked -p metaverse-api)
target=${CARGO_TARGET_DIR:-$repo/api/target}
[[ "$target" = /* ]] || target="$repo/api/$target"
api="http://127.0.0.1:$api_port"
say "启动接口服务：$api（库 $database）"
MONGODB_URI="$mongo_uri" \
  MONGODB_DATABASE="$database" \
  NYXID_BASE_URL="$nyx" \
  NYXID_JWKS_URL="$nyx/.well-known/jwks.json" \
  NYXID_JWT_ISSUER="$nyx" \
  NYXID_JWT_AUDIENCE="urn:chrono-metaverse:api" \
  ALLOWED_NYX_SERVICE_IDS="dev-service" \
  BIND="127.0.0.1:$api_port" \
  PUBLIC_BASE_URL="http://127.0.0.1:$web_port" \
  UPLOAD_MAX_SCAN_BYTES="${UPLOAD_MAX_SCAN_BYTES:-1073741824}" \
  UPLOAD_MAX_OPEN_PER_SPACE="${UPLOAD_MAX_OPEN_PER_SPACE:-16}" \
  UPLOAD_MAX_CONCURRENT_PARTS="${UPLOAD_MAX_CONCURRENT_PARTS:-4}" \
  JOB_MAX_PENDING_PER_SPACE="${JOB_MAX_PENDING_PER_SPACE:-16}" \
  RUST_LOG="${RUST_LOG:-info}" \
  start api "$target/debug/metaverse-api"
wait_http api "$api/api/healthz" 120

# ---------------------------------------------------------------------------
# 处理服务
# ---------------------------------------------------------------------------
if [[ $with_worker -eq 1 ]]; then
  if [[ ! -x "$venv/bin/metaverse-worker" ]]; then
    say "警告：worker/.venv 里没有 metaverse-worker 入口，跳过处理服务"
  else
    port_busy "$worker_health_port" && die "端口 $worker_health_port 已被占用（用 WORKER_HEALTH_PORT 换一个）"
    say "启动处理服务（健康检查端口 $worker_health_port）"
    MONGODB_URI="$mongo_uri" \
      MONGODB_DATABASE="$database" \
      WORKER_HEALTH_PORT="$worker_health_port" \
      PYTHONUNBUFFERED=1 \
      start worker "$venv/bin/metaverse-worker"
    sleep 3
    if ! alive worker; then
      tail -n 20 "$run/worker.log" >&2 || true
      say "警告：处理服务启动后退出了（日志：$run/worker.log），其他服务照常运行"
    elif ! curl -fsS -o /dev/null "http://127.0.0.1:$worker_health_port/healthz" 2>/dev/null; then
      say "处理服务在运行，健康检查端口暂时没有响应（日志：$run/worker.log）"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 网站开发服务器
# ---------------------------------------------------------------------------
if [[ $with_web -eq 1 ]]; then
  port_busy "$web_port" && die "端口 $web_port 已被占用（用 METAVERSE_WEB_PORT 换一个）"
  if [[ ! -f "$repo/web/node_modules/.package-lock.json" || "$repo/web/package-lock.json" -nt "$repo/web/node_modules/.package-lock.json" ]]; then
    say "安装网站依赖（npm ci）"
    (cd "$repo/web" && npm ci --no-audit --no-fund)
  fi
  say "启动网站开发服务器：http://127.0.0.1:$web_port"
  # 不进子 shell（子 shell 里没有作业控制，进程组就分不开）；npm 会在 web/ 目录里跑脚本。
  METAVERSE_API_URL="$api" start web npm --prefix "$repo/web" run dev -- --host 127.0.0.1 --port "$web_port" --strictPort
  wait_http web "http://127.0.0.1:$web_port/" 60
fi

cat <<EOF

本地全套已启动（停止：infra/dev/down.sh；日志：infra/dev/.run/*.log）
  MongoDB      $mongo_uri（库 $database）
  模拟 NyxID   $nyx（服务编号 dev-service，组织角色：infra/dev/org-roles.json）
  接口服务     $api/api/healthz
EOF
[[ $with_web -eq 1 ]] && echo "  网站         http://127.0.0.1:$web_port/"
alive worker && echo "  处理服务     http://127.0.0.1:$worker_health_port/healthz"
cat <<EOF

调用示例（每次自动取新令牌，详见 infra/dev/README.md）：
  node infra/dev/call.mjs --as alice POST /api/v1/admin/spaces \\
    '{"id":"front-hall","name":"公司前厅","owner":{"kind":"org","id":"chronoai"}}'
EOF
