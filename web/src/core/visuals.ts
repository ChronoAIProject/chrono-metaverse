import type { AnchorState, EventTypeDef, SpaceEvent, UniverseLink } from './api/types';
import { toMillis } from './events';
import type { Rgb } from './shapes/types';

/**
 * 事件可视化（设计 5.4、5.5、12）：把 T 时刻的事件和锚点状态变成一组"要画的东西"。
 *
 * 网站只实现六种显示方式：highlight / icon / label / path / spawnEntity / heat。
 * 新增一种交互 = 登记新的事件类型、组合已有的显示方式，不用改网站代码。
 *
 * - 状态事件（类型带 `state`）：按 T 时刻的状态显示（`state?at=` 的结果），不受时间窗限制；
 *   超过 `maxAgeSec` 没有更新的状态失效；
 * - 瞬时事件：显示 T 之前一个时间窗内的（窗口取 `durationSec` 和调用方给的窗口里大的那个）；
 * - 路线：同一 `correlationId` 的起点（pathRole = origin）和终点（destination）配对，
 *   起点事件必须写在 correlationId 前缀对应的空间里；同一侧有多条时取最新的一条；
 *   两条都在时按两事件的时间差做动画，只有起点时只在起点显示图标；
 * - 热力：每个锚点在 `heat.windowSec` 内的事件按 `weight` 累加，按同一类型的最大值归一化；
 * - 文本一律是纯文本（由渲染端用 textContent 写入），模板只替换 `{字段}`，只能引用公开字段。
 */

/** 锚点的全局引用：哪个空间的哪个锚点。 */
export interface AnchorRef {
  readonly spaceId: string;
  readonly anchorId: string;
}

export const anchorKey = (ref: AnchorRef): string => `${ref.spaceId}/${ref.anchorId}`;

interface VisualBase {
  /** 稳定的编号，渲染端据此复用元素。 */
  readonly id: string;
  /** 来自哪个事件类型。 */
  readonly type: string;
  readonly color: Rgb;
}

export interface HighlightVisual extends VisualBase {
  readonly kind: 'highlight';
  readonly anchor: AnchorRef;
  readonly text?: string;
}

export interface IconVisual extends VisualBase {
  readonly kind: 'icon';
  readonly anchor: AnchorRef;
  readonly icon: string;
  readonly text?: string;
}

export interface LabelVisual extends VisualBase {
  readonly kind: 'label';
  readonly anchor: AnchorRef;
  readonly text: string;
}

export interface SpawnVisual extends VisualBase {
  readonly kind: 'spawn';
  readonly anchor: AnchorRef;
  /** 处理后的物件模型（资源哈希）。 */
  readonly asset: string;
}

export interface HeatVisual extends VisualBase {
  readonly kind: 'heat';
  readonly anchor: AnchorRef;
  /** 0–1，按同一事件类型的最大值归一化。 */
  readonly intensity: number;
  /** 时间窗内的加权和。 */
  readonly total: number;
}

export interface PathVisual extends VisualBase {
  readonly kind: 'path';
  readonly correlationId: string;
  readonly from?: AnchorRef;
  readonly to?: AnchorRef;
  /**
   * 动画进度 0–1：起点事件到终点事件之间按时间线性推进；已经到达时为 1。
   * 只有起点（还没有终点）时为 null，只在起点显示图标。
   */
  readonly progress: number | null;
  /** 两事件的时间差（毫秒）；不完整时为 null。 */
  readonly durationMs: number | null;
  readonly icon: string;
  readonly text?: string;
}

export type Visual =
  HighlightVisual | IconVisual | LabelVisual | SpawnVisual | HeatVisual | PathVisual;

/** 一个空间的输入：已应用更正、只含公开级的事件，T 时刻的锚点状态，事件类型。 */
export interface SpaceVisualInput {
  readonly spaceId: string;
  readonly types: readonly EventTypeDef[];
  readonly events: readonly SpaceEvent[];
  /** 锚点 → 状态 key → 状态。 */
  readonly states: ReadonlyMap<string, ReadonlyMap<string, AnchorState>>;
}

export interface VisualOptions {
  readonly at: number;
  /** 瞬时事件的最小可见窗口（毫秒）：播放时随速度放大，"现在"模式用 durationSec。 */
  readonly windowMs?: number;
}

/** 默认颜色（显示规则没给 color 时）：琥珀色。 */
export const DEFAULT_VISUAL_COLOR: Rgb = [255, 176, 64];
/** 瞬时事件默认显示多久。 */
export const DEFAULT_DURATION_SEC = 5;
/** 只有起点的路线，起点图标最多显示多久（类型没给 maxAgeSec 时）。 */
export const DEFAULT_PATH_MAX_AGE_SEC = 4 * 3600;
/** 到达之后，完整路线再显示多久（类型没给 durationSec 时）。 */
export const DEFAULT_ARRIVAL_SEC = 30;

const ICONS = new Set(['dish', 'flower', 'bell', 'star', 'person', 'box', 'door', 'cart', 'info']);

/** 图标名：只认网站自带的几种，其余按 info 画。 */
export function iconName(name: string | undefined): string {
  return name !== undefined && ICONS.has(name) ? name : 'info';
}

/**
 * 找事件类型的显示规则：先找版本号完全相同的，没有就用这个类型的最高版本
 * （回放时用 T 时生效的版本：事件记录了写入时的 typeVersion）。
 */
export function eventTypeFor(
  types: readonly EventTypeDef[],
  type: string | undefined,
  version?: number,
): EventTypeDef | undefined {
  if (type === undefined) return undefined;
  let best: EventTypeDef | undefined;
  for (const def of types) {
    if (def.type !== type) continue;
    if (version !== undefined && def.version === version) return def;
    if (best === undefined || def.version > best.version) best = def;
  }
  return best;
}

function fieldValue(data: Readonly<Record<string, unknown>> | undefined, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function plain(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * 标签模板：`{字段}` 换成事件 data 里那个字段（可以是点分路径），结果是纯文本。
 * 给了 `publicFields` 时只能引用其中的字段，别的一律换成空串。
 */
export function renderTemplate(
  template: string,
  data: Readonly<Record<string, unknown>> | undefined,
  publicFields?: readonly string[],
): string {
  return template
    .replace(/\{([A-Za-z0-9_.\-一-鿿]+)\}/g, (_, field: string) => {
      if (publicFields !== undefined && publicFields.length > 0 && !publicFields.includes(field)) {
        return '';
      }
      return plain(fieldValue(data, field));
    })
    .trim();
}

function colorOf(def: EventTypeDef): Rgb {
  return def.display.color ?? DEFAULT_VISUAL_COLOR;
}

function eventText(def: EventTypeDef, data: Readonly<Record<string, unknown>> | undefined) {
  const template = def.display.labelTemplate;
  if (template === undefined) return undefined;
  const text = renderTemplate(template, data, def.publicFields);
  return text === '' ? undefined : text;
}

/** 状态的文本：有模板用模板，没有时用状态值（状态值就是类型名时不显示）。 */
function stateText(def: EventTypeDef, state: AnchorState): string | undefined {
  const data =
    state.data ??
    (def.state?.value !== undefined ? { [def.state.value]: state.value } : { value: state.value });
  const templated = eventText(def, data);
  if (templated !== undefined) return templated;
  if (state.value === null || state.value === undefined || state.value === state.type)
    return undefined;
  return plain(state.value);
}

function durationMs(def: EventTypeDef, windowMs: number): number {
  return Math.max((def.display.durationSec ?? DEFAULT_DURATION_SEC) * 1000, windowMs);
}

/** 生成 T 时刻要画的东西。输入可以是一个空间（单空间页）或组合的全部成员。 */
export function buildVisuals(
  spaces: readonly SpaceVisualInput[],
  options: VisualOptions,
): Visual[] {
  const at = options.at;
  const windowMs = options.windowMs ?? 0;
  const out: Visual[] = [];
  const heat = new Map<
    string,
    { def: EventTypeDef; spaceId: string; totals: Map<string, number> }
  >();
  const origins = new Map<string, { event: SpaceEvent; spaceId: string; def: EventTypeDef }>();
  const destinations = new Map<string, { event: SpaceEvent; spaceId: string; def: EventTypeDef }>();

  for (const space of spaces) {
    // 状态事件：按 T 时刻的状态。
    for (const [anchorId, states] of space.states) {
      for (const state of states.values()) {
        const def = eventTypeFor(space.types, state.type, state.typeVersion);
        if (def === undefined || def.state === undefined || def.state.clears) continue;
        if (def.maxAgeSec !== undefined && at - toMillis(state.at) > def.maxAgeSec * 1000) continue;
        if (toMillis(state.at) > at) continue;
        const anchor = { spaceId: space.spaceId, anchorId };
        const id = `${def.display.kind}:${anchorKey(anchor)}:${state.key}`;
        const color = colorOf(def);
        const text = stateText(def, state);
        switch (def.display.kind) {
          case 'highlight':
            out.push({ kind: 'highlight', id, type: def.type, color, anchor, text });
            break;
          case 'icon':
            out.push({
              kind: 'icon',
              id,
              type: def.type,
              color,
              anchor,
              icon: iconName(def.display.icon),
              text,
            });
            break;
          case 'label':
            if (text !== undefined)
              out.push({ kind: 'label', id, type: def.type, color, anchor, text });
            break;
          case 'spawnEntity':
            if (def.display.entityAsset !== undefined) {
              out.push({
                kind: 'spawn',
                id,
                type: def.type,
                color,
                anchor,
                asset: def.display.entityAsset,
              });
            }
            break;
          default:
            break;
        }
      }
    }

    for (const event of space.events) {
      if (event.withdrawn || event.retracted) continue;
      const def = eventTypeFor(space.types, event.type, event.typeVersion);
      if (def === undefined) continue;
      const time = toMillis(event.at);
      const kind = def.display.kind;
      if (kind === 'path') {
        const correlation = event.correlationId;
        if (correlation === undefined || time > at + 0) {
          // 路线终点可能在 T 之后（回放时已经加载到），单独处理。
          if (correlation !== undefined && def.display.pathRole === 'destination') {
            keepLatest(destinations, correlation, { event, spaceId: space.spaceId, def }, true);
          }
          continue;
        }
        if (def.display.pathRole === 'origin') {
          // 防伪造：起点事件只能写在 correlationId 前缀对应的空间里。
          if (correlation.split(':')[0] !== space.spaceId) continue;
          keepLatest(origins, correlation, { event, spaceId: space.spaceId, def }, false);
        } else if (def.display.pathRole === 'destination') {
          keepLatest(destinations, correlation, { event, spaceId: space.spaceId, def }, false);
        }
        continue;
      }
      if (kind === 'heat') {
        const windowSec = def.display.heat?.windowSec ?? 3600;
        if (time > at || time <= at - windowSec * 1000) continue;
        const entry = heat.get(def.type) ?? {
          def,
          spaceId: space.spaceId,
          totals: new Map<string, number>(),
        };
        const key = `${space.spaceId}/${event.anchorId}`;
        entry.totals.set(key, (entry.totals.get(key) ?? 0) + (def.display.heat?.weight ?? 1));
        heat.set(def.type, entry);
        continue;
      }
      // 状态类型已经按状态画过了。
      if (def.state !== undefined) continue;
      if (time > at || time < at - durationMs(def, windowMs)) continue;
      const anchor = { spaceId: space.spaceId, anchorId: event.anchorId };
      const color = colorOf(def);
      const text = eventText(def, event.data);
      const id = `${kind}:${event.id}`;
      switch (kind) {
        case 'highlight':
          out.push({ kind: 'highlight', id, type: def.type, color, anchor, text });
          break;
        case 'icon':
          out.push({
            kind: 'icon',
            id,
            type: def.type,
            color,
            anchor,
            icon: iconName(def.display.icon),
            text,
          });
          break;
        case 'label':
          if (text !== undefined)
            out.push({ kind: 'label', id, type: def.type, color, anchor, text });
          break;
        case 'spawnEntity':
          if (def.display.entityAsset !== undefined) {
            out.push({
              kind: 'spawn',
              id,
              type: def.type,
              color,
              anchor,
              asset: def.display.entityAsset,
            });
          }
          break;
        default:
          break;
      }
    }
  }

  for (const [type, { def, totals }] of heat) {
    const max = Math.max(...totals.values());
    for (const [key, total] of totals) {
      const slash = key.indexOf('/');
      out.push({
        kind: 'heat',
        id: `heat:${type}:${key}`,
        type,
        color: colorOf(def),
        anchor: { spaceId: key.slice(0, slash), anchorId: key.slice(slash + 1) },
        intensity: max > 0 ? total / max : 0,
        total,
      });
    }
  }

  out.push(...pairPaths(origins, destinations, at, windowMs));
  return out;
}

type PathEnd = { event: SpaceEvent; spaceId: string; def: EventTypeDef };

/**
 * 同一侧有多条时取最新的一条。`future` 表示这条在 T 之后（只用于终点：回放时提前知道的到达），
 * 这时取最早的那条（离 T 最近的未来）。
 */
function keepLatest(map: Map<string, PathEnd>, key: string, end: PathEnd, future: boolean): void {
  const storeKey = future ? `future:${key}` : key;
  const current = map.get(storeKey);
  const time = toMillis(end.event.at);
  if (current === undefined) {
    map.set(storeKey, end);
    return;
  }
  const currentTime = toMillis(current.event.at);
  if (future ? time < currentTime : time > currentTime) map.set(storeKey, end);
}

function pairPaths(
  origins: Map<string, PathEnd>,
  destinations: Map<string, PathEnd>,
  at: number,
  windowMs: number,
): PathVisual[] {
  const out: PathVisual[] = [];
  const correlations = new Set<string>();
  for (const key of origins.keys()) correlations.add(key);
  for (const key of destinations.keys()) correlations.add(key.replace(/^future:/, ''));
  for (const correlation of correlations) {
    const origin = origins.get(correlation);
    const arrived = destinations.get(correlation);
    const upcoming = destinations.get(`future:${correlation}`);
    const base = origin ?? arrived;
    if (base === undefined) continue;
    const def = base.def;
    const from = origin ? { spaceId: origin.spaceId, anchorId: origin.event.anchorId } : undefined;
    const icon = iconName(def.display.icon ?? arrived?.def.display.icon);
    const color = colorOf(def);
    const text = eventText(def, base.event.data);
    const common = {
      id: `path:${correlation}`,
      type: def.type,
      color,
      correlationId: correlation,
      icon,
      text,
    };
    if (
      origin !== undefined &&
      arrived !== undefined &&
      toMillis(arrived.event.at) >= toMillis(origin.event.at)
    ) {
      // 已经到达：完整路线在到达后再显示一会儿。
      const arrivedAt = toMillis(arrived.event.at);
      const linger = Math.max(
        (arrived.def.display.durationSec ?? DEFAULT_ARRIVAL_SEC) * 1000,
        windowMs,
      );
      if (at - arrivedAt > linger) continue;
      out.push({
        ...common,
        kind: 'path',
        from,
        to: { spaceId: arrived.spaceId, anchorId: arrived.event.anchorId },
        progress: 1,
        durationMs: arrivedAt - toMillis(origin.event.at),
      });
      continue;
    }
    if (origin !== undefined) {
      const sentAt = toMillis(origin.event.at);
      if (upcoming !== undefined && toMillis(upcoming.event.at) >= sentAt) {
        // 回放时已经知道终点：按两事件的时间差推进。
        const total = toMillis(upcoming.event.at) - sentAt;
        out.push({
          ...common,
          kind: 'path',
          from,
          to: { spaceId: upcoming.spaceId, anchorId: upcoming.event.anchorId },
          progress: total > 0 ? Math.min(1, Math.max(0, (at - sentAt) / total)) : 1,
          durationMs: total,
        });
        continue;
      }
      // 只有起点：只在起点显示图标。
      const maxAge = (def.maxAgeSec ?? DEFAULT_PATH_MAX_AGE_SEC) * 1000;
      if (at - sentAt > maxAge) continue;
      out.push({ ...common, kind: 'path', from, progress: null, durationMs: null });
      continue;
    }
    if (arrived !== undefined) {
      // 只有终点（起点空间不在当前视图里）：在终点显示一会儿图标。
      const arrivedAt = toMillis(arrived.event.at);
      const linger = Math.max(
        (arrived.def.display.durationSec ?? DEFAULT_ARRIVAL_SEC) * 1000,
        windowMs,
      );
      if (at - arrivedAt > linger) continue;
      out.push({
        ...common,
        kind: 'path',
        to: { spaceId: arrived.spaceId, anchorId: arrived.event.anchorId },
        progress: 1,
        durationMs: null,
      });
    }
  }
  return out;
}

/** 回放时需要往前、往后看多远的事件（毫秒）：取各类型的时间窗、路线时长里最大的，至少一小时。 */
export function eventLookMs(
  types: readonly EventTypeDef[],
  windowMs = 0,
): {
  readonly before: number;
  readonly after: number;
} {
  let before = Math.max(3_600_000, windowMs);
  let after = 0;
  for (const def of types) {
    const display = def.display;
    if (display.kind === 'heat')
      before = Math.max(before, (display.heat?.windowSec ?? 3600) * 1000);
    if (display.kind === 'path') {
      const age = (def.maxAgeSec ?? DEFAULT_PATH_MAX_AGE_SEC) * 1000;
      before = Math.max(before, age);
      after = Math.max(after, age);
    }
    if (def.state === undefined && display.durationSec !== undefined) {
      before = Math.max(before, display.durationSec * 1000);
    }
  }
  const cap = 24 * 3_600_000;
  return { before: Math.min(before, cap), after: Math.min(after, cap) };
}

/**
 * 组合里两个成员之间沿连接走的最短路径（按成员数算的广度优先）。
 * 返回途经的连接（每条连接给出从哪端进、从哪端出）；同一空间返回空数组；走不通返回 null。
 */
export function linkRoute(
  fromSpace: string,
  toSpace: string,
  links: readonly UniverseLink[],
): { readonly exit: AnchorRef; readonly enter: AnchorRef }[] | null {
  if (fromSpace === toSpace) return [];
  const previous = new Map<string, { space: string; exit: AnchorRef; enter: AnchorRef }>();
  const queue = [fromSpace];
  const seen = new Set([fromSpace]);
  while (queue.length > 0) {
    const space = queue.shift()!;
    for (const link of links) {
      for (const [a, b] of [
        [link.from, link.to],
        [link.to, link.from],
      ] as const) {
        if (a.spaceId !== space || seen.has(b.spaceId)) continue;
        seen.add(b.spaceId);
        previous.set(b.spaceId, { space, exit: a, enter: b });
        if (b.spaceId === toSpace) {
          const hops: { exit: AnchorRef; enter: AnchorRef }[] = [];
          let cursor = toSpace;
          while (cursor !== fromSpace) {
            const step = previous.get(cursor)!;
            hops.unshift({ exit: step.exit, enter: step.enter });
            cursor = step.space;
          }
          return hops;
        }
        queue.push(b.spaceId);
      }
    }
  }
  return null;
}
