import { useEffect, useRef, useState, type FormEvent } from 'react';
import './ConnectPage.css';

type Session =
  | { enabled: false; connected: false }
  | { enabled: true; connected: false }
  | { enabled: true; connected: true; subject: string; csrfToken: string };
type CheckResult = {
  subject: string;
  status: 'ready';
  organization: null | {
    id: string;
    role: 'admin' | 'member' | 'viewer' | null;
    access: 'manage' | 'read' | 'none';
  };
};
type OrganizationSummary = { id: string; name: string; role: 'admin' | 'member' | 'viewer' };
type Action = 'check' | 'organization' | 'organizations' | 'disconnect';
type Feedback = { tone: 'success' | 'error' | 'neutral'; text: string };

const CALLBACK_MESSAGES: Record<string, string> = {
  denied: '此次授权已取消，你可以重新授权。原有连接状态以下方为准。',
  expired: '授权链接已过期或不属于当前浏览器，请从本页重新授权。',
  reconnect: '未能完成账号验证，请重新授权。',
  unavailable: 'NyxID 授权暂时不可用，请稍后重新授权。',
  disabled: '此部署尚未启用 NyxID 连接，请联系管理员。',
};

function parseSession(value: unknown): Session {
  if (typeof value !== 'object' || value === null) throw new Error('session');
  const result = value as Record<string, unknown>;
  if (result.enabled === false && result.connected === false)
    return { enabled: false, connected: false };
  if (result.enabled === true && result.connected === false)
    return { enabled: true, connected: false };
  if (
    result.enabled === true &&
    result.connected === true &&
    typeof result.subject === 'string' &&
    result.subject.length > 0 &&
    typeof result.csrfToken === 'string' &&
    result.csrfToken.length > 0
  ) {
    return { enabled: true, connected: true, subject: result.subject, csrfToken: result.csrfToken };
  }
  throw new Error('session');
}

function Notice({ feedback }: { readonly feedback: Feedback }) {
  return (
    <p
      className={`connect__notice connect__notice--${feedback.tone}`}
      role={feedback.tone === 'error' ? 'alert' : 'status'}
    >
      {feedback.text}
    </p>
  );
}

export function ConnectPage({ request = fetch }: { readonly request?: typeof fetch }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [orgId, setOrgId] = useState('');
  const [organizations, setOrganizations] = useState<OrganizationSummary[] | null>(null);
  const [checked, setChecked] = useState<{ value: CheckResult; at: Date } | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const [callback] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { error: params.get('error'), connected: params.get('connected') === '1' };
  });

  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.hash,
      );
    }
    return () => {
      actionController.current?.abort();
      actionController.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let active = true;
    async function load() {
      setLoading(true);
      setLoadError(false);
      setChecked(null);
      setOrganizations(null);
      try {
        const response = await request('/api/auth/nyxid/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('session');
        const value = parseSession(await response.json());
        if (active) setSession(value);
      } catch {
        if (active) {
          setSession(null);
          setLoadError(true);
        }
      } finally {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [request, attempt]);

  function refresh() {
    setFeedback(null);
    setConfirmDisconnect(false);
    setAttempt((value) => value + 1);
  }

  async function perform(kind: Action) {
    if (!session?.connected || actionController.current || loading) return;
    const controller = new AbortController();
    actionController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    setAction(kind);
    setFeedback(null);
    setChecked(null);
    if (kind === 'organizations') setOrganizations(null);
    try {
      const response = await request(
        `/api/auth/nyxid/${kind === 'disconnect' || kind === 'organizations' ? kind : 'check'}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            'x-csrf-token': session.csrfToken,
            ...(kind === 'check' || kind === 'organization'
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          ...(kind === 'check' || kind === 'organization'
            ? { body: JSON.stringify(kind === 'organization' ? { orgId: orgId.trim() } : {}) }
            : {}),
        },
      );
      if (controller.signal.aborted) return;
      if (response.status === 401) {
        setSession({ enabled: true, connected: false });
        setConfirmDisconnect(false);
        setOrganizations(null);
        setFeedback({ tone: 'error', text: '连接已失效或浏览器会话已过期，请重新授权。' });
        return;
      }
      if (!response.ok) {
        const text =
          response.status === 403
            ? '页面状态已变化，请刷新连接状态后重试。'
            : response.status === 422
              ? '请输入有效的组织编号，不是组织名称或链接。'
              : kind === 'disconnect'
                ? '断开失败，连接状态尚未确认，请刷新状态或重试。'
                : '暂时无法完成检查，请稍后重试。检查失败不代表没有组织权限。';
        setFeedback({ tone: 'error', text });
        return;
      }
      if (kind === 'disconnect') {
        setSession({ enabled: true, connected: false });
        setConfirmDisconnect(false);
        setOrganizations(null);
        setFeedback({
          tone: 'success',
          text: '已断开。本部署已删除保存的授权凭据，Agent 无法再使用这份授权查询组织权限。',
        });
      } else if (kind === 'organizations') {
        const value = (await response.json()) as {
          subject: string;
          organizations: OrganizationSummary[];
        };
        if (
          value.subject !== session.subject ||
          !Array.isArray(value.organizations) ||
          value.organizations.some(
            (org) =>
              typeof org.id !== 'string' ||
              typeof org.name !== 'string' ||
              !['admin', 'member', 'viewer'].includes(org.role),
          )
        )
          throw new Error('organizations');
        if (!controller.signal.aborted) setOrganizations(value.organizations);
      } else {
        const value = (await response.json()) as CheckResult;
        if (
          value.subject !== session.subject ||
          value.status !== 'ready' ||
          (kind === 'organization' && value.organization?.id !== orgId.trim())
        )
          throw new Error('check');
        if (!controller.signal.aborted) setChecked({ value, at: new Date() });
      }
    } catch {
      if (actionController.current === controller)
        setFeedback({ tone: 'error', text: '请求未完成，请检查网络后刷新连接状态。' });
    } finally {
      window.clearTimeout(timeout);
      if (actionController.current === controller) {
        actionController.current = null;
        setAction(null);
      }
    }
  }

  function checkOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform('organization');
  }

  const busy = loading || action !== null;
  const organization = checked?.value.organization;
  const callbackError =
    callback.error && Object.hasOwn(CALLBACK_MESSAGES, callback.error)
      ? CALLBACK_MESSAGES[callback.error]
      : undefined;

  return (
    <main className="connect">
      <div className="connect__shell">
        <header className="connect__header">
          <a className="connect__brand" href="/">
            chrono-metaverse
          </a>
          <a className="connect__text-link" href="/">
            回到首页 <span aria-hidden="true">↗</span>
          </a>
        </header>
        <div className="connect__intro">
          <p className="connect__eyebrow">账号与授权</p>
          <h1>连接 NyxID</h1>
          <p>让使用同一 NyxID 账号的 Agent，按你在组织中的实际角色访问空间。</p>
        </div>
        {callbackError && (
          <Notice
            feedback={{
              tone: callback.error === 'denied' ? 'neutral' : 'error',
              text: callbackError,
            }}
          />
        )}
        {callback.connected && session?.connected && !feedback && (
          <Notice
            feedback={{
              tone: 'success',
              text: '授权成功，连接已保存。现在可以检查连接和组织权限。',
            }}
          />
        )}
        {feedback && <Notice feedback={feedback} />}
        <div className="connect__columns">
          <div className="connect__primary">
            <section className="connect__panel" aria-labelledby="connection-title" aria-busy={busy}>
              <div className="connect__panel-heading">
                <h2 id="connection-title">当前连接</h2>
                <button
                  className="connect__button connect__button--quiet"
                  disabled={busy}
                  onClick={refresh}
                >
                  刷新状态
                </button>
              </div>
              {loading && (
                <p role="status" className="connect__muted">
                  正在读取连接状态…
                </p>
              )}
              {!loading && loadError && (
                <>
                  <Notice feedback={{ tone: 'error', text: '无法读取连接状态，请重试。' }} />
                  <button className="connect__button" onClick={refresh}>
                    重试
                  </button>
                </>
              )}
              {!loading && session && !session.enabled && (
                <p className="connect__muted">此部署尚未启用 NyxID 连接，请联系管理员。</p>
              )}
              {!loading && session?.enabled && !session.connected && (
                <>
                  <span className="connect__badge">当前浏览器未连接</span>
                  <p className="connect__muted">使用与你的 Agent Key 相同的 NyxID 账号完成授权。</p>
                  <a className="connect__button" href="/api/auth/nyxid/login">
                    前往 NyxID 授权 <span aria-hidden="true">↗</span>
                  </a>
                  <p className="connect__fine">授权在 NyxID 页面完成，返回后会自动保存连接。</p>
                </>
              )}
              {!loading && session?.connected && (
                <>
                  <span className="connect__badge connect__badge--success">授权已保存</span>
                  <dl className="connect__account">
                    <dt>NyxID 账号编号</dt>
                    <dd>
                      <code>{session.subject}</code>
                    </dd>
                  </dl>
                  <p className="connect__fine">
                    请核对这是 Agent Key 所属的账号。保存状态不代表已完成实时有效性检查。
                  </p>
                  <div className="connect__actions">
                    <button
                      className="connect__button"
                      disabled={busy}
                      onClick={() => void perform('check')}
                    >
                      {action === 'check' ? '正在检查…' : '检查连接'}
                    </button>
                    {!busy && (
                      <a
                        className="connect__button connect__button--quiet"
                        href="/api/auth/nyxid/login"
                      >
                        重新授权
                      </a>
                    )}
                    <button
                      className="connect__button connect__button--danger"
                      disabled={busy || confirmDisconnect}
                      onClick={() => setConfirmDisconnect(true)}
                    >
                      断开连接
                    </button>
                  </div>
                  {confirmDisconnect && (
                    <div
                      className="connect__confirmation"
                      role="group"
                      aria-labelledby="disconnect-title"
                    >
                      <h3 id="disconnect-title">断开此部署的连接？</h3>
                      <p>
                        将删除本部署保存的授权凭据，并使相关连接会话失效。依赖这份授权的 Agent
                        组织访问会停止；需要时可以重新授权。
                      </p>
                      <p>此操作不会退出 NyxID，也不会撤销其他应用的授权。</p>
                      <div className="connect__actions">
                        <button
                          className="connect__button connect__button--danger"
                          disabled={busy}
                          onClick={() => void perform('disconnect')}
                        >
                          {action === 'disconnect' ? '正在断开…' : '确认断开'}
                        </button>
                        <button
                          className="connect__button connect__button--quiet"
                          disabled={busy}
                          onClick={() => setConfirmDisconnect(false)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {checked && (
                <div className="connect__result" role="status">
                  <strong>连接有效</strong>
                  <p>
                    NyxID 已实时核验当前账号。检查于{' '}
                    <time dateTime={checked.at.toISOString()}>
                      {checked.at.toLocaleTimeString('zh-CN')}
                    </time>
                    。
                  </p>
                </div>
              )}
            </section>
            <section className="connect__panel" aria-labelledby="organization-title">
              <h2 id="organization-title">检查组织访问权限</h2>
              <p className="connect__muted">
                选择你的组织，或输入空间所属组织的编号，查询当前连接账号的角色。
              </p>
              <button
                className="connect__button connect__button--quiet"
                disabled={!session?.connected || busy}
                onClick={() => void perform('organizations')}
              >
                {action === 'organizations'
                  ? '正在读取组织…'
                  : organizations
                    ? '刷新我的组织'
                    : '选择我的组织'}
              </button>
              {organizations && organizations.length === 0 && (
                <p role="status" className="connect__fine">
                  NyxID 没有返回此账号所属的组织。你仍可输入编号检查。
                </p>
              )}
              {organizations && organizations.length > 0 && (
                <div className="connect__form">
                  <label htmlFor="my-org">我的组织</label>
                  <select
                    id="my-org"
                    value={organizations.some((org) => org.id === orgId) ? orgId : ''}
                    disabled={busy}
                    onChange={(event) => {
                      setOrgId(event.target.value);
                      setChecked(null);
                    }}
                  >
                    <option value="">选择一个组织</option>
                    {organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name} ·{' '}
                        {org.role === 'admin'
                          ? '管理员'
                          : org.role === 'member'
                            ? '成员'
                            : '查看者'}
                      </option>
                    ))}
                  </select>
                  <p className="connect__fine">列表供选择使用，当前权限以下方实时检查结果为准。</p>
                </div>
              )}
              <form onSubmit={checkOrganization} className="connect__form">
                <label htmlFor="org-id">组织编号</label>
                <div className="connect__input-row">
                  <input
                    id="org-id"
                    type="text"
                    value={orgId}
                    maxLength={256}
                    required
                    pattern="[A-Za-z0-9_\-]+"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="组织 ID"
                    aria-describedby="org-hint"
                    disabled={!session?.connected || busy}
                    onChange={(event) => {
                      setOrgId(event.target.value);
                      setChecked(null);
                    }}
                  />
                  <button
                    className="connect__button connect__button--quiet"
                    type="submit"
                    disabled={!session?.connected || busy || !orgId.trim()}
                  >
                    {action === 'organization' ? '正在查询…' : '查询权限'}
                  </button>
                </div>
                <p id="org-hint" className="connect__fine">
                  {session?.connected
                    ? '使用组织编号，不是名称或网页链接。每次查询都会重新核验。'
                    : '连接 NyxID 后即可查询。'}
                </p>
              </form>
              {organization && (
                <div
                  className={`connect__result${organization.access === 'none' ? ' connect__result--neutral' : ''}`}
                  role="status"
                >
                  <strong>
                    {organization.access === 'manage'
                      ? '管理员 · 可管理组织资源'
                      : organization.access === 'read'
                        ? `${organization.role === 'member' ? '成员' : '查看者'} · 可读取组织资源`
                        : '未确认组织成员身份'}
                  </strong>
                  <p>
                    <code>{organization.id}</code>
                  </p>
                  <p>
                    {organization.access === 'none'
                      ? '组织不存在，或当前账号没有成员访问权限。请核对编号及组织成员关系。'
                      : '这是当前账号的组织资源权限。Agent 实际调用仍受服务访问、操作范围及具体资源规则限制。'}
                  </p>
                </div>
              )}
            </section>
          </div>
          <aside className="connect__secondary">
            <section className="connect__panel" aria-labelledby="flow-title">
              <h2 id="flow-title">连接后如何使用</h2>
              <ol className="connect__steps">
                <li>
                  <strong>你在 NyxID 授权</strong>
                  <p>使用与 Agent Key 相同的账号，确认授权后返回这里。</p>
                </li>
                <li>
                  <strong>Agent 继续使用原有 Key</strong>
                  <p>NyxID 检查 Key 的服务和操作权限，无需配置另一把组织 Key。</p>
                </li>
                <li>
                  <strong>按组织角色访问空间</strong>
                  <p>metaverse 实时查询你的组织角色：管理员可管理，成员和查看者只读。</p>
                </li>
              </ol>
            </section>
            <section className="connect__panel" aria-labelledby="permissions-title">
              <h2 id="permissions-title">授权用途与范围</h2>
              <p className="connect__muted">
                metaverse 保存这份授权，用于核验账号、刷新连接、读取组织列表和查询组织角色。
              </p>
              <dl className="connect__scopes">
                <div>
                  <dt>
                    <code>openid</code>
                  </dt>
                  <dd>核验 NyxID 账号身份</dd>
                </div>
                <div>
                  <dt>
                    <code>offline_access</code>
                  </dt>
                  <dd>你离开网页后，仍可刷新授权以查询组织权限</dd>
                </div>
              </dl>
              <p className="connect__fine">此客户端未申请业务服务代理权限。</p>
              <details className="connect__details">
                <summary>这份授权是否只能查询组织角色？</summary>
                <p>
                  目前不能这样保证。NyxID 尚未提供仅查询组织角色的专用权限范围；metaverse
                  在代码中限制授权的用途，但这不是 NyxID 对令牌的接口级限制。
                </p>
                <p>其他 NyxID 接口是否接受该令牌，取决于各接口自己的权限检查。</p>
              </details>
              <details className="connect__details">
                <summary>凭据保存在哪里，如何撤销？</summary>
                <p>
                  访问和刷新令牌加密保存在 metaverse 服务端，不提供给网页或 Agent。Agent
                  继续保管自己的 Key。
                </p>
                <p>
                  “断开连接”删除本部署保存的凭据。若要撤销 NyxID 侧的应用授权，请到 NyxID 管理。
                </p>
                <p>
                  关闭网页或浏览器会话过期不会自动断开已有授权。可重新授权后在这里断开，或直接在
                  NyxID 撤销。
                </p>
                <a
                  className="connect__text-link"
                  href="https://nyxid.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开 NyxID <span aria-hidden="true">↗</span>
                </a>
              </details>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
