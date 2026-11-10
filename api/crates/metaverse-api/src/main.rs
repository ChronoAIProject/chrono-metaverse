//! chrono-metaverse 接口服务入口（参照 CMA `main.rs`）。

use metaverse_api::{app, config::Config, runner, AppState};

const DEFAULT_LOG_FILTER: &str = "info";

fn main() {
    tracing_subscriber::fmt()
        // 与 CMA 相同：容器日志不带颜色控制符。
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("RUST_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(DEFAULT_LOG_FILTER)),
        )
        .init();
    // 运行时至少 2 个工作线程（docs/design/server-slim.md 4.2）：`cpu_limit = 1` 时默认只有 1 个，
    // 后台核对的计算（虽然都在阻塞线程池里）和请求就会挤在同一个线程上。
    let workers = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .max(2);
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(error = %error, "建不了异步运行时");
            std::process::exit(1);
        }
    };
    if let Err(error) = runtime.block_on(serve()) {
        tracing::error!(error = %error, "接口服务退出");
        std::process::exit(1);
    }
}

async fn serve() -> Result<(), String> {
    // 鉴权配置缺失时直接启动失败。
    let config = Config::from_env().map_err(|error| format!("配置不可用：{error}"))?;
    let state = AppState::from_config(&config).await?;
    // 先监听再建索引：建好之前 /api/healthz 返回 503，平台不会把流量导过来。
    let preparation = state.spawn_preparation();
    // 后台执行器、定期清理、后台迁移：索引建好之后开始。
    let background = runner::spawn_background(state.clone(), config.runner.clone());
    // 部署配置种子（演示空间）：索引建好之后在后台执行，失败只记日志，不影响就绪。
    if let Some(seed) = config.demo_seed.clone() {
        tracing::info!(space = %seed.space_id, revision = seed.revision, "已配置部署配置种子，索引建好后执行");
        metaverse_api::demo_seed::spawn(state.clone(), seed, preparation);
    }
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|error| format!("无法监听 {}：{error}", config.bind))?;
    tracing::info!(
        bind = %config.bind,
        public_base_url = %config.public_base_url,
        database = %config.mongodb_database,
        services = ?config.nyxid.allowed_service_ids,
        instance = %config.runner.instance_id,
        "接口服务启动"
    );
    // 带上连接地址：公开接口默认按连接地址限流（设计 8.2）。
    let served = axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown({
        // 收到停止信号时同时通知后台循环：不再领取新任务，和处理中的请求一起收尾。
        let stop = background.stop_signal();
        async move {
            shutdown_signal().await;
            stop.send();
        }
    })
    .await
    .map_err(|error| format!("HTTP 服务出错：{error}"));
    // 不再领取新任务；手上的任务最多等 20 秒，做不完的退回队列（平台终止宽限 30 秒）。
    background.stop().await;
    served
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
