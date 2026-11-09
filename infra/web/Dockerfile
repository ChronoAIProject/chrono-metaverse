# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# 网站镜像（metaverse-web）。构建上下文是仓库根目录：
#   docker build -f infra/web/Dockerfile .
# 参照 CMA infra/web/Dockerfile：node 构建，nginx 非特权镜像托管，监听 8080，
# /api/ 同源转给接口服务（web/nginx.conf）。
# 构建前端和基础镜像都按摘要固定（标签只作记号），更新时取同一标签的新摘要（Dependabot 会提）。

# ---- 构建 ----
# 用 glibc 的 Debian 镜像：锁文件里 rollup 等原生包的 gnu 版本最常用，少一类 musl 问题。
FROM node:22.23.4-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,id=metaverse-web-npm,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund
COPY web/ ./
# 构建身份（web/build/identity.ts）：本地构建默认 local；CI 传入完整提交哈希和
# git-<12 位哈希>，并标成 promotable。ARG 只在构建阶段的命令里可见，不留在镜像里。
ARG CHRONO_BUILD=dev
ARG CHRONO_BUILD_SHA=
ARG CHRONO_BUILD_ARTIFACT=local
RUN npm run build

# ---- 运行 ----
FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
LABEL org.opencontainers.image.source="https://github.com/ChronoAIProject/chrono-metaverse" \
      org.opencontainers.image.title="chrono-metaverse-web" \
      org.opencontainers.image.description="chrono-metaverse 只读查看器（nginx 托管，/api/ 转给接口服务）"
COPY --from=build /build/web/dist /usr/share/nginx/html
# 上游地址写死为 metaverse-api:8080：chrono-cd 里同一组织的服务按服务名互相访问
# （http://<服务名>:<端口>），服务名在 infra/chrono-cd/app.json 里固定为 metaverse-api。
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
# chrono-cd 要求数字形式的非 root 用户；101 是这个镜像自带的 nginx 用户。
USER 101:101
EXPOSE 8080
# 健康检查由 chrono-cd 的探针负责（/healthz），见 infra/chrono-cd/app.json。
