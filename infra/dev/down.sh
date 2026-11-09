#!/usr/bin/env bash
# 停止 infra/dev/up.sh 起的进程（按进程组整体停止）。
# 只停本脚本起的东西：复用的 MongoDB 不动；up.sh 自己起的 mongod 会停，数据留在 infra/dev/.run/mongo-data。
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
run="$repo/infra/dev/.run"

stop() {
  local name=$1 grace=$2 pidfile="$run/$1.pid" pid
  [[ -f "$pidfile" ]] || return 0
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    echo "[down] 停止 $name（进程号 $pid）"
    # 进程组号就是进程号（up.sh 用 set -m 起的）；不行再只停这个进程。
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 "$grace"); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[down] $name 没有在 $grace 秒内退出，强制结束"
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pidfile"
}

stop web 10
stop worker 25
stop api 15
stop mock-nyxid 5
stop mongod 30
echo "[down] 已停止"
