import { describe, expect, it } from 'vitest';
import type { CommitSummary, EventTypeDef, SpaceEvent } from './api/types';
import {
  advanceStates,
  commitAt,
  densityBuckets,
  effectiveEvents,
  eventsInWindow,
  incrementalCursor,
  mergeIncremental,
  stateAt,
  stateMapFrom,
} from './events';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function event(id: string, minutes: number, extra: Partial<SpaceEvent> = {}): SpaceEvent {
  return {
    id,
    at: iso(minutes),
    recordedAt: iso(minutes),
    source: 'pos',
    type: 'table.occupancy',
    anchorId: 'table-01',
    data: { status: 'occupied' },
    ...extra,
  };
}

const types: EventTypeDef[] = [
  {
    type: 'table.occupancy',
    version: 1,
    state: { key: 'occupancy', value: 'status' },
    maxAgeSec: 3 * 3600,
    display: { kind: 'highlight', color: [255, 160, 0] },
  },
  {
    type: 'table.vacated',
    version: 1,
    state: { key: 'occupancy', clears: true },
    display: { kind: 'highlight' },
  },
  { type: 'order.served', version: 1, display: { kind: 'icon', durationSec: 3 } },
  {
    type: 'staff.note',
    version: 1,
    defaultVisibility: 'internal',
    display: { kind: 'label' },
  },
];

describe('更正与撤回', () => {
  it('替换版本取 recordedAt 最新的一条，编号和时间保持原事件的', () => {
    const events = [
      event('e1', 0, { data: { status: 'occupied' } }),
      event('c1', 0, { corrects: 'e1', recordedAt: iso(5), data: { status: 'reserved' } }),
      event('c2', 0, { corrects: 'e1', recordedAt: iso(9), data: { status: 'cleaning' } }),
      event('c0', 0, { corrects: 'e1', recordedAt: iso(7), data: { status: 'ignored' } }),
    ];
    const [effective, ...rest] = effectiveEvents(events);
    expect(rest).toEqual([]);
    expect(effective!.id).toBe('e1');
    expect(effective!.revisionId).toBe('c2');
    expect(effective!.data).toEqual({ status: 'cleaning' });
    expect(effective!.at).toBe(iso(0));
  });

  it('最新的更正是撤回时事件消失', () => {
    const events = [
      event('e1', 0),
      event('c1', 0, { corrects: 'e1', recordedAt: iso(1), data: { status: 'x' } }),
      event('c2', 0, { corrects: 'e1', recordedAt: iso(2), retracted: true, data: undefined }),
    ];
    expect(effectiveEvents(events)).toEqual([]);
  });

  it('先应用更正再按可见级别过滤：改成内部级的公开事件从公开结果消失', () => {
    const events = [
      event('e1', 0),
      event('c1', 0, { corrects: 'e1', recordedAt: iso(1), visibility: 'internal' }),
      event('e2', 1, { type: 'staff.note' }),
      event('e3', 2, { type: 'order.served' }),
    ];
    expect(effectiveEvents(events, { publicOnly: true, types }).map((e) => e.id)).toEqual(['e3']);
    expect(effectiveEvents(events, { types }).map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('公开接口的数据（不带 visibility）：不给 types 时只丢显式内部级，不按类型默认级别过滤', () => {
    // staff.note 默认内部级；n1 写入时显式标成公开，接口返回时不带 visibility。
    const events = [
      event('n1', 0, { type: 'staff.note', data: { note: '今日新品' } }),
      event('n2', 1, { type: 'staff.note', visibility: 'internal' }),
      event('e3', 2, { type: 'order.served' }),
      event('u1', 3, { type: 'not.registered' }),
    ];
    expect(effectiveEvents(events, { publicOnly: true }).map((e) => e.id)).toEqual([
      'n1',
      'e3',
      'u1',
    ]);
    // 显式公开优先于类型的默认级别。
    const explicit = event('n3', 4, { type: 'staff.note', visibility: 'public' });
    expect(effectiveEvents([explicit], { publicOnly: true, types }).map((e) => e.id)).toEqual([
      'n3',
    ]);
  });

  it('给 types 时按事件记录的 (type, typeVersion) 取默认级别；类型或版本找不到时按内部级', () => {
    const versioned: EventTypeDef[] = [
      { type: 'door.opened', version: 1, defaultVisibility: 'internal', display: { kind: 'icon' } },
      { type: 'door.opened', version: 2, defaultVisibility: 'public', display: { kind: 'icon' } },
    ];
    const events = [
      event('v1', 0, { type: 'door.opened', typeVersion: 1 }),
      event('v2', 1, { type: 'door.opened', typeVersion: 2 }),
      event('v3', 2, { type: 'door.opened', typeVersion: 3 }),
      event('v1p', 3, { type: 'door.opened', typeVersion: 1, visibility: 'public' }),
      // 没写版本：取这个类型的最高版本。
      event('latest', 4, { type: 'door.opened' }),
      event('unknown', 5, { type: 'not.registered', typeVersion: 1 }),
    ];
    expect(
      effectiveEvents(events, { publicOnly: true, types: versioned }).map((e) => e.id),
    ).toEqual(['v2', 'v1p', 'latest']);
    // 反过来排版本顺序，结果不变（不是"数组里第一个同名类型"）。
    expect(
      effectiveEvents(events, { publicOnly: true, types: [...versioned].reverse() }).map(
        (e) => e.id,
      ),
    ).toEqual(['v2', 'v1p', 'latest']);
  });

  it('抹除的事件不带 data', () => {
    const [effective] = effectiveEvents([event('e1', 0, { redacted: true })]);
    expect(effective!.data).toBeUndefined();
  });
});

describe('T 时刻的状态', () => {
  it('取 at ≤ T 的最后一条，不受时间窗限制', () => {
    const events = effectiveEvents([
      event('e1', 0, { data: { status: 'occupied' } }),
      event('e2', 30, { data: { status: 'paying' } }),
      event('e3', 10, { anchorId: 'table-02' }),
      event('e4', 50, { type: 'order.served' }),
    ]);
    const at20 = stateAt(events, types, iso(20));
    expect(at20.get('table-01')?.get('occupancy')?.value).toBe('occupied');
    expect(at20.get('table-02')?.get('occupancy')?.value).toBe('occupied');
    expect(stateAt(events, types, iso(40)).get('table-01')?.get('occupancy')?.value).toBe('paying');
    expect(stateAt(events, types, iso(-1)).size).toBe(0);
  });

  it('清除类事件结束状态', () => {
    const events = effectiveEvents([
      event('e1', 0),
      event('e2', 10, { type: 'table.vacated', data: {} }),
    ]);
    expect(stateAt(events, types, iso(5)).has('table-01')).toBe(true);
    expect(stateAt(events, types, iso(15)).has('table-01')).toBe(false);
  });

  it('超过 maxAgeSec 没更新的状态失效', () => {
    const events = effectiveEvents([event('e1', 0)]);
    expect(stateAt(events, types, iso(179)).has('table-01')).toBe(true);
    expect(stateAt(events, types, iso(181)).has('table-01')).toBe(false);
  });

  it('按事件记录的版本取状态规则', () => {
    const versioned: EventTypeDef[] = [
      {
        type: 'table.occupancy',
        version: 2,
        state: { key: 'occupancy', value: 'party' },
        display: { kind: 'highlight' },
      },
      ...types,
    ];
    const events = effectiveEvents([
      event('v1', 0, { typeVersion: 1, data: { status: 'occupied', party: 2 } }),
      event('v2', 0, { anchorId: 'table-02', typeVersion: 2, data: { status: 'x', party: 4 } }),
    ]);
    const states = stateAt(events, versioned, iso(1));
    expect(states.get('table-01')?.get('occupancy')?.value).toBe('occupied');
    expect(states.get('table-02')?.get('occupancy')?.value).toBe(4);
  });

  it('更正后的状态按更正后的内容算', () => {
    const events = effectiveEvents([
      event('e1', 0),
      event('c1', 0, { corrects: 'e1', recordedAt: iso(3), data: { status: 'reserved' } }),
    ]);
    expect(stateAt(events, types, iso(1)).get('table-01')?.get('occupancy')?.value).toBe(
      'reserved',
    );
  });
});

describe('时间窗、密度、增量', () => {
  it('时间窗内的瞬时事件', () => {
    const events = [event('a', 0), event('b', 5), event('c', 10)];
    expect(eventsInWindow(events, iso(6), 2 * 60_000).map((e) => e.id)).toEqual(['b']);
    expect(eventsInWindow(events, iso(6), 6 * 60_000, 4 * 60_000).map((e) => e.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('按桶计数，区间左闭右开', () => {
    const events = [event('a', 0), event('b', 1), event('c', 59), event('d', 60)];
    const buckets = densityBuckets(events, iso(0), iso(60), 30 * 60_000);
    expect(buckets.map((b) => b.count)).toEqual([2, 1]);
    expect(buckets[0]!.start).toBe(iso(0));
    expect(densityBuckets(events, iso(10), iso(0), 1000)).toEqual([]);
  });

  it('增量合并去重，撤下标记删除事件和它的更正', () => {
    const merged = mergeIncremental(
      [event('a', 0), event('b', 1), event('c1', 1, { corrects: 'b', recordedAt: iso(2) })],
      [
        event('a', 0, { data: { status: 'updated' } }),
        event('b', 1, { withdrawn: true }),
        event('d', 3),
      ],
    );
    expect(merged.map((e) => e.id).sort()).toEqual(['a', 'd']);
    expect(merged.find((e) => e.id === 'a')!.data).toEqual({ status: 'updated' });
    expect(incrementalCursor(merged)).toBe(new Date(T0 + 3 * 60_000 - 5000).toISOString());
    expect(incrementalCursor([])).toBeNull();
  });

  it('T 时刻生效的提交', () => {
    const commits: CommitSummary[] = [1, 2, 3].map((seq) => ({
      seq,
      at: iso(seq * 10),
      message: `#${seq}`,
      actor: { kind: 'job' },
    }));
    expect(commitAt(commits, iso(5))).toBeNull();
    expect(commitAt(commits, iso(20))!.seq).toBe(2);
    expect(commitAt(commits, iso(99))!.seq).toBe(3);
  });
});

describe('"现在"模式：在 state?at= 的结果上叠加增量事件', () => {
  const base = stateMapFrom([
    {
      anchorId: 'table-01',
      key: 'occupancy',
      value: 'occupied',
      at: iso(0),
      eventId: 'e1',
      type: 'table.occupancy',
    },
  ]);
  const baseAt = T0 + 5 * 60_000;
  const now = T0 + 30 * 60_000;

  it('新事件改写状态，清除类事件删掉状态', () => {
    const second = event('e2', 10, { anchorId: 'seat-01', data: { status: 'reserved' } });
    const { states, refetch } = advanceStates(base, baseAt, [second], types, now);
    expect(refetch).toBe(false);
    expect(states.get('seat-01')?.get('occupancy')).toMatchObject({
      value: 'reserved',
      eventId: 'e2',
      data: { status: 'reserved' },
    });
    const vacated = event('e3', 12, { type: 'table.vacated', data: {} });
    const cleared = advanceStates(states, baseAt, [vacated], types, now);
    expect(cleared.states.has('table-01')).toBe(false);
    expect(cleared.states.has('seat-01')).toBe(true);
  });

  it('比当前状态早的晚到事件不改写；当前状态那条事件被更正时按更正后的内容', () => {
    const late = event('old', -10, { recordedAt: iso(20), data: { status: 'late' } });
    expect(
      advanceStates(base, baseAt, [late], types, now).states.get('table-01')?.get('occupancy'),
    ).toMatchObject({ value: 'occupied' });
    const correction = event('c1', 0, {
      recordedAt: iso(20),
      corrects: 'e1',
      data: { status: 'reserved' },
    });
    const corrected = advanceStates(base, baseAt, [correction], types, now);
    expect(corrected.refetch).toBe(false);
    expect(corrected.states.get('table-01')?.get('occupancy')).toMatchObject({
      value: 'reserved',
      eventId: 'e1',
    });
  });

  it('撤回、撤下当前状态的事件，或早于 baseAt 又没有状态的晚到事件：要重新取', () => {
    const retracted = event('c2', 0, { corrects: 'e1', retracted: true, recordedAt: iso(20) });
    expect(advanceStates(base, baseAt, [retracted], types, now).refetch).toBe(true);
    const withdrawn = { id: 'e1', withdrawn: true, recordedAt: iso(20) } as SpaceEvent;
    expect(advanceStates(base, baseAt, [withdrawn], types, now).refetch).toBe(true);
    const lateOther = event('x', 1, { anchorId: 'seat-02', recordedAt: iso(20) });
    expect(advanceStates(base, baseAt, [lateOther], types, now).refetch).toBe(true);
    // 和状态无关的撤下不用重新取；未来的事件先不算。
    const unrelated = { id: 'zzz', withdrawn: true, recordedAt: iso(20) } as SpaceEvent;
    expect(advanceStates(base, baseAt, [unrelated], types, now).refetch).toBe(false);
    const future = event('f', 60, { anchorId: 'seat-03' });
    expect(advanceStates(base, baseAt, [future], types, now).states.has('seat-03')).toBe(false);
  });
});
