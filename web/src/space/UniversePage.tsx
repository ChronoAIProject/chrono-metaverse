import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { consumePendingViewerCommand, type ViewerCommand } from '../workspace/viewerActions';
import type { PublicClient } from '../core/api/client';
import type { CommitSummary, UniverseMember, UniverseView } from '../core/api/types';
import { toMillis } from '../core/events';
import {
  hasStyleChoice,
  ceilingCutHeight,
  defaultCutHeight,
  effectiveCutHeight,
  sceneHeightRange,
  selectView,
  selectViewForStyle,
  type MemberContent,
  type SceneContent,
  type ViewMode,
} from '../core/scene';
import {
  resolveSpaceStyles,
  UNIVERSE_THEMES,
  UNIVERSE_LAYOUT_PRESETS,
  applyLayoutPreset,
} from '../core/styles';
import { buildVisuals, type SpaceVisualInput } from '../core/visuals';
import { useAssetLoaders, useDensity, useRuntimeStates, useStableList } from '../data/hooks';
import { SpaceRuntime, runtimeError, type RuntimeError } from '../data/spaceRuntime';
import {
  useViewOverrides,
  memberStylesFromSearch,
  searchWithMemberStyles,
  layoutFromSearch,
  searchWithLayout,
} from '../routing/routes';
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
import { timelineRange } from '../timeline/range';
import { usePlayback } from './usePlayback';
import { ViewerPanel, SettingSection } from './DisplaySettings';
import './SpacePage.css';

/** 回放时查组合修订的最小间隔（组合接口不缓存）。 */
const UNIVERSE_THROTTLE_MS = 500;
/** "现在"模式下多久重新查一次组合（成员各自轮询 /head）。 */
const UNIVERSE_POLL_MS = 15_000;

export interface UniversePageProps {
  readonly universeId: string;
  /** 普通空间包含自身内容和嵌套子空间；旧入口仍可读取早期响应。 */
  readonly native?: boolean;
  readonly onCameraResult?: (success: boolean) => void;
  readonly viewerCommand?: ViewerCommand;
  /** 带组合分享令牌、请求附 `?universe=` 的客户端。 */
  readonly client: PublicClient;
  readonly hasShareToken: boolean;
  readonly createView?: SceneViewFactory;
  readonly now?: () => number;
  /** 默认视图：地址里没有（或不认识）`?view=` 时用它；切回它时地址里不写 view。 */
  readonly initialMode?: ViewMode;
}

type CommitWithSpace = CommitSummary & { readonly spaceId: string; readonly spaceName: string };

/** 请求上下文变化时更换缓存；同一上下文中的历史和重复实例各自保留运行时。 */
class CompositionRuntimeCache {
  private readonly entries = new Map<string, SpaceRuntime>();
  constructor(
    private readonly client: PublicClient,
    private readonly root: string,
    private readonly now: () => number,
  ) {}
  get(member: UniverseMember): SpaceRuntime {
    const key = `${this.root}:${member.spaceId}`;
    let runtime = this.entries.get(key);
    if (!runtime) {
      const scoped = member.sourceSpaceId
        ? this.client.forComposition(member.accessPath ?? null)
        : this.client;
      runtime = new SpaceRuntime(scoped, member.sourceSpaceId ?? member.spaceId, scoped, {
        now: this.now,
        seqSource: 'external',
      });
      this.entries.set(key, runtime);
    }
    return runtime;
  }
}

/**
 * 组合页（设计 4.5、5.5、12）：取 T 时刻生效的组合修订和各成员在 T 时刻的 seq，
 * 按摆放把各成员空间放进同一场景，画出连接；跨空间的送花路线按 correlationId 配对，
 * 沿连接走最短路径，动画时长取两事件的时间差。成员数据都凭组合分享令牌读取。
 */
export function UniversePage({
  universeId,
  native = false,
  onCameraResult,
  viewerCommand,
  client,
  hasShareToken,
  createView,
  now = Date.now,
  initialMode = 'optimized',
}: UniversePageProps) {
  const {
    mode: fallbackMode,
    style: fallbackStyle,
    explicitMode,
    explicitStyle,
    setMode,
    setStyle,
    resetOverrides,
  } = useViewOverrides(initialMode);
  const [themeId, setThemeId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('themeId'),
  );
  const changeTheme = useCallback(
    (id: string) => {
      resetOverrides();
      setThemeId(id);
      const params = new URLSearchParams(window.location.search);
      params.set('themeId', id);
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}?${params}${window.location.hash}`,
      );
    },
    [resetOverrides],
  );
  const [pendingCommand, setPendingCommand] = useState<ViewerCommand>();
  const command = viewerCommand ?? pendingCommand;
  const appliedCommand = useRef('');
  const [appliedCommandId, setAppliedCommandId] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const pending = consumePendingViewerCommand();
      if (pending) setPendingCommand(pending);
    });
    return () => {
      active = false;
    };
  }, []);
  const [memberStyles, setMemberStyles] = useState<ReadonlyMap<string, string>>(() =>
    memberStylesFromSearch(window.location.search),
  );
  const [layoutId, setLayoutId] = useState(() => layoutFromSearch(window.location.search));
  const [memberOffsets, setMemberOffsets] = useState<
    Record<string, readonly [number, number, number, number]>
  >({});
  const [focusedSpaceId, setFocusedSpaceId] = useState<string | null>(null);
  const [focusedAnchor, setFocusedAnchor] = useState<{
    readonly spaceId: string;
    readonly anchorId: string;
  } | null>(null);
  const [overviewRequest, setOverviewRequest] = useState(0);
  const [cutEnabled, setCutEnabled] = useState(true);
  // 剖切高度：null 表示用户还没拖过滑块，按各成员的天花板算默认值（取最高的，只切掉天花板）。
  const [cutChoice, setCutHeight] = useState<number | null>(null);
  // 原始视图里扫描天花板的高度（查看器生成完场景后报告）。
  const [scanCeiling, setScanCeiling] = useState<number | null>(null);
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
      const load = native ? client.scene : client.universe;
      load(
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
          const error = runtimeError(cause);
          if (current && error.notFound) setView({ ...current, members: [], links: [] });
          setError(error);
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
  }, [client, universeId, timeKey, live, attempt, native]);

  // 每个成员空间一个运行时（seq 由组合接口给出），整页共用，成员离开后保留缓存。
  const cache = useMemo(
    () => new CompositionRuntimeCache(client, universeId, now),
    [client, universeId, now],
  );
  const memberIds = useMemo(() => view?.members.map((m) => m.spaceId) ?? [], [view]);
  const memberKey = memberIds.join('\u0000');
  const runtimes = useMemo(
    () => view?.members.map((member) => cache.get(member)) ?? [],
    // 成员的摆放、版本变化不需要重建运行时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberKey, cache],
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

  const runtimeTheme = useMemo(() => {
    const theme = UNIVERSE_THEMES.find((candidate) => candidate.id === themeId);
    if (theme) return theme;
    if (
      themeId &&
      scenes.some((scene, i) =>
        resolveSpaceStyles(scene, infos[i]).some((style) => style.id === themeId),
      )
    )
      return {
        id: themeId,
        name: '全局命名样式',
        description: '统一成员空间样式',
        styleId: themeId,
      };
    return undefined;
  }, [themeId, scenes, infos]);
  const savedTheme = UNIVERSE_THEMES.find((theme) => theme.id === view?.themeId);
  const activeTheme = runtimeTheme ?? savedTheme ?? UNIVERSE_THEMES[0]!;
  const memberLooks = useMemo(
    () =>
      view?.members.map((member, i) => {
        const scene = scenes[i];
        const info = infos[i];
        const requested = [
          memberStyles.get(member.spaceId),
          runtimeTheme?.styleId,
          member.styleId,
          // 显式选择「各自独立」时跳过组合保存的主题。
          runtimeTheme?.id === 'independent' ? undefined : savedTheme?.styleId,
          scene?.defaultStyleId,
          info?.defaultStyleId,
          'arch-realistic',
        ];
        const styles = resolveSpaceStyles(scene, info);
        return requested
          .map((id) => styles.find((candidate) => candidate.id === id))
          .find((candidate) => candidate !== undefined);
      }) ?? [],
    [view, scenes, infos, memberStyles, runtimeTheme, savedTheme],
  );
  const mode =
    explicitMode ??
    (memberLooks.some((look) => look?.mode === 'raw')
      ? 'raw'
      : memberLooks.some((look) => look?.mode === 'extended')
        ? 'extended'
        : memberLooks.some(Boolean)
          ? 'optimized'
          : fallbackMode);
  const style =
    explicitStyle ??
    (activeTheme.styleId ? (memberLooks.find(Boolean)?.rebuiltStyle ?? 'shapes') : fallbackStyle);
  const membersReady =
    view !== null && view.members.every((member, i) => member.seq == null || scenes[i] != null);
  useEffect(() => {
    if (!command || !membersReady || appliedCommand.current === command.id) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      appliedCommand.current = command.id;
      const nextMemberStyles = new Map(memberStyles);
      for (const action of command.actions) {
        if (action.type === 'camera') {
          setFocusedAnchor(null);
          setFocusedSpaceId(null);
        }
        if (action.type === 'mode') setMode(action.value);
        if (action.type === 'style') setStyle(action.value);
        if (action.type === 'cutaway') {
          setCutEnabled(action.height !== null);
          if (action.height !== null) setCutHeight(action.height);
        }
        if (action.type === 'look') {
          if (!action.spaceId) {
            changeTheme(action.styleId);
          } else {
            resetOverrides();
            for (const member of view?.members ?? []) {
              if (member.spaceId === action.spaceId || member.sourceSpaceId === action.spaceId)
                nextMemberStyles.set(member.spaceId, action.styleId);
            }
          }
        }
      }
      setMemberStyles(nextMemberStyles);
      const search = searchWithMemberStyles(window.location.search, nextMemberStyles);
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${search}${window.location.hash}`,
      );
      setAppliedCommandId(command.id);
    });
    return () => {
      active = false;
    };
  }, [command, membersReady, memberStyles, setMode, setStyle, resetOverrides, changeTheme, view]);
  const camera = useMemo(() => {
    if (!command || appliedCommandId !== command.id || !membersReady) return undefined;
    const actions = command.actions.filter((action) => action.type === 'camera');
    return actions.length
      ? {
          id: command.id,
          actions: actions.map((action) => {
            if (action.kind !== 'focus' || !action.spaceId) return action;
            const instance = view?.members.find(
              (member) =>
                member.spaceId === action.spaceId || member.sourceSpaceId === action.spaceId,
            );
            return instance ? { ...action, spaceId: instance.spaceId } : action;
          }),
        }
      : undefined;
  }, [command, appliedCommandId, membersReady, view]);

  // 原始视图：各成员的扫描模型。
  const scanWanted = useMemo(
    () =>
      runtimes.flatMap((runtime, i) => {
        const look = memberLooks[i];
        const showScan = explicitMode
          ? explicitMode === 'raw'
          : (look?.visibleLayers?.includes('scan') ?? (look?.mode ?? fallbackMode) === 'raw');
        if (!showScan) return [];
        const hash = scenes[i]?.scan?.webModelHashes[0];
        return hash === undefined ? [] : [{ runtime, hash }];
      }),
    [explicitMode, memberLooks, fallbackMode, runtimes, scenes],
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

  const placements = useMemo(() => {
    if (!view) return [];
    if (layoutId) {
      const arranged = new Map(
        applyLayoutPreset(
          view.members.filter((member) => member.seq != null),
          layoutId,
          memberOffsets,
        ).map((member) => [member.spaceId, member]),
      );
      return view.members.map((member) => arranged.get(member.spaceId) ?? member);
    }
    return view.members.map((member) => {
      const offset = memberOffsets[member.spaceId];
      return offset
        ? {
            ...member,
            offset: [offset[0], offset[1], offset[2]] as const,
            rotation: offset[3] as 0 | 90 | 180 | 270,
          }
        : member;
    });
  }, [view, layoutId, memberOffsets]);

  const content = useMemo<SceneContent | null>(() => {
    if (view === null) return null;
    const members: MemberContent[] = [];
    placements.forEach((member, i) => {
      const scene = scenes[i];
      if (member.seq === null || member.seq === undefined || !scene) return;
      const namedStyle = memberLooks[i];
      const memberView = namedStyle
        ? selectViewForStyle(
            scene,
            { ...namedStyle, rebuiltStyle: explicitStyle ?? namedStyle.rebuiltStyle ?? 'shapes' },
            explicitMode ?? undefined,
          )
        : selectView(scene, explicitMode ?? fallbackMode, explicitStyle ?? fallbackStyle);
      const hash = scene.scan?.webModelHashes[0];
      members.push({
        spaceId: member.spaceId,
        name: names.get(member.spaceId),
        view: memberView,
        scan: memberView.showScan && hash !== undefined ? (scans.get(hash) ?? null) : null,
        scanTransform: scene.scan?.transform,
        external: scene.external,
        placement: { offset: member.offset, rotation: member.rotation },
      });
    });
    if (members.some((member) => member.view.showScan && member.scan === null)) return null;
    return { mode, members, links: view.links };
  }, [
    view,
    scenes,
    mode,
    explicitMode,
    explicitStyle,
    fallbackMode,
    fallbackStyle,
    scans,
    names,
    placements,
    memberLooks,
  ]);
  // 有成员的重建层既有物件又有区块时才给出"形状 / 方块"切换。
  const styleChoice = scenes.some((scene) => scene != null && hasStyleChoice(scene));

  const visuals = useMemo(() => {
    const inputs: SpaceVisualInput[] = runtimes.map((runtime, i) => ({
      spaceId: memberIds[i] ?? runtime.spaceId,
      sourceSpaceId: runtime.spaceId,
      types: states[i]?.info?.eventTypes ?? [],
      events: states[i]?.events ?? [],
      states: states[i]?.states ?? new Map(),
    }));
    return buildVisuals(inputs, { at: time, windowMs });
  }, [runtimes, states, time, windowMs, memberIds]);

  const commits = useMemo<CommitWithSpace[]>(
    () =>
      runtimes
        .flatMap((runtime, i) =>
          (commitLists[i] ?? []).map((commit) => ({
            ...commit,
            spaceId: memberIds[i] ?? runtime.spaceId,
            spaceName: names.get(memberIds[i] ?? runtime.spaceId) ?? runtime.spaceId,
          })),
        )
        .sort((a, b) => toMillis(a.at) - toMillis(b.at)),
    [runtimes, commitLists, names, memberIds],
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
  const densityClient = useMemo<PublicClient>(
    () => ({
      ...client,
      eventDensity: (instanceId, query) => {
        const member = view?.members.find((member) => member.spaceId === instanceId);
        const scoped = member?.sourceSpaceId
          ? client.forComposition(member.accessPath ?? null)
          : client;
        return scoped.eventDensity(member?.sourceSpaceId ?? instanceId, query);
      },
    }),
    [client, view],
  );
  const density = useDensity(
    densityClient,
    memberIds,
    range.from,
    range.to,
    changes,
    view !== null,
  );
  const heights = useMemo(() => {
    let max = 3;
    states.forEach((state, index) => {
      if (state.scene)
        max = Math.max(
          max,
          sceneHeightRange(state.scene).max + (placements[index]?.offset[1] ?? 0) * 0.05,
        );
    });
    return { min: 0, max };
  }, [states, placements]);
  const ceiling = useMemo(() => {
    let top: number | null = null;
    states.forEach((state, index) => {
      const h = state.scene ? ceilingCutHeight(state.scene) : null;
      const placed = h === null ? null : h + (placements[index]?.offset[1] ?? 0) * 0.05;
      if (placed !== null) top = top === null ? placed : Math.max(top, placed);
    });
    return top;
  }, [states, placements]);
  const cutHeight = effectiveCutHeight(cutChoice, defaultCutHeight(mode, ceiling, scanCeiling));

  if (error !== null && view === null) {
    return (
      <ErrorCard
        title={native ? '打不开这个空间' : '打不开这个组合'}
        message={
          error.notFound
            ? `链接无效，或者${native ? '空间' : '组合'}不存在。请确认链接完整（包含 # 后面的部分）。`
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
    <main
      className="space"
      data-space-id={native ? universeId : undefined}
      data-universe-id={native ? undefined : universeId}
      data-live={live}
    >
      <header className="space__bar">
        <div className="space__title">
          <h1>{view?.name ?? '正在加载…'}</h1>
          <p className="space__version">
            {view
              ? `版本 #${view.seq} · ${view.members.length} 个空间 · ${view.links.length} 条连接`
              : '正在读取组合'}
          </p>
        </div>
        <div className="space__primary-actions">
          <ViewModeSwitch mode={mode} onChange={setMode} />
          <ViewerPanel label="显示设置">
            <SettingSection label="空间样式">
              <div className="segmented" role="group" aria-label="组合样式主题">
                {UNIVERSE_THEMES.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    aria-pressed={activeTheme.id === theme.id}
                    title={theme.description}
                    onClick={() => changeTheme(theme.id)}
                  >
                    {theme.name}
                  </button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label="组合排布预设">
                {UNIVERSE_LAYOUT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={(layoutId ?? 'default') === preset.id}
                    title={preset.description}
                    onClick={() => {
                      setLayoutId(preset.id);
                      const next = searchWithLayout(window.location.search, preset.id);
                      window.history.replaceState(
                        window.history.state,
                        '',
                        `${window.location.pathname}${next}${window.location.hash}`,
                      );
                    }}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
              {styleChoice && (
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
          camera={camera}
          visuals={visuals}
          cutaway={cutEnabled ? cutHeight : null}
          onScanCeiling={setScanCeiling}
          onCameraResult={onCameraResult}
          loadTexture={loaders.loadTexture}
          loadModel={loaders.loadModel}
          createView={createView}
          overviewRequest={overviewRequest}
          focusedSpaceId={focusedSpaceId}
          focusedAnchor={focusedAnchor}
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
        {error && view !== null && !error.notFound && (
          <div className="space__empty" role="status">
            {error.message}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
        {memberErrors > 0 && (
          <div className="space__empty" role="status">
            有 {memberErrors} 个成员空间读取失败。
          </div>
        )}
        {view && view.members.length > 0 && (
          <ViewerPanel label="空间导览" className="viewer-panel--navigation">
            <aside className="space__members" aria-label="成员空间">
              <dl>
                {view.members.map((member, i) => (
                  <div key={member.spaceId} className="space__info-row">
                    <dt>{names.get(member.spaceId)}</dt>
                    <dd>
                      <span>{member.seq != null ? `版本 #${member.seq}` : '还没有提交'}</span>
                      <div className="space__member-actions">
                        <button
                          type="button"
                          onClick={() => {
                            setFocusedAnchor(null);
                            if (focusedSpaceId === member.spaceId)
                              setOverviewRequest((value) => value + 1);
                            setFocusedSpaceId(
                              focusedSpaceId === member.spaceId ? null : member.spaceId,
                            );
                          }}
                        >
                          {focusedSpaceId === member.spaceId ? '全景' : '聚焦'}
                        </button>
                        <select
                          aria-label={`${names.get(member.spaceId)} 样式`}
                          value={memberStyles.get(member.spaceId) ?? ''}
                          onChange={(event) => {
                            resetOverrides();
                            const next = new Map(memberStyles);
                            if (event.target.value) next.set(member.spaceId, event.target.value);
                            else next.delete(member.spaceId);
                            setMemberStyles(next);
                            const search = searchWithMemberStyles(window.location.search, next);
                            window.history.replaceState(
                              window.history.state,
                              '',
                              `${window.location.pathname}${search}${window.location.hash}`,
                            );
                          }}
                        >
                          <option value="">跟随组合</option>
                          {resolveSpaceStyles(scenes[i], infos[i]).map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <details className="space__placement">
                        <summary>排布微调</summary>
                        <label>
                          旋转
                          <select
                            aria-label={`${names.get(member.spaceId)} 旋转`}
                            value={placements[i]?.rotation ?? member.rotation}
                            onChange={(event) => {
                              const current = [
                                ...(placements[i]?.offset ?? member.offset),
                                placements[i]?.rotation ?? member.rotation,
                              ] as const;
                              setMemberOffsets((offsets) => ({
                                ...offsets,
                                [member.spaceId]: [
                                  current[0],
                                  current[1],
                                  current[2],
                                  Number(event.target.value),
                                ],
                              }));
                            }}
                          >
                            {[0, 90, 180, 270].map((rotation) => (
                              <option key={rotation} value={rotation}>
                                {rotation}°
                              </option>
                            ))}
                          </select>
                        </label>
                        {(['X', 'Z'] as const).map((axis) => (
                          <label key={axis}>
                            {axis}
                            <input
                              type="number"
                              step="1"
                              aria-label={`${names.get(member.spaceId)} ${axis} 偏移`}
                              value={(placements[i]?.offset ?? member.offset)[axis === 'X' ? 0 : 2]}
                              onChange={(event) => {
                                const current = [
                                  ...(placements[i]?.offset ?? member.offset),
                                  placements[i]?.rotation ?? member.rotation,
                                ] as const;
                                const next: [number, number, number, number] = [...current];
                                next[axis === 'X' ? 0 : 2] = Number(event.target.value);
                                setMemberOffsets((offsets) => ({
                                  ...offsets,
                                  [member.spaceId]: next,
                                }));
                              }}
                            />
                          </label>
                        ))}
                      </details>
                    </dd>
                  </div>
                ))}
              </dl>
              <button
                type="button"
                className="space__overview"
                onClick={() => {
                  setFocusedSpaceId(null);
                  setFocusedAnchor(null);
                  setOverviewRequest((value) => value + 1);
                }}
              >
                全景总览
              </button>
              {view.links.length > 0 && (
                <div className="space__links">
                  <strong>跨空间连接</strong>
                  {view.links.flatMap((link, index) => {
                    const directions =
                      link.from.spaceId === link.to.spaceId &&
                      link.from.anchorId === link.to.anchorId
                        ? [[link.from, link.to] as const]
                        : ([
                            [link.from, link.to],
                            [link.to, link.from],
                          ] as const);
                    return directions.map(([here, there], direction) => (
                      <button
                        key={`${index}:${direction}`}
                        type="button"
                        title={`跳转到${names.get(there.spaceId)}`}
                        onClick={() => {
                          setFocusedSpaceId(there.spaceId);
                          setFocusedAnchor({ spaceId: there.spaceId, anchorId: there.anchorId });
                        }}
                      >
                        {link.kind === 'door'
                          ? '门洞'
                          : link.kind === 'portal'
                            ? '传送门'
                            : '街区通道'}{' '}
                        · {names.get(here.spaceId)} → {names.get(there.spaceId)}
                      </button>
                    ));
                  })}
                </div>
              )}
            </aside>
          </ViewerPanel>
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
