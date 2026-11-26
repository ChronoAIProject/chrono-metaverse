import { useEffect, useMemo, useRef, useState } from 'react';
import { readCatalog, viewerLink, type Catalog, type Session } from './client';
import { createPublicClient } from '../core/api/client';
import { SpacePage } from '../space/SpacePage';
import './WorkspacePage.css';
import { ViewerToolsContext, ViewerToolBinding } from './viewerTools';
import { NyxAgentPanel } from './NyxAgentPanel';
import { ShareSpace } from './ShareSpace';
import { setPendingViewerCommand, type ViewerCommand } from './viewerActions';
export function WorkspacePage({ request = fetch }: { readonly request?: typeof fetch }) {
  const [sdkViewer] = useState(() => new ViewerToolBinding());
  return (
    <ViewerToolsContext.Provider value={sdkViewer}>
      <Workspace request={request} />
    </ViewerToolsContext.Provider>
  );
}

function Workspace({ request }: { readonly request: typeof fetch }) {
  const [session, setSession] = useState<Session | null>(null);
  const [spaceId, setSpaceId] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const selected = catalog?.items.find((space) => space.id === spaceId);
  const [disabled, setBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [catalogError, setCatalogError] = useState('');
  const [catalogReload, setCatalogReload] = useState(0);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [menu, setMenu] = useState<'spaces' | 'view' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const spaceButton = useRef<HTMLButtonElement>(null);
  const [targetId, setTargetId] = useState('');
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [viewerInput, setViewerInput] = useState('');
  const [viewerCommand, setViewerCommand] = useState<ViewerCommand>();
  const [viewerFeedback, setViewerFeedback] = useState<{ error?: string; notice?: string }>({});
  const appliedViewerCommands = useRef(new Set<string>());
  const browserCsrf = session?.connected ? session.csrfToken : undefined;
  const inlinePreviewToken = preview.startsWith('/preview#t=')
    ? new URL(preview, window.location.origin).hash.slice(3)
    : undefined;
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
        setSession(s);
        setCatalog(null);
        const space = new URLSearchParams(location.search).get('space') ?? '';
        setSpaceId(/^[a-z0-9][a-z0-9-]{0,79}$/.test(space) ? space : '');
        setMenu(null);
        setError('');
      })
      .catch(() => {
        if (active) setError('无法读取连接状态，请重试。');
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      c.abort();
      clearTimeout(timeout);
    };
  }, [request, reload]);
  useEffect(() => {
    if (!browserCsrf) return;
    const c = new AbortController();
    const timeout = setTimeout(() => c.abort(), 15000);
    let active = true;
    void readCatalog(
      { enabled: true, connected: true, csrfToken: browserCsrf },
      undefined,
      c.signal,
      request,
    )
      .then((v) => {
        if (active) {
          setCatalog(v);
          setCatalogError('');
        }
      })
      .catch((e) => {
        if (active) setCatalogError(e instanceof Error ? e.message : '无法读取空间列表。');
      })
      .finally(() => {
        clearTimeout(timeout);
        if (active) setCatalogBusy(false);
      });
    return () => {
      active = false;
      c.abort();
      clearTimeout(timeout);
    };
  }, [browserCsrf, request, catalogReload]);
  async function moreSpaces() {
    if (!session || !catalog?.next || catalogBusy) return;
    setCatalogBusy(true);
    const c = new AbortController();
    const timeout = setTimeout(() => c.abort(), 15000);
    try {
      const page = await readCatalog(session, catalog.next, c.signal, request);
      setCatalog((old) =>
        old
          ? {
              ...page,
              items: [
                ...old.items,
                ...page.items.filter((s) => !old.items.some((o) => o.id === s.id)),
              ],
            }
          : page,
      );
      setCatalogError('');
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : '无法读取空间列表。');
    } finally {
      clearTimeout(timeout);
      setCatalogBusy(false);
    }
  }
  function openSpace(id: string) {
    if (!session?.subject || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) return;
    setSpaceId(id);
    setMenu(null);
    setPreview('');
    setViewerCommand(undefined);
    setViewerFeedback({});
    setError('');
    const url = new URL(location.href);
    url.searchParams.set('space', id);
    window.history.replaceState(null, '', url.pathname + url.search);
  }
  function applyViewerCommand(command: ViewerCommand) {
    const key = `${spaceId}:${command.id}`;
    if (appliedViewerCommands.current.has(key)) return false;
    const space = command.actions.find((a) => a.type === 'space');
    if (space?.type === 'space') {
      const target = catalog?.items.find((s) => s.id === space.spaceId);
      if (!target) {
        setViewerFeedback({ error: '无法打开该空间，请先在空间列表中核对访问权限。' });
        return false;
      }
      openSpace(target.id);
    }
    const universe = command.actions.find((a) => a.type === 'universe');
    if (universe?.type === 'universe') {
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(universe.universeId)) {
        setViewerFeedback({ error: '组合编号格式不正确。' });
        return false;
      }
      setPendingViewerCommand({ id: command.id, actions: command.actions.slice(1) });
      appliedViewerCommands.current.add(key);
      window.history.pushState(null, '', `/s/${encodeURIComponent(universe.universeId)}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return true;
    }
    appliedViewerCommands.current.add(key);
    if (appliedViewerCommands.current.size > 50)
      appliedViewerCommands.current.delete(appliedViewerCommands.current.values().next().value!);
    for (const action of command.actions) {
      if (action.type === 'current') {
        setPreview('');
      }
      if (action.type === 'preview') {
        setPreview(viewerLink(action.url)!);
      }
    }
    setViewerCommand(command);
    setViewerFeedback({ notice: '已更新页面查看设置。' });
    return true;
  }
  const visibleSpaces =
    catalog?.items.filter(
      (s) =>
        (ownerFilter === 'all' ||
          (ownerFilter === 'person' ? s.owner.kind === 'person' : s.owner.id === ownerFilter)) &&
        `${s.name} ${s.id}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const browserClient = useMemo(
    () =>
      browserCsrf
        ? createPublicClient({ browser: { csrfToken: browserCsrf }, fetch: request })
        : null,
    [browserCsrf, request],
  );
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (menu && event.target instanceof Node && !menuRef.current?.contains(event.target))
        setMenu(null);
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape' && menu) {
        setMenu(null);
        spaceButton.current?.focus();
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyboard);
    };
  }, [menu]);
  return (
    <main className="workspace">
      <header className="workspace__header workspace__ui">
        <a href="/" className="workspace__brand" aria-label="chrono-metaverse 首页">
          <span className="workspace__brand-full">chrono-metaverse</span>
          <span className="workspace__brand-short" aria-hidden="true">
            chrono
          </span>
        </a>
        {session?.connected && (
          <div className="workspace__menus" ref={menuRef}>
            <button
              ref={spaceButton}
              className="workspace__space-trigger workspace__secondary"
              aria-label="选择空间"
              aria-expanded={menu !== null}
              aria-controls="workspace-spaces"
              onClick={() => setMenu(menu === null ? 'spaces' : null)}
            >
              <span aria-hidden="true">▦</span>
              <span>{selected?.name || spaceId || '选择空间'}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            {menu !== null && (
              <section id="workspace-spaces" className="workspace__library" aria-label="空间菜单">
                <div className="workspace__heading">
                  <h2>空间</h2>
                  <button
                    className="workspace__icon-button workspace__secondary"
                    aria-label="关闭空间菜单"
                    onClick={() => {
                      setMenu(null);
                      spaceButton.current?.focus();
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="workspace__menu-tabs" role="group" aria-label="空间菜单内容">
                  <button
                    className="workspace__secondary"
                    aria-pressed={menu === 'spaces'}
                    onClick={() => setMenu('spaces')}
                  >
                    我的空间
                  </button>
                  <button
                    className="workspace__secondary"
                    aria-pressed={menu === 'view'}
                    onClick={() => setMenu('view')}
                  >
                    查看与预览
                  </button>
                </div>
                {error && <p role="alert">{error}</p>}
                {menu === 'spaces' && (
                  <div className="workspace__menu-content" aria-label="已有空间">
                    <button
                      className="workspace__secondary"
                      disabled={catalogBusy}
                      onClick={() => setCatalogReload((v) => v + 1)}
                    >
                      刷新空间
                    </button>
                    <label>
                      搜索空间
                      <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="名称或编号"
                      />
                    </label>
                    <label>
                      空间归属
                      <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                        <option value="all">全部空间</option>
                        <option value="person">我的个人空间</option>
                        {catalog?.organizations.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {catalogError && <p role="alert">{catalogError}</p>}
                    {!catalog && !catalogError && <p role="status">正在读取空间…</p>}
                    <ul className="workspace__spaces">
                      {visibleSpaces.map((space) => (
                        <li key={space.id}>
                          <button
                            className="workspace__space-card"
                            aria-pressed={spaceId === space.id}
                            disabled={disabled}
                            onClick={() => openSpace(space.id)}
                          >
                            <strong>{space.name}</strong>
                            <span>
                              {space.owner.kind === 'person'
                                ? '个人空间'
                                : (catalog?.organizations.find((o) => o.id === space.owner.id)
                                    ?.name ?? '组织空间')}{' '}
                              · {space.access === 'read' ? '只读' : '可调整'}
                            </span>
                            <small>{space.id}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {catalog && visibleSpaces.length === 0 && (
                      <p className="workspace__muted">
                        {search || ownerFilter !== 'all'
                          ? '当前筛选下没有空间。'
                          : '还没有可访问的空间。'}
                      </p>
                    )}
                    {catalog?.next && (
                      <button
                        className="workspace__secondary"
                        disabled={catalogBusy}
                        onClick={() => void moreSpaces()}
                      >
                        加载更多空间
                      </button>
                    )}

                    <details className="workspace__open-space">
                      <summary>按编号打开已有空间</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          openSpace(targetId);
                        }}
                      >
                        <label>
                          目标空间编号
                          <input
                            value={targetId}
                            onChange={(e) => setTargetId(e.target.value)}
                            required
                            maxLength={80}
                            pattern="[a-z0-9][a-z0-9-]*"
                            placeholder="例如 sample-space"
                          />
                        </label>
                        <button disabled={disabled || !targetId}>打开空间</button>
                      </form>
                    </details>
                  </div>
                )}
                {menu === 'view' && (
                  <div className="workspace__menu-content" aria-label="查看选项">
                    <div className="workspace__heading">
                      <h2>{preview ? '草稿预览 · 尚未发布' : '当前已发布空间'}</h2>
                    </div>
                    {preview && (
                      <button
                        onClick={() => {
                          setPreview('');
                          setMenu(null);
                        }}
                      >
                        当前空间
                      </button>
                    )}
                    {preview && (
                      <a href={preview} target="_blank" rel="noopener noreferrer">
                        在新窗口打开 ↗
                      </a>
                    )}
                    <details className="workspace__open-link">
                      <summary>打开分享或预览链接</summary>
                      <form
                        className="workspace__viewer-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const url = viewerLink(viewerInput);
                          if (url) {
                            setPreview(url);
                            setError('');
                            setMenu(null);
                          } else {
                            setError('请输入本站的空间、组合或草稿预览链接。');
                          }
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
                    </details>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
        {browserCsrf &&
          selected &&
          (selected.visibility === 'public' || selected.access === 'manage') && (
            <ShareSpace
              key={`${browserCsrf}:${selected.id}`}
              space={selected}
              csrfToken={browserCsrf}
              request={request}
            />
          )}
        {session?.connected && selected && (
          <NyxAgentPanel
            key={JSON.stringify([session.subject, selected.id, selected.owner.id])}
            session={session}
            space={selected}
            onBusy={setBusy}
            viewerContext={{
              spaces: (catalog?.items ?? []).map(({ id, name }) => ({ id, name })),
              ...(inlinePreviewToken ? { preview } : {}),
            }}
            onViewerCommand={applyViewerCommand}
            viewerFeedback={viewerFeedback}
            onPreview={setPreview}
          />
        )}
        <nav className="workspace__account-nav">
          <a href="/connect">账号与组织</a>
        </nav>
      </header>
      {!session && (
        <section className="workspace__panel workspace__ui">
          <p>正在读取连接状态…</p>
          {error && (
            <>
              <p role="alert">{error}</p>
              <button onClick={() => setReload((v) => v + 1)}>重新读取</button>
            </>
          )}
        </section>
      )}
      {session && !session.connected && (
        <section className="workspace__welcome workspace__ui">
          <span>YOUR SPACES, ONE CONVERSATION</span>
          <h1>打开空间，聊着就能改</h1>
          <p>在查看器中选择物件，通过 Nyx 助手调整空间。</p>
          <a className="workspace__button" href="/connect">
            连接 NyxID，查看我的空间
          </a>
        </section>
      )}
      {session?.connected && (
        <div className="workspace__stage">
          <section className="workspace__preview" aria-label="空间视图">
            <div className="workspace__scene">
              {preview && (!inlinePreviewToken || !spaceId || !browserClient) ? (
                <iframe
                  className="workspace__frame"
                  title="三维空间预览"
                  src={preview}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-pointer-lock"
                />
              ) : spaceId && browserClient ? (
                <SpacePage
                  key={session.subject}
                  spaceId={spaceId}
                  client={browserClient}
                  hasShareToken
                  embedded
                  previewToken={inlinePreviewToken}
                  viewerCommand={viewerCommand}
                  onCameraResult={(success) =>
                    setViewerFeedback(
                      success
                        ? { notice: '已调整镜头。' }
                        : { error: '当前视图中没有找到可聚焦的物件，请先切换视图或核对物件。' },
                    )
                  }
                />
              ) : (
                <div className="workspace__empty">
                  <span aria-hidden="true">◇</span>
                  <h1>让你的空间占满眼前</h1>
                  <p>选择一个可访问的空间。</p>
                  <div className="workspace__ui workspace__actions">
                    <button onClick={() => setMenu('spaces')}>选择已有空间</button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
