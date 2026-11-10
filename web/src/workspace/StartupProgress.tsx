import { useEffect, useState } from 'react';
import { statusText, type Operation } from './client';

const phases: Record<string, string> = {
  queued: '等待分配环境',
  profiles: '准备运行配置',
  sandbox_ready: '准备沙箱',
  key_scope_ready: '配置服务权限',
  workspace_runtime: '准备工作目录',
  agent_startup: '启动 CMA',
  desktop_preparation: '准备桌面环境',
  ready: '环境已准备',
};

export function StartupProgress({
  operation,
  operationId,
  cmaUrl,
  busy,
  onRefresh,
  onResume,
  onRestart,
}: {
  readonly operation: Operation | null;
  readonly operationId: string;
  readonly cmaUrl: string;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onResume?: () => void;
  readonly onRestart?: () => void;
}) {
  const failed =
    operation && ['failed', 'cancelled', 'stopped', 'deleted', 'paused'].includes(operation.status);
  const waiting = operation?.status === 'waiting_for_connection';
  const events = [...(operation?.events ?? [])].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
  );
  const latest = events.at(-1);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (failed || waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [failed, waiting]);
  const latestAt = latest?.occurred_at ? Date.parse(latest.occurred_at) : NaN;
  const slow = !failed && !waiting && Number.isFinite(latestAt) && now - latestAt > 120_000;
  return (
    <section className="workspace__startup workspace__notice" aria-label="CMA 启动进度">
      <strong>
        {failed
          ? '在线 worker 准备未完成'
          : waiting
            ? '需要完成 CMA 服务授权'
            : '正在准备在线 worker'}
      </strong>
      <p role={failed ? 'alert' : 'status'}>
        {failed
          ? operation.error || 'CMA 已停止准备环境，请核对进度后再操作。'
          : waiting
            ? 'CMA 正在等待服务授权，完成授权后才能继续。'
            : `${phases[operation?.phase ?? 'queued'] ?? operation?.phase} · ${statusText(latest?.status ?? operation?.status ?? 'queued')}`}
      </p>
      {!failed && !waiting && latest?.message && <p>{latest.message}</p>}
      {slow && <p>此阶段已超过 2 分钟没有新进度。可刷新状态，或在 CMA 核查运行环境。</p>}
      {waiting && operation?.connection?.services.length ? (
        <p>待授权服务：{operation.connection.services.join('、')}</p>
      ) : null}
      {events.length > 0 && (
        <details>
          <summary>启动详情</summary>
          <ol>
            {events.slice(-6).map((event, i) => (
              <li key={event.sequence ?? i}>
                {phases[event.phase] ?? event.phase} · {statusText(event.status)}
                <p>{event.message}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="workspace__actions">
        <button className="workspace__secondary" disabled={busy} onClick={onRefresh}>
          刷新启动进度
        </button>
        {waiting && (
          <>
            <a href={`${cmaUrl}/auth/login`} target="_blank" rel="noopener noreferrer">
              前往 CMA 完成授权 ↗
            </a>
            {onResume && (
              <button disabled={busy} onClick={onResume}>
                已完成授权，继续原任务
              </button>
            )}
          </>
        )}
        {failed && onRestart && (
          <button disabled={busy} onClick={onRestart}>
            重新准备 worker
          </button>
        )}
      </div>
      {waiting && !onResume && <p>此任务的原始请求未保留，请先完成授权并核查 CMA 中的任务状态。</p>}
      <small>
        准备任务 <code>{operationId}</code>
      </small>
    </section>
  );
}
