# syntax=docker/dockerfile:1
# 接口服务镜像（metaverse-api）。构建上下文是仓库根目录：
#   docker build -f infra/api/Dockerfile .
# 参照 CMA infra/api/Dockerfile：多阶段构建，配置全部由部署时的环境变量注入，这里不写 ENV。

# ---- 构建：与 api/rust-toolchain.toml 相同的工具链 ----
FROM rust:1.97.0-slim-trixie AS build
WORKDIR /build
COPY api/ ./
# RUSTUP_TOOLCHAIN 只在这条命令里生效：直接用镜像自带的 1.97.0，
# 不按 rust-toolchain.toml 再去下载 rustfmt、clippy（构建用不到）。
# 依赖缓存与编译目录挂缓存卷，二进制在同一步里拷出来（缓存卷不进镜像层）。
RUN --mount=type=cache,id=metaverse-api-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=metaverse-api-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=metaverse-api-target,target=/build/target,sharing=locked \
    RUSTUP_TOOLCHAIN=1.97.0 cargo build --release --locked --bin metaverse-api \
    && install -D -m 0755 target/release/metaverse-api /out/metaverse-api

# ---- 运行：distroless（只有 glibc、libgcc 和 CA 证书，没有 shell） ----
# 与构建镜像同为 Debian 13，glibc 版本一致。依赖全部是 rustls（不链接 OpenSSL）。
# distroless 没有版本号标签，按摘要固定；更新时取 nonroot 标签的新摘要。
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cc66d222f0a7ec996b78a99fe76a969bc80b539a5016ad866c14d1949bc6d0ab AS runtime
LABEL org.opencontainers.image.source="https://github.com/ChronoAIProject/chrono-metaverse" \
      org.opencontainers.image.title="chrono-metaverse-api" \
      org.opencontainers.image.description="chrono-metaverse 接口服务：公开读、写和管理接口，NyxID 鉴权"
COPY --from=build /out/metaverse-api /usr/local/bin/metaverse-api
# chrono-cd 要求数字形式的非 root 用户（写成 nonroot 这样的用户名会启动失败）。
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/metaverse-api"]
# 健康检查由 chrono-cd 的探针负责（/api/healthz），见 infra/chrono-cd/app.json。
