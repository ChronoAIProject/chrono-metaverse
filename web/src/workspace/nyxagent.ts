import { cmaAuthHeaders } from '../auth/cmaConnection';
import {
  outputMessages,
  validCredentialVersion,
  WorkerError,
  type Session,
  type ResponseOutput,
} from './client';
import type { ViewerContext } from './viewerActions';

export type NyxagentTask = {
  spaceId: string;
  orgId?: string;
  instruction: string;
  idempotencyKey: string;
  conversationId?: string;
  instructionsVersion?: 1 | 2 | 3 | 4;
  viewerContext?: ViewerContext;
};
export type NyxagentResponse = {
  id: string;
  conversation: { id: string };
  status: 'completed' | 'failed' | 'in_progress';
  output: ResponseOutput[];
  error?: { code?: string };
};
export type NyxagentPending = {
  body: NyxagentTask;
  credentialVersion: string;
  responseId?: string;
};
export type NyxagentNote = {
  conversationId?: string;
  recoveryRequired?: boolean;
  instruction: string;
  messages: { role: 'user' | 'assistant'; text: string }[];
  pending?: NyxagentPending;
};
const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const noteKey = (subject: string, spaceId: string) =>
  `metaverse-nyxagent-chat:v1:${encodeURIComponent(subject)}:${encodeURIComponent(spaceId)}`;
export const emptyNyxagentNote = (): NyxagentNote => ({ instruction: '', messages: [] });

export function readNyxagentNote(subject: string, spaceId: string, orgId?: string): NyxagentNote {
  try {
    const raw = sessionStorage.getItem(noteKey(subject, spaceId));
    if (!raw || raw.length > 200_000) return emptyNyxagentNote();
    const note = JSON.parse(raw) as NyxagentNote;
    if (
      typeof note.instruction !== 'string' ||
      note.instruction.length > 16000 ||
      (note.conversationId !== undefined && !identifier(note.conversationId)) ||
      (note.recoveryRequired !== undefined && typeof note.recoveryRequired !== 'boolean') ||
      !Array.isArray(note.messages) ||
      note.messages.length > 30 ||
      note.messages.some(
        (m) => !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string',
      )
    )
      return emptyNyxagentNote();
    if (note.pending) {
      const p = note.pending;
      if (
        !validCredentialVersion(p.credentialVersion) ||
        (p.responseId !== undefined && !identifier(p.responseId)) ||
        !p.body ||
        p.body.spaceId !== spaceId ||
        p.body.orgId !== orgId ||
        typeof p.body.instruction !== 'string' ||
        p.body.instruction.length > 16000 ||
        !identifier(p.body.idempotencyKey) ||
        p.body.idempotencyKey.length < 16 ||
        (p.body.instructionsVersion !== undefined &&
          p.body.instructionsVersion !== 1 &&
          p.body.instructionsVersion !== 2 &&
          p.body.instructionsVersion !== 3 &&
          p.body.instructionsVersion !== 4) ||
        (p.body.viewerContext !== undefined &&
          JSON.stringify(p.body.viewerContext).length > 16000) ||
        (p.body.conversationId !== undefined && !identifier(p.body.conversationId))
      )
        return emptyNyxagentNote();
    }
    return note;
  } catch {
    return emptyNyxagentNote();
  }
}
export function saveNyxagentNote(subject: string, spaceId: string, note: NyxagentNote) {
  const messages = note.messages.slice(-30).map((m) => ({ ...m, text: m.text.slice(0, 64000) }));
  while (messages.length > 1 && messages.reduce((n, m) => n + m.text.length, 0) > 100000)
    messages.shift();
  const saved = { ...note, messages };
  sessionStorage.setItem(noteKey(subject, spaceId), JSON.stringify(saved));
  return saved;
}
export function parseNyxagentResponse(value: unknown): NyxagentResponse {
  const v = value as NyxagentResponse;
  if (
    !v ||
    !identifier(v.id) ||
    !identifier(v.conversation?.id) ||
    !['completed', 'failed', 'in_progress'].includes(v.status) ||
    !Array.isArray(v.output) ||
    v.output.some(
      (item) =>
        !item ||
        typeof item.type !== 'string' ||
        (item.content !== undefined &&
          (!Array.isArray(item.content) ||
            item.content.some(
              (c) =>
                !c ||
                typeof c.type !== 'string' ||
                (c.text !== undefined && typeof c.text !== 'string'),
            ))),
    )
  ) {
    throw new Error('NyxAgent 返回格式不完整，请保留原请求并核对结果。');
  }
  return v;
}
export type NyxagentUpdate = {
  responseId?: string;
  conversationId?: string;
  text: string;
  activity: string;
};

/** Consume SSE across arbitrary UTF-8 and CRLF chunk boundaries; only a terminal frame confirms a turn. */
export async function streamNyxagent(
  session: Session,
  pending: NyxagentPending,
  signal: AbortSignal,
  onUpdate: (update: NyxagentUpdate) => void,
  request = fetch,
): Promise<NyxagentResponse> {
  // Each transport attempt has its own trace ID; the saved mutation request stays unchanged.
  const requestId = crypto.randomUUID();
  const interrupted = () =>
    new WorkerError(
      'nyxagent_stream_interrupted',
      `网络连接已中断，NyxAgent 结果尚未确认。请先核对结果或恢复原请求，避免重复操作。排查编号：${requestId}`,
      0,
    );
  async function network<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (failure) {
      if (signal.aborted) throw failure;
      throw interrupted();
    }
  }
  const r = await network(() =>
    request('/api/auth/nyxid/nyxagent/message', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': session.csrfToken ?? '',
        'x-request-id': requestId,
        ...cmaAuthHeaders({ ...session, cmaCredentialVersion: pending.credentialVersion }),
      },
      body: JSON.stringify(pending.body),
    }),
  );
  if (!r.ok) {
    const problem = (await r.json().catch(() => ({}))) as { code?: string; detail?: string };
    throw new WorkerError(
      problem.code ?? 'nyxagent_error',
      problem.detail ?? 'NyxAgent 请求未完成，请保留原请求。',
      r.status,
    );
  }
  if (!r.headers.get('content-type')?.startsWith('text/event-stream') || !r.body)
    throw new Error('无法确认 NyxAgent 响应，请保留原请求。');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    data: string[] = [],
    event = '',
    total = 0;
  const update: NyxagentUpdate = {
    responseId: pending.responseId,
    conversationId: pending.body.conversationId,
    text: '',
    activity: '',
  };
  const texts = new Map<number, string>();
  function identity(response: { id?: unknown; conversation?: { id?: unknown } }) {
    if (
      !identifier(response?.id) ||
      !identifier(response?.conversation?.id) ||
      (update.responseId && update.responseId !== response.id) ||
      (update.conversationId && update.conversationId !== response.conversation.id)
    )
      throw new Error('NyxAgent 响应与原请求不一致，请保留原请求并核对结果。');
    update.responseId = response.id;
    update.conversationId = response.conversation.id;
  }
  function frame(): NyxagentResponse | undefined {
    if (!data.length) {
      event = '';
      return;
    }
    const raw = data.join('\n');
    data = [];
    if (raw === '[DONE]') {
      event = '';
      return;
    }
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw interrupted();
    }
    if (!v || typeof v !== 'object') throw interrupted();
    const kind = typeof v.type === 'string' ? v.type : event;
    event = '';
    if (kind === 'metaverse.error') throw interrupted();
    if (kind === 'response.created' || kind === 'response.in_progress') {
      const response = v.response as { id?: unknown; conversation?: { id?: unknown } };
      identity(response);
    }
    if (kind === 'response.output_text.delta' || kind === 'response.output_text.done') {
      const index = typeof v.output_index === 'number' ? v.output_index : 0;
      if (kind.endsWith('.delta') && typeof v.delta === 'string')
        texts.set(index, (texts.get(index) ?? '') + v.delta);
      if (kind.endsWith('.done') && typeof v.text === 'string') texts.set(index, v.text);
      update.text = [...texts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, text]) => text)
        .join('\n');
    }
    if (kind.startsWith('response.mcp_call.'))
      update.activity = kind.endsWith('in_progress') ? '正在调用已授权工具…' : '工具调用已返回';
    if (kind === 'response.completed' || kind === 'response.failed') {
      const response = parseNyxagentResponse(v.response);
      if (response.status !== (kind === 'response.completed' ? 'completed' : 'failed'))
        throw new Error('NyxAgent 终态尚未确认。');
      identity(response);
      update.text = outputMessages(response.output).join('\n');
      onUpdate({ ...update });
      return response;
    }
    onUpdate({ ...update });
  }
  try {
    while (true) {
      const chunk = await network(() => reader.read());
      if (chunk.done) buffer += decoder.decode();
      else {
        total += chunk.value.byteLength;
        if (total > 8 * 1024 * 1024) throw new Error('NyxAgent 响应过长，请保留原请求并核对结果。');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          const response = frame();
          if (response) return response;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      if (buffer.length > 2 * 1024 * 1024 || data.join('').length > 2 * 1024 * 1024)
        throw new Error('NyxAgent 响应格式不正确。');
      if (chunk.done) break;
    }
    throw interrupted();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
