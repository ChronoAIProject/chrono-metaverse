import type { CommitSummary, EventTypeDef, SpaceEvent } from '../core/api/types';

/** 夹具时间线：4 次提交和一个多月的桌位、出餐事件。 */

export const commits: CommitSummary[] = [
  {
    seq: 1,
    at: '2026-10-01T09:00:00.000Z',
    observedAt: '2026-09-30T18:30:00.000Z',
    message: '导入前厅扫描',
    actor: { kind: 'person' },
  },
  {
    seq: 2,
    at: '2026-10-01T09:20:00.000Z',
    message: 'AI 重建：结构与家具',
    actor: { kind: 'job' },
  },
  {
    seq: 3,
    at: '2026-10-15T14:00:00.000Z',
    message: '虚拟展区：方块平台与展台',
    actor: { kind: 'plot' },
  },
  { seq: 4, at: '2026-11-01T10:00:00.000Z', message: '调整 2 号座位', actor: { kind: 'agent' } },
];

export const eventTypes: EventTypeDef[] = [
  {
    type: 'table.occupancy',
    version: 1,
    publicFields: ['status', 'party'],
    defaultVisibility: 'public',
    state: { key: 'occupancy', value: 'status' },
    maxAgeSec: 4 * 3600,
    display: { kind: 'highlight', color: [255, 168, 40], labelTemplate: '{status}' },
  },
  {
    type: 'table.vacated',
    version: 1,
    defaultVisibility: 'public',
    state: { key: 'occupancy', clears: true },
    display: { kind: 'highlight' },
  },
  {
    type: 'order.served',
    version: 1,
    defaultVisibility: 'public',
    display: { kind: 'icon', icon: 'dish', durationSec: 3 },
  },
];

/** 确定性伪随机数，保证每次生成同样的事件。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 2026-10-01 到 2026-11-08 每个工作日几轮入座、出餐、离座。 */
export function fixtureEvents(): SpaceEvent[] {
  const rand = lcg(7);
  const events: SpaceEvent[] = [];
  const start = Date.parse('2026-10-01T00:00:00Z');
  const anchors = ['table-01', 'seat-01', 'seat-02', 'seat-03'];
  let n = 0;
  const push = (at: number, type: string, anchorId: string, data: Record<string, unknown>) => {
    n += 1;
    const time = new Date(at).toISOString();
    events.push({
      id: `evt-${String(n).padStart(5, '0')}`,
      at: time,
      recordedAt: time,
      source: 'pos',
      sourceEventId: `pos-${n}`,
      type,
      anchorId,
      data,
      visibility: 'public',
    });
  };
  for (let day = 0; day < 39; day += 1) {
    const date = new Date(start + day * 86_400_000);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const rounds = 2 + Math.floor(rand() * 4);
    for (let r = 0; r < rounds; r += 1) {
      const anchor = anchors[Math.floor(rand() * anchors.length)]!;
      const begin = start + day * 86_400_000 + (1 + r * 2.5 + rand()) * 3_600_000;
      push(begin, 'table.occupancy', anchor, {
        status: rand() < 0.8 ? '有人' : '已预订',
        party: 1 + Math.floor(rand() * 4),
      });
      push(begin + 20 * 60_000, 'order.served', anchor, {});
      push(begin + (50 + rand() * 40) * 60_000, 'table.vacated', anchor, {});
    }
  }
  // 一条更正：第一次入座其实是预订。
  const first = events[0]!;
  events.push({
    ...first,
    id: 'evt-correction-1',
    sourceEventId: 'pos-correction-1',
    recordedAt: new Date(Date.parse(first.recordedAt) + 3_600_000).toISOString(),
    corrects: first.id,
    data: { status: '已预订', party: 2 },
  });
  return events;
}
