import { useEffect, useMemo, useState } from 'react';
import type { PublicClient } from '../core/api/client';
import { toMillis } from '../core/events';
import {
  IDENTITY_PLACEMENT,
  hasStyleChoice,
  ceilingCutHeight,
  defaultCutHeight,
  effectiveCutHeight,
  sceneHeightRange,
  selectView,
  type SceneContent,
  type ViewMode,
} from '../core/scene';
import { buildVisuals } from '../core/visuals';
import { useAssetLoaders, useDensity, useRuntimeState } from '../data/hooks';
import { SpaceRuntime } from '../data/spaceRuntime';
import { useRebuiltStyle, useViewMode } from '../routing/routes';
import { TimelineBar, formatTime } from '../timeline/TimelineBar';
import { Viewer, type SceneViewFactory } from '../viewer/Viewer';
import {
  CutawayControl,
  ErrorCard,
  LoadingCard,
  StyleSwitch,
  ThemeToggle,
  ViewModeSwitch,
} from './controls';
import { usePlayback } from './usePlayback';
import './SpacePage.css';

export interface SpacePageProps {
  readonly spaceId: string;
  readonly client: PublicClient;
  /** 有分享令牌时为 true；没有时提示链接可能不完整。 */
  readonly hasShareToken: boolean;
  readonly embedded?: boolean;
  readonly createView?: SceneViewFactory;
  readonly now?: () => number;
  /** 默认视图：地址里没有（或不认识）`?view=` 时用它；切回它时地址里不写 view。 */
  readonly initialMode?: ViewMode;
}

/** 时间轴的范围：第一次提交前一天到现在（或最后一次提交、当前时刻里最晚的）。 */
export function timelineRange(commitTimes: readonly number[], now: number, time: number) {
  const first = commitTimes.length > 0 ? Math.min(...commitTimes) : now - 7 * 86_400_000;
  const last = commitTimes.length > 0 ? Math.max(...commitTimes) : now;
  const to = Math.max(now, last, time);
  const from = Math.min(first - 86_400_000, to - 86_400_000);
  return { from, to };
}

/** 查看一个空间：三维视图、三种视图切换、剖切、时间轴、事件可视化（设计第 7 节）。 */
export function SpacePage({
  spaceId,
  client,
  hasShareToken,
  embedded = false,
  createView,
  now = Date.now,
  initialMode = 'optimized',
}: SpacePageProps) {
  const [mode, setMode] = useViewMode(initialMode);
  const [style, setStyle] = useRebuiltStyle();
  const [cutEnabled, setCutEnabled] = useState(true);
  // 剖切高度：null 表示用户还没拖过滑块，按天花板算默认值（只切掉天花板）。
  const [cutChoice, setCutHeight] = useState<number | null>(null);
  // 原始视图里扫描天花板的高度（查看器生成完场景后报告）。
  const [scanCeiling, setScanCeiling] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 下载好的扫描模型，连同它的哈希：换了扫描时旧的自动失效。
  const [loadedScan, setLoadedScan] = useState<{ hash: string; bytes: ArrayBuffer } | null>(null);
  const playback = usePlayback(now);
  const { time, live, windowMs } = playback;

  // 每个空间（和每次"重试"）一个运行时；挂载时开始，卸载时停下。
  const runtime = useMemo(
    () => new SpaceRuntime(client, spaceId, client, { now }),
    // now 只用来取当前时间；attempt 变了表示重试，换一个新的运行时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, spaceId, attempt],
  );
  useEffect(() => {
    runtime.start();
    return () => runtime.stop();
  }, [runtime]);

  useEffect(() => {
    runtime.setTime(time, live, windowMs);
  }, [runtime, time, live, windowMs]);

  const state = useRuntimeState(runtime);
  const { scene, info } = state;
  const loaders = useAssetLoaders(client);

  useEffect(() => {
    if (info) document.title = `${info.name} · chrono-metaverse`;
  }, [info]);

  const scanHash = mode === 'raw' ? scene?.scan?.webModelHashes[0] : undefined;
  useEffect(() => {
    if (scanHash === undefined) return;
    let cancelled = false;
    runtime
      .scan(scanHash)
      .then((bytes) => {
        if (!cancelled) setLoadedScan({ hash: scanHash, bytes });
      })
      .catch(() => {
        // 扫描下载失败时原始视图保持空白。
      });
    return () => {
      cancelled = true;
    };
  }, [scanHash, runtime]);
  const scan = loadedScan !== null && loadedScan.hash === scanHash ? loadedScan.bytes : null;

  const content = useMemo<SceneContent | null>(() => {
    if (state.status !== 'ready') return null;
    if (state.seq === null) return { mode, members: [], links: [] };
    if (scene === null) return null;
    const view = selectView(scene, mode, style);
    // 原始视图要等扫描下载完再交给查看器，避免先画一个空场景。
    if (view.showScan && scan === null) return null;
    return {
      mode,
      members: [
        {
          spaceId,
          name: info?.name,
          view,
          scan,
          scanTransform: scene.scan?.transform,
          placement: IDENTITY_PLACEMENT,
        },
      ],
      links: [],
    };
  }, [state.status, state.seq, scene, mode, style, scan, spaceId, info?.name]);

  const visuals = useMemo(
    () =>
      buildVisuals(
        [
          {
            spaceId,
            types: info?.eventTypes ?? [],
            events: state.events,
            states: state.states,
          },
        ],
        { at: time, windowMs },
      ),
    [spaceId, info?.eventTypes, state.events, state.states, time, windowMs],
  );

  const heights = useMemo(() => (scene ? sceneHeightRange(scene) : { min: 0, max: 3 }), [scene]);
  const ceiling = useMemo(() => (scene ? ceilingCutHeight(scene) : null), [scene]);
  const cutHeight = effectiveCutHeight(cutChoice, defaultCutHeight(mode, ceiling, scanCeiling));
  const nowMs = now();
  const range = useMemo(
    () =>
      timelineRange(
        state.commits.map((c) => toMillis(c.at)),
        nowMs,
        time,
      ),
    [state.commits, nowMs, time],
  );
  const density = useDensity(
    client,
    [spaceId],
    range.from,
    range.to,
    state.changes,
    state.status === 'ready',
  );

  if (state.status === 'error' && state.error) {
    return (
      <ErrorCard
        title="打不开这个空间"
        message={state.error.message}
        notFound={state.error.notFound}
        hint={
          !hasShareToken && state.error.notFound
            ? '链接里没有分享令牌（# 后面的 share=…）。'
            : undefined
        }
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  const commit = state.commits.filter((c) => c.seq === state.seq)[0] ?? null;
  const loading = state.status === 'loading' || (state.seq !== null && scene === null);
  return (
    <main className="space" data-space-id={spaceId} data-live={live}>
      <header className="space__bar">
        <div className="space__title">
          <h1>{info?.name ?? '正在加载…'}</h1>
          <p className="space__version">
            {commit
              ? `版本 #${commit.seq} · ${commit.message}`
              : state.status === 'loading'
                ? '正在读取时间线'
                : '这个时刻还没有任何提交'}
          </p>
        </div>
        <div className="space__switches">
          <ViewModeSwitch mode={mode} onChange={setMode} />
          {scene !== null && hasStyleChoice(scene) && (
            <StyleSwitch style={style} disabled={mode === 'raw'} onChange={setStyle} />
          )}
        </div>
        <CutawayControl
          enabled={cutEnabled}
          height={Math.min(cutHeight, heights.max)}
          max={heights.max}
          onToggle={setCutEnabled}
          onHeight={setCutHeight}
        />
        {!embedded && window.self === window.top && (
          <a
            className="space__worker-link"
            href={`/workspace?space=${encodeURIComponent(spaceId)}`}
          >
            请 worker 调整
          </a>
        )}
        <ThemeToggle />
      </header>

      <section className="space__stage" aria-label="三维视图" aria-busy={state.sceneLoading}>
        <Viewer
          content={content}
          visuals={visuals}
          cutaway={cutEnabled ? cutHeight : null}
          onScanCeiling={setScanCeiling}
          loadTexture={loaders.loadTexture}
          loadModel={loaders.loadModel}
          createView={createView}
        />
        {(loading || state.progress !== null) && (
          <LoadingCard
            label={state.progress?.label ?? (state.status === 'loading' ? '读取空间' : '读取版本')}
            done={state.progress?.done}
            total={state.progress?.total}
          />
        )}
        {state.status === 'ready' && state.seq === null && (
          <div className="space__empty" role="status">
            这个时刻还没有任何提交。
          </div>
        )}
        {mode === 'extended' && (
          <div className="space__legend" aria-hidden="true">
            <span className="space__legend-swatch" /> 虚拟区
          </div>
        )}
        {commit && (
          <aside className="space__info" aria-label="当前版本">
            <dl>
              <dt>版本</dt>
              <dd>#{commit.seq}</dd>
              <dt>发布时间</dt>
              <dd>
                <time dateTime={commit.at}>{formatTime(Date.parse(commit.at))}</time>
              </dd>
              {commit.observedAt && (
                <>
                  <dt>拍摄时间</dt>
                  <dd>
                    <time dateTime={commit.observedAt}>
                      {formatTime(Date.parse(commit.observedAt))}
                    </time>
                  </dd>
                </>
              )}
            </dl>
          </aside>
        )}
      </section>

      <TimelineBar
        from={range.from}
        to={range.to}
        time={time}
        commits={state.commits}
        density={density}
        playing={playback.playing}
        speed={playback.speed}
        live={live}
        onSeek={playback.seek}
        onTogglePlay={() => playback.togglePlay(range.from)}
        onSpeedChange={playback.setSpeed}
        onNow={playback.goNow}
      />
    </main>
  );
}
