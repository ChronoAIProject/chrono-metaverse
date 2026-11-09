import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicClient } from '../core/api/client';
import type { CommitSummary, UniverseView } from '../core/api/types';
import { toMillis } from '../core/events';
import {
  hasStyleChoice,
  ceilingCutHeight,
  effectiveCutHeight,
  sceneHeightRange,
  selectView,
  type MemberContent,
  type SceneContent,
  type ViewMode,
} from '../core/scene';
import { buildVisuals, type SpaceVisualInput } from '../core/visuals';
import { useAssetLoaders, useDensity, useRuntimeStates, useStableList } from '../data/hooks';
import { SpaceRuntime, runtimeError, type RuntimeError } from '../data/spaceRuntime';
import { useRebuiltStyle, useViewMode } from '../routing/routes';
import { TimelineBar } from '../timeline/TimelineBar';
import { Viewer, type SceneViewFactory } from '../viewer/Viewer';
import {
  CutawayControl,
  ErrorCard,
  LoadingCard,
  StyleSwitch,
  ThemeToggle,
  ViewModeSwitch,
} from './controls';
import { timelineRange } from './SpacePage';
import { usePlayback } from './usePlayback';
import './SpacePage.css';

/** 回放时查组合修订的最小间隔（组合接口不缓存）。 */
const UNIVERSE_THROTTLE_MS = 500;
/** "现在"模式下多久重新查一次组合（成员各自轮询 /head）。 */
const UNIVERSE_POLL_MS = 15_000;

export interface UniversePageProps {
  readonly universeId: string;
  /** 带组合分享令牌、请求附 `?universe=` 的客户端。 */
  readonly client: PublicClient;
  readonly hasShareToken: boolean;
  readonly createView?: SceneViewFactory;
  readonly now?: () => number;
  /** 默认视图：地址里没有（或不认识）`?view=` 时用它；切回它时地址里不写 view。 */
  readonly initialMode?: ViewMode;
}

type CommitWithSpace = CommitSummary & { readonly spaceId: string; readonly spaceName: string };

/**
 * 组合页（设计 4.5、5.5、12）：取 T 时刻生效的组合修订和各成员在 T 时刻的 seq，
 * 按摆放把各成员空间放进同一场景，画出连接；跨空间的送花路线按 correlationId 配对，
 * 沿连接走最短路径，动画时长取两事件的时间差。成员数据都凭组合分享令牌读取。
 */
export function UniversePage({
  universeId,
  client,
  hasShareToken,
  createView,
  now = Date.now,
  initialMode = 'optimized',
}: UniversePageProps) {
  const [mode, setMode] = useViewMode(initialMode);
  const [style, setStyle] = useRebuiltStyle();
  const [cutEnabled, setCutEnabled] = useState(true);
  // 剖切高度：null 表示用户还没拖过滑块，按各成员的天花板算默认值（取最高的，只切掉天花板）。
  const [cutChoice, setCutHeight] = useState<number | null>(null);
  const [view, setView] = useState<UniverseView | null>(null);
  const [error, setError] = useState<RuntimeError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [scans, setScans] = useState<ReadonlyMap<string, ArrayBuffer>>(new Map());
  const playback = usePlayback(now);
  const { time, live, windowMs } = playback;
  const loaders = useAssetLoaders(client);

  // T 时刻的组合修订：回放时节流，"现在"模式定期重查。
  const lastFetch = useRef(0);
  const timeRef = useRef(time);
  const viewRef = useRef<UniverseView | null>(null);
  useEffect(() => {
    timeRef.current = time;
  }, [time]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const timeKey = live ? 'live' : String(time);
  useEffect(() => {
    let cancelled = false;
    const fetchView = () => {
      lastFetch.current = Date.now();
      client
        .universe(
          universeId,
          live ? new Date(now()).toISOString() : new Date(timeRef.current).toISOString(),
        )
        .then((next) => {
          if (cancelled) return;
          // 内容没变（同一个修订、同样的成员 seq）时保留原对象，场景不必重建。
          setView((current) =>
            current !== null && JSON.stringify(current) === JSON.stringify(next) ? current : next,
          );
          setError(null);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          // 某个时刻组合还不存在（404）时：已经加载过就清空成员，从没加载过就是链接无效。
          const current = viewRef.current;
          if (current === null) setError(runtimeError(cause));
          else setView({ ...current, members: [], links: [] });
        });
    };
    const wait = Math.max(0, UNIVERSE_THROTTLE_MS - (Date.now() - lastFetch.current));
    const timer = setTimeout(fetchView, live ? 0 : wait);
    const poll = live ? setInterval(fetchView, UNIVERSE_POLL_MS) : null;
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
    };
    // now 只用来取当前时间。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, universeId, timeKey, live, attempt]);

  // 每个成员空间一个运行时（seq 由组合接口给出），整页共用，成员离开后保留缓存。
  const [cache] = useState(() => new Map<string, SpaceRuntime>());
  const memberIds = useMemo(() => view?.members.map((m) => m.spaceId) ?? [], [view]);
  const memberKey = memberIds.join('\u0000');
  const runtimes = useMemo(
    () =>
      memberIds.map((spaceId) => {
        let runtime = cache.get(spaceId);
        if (runtime === undefined) {
          runtime = new SpaceRuntime(client, spaceId, client, { now, seqSource: 'external' });
          cache.set(spaceId, runtime);
        }
        return runtime;
      }),
    // memberIds 按拼接后的 key 比较。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberKey, cache, client],
  );
  useEffect(() => {
    for (const runtime of runtimes) runtime.start();
    return () => runtimes.forEach((runtime) => runtime.stop());
  }, [runtimes]);
  useEffect(() => {
    if (view === null) return;
    view.members.forEach((member, i) => runtimes[i]?.setSeq(member.seq ?? null));
  }, [view, runtimes]);
  useEffect(() => {
    for (const runtime of runtimes) runtime.setTime(time, live, windowMs);
  }, [runtimes, time, live, windowMs]);

  const states = useRuntimeStates(runtimes);
  // 只在场景、空间信息、提交列表真的变了时才重算（"现在"模式下事件每秒都在变）。
  const scenes = useStableList(states.map((s) => s.scene));
  const infos = useStableList(states.map((s) => s.info));
  const commitLists = useStableList(states.map((s) => s.commits));

  // 原始视图：各成员的扫描模型。
  const scanWanted = useMemo(
    () =>
      mode !== 'raw'
        ? []
        : runtimes.flatMap((runtime, i) => {
            const hash = scenes[i]?.scan?.webModelHashes[0];
            return hash === undefined ? [] : [{ runtime, hash }];
          }),
    [mode, runtimes, scenes],
  );
  const scanKey = scanWanted.map((s) => s.hash).join(',');
  useEffect(() => {
    let cancelled = false;
    for (const { runtime, hash } of scanWanted) {
      runtime
        .scan(hash)
        .then((bytes) => {
          if (!cancelled) setScans((current) => new Map(current).set(hash, bytes));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // scanWanted 按哈希列表比较。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    view?.members.forEach((member, i) => {
      map.set(member.spaceId, member.name ?? infos[i]?.name ?? member.spaceId);
    });
    return map;
  }, [view, infos]);

  const content = useMemo<SceneContent | null>(() => {
    if (view === null) return null;
    const members: MemberContent[] = [];
    view.members.forEach((member, i) => {
      const scene = scenes[i];
      if (member.seq === null || member.seq === undefined || !scene) return;
      const memberView = selectView(scene, mode, style);
      const hash = scene.scan?.webModelHashes[0];
      members.push({
        spaceId: member.spaceId,
        name: names.get(member.spaceId),
        view: memberView,
        scan: memberView.showScan && hash !== undefined ? (scans.get(hash) ?? null) : null,
        scanTransform: scene.scan?.transform,
        placement: { offset: member.offset, rotation: member.rotation },
      });
    });
    return { mode, members, links: view.links };
  }, [view, scenes, mode, style, scans, names]);
  // 有成员的重建层既有物件又有区块时才给出"形状 / 方块"切换。
  const styleChoice = scenes.some((scene) => scene != null && hasStyleChoice(scene));

  const visuals = useMemo(() => {
    const inputs: SpaceVisualInput[] = runtimes.map((runtime, i) => ({
      spaceId: runtime.spaceId,
      types: states[i]?.info?.eventTypes ?? [],
      events: states[i]?.events ?? [],
      states: states[i]?.states ?? new Map(),
    }));
    return buildVisuals(inputs, { at: time, windowMs });
  }, [runtimes, states, time, windowMs]);

  const commits = useMemo<CommitWithSpace[]>(
    () =>
      runtimes
        .flatMap((runtime, i) =>
          (commitLists[i] ?? []).map((commit) => ({
            ...commit,
            spaceId: runtime.spaceId,
            spaceName: names.get(runtime.spaceId) ?? runtime.spaceId,
          })),
        )
        .sort((a, b) => toMillis(a.at) - toMillis(b.at)),
    [runtimes, commitLists, names],
  );
  const nowMs = now();
  const range = useMemo(
    () =>
      timelineRange(
        commits.map((c) => toMillis(c.at)),
        nowMs,
        time,
      ),
    [commits, nowMs, time],
  );
  const changes = states.reduce((n, s) => n + s.changes, 0);
  const density = useDensity(client, memberIds, range.from, range.to, changes, view !== null);
  const heights = useMemo(() => {
    let max = 3;
    for (const state of states)
      if (state.scene) max = Math.max(max, sceneHeightRange(state.scene).max);
    return { min: 0, max };
  }, [states]);
  const ceiling = useMemo(() => {
    let top: number | null = null;
    for (const state of states) {
      const h = state.scene ? ceilingCutHeight(state.scene) : null;
      if (h !== null) top = top === null ? h : Math.max(top, h);
    }
    return top;
  }, [states]);
  const cutHeight = effectiveCutHeight(cutChoice, ceiling);

  if (error !== null && view === null) {
    return (
      <ErrorCard
        title="打不开这个组合"
        message={
          error.notFound
            ? '链接无效，或者组合不存在。请确认链接完整（包含 # 后面的部分）。'
            : error.message
        }
        notFound={error.notFound}
        hint={
          !hasShareToken && error.notFound ? '链接里没有分享令牌（# 后面的 share=…）。' : undefined
        }
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  const memberErrors = states.filter((s) => s.status === 'error').length;
  const progress = states.find((s) => s.progress !== null)?.progress ?? null;
  const loading =
    view === null ||
    states.some(
      (s, i) => s.status === 'loading' || (view.members[i]?.seq != null && s.scene === null),
    );
  return (
    <main className="space" data-universe-id={universeId} data-live={live}>
      <header className="space__bar">
        <div className="space__title">
          <h1>{view?.name ?? '正在加载…'}</h1>
          <p className="space__version">
            {view
              ? `组合修订 #${view.seq} · ${view.members.length} 个空间 · ${view.links.length} 条连接`
              : '正在读取组合'}
          </p>
        </div>
        <div className="space__switches">
          <ViewModeSwitch mode={mode} onChange={setMode} />
          {styleChoice && (
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
        <ThemeToggle />
      </header>

      <section className="space__stage" aria-label="三维视图">
        <Viewer
          content={content}
          visuals={visuals}
          cutaway={cutEnabled ? cutHeight : null}
          loadTexture={loaders.loadTexture}
          loadModel={loaders.loadModel}
          createView={createView}
        />
        {(loading || progress !== null) && (
          <LoadingCard
            label={progress?.label ?? (view === null ? '读取组合' : '读取成员空间')}
            done={progress?.done}
            total={progress?.total}
          />
        )}
        {view !== null && view.members.length === 0 && (
          <div className="space__empty" role="status">
            这个时刻组合里还没有空间。
          </div>
        )}
        {memberErrors > 0 && (
          <div className="space__empty" role="status">
            有 {memberErrors} 个成员空间读取失败。
          </div>
        )}
        {view && view.members.length > 0 && (
          <aside className="space__info" aria-label="成员空间">
            <dl>
              {view.members.map((member) => (
                <div key={member.spaceId} className="space__info-row">
                  <dt>{names.get(member.spaceId)}</dt>
                  <dd>{member.seq != null ? `版本 #${member.seq}` : '还没有提交'}</dd>
                </div>
              ))}
            </dl>
          </aside>
        )}
      </section>

      <TimelineBar
        from={range.from}
        to={range.to}
        time={time}
        commits={commits}
        density={density}
        playing={playback.playing}
        speed={playback.speed}
        live={live}
        onSeek={playback.seek}
        onTogglePlay={() => playback.togglePlay(range.from)}
        onSpeedChange={playback.setSpeed}
        onNow={playback.goNow}
        markerKey={(commit) => `${(commit as CommitWithSpace).spaceId}:${commit.seq}`}
        markerLabel={(commit) =>
          `${(commit as CommitWithSpace).spaceName} #${commit.seq} ${commit.message}`
        }
      />
    </main>
  );
}
