import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  emptyNotebook,
  readNotebook,
  resultLinks,
  saveNotebook,
  statusText,
  viewerLink,
  WorkerError,
  workerRequest,
  type Agent,
  type Controls,
  type Intent,
  type Notebook,
  type Operation,
  type Session,
  type Transcript,
} from './client';
import './WorkspacePage.css';

type PreviewIdentity = {
  spaceId: string;
  preview: { draftId: string; rev: number; baseSeq: number; scope: string };
};
const CMA = 'https://cma.nyxid.ai';
const terminal = (status: string) =>
  ['succeeded', 'completed', 'failed', 'cancelled', 'stopped', 'deleted', 'paused'].includes(
    status,
  );
export function WorkspacePage({ request = fetch }: { readonly request?: typeof fetch }) {
  const [session, setSession] = useState<Session | null>(null);
  const [note, setNote] = useState<Notebook>(emptyNotebook);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [poll, setPoll] = useState(0);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [responseStatus, setResponseStatus] = useState('');
  const [controls, setControls] = useState<Controls | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [preview, setPreview] = useState('');
  const [viewerInput, setViewerInput] = useState('');
  const [previewIdentity, setPreviewIdentity] = useState<{
    url: string;
    value: PreviewIdentity;
  } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const activeAction = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const version = useRef(0);
  const noteRef = useRef(note);
  const { agentId, operationId, responseId } = note;

  useEffect(() => {
    const c = new AbortController();
    const timeout = setTimeout(() => c.abort(), 15_000);
    let active = true;
    void request('/api/auth/nyxid/session', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: c.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return (await r.json()) as Session;
      })
      .then((s) => {
        if (!active) return;
        if (
          typeof s.enabled !== 'boolean' ||
          typeof s.connected !== 'boolean' ||
          (s.connected && (!s.subject || !s.csrfToken))
        )
          throw new Error();
        version.current++;
        setSession(s);
        const recovered = s.connected ? readNotebook(s.subject!) : emptyNotebook();
        const selectedSpace = new URLSearchParams(window.location.search).get('space');
        if (
          !recovered.agentId &&
          !recovered.operationId &&
          !recovered.pending &&
          !recovered.instruction &&
          selectedSpace &&
          /^[a-z0-9][a-z0-9-]{0,79}$/.test(selectedSpace)
        )
          recovered.spaceId = selectedSpace;
        noteRef.current = recovered;
        setNote(recovered);
        setError('');
        setAgents(null);
        setTranscript(null);
        setAgent(null);
        setOperation(null);
        setControls(null);
      })
      .catch(() => {
        if (active) setError('无法读取连接状态，请重试。');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      c.abort();
      clearTimeout(timeout);
      activeAction.current?.abort();
    };
  }, [request, reload]);

  useEffect(() => {
    if (!preview.startsWith('/preview')) return;
    const c = new AbortController();
    const timeout = setTimeout(() => c.abort(), 15_000);
    let active = true;
    const token = new URL(preview, window.location.origin).hash.slice(3);
    void request('/api/public/previews', {
      cache: 'no-store',
      credentials: 'omit',
      signal: c.signal,
      headers: { Authorization: `Preview ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return (await r.json()) as PreviewIdentity;
      })
      .then((v) => {
        if (!active) return;
        if (
          !/^[a-z0-9][a-z0-9-]{0,79}$/.test(v.spaceId) ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(v.preview.draftId) ||
          !Number.isSafeInteger(v.preview.rev) ||
          v.preview.rev < 0 ||
          !Number.isSafeInteger(v.preview.baseSeq) ||
          v.preview.baseSeq < 0 ||
          !/^(physical|rebuild|plot:[a-z0-9-]+)$/.test(v.preview.scope)
        )
          throw new Error();
        setPreviewIdentity({ url: preview, value: v });
        setPreviewError('');
      })
      .catch(() => {
        if (active) {
          setPreviewIdentity(null);
          setPreviewError('预览已过期、草稿发生变化，或暂时无法核验。请让 worker 生成新的预览。');
        }
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      c.abort();
      clearTimeout(timeout);
    };
  }, [preview, request]);

  const report = useCallback((e: unknown) => {
    if (e instanceof WorkerError && e.code === 'cma_consent_required')
      setSession((s) => (s ? { ...s, workerEnabled: false } : s));
    if (e instanceof WorkerError && e.code === 'nyxid_reconnect_required') {
      setSession({ enabled: true, connected: false });
      setTranscript(null);
      setAgent(null);
      setOperation(null);
      setPreview('');
    }
    setError(e instanceof Error ? e.message : '操作未完成。');
  }, []);

  const commit = useCallback(
    (next: Notebook) => {
      if (!session?.subject) return;
      saveNotebook(session.subject, next);
      noteRef.current = next;
      setNote(next);
    },
    [session],
  );

  // Bounded, non-overlapping observation. No write is retried by polling.
  useEffect(() => {
    if (!session?.workerEnabled || busy || (!agentId && !operationId)) return;
    const c = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    async function observe() {
      try {
        if (operationId) {
          const v = await workerRequest<{ operation: Operation }>(
            session!,
            'observe',
            { operationId: operationId },
            c.signal,
            request,
          );
          if (!active) return;
          setOperation(v.operation);
          if (v.operation.agent_id) {
            commit({
              ...noteRef.current,
              agentId: v.operation.agent_id,
              ...(terminal(v.operation.status) ? { operationId: undefined } : {}),
            });
            if (terminal(v.operation.status)) return;
          }
          if (terminal(v.operation.status)) return;
        } else if (agentId) {
          const v = await workerRequest<{ agent: Agent; transcript: Transcript }>(
            session!,
            'observe',
            { agentId: agentId },
            c.signal,
            request,
          );
          if (!active) return;
          setAgent(v.agent);
          setTranscript(v.transcript);
          if (responseId) {
            const r = await workerRequest<{ response: { status: string }; controls: Controls }>(
              session!,
              'response',
              { agentId: agentId, responseId: responseId },
              c.signal,
              request,
            );
            if (!active) return;
            setResponseStatus(r.response.status);
            setControls(r.controls);
            if (terminal(r.response.status)) return;
          } else if (
            ['failed', 'stopped', 'paused', 'deleted'].includes(v.agent.status) ||
            (v.agent.status === 'ready' &&
              v.transcript.turns.some((t) => t.messages.some((m) => m.role === 'assistant')))
          )
            return;
        }
        reads++;
        if (reads < 120 && active) timer = setTimeout(() => void observe(), 5000);
        else if (active) setNotice('自动刷新已暂停。任务仍在 CMA 运行，可点击刷新继续查看。');
      } catch (e) {
        if (active) report(e);
      }
    }
    void observe();
    return () => {
      active = false;
      c.abort();
      clearTimeout(timer);
    };
  }, [session, agentId, operationId, responseId, busy, request, poll, commit, report]);

  async function action(run: (signal: AbortSignal) => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const c = new AbortController();
    activeAction.current = c;
    const generation = version.current;
    try {
      await run(c.signal);
    } catch (e) {
      if (!c.signal.aborted && version.current === generation) report(e);
    } finally {
      if (version.current === generation) {
        setBusy(false);
        setPoll((v) => v + 1);
      }
      locked.current = false;
      activeAction.current = null;
    }
  }
  async function enable(enabled: boolean) {
    await action(async (signal) => {
      await workerRequest(session!, 'consent', { enabled }, signal, request);
      setSession({ ...session!, workerEnabled: enabled });
      setNotice(
        enabled
          ? '已启用。填写需求后即可开始。'
          : '已关闭网页 CMA 调用。已受理的任务仍在 CMA 中运行。',
      );
    });
  }
  async function runIntent(intent: Intent, base = note) {
    await action(async (signal) => {
      const pending = intent.setupRequired
        ? {
            ...intent,
            body: { ...intent.body, idempotencyKey: crypto.randomUUID() },
            setupRequired: false,
          }
        : intent;
      commit({ ...base, pending });
      try {
        const value = await workerRequest<{ id?: string; responseId?: string; commandId?: string }>(
          session!,
          pending.action,
          pending.body,
          signal,
          request,
        );
        if (signal.aborted) return;
        if (pending.action === 'create') {
          if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id))
            throw new Error('创建结果缺少任务编号，请重试原请求恢复。');
          commit({
            ...base,
            pending: undefined,
            operationId: value.id,
            instruction: '',
            agentId: undefined,
            responseId: undefined,
          });
          setOperation(null);
          setAgent(null);
          setTranscript(null);
        } else if (pending.action === 'message') {
          if (!value.responseId) throw new Error('结果缺少响应编号，请重试原请求恢复。');
          commit({ ...base, pending: undefined, responseId: value.responseId, instruction: '' });
          setResponseStatus('queued');
          setControls(null);
          setConfirmPublish(false);
        } else {
          commit({ ...base, pending: undefined });
        }
        setNotice(
          pending.action === 'cancel'
            ? '停止请求已受理，等待 CMA 确认实际状态。'
            : '请求已受理，正在跟进进度。',
        );
      } catch (e) {
        if (e instanceof WorkerError && e.code === 'cma_setup_required')
          commit({ ...base, pending: { ...pending, setupRequired: true } });
        throw e;
      }
    });
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (note.pending || !note.spaceId.trim() || !note.instruction.trim()) return;
    void runIntent({
      action: note.agentId ? 'message' : 'create',
      body: {
        context: { spaceId: note.spaceId.trim(), ...(note.orgId ? { orgId: note.orgId } : {}) },
        instruction: note.instruction,
        idempotencyKey: crypto.randomUUID(),
        ...(note.agentId ? { agentId: note.agentId } : {}),
      },
    });
  }
  async function list(cursor?: string) {
    await action(async (signal) => {
      const v = await workerRequest<{ items: Agent[]; next?: string | null }>(
        session!,
        'agents',
        cursor ? { cursor } : {},
        signal,
        request,
      );
      setAgents((old) => (cursor ? [...(old ?? []), ...v.items] : v.items));
      setNextCursor(v.next ?? null);
    });
  }
  function selectAgent(id: string) {
    if (note.pending || busy) return;
    commit({ ...note, agentId: id, operationId: undefined, responseId: undefined });
    setAgent(null);
    setTranscript(null);
    setOperation(null);
    setControls(null);
    setResponseStatus('');
    setPreview('');
  }
  function change(field: 'spaceId' | 'orgId' | 'instruction', value: string) {
    try {
      commit({ ...note, [field]: value });
    } catch {
      setError('无法保存此标签页的恢复记录，请检查浏览器存储设置。');
    }
  }
  const links = resultLinks(transcript);
  const cmaBase = session?.workerUrl ?? CMA;
  const cmaLink = note.agentId ? `${cmaBase}/agents/${encodeURIComponent(note.agentId)}` : cmaBase;
  const checkedPreview = previewIdentity?.url === preview ? previewIdentity.value : null;
  const ready = session?.connected && session.workerEnabled;
  const disabled = busy || Boolean(note.pending);
  return (
    <main className="workspace">
      <header className="workspace__header">
        <a href="/" className="workspace__brand">
          chrono-metaverse
        </a>
        <nav>
          <a href="/connect">账号与组织</a>
          <a href={cmaLink} target="_blank" rel="noopener noreferrer">
            在 CMA 中打开 ↗
          </a>
        </nav>
      </header>
      <div className="workspace__intro">
        <span>ONLINE WORKSPACE</span>
        <h1>说出想法，让 worker 来建造</h1>
        <p>描述空间的变化，跟进在线 CMA worker，在三维预览中验收结果。</p>
      </div>
      {error && (
        <p className="workspace__notice workspace__notice--error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="workspace__notice" role="status">
          {notice}
        </p>
      )}
      {!session && (
        <section className="workspace__panel">
          <p>正在读取连接状态…</p>
          {error && <button onClick={() => setReload((v) => v + 1)}>重新读取</button>}
        </section>
      )}
      {session && !session.connected && (
        <section className="workspace__panel">
          <h2>先连接你的 NyxID 账号</h2>
          <p>worker 使用你的服务授权操作空间。</p>
          <a className="workspace__button" href="/connect">
            连接 NyxID
          </a>
        </section>
      )}
      {session?.connected && !session.workerAvailable && (
        <section className="workspace__panel">
          <h2>在线 worker 尚未启用</h2>
          <p>此部署尚未配置 CMA 服务，请联系部署管理员。</p>
        </section>
      )}
      {session?.connected && session.workerAvailable && !session.workerEnabled && (
        <section className="workspace__panel workspace__consent">
          <h2>启用在线 CMA worker</h2>
          <p>
            当前账号 <code>{session.subject}</code>
          </p>
          <label>
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
            />
            允许此浏览器通过 CMA 查看、创建和使用此账号有权限的 Agent，并发送我填写的任务。
          </label>
          <p>新 worker 申请 metaverse 和 CMA 必需的模型、技能服务。已有 worker 保留自己的权限。</p>
          <button disabled={!consentChecked || busy} onClick={() => void enable(true)}>
            同意并启用
          </button>
        </section>
      )}
      {ready && (
        <div className="workspace__grid">
          <div className="workspace__work">
            <section className="workspace__panel">
              <div className="workspace__heading">
                <h2>任务与 worker</h2>
                <span className="workspace__badge">
                  {statusText(operation?.status ?? agent?.status ?? 'ready')}
                </span>
              </div>
              <form onSubmit={submit} className="workspace__form">
                <div className="workspace__fields">
                  <label>
                    目标空间编号
                    <input
                      required
                      maxLength={80}
                      pattern="[a-z0-9][a-z0-9-]*"
                      value={note.spaceId}
                      onChange={(e) => change('spaceId', e.target.value)}
                      disabled={disabled}
                      placeholder="例如 chronoai-lobby"
                    />
                  </label>
                  <label>
                    新建空间归属
                    <select
                      value={note.orgId ? 'org' : 'person'}
                      disabled={disabled}
                      onChange={(e) =>
                        change('orgId', e.target.value === 'org' ? '填写组织编号' : '')
                      }
                    >
                      <option value="person">我的个人空间</option>
                      <option value="org">组织空间</option>
                    </select>
                  </label>
                </div>
                {note.orgId && (
                  <label>
                    NyxID 组织编号
                    <input
                      required
                      value={note.orgId}
                      maxLength={256}
                      disabled={disabled}
                      onChange={(e) => change('orgId', e.target.value)}
                    />
                  </label>
                )}
                <label>
                  你想让空间发生什么变化
                  <textarea
                    required
                    rows={5}
                    maxLength={16000}
                    value={note.instruction}
                    disabled={disabled}
                    onChange={(e) => change('instruction', e.target.value)}
                    placeholder="例如：在入口加一个欢迎区，保留现有场景，先给我预览。"
                  />
                </label>
                <div className="workspace__actions">
                  <button
                    type="submit"
                    disabled={
                      disabled ||
                      Boolean(note.operationId) ||
                      !note.spaceId.trim() ||
                      !note.instruction.trim()
                    }
                  >
                    {note.agentId ? '发送给当前 worker' : '创建 worker 并开始'}
                  </button>
                  <button
                    type="button"
                    className="workspace__secondary"
                    disabled={busy}
                    onClick={() => {
                      setError('');
                      setPoll((v) => v + 1);
                    }}
                  >
                    刷新进度
                  </button>
                </div>
              </form>
              <p className="workspace__fine">
                任务在云端执行，关闭页面不会停止。此标签页保留需求和恢复编号。首次使用可能需要先在
                CMA 完成授权。
              </p>
              {note.agentId && (
                <p className="workspace__identifier">
                  worker <code>{note.agentId}</code>
                </p>
              )}
              {note.operationId && (
                <p className="workspace__identifier">
                  准备任务 <code>{note.operationId}</code>
                  {operation && <span> · {statusText(operation.phase)}</span>}
                </p>
              )}
              {operation?.error && <p role="alert">环境准备未完成：{operation.error}</p>}
              {note.responseId && (
                <p className="workspace__identifier">
                  响应 <code>{note.responseId}</code> · {statusText(responseStatus || 'pending')}
                </p>
              )}
              {controls?.target_active && controls.target && !note.pending && (
                <button
                  disabled={busy}
                  className="workspace__secondary"
                  onClick={() =>
                    void runIntent({
                      action: 'cancel',
                      body: {
                        agentId: note.agentId,
                        responseId: note.responseId,
                        turnSequence: controls.target!.turn_sequence,
                        agentRevision: controls.agent_revision,
                        idempotencyKey: crypto.randomUUID(),
                      },
                    })
                  }
                >
                  请求停止当前响应
                </button>
              )}
            </section>
            {note.pending && (
              <section className="workspace__panel workspace__recovery">
                <h2>保留了一次待确认请求</h2>
                <p>
                  {note.pending.setupRequired
                    ? 'CMA 需要可续期的运行环境授权。请用相同账号登录 CMA，完成后回到这里重新提交。'
                    : '上次请求的结果尚未确认。恢复时会发送相同内容和相同请求编号。'}
                </p>
                <code>{note.pending.body.idempotencyKey}</code>
                <div className="workspace__actions">
                  {note.pending.setupRequired && (
                    <a href={`${cmaBase}/auth/login`} target="_blank" rel="noopener noreferrer">
                      登录 CMA ↗
                    </a>
                  )}
                  <button disabled={busy} onClick={() => void runIntent(note.pending!)}>
                    {note.pending.setupRequired ? '已完成授权，重新提交' : '重试原请求'}
                  </button>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmForget}
                    onChange={(e) => setConfirmForget(e.target.checked)}
                  />
                  我已在 CMA 核对结果，可以清除此恢复记录
                </label>
                <button
                  disabled={busy || !confirmForget}
                  className="workspace__secondary"
                  onClick={() => {
                    commit({ ...note, pending: undefined });
                    setConfirmForget(false);
                  }}
                >
                  清除恢复记录
                </button>
              </section>
            )}
            <section className="workspace__panel">
              <div className="workspace__heading">
                <h2>工作记录</h2>
                <a href={cmaLink} target="_blank" rel="noopener noreferrer">
                  完整进度与审批 ↗
                </a>
              </div>
              {!transcript?.turns.length && (
                <p className="workspace__muted">
                  worker 的回复会显示在这里。准备完成不代表需求已经完成。
                </p>
              )}
              <div className="workspace__conversation">
                {transcript?.turns.slice(-30).map((t) => (
                  <div key={t.turn_sequence}>
                    {t.messages.map((m) => (
                      <article
                        key={m.sequence}
                        className={`workspace__message workspace__message--${m.role}`}
                      >
                        <strong>{m.role === 'assistant' ? 'CMA worker' : '你的需求'}</strong>
                        <p>{m.content}</p>
                      </article>
                    ))}
                  </div>
                ))}
              </div>
            </section>
            <details className="workspace__panel">
              <summary>继续已有 worker 或开启新任务</summary>
              <p>已有 worker 的授权范围由 CMA 管理。选择不会修改其权限。</p>
              <button disabled={disabled} onClick={() => void list()}>
                读取我的 CMA workers
              </button>
              {agents && (
                <ul className="workspace__agents">
                  {agents.map((a) => (
                    <li key={a.id}>
                      <button
                        className="workspace__secondary"
                        disabled={disabled}
                        onClick={() => selectAgent(a.id)}
                      >
                        {a.owner_title ?? a.title ?? a.id}
                        <span>{statusText(a.status)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {nextCursor && (
                <button disabled={disabled} onClick={() => void list(nextCursor)}>
                  加载更多
                </button>
              )}
              <button
                className="workspace__secondary"
                disabled={disabled}
                onClick={() => {
                  commit({
                    ...note,
                    agentId: undefined,
                    operationId: undefined,
                    responseId: undefined,
                  });
                  setAgent(null);
                  setTranscript(null);
                  setOperation(null);
                  setControls(null);
                  setResponseStatus('');
                  setPreview('');
                }}
              >
                使用新 worker 开始下一项任务
              </button>
            </details>
            <details className="workspace__panel">
              <summary>网页授权</summary>
              <p>
                关闭后此浏览器不能再调用 CMA，已受理任务继续运行。需要停止时请先处理对应响应，或到
                CMA 操作。
              </p>
              <button
                className="workspace__secondary"
                disabled={busy}
                onClick={() => void enable(false)}
              >
                关闭网页 CMA 调用
              </button>
            </details>
          </div>
          <aside className="workspace__preview">
            <section className="workspace__panel">
              <div className="workspace__heading">
                <h2>空间与结果预览</h2>
                {preview && (
                  <a href={preview} target="_blank" rel="noopener noreferrer">
                    全屏打开 ↗
                  </a>
                )}
              </div>
              <p className="workspace__muted">
                worker 返回预览后，选择结果即可查看。尚未公开的空间需要分享链接。
              </p>
              {links.length > 0 && (
                <div className="workspace__results">
                  {links.map((url, i) => (
                    <button
                      key={url}
                      className={preview === url ? '' : 'workspace__secondary'}
                      onClick={() => {
                        setConfirmPublish(false);
                        setPreviewIdentity(null);
                        setPreview(url);
                      }}
                    >
                      {url.startsWith('/preview') ? `草稿预览 ${i + 1}` : url.split('#')[0]}
                    </button>
                  ))}
                </div>
              )}
              <form
                className="workspace__viewer-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const url = viewerLink(viewerInput);
                  if (url) {
                    setConfirmPublish(false);
                    setPreviewIdentity(null);
                    setPreview(url);
                    setError('');
                  } else setError('请输入本站的空间、组合或草稿预览链接。');
                }}
              >
                <label>
                  打开已有查看链接
                  <input
                    value={viewerInput}
                    onChange={(e) => setViewerInput(e.target.value)}
                    placeholder="/s/空间编号#share=…"
                  />
                </label>
                <button className="workspace__secondary">打开</button>
              </form>
            </section>
            {preview ? (
              <iframe
                className="workspace__frame"
                title="三维空间预览"
                src={preview}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-pointer-lock"
              />
            ) : (
              <div className="workspace__empty">
                <span aria-hidden="true">◇</span>
                <p>等待空间或草稿预览</p>
                <small>把建造交给 worker，在这里看见变化</small>
              </div>
            )}
            {preview.startsWith('/preview') && note.agentId && (
              <section className="workspace__panel">
                <h2>验收这次草稿</h2>
                {previewError && <p role="alert">{previewError}</p>}
                {checkedPreview && (
                  <p>
                    草稿 <code>{checkedPreview.preview.draftId}</code> · 修订{' '}
                    {checkedPreview.preview.rev}
                  </p>
                )}
                <p>如需调整，继续向 worker 描述。确认后，它会检查当前草稿和版本再发布。</p>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmPublish}
                    onChange={(e) => setConfirmPublish(e.target.checked)}
                  />
                  我已查看预览，要求 worker 发布对应草稿
                </label>
                <button
                  disabled={!confirmPublish || disabled || !checkedPreview}
                  onClick={() =>
                    void runIntent({
                      action: 'message',
                      body: {
                        agentId: note.agentId,
                        context: {
                          spaceId: checkedPreview!.spaceId,
                          ...(note.orgId ? { orgId: note.orgId } : {}),
                        },
                        instruction: `我已查看预览，确认发布空间 ${checkedPreview!.spaceId} 的草稿 ${checkedPreview!.preview.draftId}，范围 ${checkedPreview!.preview.scope}，草稿修订 rev=${checkedPreview!.preview.rev}，基础版本 baseSeq=${checkedPreview!.preview.baseSeq}。先核对上述编号和版本是否仍一致，并在发布请求中保留该 rev；如果已变化或冲突，请停止并说明，不要自动重放。`,
                        idempotencyKey: crypto.randomUUID(),
                      },
                    })
                  }
                >
                  请 worker 发布此草稿
                </button>
              </section>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
