#!/usr/bin/env bash
# 持续集成用：起一个单节点 MongoDB 副本集（接口服务和处理服务的集成测试要用事务和变更流，
# 必须是副本集）。监听 127.0.0.1:27017，副本集名 rs0：
#   mongodb://127.0.0.1:27017/?replicaSet=rs0
#
# 为什么不用 GitHub Actions 的 services 容器：services 不能给容器传启动参数，
# 没法加 --replSet；所以和 CMA（.github/scripts/mongo-contract-tests.sh）一样直接 docker run。
# 版本与 chrono-cd 的 MongoDB 插件（Atlas，MongoDB 8）同一大版本。
set -euo pipefail

# 与 CMA 的 mongo-contract-tests.sh 同一个镜像（按摘要固定）。
readonly image="mongo:8.0.13@sha256:cf340b1e5283843c63eb12999922f20c463ae31285f746d30f05dcc21cd1d47c"
readonly name="metaverse-mongo"

# 任何一步失败都打印容器日志，方便排查（容器启动后立即退出时尤其需要）。
# 只在 ERR 陷阱里调用，shellcheck 看不出来。
# shellcheck disable=SC2317
show_logs() {
  echo "MongoDB 启动失败，容器日志：" >&2
  docker ps --all --filter "name=$name" >&2 || true
  docker logs "$name" 2>&1 | tail -80 >&2 || true
}
trap 'show_logs' ERR

docker run --detach --name "$name" --publish 127.0.0.1:27017:27017 "$image" \
  --replSet rs0 --bind_ip_all >/dev/null

mongosh_eval() {
  docker exec "$name" mongosh --quiet --eval "$1"
}

for _ in $(seq 1 60); do
  if mongosh_eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# 成员地址写 127.0.0.1:27017：容器里是 mongod 自己，宿主机上是映射出来的同一端口，
# 测试进程按副本集成员地址重连时两边都能连上。
mongosh_eval 'try { rs.status().ok } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] }).ok }' >/dev/null

for _ in $(seq 1 60); do
  if [[ "$(mongosh_eval 'db.hello().isWritablePrimary' 2>/dev/null)" == "true" ]]; then
    echo "MongoDB 副本集已就绪：mongodb://127.0.0.1:27017/?replicaSet=rs0"
    exit 0
  fi
  sleep 1
done

echo "MongoDB 副本集没有在 60 秒内选出主节点" >&2
docker logs "$name" | tail -50 >&2
exit 1
