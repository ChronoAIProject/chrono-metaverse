import { useContext, useLayoutEffect, useRef, useState } from 'react';
import { z } from '@chronoai/nyx-assistant-sdk';
import { NyxAssistantElement } from '@chronoai/nyx-assistant-sdk/widget';
import { resultLinks, type Session, type SpaceSummary } from './client';
import { clearBrowserKey, readBrowserKey } from '../auth/browserKey';
import { readNyxagentNote } from './nyxagent';
import { validViewerActions, type ViewerCommand, type ViewerContext } from './viewerActions';
import { registerViewerTools, ViewerToolsContext } from './viewerTools';

const instructions =
  '你是当前工作台的空间助手。页面操作使用已登记的查看器工具。编辑时只使用 NyxID 已授权的 chrono-metaverse 服务，先读取 get_agent_guide（或 GET /api/agent-guide）和目标空间最新状态。空间编号与归属只是上下文。修改先生成草稿及本站预览链接，只有用户明确确认具体预览后才能发布；遇到冲突停止，不覆盖。不得索取密钥。';
const actionDescription =
  '更新查看器。actions 最多 8 项，空间/组合切换须在首项。每项形如 {type:"space",spaceId}、{type:"universe",universeId}、{type:"current"}、{type:"preview",url}、{type:"mode",value:"raw|optimized|extended"}、{type:"style",value:"shapes|blocks"}、{type:"look",styleId,spaceId?}、{type:"cutaway",height:数字或null} 或 {type:"camera",kind:"overview|focus|orbit|zoom",...}。focus 指定 entityId，可选 spaceId；orbit 指定 yaw、pitch；zoom 指定 factor。';
const relay =
  window.location.hostname === 'chrono-metaverse-prod-chronoai.apps.nyxid.ai'
    ? 'https://nyx-assistant-sdk-chronoai.apps.nyxid.ai'
    : 'https://nyx-assistant-sdk-staging-chronoai.apps.nyxid.ai';
if (!customElements.get('nyx-assistant'))
  customElements.define('nyx-assistant', NyxAssistantElement);

type PanelProps = {
  session: Session;
  space?: SpaceSummary;
  onBusy: (busy: boolean) => void;
  onRestore: () => void;
  viewerContext: ViewerContext;
  onViewerCommand: (command: ViewerCommand) => boolean;
  viewerFeedback: { error?: string; notice?: string };
  onPreview: (link: string) => void;
};
export function NyxAgentPanel(props: PanelProps) {
  const { session, space, viewerFeedback } = props;
  const viewer = useContext(ViewerToolsContext);
  const mount = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<NyxAssistantElement | null>(null);
  const latest = useRef(props);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [legacy] = useState(() =>
    space && session.subject
      ? readNyxagentNote(
          session.subject,
          space.id,
          space.owner.kind === 'org' ? space.owner.id : undefined,
        )
      : undefined,
  );
  useLayoutEffect(() => {
    latest.current = props;
  });
  const subject = session.subject;
  const spaceId = space?.id;
  useLayoutEffect(() => {
    if (!subject || !spaceId || !mount.current) return;
    const widget = document.createElement('nyx-assistant') as NyxAssistantElement;
    widgetRef.current = widget;
    widget.setAttribute('layout', 'embedded');
    Object.assign(widget.dataset, {
      nyxid: relay,
      verificationOrigin: 'https://nyxid.ai',
      storage: 'local',
      ownerId: subject,
      session: spaceId,
      services: 'llm-nyx,chrono-llm-public,chrono-metaverse',
      catalogServices: 'llm-nyx,chrono-llm-public',
    });
    widget.previousGrant = () => {
      const saved = readBrowserKey(subject, subject, 'nyxagent');
      if (!saved) return;
      return {
        credential: saved.credential,
        forget() {
          if (readBrowserKey(subject, subject, 'nyxagent')?.credential === saved.credential)
            clearBrowserKey(subject, subject, 'nyxagent');
        },
      };
    };
    widget.instructions = instructions;
    widget.context = () => {
      const { space, viewerContext } = latest.current;
      return {
        spaceId,
        orgId: space?.owner.kind === 'org' ? space.owner.id : null,
        spaces: viewerContext.spaces,
        preview: viewerContext.preview ?? null,
      };
    };
    for (const text of [
      '看看这个空间里有什么',
      '聚焦当前选中物件',
      '在入口添加欢迎牌，先给我预览',
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.slot = 'prompt';
      button.textContent = text;
      widget.append(button);
    }
    let navigation: ViewerCommand | undefined;
    let viewChosen = false;
    let running = false;
    let unbind: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    function releaseTools() {
      unsubscribe?.();
      unbind?.();
    }
    widget.addEventListener('nyx-ready', () => {
      releaseTools();
      const host = widget.host!;
      unsubscribe = viewer?.subscribe(() => {
        unbind?.();
        unbind = viewer.current ? registerViewerTools(host, viewer, viewer.current) : undefined;
      });
      host.registerTool({
        name: 'set_view',
        description: actionDescription,
        parameters: z.object({ actions: z.array(z.record(z.string(), z.unknown())).min(1).max(8) }),
        execute({ actions }) {
          if (!validViewerActions(actions))
            return { ok: false, code: 'invalid_action', message: '页面操作或参数无效。' };
          const command = { id: crypto.randomUUID(), actions };
          const first = actions[0];
          if (first?.type === 'space' || first?.type === 'universe') {
            if (
              first.type === 'space' &&
              !latest.current.viewerContext.spaces.some((s) => s.id === first.spaceId)
            ) {
              return {
                ok: false,
                code: 'space_unavailable',
                message: '无法打开该空间，请先在空间列表中核对访问权限。',
              };
            }
            // 切换路由会卸载原会话，等工具结果送达并收到最终答复后再导航。
            navigation = command;
            return { ok: true, value: { navigateAfterReply: true } };
          }
          viewChosen ||= actions.some(
            (action) => action.type === 'current' || action.type === 'preview',
          );
          const accepted = latest.current.onViewerCommand(command);
          return accepted
            ? { ok: true, value: { accepted: true } }
            : { ok: false, code: 'view_unavailable', message: '当前工作台无法执行该操作。' };
        },
      });
    });
    widget.addEventListener('nyx-state', () => {
      if (widget.busy && !running && !widget.host?.pendingRequestId) {
        navigation = undefined;
        viewChosen = false;
      }
      running = widget.busy;
      latest.current.onBusy(widget.busy);
      setBusy(widget.busy);
      if (!widget.host) {
        releaseTools();
        setDraft('');
        setConfirm(false);
      }
    });
    widget.addEventListener('nyx-recovery', () => latest.current.onRestore());
    widget.addEventListener('nyx-answer', (event) => {
      const content = (event as CustomEvent<string>).detail;
      const links = resultLinks({
        turns: [
          {
            turn_sequence: 0,
            owner_message: '',
            outcome: null,
            messages: [{ sequence: 0, role: 'assistant', content }],
          },
        ],
      });
      const link = links.find((url) => url.startsWith('/preview#')) ?? '';
      setDraft(link);
      setConfirm(false);
      if (navigation) {
        latest.current.onViewerCommand(navigation);
        navigation = undefined;
      } else if (link && !viewChosen) latest.current.onPreview(link);
    });
    mount.current.append(widget);
    return () => {
      releaseTools();
      widget.remove();
      widgetRef.current = null;
    };
  }, [subject, spaceId, viewer]);

  return (
    <>
      {viewerFeedback.error && (
        <p role="alert" className="workspace__notice">
          {viewerFeedback.error}
        </p>
      )}
      {viewerFeedback.notice && (
        <p role="status" className="workspace__notice">
          {viewerFeedback.notice}
        </p>
      )}
      {!space && <p className="workspace__notice">先选择已有空间。</p>}
      {legacy && (legacy.messages.length > 0 || legacy.pending || legacy.recoveryRequired) && (
        <details className="workspace__legacy">
          <summary>查看迁移前的对话</summary>
          {legacy.messages.map((m, i) => (
            <p key={i}>
              {m.role === 'user' ? '你' : 'NyxBot'} · {m.text}
            </p>
          ))}
          {(legacy.pending || legacy.recoveryRequired) && (
            <p>
              旧请求有待核对，请查看空间的草稿、预览或已发布版本。原请求编号{' '}
              {legacy.pending?.responseId ?? legacy.pending?.body.idempotencyKey}
            </p>
          )}
        </details>
      )}
      <div ref={mount} className="workspace__nyx" />
      {draft && (
        <section aria-label="草稿预览操作" className="workspace__preview-action">
          <button onClick={() => props.onPreview(draft)}>查看草稿预览</button>
          {confirm ? (
            <>
              <p>发布后，其他人将看到这份预览中的修改。</p>
              <button
                disabled={busy}
                onClick={() => {
                  setConfirm(false);
                  void widgetRef.current?.sendMessage('我已查看并确认发布这个草稿预览：' + draft);
                }}
              >
                确认发布此预览
              </button>
              <button onClick={() => setConfirm(false)}>暂不发布</button>
            </>
          ) : (
            <button disabled={busy} onClick={() => setConfirm(true)}>
              发布这个草稿…
            </button>
          )}
        </section>
      )}
    </>
  );
}
