#!/usr/bin/env bash
# 一键起本地全套（只监听 127.0.0.1）：
#   MongoDB 副本集（已有就复用）→ 模拟 NyxID → 接口服务（含后台执行器：上传核对、ops_from_upload、
#   定期清理）→ 网站开发服务器（/api 转给本地接口服务）
#
# 处理服务已下线（docs/design/server-slim.md）：上传核对由接口服务自己做，重建改在本地用重建工具做。
#
# 用法：infra/dev/up.sh [--no-web] [--demo-seed[=<种子.json>]]
# 停止：infra/dev/down.sh
# 日志和进程号：infra/dev/.run/
#
# --demo-seed：接口服务启动后按部署配置种子建演示空间、导入扫描（默认用线上的 infra/chrono-cd/demo-seed.json，
#   会从种子里的地址下载扫描）。也可以用环境变量 METAVERSE_DEV_DEMO_SEED=<种子.json>；
#   METAVERSE_DEV_DEMO_SEED_OWNER=chronoai 把主人换成本地模拟 NyxID 的组织（alice 就能管理它）；
#   分享令牌取 METAVERSE_DEMO_SHARE_TOKEN，没设时生成一个存在 infra/dev/.run/demo-share-token（之后复用）。
#
# 可用环境变量改端口和库名（默认值在括号里）：
#   METAVERSE_MONGODB_URI（自动找 127.0.0.1:27017 / 27018 上的 rs0 副本集）
#   METAVERSE_DEV_DATABASE（chrono_metaverse_dev）
#   MOCK_NYXID_PORT（8090）、METAVERSE_API_PORT（8080）、METAVERSE_WEB_PORT（5173）
#   METAVERSE_DEV_MONGO_PORT（27017，本脚本自己起 mongod 时用）、MONGOD_BIN（mongod 可执行文件）
#   UPLOAD_MAX_SCAN_BYTES、UPLOAD_MAX_OPEN_PER_SPACE、UPLOAD_MAX_CONCURRENT_PARTS、JOB_MAX_PENDING_PER_SPACE
#     （传给接口服务的上传和任务上限，其余 UPLOAD_* 用接口服务的默认值）
#   RUNNER_POLL_SECONDS、CLEANUP_INTERVAL_SECONDS（后台执行器和定期清理，默认用接口服务的默认值）
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
run="$repo/infra/dev/.run"
mkdir -p "$run"

mock_port=${MOCK_NYXID_PORT:-8090}
api_port=${METAVERSE_API_PORT:-8080}
web_port=${METAVERSE_WEB_PORT:-5173}
database=${METAVERSE_DEV_DATABASE:-chrono_metaverse_dev}
mongo_port=${METAVERSE_DEV_MONGO_PORT:-27017}

with_web=1
seed_file=${METAVERSE_DEV_DEMO_SEED:-}
for arg in "$@"; do
  case "$arg" in
    --no-worker) echo "[up] 处理服务已下线，--no-worker 不再需要（忽略）" >&2 ;;
    --no-web) with_web=0 ;;
    --demo-seed) seed_file="$repo/infra/chrono-cd/demo-seed.json" ;;
    --demo-seed=*) seed_file=${arg#--demo-seed=} ;;
    -h | --help)
      sed -n '2,23p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "不认识的参数：$arg（可用 --no-web、--demo-seed[=<种子.json>]）" >&2
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

for name in mongod mock-nyxid api web; do
  if alive "$name"; then
    die "$name 已经在运行（进程号 $(cat "$run/$name.pid")），先运行 infra/dev/down.sh"
  fi
done

# 打印副本集名；连不上或不是副本集时返回非 0（infra/dev/mongo.mjs，不需要 MongoDB 驱动）。
replica_set_name() {
  node "$repo/infra/dev/mongo.mjs" set-name "$1" 2>/dev/null
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
      if name=$(replica_set_name "$port"); then
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
  node "$repo/infra/dev/mongo.mjs" init "$mongo_port" 60 || die "mongod 没有选出主节点（日志：$run/mongod.log）"
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
# 部署配置种子（可选）：压缩成一行交给接口服务，分享令牌生成一次后复用
# ---------------------------------------------------------------------------
seed_json=""
seed_token=""
seed_space=""
if [[ -n "$seed_file" ]]; then
  [[ -f "$seed_file" ]] || die "种子配置不存在：$seed_file"
  owner_args=()
  if [[ -n "${METAVERSE_DEV_DEMO_SEED_OWNER:-}" ]]; then
    owner_args=(--owner "$METAVERSE_DEV_DEMO_SEED_OWNER")
  fi
  seed_json=$(node "$repo/infra/dev/demo-seed.mjs" compact "$seed_file" "${owner_args[@]}") || die "种子配置读不出来：$seed_file"
  seed_space=$(node "$repo/infra/dev/demo-seed.mjs" space-id "$seed_file") || die "种子配置没有 spaceId：$seed_file"
  seed_token=${METAVERSE_DEMO_SHARE_TOKEN:-}
  if [[ -z "$seed_token" ]]; then
    if [[ -s "$run/demo-share-token" ]]; then
      seed_token=$(cat "$run/demo-share-token")
    else
      seed_token=$(node "$repo/infra/dev/demo-seed.mjs" token)
      (umask 077 && printf '%s\n' "$seed_token" >"$run/demo-share-token")
    fi
  fi
  say "部署配置种子：$seed_file（空间 $seed_space），接口服务建好索引后在后台导入"
fi

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
  RUNNER_POLL_SECONDS="${RUNNER_POLL_SECONDS:-2}" \
  CLEANUP_INTERVAL_SECONDS="${CLEANUP_INTERVAL_SECONDS:-600}" \
  METAVERSE_DEMO_SEED="$seed_json" \
  METAVERSE_DEMO_SHARE_TOKEN="$seed_token" \
  RUST_LOG="${RUST_LOG:-info}" \
  start api "$target/debug/metaverse-api"
wait_http api "$api/api/healthz" 120

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
echo "  本地重建工具 worker/.venv/bin/metaverse-recon（没有就 cd worker && uv sync --frozen --extra dev）"
if [[ -n "$seed_space" ]]; then
  cat <<EOF
  演示空间     http://127.0.0.1:$web_port/s/$seed_space#share=$seed_token
               （种子在后台下载；旧格式种子的导入任务要处理服务，现在会被定期清理标记失败，
                见 docs/design/server-slim.md 13.3；分享令牌在 infra/dev/.run/demo-share-token）
EOF
fi
cat <<EOF

调用示例（每次自动取新令牌，详见 infra/dev/README.md）：
  node infra/dev/call.mjs --as alice POST /api/v1/admin/spaces \\
    '{"id":"front-hall","name":"公司前厅","owner":{"kind":"org","id":"chronoai"}}'
EOF
