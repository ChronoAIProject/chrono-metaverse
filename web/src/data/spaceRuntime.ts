import {
  allEvents,
  allTimeline,
  type ProgressCallback,
  type PublicClient,
} from '../core/api/client';
import type { CommitSummary, SpaceEvent, SpaceInfo } from '../core/api/types';
import {
  advanceStates,
  commitAt,
  effectiveEvents,
  mergeIncremental,
  stateMapFrom,
  toMillis,
  type EffectiveEvent,
  type StateMap,
} from '../core/events';
import { loadScene, type SceneDocument } from '../core/scene';
import { eventLookMs } from '../core/visuals';

/**
 * 一个空间在查看器里的全部数据，和界面框架无关（单空间页用一个，组合页每个成员一个）：
 *
 * - 空间信息、全部提交（按 `nextAfter` 取完）；
 * - 时刻 T 的场景：用提交列表把 T 换算成 seq，再取 `snapshot?seq=`（按 seq 缓存，
 *   来回拖动不重复下载；不走 `?at=` 跳转）。组合页的 seq 由组合接口给出；
 * - 回放：按 6 小时一段取 T 前后的事件（每次请求 ≤ 24 小时、按页取完），锚点状态取 `state?at=T`（节流）；
 * - "现在"模式（设计 5.5）：先取 `state?at=now` 和最近一段事件，然后至少每 5 秒带
 *   If-None-Match 查一次 `/head`（304 不处理）；有变化时按 `since=<recordedAt 游标>` 增量拉事件，
 *   游标往回退 5 秒、按事件编号去重，"撤下"标记删除事件；seq 变了就补拉提交、换新快照。
 */

export const HEAD_POLL_MS = 5000;
/** 回放取事件的分段长度。 */
const BUCKET_MS = 6 * 3_600_000;
/** 最多同时缓存的事件段数。 */
const MAX_BUCKETS = 48;
/** 增量游标往回退多少。 */
const CURSOR_BACKOFF_MS = 5000;
const STATE_THROTTLE_MS = 400;
const EVENTS_DEBOUNCE_MS = 120;

export interface AssetSource {
  chunk(hash: string): Promise<Uint16Array>;
  asset(hash: string, onProgress?: ProgressCallback): Promise<ArrayBuffer>;
}

export interface LoadProgress {
  readonly label: string;
  readonly done: number;
  readonly total: number;
}

export interface RuntimeError {
  readonly message: string;
  readonly notFound: boolean;
}

export interface RuntimeState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: RuntimeError | null;
  readonly info: SpaceInfo | null;
  readonly commits: readonly CommitSummary[];
  /** 当前时刻要显示的 seq；时刻早于第一次提交时为 null。 */
  readonly seq: number | null;
  /** 最近一次加载完成的场景（换版本时先保留旧的，新的到了再换，画面不闪）。 */
  readonly scene: SceneDocument | null;
  readonly sceneLoading: boolean;
  readonly progress: LoadProgress | null;
  /** T 附近的有效事件（已应用更正、只含公开级）。 */
  readonly events: readonly EffectiveEvent[];
  /** T 时刻的锚点状态。 */
  readonly states: StateMap;
  readonly live: boolean;
  /** 每次 head 有变化加一（事件密度据此刷新）。 */
  readonly changes: number;
}

export interface RuntimeOptions {
  readonly now?: () => number;
  /** `/head` 轮询间隔，至少 5 秒。 */
  readonly pollMs?: number;
  /** 'timeline'：seq 由提交列表换算；'external'：由 setSeq 给出（组合页）。 */
  readonly seqSource?: 'timeline' | 'external';
}

/** 404 一律当作"链接无效或空间不存在"，不暴露是哪一种。 */
export function runtimeError(error: unknown): RuntimeError {
  const status = (error as { status?: number }).status;
  if (status === 404) {
    return {
      message: '链接无效，或者空间不存在。请确认链接完整（包含 # 后面的部分）。',
      notFound: true,
    };
  }
  if (error instanceof TypeError) {
    return { message: '网络连接失败，请检查网络后重试。', notFound: false };
  }
  return { message: error instanceof Error ? error.message : String(error), notFound: false };
}

const iso = (t: number) => new Date(t).toISOString();

function latestRecordedAt(events: readonly SpaceEvent[]): number | null {
  let latest = -Infinity;
  for (const event of events) latest = Math.max(latest, toMillis(event.recordedAt));
  return Number.isFinite(latest) ? latest : null;
}

export class SpaceRuntime {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly seqSource: 'timeline' | 'external';
  private readonly listeners = new Set<() => void>();
  private readonly scenes = new Map<number, Promise<SceneDocument>>();
  private readonly scans = new Map<string, Promise<ArrayBuffer>>();
  private readonly buckets = new Map<number, Promise<SpaceEvent[]>>();
  private readonly bucketData = new Map<number, SpaceEvent[]>();
  private state: RuntimeState = {
    status: 'loading',
    error: null,
    info: null,
    commits: [],
    seq: null,
    scene: null,
    sceneLoading: false,
    progress: null,
    events: [],
    states: new Map(),
    live: false,
    changes: 0,
  };
  private time: number;
  private windowMs = 0;
  private externalSeq: number | null = null;
  private started = false;
  /** start 之后、stop 之前为 true；停下时不再发起新的请求和定时器。 */
  private active = false;
  // 回放
  private eventsTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStateFetch = 0;
  private replayToken = 0;
  private stateToken = 0;
  // "现在"模式
  private liveToken = 0;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private liveStartedAt = 0;
  private liveRaw: SpaceEvent[] = [];
  private liveSeen = new Map<string, string>();
  private liveStates: StateMap = new Map();
  private liveBaseAt = 0;
  private etag: string | null = null;
  private cursor: number | null = null;
  private headRecordedAt: string | null = null;
  private headSeq: number | null = null;
  private polling = false;

  constructor(
    readonly client: PublicClient,
    readonly spaceId: string,
    private readonly assets: AssetSource = client,
    options: RuntimeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pollMs = Math.max(HEAD_POLL_MS, options.pollMs ?? HEAD_POLL_MS);
    this.seqSource = options.seqSource ?? 'timeline';
    this.time = this.now();
  }

  // ---------------------------------------------------------------------------
  // 订阅
  // ---------------------------------------------------------------------------

  getState(): RuntimeState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private get types() {
    return this.state.info?.eventTypes ?? [];
  }

  // ---------------------------------------------------------------------------
  // 加载
  // ---------------------------------------------------------------------------

  /**
   * 开始（取空间信息和全部提交）。可以在 stop 之后再次调用（React 严格模式会先挂载、
   * 卸载、再挂载一次）：已经取到的数据和缓存保留。
   */
  start(): void {
    this.active = true;
    if (this.started) {
      this.refresh();
      return;
    }
    this.started = true;
    Promise.all([this.client.space(this.spaceId), allTimeline(this.client, this.spaceId)])
      .then(([info, commits]) => {
        this.update({ info, commits, status: 'ready' });
        this.refresh();
      })
      .catch((error: unknown) => this.update({ status: 'error', error: runtimeError(error) }));
  }

  /** 补拉 seq 变化后的新提交（从最后一次提交的时间开始，按 seq 合并）。 */
  private async refreshTimeline(): Promise<void> {
    const commits = this.state.commits;
    const last = commits[commits.length - 1];
    const fresh = await allTimeline(this.client, this.spaceId, last ? { from: last.at } : {});
    const bySeq = new Map(commits.map((c) => [c.seq, c]));
    for (const commit of fresh) bySeq.set(commit.seq, commit);
    this.update({ commits: [...bySeq.values()].sort((a, b) => a.seq - b.seq) });
  }

  /** 时刻和模式。live 为 true 时 t 应当是当前时间。 */
  setTime(t: number, live: boolean, windowMs = 0): void {
    this.time = t;
    this.windowMs = windowMs;
    if (this.active && live !== this.state.live) {
      if (live) this.startLive();
      else this.stopLive();
      this.update({ live });
    }
    this.refresh();
  }

  /** 组合页：组合接口给出的该成员在 T 时刻的 seq。 */
  setSeq(seq: number | null): void {
    this.externalSeq = seq;
    this.refresh();
  }

  private refresh(): void {
    if (!this.active || this.state.status !== 'ready') return;
    const seq =
      this.seqSource === 'external'
        ? this.externalSeq
        : (commitAt(this.state.commits, this.time)?.seq ?? null);
    if (seq !== this.state.seq) this.update({ seq });
    this.ensureScene(seq);
    if (this.state.live) this.updateLiveView();
    else this.scheduleReplay();
  }

  private ensureScene(seq: number | null): void {
    if (seq === null) {
      if (this.state.sceneLoading) this.update({ sceneLoading: false });
      return;
    }
    if (this.state.scene?.seq === seq) return;
    let pending = this.scenes.get(seq);
    if (pending === undefined) {
      this.update({ progress: { label: '读取版本', done: 0, total: 1 } });
      pending = this.client.snapshot(this.spaceId, { seq }).then((snapshot) =>
        loadScene(this.assets, snapshot, this.state.info?.name, (done, total) => {
          if (total > 0) this.update({ progress: { label: '下载区块', done, total } });
        }),
      );
      this.scenes.set(seq, pending);
      pending.catch(() => this.scenes.delete(seq));
    }
    this.update({ sceneLoading: true });
    pending
      .then((scene) => {
        if (this.state.seq !== seq) return;
        this.update({ scene, sceneLoading: false, progress: null });
      })
      .catch((error: unknown) => {
        if (this.state.seq !== seq) return;
        this.update({ status: 'error', error: runtimeError(error), sceneLoading: false });
      });
  }

  /** 扫描模型（网页用 glb），按哈希缓存，下载进度写进 progress。 */
  scan(hash: string): Promise<ArrayBuffer> {
    let pending = this.scans.get(hash);
    if (pending === undefined) {
      pending = this.assets.asset(hash, (loaded, total) => {
        const kb = (n: number) => Math.round(n / 1024);
        this.update({
          progress:
            total !== null && loaded >= total
              ? null
              : { label: '下载扫描模型（KB）', done: kb(loaded), total: kb(total ?? loaded * 2) },
        });
      });
      this.scans.set(hash, pending);
      pending.catch(() => {
        this.scans.delete(hash);
        this.update({ progress: null });
      });
    }
    return pending;
  }

  // ---------------------------------------------------------------------------
  // 回放：事件和状态
  // ---------------------------------------------------------------------------

  private scheduleReplay(): void {
    if (this.eventsTimer !== null) clearTimeout(this.eventsTimer);
    this.eventsTimer = setTimeout(() => {
      this.eventsTimer = null;
      void this.loadReplayEvents();
    }, EVENTS_DEBOUNCE_MS);
    if (this.stateTimer !== null) clearTimeout(this.stateTimer);
    const wait = Math.max(0, STATE_THROTTLE_MS - (Date.now() - this.lastStateFetch));
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.loadReplayState();
    }, wait);
  }

  private bucket(index: number): Promise<SpaceEvent[]> {
    let pending = this.buckets.get(index);
    if (pending === undefined) {
      pending = allEvents(this.client, this.spaceId, {
        from: iso(index * BUCKET_MS),
        to: iso((index + 1) * BUCKET_MS),
      });
      this.buckets.set(index, pending);
      pending
        .then((events) => this.bucketData.set(index, events))
        .catch(() => this.buckets.delete(index));
    }
    return pending;
  }

  private evictBuckets(center: number): void {
    if (this.buckets.size <= MAX_BUCKETS) return;
    const far = [...this.buckets.keys()].sort(
      (a, b) => Math.abs(b - center) - Math.abs(a - center),
    );
    for (const index of far.slice(0, this.buckets.size - MAX_BUCKETS)) {
      this.buckets.delete(index);
      this.bucketData.delete(index);
    }
  }

  private async loadReplayEvents(): Promise<void> {
    const token = ++this.replayToken;
    const t = this.time;
    const look = eventLookMs(this.types, this.windowMs);
    const first = Math.floor((t - look.before) / BUCKET_MS);
    const last = Math.floor((t + look.after) / BUCKET_MS);
    try {
      await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this.bucket(first + i)));
    } catch {
      // 事件取不到时不影响场景显示，下一次拖动再试。
      return;
    }
    if (token !== this.replayToken || this.state.live) return;
    this.evictBuckets(Math.floor(t / BUCKET_MS));
    const raw: SpaceEvent[] = [];
    for (let index = first; index <= last; index += 1)
      raw.push(...(this.bucketData.get(index) ?? []));
    const deduped = [...new Map(raw.map((event) => [event.id, event])).values()];
    const events = effectiveEvents(deduped, { publicOnly: true, types: this.types }).filter(
      (event) => {
        const at = toMillis(event.at);
        return at >= t - look.before && at <= t + look.after;
      },
    );
    this.update({ events });
  }

  private async loadReplayState(): Promise<void> {
    const token = ++this.stateToken;
    this.lastStateFetch = Date.now();
    try {
      const result = await this.client.state(this.spaceId, iso(this.time));
      // 期间又发了新的请求，或者回到了"现在"模式：这次的结果作废。
      if (token !== this.stateToken || this.state.live) return;
      this.update({ states: stateMapFrom(result.states) });
    } catch {
      // 状态取不到时不影响场景显示。
    }
  }

  // ---------------------------------------------------------------------------
  // "现在"模式
  // ---------------------------------------------------------------------------

  private startLive(): void {
    const token = ++this.liveToken;
    this.liveStartedAt = this.now();
    void this.bootLive(token);
  }

  private stopLive(): void {
    this.liveToken += 1;
    if (this.liveTimer !== null) clearInterval(this.liveTimer);
    this.liveTimer = null;
    // "现在"模式期间可能有新事件，回放用的最近几段作废重取。
    const look = eventLookMs(this.types, this.windowMs);
    const stale = Math.floor((this.liveStartedAt - look.before) / BUCKET_MS);
    for (const index of [...this.buckets.keys()]) {
      if (index >= stale) {
        this.buckets.delete(index);
        this.bucketData.delete(index);
      }
    }
  }

  private async bootLive(token: number): Promise<void> {
    if (this.state.status !== 'ready') {
      // 空间信息还没到：等加载完再开始。
      await new Promise<void>((resolve) => {
        const off = this.subscribe(() => {
          if (this.state.status !== 'loading') {
            off();
            resolve();
          }
        });
      });
      if (this.getState().status !== 'ready') return;
    }
    if (token !== this.liveToken) return;
    const now = this.now();
    const look = eventLookMs(this.types, this.windowMs);
    try {
      const [head, state, recent] = await Promise.all([
        this.client.head(this.spaceId, null),
        this.client.state(this.spaceId, iso(now)),
        allEvents(this.client, this.spaceId, {
          from: iso(now - Math.min(look.before, 24 * 3_600_000 - 60_000)),
          to: iso(now + 60_000),
        }),
      ]);
      if (token !== this.liveToken) return;
      this.etag = head.etag;
      this.headSeq = head.head?.seq ?? null;
      this.headRecordedAt = head.head?.recordedAt ?? null;
      this.cursor =
        (this.headRecordedAt !== null ? toMillis(this.headRecordedAt) : null) ??
        latestRecordedAt(recent) ??
        now;
      this.liveRaw = mergeIncremental([], recent);
      this.liveSeen = new Map(recent.map((event) => [event.id, event.recordedAt]));
      this.liveStates = stateMapFrom(state.states);
      this.liveBaseAt = now;
      const lastSeq = this.state.commits[this.state.commits.length - 1]?.seq ?? 0;
      if (this.headSeq !== null && this.headSeq !== lastSeq) await this.refreshTimeline();
      if (token !== this.liveToken) return;
      this.refresh();
    } catch {
      // 首次取失败：轮询照常开始，下一轮再补。
    }
    if (token !== this.liveToken) return;
    if (this.liveTimer !== null) clearInterval(this.liveTimer);
    this.liveTimer = setInterval(() => void this.poll(token), this.pollMs);
  }

  /** 一轮 `/head` 轮询。 */
  async poll(token = this.liveToken): Promise<void> {
    if (this.polling || token !== this.liveToken) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.polling = true;
    try {
      const result = await this.client.head(this.spaceId, this.etag);
      if (token !== this.liveToken) return;
      this.etag = result.etag ?? this.etag;
      if (result.notModified || result.head === undefined) return;
      const head = result.head;
      let changed = false;
      if (head.recordedAt !== this.headRecordedAt) {
        this.headRecordedAt = head.recordedAt;
        await this.pullIncremental(token);
        changed = true;
      }
      if (head.seq !== this.headSeq) {
        this.headSeq = head.seq;
        await this.refreshTimeline();
        changed = true;
      }
      if (token !== this.liveToken) return;
      if (changed) {
        this.update({ changes: this.state.changes + 1 });
        this.refresh();
      }
    } catch {
      // 下一轮再试。
    } finally {
      this.polling = false;
    }
  }

  private async pullIncremental(token: number): Promise<void> {
    const since = iso((this.cursor ?? this.now()) - CURSOR_BACKOFF_MS);
    const incoming = await allEvents(this.client, this.spaceId, { since });
    if (token !== this.liveToken) return;
    // 游标回退会拿到已经处理过的：按编号和记录时间去重，只处理新的。
    const fresh = incoming.filter((event) => this.liveSeen.get(event.id) !== event.recordedAt);
    for (const event of fresh) this.liveSeen.set(event.id, event.recordedAt);
    this.liveRaw = mergeIncremental(this.liveRaw, fresh);
    const latest = latestRecordedAt(incoming);
    const headAt = this.headRecordedAt !== null ? toMillis(this.headRecordedAt) : null;
    this.cursor = Math.max(this.cursor ?? 0, latest ?? 0, headAt ?? 0) || this.now();
    const now = this.now();
    const advanced = advanceStates(this.liveStates, this.liveBaseAt, fresh, this.types, now);
    if (advanced.refetch) {
      const state = await this.client.state(this.spaceId, iso(now));
      if (token !== this.liveToken) return;
      this.liveStates = stateMapFrom(state.states);
      this.liveBaseAt = now;
    } else {
      this.liveStates = advanced.states;
    }
    // 只留最近一段，"现在"模式开很久也不会无限增长。
    const look = eventLookMs(this.types, this.windowMs);
    const horizon = now - look.before - 3_600_000;
    this.liveRaw = this.liveRaw.filter(
      (event) => event.at === undefined || toMillis(event.at) >= horizon,
    );
  }

  private updateLiveView(): void {
    const t = this.time;
    const look = eventLookMs(this.types, this.windowMs);
    const events = effectiveEvents(this.liveRaw, { publicOnly: true, types: this.types }).filter(
      (event) => {
        const at = toMillis(event.at);
        return at >= t - look.before && at <= t + 60_000;
      },
    );
    this.update({ events, states: this.liveStates });
  }

  /** 停下所有定时器和进行中的请求结果（可以再 start）。 */
  stop(): void {
    this.active = false;
    this.liveToken += 1;
    this.replayToken += 1;
    this.stateToken += 1;
    if (this.liveTimer !== null) clearInterval(this.liveTimer);
    if (this.eventsTimer !== null) clearTimeout(this.eventsTimer);
    if (this.stateTimer !== null) clearTimeout(this.stateTimer);
    this.liveTimer = null;
    this.eventsTimer = null;
    this.stateTimer = null;
    // 下次 setTime(…, live = true) 时重新进入"现在"模式。
    if (this.state.live) this.state = { ...this.state, live: false };
  }
}
