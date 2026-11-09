# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# 处理服务镜像（metaverse-worker）。构建上下文是仓库根目录：
#   docker build -f infra/worker/Dockerfile .
# 构建阶段把 worker 包和依赖装进 /opt/venv，运行阶段只拷这个虚拟环境。
# 配置全部由部署时的环境变量注入（worker/src/metaverse_worker/config.py），这里不写 ENV。
# 构建前端和基础镜像都按摘要固定（标签只作记号），更新时取同一标签的新摘要（Dependabot 会提）。

FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv

# ---- 构建 ----
FROM python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src/worker
COPY worker/ ./
COPY infra/worker/build-requirements.txt /tmp/build-requirements.txt
# 依赖都有 manylinux 预编译包（numpy、scipy、pillow、trimesh、DracoPy、pymongo、
# fast-simplification），不需要编译器。依赖一律按 uv.lock 的版本和哈希装（没有锁文件就失败）。
# worker 包本身的构建后端也要固定：uv.lock 不锁构建依赖，默认的构建隔离会从 PyPI 拉最新的
# setuptools。所以按 build-requirements.txt 的版本和哈希装进虚拟环境，关掉构建隔离装 worker 包，
# 装完删掉（运行时不需要）。字节码在构建时编译好：运行用户没有写权限。
RUN --mount=type=cache,id=metaverse-worker-uv,target=/root/.cache/uv,sharing=locked <<'INSTALL'
set -eu
export UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never
uv venv /opt/venv --python /usr/local/bin/python3.13
uv export --frozen --no-dev --no-emit-project -o /tmp/requirements.txt
uv pip install --python /opt/venv/bin/python --require-hashes -r /tmp/requirements.txt
uv pip install --python /opt/venv/bin/python --require-hashes -r /tmp/build-requirements.txt
uv pip install --python /opt/venv/bin/python --no-deps --no-build-isolation .
uv pip uninstall --python /opt/venv/bin/python setuptools
/opt/venv/bin/python -c 'import metaverse_worker'
test -x /opt/venv/bin/metaverse-worker
if /opt/venv/bin/python -c 'import setuptools' 2>/dev/null; then
  echo '构建后端 setuptools 不应留在运行环境里' >&2
  exit 1
fi
INSTALL

# ---- 运行 ----
FROM python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS runtime
LABEL org.opencontainers.image.source="https://github.com/ChronoAIProject/chrono-metaverse" \
      org.opencontainers.image.title="chrono-metaverse-worker" \
      org.opencontainers.image.description="chrono-metaverse 处理服务：上传校验、扫描对齐、重建、体素化、清理"
# 有家目录的数字用户：个别库会往 ~/.cache 写缓存。
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/worker --shell /usr/sbin/nologin worker
COPY --from=build /opt/venv /opt/venv
WORKDIR /home/worker
# chrono-cd 要求数字形式的非 root 用户。
USER 10001:10001
# 健康检查端口由处理服务的环境变量决定（见 infra/chrono-cd/app.json）。
EXPOSE 8080
ENTRYPOINT ["/opt/venv/bin/metaverse-worker"]
