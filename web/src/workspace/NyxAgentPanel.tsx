import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AgentKeyConnection } from '../auth/AgentKeyConnection';
import {
  outputMessages,
  resultLinks,
  validCredentialVersion,
  workerRequest,
  type Session,
  type SpaceSummary,
} from './client';
import {
  emptyNyxagentNote,
  parseNyxagentResponse,
  readNyxagentNote,
  saveNyxagentNote,
  streamNyxagent,
  type NyxagentNote,
  type NyxagentPending,
  type NyxagentResponse,
} from './nyxagent';

export function NyxAgentPanel({
  session: supplied,
  space,
  request,
  onPreview,
  onBusy,
}: {
  readonly session: Session;
  readonly space?: SpaceSummary;
  readonly request: typeof fetch;
  readonly onPreview: (link: string) => void;
  readonly onBusy: (busy: boolean) => void;
}) {
  const orgId = space?.owner.kind === 'org' ? space.owner.id : undefined;
  const session = useMemo(
    () => ({
      ...supplied,
      chatProvider: 'nyxagent' as const,
      cmaAuthMethod: 'agent_key' as const,
      cmaOwnerId: orgId ?? supplied.subject,
    }),
    [supplied, orgId],
  );
  const [note, setNote] = useState(() =>
    space ? readNyxagentNote(session.subject!, space.id, orgId) : emptyNyxagentNote(),
  );
  const current = useRef(note);
  const [credentialVersion, setCredentialVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [connectionCheck, setConnectionCheck] = useState(0);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      onBusy(false);
    };
  }, [onBusy]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [text, note.messages]);
  const connection = useCallback((ready: boolean, version?: string) => {
    setCredentialVersion(ready && validCredentialVersion(version) ? version : '');
    if (!ready) active.current?.abort();
  }, []);
  function commit(value: NyxagentNote) {
    if (!space) return;
    const saved = saveNyxagentNote(session.subject!, space.id, value);
    current.current = saved;
    setNote(saved);
  }
  function finished(response: NyxagentResponse) {
    const answer = outputMessages(response.output).join('\n');
    const saved = current.current;
    commit({
      ...saved,
      conversationId: response.conversation.id,
      pending: undefined,
      messages: [
        ...saved.messages,
        {
          role: 'assistant',
          text:
            answer ||
            (response.status === 'failed'
              ? '本轮未完成，请核对已执行的操作后再继续。'
              : '本轮已完成。'),
        },
      ],
    });
    const links = resultLinks({
      turns: [
        {
          turn_sequence: 0,
          owner_message: '',
          outcome: null,
          messages: [{ sequence: 0, role: 'assistant', content: answer }],
        },
      ],
    });
    if (links[0]) onPreview(links[0]);
    setText('');
    setActivity('');
    if (response.status === 'failed')
      setError('NyxAgent 本轮执行失败，请核对已完成的操作后再继续。');
  }
  async function run(pending: NyxagentPending) {
    if (!space || active.current || !credentialVersion) return;
    if (credentialVersion !== pending.credentialVersion) {
      setError('凭据已变化。请切回原 NyxAgent 授权后恢复请求。');
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    onBusy(true);
    setError('');
    setText('');
    setActivity('正在连接 NyxAgent…');
    try {
      // Save the exact request before any write. Refresh never resubmits it automatically.
      commit({ ...current.current, pending });
      const response = await streamNyxagent(
        session,
        pending,
        controller.signal,
        (update) => {
          if (!mounted.current) return;
          setText(update.text);
          setActivity(update.activity);
          const p = current.current.pending;
          if (
            p &&
            (update.responseId !== p.responseId ||
              (update.conversationId && update.conversationId !== current.current.conversationId))
          )
            commit({
              ...current.current,
              ...(update.conversationId ? { conversationId: update.conversationId } : {}),
              pending: { ...p, ...(update.responseId ? { responseId: update.responseId } : {}) },
            });
        },
        request,
      );
      if (mounted.current) finished(response);
    } catch (failure) {
      if (mounted.current) {
        setError(
          controller.signal.aborted
            ? '连接已中断，操作结果尚未确认。请先核对结果，避免重复操作。'
            : failure instanceof Error
              ? failure.message
              : '结果尚未确认，请恢复原请求。',
        );
        setActivity('结果尚未确认');
        setConnectionCheck((v) => v + 1);
      }
    } finally {
      active.current = null;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!space || busy || note.pending || !credentialVersion || !note.instruction.trim()) return;
    const body = {
      spaceId: space.id,
      ...(orgId ? { orgId } : {}),
      instruction: note.instruction,
      idempotencyKey: crypto.randomUUID(),
      instructionsVersion: 2 as const,
      ...(note.conversationId ? { conversationId: note.conversationId } : {}),
    };
    try {
      commit({
        ...note,
        instruction: '',
        messages: [...note.messages, { role: 'user', text: body.instruction }],
        pending: { body, credentialVersion },
      });
      void run({ body, credentialVersion });
    } catch {
      setError('无法保存原请求，请检查浏览器存储后重试。');
    }
  }
  async function readResult() {
    const pending = note.pending;
    if (!pending?.responseId || active.current || credentialVersion !== pending.credentialVersion)
      return;
    setBusy(true);
    onBusy(true);
    setError('');
    const controller = new AbortController();
    active.current = controller;
    try {
      const value = await workerRequest<unknown>(
        { ...session, cmaCredentialVersion: pending.credentialVersion },
        'response',
        { responseId: pending.responseId },
        controller.signal,
        request,
      );
      if (!mounted.current) return;
      const response = parseNyxagentResponse(value);
      if (
        response.id !== pending.responseId ||
        (note.conversationId && response.conversation.id !== note.conversationId)
      )
        throw new Error('响应与原请求不一致。');
      if (response.status === 'in_progress') setActivity('NyxAgent 仍在执行，可稍后再次核对。');
      else finished(response);
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : '无法确认结果，请保留原请求。');
    } finally {
      active.current = null;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  return (
    <>
      <div className="workspace__chat-scroll">
        <AgentKeyConnection
          provider="nyxagent"
          session={session}
          request={request}
          onChange={connection}
          checkVersion={connectionCheck}
        />
        {!space && (
          <p className="workspace__notice">先选择已有空间。扫描和模型导入可使用 CMA 创建空间。</p>
        )}
        <div
          className="workspace__conversation"
          role="log"
          aria-label="NyxAgent 聊天记录"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {note.messages.length === 0 && (
            <div className="workspace__chat-empty">
              <h2>和 NyxAgent 调整空间</h2>
              <p>描述需求，查看草稿预览，再确认发布。对话保存在此标签页，按空间分别继续。</p>
            </div>
          )}
          {note.messages.map((message, index) => (
            <article
              key={index}
              className={`workspace__message workspace__message--${message.role}`}
            >
              <strong>{message.role === 'assistant' ? 'NyxAgent' : '你'}</strong>
              <p>{message.text}</p>
            </article>
          ))}
          {text && (
            <article className="workspace__message workspace__message--assistant">
              <strong>NyxAgent</strong>
              <p>{text}</p>
            </article>
          )}
          {activity && <p role="status">{activity}</p>}
          <div ref={end} />
        </div>
        {error && (
          <p className="workspace__notice workspace__notice--error" role="alert">
            {error}
          </p>
        )}
        {note.pending && !busy && (
          <section className="workspace__recovery">
            <h2>恢复 NyxAgent 原请求</h2>
            <p>结果尚未确认。保留同一请求编号和凭据，避免重复操作。</p>
            {credentialVersion && credentialVersion !== note.pending.credentialVersion && (
              <p>当前凭据已变化，请切回原 NyxAgent 授权后恢复请求。</p>
            )}
            <code>{note.pending.body.idempotencyKey}</code>
            {note.pending.responseId && (
              <button
                disabled={
                  !credentialVersion || credentialVersion !== note.pending.credentialVersion
                }
                onClick={() => void readResult()}
              >
                核对 NyxAgent 结果
              </button>
            )}
            <button
              disabled={!credentialVersion || credentialVersion !== note.pending.credentialVersion}
              onClick={() => void run(note.pending!)}
            >
              恢复 NyxAgent 原请求
            </button>
          </section>
        )}
        {(note.conversationId || note.pending) && (
          <details className="workspace__chat-options">
            <summary>NyxAgent 对话设置</summary>
            {confirmClear ? (
              <>
                <p>清除本地记录不会撤销已经执行的修改。请先核对原请求结果。</p>
                <button
                  disabled={busy}
                  onClick={() => {
                    try {
                      commit(emptyNyxagentNote());
                      setConfirmClear(false);
                      setError('');
                      setText('');
                      setActivity('');
                    } catch {
                      setError('无法保存新的对话记录。');
                    }
                  }}
                >
                  确认开始新的 NyxAgent 对话
                </button>
                <button onClick={() => setConfirmClear(false)}>保留当前对话</button>
              </>
            ) : (
              <button disabled={busy} onClick={() => setConfirmClear(true)}>
                开始新的 NyxAgent 对话
              </button>
            )}
          </details>
        )}
      </div>
      <form className="workspace__composer" onSubmit={submit}>
        <label>
          <span className="workspace__sr-only">给 NyxAgent 发消息</span>
          <textarea
            rows={2}
            maxLength={16000}
            value={note.instruction}
            disabled={!space || busy || !!note.pending}
            placeholder={space ? '描述你想要的变化…' : '先选择一个空间'}
            onChange={(e) => {
              try {
                commit({ ...note, instruction: e.target.value });
              } catch {
                setError('无法保存需求，请检查浏览器存储。');
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </label>
        <div className="workspace__actions">
          <small>Enter 发送 · Shift + Enter 换行</small>
          {busy ? (
            <button
              type="button"
              className="workspace__secondary"
              onClick={() => active.current?.abort()}
            >
              中断连接
            </button>
          ) : (
            <button
              disabled={!space || !credentialVersion || !!note.pending || !note.instruction.trim()}
            >
              发送给 NyxAgent
            </button>
          )}
        </div>
      </form>
    </>
  );
}
