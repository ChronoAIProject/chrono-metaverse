# syntax=docker/dockerfile:1
# 处理服务镜像（metaverse-worker）。构建上下文是仓库根目录：
#   docker build -f infra/worker/Dockerfile .
# 构建阶段把 worker 包和依赖装进 /opt/venv，运行阶段只拷这个虚拟环境。
# 配置全部由部署时的环境变量注入（worker/src/metaverse_worker/config.py），这里不写 ENV。

FROM ghcr.io/astral-sh/uv:0.11.32 AS uv

# ---- 构建 ----
FROM python:3.13.18-slim-trixie AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src/worker
COPY worker/ ./
# 依赖都有 manylinux 预编译包（numpy、scipy、pillow、trimesh、DracoPy、pymongo、
# fast-simplification），不需要编译器。有 uv.lock 时按锁定版本装依赖，没有时按
# pyproject.toml 的版本范围装。字节码在构建时编译好：运行用户没有写权限。
RUN --mount=type=cache,id=metaverse-worker-uv,target=/root/.cache/uv,sharing=locked <<'INSTALL'
set -eu
export UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never
uv venv /opt/venv --python /usr/local/bin/python3.13
if [ -f uv.lock ]; then
  uv export --frozen --no-dev --no-emit-project -o /tmp/requirements.txt
  uv pip install --python /opt/venv/bin/python -r /tmp/requirements.txt
  uv pip install --python /opt/venv/bin/python --no-deps .
else
  uv pip install --python /opt/venv/bin/python .
fi
/opt/venv/bin/python -c 'import metaverse_worker'
test -x /opt/venv/bin/metaverse-worker
INSTALL

# ---- 运行 ----
FROM python:3.13.18-slim-trixie AS runtime
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
