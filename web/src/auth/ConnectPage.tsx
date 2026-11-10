import { useEffect, useState } from 'react';

type Session =
  | { enabled: false; connected: false }
  | { enabled: true; connected: false }
  | { enabled: true; connected: true; subject: string; csrfToken: string };

export function ConnectPage({ request = fetch }: { readonly request?: typeof fetch }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await request('/api/auth/nyxid/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('session');
        const value: Session = await response.json();
        if (!controller.signal.aborted) setSession(value);
      } catch {
        if (!controller.signal.aborted) setError('无法读取连接状态，请重试。');
      }
    }
    void load();
    return () => controller.abort();
  }, [request, attempt]);

  async function disconnect() {
    if (!session?.connected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await request('/api/auth/nyxid/disconnect', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': session.csrfToken },
      });
      if (!response.ok) throw new Error('disconnect');
      setSession({ enabled: true, connected: false });
    } catch {
      setError('断开失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <div className="home__card">
        <h1>连接 NyxID</h1>
        <p>连接后，使用同一 NyxID 账号的 Agent 可以按你的组织权限访问空间。</p>
        {new URLSearchParams(window.location.search).get('error') === 'denied' && (
          <p role="status">授权已取消，可以重新连接。</p>
        )}
        {error && <p role="alert">{error}</p>}
        {!session && !error && <p role="status">正在读取连接状态…</p>}
        {!session && error && (
          <button
            className="home__link"
            onClick={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            重试
          </button>
        )}
        {session && !session.enabled && <p>此部署尚未启用 NyxID 连接，请联系管理员。</p>}
        {session?.enabled && !session.connected && (
          <a className="home__link" href="/api/auth/nyxid/login">
            前往 NyxID 授权
          </a>
        )}
        {session?.connected && (
          <>
            <p role="status">已连接 NyxID。你可以随时断开此连接。</p>
            <button
              className="home__link home__link--quiet"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {busy ? '正在断开…' : '断开连接'}
            </button>
          </>
        )}
        <a href="/">回到首页</a>
      </div>
    </main>
  );
}
