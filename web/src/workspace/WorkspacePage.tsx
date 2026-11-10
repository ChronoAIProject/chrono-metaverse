import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
import { createPublicClient } from '../core/api/client';
import { SpacePage } from '../space/SpacePage';
import {
  readCatalog,
  readSpaceNotebook,
  recordSent,
  outputMessages,
  userText,
  type Catalog,
  type ResponseOutput,
} from './client';
import './WorkspacePage.css';
import { modelDigest, scaniverseLink, uploadModel } from './creation';
import { StartupProgress } from './StartupProgress';

type PreviewIdentity = {
  spaceId: string;
  preview: { draftId: string; rev: number; baseSeq: number; scope: string };
};
const CMA = 'https://cma.nyxid.ai';
const terminal = (status: string) =>
  ['succeeded', 'completed', 'failed', 'cancelled', 'stopped', 'deleted', 'paused'].includes(
    status,
  );
function fileUploadIntent(base: Notebook): Intent {
  const source = base.creation!.source!;
  if (source.kind !== 'file') throw new Error('没有待上传模型');
  return {
    action: 'attachment',
    body: {
      agentId: base.agentId,
      name: source.name,
      size: source.size,
      sha256: source.sha256,
      idempotencyKey: crypto.randomUUID(),
    },
  };
}
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
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogReload, setCatalogReload] = useState(0);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [menu, setMenu] = useState<'spaces' | 'view' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const spaceButton = useRef<HTMLButtonElement>(null);
  const viewButton = useRef<HTMLButtonElement>(null);
  const chatButton = useRef<HTMLButtonElement>(null);
  const chatPanel = useRef<HTMLElement>(null);
  const autoUpload = useRef(false);
  const [sourceFile, setSourceFile] = useState<{
    spaceId: string;
    file: File;
    sha256: string;
  } | null>(null);
  const [targetId, setTargetId] = useState('');
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [output, setOutput] = useState<ResponseOutput[]>([]);
  const [followPreview, setFollowPreview] = useState(true);
  const chatEnd = useRef<HTMLDivElement>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState('');
  const [confirmForget, setConfirmForget] = useState(false);
  const [manualPreview, setPreview] = useState('');
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
  const browserCsrf = session?.connected ? session.csrfToken : undefined;

  const responseTexts = outputMessages(output);
  const liveTranscript: Transcript = {
    turns: [
      {
        turn_sequence: 0,
        owner_message: '',
        outcome: null,
        messages: responseTexts.map((content, sequence) => ({
          sequence,
          role: 'assistant',
          content,
        })),
      },
    ],
  };
  const links = [...new Set([...resultLinks(liveTranscript), ...resultLinks(transcript)])];
  const latest = links[0] ?? '';
  const preview = followPreview && latest ? latest : manualPreview;
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
        setCatalog(null);
        setOutput([]);
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
        setChatOpen(Boolean(recovered.pending));
        setMenu(null);
        setSourceFile(null);
        autoUpload.current = false;
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
          v.spaceId !== note.spaceId ||
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
  }, [preview, request, note.spaceId]);

  const report = useCallback((e: unknown) => {
    if (e instanceof WorkerError && e.code === 'cma_consent_required')
      setSession((s) => (s ? { ...s, workerEnabled: false } : s));
    if (e instanceof WorkerError && e.code === 'nyxid_reconnect_required') {
      setSession({ enabled: true, connected: false });
      setTranscript(null);
      setAgent(null);
      setOperation(null);
      setPreview('');
      setOutput([]);
      setCatalog(null);
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
    let failures = 0;
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
          if (failures) setError('');
          failures = 0;
          setOperation(v.operation);
          if (['succeeded', 'completed'].includes(v.operation.status) && v.operation.agent_id) {
            commit({
              ...noteRef.current,
              agentId: v.operation.agent_id,
              operationId: undefined,
              startup: undefined,
            });
            setOperation(null);
            return;
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
            const r = await workerRequest<{
              response: { status: string; output?: ResponseOutput[] };
              controls: Controls;
            }>(
              session!,
              'response',
              { agentId: agentId, responseId: responseId },
              c.signal,
              request,
            );
            if (!active) return;
            setResponseStatus(r.response.status);
            setOutput(r.response.output ?? []);
            setControls(r.controls);
            if (terminal(r.response.status)) return;
          } else if (
            ['failed', 'stopped', 'paused', 'deleted'].includes(v.agent.status) ||
            (['ready', 'idle'].includes(v.agent.status) &&
              v.transcript.turns.some((t) => t.messages.some((m) => m.role === 'assistant')))
          )
            return;
        }
        if (failures) setError('');
        failures = 0;
        reads++;
        if (reads < 120 && active) timer = setTimeout(() => void observe(), 2000);
        else if (active) setNotice('自动刷新已暂停，尚未确认任务完成。点击刷新进度继续查看。');
      } catch (e) {
        if (!active) return;
        if (
          e instanceof WorkerError &&
          (e.code === 'network' ||
            e.code === 'cma_unavailable' ||
            e.status === 408 ||
            e.status === 429 ||
            (e.status ?? 0) >= 500) &&
          failures < 4
        ) {
          failures++;
          setError('暂时无法读取 CMA 进度，正在重新连接。原任务已保留。');
          timer = setTimeout(() => void observe(), Math.min(1000 * 2 ** failures, 10000));
        } else report(e);
      }
    }
    void observe();
    return () => {
      active = false;
      c.abort();
      clearTimeout(timer);
    };
  }, [session, agentId, operationId, responseId, busy, request, poll, commit, report]);

  const action = useCallback(
    async (run: (signal: AbortSignal) => Promise<void>) => {
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
    },
    [report],
  );
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
  const runIntent = useCallback(
    async function runIntent(intent: Intent, base = noteRef.current) {
      const chain: { next?: { intent: Intent; base: Notebook } } = {};
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
          if (pending.action === 'attachment') {
            if (
              !sourceFile ||
              sourceFile.spaceId !== base.spaceId ||
              sourceFile.file.name !== pending.body.name ||
              sourceFile.file.size !== pending.body.size ||
              sourceFile.sha256 !== pending.body.sha256
            )
              throw new Error('请重新选择同一模型文件，再重试原请求。');
            const receipt = await uploadModel(
              session!,
              String(pending.body.agentId),
              sourceFile.file,
              pending.body.idempotencyKey,
              sourceFile.sha256,
              signal,
              request,
            );
            if (signal.aborted) return;
            const creation = base.creation!;
            const source = {
              kind: 'file' as const,
              name: receipt.name,
              size: receipt.size_bytes,
              sha256: receipt.sha256,
              attachment: receipt,
            };
            const follow: Intent = {
              action: 'message',
              body: {
                agentId: base.agentId,
                context: {
                  chat: true,
                  spaceId: base.spaceId,
                  ...(base.orgId ? { orgId: base.orgId } : {}),
                  creation: { name: creation.name, source },
                },
                instruction: creation.instruction || `从模型 ${receipt.name} 创建空间`,
                idempotencyKey: crypto.randomUUID(),
              },
            };
            const next = {
              ...base,
              creation: { ...creation, source, phase: 'uploaded' as const },
              pending: follow,
            };
            commit(next);
            chain.next = { intent: follow, base: next };
            return;
          }
          const value = await workerRequest<{
            id?: string;
            responseId?: string;
            commandId?: string;
          }>(session!, pending.action, pending.body, signal, request);
          if (signal.aborted) return;
          if (pending.action === 'create') {
            if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id))
              throw new Error('创建结果缺少任务编号，请重试原请求恢复。');
            if (base.operationId && value.id !== base.operationId)
              throw new Error('CMA 返回的任务编号与原任务不一致，请先核对原任务状态。');
            commit({
              ...base,
              pending: undefined,
              operationId: value.id,
              startup: pending,
              instruction: '',
              sent: pending.body.prepareOnly
                ? base.sent
                : recordSent(base, pending.body.idempotencyKey, String(pending.body.instruction)),
              ...(base.creation
                ? {
                    creation: {
                      ...base.creation,
                      phase: pending.body.prepareOnly
                        ? ('preparing' as const)
                        : ('submitted' as const),
                    },
                  }
                : {}),
              agentId: undefined,
              responseId: undefined,
            });
            setOperation(null);
            setAgent(null);
            setTranscript(null);
          } else if (pending.action === 'message') {
            if (!value.responseId) throw new Error('结果缺少响应编号，请重试原请求恢复。');
            commit({
              ...base,
              pending: undefined,
              responseId: value.responseId,
              instruction: '',
              sent: recordSent(base, pending.body.idempotencyKey, String(pending.body.instruction)),
              ...(base.creation
                ? { creation: { ...base.creation, phase: 'submitted' as const } }
                : {}),
            });
            setOutput([]);
            setResponseStatus('queued');
            setControls(null);
            setConfirmPublish('');
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
      if (chain.next) await runIntent(chain.next.intent, chain.next.base);
    },
    [action, commit, request, session, sourceFile],
  );

  useEffect(() => {
    if (
      !autoUpload.current ||
      !sourceFile ||
      sourceFile.spaceId !== note.spaceId ||
      !note.agentId ||
      note.operationId ||
      note.pending ||
      busy ||
      note.creation?.phase !== 'preparing'
    )
      return;
    // 只接续本次明确提交的创建流程；刷新页面或结果未知时必须手动恢复。
    const timer = setTimeout(() => {
      autoUpload.current = false;
      void runIntent(fileUploadIntent(note), note);
    }, 0);
    return () => clearTimeout(timer);
  }, [note, sourceFile, busy, runIntent]);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!session?.workerEnabled || busy || note.operationId || note.pending || !note.spaceId.trim())
      return;
    if (note.creation?.phase === 'draft') {
      const url = scaniverseLink(note.instruction);
      const source =
        sourceFile?.spaceId === note.spaceId
          ? {
              kind: 'file' as const,
              name: sourceFile.file.name,
              size: sourceFile.file.size,
              sha256: sourceFile.sha256,
            }
          : url
            ? { kind: 'scaniverse' as const, url }
            : null;
      if (!source || !note.creation.name.trim()) {
        setError('填写空间名称，再粘贴 Scaniverse 链接或上传 GLB/ZIP 模型。');
        return;
      }
      const base = {
        ...note,
        creation: {
          ...note.creation,
          name: note.creation.name.trim(),
          source,
          instruction:
            note.instruction.trim() ||
            `从模型 ${source.kind === 'file' ? source.name : source.url} 创建空间`,
        },
      };
      autoUpload.current = source.kind === 'file';
      void runIntent(
        {
          action: 'create',
          body: {
            context: {
              chat: true,
              spaceId: note.spaceId,
              ...(note.orgId ? { orgId: note.orgId } : {}),
              creation: { name: base.creation.name, source },
            },
            instruction: base.creation.instruction,
            ...(source.kind === 'file' ? { prepareOnly: true } : {}),
            idempotencyKey: crypto.randomUUID(),
          },
        },
        base,
      );
      return;
    }
    if (note.creation && ['preparing', 'uploaded'].includes(note.creation.phase)) return;
    if (!note.instruction.trim()) return;
    void runIntent({
      action: note.agentId ? 'message' : 'create',
      body: {
        context: {
          chat: true,
          spaceId: note.spaceId.trim(),
          ...(note.orgId ? { orgId: note.orgId } : {}),
        },
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
    setOutput([]);
    setPreview('');
  }
  function change(field: 'spaceId' | 'orgId' | 'instruction', value: string) {
    try {
      commit({ ...note, [field]: value });
    } catch {
      setError('无法保存此标签页的恢复记录，请检查浏览器存储设置。');
    }
  }
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
  function openSpace(id: string, orgId?: string) {
    if (disabled || !session?.subject || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) return;
    try {
      const next = readSpaceNotebook(session.subject, id);
      if (!next.agentId && orgId) next.orgId = orgId;
      commit(next);
      setMenu(null);
      setSourceFile(null);
      autoUpload.current = false;
      setTranscript(null);
      setAgent(null);
      setOperation(null);
      setControls(null);
      setOutput([]);
      setResponseStatus('');
      setPreview('');
      setPreviewIdentity(null);
      setPreviewError('');
      setConfirmPublish('');
      setFollowPreview(true);
      setNotice('');
      setError('');
      const u = new URL(window.location.href);
      u.searchParams.set('space', id);
      window.history.replaceState(null, '', u.pathname + u.search);
    } catch {
      setError('无法保存聊天记录，请检查浏览器存储设置。');
    }
  }
  const conversation = (transcript?.turns ?? [])
    .slice(-30)
    .flatMap((t) => [
      {
        key: `u-${t.turn_sequence}`,
        role: 'user',
        text: userText(t.owner_message || t.messages.find((m) => m.role === 'user')?.content || ''),
      },
      ...t.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => ({
          key: `a-${t.turn_sequence}-${m.sequence}`,
          role: 'assistant',
          text: m.content,
        })),
    ])
    .filter((m) => m.text);
  const consumed = new Map<string, number>();
  for (const m of conversation)
    if (m.role === 'user') consumed.set(m.text, (consumed.get(m.text) ?? 0) + 1);
  const unobserved = (note.sent ?? []).filter((m) => {
    const n = consumed.get(m.text) ?? 0;
    if (n) {
      consumed.set(m.text, n - 1);
      return false;
    }
    return true;
  });
  const lastTurn = transcript?.turns.at(-1);
  const extraTexts = responseTexts.filter(
    (t) => !lastTurn?.messages.some((m) => m.role === 'assistant' && m.content === t),
  );
  const pendingText =
    note.pending && ['create', 'message'].includes(note.pending.action)
      ? String(note.pending.body.instruction ?? '')
      : '';
  useEffect(() => {
    if (chatOpen) chatEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [transcript, output, busy, note.sent, note.pending, chatOpen]);
  const cmaBase = session?.workerUrl ?? CMA;
  const observedAgentId = note.agentId || operation?.agent_id;
  const cmaLink = observedAgentId
    ? `${cmaBase}/agents/${encodeURIComponent(observedAgentId)}`
    : cmaBase;
  const checkedPreview = previewIdentity?.url === preview ? previewIdentity.value : null;
  const ready = session?.connected && session.workerEnabled;
  const disabled = busy || Boolean(note.pending);
  const selected = catalog?.items.find((s) => s.id === note.spaceId);
  const visibleSpaces =
    catalog?.items.filter(
      (s) =>
        (ownerFilter === 'all' ||
          (ownerFilter === 'person' ? s.owner.kind === 'person' : s.owner.id === ownerFilter)) &&
        `${s.name} ${s.id}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const querySpace = new URLSearchParams(window.location.search).get('space');
  const browserClient = useMemo(
    () =>
      browserCsrf
        ? createPublicClient({ browser: { csrfToken: browserCsrf }, fetch: request })
        : null,
    [browserCsrf, request],
  );
  const activity = output.filter((o) => o.type === 'mcp_call' && o.name).slice(-3);
  const awaiting =
    busy ||
    ['queued', 'in_progress', 'running'].includes(responseStatus) ||
    ['working', 'busy', 'running'].includes(agent?.status ?? '');
  const creating = note.creation?.phase === 'draft';
  const importing = Boolean(
    note.creation && ['preparing', 'uploaded'].includes(note.creation.phase),
  );
  const spaceName = selected?.name ?? note.creation?.name ?? note.spaceId;
  const canSend = Boolean(
    ready &&
    note.spaceId &&
    !disabled &&
    !note.operationId &&
    !importing &&
    (creating
      ? note.creation!.name.trim() &&
        (sourceFile?.spaceId === note.spaceId || scaniverseLink(note.instruction))
      : note.instruction.trim()),
  );
  function startCreation() {
    if (disabled || !session?.subject) return;
    const org =
      selected?.owner.kind === 'org' &&
      catalog?.organizations.some((o) => o.id === selected.owner.id && o.role === 'admin')
        ? selected.owner.id
        : '';
    const spaceId = `space-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    openSpace(spaceId, org);
    commit({
      ...emptyNotebook(),
      spaceId,
      orgId: org,
      creation: { name: '新空间', phase: 'draft' },
    });
    setChatOpen(true);
  }
  async function pickModel(file: File) {
    if (!note.creation || busy || note.creation.phase === 'submitted') return;
    const base = note;
    await action(async () => {
      const sha256 = await modelDigest(file);
      if (base.spaceId !== noteRef.current.spaceId) return;
      if (
        base.creation!.phase !== 'draft' &&
        base.creation!.source?.kind === 'file' &&
        (base.creation!.source.name !== file.name ||
          base.creation!.source.size !== file.size ||
          base.creation!.source.sha256 !== sha256)
      )
        throw new Error('请选择原来提交的同一文件，文件名、大小和内容必须一致。');
      setSourceFile({ spaceId: base.spaceId, file, sha256 });
      if (base.creation!.phase === 'draft')
        commit({
          ...base,
          creation: {
            ...base.creation!,
            source: { kind: 'file', name: file.name, size: file.size, sha256 },
          },
        });
    });
  }
  function closeChat() {
    setChatOpen(false);
    requestAnimationFrame(() => chatButton.current?.focus());
  }
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (menu && event.target instanceof Node && !menuRef.current?.contains(event.target))
        setMenu(null);
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (menu) {
        setMenu(null);
        (menu === 'spaces' ? spaceButton : viewButton).current?.focus();
      } else if (chatOpen && chatPanel.current?.contains(document.activeElement)) {
        setChatOpen(false);
        requestAnimationFrame(() => chatButton.current?.focus());
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyboard);
    };
  }, [menu, chatOpen]);
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
          <>
            <div className="workspace__menus" ref={menuRef}>
              <button
                ref={spaceButton}
                className="workspace__space-trigger workspace__secondary"
                aria-label="选择空间"
                aria-expanded={menu === 'spaces'}
                aria-controls="workspace-spaces"
                onClick={() => setMenu(menu === 'spaces' ? null : 'spaces')}
              >
                <span aria-hidden="true">▦</span>
                <span>{spaceName || '选择空间'}</span>
                <span aria-hidden="true">⌄</span>
              </button>
              <button
                ref={viewButton}
                className="workspace__view-trigger workspace__secondary"
                aria-label="切换空间视图"
                aria-expanded={menu === 'view'}
                aria-controls="workspace-view-options"
                onClick={() => setMenu(menu === 'view' ? null : 'view')}
              >
                <span aria-hidden="true">◈</span>
                <span>{preview ? '草稿预览' : '当前空间'}</span>
                <span aria-hidden="true">⌄</span>
              </button>
              {menu === 'spaces' && (
                <section id="workspace-spaces" className="workspace__library" aria-label="已有空间">
                  <div className="workspace__heading">
                    <h2>我的空间</h2>
                    <button
                      className="workspace__icon-button workspace__secondary"
                      aria-label="关闭空间菜单"
                      onClick={() => setMenu(null)}
                    >
                      ×
                    </button>
                    <button
                      className="workspace__secondary"
                      disabled={catalogBusy}
                      onClick={() => setCatalogReload((v) => v + 1)}
                    >
                      刷新空间
                    </button>
                  </div>
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
                          aria-pressed={note.spaceId === space.id}
                          disabled={disabled}
                          onClick={() =>
                            openSpace(
                              space.id,
                              space.owner.kind === 'org' ? space.owner.id : undefined,
                            )
                          }
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
                        : '还没有可访问的空间，可以点击顶部“创建空间”开始。'}
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
                          placeholder="例如 chronoai-lobby"
                        />
                      </label>
                      <button disabled={disabled || !targetId}>打开空间</button>
                    </form>
                  </details>
                </section>
              )}
              {menu === 'view' && (
                <section
                  id="workspace-view-options"
                  className="workspace__view-options"
                  aria-label="查看选项"
                >
                  <div className="workspace__heading">
                    <h2>{preview ? '草稿预览 · 尚未发布' : '当前已发布空间'}</h2>
                    <button
                      className="workspace__icon-button workspace__secondary"
                      aria-label="关闭查看选项"
                      onClick={() => setMenu(null)}
                    >
                      ×
                    </button>
                  </div>
                  {links.length > 0 && (
                    <div className="workspace__results">
                      <button
                        className={!preview ? '' : 'workspace__secondary'}
                        onClick={() => {
                          setFollowPreview(false);
                          setPreview('');
                          setConfirmPublish('');
                          setMenu(null);
                        }}
                      >
                        当前空间
                      </button>
                      {links.slice(0, 5).map((url, i) => (
                        <button
                          key={url}
                          className={preview === url ? '' : 'workspace__secondary'}
                          onClick={() => {
                            setFollowPreview(i === 0);
                            setPreview(url);
                            setPreviewIdentity(null);
                            setConfirmPublish('');
                            setMenu(null);
                          }}
                        >
                          {url.startsWith('/preview') ? `草稿预览 ${i + 1}` : url.split('#')[0]}
                        </button>
                      ))}
                    </div>
                  )}
                  {!followPreview && latest && (
                    <button className="workspace__secondary" onClick={() => setFollowPreview(true)}>
                      跟随最新预览
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
                          setFollowPreview(false);
                          setConfirmPublish('');
                          setPreviewIdentity(null);
                          setPreview(url);
                          setError('');
                          setMenu(null);
                        } else {
                          setError('请输入本站的空间、组合或草稿预览链接。');
                          setChatOpen(true);
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
                </section>
              )}
            </div>
            <button
              className="workspace__create-button"
              aria-label="创建空间"
              disabled={disabled}
              onClick={startCreation}
            >
              <span aria-hidden="true">＋</span>
              <span>创建空间</span>
            </button>
          </>
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
          <p>把空间铺满眼前，让 CMA 在左下角陪你建造。</p>
          <a className="workspace__button" href="/connect">
            连接 NyxID，查看我的空间
          </a>
        </section>
      )}
      {session?.connected && (
        <div className="workspace__stage">
          <section className="workspace__preview" aria-label="空间视图">
            <div className="workspace__scene">
              {preview ? (
                <iframe
                  className="workspace__frame"
                  title="三维空间预览"
                  src={preview}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-pointer-lock"
                />
              ) : note.creation && !selected ? (
                <div className="workspace__empty" role="status">
                  <span aria-hidden="true">◇</span>
                  <h1>{note.creation.name}</h1>
                  <p>
                    {creating
                      ? '在左下角放入扫描链接或模型，开始创建你的空间。'
                      : 'CMA 正在准备空间；重建完成后，预览会出现在这里。'}
                  </p>
                  <div className="workspace__ui">
                    <button onClick={() => setChatOpen(true)}>打开创建聊天</button>
                  </div>
                </div>
              ) : note.spaceId && browserClient ? (
                <SpacePage
                  key={note.spaceId}
                  spaceId={note.spaceId}
                  client={browserClient}
                  hasShareToken
                  embedded
                />
              ) : (
                <div className="workspace__empty">
                  <span aria-hidden="true">◇</span>
                  <h1>让你的空间占满眼前</h1>
                  <p>选择已有空间，或从扫描与模型创建一个新空间。</p>
                  <div className="workspace__ui workspace__actions">
                    <button onClick={() => setMenu('spaces')}>选择已有空间</button>
                    <button className="workspace__secondary" onClick={startCreation}>
                      创建第一个空间
                    </button>
                  </div>
                  <small>需要调整时，打开左下角的 CMA 聊天</small>
                </div>
              )}
            </div>
          </section>
          <button
            ref={chatButton}
            className="workspace__chat-launcher workspace__button"
            aria-label="打开 CMA 聊天"
            aria-expanded={chatOpen}
            aria-controls="workspace-chat"
            hidden={chatOpen}
            onClick={() => setChatOpen(true)}
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="M20 11.5a8 8 0 0 1-8 8H4l1.4-4A8 8 0 1 1 20 11.5Z" />
              <path d="M8 10h8M8 14h5" />
            </svg>
            <span>CMA 聊天</span>
            {awaiting ? (
              <small>处理中</small>
            ) : preview.startsWith('/preview') ? (
              <small>查看草稿</small>
            ) : null}
          </button>
          <section
            id="workspace-chat"
            ref={chatPanel}
            className="workspace__chat workspace__ui"
            role="dialog"
            aria-label="CMA 空间聊天"
            aria-modal="false"
            hidden={!chatOpen}
            onDragOver={(e) => {
              if (note.creation && e.dataTransfer.types.includes('Files')) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!note.creation) return;
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) void pickModel(file);
            }}
          >
            <header className="workspace__chat-heading">
              <div>
                <h2>{note.creation?.phase === 'draft' ? '创建空间' : 'CMA 聊天'}</h2>
                <p>{spaceName || '选择一个空间，或创建新空间'}</p>
              </div>
              <span className="workspace__badge" role="status">
                {creating
                  ? '待提交'
                  : statusText(responseStatus || operation?.status || agent?.status || 'ready')}
              </span>
              <button
                className="workspace__icon-button workspace__secondary"
                aria-label="收起 CMA 聊天"
                onClick={closeChat}
              >
                −
              </button>
            </header>
            <div className="workspace__chat-scroll">
              {note.creation && note.creation.phase !== 'submitted' && (
                <section className="workspace__creation" aria-label="创建空间设置">
                  {creating && (
                    <>
                      <h2>从扫描或模型开始</h2>
                      <p>
                        粘贴 Scaniverse 链接，或放入 GLB / 扫描 ZIP。CMA
                        会完成重建和上传，先给你预览。
                      </p>
                      <div className="workspace__creation-fields">
                        <label>
                          空间名称
                          <input
                            value={note.creation.name}
                            maxLength={80}
                            disabled={disabled}
                            onChange={(e) =>
                              commit({
                                ...note,
                                creation: { ...note.creation!, name: e.target.value },
                              })
                            }
                          />
                        </label>
                        <label>
                          空间归属
                          <select
                            value={note.orgId}
                            disabled={disabled}
                            onChange={(e) => change('orgId', e.target.value)}
                          >
                            <option value="">我的个人空间</option>
                            {catalog?.organizations
                              .filter((o) => o.role === 'admin')
                              .map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      </div>
                    </>
                  )}
                  <label className="workspace__file-picker">
                    <input
                      className="workspace__sr-only"
                      type="file"
                      aria-label="选择模型文件"
                      accept=".glb,.zip"
                      disabled={busy}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void pickModel(file);
                        e.target.value = '';
                      }}
                    />
                    <span>
                      {note.creation.source?.kind === 'file' ? '重新选择模型' : '上传模型'}
                    </span>
                    <small>GLB / ZIP · 最大 20 MiB，也可拖入聊天窗</small>
                  </label>
                  {note.creation.source?.kind === 'file' && (
                    <p className="workspace__file-name">
                      {note.creation.source.name} ·{' '}
                      {(note.creation.source.size / 1024 / 1024).toFixed(1)} MiB
                      {!sourceFile && ' · 继续时请重新选择原文件'}
                    </p>
                  )}
                  {note.creation.phase === 'preparing' && (
                    <p role="status">准备建模环境后会上传模型，随后自动开始重建。</p>
                  )}
                  {note.creation.phase === 'preparing' &&
                    note.agentId &&
                    !note.operationId &&
                    !note.pending && (
                      <button
                        disabled={busy || !sourceFile}
                        onClick={() => void runIntent(fileUploadIntent(note))}
                      >
                        继续上传模型
                      </button>
                    )}
                </section>
              )}
              {querySpace &&
                querySpace !== note.spaceId &&
                /^[a-z0-9][a-z0-9-]{0,79}$/.test(querySpace) && (
                  <div className="workspace__notice">
                    <p>已有会话已保留，可切换到链接指定的空间。</p>
                    <button disabled={disabled} onClick={() => openSpace(querySpace)}>
                      打开 {querySpace}
                    </button>
                  </div>
                )}
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
              {!session.workerAvailable && (
                <div className="workspace__notice">
                  <p>在线 worker 尚未启用。你仍可以查看有权限的空间。</p>
                </div>
              )}
              {session.workerAvailable && !session.workerEnabled && (
                <div className="workspace__consent">
                  <h2>启用空间聊天</h2>
                  <label>
                    <input
                      type="checkbox"
                      checked={consentChecked}
                      onChange={(e) => setConsentChecked(e.target.checked)}
                    />
                    允许此浏览器通过 CMA 查看、创建和使用此账号有权限的 Agent，并发送我填写的任务。
                  </label>
                  <button disabled={!consentChecked || busy} onClick={() => void enable(true)}>
                    同意并启用
                  </button>
                </div>
              )}
              <div
                className="workspace__conversation"
                role="log"
                aria-label="聊天记录"
                aria-live="polite"
                aria-relevant="additions text"
              >
                {!note.creation &&
                  conversation.length === 0 &&
                  unobserved.length === 0 &&
                  !pendingText && (
                    <div className="workspace__chat-empty">
                      <span aria-hidden="true">✳</span>
                      <h2>
                        {note.creation
                          ? '给新空间一个起点'
                          : note.spaceId
                            ? '你想怎样调整这个空间？'
                            : '先选一个空间'}
                      </h2>
                      <p>
                        {note.creation
                          ? '放入扫描链接或模型，也可以告诉 CMA 你希望保留的布局和风格。'
                          : '可以说“把入口改得明亮一点”，再继续说“暖色一些”。worker 会沿用当前草稿，给你新的预览。'}
                      </p>
                      {note.spaceId && ready && !note.creation && (
                        <div className="workspace__suggestions">
                          {[
                            '介绍一下这个空间',
                            '把入口改得明亮一点，先给我预览',
                            '保留现有布局，增加一个交流区',
                          ].map((text) => (
                            <button
                              className="workspace__secondary"
                              key={text}
                              disabled={disabled}
                              onClick={() => change('instruction', text)}
                            >
                              {text}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                {conversation.map((m) => (
                  <article
                    key={m.key}
                    className={`workspace__message workspace__message--${m.role}`}
                  >
                    <strong>{m.role === 'assistant' ? 'CMA worker' : '你'}</strong>
                    <p>{m.text}</p>
                  </article>
                ))}
                {unobserved.map((m) => (
                  <article key={m.key} className="workspace__message workspace__message--user">
                    <strong>你</strong>
                    <p>{m.text}</p>
                  </article>
                ))}
                {pendingText && (
                  <article className="workspace__message workspace__message--user">
                    <strong>你 · {busy ? '正在发送' : '等待确认'}</strong>
                    <p>{pendingText}</p>
                  </article>
                )}
                {extraTexts.map((text, i) => (
                  <article
                    key={`live-${i}`}
                    className="workspace__message workspace__message--assistant"
                  >
                    <strong>CMA worker</strong>
                    <p>{text}</p>
                  </article>
                ))}
                {awaiting && (
                  <div className="workspace__activity" role="status">
                    <span className="workspace__pulse" />
                    worker 正在处理，回复和预览会自动更新。
                    {activity.map((a) => (
                      <p key={a.id}>
                        {a.name} · {statusText(a.status ?? 'in_progress')}
                      </p>
                    ))}
                  </div>
                )}
                <div ref={chatEnd} />
              </div>
              {note.pending && !busy && (
                <section className="workspace__recovery">
                  <h2>保留了一次待确认请求</h2>
                  <p>
                    {note.pending.setupRequired
                      ? '请用相同账号登录 CMA，完成运行环境授权后回到这里重新提交。'
                      : '发送结果尚未确认。重试会使用相同内容和原请求编号。'}
                  </p>
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
                  <details>
                    <summary>已在 CMA 核对结果</summary>
                    <label>
                      <input
                        type="checkbox"
                        checked={confirmForget}
                        onChange={(e) => setConfirmForget(e.target.checked)}
                      />
                      我已在 CMA 核对结果，可以清除此恢复记录
                    </label>
                    <button
                      className="workspace__secondary"
                      disabled={busy || !confirmForget}
                      onClick={() => {
                        commit({ ...note, pending: undefined });
                        setConfirmForget(false);
                      }}
                    >
                      清除恢复记录
                    </button>
                  </details>
                </section>
              )}
              {note.operationId && (
                <StartupProgress
                  operation={operation}
                  operationId={note.operationId}
                  cmaUrl={cmaBase}
                  busy={disabled}
                  onRefresh={() => {
                    setError('');
                    setNotice('');
                    setPoll((v) => v + 1);
                  }}
                  onResume={note.startup ? () => void runIntent(note.startup!) : undefined}
                  onRestart={
                    note.startup && !operation?.agent_id
                      ? () => {
                          autoUpload.current = Boolean(
                            note.creation?.source?.kind === 'file' && sourceFile,
                          );
                          void runIntent(
                            {
                              ...note.startup!,
                              body: { ...note.startup!.body, idempotencyKey: crypto.randomUUID() },
                            },
                            { ...note, operationId: undefined },
                          );
                        }
                      : undefined
                  }
                />
              )}
              {preview.startsWith('/preview') && note.agentId && (
                <section className="workspace__publish">
                  <h2>验收这次草稿</h2>
                  {previewError && <p role="alert">{previewError}</p>}
                  {checkedPreview && (
                    <p>
                      草稿 <code>{checkedPreview.preview.draftId}</code> · 修订{' '}
                      {checkedPreview.preview.rev}
                    </p>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmPublish === preview}
                      onChange={(e) => setConfirmPublish(e.target.checked ? preview : '')}
                    />
                    我已查看预览，要求 worker 发布对应草稿
                  </label>
                  <button
                    disabled={confirmPublish !== preview || disabled || !checkedPreview}
                    onClick={() =>
                      void runIntent({
                        action: 'message',
                        body: {
                          agentId: note.agentId,
                          context: {
                            chat: true,
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
              <details className="workspace__chat-options">
                <summary>会话与 worker</summary>
                <div className="workspace__actions">
                  <button
                    className="workspace__secondary"
                    disabled={busy}
                    onClick={() => {
                      setError('');
                      setPoll((v) => v + 1);
                    }}
                  >
                    刷新进度
                  </button>
                  <a href={cmaLink} target="_blank" rel="noopener noreferrer">
                    完整进度与审批 ↗
                  </a>
                </div>
                {note.agentId && (
                  <p>
                    worker <code>{note.agentId}</code>
                  </p>
                )}
                {note.operationId && (
                  <p>
                    准备任务 <code>{note.operationId}</code>
                  </p>
                )}
                <p>关闭页面不会停止云端任务；当前标签页保留每个空间的聊天恢复记录。</p>
                {ready && !note.creation && (
                  <>
                    <button
                      className="workspace__secondary"
                      disabled={disabled}
                      onClick={() => void list()}
                    >
                      读取我的 CMA workers
                    </button>
                    {agents && (
                      <ul className="workspace__agents">
                        {agents.map((a) => (
                          <li key={a.id}>
                            <button
                              disabled={disabled}
                              className="workspace__secondary"
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
                          sent: [],
                        });
                        setAgent(null);
                        setTranscript(null);
                        setOperation(null);
                        setControls(null);
                        setOutput([]);
                        setResponseStatus('');
                      }}
                    >
                      换一个 worker 开始新对话
                    </button>
                    <button
                      className="workspace__secondary"
                      disabled={busy}
                      onClick={() => void enable(false)}
                    >
                      关闭网页 CMA 调用
                    </button>
                    <p>关闭授权后，已受理任务仍在运行；已有 worker 的权限仍由 CMA 管理。</p>
                  </>
                )}
              </details>
            </div>
            <form onSubmit={submit} className="workspace__composer">
              <label>
                <span className="workspace__sr-only">给空间发消息</span>
                <textarea
                  required={!creating}
                  rows={2}
                  maxLength={16000}
                  value={note.instruction}
                  disabled={!ready || !note.spaceId || disabled || importing}
                  onChange={(e) => change('instruction', e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (canSend) e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    creating
                      ? '粘贴 Scaniverse 分享链接，或上传模型后说说你的想法…'
                      : note.spaceId
                        ? '描述你想要的变化…'
                        : '先选择一个空间'
                  }
                />
              </label>
              <div className="workspace__actions">
                <small>Enter 发送 · Shift + Enter 换行</small>
                {controls?.target_active && controls.target && (
                  <button
                    type="button"
                    className="workspace__secondary"
                    disabled={disabled}
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
                    停止响应
                  </button>
                )}
                <button type="submit" disabled={!canSend}>
                  {creating ? '开始创建' : '发送'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
