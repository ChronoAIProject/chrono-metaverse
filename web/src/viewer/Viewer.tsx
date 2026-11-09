import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Texture } from 'three';
import { viewHasGeometry, type SceneContent } from '../core/scene';
import { sceneSources } from '../core/sources';
import type { Visual } from '../core/visuals';
import { InfoPanel } from './InfoPanel';
import { ModelSources } from './ModelSources';
import {
  SceneView,
  type LoadStep,
  type SceneStats,
  type SceneViewOptions,
  type Selection,
} from './sceneView';
import './Viewer.css';

/** 查看器需要的场景能力；测试里可以换成假的实现（jsdom 没有 WebGL）。 */
export interface SceneViewLike {
  setContent(content: SceneContent): Promise<void>;
  setVisuals(visuals: readonly Visual[]): void;
  setCutaway(height: number | null): void;
  select(selection: Selection | null): void;
  frameContent(): void;
  /** 显示全部锚点标签；false 时只显示有意义的几类（见 labelLayout.ts）。 */
  setShowAllLabels(all: boolean): void;
  getStats(): SceneStats;
  dispose(): void;
}

export type SceneViewFactory = (host: HTMLElement, options: SceneViewOptions) => SceneViewLike;

export const createSceneView: SceneViewFactory = (host, options) => new SceneView(host, options);

export interface ViewerProps {
  readonly content: SceneContent | null;
  readonly visuals?: readonly Visual[];
  /** 剖切高度（米）；null 表示不剖切。 */
  readonly cutaway: number | null;
  readonly loadTexture?: (hash: string) => Promise<Texture>;
  readonly loadModel?: (hash: string) => Promise<ArrayBuffer>;
  readonly createView?: SceneViewFactory;
}

/** 内容对应的提示：原始视图那时还没有扫描、优化视图那时还没有模型。 */
function noticeFor(content: SceneContent): string | null {
  if (content.members.length === 0) return null;
  if (content.mode === 'raw') {
    return content.members.every((m) => m.view.scanMissing)
      ? '这个时刻之前还没有导入扫描模型。'
      : null;
  }
  return content.members.some((m) => viewHasGeometry(m.view))
    ? null
    : '这个时刻还没有优化模型，可以切到"原始"视图看扫描。';
}

/** three.js 场景的 React 外壳：挂载、传参、生成进度、点选面板、WebGL 不可用时给出提示。 */
export function Viewer({
  content,
  visuals = [],
  cutaway,
  loadTexture,
  loadModel,
  createView = createSceneView,
}: ViewerProps) {
  const viewRef = useRef<SceneViewLike | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textureRef = useRef(loadTexture);
  const modelRef = useRef(loadModel);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [step, setStep] = useState<LoadStep | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [allLabels, setAllLabels] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // 场景里外部模型的署名（CC-BY 必须可见）：有就一直显示模型来源按钮。
  const credits = useMemo(() => sceneSources(content), [content]);

  useEffect(() => {
    textureRef.current = loadTexture;
    modelRef.current = loadModel;
  }, [loadTexture, loadModel]);

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
          loadModel: (hash) =>
            modelRef.current
              ? modelRef.current(hash)
              : Promise.reject(new Error('没有模型加载函数')),
          onProgress: setStep,
          onSelect: setSelection,
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

  // 内容交给场景；生成完以后把统计写到宿主元素的 data-* 上（端到端测试据此判断已经画出内容）。
  useEffect(() => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (host === null) return;
    if (view === null || content === null) {
      host.dataset.ready = 'false';
      return;
    }
    let cancelled = false;
    host.dataset.ready = 'false';
    view
      .setContent(content)
      .then(() => {
        if (cancelled) return;
        const stats = view.getStats();
        host.dataset.mode = content.mode;
        host.dataset.entities = String(stats.entities);
        host.dataset.voxelFaces = String(stats.voxelFaces);
        host.dataset.instanced = String(stats.instancedEntities);
        host.dataset.textured = String(stats.textured);
        host.dataset.threaded = String(stats.threaded);
        host.dataset.members = String(stats.members);
        host.dataset.scan = String(stats.hasScan);
        host.dataset.sources = String(sceneSources(content).length);
        host.dataset.ready = 'true';
      })
      .catch((error: unknown) => {
        if (!cancelled) setUnsupported(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [content]);

  useEffect(() => {
    viewRef.current?.setCutaway(cutaway);
  }, [cutaway, content]);

  useEffect(() => {
    viewRef.current?.setVisuals(visuals);
  }, [visuals, content]);

  useEffect(() => {
    viewRef.current?.setShowAllLabels(allLabels);
  }, [allLabels, content]);

  // 换了内容（换时刻、换视图）时，原来选中的物件可能已经不在了。
  const [selectedContent, setSelectedContent] = useState(content);
  if (selectedContent !== content) {
    setSelectedContent(content);
    if (selection !== null) setSelection(null);
  }

  const notice = content !== null && unsupported === null ? noticeFor(content) : null;
  return (
    <div className="viewer" ref={attach} data-ready="false">
      {unsupported !== null && (
        <div className="viewer__notice" role="alert">
          <strong>无法显示三维场景</strong>
          <span>当前浏览器不支持 WebGL，或者显卡加速被关闭了。</span>
        </div>
      )}
      {notice !== null && (
        <div className="viewer__notice viewer__notice--soft" role="status">
          {notice}
        </div>
      )}
      {step !== null && step.total > 0 && (
        <div className="viewer__progress" role="status" aria-live="polite">
          <span>
            {step.label} {step.done}/{step.total}
          </span>
          <progress max={step.total} value={step.done} />
        </div>
      )}
      {selection !== null && (
        <InfoPanel
          selection={selection}
          onClose={() => {
            setSelection(null);
            viewRef.current?.select(null);
          }}
        />
      )}
      <ModelSources credits={credits} open={sourcesOpen} onClose={() => setSourcesOpen(false)} />
      {content !== null && unsupported === null && (
        <div className="viewer__tools">
          {credits.length > 0 && (
            <button
              type="button"
              className="viewer__tool"
              aria-expanded={sourcesOpen}
              aria-controls="viewer-model-sources"
              title="场景里外部模型的标题、作者、许可和来源页"
              onClick={() => setSourcesOpen((open) => !open)}
            >
              模型来源 · {credits.length}
            </button>
          )}
          <label
            className="viewer__tool viewer__tool--check"
            title="默认只显示桌子、前台、区域、门和有事件的锚点"
          >
            <input
              type="checkbox"
              checked={allLabels}
              onChange={(event) => setAllLabels(event.target.checked)}
            />
            显示全部标签
          </label>
          <button
            type="button"
            className="viewer__tool"
            onClick={() => viewRef.current?.frameContent()}
          >
            回到全景
          </button>
        </div>
      )}
    </div>
  );
}
