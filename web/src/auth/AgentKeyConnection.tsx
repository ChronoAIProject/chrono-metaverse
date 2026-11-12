import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  WorkerError,
  workerRequest,
  validCredentialVersion,
  type Session,
} from '../workspace/client';
import {
  browserKeyStorageKey,
  clearBrowserKey,
  readBrowserKey,
  saveBrowserKey,
  validIdentity,
  type KeyIdentity,
  type ChatProvider,
} from './browserKey';
import {
  clearEnrollment,
  readEnrollment,
  saveEnrollment,
  validEnrollment,
  type Enrollment,
  type PendingEnrollment,
} from './browserEnrollment';
import { receiveBrowserKey } from './browserDelivery';
export function AgentKeyConnection({
  session: suppliedSession,
  request,
  onChange,
  checkVersion = 0,
  ownerName,
  provider = 'cma',
}: {
  readonly session: Session;
  readonly request: typeof fetch;
  readonly onChange: (ready: boolean, version?: string) => void;
  readonly checkVersion?: number;
  readonly ownerName?: string;
  readonly provider?: ChatProvider;
}) {
  const session = useMemo(
    () => ({
      ...suppliedSession,
      cmaAuthMethod: 'agent_key' as const,
      ...(provider === 'nyxagent' ? { chatProvider: 'nyxagent' as const } : {}),
    }),
    [suppliedSession, provider],
  );
  const serviceName = provider === 'nyxagent' ? 'NyxAgent' : 'CMA';
  const owner = session.cmaOwnerId ?? session.subject!;
  const ownerLabel = owner === session.subject ? '个人空间' : (ownerName ?? '当前组织');
  const [identity, setIdentity] = useState<KeyIdentity | null>(null);
  const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const generation = useRef(0);
  const action = useRef(false);
  const lost = useCallback(() => {
    onChange(false);
    setReady(false);
  }, [onChange]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const runGeneration = ++generation.current;
    void Promise.resolve().then(async () => {
      if (!active) return;
      lost();
      setEnrollment(null);
      setError('');
      const saved = readBrowserKey(session.subject, owner, provider);
      setIdentity(saved?.identity ?? null);
      if (!saved) {
        setEnrollment(readEnrollment(session.subject!, owner, provider));
        setBusy(false);
        return;
      }
      clearEnrollment(session.subject!, owner, provider);
      setBusy(true);
      try {
        const value = await workerRequest<KeyIdentity>(
          session,
          'key/check',
          {},
          controller.signal,
          request,
        );
        if (!validIdentity(value) || !validCredentialVersion(value.credentialVersion))
          throw new Error('无法核对 Agent Key 授权状态。');
        if (!active) return;
        saveBrowserKey(session.subject!, saved.credential, value, owner, provider);
        setIdentity(value);
        setReady(true);
        onChange(true, value.credentialVersion);
      } catch (failure) {
        if (!active) return;
        if (
          failure instanceof WorkerError &&
          [
            'cma_key_required',
            'cma_key_account_mismatch',
            'cma_key_scope_required',
            'nyxagent_key_required',
            'nyxagent_key_account_mismatch',
            'nyxagent_key_scope_required',
          ].includes(failure.code)
        ) {
          clearBrowserKey(session.subject!, owner, provider);
          setIdentity(null);
        }
        setError(failure instanceof Error ? failure.message : '暂时无法核验 Agent Key。');
      } finally {
        if (active) setBusy(false);
      }
    });
    return () => {
      active = false;
      generation.current = runGeneration + 1;
      controller.abort();
    };
  }, [session, attempt, checkVersion, lost, onChange, request, owner, provider]);

  useEffect(() => {
    function changed(event: StorageEvent) {
      if (
        event.storageArea === localStorage &&
        (event.key === null || event.key === browserKeyStorageKey(session.subject!, provider))
      )
        setAttempt((value) => value + 1);
    }
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [session.subject, owner, provider]);

  useEffect(() => {
    if (!enrollment) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let interval = enrollment.interval;
    async function poll() {
      if (Date.now() >= enrollment!.expiresAt) {
        clearEnrollment(session.subject!, owner, provider);
        setEnrollment(null);
        setError('此次授权已过期，请重新发起。');
        return;
      }
      try {
        const delivery = await receiveBrowserKey(session, enrollment!, request, owner, provider);
        if (!active) return;
        setIdentity(delivery.identity);
        setEnrollment(null);
        setError('');
        // 交付已保存；服务核验失败不能导致重复审批。
        setAttempt((value) => value + 1);
      } catch (failure) {
        if (!active) return;
        if (
          failure instanceof WorkerError &&
          [
            'cma_key_pending',
            'cma_key_slow_down',
            'network',
            'cma_key_unavailable',
            'nyxagent_key_pending',
            'nyxagent_key_slow_down',
            'nyxagent_key_unavailable',
          ].includes(failure.code)
        ) {
          if (failure.code.endsWith('_key_slow_down')) interval = Math.min(60, interval + 5);
          try {
            saveEnrollment(
              session.subject!,
              owner,
              {
                ...enrollment!,
                interval,
                nextPollAt: Date.now() + interval * 1000,
              },
              provider,
            );
          } catch (storageFailure) {
            setEnrollment(null);
            setError((storageFailure as Error).message);
            return;
          }
          setError(
            failure.code === 'network' || failure.code.endsWith('_key_unavailable')
              ? '正在重新检查原授权，请稍候。'
              : '',
          );
          timer = setTimeout(() => void poll(), interval * 1000);
          return;
        }
        clearEnrollment(session.subject!, owner, provider);
        setEnrollment(null);
        setError(
          failure instanceof Error
            ? failure.message
            : '授权结果尚未确认，请先在 NyxID 核对本次登录凭据。',
        );
      }
    }
    timer = setTimeout(() => void poll(), Math.max(0, enrollment.nextPollAt - Date.now()));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enrollment, session, onChange, request, owner, provider]);

  async function run(work: () => Promise<void>) {
    if (action.current) return;
    action.current = true;
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      if (current === generation.current)
        setError(failure instanceof Error ? failure.message : 'Agent Key 操作未完成。');
    } finally {
      action.current = false;
      if (current === generation.current) setBusy(false);
    }
  }
  async function start() {
    await run(async () => {
      const current = generation.current;
      const value = await workerRequest<Enrollment>(session, 'key/request', {}, undefined, request);
      if (!validEnrollment(value)) throw new Error('无法核对授权入口，请重试。');
      if (current === generation.current) {
        const pending = {
          ...value,
          expiresAt: Date.now() + value.expires_in * 1000,
          nextPollAt: Date.now() + value.interval * 1000,
        };
        saveEnrollment(session.subject!, owner, pending, provider);
        setEnrollment(pending);
      }
    });
  }
  async function revoke() {
    await run(async () => {
      const current = generation.current;
      await workerRequest(session, 'key/revoke', {}, undefined, request);
      if (current !== generation.current) return;
      clearBrowserKey(session.subject!, owner, provider);
      setIdentity(null);
      lost();
    });
  }
  return (
    <section className="workspace__consent" aria-label={`${serviceName} 浏览器授权`}>
      <p>
        当前空间：{ownerLabel} · 使用当前账号的 {serviceName} 授权
      </p>
      {ready && identity ? (
        <>
          <p>
            已连接 {serviceName} · {identity.name}
          </p>
          <button className="workspace__secondary" disabled={busy} onClick={() => void revoke()}>
            断开此浏览器的 {serviceName} 授权
          </button>
        </>
      ) : enrollment ? (
        <>
          <h2>在 NyxID 确认 {serviceName} 授权</h2>
          <p>
            请求码和 {serviceName} 权限已填好，无需输入验证码或 Key。在 NyxID
            选择当前账号的专用授权并确认。
          </p>
          <a href={enrollment.verification_uri} target="_blank" rel="noopener noreferrer">
            打开 NyxID 授权页
          </a>
          <p>完成后本页会自动连接。不会自动重发原消息。</p>
          <button
            className="workspace__secondary"
            onClick={() => {
              clearEnrollment(session.subject!, owner, provider);
              setEnrollment(null);
            }}
          >
            取消等待
          </button>
        </>
      ) : (
        <>
          <h2>连接 {serviceName}</h2>
          <p>授权一次后，此浏览器会复用已有凭据。刷新或打开其他空间时会自动核验。</p>
          <button
            disabled={busy}
            onClick={() => (identity ? setAttempt((v) => v + 1) : void start())}
          >
            {busy
              ? '正在核验…'
              : identity
                ? `重新检查 ${serviceName} 授权`
                : `授权此浏览器调用 ${serviceName}`}
          </button>
        </>
      )}
      {provider === 'nyxagent' && !ready && (
        <p>
          请选择 proxy 权限，以及 NyxAgent（llm-nyx）、chrono-metaverse 和 Chrono LLM Public
          三个服务。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
