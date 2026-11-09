//! chrono-metaverse 接口服务入口（参照 CMA `main.rs`）。

use metaverse_api::{app, config::Config, AppState};

const DEFAULT_LOG_FILTER: &str = "info";

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        // 与 CMA 相同：容器日志不带颜色控制符。
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("RUST_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(DEFAULT_LOG_FILTER)),
        )
        .init();
    if let Err(error) = serve().await {
        tracing::error!(error = %error, "接口服务退出");
        std::process::exit(1);
    }
}

async fn serve() -> Result<(), String> {
    // 鉴权配置缺失时直接启动失败。
    let config = Config::from_env().map_err(|error| format!("配置不可用：{error}"))?;
    let state = AppState::from_config(&config).await?;
    // 先监听再建索引：建好之前 /api/healthz 返回 503，平台不会把流量导过来。
    state.spawn_preparation();
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|error| format!("无法监听 {}：{error}", config.bind))?;
    tracing::info!(
        bind = %config.bind,
        public_base_url = %config.public_base_url,
        database = %config.mongodb_database,
        services = ?config.nyxid.allowed_service_ids,
        "接口服务启动"
    );
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| format!("HTTP 服务出错：{error}"))
}

/// 收到 SIGTERM（滚动更新）或 Ctrl-C 时停止接收新连接，处理完进行中的请求再退出。
async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = interrupt => {},
        _ = terminate => {},
    }
    tracing::info!("收到停止信号，正在退出");
}
