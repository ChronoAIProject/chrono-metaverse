import { describe, expect, it } from 'vitest';
import type { AnchorState, EventTypeDef, SpaceEvent, UniverseLink } from './api/types';
import {
  buildVisuals,
  eventLookMs,
  eventTypeFor,
  iconName,
  linkRoute,
  renderTemplate,
  type SpaceVisualInput,
  type Visual,
} from './visuals';

const T = Date.parse('2026-10-27T10:12:00Z');
const iso = (t: number) => new Date(t).toISOString();

const types: EventTypeDef[] = [
  {
    type: 'table.occupancy',
    version: 1,
    publicFields: ['status', 'party'],
    state: { key: 'occupancy', value: 'status' },
    maxAgeSec: 3600,
    display: { kind: 'highlight', color: [255, 168, 40], labelTemplate: '{status} {party} 位' },
  },
  {
    type: 'table.occupancy',
    version: 2,
    state: { key: 'occupancy', value: 'status' },
    display: { kind: 'icon', icon: 'person' },
  },
  {
    type: 'shop.status',
    version: 1,
    state: { key: 'open', value: 'status' },
    display: { kind: 'label', labelTemplate: '{status}' },
  },
  { type: 'order.served', version: 1, display: { kind: 'icon', icon: 'dish', durationSec: 3 } },
  { type: 'note', version: 1, display: { kind: 'label', labelTemplate: '{text}' } },
  {
    type: 'visitor',
    version: 1,
    display: { kind: 'heat', heat: { windowSec: 600, weight: 2 } },
  },
  {
    type: 'decor',
    version: 1,
    state: { key: 'decor' },
    display: { kind: 'spawnEntity', entityAsset: 'a'.repeat(64) },
  },
  {
    type: 'sent',
    version: 1,
    maxAgeSec: 3600,
    display: { kind: 'path', pathRole: 'origin', icon: 'flower', labelTemplate: '{item}' },
  },
  { type: 'arrived', version: 1, display: { kind: 'path', pathRole: 'destination' } },
];

let n = 0;
function event(type: string, at: number, anchorId: string, extra: Partial<SpaceEvent> = {}) {
  n += 1;
  return {
    id: `e${n}`,
    at: iso(at),
    recordedAt: iso(at),
    source: 'test',
    type,
    anchorId,
    ...extra,
  } satisfies SpaceEvent;
}

function state(anchorId: string, key: string, type: string, value: unknown, at: number) {
  return {
    anchorId,
    key,
    value,
    at: iso(at),
    eventId: `s-${anchorId}-${key}`,
    type,
  } satisfies AnchorState;
}

function space(
  spaceId: string,
  events: SpaceEvent[],
  states: AnchorState[] = [],
): SpaceVisualInput {
  const map = new Map<string, Map<string, AnchorState>>();
  for (const s of states) {
    const entry = map.get(s.anchorId) ?? new Map();
    entry.set(s.key, s);
    map.set(s.anchorId, entry);
  }
  return { spaceId, types, events, states: map };
}

const kinds = (visuals: Visual[]) => visuals.map((v) => `${v.kind}:${v.id}`).sort();

describe('显示规则', () => {
  it('按事件记录的版本找显示规则，没有就用最高版本', () => {
    expect(eventTypeFor(types, 'table.occupancy', 1)?.display.kind).toBe('highlight');
    expect(eventTypeFor(types, 'table.occupancy', 9)?.version).toBe(2);
    expect(eventTypeFor(types, 'table.occupancy')?.version).toBe(2);
    expect(eventTypeFor(types, 'nope')).toBeUndefined();
    expect(eventTypeFor(types, undefined)).toBeUndefined();
  });

  it('模板只替换公开字段，结果是纯文本', () => {
    expect(renderTemplate('{a} / {b.c}', { a: '<b>x</b>', b: { c: 2 } })).toBe('<b>x</b> / 2');
    expect(renderTemplate('{a}{secret}', { a: 1, secret: 's' }, ['a'])).toBe('1');
    expect(renderTemplate('{obj}', { obj: { k: [1] } })).toBe('{"k":[1]}');
    expect(renderTemplate('{missing}', undefined)).toBe('');
  });

  it('不认识的图标画成 info', () => {
    expect(iconName('flower')).toBe('flower');
    expect(iconName('<script>')).toBe('info');
    expect(iconName(undefined)).toBe('info');
  });
});

describe('T 时刻要画的东西', () => {
  it('状态事件按状态显示，模板用状态事件的公开字段，超过 maxAgeSec 失效', () => {
    const occupied = {
      ...state('table-01', 'occupancy', 'table.occupancy', '有人', T - 600_000),
      typeVersion: 1,
      data: { status: '有人', party: 3 },
    };
    const open = state('_space', 'open', 'shop.status', '营业中', T - 7_200_000);
    const visuals = buildVisuals([space('lobby', [], [occupied, open])], { at: T });
    expect(visuals).toContainEqual(
      expect.objectContaining({ kind: 'highlight', text: '有人 3 位', color: [255, 168, 40] }),
    );
    expect(visuals).toContainEqual(expect.objectContaining({ kind: 'label', text: '营业中' }));
    // 一个半小时后桌位状态（maxAgeSec = 3600）失效，营业状态没有上限。
    const later = buildVisuals([space('lobby', [], [occupied, open])], { at: T + 3_600_000 });
    expect(kinds(later)).toEqual(['label:label:lobby/_space:open']);
  });

  it('没有 data 的状态用状态值作模板字段；生成物件的状态', () => {
    const visuals = buildVisuals(
      [
        space(
          'lobby',
          [],
          [
            { ...state('t', 'occupancy', 'table.occupancy', '已预订', T), typeVersion: 1 },
            state('counter', 'decor', 'decor', 'decor', T - 1000),
          ],
        ),
      ],
      { at: T },
    );
    expect(visuals.find((v) => v.kind === 'highlight')).toMatchObject({ text: '已预订  位' });
    expect(visuals.find((v) => v.kind === 'spawn')).toMatchObject({ asset: 'a'.repeat(64) });
  });

  it('瞬时事件只在时间窗内显示；窗口取 durationSec 和调用方窗口里大的', () => {
    const served = event('order.served', T - 2000, 'table-01');
    const note = event('note', T - 60_000, 'door', { data: { text: '你好' } });
    const future = event('order.served', T + 1000, 'table-01');
    const input = [space('lobby', [served, note, future])];
    expect(kinds(buildVisuals(input, { at: T }))).toEqual([`icon:icon:${served.id}`]);
    const wide = buildVisuals(input, { at: T, windowMs: 120_000 });
    expect(kinds(wide)).toEqual([`icon:icon:${served.id}`, `label:label:${note.id}`]);
    expect(wide.find((v) => v.kind === 'label')).toMatchObject({ text: '你好' });
    expect(buildVisuals(input, { at: T + 10_000 })).toEqual([]);
  });

  it('热力：时间窗内按权重累加，按同类型的最大值归一化', () => {
    const events = [
      event('visitor', T - 60_000, 'door'),
      event('visitor', T - 120_000, 'door'),
      event('visitor', T - 180_000, 'lounge'),
      event('visitor', T - 900_000, 'lounge'),
    ];
    const heat = buildVisuals([space('lobby', events)], { at: T }).filter((v) => v.kind === 'heat');
    expect(heat).toHaveLength(2);
    expect(heat.find((v) => v.anchor.anchorId === 'door')).toMatchObject({
      intensity: 1,
      total: 4,
    });
    expect(heat.find((v) => v.anchor.anchorId === 'lounge')).toMatchObject({
      intensity: 0.5,
      total: 2,
    });
  });
});

describe('跨空间路线', () => {
  const sentAt = T - 12 * 60_000;
  const arrivedAt = T + 13 * 60_000;
  const sent = event('sent', sentAt, 'counter', {
    correlationId: 'florist:d1',
    data: { item: '花束' },
  });
  const arrived = event('arrived', arrivedAt, 'counter-01', { correlationId: 'florist:d1' });

  it('只有起点：只在起点显示图标', () => {
    const [path] = buildVisuals([space('florist', [sent])], { at: T });
    expect(path).toMatchObject({
      kind: 'path',
      from: { spaceId: 'florist', anchorId: 'counter' },
      progress: null,
      text: '花束',
      icon: 'flower',
    });
    // 起点超过 maxAgeSec 还没到：不再显示。
    expect(buildVisuals([space('florist', [sent])], { at: sentAt + 3_700_000 })).toEqual([]);
  });

  it('回放时知道终点：按两事件的时间差推进；到达后显示完整路线一会儿', () => {
    const inputs = [space('florist', [sent]), space('lobby', [arrived])];
    const [moving] = buildVisuals(inputs, { at: T });
    expect(moving).toMatchObject({
      kind: 'path',
      to: { spaceId: 'lobby', anchorId: 'counter-01' },
      durationMs: 25 * 60_000,
    });
    expect((moving as { progress: number }).progress).toBeCloseTo(12 / 25, 5);
    const [done] = buildVisuals(inputs, { at: arrivedAt + 10_000 });
    expect(done).toMatchObject({ progress: 1 });
    expect(buildVisuals(inputs, { at: arrivedAt + 3_600_000 })).toEqual([]);
    expect(buildVisuals(inputs, { at: sentAt - 1000 })).toEqual([]);
  });

  it('起点事件写在别的空间（前缀不对）不算：防伪造', () => {
    const forged = event('sent', sentAt, 'x', { correlationId: 'florist:d9' });
    expect(buildVisuals([space('lobby', [forged])], { at: T })).toEqual([]);
  });

  it('同一侧有多条时取最新的；只有终点时在终点显示一会儿', () => {
    const older = event('sent', sentAt - 60_000, 'old', { correlationId: 'florist:d1' });
    const [path] = buildVisuals([space('florist', [older, sent])], { at: T });
    expect(path).toMatchObject({ from: { anchorId: 'counter' } });
    const onlyArrival = buildVisuals([space('lobby', [arrived])], { at: arrivedAt + 5000 });
    expect(onlyArrival).toEqual([
      expect.objectContaining({ kind: 'path', to: { spaceId: 'lobby', anchorId: 'counter-01' } }),
    ]);
  });

  it('沿连接的最短路径', () => {
    const links: UniverseLink[] = [
      {
        from: { spaceId: 'a', anchorId: 'a-door' },
        to: { spaceId: 'b', anchorId: 'b-1' },
        kind: 'door',
      },
      {
        from: { spaceId: 'c', anchorId: 'c-1' },
        to: { spaceId: 'b', anchorId: 'b-2' },
        kind: 'street',
      },
      {
        from: { spaceId: 'a', anchorId: 'a-portal' },
        to: { spaceId: 'c', anchorId: 'c-2' },
        kind: 'portal',
      },
    ];
    expect(linkRoute('a', 'a', links)).toEqual([]);
    expect(linkRoute('a', 'c', links)).toEqual([
      { exit: { spaceId: 'a', anchorId: 'a-portal' }, enter: { spaceId: 'c', anchorId: 'c-2' } },
    ]);
    expect(linkRoute('b', 'a', links)).toEqual([
      { exit: { spaceId: 'b', anchorId: 'b-1' }, enter: { spaceId: 'a', anchorId: 'a-door' } },
    ]);
    expect(linkRoute('a', 'z', links)).toBeNull();
  });

  it('回放时往前、往后看的范围取各类型的时间窗和路线时长', () => {
    // 终点类型没给 maxAgeSec：按默认的 4 小时。
    expect(eventLookMs(types)).toEqual({ before: 14_400_000, after: 14_400_000 });
    expect(eventLookMs(types.slice(0, 7))).toEqual({ before: 3_600_000, after: 0 });
    expect(eventLookMs([], 7_200_000).before).toBe(7_200_000);
    expect(eventLookMs([], 48 * 3_600_000).before).toBe(24 * 3_600_000);
  });
});
