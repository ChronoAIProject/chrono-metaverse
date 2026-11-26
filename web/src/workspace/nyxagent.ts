const validCredentialVersion = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
import type { ViewerContext } from './viewerActions';

type NyxagentTask = {
  spaceId: string;
  orgId?: string;
  instruction: string;
  idempotencyKey: string;
  conversationId?: string;
  instructionsVersion?: 1 | 2 | 3 | 4 | 5 | 6;
  viewerContext?: ViewerContext;
};
type NyxagentPending = {
  body: NyxagentTask;
  credentialVersion: string;
  responseId?: string;
};
type NyxagentNote = {
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
const emptyNyxagentNote = (): NyxagentNote => ({ instruction: '', messages: [] });

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
          p.body.instructionsVersion !== 4 &&
          p.body.instructionsVersion !== 5 &&
          p.body.instructionsVersion !== 6) ||
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
