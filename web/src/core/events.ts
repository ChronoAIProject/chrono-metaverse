import type {
  AnchorState,
  CommitSummary,
  DensityBucket,
  EventTypeDef,
  SpaceEvent,
  Timestamp,
} from './api/types';

/**
 * 事件回放的纯函数（设计 5.3–5.5）。
 *
 * - 更正：`corrects` 一律指向最初那条事件；同一事件有多条更正时，以 recordedAt 最新的为准。
 *   替换是完整的新记录（at 与原事件相同），撤回是 `retracted: true`。
 * - 公开过滤顺序：先应用更正，再按可见级别过滤。公开接口返回的已经是服务端的公开投影
 *   （不带 visibility），网站拿到后只丢掉显式标成内部级的记录，不再按类型默认级别过滤。
 * - 状态事件：对每个 (锚点, 状态 key) 取 at ≤ T 的最后一条有效事件，不受时间窗限制；
 *   超过 maxAgeSec 没有更新的状态自动失效。
 */

export function toMillis(time: Timestamp | number | Date): number {
  if (typeof time === 'number') return time;
  if (time instanceof Date) return time.getTime();
  const value = Date.parse(time);
  if (Number.isNaN(value)) throw new RangeError(`无效的时间：${time}`);
  return value;
}

/** 生效的事件：保留最初那条的编号，内容取最新的替换版本。 */
export interface EffectiveEvent extends SpaceEvent {
  /** 生效内容来自哪条记录（原事件或某条更正）。 */
  readonly revisionId: string;
}

export interface EffectiveOptions {
  /**
   * 只要公开级的（在应用更正之后过滤）。
   *
   * 公开接口返回的事件已经按生效的可见级别过滤过，并且不带 `visibility`——其中可能有
   * 类型默认内部级、写入时显式标成公开的事件。对这种数据不要传 `types`：这时只丢掉
   * 显式写了 `visibility: 'internal'` 的记录，没写的一律当公开。
   */
  readonly publicOnly?: boolean;
  /**
   * 全部事件类型（含各版本）。只在手里是原始记录时传（夹具模拟服务端）：没写 visibility
   * 的事件按服务端的规则取 (type, typeVersion) 那个版本的默认级别，类型或版本找不到时按内部级。
   */
  readonly types?: readonly EventTypeDef[];
}

/**
 * 生效的可见级别：事件自己写的优先；否则给了 `types` 时取事件记录的那个版本的默认级别
 * （与接口服务 `effective_visibility` 相同，找不到按内部级），没给时当公开。
 */
function visibilityOf(event: SpaceEvent, types?: readonly EventTypeDef[]): 'public' | 'internal' {
  if (event.visibility) return event.visibility;
  if (types === undefined) return 'public';
  const def =
    event.typeVersion === undefined
      ? typeOf(types, event.type)
      : types.find((t) => t.type === event.type && t.version === event.typeVersion);
  if (def === undefined) return 'internal';
  return def.defaultVisibility ?? 'public';
}

/** 应用更正和撤回，按 at（再按编号）排序。 */
export function effectiveEvents(
  events: readonly SpaceEvent[],
  options: EffectiveOptions = {},
): EffectiveEvent[] {
  const originals = new Map<string, SpaceEvent>();
  const latestCorrection = new Map<string, SpaceEvent>();
  for (const event of events) {
    if (event.withdrawn) continue;
    if (event.corrects === undefined) {
      originals.set(event.id, event);
      continue;
    }
    const current = latestCorrection.get(event.corrects);
    if (
      current === undefined ||
      toMillis(event.recordedAt) > toMillis(current.recordedAt) ||
      (toMillis(event.recordedAt) === toMillis(current.recordedAt) && event.id > current.id)
    ) {
      latestCorrection.set(event.corrects, event);
    }
  }
  const out: EffectiveEvent[] = [];
  for (const [id, original] of originals) {
    const correction = latestCorrection.get(id);
    if (correction?.retracted) continue;
    const source = correction ?? original;
    const effective: EffectiveEvent = {
      ...source,
      id,
      corrects: undefined,
      // 替换版本的 at 与原事件相同；以原事件为准，防止更正把事件挪到别的时刻。
      at: original.at,
      revisionId: source.id,
    };
    if (options.publicOnly && visibilityOf(effective, options.types) !== 'public') continue;
    if (effective.redacted) out.push({ ...effective, data: undefined });
    else out.push(effective);
  }
  return out.sort(
    (a, b) => toMillis(a.at) - toMillis(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** T 附近时间窗内的瞬时事件：[T - before, T + after]。 */
export function eventsInWindow<E extends SpaceEvent>(
  events: readonly E[],
  at: Timestamp | number,
  beforeMs: number,
  afterMs = 0,
): E[] {
  const t = toMillis(at);
  return events.filter((event) => {
    const time = toMillis(event.at);
    return time >= t - beforeMs && time <= t + afterMs;
  });
}

/**
 * 按点分路径取 data 里的值，例如 `status` 或 `party.size`（与接口服务的 `value_at_path` 相同）。
 * 路径中途不是对象时返回 undefined。
 */
export function valueAtPath(
  data: Readonly<Record<string, unknown>> | undefined,
  path: string,
): unknown {
  let current: unknown = data;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 事件的状态值：类型定义了 `state.value`（data 里的点分路径）时取那个值，取不到是 null；
 * 没定义时就是事件类型。与接口服务的状态折叠相同。
 */
function stateValue(event: SpaceEvent, def: EventTypeDef): unknown {
  const path = def.state?.value;
  if (path === undefined) return event.type;
  const value = valueAtPath(event.data, path);
  return value === undefined ? null : value;
}

/**
 * T 时刻各锚点的状态（设计 5.5）。传入的事件应当已经应用过更正（effectiveEvents）。
 * 返回 锚点 → 状态 key → 状态。
 */
export function stateAt(
  events: readonly SpaceEvent[],
  types: readonly EventTypeDef[],
  at: Timestamp | number,
): Map<string, Map<string, AnchorState>> {
  const t = toMillis(at);
  const latest = new Map<string, { event: SpaceEvent; def: EventTypeDef }>();
  for (const event of events) {
    // 按事件记录的版本取规则（同一类型各版本的 state 可以不同）。
    const def = typeOf(types, event.type, event.typeVersion);
    if (def?.state === undefined) continue;
    const time = toMillis(event.at);
    if (time > t) continue;
    const key = `${event.anchorId}\u0000${def.state.key}`;
    const current = latest.get(key);
    if (current === undefined || time >= toMillis(current.event.at))
      latest.set(key, { event, def });
  }
  const result = new Map<string, Map<string, AnchorState>>();
  for (const { event, def } of latest.values()) {
    if (def.state?.clears) continue;
    if (def.maxAgeSec !== undefined && t - toMillis(event.at) > def.maxAgeSec * 1000) continue;
    const states = result.get(event.anchorId) ?? new Map<string, AnchorState>();
    states.set(def.state!.key, {
      anchorId: event.anchorId,
      key: def.state!.key,
      value: stateValue(event, def),
      at: event.at,
      eventId: event.id,
      type: event.type,
    });
    result.set(event.anchorId, states);
  }
  return result;
}

/** 本地计算事件密度（聚合接口不可用时的兜底，也用于测试夹具）。 */
export function densityBuckets(
  events: readonly SpaceEvent[],
  from: Timestamp | number,
  to: Timestamp | number,
  bucketMs: number,
): DensityBucket[] {
  const start = toMillis(from);
  const end = toMillis(to);
  if (!(bucketMs > 0) || end <= start) return [];
  const count = Math.ceil((end - start) / bucketMs);
  const buckets = Array.from({ length: count }, (_, i) => ({
    start: new Date(start + i * bucketMs).toISOString(),
    count: 0,
  }));
  for (const event of events) {
    const time = toMillis(event.at);
    if (time < start || time >= end) continue;
    buckets[Math.floor((time - start) / bucketMs)]!.count += 1;
  }
  return buckets;
}

/**
 * "现在"模式的增量合并：按编号去重（游标回退几秒会拿到重复的），
 * 新的覆盖旧的；带"撤下"标记的从结果里删掉。
 */
export function mergeIncremental(
  existing: readonly SpaceEvent[],
  incoming: readonly SpaceEvent[],
): SpaceEvent[] {
  const byId = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) {
    if (event.withdrawn) {
      byId.delete(event.id);
      for (const [id, other] of byId) if (other.corrects === event.id) byId.delete(id);
    } else {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()];
}

/** 增量拉取的游标：最新的 recordedAt 往回退 `backoffMs`（默认 5 秒），再按编号去重。 */
export function incrementalCursor(
  events: readonly SpaceEvent[],
  backoffMs = 5000,
): Timestamp | null {
  let latest = -Infinity;
  for (const event of events) latest = Math.max(latest, toMillis(event.recordedAt));
  return Number.isFinite(latest) ? new Date(latest - backoffMs).toISOString() : null;
}

/** T 时刻生效的提交：at ≤ T 的最后一个（提交按 seq 排序，at 随 seq 单调不减）。 */
export function commitAt(
  commits: readonly CommitSummary[],
  at: Timestamp | number,
): CommitSummary | null {
  const t = toMillis(at);
  let found: CommitSummary | null = null;
  for (const commit of commits) {
    if (toMillis(commit.at) <= t && (found === null || commit.seq > found.seq)) found = commit;
  }
  return found;
}

/** 锚点 → 状态 key → 状态。 */
export type StateMap = ReadonlyMap<string, ReadonlyMap<string, AnchorState>>;

/** `state?at=` 的结果整理成按锚点、状态 key 索引的表。 */
export function stateMapFrom(states: readonly AnchorState[]): StateMap {
  const map = new Map<string, Map<string, AnchorState>>();
  for (const state of states) {
    const entry = map.get(state.anchorId) ?? new Map<string, AnchorState>();
    entry.set(state.key, state);
    map.set(state.anchorId, entry);
  }
  return map;
}

function typeOf(types: readonly EventTypeDef[], type: string | undefined, version?: number) {
  let best: EventTypeDef | undefined;
  for (const def of types) {
    if (def.type !== type) continue;
    if (version !== undefined && def.version === version) return def;
    if (best === undefined || def.version > best.version) best = def;
  }
  return best;
}

/**
 * "现在"模式：在 `state?at=<baseAt>` 的结果上叠加增量拉到的事件（设计 5.5）。
 *
 * - 新事件（时间不早于该锚点、该 key 当前状态的时间）直接改写状态，清除类事件删掉状态；
 * - 改的是当前状态那条事件本身（更正）：按更正后的内容改写；
 * - 撤回、撤下了当前状态的那条事件，或者晚到的事件早于 baseAt 而该 key 又没有状态时，
 *   本地无法确定结果，返回 `refetch: true`，由调用方重新取 `state?at=`。
 */
export function advanceStates(
  base: StateMap,
  baseAt: number,
  incoming: readonly SpaceEvent[],
  types: readonly EventTypeDef[],
  at: number,
): { readonly states: StateMap; readonly refetch: boolean } {
  const states = new Map<string, Map<string, AnchorState>>();
  for (const [anchorId, entry] of base) states.set(anchorId, new Map(entry));
  const holders = () => {
    const ids = new Set<string>();
    for (const entry of states.values()) for (const state of entry.values()) ids.add(state.eventId);
    return ids;
  };
  let refetch = false;
  const ordered = [...incoming].sort((a, b) => {
    const ta = a.at === undefined ? 0 : toMillis(a.at);
    const tb = b.at === undefined ? 0 : toMillis(b.at);
    return ta - tb || toMillis(a.recordedAt) - toMillis(b.recordedAt);
  });
  for (const event of ordered) {
    const target = event.corrects ?? event.id;
    if (event.withdrawn || event.retracted || event.redacted) {
      if (holders().has(target)) refetch = true;
      continue;
    }
    const def = typeOf(types, event.type, event.typeVersion);
    if (def?.state === undefined || event.anchorId === undefined || event.at === undefined) {
      continue;
    }
    const time = toMillis(event.at);
    if (time > at) continue;
    const entry = states.get(event.anchorId) ?? new Map<string, AnchorState>();
    const current = entry.get(def.state.key);
    const replacesCurrent = current?.eventId === target;
    if (!replacesCurrent) {
      if (current !== undefined && time < toMillis(current.at)) continue;
      if (current === undefined && time < baseAt) {
        refetch = true;
        continue;
      }
    }
    if (def.state.clears) {
      entry.delete(def.state.key);
    } else {
      entry.set(def.state.key, {
        anchorId: event.anchorId,
        key: def.state.key,
        value: stateValue(event, def),
        at: event.at,
        eventId: target,
        type: event.type,
        typeVersion: event.typeVersion,
        data: event.data,
      });
    }
    states.set(event.anchorId, entry);
  }
  for (const [anchorId, entry] of states) if (entry.size === 0) states.delete(anchorId);
  return { states, refetch };
}
