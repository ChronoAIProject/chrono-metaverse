#!/usr/bin/env bash
# 设计 9.4："数据访问层以外的代码不能直接访问数据库集合。"
#
# - 接口服务（api/crates/metaverse-api/src）里，只有 repo/ 可以碰 MongoDB 驱动；
#   其他文件一律通过 repo/ 的方法读写（这些方法都要求授权凭据）。
# - 核心库（api/crates/metaverse-core）是纯计算，不能依赖数据库驱动。
#
# 接口服务的单元测试 repo::tests::only_repo_touches_the_database 做同样的检查；
# 这个脚本不需要编译，在持续集成里单独跑，失败时直接列出位置。
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
api_src="$root/api/crates/metaverse-api/src"
core="$root/api/crates/metaverse-core"
status=0

[[ -d "$api_src/repo" ]] || { echo "找不到 $api_src/repo" >&2; exit 2; }

# 直接访问数据库的写法：驱动路径、取集合、集合类型、裸命令、GridFS、取数据库句柄。
pattern='mongodb::|\.collection(::<[^>]*>)?\(|Collection<|run_command|gridfs_bucket|\.database\('
if offenders=$(grep -rnE --include='*.rs' "$pattern" "$api_src" | grep -v "^$api_src/repo/"); then
  echo "repo/ 以外直接访问了数据库（改成调用 repo/ 里要求授权凭据的方法）：" >&2
  echo "${offenders//$root\//}" >&2
  status=1
fi

if grep -nE '^\s*mongodb\s*=' "$core/Cargo.toml" >/dev/null; then
  echo "metaverse-core 依赖了 mongodb：核心库必须是纯计算（api/README.md）" >&2
  status=1
fi
if offenders=$(grep -rnE --include='*.rs' 'mongodb::|bson::' "$core/src"); then
  echo "metaverse-core 里出现了数据库驱动：" >&2
  echo "${offenders//$root\//}" >&2
  status=1
fi

if [[ $status -eq 0 ]]; then
  echo "数据访问边界检查通过：只有 api/crates/metaverse-api/src/repo/ 访问数据库。"
fi
exit "$status"
