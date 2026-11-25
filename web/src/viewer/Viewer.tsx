import { ViewerToolsContext } from '../workspace/viewerTools';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Texture } from 'three';
import { sceneChange, viewHasGeometry, type SceneContent } from '../core/scene';
import { sceneSources } from '../core/sources';
import type { Visual } from '../core/visuals';
import type { ViewCameraAction } from './cameraPose';
import { CameraControls } from './CameraControls';
import type { CameraPerspective } from './cameraPerspective';
import type { CameraStep } from './cameraNavigation';
import { InfoPanel } from './InfoPanel';
import { ModelSources } from './ModelSources';
import {
  SceneView,
  type LoadStep,
  type SceneStats,
  type SceneViewOptions,
  type Selection,
} from './sceneView';
import type { BroadcastView } from './broadcast/venue';
import './Viewer.css';

/** 查看器需要的场景能力；测试里可以换成假的实现（jsdom 没有 WebGL）。 */
export interface SceneViewLike {
  setContent(content: SceneContent): Promise<void>;
  setVisuals(visuals: readonly Visual[]): void;
  setCutaway(height: number | null): void;
  select(selection: Selection | null): void;
  frameContent(): void;
  toggleTour?(): void;
  showBroadcast?(shot: string): void;
  stepCamera(step: CameraStep): void;
  setPerspective(mode: CameraPerspective): void;
  focusMember?(spaceId: string | null): void;
  focusAnchor?(
    ref: { readonly spaceId: string; readonly anchorId: string } | null,
    moveCamera?: boolean,
  ): void;
  applyCamera?(action: ViewCameraAction, content: SceneContent): boolean;
  /** 扩大锚点标签的显示范围和数量上限。 */
  setMoreLabels(more: boolean): void;
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
  /** 场景生成完以后报告扫描天花板的高度（米；没有扫描或没扫到天花板时是 null），页面据此定默认剖切高度。 */
  readonly onScanCeiling?: (height: number | null) => void;
  readonly camera?: { id: string; actions: ViewCameraAction[] };
  readonly onCameraResult?: (success: boolean) => void;
  /** 组合工作台的成员镜头聚焦；`null` 表示全景总览。 */
  readonly focusedSpaceId?: string | null;
  /** 每次点击全景总览时递增，重复点击也生效。 */
  readonly overviewRequest?: number;
  /** 空间锚点导览的镜头目标；`null` 表示清除锚点高亮。 */
  readonly focusedAnchor?: { readonly spaceId: string; readonly anchorId: string } | null;
}

/** 内容对应的提示：原始视图那时还没有扫描、优化视图那时还没有模型。 */
function noticeFor(content: SceneContent): string | null {
  if (content.members.length === 0) return null;
  if (content.members.some((member) => member.view.showScan || viewHasGeometry(member.view)))
    return null;
  if (content.members.every((member) => member.view.scanMissing))
    return '这个时刻之前还没有导入扫描模型。';
  if (content.mode === 'raw') return null;
  return content.members.some((member) => member.view.visibleLayers !== undefined)
    ? '当前样式没有可见内容，可以切换样式或查看模式。'
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
  onScanCeiling,
  camera,
  onCameraResult,
  focusedSpaceId,
  focusedAnchor,
  overviewRequest = 0,
}: ViewerProps) {
  const viewRef = useRef<SceneViewLike | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textureRef = useRef(loadTexture);
  const modelRef = useRef(loadModel);
  const ceilingRef = useRef(onScanCeiling);
  const cameraRef = useRef(camera);
  const cameraResultRef = useRef(onCameraResult);
  const focusedSpaceRef = useRef(focusedSpaceId);
  const focusedAnchorRef = useRef(focusedAnchor);
  const lastCamera = useRef('');
  const readyContent = useRef<SceneContent | null>(null);
  const [tour, setTour] = useState(false);
  const [broadcast, setBroadcast] = useState<BroadcastView | null>(null);
  const [perspective, setPerspective] = useState<CameraPerspective>('third');
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [step, setStep] = useState<LoadStep | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const sdkViewer = useContext(ViewerToolsContext);
  const currentSelection = useRef(selection);
  useLayoutEffect(() => {
    currentSelection.current = selection;
  }, [selection]);
  useLayoutEffect(() => {
    if (!sdkViewer || !content) return;
    return sdkViewer.bind({
      selection() {
        const picked = currentSelection.current;
        return picked && readyContent.current === content
          ? { spaceId: picked.spaceId, entityId: picked.entity.entityId }
          : null;
      },
      focus(target) {
        return (
          readyContent.current === content &&
          (viewRef.current?.applyCamera?.({ kind: 'focus', ...target }, content) ?? false)
        );
      },
    });
  }, [sdkViewer, content]);
  const [moreLabels, setMoreLabels] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [hasProviderCredits, setHasProviderCredits] = useState(false);
  const providerCreditsRef = useRef<HTMLDivElement>(null);
  const sourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const sourcesCloseRef = useRef<HTMLButtonElement>(null);
  const sourcesId = useId();
  const credits = useMemo(() => sceneSources(content), [content]);
  const hasSources = credits.length > 0 || hasProviderCredits;
  if (!hasSources && sourcesOpen) setSourcesOpen(false);

  useEffect(() => {
    const host = providerCreditsRef.current;
    if (!host) return;
    // 地图和流式内容由渲染器挂载署名，跟随实际加载的来源显示入口。
    const update = () => setHasProviderCredits(host.childElementCount > 0);
    const observer = new MutationObserver(update);
    observer.observe(host, { childList: true });
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (sourcesOpen) sourcesCloseRef.current?.focus();
  }, [sourcesOpen]);

  const closeSources = () => {
    setSourcesOpen(false);
    sourcesTriggerRef.current?.focus();
  };

  useEffect(() => {
    textureRef.current = loadTexture;
    modelRef.current = loadModel;
    ceilingRef.current = onScanCeiling;
  }, [loadTexture, loadModel, onScanCeiling]);
  const applyCamera = useCallback((view: SceneViewLike, content: SceneContent) => {
    const command = cameraRef.current;
    if (!command || lastCamera.current === command.id) return;
    lastCamera.current = command.id;
    const results = command.actions.map((action) => view.applyCamera?.(action, content) ?? false);
    const success = results.every(Boolean);
    if (hostRef.current) hostRef.current.dataset.cameraCommand = command.id;
    cameraResultRef.current?.(success);
  }, []);
  useEffect(() => {
    viewRef.current?.setCutaway(cutaway);
  }, [cutaway, content]);
  useEffect(() => {
    cameraRef.current = camera;
    cameraResultRef.current = onCameraResult;
    if (
      content &&
      readyContent.current === content &&
      viewRef.current &&
      hostRef.current?.dataset.ready === 'true'
    )
      applyCamera(viewRef.current, content);
  }, [camera, onCameraResult, content, applyCamera]);

  useEffect(() => {
    focusedSpaceRef.current = focusedSpaceId;
    if (focusedSpaceId != null) viewRef.current?.focusMember?.(focusedSpaceId);
  }, [focusedSpaceId]);

  useEffect(() => {
    focusedAnchorRef.current = focusedAnchor;
    if (focusedAnchor !== undefined) viewRef.current?.focusAnchor?.(focusedAnchor);
  }, [focusedAnchor]);

  useEffect(() => {
    if (overviewRequest > 0) viewRef.current?.frameContent();
  }, [overviewRequest]);

  // 场景在宿主元素挂上时创建一次（回调 ref，React 19 支持返回清理函数）。
  const attach = useCallback(
    (host: HTMLDivElement | null) => {
      hostRef.current = host;
      if (host === null) return;
      let view: SceneViewLike;
      try {
        view = createView(host, {
          providerCreditsHost: providerCreditsRef.current ?? undefined,
          loadTexture: (hash) =>
            textureRef.current
              ? textureRef.current(hash)
              : Promise.reject(new Error('没有贴图加载函数')),
          loadModel: (hash) =>
            modelRef.current
              ? modelRef.current(hash)
              : Promise.reject(new Error('没有模型加载函数')),
          onBroadcastTour: setTour,
          onBroadcastShot: setBroadcast,
          onPerspectiveChange: setPerspective,
          onProgress: setStep,
          onSelect: setSelection,
        });
      } catch (error) {
        setUnsupported(error instanceof Error ? error.message : String(error));
        return;
      }
      setPerspective('third');
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
        host.dataset.scanCeiling = stats.scanCeiling === null ? '' : stats.scanCeiling.toFixed(3);
        ceilingRef.current?.(stats.scanCeiling);
        host.dataset.sources = String(credits.length);
        host.dataset.ready = 'true';
        const extensionChanged = sceneChange(readyContent.current, content) === 'extension';
        readyContent.current = content;
        if (extensionChanged) {
          if (focusedAnchorRef.current) view.focusAnchor?.(focusedAnchorRef.current, false);
        } else {
          if (focusedSpaceRef.current != null) view.focusMember?.(focusedSpaceRef.current);
          if (focusedAnchorRef.current !== undefined) view.focusAnchor?.(focusedAnchorRef.current);
        }
        applyCamera(view, content);
      })
      .catch((error: unknown) => {
        if (!cancelled) setUnsupported(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [content, credits, applyCamera]);

  useEffect(() => {
    viewRef.current?.setVisuals(visuals);
  }, [visuals, content]);

  useEffect(() => {
    viewRef.current?.setMoreLabels(moreLabels);
  }, [moreLabels, content]);

  // 换了内容（换时刻、换视图）时，原来选中的物件可能已经不在了。
  const [selectedContent, setSelectedContent] = useState(content);
  if (selectedContent !== content) {
    setSelectedContent(content);
    if (selection !== null) setSelection(null);
  }

  const notice = content !== null && unsupported === null ? noticeFor(content) : null;
  const showTools = content !== null && unsupported === null;
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
      {showTools && broadcast && (
        <nav className="viewer__broadcast" aria-label="发布会机位">
          <button
            className="viewer__tour"
            type="button"
            onClick={() => viewRef.current?.toggleTour?.()}
          >
            <span aria-hidden="true">{tour ? '■' : '▶'}</span> {tour ? '停止拉远' : '播放拉远'}
          </button>
          {broadcast.stops.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={broadcast.active === id}
              onClick={() => viewRef.current?.showBroadcast?.(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {(showTools || hasSources) && (
        <div className="viewer__bottom">
          <div className="viewer__actions">
            {showTools && (
              <div className="viewer__tools">
                <label
                  className="viewer__tool viewer__tool--check"
                  title="显示更多物件名称，标签会自动避让"
                >
                  <input
                    type="checkbox"
                    checked={moreLabels}
                    onChange={(event) => setMoreLabels(event.target.checked)}
                  />
                  更多标签
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
            {hasSources && (
              <button
                type="button"
                className="viewer__tool"
                ref={sourcesTriggerRef}
                aria-expanded={sourcesOpen}
                aria-controls={sourcesId}
                onClick={() => setSourcesOpen((open) => !open)}
              >
                引用版权
              </button>
            )}
          </div>
          {showTools && (
            <CameraControls
              perspective={perspective}
              onPerspective={(mode) => viewRef.current?.setPerspective(mode)}
              onStep={(step) => viewRef.current?.stepCamera(step)}
            />
          )}
        </div>
      )}
      <section
        className="viewer__sources"
        aria-labelledby={`${sourcesId}-title`}
        id={sourcesId}
        hidden={!sourcesOpen}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            closeSources();
          }
        }}
      >
        <header>
          <h2 id={`${sourcesId}-title`}>引用版权</h2>
          <button
            type="button"
            className="viewer__info-close"
            ref={sourcesCloseRef}
            onClick={closeSources}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <ModelSources credits={credits} />
        <div className="viewer__provider-credits" ref={providerCreditsRef} />
      </section>
    </div>
  );
}
