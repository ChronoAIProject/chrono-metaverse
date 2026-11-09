//! 后台执行器（docs/design/server-slim.md 4.2）：接口服务进程里一个常驻的异步循环，执行上传核对
//! （`upload_verify`）和重任务（`ops_from_upload`；部署种子的 `bundle_import` 由后面的步骤接上）。
//! 状态和租约都存在库里，进程重启、换副本后照样接着做。
//!
//! - **名额**：两类，各有进程内的信号量：核对 `RUNNER_VERIFY_SLOTS`（默认 2），重任务
//!   `RUNNER_HEAVY_SLOTS`（默认 1）。哪一类有空名额才去领那一类的任务，核对先领；
//! - **每个空间同时一个**：领取时排除已有运行中、租约未过期任务的空间
//!   （`RUNNER_MAX_JOBS_PER_SPACE`）；
//! - **领取、续约、栅栏**：见 `repo/runner.rs`。续约匹配不到说明租约丢了，立刻取消这个任务；
//!   任务的任何写入都带栅栏，丢了租约的执行器什么都写不进去；
//! - **重试**：失败分三类——`content` 直接失败；`fetch`、`transient` 按退避
//!   `30 秒 × 2^(attempt−1)` 退回队列，次数用完后失败；最终失败后调用这一种任务的收尾
//!   （上传核对：上传不能停在 `complete`）；
//! - **停止**：收到停止信号后不再领取；手上的任务等最多 20 秒，做不完就取消、按栅栏退回队列并把
//!   `attempt` 减 1；进程被直接杀掉时，租约过期后由别的进程重新领取；
//! - **通知**：完成上传、`ops-from-upload` 建好任务后用 [`JobSignal`] 叫醒本进程的执行器，不等轮询；
//! - **健康检查不带后台状态**：执行器的状态只写结构化日志（每次领取、完成、失败各一条，带任务种类、
//!   空间、耗时）；循环异常退出时记错误日志、5 秒后重启。
//!
//! 定期清理（[`cleanup`]）和后台迁移（[`migrations`]）是另外两个常驻循环，由 [`spawn_background`]
//! 一起启动。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use metaverse_core::model::{ErrorClass, Job, JobError, JobKind};
use metaverse_core::Timestamp;
use tokio::sync::{watch, Notify, Semaphore};
use tokio::task::{AbortHandle, JoinHandle};

use crate::auth::{BackgroundGrant, Grant};
use crate::error::ApiError;
use crate::repo::{JobFence, RepoError};
use crate::AppState;

pub mod cleanup;
pub mod config;
pub mod migrations;
pub mod ops_job;
pub mod upload_verify;
pub mod verify;

pub use config::{RunnerConfig, STOP_GRACE_SECONDS};

/// 进程内通知：完成上传、建好任务以后叫醒执行器（不等轮询）。
#[derive(Debug, Default)]
pub struct JobSignal(Notify);

impl JobSignal {
    pub fn notify(&self) {
        self.0.notify_one();
    }

    async fn wait(&self) {
        self.0.notified().await;
    }
}

/// 名额的类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotClass {
    /// 上传核对。
    Verify,
    /// 重任务。
    Heavy,
}

impl SlotClass {
    /// 这一类领取哪些种类。部署种子的 `bundle_import` 等它的处理代码接上以后再加进来。
    pub fn kinds(self) -> &'static [JobKind] {
        match self {
            SlotClass::Verify => &[JobKind::UploadVerify],
            SlotClass::Heavy => &[JobKind::OpsFromUpload],
        }
    }

    fn name(self) -> &'static str {
        match self {
            SlotClass::Verify => "verify",
            SlotClass::Heavy => "heavy",
        }
    }
}

/// 领到的任务和它的栅栏。
#[derive(Debug, Clone)]
pub struct Lease {
    pub job: Job,
    pub fence: JobFence,
}

/// 处理一个任务出错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobFailure {
    /// 内容不合规、参数不对：不重试。
    Content(String),
    /// 下载失败：按退避重试。
    Fetch(String),
    /// 数据库抖动、草稿在处理期间被别人改了：按退避重试。
    Transient(String),
    /// 租约已经丢了：什么都不写，由新的持有者决定。
    LeaseLost,
    /// 处理代码已经把最终状态写好了（例如上传和任务在同一个事务里标记失败）。
    Recorded,
}

impl From<RepoError> for JobFailure {
    fn from(error: RepoError) -> Self {
        match error {
            RepoError::Unavailable | RepoError::Duplicate => {
                JobFailure::Transient(format!("数据库暂时不可用：{error}"))
            }
            RepoError::GrantMismatch | RepoError::Corrupt(_) => {
                JobFailure::Content(format!("记录不一致：{error}"))
            }
        }
    }
}

impl From<ApiError> for JobFailure {
    fn from(error: ApiError) -> Self {
        if error.status.is_server_error() {
            JobFailure::Transient(error.detail.into_owned())
        } else {
            JobFailure::Content(error.detail.into_owned())
        }
    }
}

/// 一个任务的结局（日志和测试用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// 最终失败。
    Failed(ErrorClass),
    /// 退回队列，过一会儿重试。
    Retrying(ErrorClass),
    LeaseLost,
    /// 停止时被取消（已退回队列）。
    Stopped,
}

/// 退避：`30 秒 × 2^(attempt−1)`。
pub fn retry_delay_seconds(attempt: u32) -> i64 {
    30 * (1i64 << attempt.saturating_sub(1).min(10))
}

/// 错误说明最多保留的字符数。
const MAX_ERROR_CHARS: usize = 2000;

/// 后台执行器。
pub struct Runner {
    pub(crate) state: AppState,
    pub(crate) config: RunnerConfig,
    pub(crate) background: BackgroundGrant,
    verify_slots: Arc<Semaphore>,
    heavy_slots: Arc<Semaphore>,
    /// 正在处理的任务（停止时取消、退回队列）。
    running: Mutex<HashMap<String, (JobFence, AbortHandle)>>,
}

impl Runner {
    pub fn new(state: AppState, config: RunnerConfig) -> Arc<Self> {
        let background = state.authorizer.background("runner");
        Arc::new(Self {
            verify_slots: Arc::new(Semaphore::new(config.verify_slots)),
            heavy_slots: Arc::new(Semaphore::new(config.heavy_slots)),
            state,
            config,
            background,
            running: Mutex::new(HashMap::new()),
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.config.instance_id
    }

    /// 本进程正在处理的任务数。
    pub fn running_jobs(&self) -> usize {
        self.running.lock().expect("正在处理的任务表").len()
    }

    fn slots(&self, class: SlotClass) -> &Arc<Semaphore> {
        match class {
            SlotClass::Verify => &self.verify_slots,
            SlotClass::Heavy => &self.heavy_slots,
        }
    }

    fn lease_until(&self, now: Timestamp) -> Timestamp {
        now.saturating_add_seconds(self.config.lease_seconds as i64)
    }

    /// 领取一个这一类的任务（`now` 由调用方给，测试可以模拟时间）。
    pub async fn claim(
        &self,
        class: SlotClass,
        now: Timestamp,
    ) -> Result<Option<Lease>, RepoError> {
        let repo = &self.state.repo;
        let busy = repo
            .saturated_spaces(&self.background, now, self.config.max_jobs_per_space)
            .await?;
        let Some(job) = repo
            .claim_job(
                &self.background,
                class.kinds(),
                &self.config.instance_id,
                now,
                self.lease_until(now),
                &busy,
            )
            .await?
        else {
            return Ok(None);
        };
        tracing::info!(
            job = %job.id,
            kind = job.kind.name(),
            space = %job.space_id,
            attempt = job.attempt,
            slot = class.name(),
            "领取任务"
        );
        Ok(Some(Lease {
            fence: JobFence {
                job_id: job.id.clone(),
                attempt: job.attempt,
                owner: self.config.instance_id.clone(),
            },
            job,
        }))
    }

    /// 处理一个领到的任务：处理代码和续约一起跑，续约失败就取消；结束后按结果写任务状态。
    pub async fn execute(self: &Arc<Self>, lease: Lease) -> Outcome {
        let started = Instant::now();
        let runner = self.clone();
        let task_lease = lease.clone();
        let mut handle = tokio::spawn(async move { runner.handle(&task_lease).await });
        self.running.lock().expect("正在处理的任务表").insert(
            lease.job.id.clone(),
            (lease.fence.clone(), handle.abort_handle()),
        );
        let heartbeat = self.heartbeat(&lease.fence);
        tokio::pin!(heartbeat);
        let result = tokio::select! {
            joined = &mut handle => match joined {
                Ok(result) => result,
                Err(error) if error.is_cancelled() => {
                    self.running.lock().expect("正在处理的任务表").remove(&lease.job.id);
                    return Outcome::Stopped;
                }
                Err(error) => {
                    tracing::error!(job = %lease.job.id, error = %error, "处理任务时内部出错");
                    Err(JobFailure::Transient("执行器内部出错".to_owned()))
                }
            },
            () = &mut heartbeat => {
                handle.abort();
                Err(JobFailure::LeaseLost)
            }
        };
        self.running
            .lock()
            .expect("正在处理的任务表")
            .remove(&lease.job.id);
        let outcome = self.settle(&lease, result).await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Outcome::Done => tracing::info!(
                job = %lease.job.id, kind = lease.job.kind.name(), space = %lease.job.space_id,
                elapsed_ms, "任务完成"
            ),
            other => tracing::warn!(
                job = %lease.job.id, kind = lease.job.kind.name(), space = %lease.job.space_id,
                elapsed_ms, outcome = ?other, "任务没有完成"
            ),
        }
        outcome
    }

    /// 按种类分派。
    async fn handle(self: &Arc<Self>, lease: &Lease) -> Result<(), JobFailure> {
        match lease.job.kind {
            JobKind::UploadVerify => upload_verify::run(self, lease).await,
            JobKind::OpsFromUpload => ops_job::run(self, lease).await,
            other => Err(JobFailure::Content(format!(
                "执行器不处理 {} 任务",
                other.name()
            ))),
        }
    }

    /// 续约：每 `RUNNER_HEARTBEAT_SECONDS` 秒按栅栏续一次，匹配不到（租约丢了）就返回。
    async fn heartbeat(&self, fence: &JobFence) {
        let period = Duration::from_secs(self.config.heartbeat_seconds);
        loop {
            tokio::time::sleep(period).await;
            let Ok(now) = crate::now() else {
                continue;
            };
            match self
                .state
                .repo
                .renew_job(&self.background, fence, self.lease_until(now))
                .await
            {
                Ok(true) => {}
                Ok(false) => {
                    tracing::warn!(job = %fence.job_id, "续约失败：租约已经丢了，取消这个任务");
                    return;
                }
                Err(error) => {
                    tracing::warn!(job = %fence.job_id, error = %error, "续约时数据库出错")
                }
            }
        }
    }

    /// 按处理结果写任务状态（测试也直接调用它核对重试分类）。
    pub async fn settle(&self, lease: &Lease, result: Result<(), JobFailure>) -> Outcome {
        let (class, message) = match result {
            Ok(()) => return Outcome::Done,
            Err(JobFailure::Recorded) => return Outcome::Failed(ErrorClass::Content),
            Err(JobFailure::LeaseLost) => return Outcome::LeaseLost,
            Err(JobFailure::Content(message)) => (ErrorClass::Content, message),
            Err(JobFailure::Fetch(message)) => (ErrorClass::Fetch, message),
            Err(JobFailure::Transient(message)) => (ErrorClass::Transient, message),
        };
        let now = crate::now().unwrap_or(lease.job.created_at);
        let message: String = message.chars().take(MAX_ERROR_CHARS).collect();
        let error = JobError::Detail {
            class,
            message: message.clone(),
            at: now,
        };
        let retry = class != ErrorClass::Content && lease.job.attempt < lease.job.max_attempts;
        let retry_at =
            retry.then(|| now.saturating_add_seconds(retry_delay_seconds(lease.job.attempt)));
        match self
            .state
            .repo
            .settle_job_error(&self.background, &lease.fence, &error, retry_at, now)
            .await
        {
            Ok(true) => {}
            Ok(false) => return Outcome::LeaseLost,
            Err(error) => {
                // 写不进去：租约过期后由别的进程（或本进程）重新领取。
                tracing::warn!(job = %lease.job.id, error = %error, "写任务失败状态时数据库出错");
                return Outcome::LeaseLost;
            }
        }
        if retry {
            tracing::info!(job = %lease.job.id, class = class.name(), error = %message, "任务退回队列，稍后重试");
            return Outcome::Retrying(class);
        }
        tracing::warn!(job = %lease.job.id, class = class.name(), error = %message, "任务最终失败");
        self.after_final_failure(&lease.job, &message).await;
        Outcome::Failed(class)
    }

    /// 最终失败以后的收尾（清理第 0 步、第 1 步兜底同样的事）。
    pub(crate) async fn after_final_failure(&self, job: &Job, message: &str) {
        if job.kind == JobKind::UploadVerify {
            if let Err(error) = upload_verify::settle_after_failure(self, job, message).await {
                tracing::warn!(job = %job.id, error = ?error, "上传核对失败后收尾没做成，留给定期清理");
            }
        }
    }

    /// 这个任务所在空间的系统范围（主人必须没变）。
    pub(crate) async fn space_grant(
        &self,
        job: &Job,
        purpose: &'static str,
    ) -> Result<Grant, JobFailure> {
        self.state
            .authorizer
            .system_space(&job.space_id, &job.owner, purpose, &job.id)
            .await
            .map_err(|error| {
                if error.status == axum::http::StatusCode::NOT_FOUND {
                    JobFailure::Content("空间已经不在了，或主人已经变了".to_owned())
                } else {
                    error.into()
                }
            })
    }

    /// 测试和本机工具用：按"核对先领"的顺序一个一个领取、处理，直到没有可领的任务。
    pub async fn run_until_idle(self: &Arc<Self>) -> Vec<Outcome> {
        let mut outcomes = Vec::new();
        while outcomes.len() < 10_000 {
            let Ok(now) = crate::now() else {
                break;
            };
            let mut lease = None;
            for class in [SlotClass::Verify, SlotClass::Heavy] {
                match self.claim(class, now).await {
                    Ok(Some(found)) => {
                        lease = Some(found);
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => tracing::warn!(error = %error, "领取任务时数据库出错"),
                }
            }
            match lease {
                Some(lease) => outcomes.push(self.execute(lease).await),
                None => break,
            }
        }
        outcomes
    }

    /// 一轮领取：每一类有空名额就领，领到的任务在新的异步任务里处理，处理完释放名额、再叫醒循环。
    async fn claim_round(self: &Arc<Self>) {
        for class in [SlotClass::Verify, SlotClass::Heavy] {
            loop {
                let Ok(permit) = self.slots(class).clone().try_acquire_owned() else {
                    break;
                };
                let Ok(now) = crate::now() else {
                    return;
                };
                match self.claim(class, now).await {
                    Ok(Some(lease)) => {
                        let runner = self.clone();
                        tokio::spawn(async move {
                            runner.execute(lease).await;
                            drop(permit);
                            runner.state.job_signal.notify();
                        });
                    }
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!(error = %error, "领取任务时数据库出错");
                        break;
                    }
                }
            }
        }
    }

    async fn main_loop(self: Arc<Self>, mut shutdown: watch::Receiver<bool>) {
        let poll = Duration::from_secs(self.config.poll_seconds);
        loop {
            if *shutdown.borrow() {
                return;
            }
            self.claim_round().await;
            tokio::select! {
                () = self.state.job_signal.wait() => {}
                () = tokio::time::sleep(poll) => {}
                changed = shutdown.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    }

    /// 停止：手上的任务等最多 [`STOP_GRACE_SECONDS`] 秒，做不完的取消、按栅栏退回队列并退还
    /// 这一次的尝试次数。
    pub async fn drain(&self, grace: Duration) {
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if self.running.lock().expect("正在处理的任务表").is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let left: Vec<(String, (JobFence, AbortHandle))> = self
            .running
            .lock()
            .expect("正在处理的任务表")
            .drain()
            .collect();
        for (job_id, (fence, abort)) in left {
            abort.abort();
            match self
                .state
                .repo
                .requeue_stopped_job(&self.background, &fence)
                .await
            {
                Ok(true) => tracing::info!(job = %job_id, "停止时没做完，退回队列"),
                Ok(false) => tracing::info!(job = %job_id, "停止时租约已经不在本进程"),
                Err(error) => {
                    tracing::warn!(job = %job_id, error = %error, "停止时退回队列失败，等租约过期后重新领取")
                }
            }
        }
    }

    /// 启动常驻循环：异常退出时记错误日志、5 秒后重启；收到停止信号后不再领取，等手上的任务。
    pub fn spawn(self: Arc<Self>, shutdown: watch::Receiver<bool>) -> JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let runner = self.clone();
                let receiver = shutdown.clone();
                let joined = tokio::spawn(runner.main_loop(receiver)).await;
                match joined {
                    Ok(()) => break,
                    Err(error) => {
                        tracing::error!(error = %error, "后台执行器的循环异常退出，5 秒后重启");
                        if *shutdown.borrow() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
            self.drain(Duration::from_secs(STOP_GRACE_SECONDS)).await;
            tracing::info!("后台执行器已停止");
        })
    }
}

/// 后台的三个常驻循环。
pub struct Background {
    shutdown: Arc<watch::Sender<bool>>,
    tasks: Vec<JoinHandle<()>>,
}

/// 通知后台循环停止（可以在别的任务里调用）。
#[derive(Clone)]
pub struct StopSignal(Arc<watch::Sender<bool>>);

impl StopSignal {
    pub fn send(&self) {
        let _ = self.0.send(true);
    }
}

impl Background {
    pub fn stop_signal(&self) -> StopSignal {
        StopSignal(self.shutdown.clone())
    }

    /// 停止：通知各循环，等执行器把手上的任务做完或退回队列。
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        for task in self.tasks {
            let _ = task.await;
        }
    }
}

/// 等索引建好以后启动后台执行器、定期清理和后台迁移。
pub fn spawn_background(state: AppState, config: RunnerConfig) -> Background {
    let (shutdown, receiver) = watch::channel(false);
    let mut tasks = Vec::new();
    let ready = {
        let state = state.clone();
        async move {
            while !state.is_ready() {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    };
    let runner_receiver = receiver.clone();
    let runner_state = state.clone();
    let runner_config = config.clone();
    tasks.push(tokio::spawn(async move {
        ready.await;
        let runner = Runner::new(runner_state, runner_config);
        tracing::info!(instance = %runner.instance_id(), "后台执行器启动");
        let _ = runner.spawn(runner_receiver).await;
    }));
    tasks.push(cleanup::spawn(
        state.clone(),
        config.clone(),
        receiver.clone(),
    ));
    tasks.push(migrations::spawn(state, config, receiver));
    Background {
        shutdown: Arc::new(shutdown),
        tasks,
    }
}
