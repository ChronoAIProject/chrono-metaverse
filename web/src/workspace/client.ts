export type Session = {
  enabled: boolean;
  connected: boolean;
  subject?: string;
  csrfToken?: string;
  workerAvailable?: boolean;
  workerUrl?: string | null;
  workerEnabled?: boolean;
};
export type Context = { spaceId: string; orgId?: string };
export type Intent = {
  action: 'create' | 'message' | 'cancel';
  body: Record<string, unknown> & { idempotencyKey: string };
  setupRequired?: boolean;
};
export type Notebook = {
  spaceId: string;
  orgId: string;
  instruction: string;
  agentId?: string;
  operationId?: string;
  responseId?: string;
  pending?: Intent;
};
export type Agent = { id: string; title?: string; owner_title?: string; status: string };
export type Operation = {
  id: string;
  agent_id?: string | null;
  status: string;
  phase: string;
  error?: string | null;
  events?: { phase?: string; detail?: string }[];
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
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken ?? '' },
      body: JSON.stringify(body),
    });
    const result: unknown = await r.json();
    if (!r.ok) {
      const problem = result as { code?: string; detail?: string };
      throw new WorkerError(
        problem.code ?? 'cma_error',
        problem.detail ?? '请求未完成，请核对 CMA 状态。',
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
export const emptyNotebook = (): Notebook => ({ spaceId: '', orgId: '', instruction: '' });
export function readNotebook(subject: string): Notebook {
  try {
    const raw = sessionStorage.getItem(`metaverse-worker:${subject}`);
    if (!raw || raw.length > 200_000) return emptyNotebook();
    const v = JSON.parse(raw) as Notebook;
    if (
      typeof v.spaceId !== 'string' ||
      typeof v.orgId !== 'string' ||
      typeof v.instruction !== 'string' ||
      [v.agentId, v.operationId, v.responseId].some((n) => n !== undefined && !id(n)) ||
      (v.pending !== undefined &&
        (!['create', 'message', 'cancel'].includes(v.pending.action) ||
          typeof v.pending.body !== 'object' ||
          v.pending.body === null ||
          !id(v.pending.body.idempotencyKey)))
    )
      return emptyNotebook();
    return v;
  } catch {
    return emptyNotebook();
  }
}
export function saveNotebook(subject: string, value: Notebook) {
  sessionStorage.setItem(`metaverse-worker:${subject}`, JSON.stringify(value));
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
