import { useEffect, useState } from 'react';
import { WorkerError, workerRequest, type Session } from '../workspace/client';

export function OAuthConnection({
  session,
  request,
  onChange,
  checkVersion = 0,
  ownerName,
}: {
  readonly session: Session;
  readonly request: typeof fetch;
  readonly onChange: (ready: boolean) => void;
  readonly checkVersion?: number;
  readonly ownerName?: string;
}) {
  const owner = session.cmaOwnerId ?? session.subject!;
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [authorize, setAuthorize] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    onChange(false);
    void Promise.resolve().then(async () => {
      if (!active) return;
      setBusy(true);
      setReady(false);
      setError('');
      setAuthorize(false);
      try {
        const result = await workerRequest<{ ready: boolean; ownerId: string }>(
          session,
          'connection',
          {},
          controller.signal,
          request,
        );
        if (!result.ready || result.ownerId !== owner) throw new Error('无法核对 CMA 连接。');
        if (!active) return;
        setReady(true);
        onChange(true);
      } catch (failure) {
        if (!active) return;
        setError(failure instanceof Error ? failure.message : '暂时无法核对 CMA 连接。');
        setAuthorize(
          failure instanceof WorkerError &&
            ['cma_oauth_required', 'nyxid_reconnect_required'].includes(failure.code),
        );
      } finally {
        if (active) setBusy(false);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [session, owner, request, onChange, checkVersion, attempt]);
  return (
    <section className="workspace__consent" aria-label="CMA 授权">
      <p>
        当前空间：{owner === session.subject ? '个人空间' : (ownerName ?? '当前组织')} ·
        使用当前账号的 CMA 授权
      </p>
      {busy ? (
        <p role="status">正在核对 CMA 授权…</p>
      ) : ready ? (
        <p>已连接 CMA</p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          {authorize && (
            <>
              <p>在 NyxID 确认账号授权即可。完成后回到工作台，原消息仍可恢复。</p>
              <a href="/api/auth/nyxid/login?workspace=1">授权网页使用 CMA</a>
            </>
          )}
          <button className="workspace__secondary" onClick={() => setAttempt((v) => v + 1)}>
            重新检查 CMA 连接
          </button>
        </>
      )}
    </section>
  );
}
