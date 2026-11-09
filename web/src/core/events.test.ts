import { describe, expect, it } from 'vitest';
import type { CommitSummary, EventTypeDef, SpaceEvent } from './api/types';
import {
  commitAt,
  densityBuckets,
  effectiveEvents,
  eventsInWindow,
  incrementalCursor,
  mergeIncremental,
  stateAt,
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
