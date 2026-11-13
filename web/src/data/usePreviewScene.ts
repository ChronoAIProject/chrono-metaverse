import { useEffect, useMemo, useState } from 'react';
import type { PublicClient } from '../core/api/client';
import type { PreviewView } from '../core/api/types';
import { loadScene, type SceneDocument } from '../core/scene';
import { runtimeError, type LoadProgress, type RuntimeError } from './spaceRuntime';

interface PreviewState {
  readonly request: object;
  readonly view: PreviewView | null;
  readonly scene: SceneDocument | null;
  readonly progress: LoadProgress | null;
  readonly error: RuntimeError | null;
}

/** Validate each preview before applying it to the workspace's existing viewer. */
export function usePreviewScene(
  client: PublicClient,
  spaceId: string,
  token: string | undefined,
  attempt: number,
) {
  const [state, setState] = useState<PreviewState | null>(null);
  const request = useMemo(
    () => ({ client, spaceId, token, attempt }),
    [client, spaceId, token, attempt],
  );
  const source = useMemo(
    () =>
      token
        ? {
            chunk: (hash: string) => client.previewChunk(token, hash),
            asset: (hash: string) => client.previewAsset(token, hash),
            assetBlob: (hash: string) => client.previewAssetBlob(token, hash),
            external: client.previewExternal
              ? (
                  _space: string,
                  _seq: number,
                  resource: import('../core/externalSource').ExternalRequest,
                  signal: AbortSignal,
                ) => client.previewExternal!(token, resource, signal)
              : undefined,
          }
        : client,
    [client, token],
  );
  useEffect(() => {
    if (!token) return;
    let active = true;
    const next: PreviewState = { request, view: null, scene: null, progress: null, error: null };
    void client
      .preview(token)
      .then(async (view) => {
        if (!active) return;
        if (view.spaceId !== spaceId) throw new Error('这个草稿不属于当前空间。');
        const scene = await loadScene(source, view, view.spaceName, (done, total) => {
          if (active) setState({ ...next, progress: { label: '读取草稿区块', done, total } });
        });
        if (active) setState({ ...next, view, scene });
      })
      .catch((error: unknown) => {
        if (active) setState({ ...next, error: runtimeError(error) });
      });
    return () => {
      active = false;
    };
  }, [client, source, spaceId, token, request]);
  return {
    source,
    view: token && state?.request === request ? state.view : null,
    scene: token && state?.request === request ? state.scene : null,
    progress: token && state?.request === request ? state.progress : null,
    error: token && state?.request === request ? state.error : null,
  };
}
