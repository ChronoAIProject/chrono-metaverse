import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnchorState } from '../core/api/types';
import type { ViewContent } from '../core/scene';
import { SceneView, type SceneStats, type SceneViewOptions } from './sceneView';
import './Viewer.css';

/** 查看器需要的场景能力；测试里可以换成假的实现（jsdom 没有 WebGL）。 */
export interface SceneViewLike {
  setContent(view: ViewContent, scan?: ArrayBuffer | null, scanTransform?: readonly number[]): void;
  setCutaway(height: number | null): void;
  setAnchorStates(states: ReadonlyMap<string, ReadonlyMap<string, AnchorState>>): void;
  frameContent(): void;
  getStats(): SceneStats;
  dispose(): void;
}

export type SceneViewFactory = (host: HTMLElement, options: SceneViewOptions) => SceneViewLike;

export const createSceneView: SceneViewFactory = (host, options) => new SceneView(host, options);

export interface ViewerProps {
  readonly content: ViewContent | null;
  readonly scan?: ArrayBuffer | null;
  readonly scanTransform?: readonly number[];
  /** 剖切高度（米）；null 表示不剖切。 */
  readonly cutaway: number | null;
  readonly states: ReadonlyMap<string, ReadonlyMap<string, AnchorState>>;
  readonly loadTexture?: SceneViewOptions['loadTexture'];
  readonly createView?: SceneViewFactory;
}

/** three.js 场景的 React 外壳：挂载、传参、WebGL 不可用时给出提示。 */
export function Viewer({
  content,
  scan,
  scanTransform,
  cutaway,
  states,
  loadTexture,
  createView = createSceneView,
}: ViewerProps) {
  const viewRef = useRef<SceneViewLike | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textureRef = useRef(loadTexture);
  const [unsupported, setUnsupported] = useState<string | null>(null);

  useEffect(() => {
    textureRef.current = loadTexture;
  }, [loadTexture]);

  // 场景在宿主元素挂上时创建一次（回调 ref，React 19 支持返回清理函数）。
  const attach = useCallback(
    (host: HTMLDivElement | null) => {
      hostRef.current = host;
      if (host === null) return;
      let view: SceneViewLike;
      try {
        view = createView(host, {
          loadTexture: (hash) =>
            textureRef.current
              ? textureRef.current(hash)
              : Promise.reject(new Error('没有贴图加载函数')),
        });
      } catch (error) {
        setUnsupported(error instanceof Error ? error.message : String(error));
        return;
      }
      viewRef.current = view;
      return () => {
        view.dispose();
        viewRef.current = null;
      };
    },
    [createView],
  );

  // 内容交给场景；统计写到宿主元素的 data-* 上（端到端测试据此判断已经画出内容）。
  useEffect(() => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (host === null) return;
    if (view === null || content === null) {
      host.dataset.ready = 'false';
      return;
    }
    view.setContent(content, scan ?? null, scanTransform);
    const stats = view.getStats();
    host.dataset.mode = content.mode;
    host.dataset.entities = String(stats.entities);
    host.dataset.voxelFaces = String(stats.voxelFaces);
    host.dataset.ready = 'true';
  }, [content, scan, scanTransform]);

  useEffect(() => {
    viewRef.current?.setCutaway(cutaway);
  }, [cutaway, content]);

  useEffect(() => {
    viewRef.current?.setAnchorStates(states);
  }, [states, content]);

  const ready = content !== null && unsupported === null;
  const empty = content !== null && content.entities.length === 0 && content.voxels.size === 0;
  return (
    <div className="viewer" ref={attach} data-ready="false">
      {unsupported !== null && (
        <div className="viewer__notice" role="alert">
          <strong>无法显示三维场景</strong>
          <span>当前浏览器不支持 WebGL，或者显卡加速被关闭了。</span>
        </div>
      )}
      {ready && content.mode === 'raw' && content.scanMissing && (
        <div className="viewer__notice viewer__notice--soft" role="status">
          这个时刻之前还没有导入扫描模型。
        </div>
      )}
      {ready && content.mode !== 'raw' && empty && (
        <div className="viewer__notice viewer__notice--soft" role="status">
          这个时刻还没有优化模型，可以切到"原始"视图看扫描。
        </div>
      )}
      {ready && (
        <button
          type="button"
          className="viewer__frame"
          onClick={() => viewRef.current?.frameContent()}
        >
          回到全景
        </button>
      )}
    </div>
  );
}
