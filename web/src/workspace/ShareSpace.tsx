import { useEffect, useId, useRef, useState } from 'react';
import { routePath } from '../routing/routes';
import { requestSpaceShare, type SpaceSummary } from './client';

type ShareState =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; url: string };

export function ShareSpace({
  space,
  csrfToken,
  request,
}: {
  readonly space: SpaceSummary;
  readonly csrfToken: string;
  readonly request: typeof fetch;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [state, setState] = useState<ShareState | null>(null);
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => () => pending.current?.abort(), []);

  async function loadLink() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setCopyStatus('');
    setState({ kind: 'loading' });
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort();
      setState({ kind: 'error', message: '获取分享链接超时，请重试。' });
    }, 15_000);
    try {
      const token =
        space.visibility === 'public' && space.access !== 'manage'
          ? null
          : await requestSpaceShare(space.id, csrfToken, controller.signal, request);
      const url = new URL(routePath({ kind: 'space', spaceId: space.id }), window.location.origin);
      if (token) url.hash = new URLSearchParams({ share: token }).toString();
      if (!controller.signal.aborted) setState({ kind: 'ready', url: url.href });
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : '暂时无法获取分享链接，请重试。',
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function copyLink(url: string) {
    const attempt = pending.current;
    try {
      await navigator.clipboard.writeText(url);
      if (dialog.current?.open && pending.current === attempt) setCopyStatus('已复制链接');
    } catch {
      if (!dialog.current?.open || pending.current !== attempt) return;
      input.current?.focus();
      input.current?.select();
      setCopyStatus('链接已选中，请手动复制。');
    }
  }

  return (
    <>
      <button
        type="button"
        className="workspace__secondary workspace__share-trigger"
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          void loadLink();
        }}
      >
        分享空间
      </button>
      <dialog
        ref={dialog}
        className="workspace__share-dialog"
        aria-labelledby={titleId}
        onClose={() => {
          if (dialog.current?.open) return;
          pending.current?.abort();
          setState(null);
          setCopyStatus('');
        }}
      >
        <div className="workspace__heading">
          <h2 id={titleId}>分享空间</h2>
          <button
            type="button"
            className="workspace__icon-button workspace__secondary"
            aria-label="关闭分享"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p>任何拿到链接的人都可以查看「{space.name}」已发布的内容。</p>
        {state?.kind === 'loading' && <p role="status">正在获取链接…</p>}
        {state?.kind === 'error' && (
          <>
            <p role="alert">{state.message}</p>
            <button type="button" onClick={() => void loadLink()}>
              重试
            </button>
          </>
        )}
        {state?.kind === 'ready' && (
          <div className="workspace__share-link">
            <label>
              分享链接
              <input
                ref={input}
                type="text"
                value={state.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <button type="button" onClick={() => void copyLink(state.url)}>
              复制链接
            </button>
            <p role="status">{copyStatus}</p>
          </div>
        )}
      </dialog>
    </>
  );
}
