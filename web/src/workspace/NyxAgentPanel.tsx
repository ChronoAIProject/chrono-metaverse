import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AgentKeyConnection } from '../auth/AgentKeyConnection';
import {
  outputMessages,
  resultLinks,
  WorkerError,
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
  onRestore,
}: {
  readonly session: Session;
  readonly space?: SpaceSummary;
  readonly request: typeof fetch;
  readonly onPreview: (link: string) => void;
  readonly onBusy: (busy: boolean) => void;
  readonly onRestore?: () => void;
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
  const [confirmPublish, setConfirmPublish] = useState('');
  const [connectionCheck, setConnectionCheck] = useState(0);
  const active = useRef<AbortController | null>(null);
  const autoRecovery = useRef(false);
  const mounted = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    if (current.current.pending || current.current.recoveryRequired) onRestore?.();
    return () => {
      mounted.current = false;
      active.current?.abort();
      onBusy(false);
    };
  }, [onBusy, onRestore]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [text, note.messages]);
  const connection = useCallback((ready: boolean, version?: string) => {
    setCredentialVersion(ready && validCredentialVersion(version) ? version : '');
    if (!ready) active.current?.abort();
  }, []);
  const commit = useCallback(
    (value: NyxagentNote) => {
      if (!space) return;
      const saved = saveNyxagentNote(session.subject!, space.id, value);
      current.current = saved;
      setNote(saved);
    },
    [space, session.subject],
  );
  const finished = useCallback(
    (response: NyxagentResponse) => {
      const answer = outputMessages(response.output).join('\n');
      const saved = current.current;
      commit({
        ...saved,
        conversationId: response.conversation.id,
        recoveryRequired: response.status === 'failed',
        pending: undefined,
        messages: [
          ...saved.messages,
          {
            role: 'assistant',
            text:
              answer ||
              (response.status === 'failed'
                ? '本轮未完成，请核对已执行的操作后开始新的 NyxAgent 对话。'
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
        setError('NyxAgent 本轮执行失败，请核对已完成的操作后开始新的 NyxAgent 对话。');
    },
    [commit, onPreview],
  );
  async function run(pending: NyxagentPending) {
    if (!space || active.current || !credentialVersion || current.current.recoveryRequired) return;
    if (credentialVersion !== pending.credentialVersion) {
      setError('凭据已变化。请切回原 NyxAgent 授权后恢复请求。');
      return;
    }
    const controller = new AbortController();
    autoRecovery.current = true;
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
        if (failure instanceof WorkerError && failure.code === 'nyxagent_recovery_required')
          commit({ ...current.current, recoveryRequired: true });
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
    sendInstruction(note.instruction);
  }
  function sendInstruction(instruction: string, displayed = instruction) {
    if (
      !space ||
      busy ||
      note.pending ||
      note.recoveryRequired ||
      !credentialVersion ||
      !instruction.trim()
    )
      return;
    const body = {
      spaceId: space.id,
      ...(orgId ? { orgId } : {}),
      instruction,
      idempotencyKey: crypto.randomUUID(),
      instructionsVersion: 3 as const,
      ...(note.conversationId ? { conversationId: note.conversationId } : {}),
    };
    try {
      commit({
        ...note,
        instruction: '',
        messages: [...note.messages, { role: 'user', text: displayed }],
        pending: { body, credentialVersion },
      });
      void run({ body, credentialVersion });
      setConfirmPublish('');
    } catch {
      setError('无法保存原请求，请检查浏览器存储后重试。');
    }
  }
  function fillInstruction(instruction: string) {
    try {
      commit({ ...note, instruction });
      composer.current?.focus();
    } catch {
      setError('无法保存需求，请检查浏览器存储。');
    }
  }
  const readResult = useCallback(async () => {
    const pending = note.pending;
    if (!pending?.responseId || active.current || credentialVersion !== pending.credentialVersion)
      return;
    setBusy(true);
    onBusy(true);
    setError('');
    const controller = new AbortController();
    active.current = controller;
    try {
      while (!controller.signal.aborted) {
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
        if (response.status !== 'in_progress') {
          finished(response);
          break;
        }
        setActivity('NyxAgent 仍在执行，正在等待原请求结果…');
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', stop);
            resolve();
          }, 1000);
          controller.signal.addEventListener('abort', stop, { once: true });
        });
      }
    } catch (failure) {
      if (mounted.current) {
        setActivity('结果尚未确认');
        setError(
          controller.signal.aborted
            ? '已停止等待，原请求仍可能在执行。可再次核对结果。'
            : failure instanceof Error
              ? failure.message
              : '无法确认结果，请保留原请求。',
        );
      }
    } finally {
      active.current = null;
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }, [note.pending, note.conversationId, credentialVersion, session, request, finished, onBusy]);
  useEffect(() => {
    if (
      !autoRecovery.current &&
      !active.current &&
      !note.recoveryRequired &&
      note.pending?.responseId &&
      credentialVersion === note.pending.credentialVersion
    ) {
      autoRecovery.current = true;
      void readResult();
    }
  }, [credentialVersion, note.pending, note.recoveryRequired, readResult]);
  const previewLinks = resultLinks({
    turns: [
      {
        turn_sequence: 0,
        owner_message: '',
        outcome: null,
        messages: note.messages
          .filter((message) => message.role === 'assistant')
          .slice(-1)
          .map((message) => ({ sequence: 0, role: 'assistant', content: message.text })),
      },
    ],
  });
  const draftLink = previewLinks.find((link) => link.startsWith('/preview#'));
  return (
    <>
      <div className="workspace__chat-scroll">
        <AgentKeyConnection
          compact
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
              <h2>想怎样调整这个空间？</h2>
              <p>先生成草稿预览，满意后再确认发布。</p>
              {space && (
                <div className="workspace__suggestions" aria-label="任务示例">
                  {[
                    '看看这个空间里有什么',
                    '调整一个物件的位置，先给我预览',
                    '在入口添加欢迎牌，先给我预览',
                  ].map((suggestion) => (
                    <button
                      className="workspace__secondary"
                      key={suggestion}
                      disabled={busy || !!note.pending || note.recoveryRequired}
                      onClick={() => fillInstruction(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
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
          {busy && (
            <p className="workspace__activity" role="status">
              {activity || '正在查询进度…'}
            </p>
          )}
          <div ref={end} />
        </div>
        {error && !note.pending && (
          <p className="workspace__notice workspace__notice--error" role="alert">
            {error}
          </p>
        )}
        {note.pending && !busy && (
          <section className="workspace__recovery">
            <h2>{note.recoveryRequired ? '需要核对已执行的操作' : '连接中断，进度已保存'}</h2>
            <p>
              {note.recoveryRequired
                ? '原会话已中断，无法再次执行。请核对空间中的草稿、预览和已发布版本，再开始新对话。'
                : '可以继续查看这次任务的进度。请先确认结果，再发送新任务。'}
            </p>
            {credentialVersion && credentialVersion !== note.pending.credentialVersion && (
              <p>当前凭据已变化，请切回原 NyxAgent 授权后恢复请求。</p>
            )}
            {note.pending.responseId ? (
              <button
                disabled={
                  !credentialVersion || credentialVersion !== note.pending.credentialVersion
                }
                onClick={() => void readResult()}
              >
                查看任务进度
              </button>
            ) : (
              !note.recoveryRequired && (
                <button
                  disabled={
                    !credentialVersion || credentialVersion !== note.pending.credentialVersion
                  }
                  onClick={() =>
                    void (note.pending!.responseId ? readResult() : run(note.pending!))
                  }
                >
                  继续这次任务
                </button>
              )
            )}
            <details>
              <summary>诊断详情</summary>
              {error && <p>{error}</p>}
              <code>{note.pending.body.idempotencyKey}</code>
            </details>
          </section>
        )}
        {draftLink && !note.pending && !note.recoveryRequired && (
          <section className="workspace__preview-action" aria-label="草稿预览操作">
            <p>先查看效果，再决定是否发布。</p>
            <button onClick={() => onPreview(draftLink)}>查看草稿预览</button>
            {confirmPublish === draftLink ? (
              <>
                <p>发布后，其他人将看到这份预览中的修改。</p>
                <button
                  disabled={busy || !credentialVersion}
                  onClick={() =>
                    sendInstruction(
                      `我已查看并确认发布这个草稿预览：${draftLink}`,
                      '确认发布此预览',
                    )
                  }
                >
                  确认发布此预览
                </button>
                <button className="workspace__secondary" onClick={() => setConfirmPublish('')}>
                  暂不发布
                </button>
              </>
            ) : (
              <button
                className="workspace__secondary"
                disabled={busy}
                onClick={() => setConfirmPublish(draftLink)}
              >
                发布这个草稿…
              </button>
            )}
          </section>
        )}
        {(note.conversationId || note.pending || note.recoveryRequired) && (
          <details className="workspace__chat-options" open={note.recoveryRequired || undefined}>
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
            ref={composer}
            rows={2}
            maxLength={16000}
            value={note.instruction}
            disabled={!space || busy || !!note.pending || note.recoveryRequired}
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
          <small>
            {busy ? '停止等待后，任务仍会在后台执行' : 'Enter 发送 · Shift + Enter 换行'}
          </small>
          {busy ? (
            <button
              type="button"
              className="workspace__secondary"
              onClick={() => active.current?.abort()}
            >
              停止等待
            </button>
          ) : (
            <button
              disabled={
                !space ||
                !credentialVersion ||
                !!note.pending ||
                note.recoveryRequired ||
                !note.instruction.trim()
              }
            >
              发送给 NyxAgent
            </button>
          )}
        </div>
      </form>
    </>
  );
}
