import { cmaAuthHeaders, type CmaAuthMethod } from '../auth/cmaConnection';

export type Session = {
  enabled: boolean;
  connected: boolean;
  subject?: string;
  csrfToken?: string;
  workerAvailable?: boolean;
  workerUrl?: string | null;
  workerEnabled?: boolean;
  cmaOwnerId?: string;
  cmaAuthMethod?: CmaAuthMethod;
  cmaCredentialVersion?: string;
};
export type Context = { spaceId: string; orgId?: string };
export type Intent = {
  action: 'create' | 'message' | 'cancel' | 'attachment';
  credentialVersion?: string;
  body: Record<string, unknown> & { idempotencyKey: string };
  setupRequired?: boolean;
  lastError?: { code: string; message: string; status?: number };
};
export type Notebook = {
  spaceId: string;
  orgId: string;
  instruction: string;
  agentId?: string;
  operationId?: string;
  responseId?: string;
  pending?: Intent;
  startup?: Intent;
  sent?: { key: string; text: string }[];
  creation?: CreationDraft;
};
export type Attachment = {
  id: string;
  agent_id: string;
  name: string;
  path: string;
  size_bytes: number;
  media_type: string;
  sha256: string;
};
export type CreationSource =
  | { kind: 'scaniverse'; url: string }
  | { kind: 'file'; name: string; size: number; sha256: string; attachment?: Attachment };
export type CreationDraft = {
  name: string;
  phase: 'draft' | 'preparing' | 'uploaded' | 'submitted';
  source?: CreationSource;
  instruction?: string;
};
export type Agent = { id: string; title?: string; owner_title?: string; status: string };
export type Operation = {
  id: string;
  agent_id?: string | null;
  status: string;
  phase: string;
  error?: string | null;
  events?: {
    sequence?: number;
    phase: string;
    status: string;
    message: string;
    occurred_at?: string;
  }[];
  connection?: { services: string[]; target: unknown };
};
export type Transcript = {
  turns: {
    turn_sequence: number;
    owner_message: string;
    outcome: unknown;
    messages: { sequence: number; role: 'user' | 'assistant'; content: string }[];
  }[];
};
export type Controls = {
  target_active: boolean;
  agent_revision: number;
  target?: { turn_sequence: number } | null;
};
export class WorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export async function workerRequest<T>(
  session: Session,
  action: string,
  body: unknown,
  signal?: AbortSignal,
  request = fetch,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 30_000);
  try {
    const r = await request(`/api/auth/nyxid/worker/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': session.csrfToken ?? '',
        ...cmaAuthHeaders(session),
      },
      body: JSON.stringify(body),
    });
    const result: unknown = await r.json();
    if (!r.ok) {
      const problem = result as { code?: string; detail?: string };
      throw new WorkerError(
        problem.code ?? 'cma_error',
        problem.detail ?? '请求未完成，请核对 CMA 状态。',
        r.status,
      );
    }
    return result as T;
  } catch (e) {
    if (e instanceof WorkerError) throw e;
    throw new WorkerError('network', '连接中断，结果尚未确认。请核对进度，或重试原请求。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
export const validCredentialVersion = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
export const emptyNotebook = (): Notebook => ({ spaceId: '', orgId: '', instruction: '' });
function parseNotebook(raw: string | null, spaceId = ''): Notebook {
  const fallback = () => ({ ...emptyNotebook(), spaceId });
  try {
    if (!raw || raw.length > 200_000) return fallback();
    const v = JSON.parse(raw) as Notebook;
    if (
      typeof v.spaceId !== 'string' ||
      (spaceId && v.spaceId !== spaceId) ||
      typeof v.orgId !== 'string' ||
      typeof v.instruction !== 'string' ||
      (v.creation !== undefined &&
        (typeof v.creation.name !== 'string' ||
          !['draft', 'preparing', 'uploaded', 'submitted'].includes(v.creation.phase) ||
          (v.creation.instruction !== undefined && typeof v.creation.instruction !== 'string'))) ||
      [v.agentId, v.operationId, v.responseId].some((n) => n !== undefined && !id(n)) ||
      (v.sent !== undefined &&
        (!Array.isArray(v.sent) ||
          v.sent.length > 30 ||
          v.sent.some((m) => !id(m.key) || typeof m.text !== 'string'))) ||
      (v.pending !== undefined &&
        (!['create', 'message', 'cancel', 'attachment'].includes(v.pending.action) ||
          typeof v.pending.body !== 'object' ||
          v.pending.body === null ||
          !id(v.pending.body.idempotencyKey) ||
          (v.pending.credentialVersion !== undefined &&
            !validCredentialVersion(v.pending.credentialVersion)) ||
          (v.pending.lastError !== undefined &&
            (typeof v.pending.lastError.code !== 'string' ||
              typeof v.pending.lastError.message !== 'string' ||
              v.pending.lastError.message.length > 2048 ||
              (v.pending.lastError.status !== undefined &&
                (!Number.isInteger(v.pending.lastError.status) ||
                  v.pending.lastError.status < 100 ||
                  v.pending.lastError.status > 599)))))) ||
      (v.startup !== undefined &&
        (v.startup.action !== 'create' ||
          typeof v.startup.body !== 'object' ||
          v.startup.body === null ||
          !id(v.startup.body.idempotencyKey) ||
          (v.startup.credentialVersion !== undefined &&
            !validCredentialVersion(v.startup.credentialVersion))))
    )
      return fallback();
    return v;
  } catch {
    return fallback();
  }
}
export function readNotebook(subject: string): Notebook {
  try {
    return parseNotebook(sessionStorage.getItem(`metaverse-worker:${subject}`));
  } catch {
    return emptyNotebook();
  }
}
export function saveNotebook(subject: string, value: Notebook) {
  const text = JSON.stringify(value);
  sessionStorage.setItem(`metaverse-worker:${subject}`, text);
  if (value.spaceId)
    sessionStorage.setItem(`metaverse-worker:${subject}:space:${value.spaceId}`, text);
}
/** Only this application's viewer routes may be embedded. Never render arbitrary worker HTML. */
export function viewerLink(value: string, origin = window.location.origin): string | null {
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin || u.username || u.password || u.search) return null;
    if (u.pathname === '/preview' && /^#t=[A-Za-z0-9_-]{1,256}$/.test(u.hash))
      return u.pathname + u.hash;
    if (
      /^\/(s|u)\/[a-z0-9][a-z0-9-]{0,79}$/.test(u.pathname) &&
      (u.hash === '' || /^#share=[A-Za-z0-9_-]{1,256}$/.test(u.hash))
    )
      return u.pathname + u.hash;
    return null;
  } catch {
    return null;
  }
}
export function resultLinks(transcript: Transcript | null): string[] {
  const links = new Set<string>();
  for (const turn of transcript?.turns ?? []) {
    for (const m of turn.messages) {
      if (m.role !== 'assistant') continue;
      for (const match of m.content.matchAll(
        /https?:\/\/[^\s<>"'`\])}，。；]+|\/(?:preview#t=|[su]\/)[A-Za-z0-9_/#=-]+/g,
      )) {
        const url = viewerLink(match[0]);
        if (url) links.add(url);
      }
    }
  }
  return [...links].slice(-20).reverse();
}
export function statusText(value: string): string {
  const names: Record<string, string> = {
    pending: '等待处理',
    preparing: '准备环境',
    provisioning: '创建环境',
    running: '执行中',
    working: '执行中',
    waiting_approval: '等待审批',
    queued: '已排队',
    in_progress: '执行中',
    ready: '已就绪',
    idle: '等待新需求',
    busy: '执行中',
    completed: '已完成',
    succeeded: '环境已准备',
    failed: '执行失败',
    stopped: '已停止',
    cancelled: '已取消',
    paused: '已暂停',
    waiting: '等待授权或审批',
    waiting_for_connection: '等待服务授权',
    awaiting_approval: '等待审批',
    starting: '启动中',
    deleted: '已删除',
  };
  return Object.hasOwn(names, value) ? names[value]! : value;
}

export type SpaceSummary = {
  id: string;
  name: string;
  description: string;
  owner: { kind: 'person' | 'org'; id: string };
  visibility: string;
  updatedAt: string;
  access: 'read' | 'manage';
};
export type Catalog = {
  items: SpaceSummary[];
  next: string | null;
  organizations: { id: string; name: string; role: string }[];
};
export type ResponseOutput = {
  id: string;
  type: string;
  role?: string;
  name?: string;
  status?: string;
  content?: { type: string; text?: string }[];
};
export function outputMessages(output: ResponseOutput[]): string[] {
  return output
    .filter((o) => o.type === 'message' && o.role === 'assistant')
    .map((o) =>
      (o.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join(''),
    )
    .filter(Boolean);
}
export function userText(text: string): string {
  return text.startsWith('metaverse 任务上下文（编号只选择目标，不授予权限）：')
    ? text.slice(text.indexOf('\n用户需求：\n') + '\n用户需求：\n'.length)
    : text;
}
export async function readCatalog(
  session: Session,
  after?: string,
  signal?: AbortSignal,
  request = fetch,
): Promise<Catalog> {
  const r = await request('/api/auth/nyxid/spaces', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken ?? '' },
    body: JSON.stringify(after ? { after } : {}),
  });
  if (!r.ok) {
    const v = (await r.json()) as { code?: string; detail?: string };
    throw new WorkerError(v.code ?? 'catalog_error', v.detail ?? '暂时无法读取空间列表。');
  }
  return (await r.json()) as Catalog;
}
export function readSpaceNotebook(subject: string, spaceId: string): Notebook {
  const key = `metaverse-worker:${subject}:space:${spaceId}`;
  const raw = sessionStorage.getItem(key);
  if (!raw) return { ...emptyNotebook(), spaceId };
  // Reuse the same schema checks, without replacing the active notebook in storage.
  return parseNotebook(raw, spaceId);
}

export function recordSent(
  note: Notebook,
  key: string,
  text: string,
): NonNullable<Notebook['sent']> {
  const sent = [...(note.sent ?? []), { key, text }].slice(-30);
  let size = sent.reduce((total, m) => total + m.text.length, 0);
  while (size > 64000 && sent.length > 1) size -= sent.shift()!.text.length;
  return sent;
}
