import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkerError, workerRequest, type Session } from '../workspace/client';
import {
  clearBrowserKey,
  readBrowserKey,
  saveBrowserKey,
  validIdentity,
  type KeyIdentity,
} from './browserKey';

type Enrollment = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};
export function AgentKeyConnection({
  session,
  request,
  onChange,
  checkVersion = 0,
}: {
  readonly session: Session;
  readonly request: typeof fetch;
  readonly onChange: (ready: boolean) => void;
  readonly checkVersion?: number;
}) {
  const [identity, setIdentity] = useState<KeyIdentity | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
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
      const saved = readBrowserKey(session.subject);
      setIdentity(saved?.identity ?? null);
      if (!saved) {
        setBusy(false);
        return;
      }
      setBusy(true);
      try {
        const value = await workerRequest<KeyIdentity>(
          session,
          'key/check',
          {},
          controller.signal,
          request,
        );
        if (!validIdentity(value)) throw new Error('无法核对 Agent Key 授权状态。');
        if (!active) return;
        saveBrowserKey(session.subject!, saved.credential, value);
        setIdentity(value);
        setReady(true);
        onChange(true);
      } catch (failure) {
        if (!active) return;
        if (
          failure instanceof WorkerError &&
          ['cma_key_required', 'cma_key_account_mismatch', 'cma_key_scope_required'].includes(
            failure.code,
          )
        ) {
          clearBrowserKey(session.subject!);
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
  }, [session, attempt, checkVersion, lost, onChange, request]);

  useEffect(() => {
    if (!enrollment) return;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + enrollment.expires_in * 1000;
    let interval = enrollment.interval;
    async function poll() {
      if (Date.now() >= expires) {
        setEnrollment(null);
        setError('此次授权已过期，请重新发起。');
        return;
      }
      try {
        const delivery = await workerRequest<{ credential: string; identity: KeyIdentity }>(
          session,
          'key/poll',
          { deviceCode: enrollment!.device_code },
          controller.signal,
          request,
        );
        if (!active) return;
        saveBrowserKey(session.subject!, delivery.credential, delivery.identity);
        setIdentity(delivery.identity);
        setEnrollment(null);
        setError('');
        setReady(true);
        onChange(true);
      } catch (failure) {
        if (!active) return;
        if (
          failure instanceof WorkerError &&
          ['cma_key_pending', 'cma_key_slow_down'].includes(failure.code)
        ) {
          if (failure.code === 'cma_key_slow_down') interval = Math.min(60, interval + 5);
          timer = setTimeout(() => void poll(), interval * 1000);
          return;
        }
        setEnrollment(null);
        setError(
          failure instanceof Error
            ? failure.message
            : '授权结果尚未确认，请先在 NyxID 核对本次登录凭据。',
        );
      }
    }
    timer = setTimeout(() => void poll(), interval * 1000);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enrollment, session, onChange, request]);

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
      const url = new URL(value.verification_uri);
      if (
        url.protocol !== 'https:' ||
        url.pathname !== '/login/agent-key' ||
        url.username ||
        url.password ||
        url.hash ||
        !/^[A-Z0-9-]{4,32}$/.test(value.user_code) ||
        typeof value.device_code !== 'string' ||
        value.device_code.length > 4096 ||
        !Number.isInteger(value.expires_in) ||
        !Number.isInteger(value.interval) ||
        !value.device_code.length ||
        value.expires_in < 1 ||
        value.expires_in > 600 ||
        value.interval < 1 ||
        value.interval > 60
      )
        throw new Error('无法核对授权入口，请重试。');
      if (current === generation.current) setEnrollment(value);
    });
  }
  async function revoke() {
    await run(async () => {
      const current = generation.current;
      await workerRequest(session, 'key/revoke', {}, undefined, request);
      if (current !== generation.current) return;
      clearBrowserKey(session.subject!);
      setIdentity(null);
      lost();
    });
  }
  return (
    <section className="workspace__consent" aria-label="CMA 浏览器授权">
      {ready && identity ? (
        <>
          <p>已连接 CMA · {identity.name}</p>
          <button className="workspace__secondary" disabled={busy} onClick={() => void revoke()}>
            断开此浏览器的 CMA 授权
          </button>
        </>
      ) : enrollment ? (
        <>
          <h2>在 NyxID 确认 CMA 授权</h2>
          <p>复制验证码，在授权页输入后，选择仅允许 CMA 的个人 Key。也可以新建一个。</p>
          <p>
            <strong>{enrollment.user_code}</strong>
          </p>
          <a href={enrollment.verification_uri} target="_blank" rel="noopener noreferrer">
            打开 NyxID 授权页
          </a>
          <p>完成后本页会自动连接。不会自动重发原消息。</p>
          <button onClick={() => setEnrollment(null)}>取消等待</button>
        </>
      ) : (
        <>
          <h2>连接 CMA</h2>
          <p>授权一次后，本标签页会复用已有凭据。Agent Key 保存在浏览器，后端只临时转发。</p>
          <button
            disabled={busy}
            onClick={() => (identity ? setAttempt((v) => v + 1) : void start())}
          >
            {busy ? '正在核验…' : identity ? '重新检查 CMA 授权' : '授权此浏览器调用 CMA'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
