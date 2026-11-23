import { useEffect, useMemo, useState } from 'react';
import type { PublicClient } from '../core/api/client';
import type { PreviewView } from '../core/api/types';
import {
  IDENTITY_PLACEMENT,
  hasStyleChoice,
  loadScene,
  ceilingCutHeight,
  defaultCutHeight,
  effectiveCutHeight,
  sceneHeightRange,
  selectView,
  selectViewForStyle,
  type SceneContent,
  type SceneDocument,
  type ViewMode,
} from '../core/scene';
import { resolveSpaceStyles } from '../core/styles';
import { useAssetLoaders } from '../data/hooks';
import { runtimeError, type LoadProgress, type RuntimeError } from '../data/spaceRuntime';
import { useViewOverrides, lookFromSearch, searchWithLook } from '../routing/routes';
import { formatTime } from '../timeline/TimelineBar';
import { Viewer, type SceneViewFactory } from '../viewer/Viewer';
import { previewPose } from '../viewer/cameraPose';
import {
  CutawayControl,
  ErrorCard,
  LoadingCard,
  StyleSwitch,
  StyleGallerySwitch,
  AnchorQuickBar,
  ThemeToggle,
  ViewModeSwitch,
} from './controls';
import { ViewerPanel, SettingSection } from './DisplaySettings';
import './SpacePage.css';

export interface PreviewPageProps {
  /** 预览令牌（地址里 `#t=` 后面的部分）；没有时为 null。 */
  readonly token: string | null;
  readonly client: PublicClient;
  readonly createView?: SceneViewFactory;
  /** 默认视图：地址里没有（或不认识）`?view=` 时用它；切回它时地址里不写 view。 */
  readonly initialMode?: ViewMode;
}

/**
 * 草稿预览页 `/preview#t=<令牌>`（设计 5.6、8.2）：
 *
 * - `GET /api/public/previews`，令牌放在 `Authorization: Preview <令牌>` 里（在 # 后面，不进日志）；
 * - 草稿的区块和资源（包括新上传的贴图）全部走 `/api/public/previews/chunks|assets/{hash}`；
 * - 每次打开先验证预览；资源字节按授权与修订隔离保存在浏览器，页面没有时间轴。
 */
export function PreviewPage({
  token,
  client,
  createView,
  initialMode = 'extended',
}: PreviewPageProps) {
  const {
    mode: fallbackMode,
    style: fallbackStyle,
    explicitMode,
    explicitStyle,
    setMode,
    setStyle,
    resetOverrides,
  } = useViewOverrides(initialMode);
  const [linkedCamera] = useState(() => {
    const pose = previewPose(window.location.search);
    return pose ? { id: 'preview-pose', actions: [pose] } : undefined;
  });
  const [lookId, setLookId] = useState<string | null>(() => lookFromSearch(window.location.search));
  const [focusedAnchor, setFocusedAnchor] = useState<{ spaceId: string; anchorId: string } | null>(
    null,
  );
  const [overviewRequest, setOverviewRequest] = useState(0);
  const [cutEnabled, setCutEnabled] = useState(true);
  // 剖切高度：null 表示用户还没拖过滑块，按天花板算默认值（只切掉天花板）。
  const [cutChoice, setCutHeight] = useState<number | null>(null);
  // 原始视图里扫描天花板的高度（查看器生成完场景后报告）。
  const [scanCeiling, setScanCeiling] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [scene, setScene] = useState<SceneDocument | null>(null);
  const [error, setError] = useState<RuntimeError | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scan, setScan] = useState<{ hash: string; bytes: ArrayBuffer } | null>(null);

  const assets = useMemo(
    () => ({
      external: client.previewExternal
        ? (
            _space: string,
            _seq: number,
            resource: import('../core/externalSource').ExternalRequest,
            signal: AbortSignal,
          ) => client.previewExternal!(token ?? '', resource, signal)
        : undefined,
      chunk: (hash: string) => client.previewChunk(token ?? '', hash),
      asset: (hash: string) => client.previewAsset(token ?? '', hash),
      assetBlob: (hash: string) => client.previewAssetBlob(token ?? '', hash),
    }),
    [client, token],
  );
  const loaders = useAssetLoaders(assets);

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    client
      .preview(token)
      .then(async (view) => {
        if (cancelled) return;
        setPreview(view);
        const doc = await loadScene(assets, view, view.spaceName, (done, total) => {
          if (!cancelled) setProgress({ label: '下载区块', done, total });
        });
        if (cancelled) return;
        setScene(doc);
        setProgress(null);
        document.title = `草稿预览 · ${view.spaceName ?? view.spaceId} · chrono-metaverse`;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(runtimeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client, token, assets, attempt]);

  const styles = useMemo(() => resolveSpaceStyles(scene), [scene]);
  const activeStyle = styles.find(
    (candidate) => candidate.id === (lookId ?? scene?.defaultStyleId),
  );
  const mode = explicitMode ?? activeStyle?.mode ?? fallbackMode;
  const style =
    explicitStyle ?? (activeStyle ? (activeStyle.rebuiltStyle ?? 'shapes') : fallbackStyle);

  const showScan = explicitMode
    ? explicitMode === 'raw'
    : (activeStyle?.visibleLayers?.includes('scan') ?? mode === 'raw');
  const scanHash = showScan ? scene?.scan?.webModelHashes[0] : undefined;
  useEffect(() => {
    if (scanHash === undefined || token === null) return;
    let cancelled = false;
    client
      .previewAsset(token, scanHash, (loaded, total) => {
        if (!cancelled && total !== null && loaded < total) {
          setProgress({
            label: '下载扫描模型（KB）',
            done: Math.round(loaded / 1024),
            total: Math.round(total / 1024),
          });
        }
      })
      .then((bytes) => {
        if (cancelled) return;
        setScan({ hash: scanHash, bytes });
        setProgress(null);
      })
      .catch(() => setProgress(null));
    return () => {
      cancelled = true;
    };
  }, [client, token, scanHash]);

  const content = useMemo<SceneContent | null>(() => {
    if (scene === null) return null;
    const view = activeStyle
      ? selectViewForStyle(
          scene,
          { ...activeStyle, rebuiltStyle: style },
          explicitMode ?? undefined,
        )
      : selectView(scene, mode, style);
    const bytes = scan !== null && scan.hash === scanHash ? scan.bytes : null;
    if (view.showScan && bytes === null) return null;
    return {
      mode,
      members: [
        {
          spaceId: scene.spaceId,
          name: scene.name,
          view,
          scan: bytes,
          scanTransform: scene.scan?.transform,
          external: scene.external,
          placement: IDENTITY_PLACEMENT,
        },
      ],
      links: [],
    };
  }, [scene, mode, style, explicitMode, activeStyle, scan, scanHash]);
  const heights = useMemo(() => (scene ? sceneHeightRange(scene) : { min: 0, max: 3 }), [scene]);
  const ceiling = useMemo(() => (scene ? ceilingCutHeight(scene) : null), [scene]);
  const cutHeight = effectiveCutHeight(cutChoice, defaultCutHeight(mode, ceiling, scanCeiling));

  if (token === null) {
    return (
      <ErrorCard
        title="打不开这个预览"
        message="链接里没有预览令牌（# 后面的 t=…）。请向发起预览的人要完整的链接。"
        notFound
      />
    );
  }
  if (error !== null) {
    return (
      <ErrorCard
        title="打不开这个预览"
        message={
          error.notFound
            ? '预览链接无效或已过期：草稿可能已经发布或丢弃，也可能链接不完整。'
            : error.message
        }
        notFound={error.notFound}
        onRetry={() => {
          setError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  const info = preview?.preview;
  return (
    <main className="space space--preview" data-preview="true">
      <header className="space__bar">
        <div className="space__title">
          <h1>
            <span className="space__badge">草稿预览</span>
            {preview?.spaceName ?? preview?.spaceId ?? '正在加载…'}
          </h1>
          <p className="space__version">
            {info
              ? `基于版本 #${info.baseSeq} · 草稿修订 ${info.rev}${info.scope ? ` · 范围 ${info.scope}` : ''}${
                  info.expiresAt ? ` · 有效期至 ${formatTime(Date.parse(info.expiresAt))}` : ''
                }`
              : '正在读取草稿'}
          </p>
        </div>
        <div className="space__primary-actions">
          <ViewModeSwitch mode={mode} onChange={setMode} />
          <ViewerPanel label="显示设置">
            <SettingSection label="空间样式">
              <StyleGallerySwitch
                styles={styles}
                activeId={activeStyle?.id}
                onChange={(next) => {
                  setLookId(next.id);
                  const search = searchWithLook(window.location.search, next.id);
                  window.history.replaceState(
                    window.history.state,
                    '',
                    `${window.location.pathname}${search}${window.location.hash}`,
                  );
                  resetOverrides();
                }}
              />
              {scene !== null && hasStyleChoice(scene) && (
                <StyleSwitch style={style} disabled={mode === 'raw'} onChange={setStyle} />
              )}
            </SettingSection>
            <SettingSection label="室内剖切">
              <CutawayControl
                enabled={cutEnabled}
                height={Math.min(cutHeight, heights.max)}
                max={heights.max}
                onToggle={setCutEnabled}
                onHeight={setCutHeight}
              />
            </SettingSection>
            <SettingSection label="界面外观">
              <ThemeToggle />
            </SettingSection>
          </ViewerPanel>
        </div>
      </header>
      <section className="space__stage" aria-label="三维视图">
        <Viewer
          content={content}
          camera={linkedCamera}
          cutaway={cutEnabled ? cutHeight : null}
          onScanCeiling={setScanCeiling}
          loadTexture={loaders.loadTexture}
          loadModel={loaders.loadModel}
          createView={createView}
          overviewRequest={overviewRequest}
          focusedAnchor={focusedAnchor}
        />
        <ViewerPanel label="空间导览" className="viewer-panel--navigation">
          <AnchorQuickBar
            anchors={scene?.anchors ?? []}
            onFocus={(anchor) => {
              if (!anchor) setOverviewRequest((value) => value + 1);
              setFocusedAnchor(
                anchor && scene ? { spaceId: scene.spaceId, anchorId: anchor.anchorId } : null,
              );
            }}
          />
        </ViewerPanel>
        {(scene === null || progress !== null) && (
          <LoadingCard
            label={progress?.label ?? '读取草稿'}
            done={progress?.done}
            total={progress?.total}
          />
        )}
      </section>
    </main>
  );
}
