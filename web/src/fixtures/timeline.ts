import type { CommitSummary, EventTypeDef, SpaceEvent } from '../core/api/types';
import { MODELS } from './assets';
import { random } from './png';

/**
 * 夹具时间线：两个空间的提交、事件类型和事件。
 *
 * 前厅 4 次提交；一个多月的入座、出餐、离座、客流（热力）和营业状态事件，一条更正；
 * 10 月 2 日凌晨有一大串内部级门磁事件（sensor.door），夹具接口的第一页全是它们（空页）。
 * 店员备注（staff.note）默认内部级：一条没写可见级别（公开接口不返回），另有显式标成公开的
 * （公开接口返回，并且和真实接口一样不带 visibility）。存的是原始记录，visibility 只在写入时
 * 显式给了才有；公开投影在夹具接口（server.ts）里做。
 * 每隔三天花店送一次花（花店写 delivery.sent，前厅写 delivery.arrived，同一个 correlationId），
 * 到了之后前台上摆出花束（spawnEntity）。另有一批相对"现在"的事件，"现在"模式一打开就能看到
 * 全部显示方式：营业中（标签）、1 号桌和 2 号座位有人（高亮）、客流热力、正在路上的送花（只有起点）。
 */

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

export const floristCommits: CommitSummary[] = [
  {
    seq: 1,
    at: '2026-10-18T08:00:00.000Z',
    message: '花店：AI 重建',
    actor: { kind: 'job' },
  },
  {
    seq: 2,
    at: '2026-10-25T08:30:00.000Z',
    message: '加了一排花桶',
    actor: { kind: 'person' },
  },
];

const deliverySent: EventTypeDef = {
  type: 'delivery.sent',
  version: 1,
  publicFields: ['item'],
  defaultVisibility: 'public',
  maxAgeSec: 4 * 3600,
  display: {
    kind: 'path',
    pathRole: 'origin',
    icon: 'flower',
    color: [236, 96, 140],
    labelTemplate: '{item}',
  },
};

const deliveryArrived: EventTypeDef = {
  type: 'delivery.arrived',
  version: 1,
  publicFields: ['item'],
  defaultVisibility: 'public',
  display: {
    kind: 'path',
    pathRole: 'destination',
    icon: 'flower',
    color: [236, 96, 140],
    durationSec: 60,
  },
};

const shopStatus: EventTypeDef = {
  type: 'shop.status',
  version: 1,
  publicFields: ['status'],
  defaultVisibility: 'public',
  state: { key: 'open', value: 'status' },
  display: { kind: 'label', color: [120, 200, 110], labelTemplate: '{status}' },
};

const visitorCount: EventTypeDef = {
  type: 'visitor.count',
  version: 1,
  publicFields: ['count'],
  defaultVisibility: 'public',
  display: { kind: 'heat', color: [255, 120, 60], heat: { windowSec: 3600, weight: 1 } },
};

export const eventTypes: EventTypeDef[] = [
  {
    type: 'table.occupancy',
    version: 1,
    publicFields: ['status', 'party'],
    defaultVisibility: 'public',
    state: { key: 'occupancy', value: 'status' },
    maxAgeSec: 4 * 3600,
    display: { kind: 'highlight', color: [255, 168, 40], labelTemplate: '{status} {party} 位' },
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
    publicFields: ['dish'],
    defaultVisibility: 'public',
    display: { kind: 'icon', icon: 'dish', durationSec: 3, labelTemplate: '{dish}' },
  },
  shopStatus,
  visitorCount,
  deliveryArrived,
  {
    type: 'decor.placed',
    version: 1,
    defaultVisibility: 'public',
    state: { key: 'decor' },
    maxAgeSec: 2 * 86_400,
    display: { kind: 'spawnEntity', entityAsset: MODELS.bouquet.hash },
  },
  {
    // 门磁传感器：默认内部级、量大。公开接口按原始记录分页，一整页都是它时返回空页。
    type: 'sensor.door',
    version: 1,
    defaultVisibility: 'internal',
    display: { kind: 'icon', icon: 'door' },
  },
  {
    // 默认内部级；写入时显式标成公开的那几条公开接口照样返回（不带 visibility）。
    type: 'staff.note',
    version: 1,
    publicFields: ['note'],
    defaultVisibility: 'internal',
    display: { kind: 'label', labelTemplate: '{note}' },
  },
];

export const floristEventTypes: EventTypeDef[] = [deliverySent, shopStatus, visitorCount];

interface Draft {
  at: number;
  type: string;
  anchorId: string;
  data?: Record<string, unknown>;
  correlationId?: string;
  visibility?: 'public' | 'internal';
}

function finish(prefix: string, drafts: Draft[]): SpaceEvent[] {
  return drafts
    .sort((a, b) => a.at - b.at)
    .map((d, i) => {
      const time = new Date(d.at).toISOString();
      return {
        id: `${prefix}-${String(i + 1).padStart(5, '0')}`,
        at: time,
        recordedAt: time,
        source: d.type.startsWith('delivery') ? 'florist' : 'pos',
        sourceEventId: `${prefix}-${i + 1}`,
        type: d.type,
        typeVersion: 1,
        anchorId: d.anchorId,
        data: d.data ?? {},
        // 只有显式写了才带；没写的由夹具接口按类型默认级别判断（与接口服务相同）。
        ...(d.visibility ? { visibility: d.visibility } : {}),
        ...(d.correlationId ? { correlationId: d.correlationId } : {}),
      };
    });
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const START = Date.parse('2026-10-01T00:00:00Z');
const DISHES = ['拿铁', '美式', '抹茶', '可颂', '三明治'];
/** 10 月 2 日凌晨一连串内部级门磁事件的条数（比夹具接口的一页 400 条多）。 */
export const SENSOR_BURST = 450;

/** 送花日：10 月 21 日起每三天一次，10:00 出发、10:25 到达、10:30 摆上前台。 */
export function deliveryDays(): number[] {
  const days: number[] = [];
  for (
    let t = Date.parse('2026-10-21T00:00:00Z');
    t < Date.parse('2026-11-09T00:00:00Z');
    t += 3 * DAY
  ) {
    days.push(t);
  }
  return days;
}

/** 前厅：2026-10-01 到 2026-11-08 每个工作日的事件；再加上相对 `now` 的一批。 */
export function fixtureEvents(now: number = Date.now()): SpaceEvent[] {
  const rand = random(7);
  const drafts: Draft[] = [];
  const anchors = ['table-01', 'seat-01', 'seat-02', 'seat-03'];
  const heatAnchors = ['zone-lounge', 'door-01', 'table-01', 'counter-01'];
  for (let day = 0; day < 39; day += 1) {
    const date = new Date(START + day * DAY);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const base = START + day * DAY;
    drafts.push({
      at: base + 1 * HOUR,
      type: 'shop.status',
      anchorId: '_space',
      data: { status: '营业中' },
    });
    drafts.push({
      at: base + 11 * HOUR,
      type: 'shop.status',
      anchorId: '_space',
      data: { status: '已打烊' },
    });
    const rounds = 2 + Math.floor(rand() * 4);
    for (let r = 0; r < rounds; r += 1) {
      const anchor = anchors[Math.floor(rand() * anchors.length)]!;
      const begin = base + (1 + r * 2.5 + rand()) * HOUR;
      drafts.push({
        at: begin,
        type: 'table.occupancy',
        anchorId: anchor,
        data: { status: rand() < 0.8 ? '有人' : '已预订', party: 1 + Math.floor(rand() * 4) },
      });
      drafts.push({
        at: begin + 20 * 60_000,
        type: 'order.served',
        anchorId: anchor,
        data: { dish: DISHES[Math.floor(rand() * DISHES.length)] },
      });
      drafts.push({
        at: begin + (50 + rand() * 40) * 60_000,
        type: 'table.vacated',
        anchorId: anchor,
      });
    }
    // 客流：营业时间里每 15 分钟一条，落在几个区域上。
    for (let q = 4; q < 44; q += 1) {
      if (rand() < 0.35) continue;
      drafts.push({
        at: base + q * 15 * 60_000,
        type: 'visitor.count',
        anchorId: heatAnchors[Math.floor(rand() * rand() * heatAnchors.length)]!,
        data: { count: 1 },
      });
    }
  }
  deliveryDays().forEach((day, n) => {
    drafts.push({
      at: day + 10 * HOUR + 25 * 60_000,
      type: 'delivery.arrived',
      anchorId: 'counter-01',
      data: { item: '花束' },
      correlationId: `demo-florist:d${n + 1}`,
    });
    drafts.push({
      at: day + 10 * HOUR + 30 * 60_000,
      type: 'decor.placed',
      anchorId: 'counter-01',
    });
  });
  // 10 月 2 日 0 点到 1 点：门磁每 8 秒一条，共 450 条内部级事件，排在当天的公开事件前面。
  // 夹具接口每页 400 条：这天的第一页全是它们（items 为空），公开事件在后面的页里。
  for (let i = 0; i < SENSOR_BURST; i += 1) {
    drafts.push({
      at: START + DAY + i * 8_000,
      type: 'sensor.door',
      anchorId: 'door-01',
      data: { open: i % 2 === 0 },
    });
  }
  // 内部级事件：公开接口不返回（查看器也不该看到）。
  drafts.push({
    at: START + 2 * DAY + 3 * HOUR,
    type: 'staff.note',
    anchorId: 'counter-01',
    data: { note: '内部备注' },
  });
  // 默认内部级、写入时显式标成公开：公开接口返回（不带 visibility），查看器要显示。
  drafts.push({
    at: START + 2 * DAY + 4 * HOUR,
    type: 'staff.note',
    anchorId: 'counter-01',
    data: { note: '今日新品：桂花拿铁' },
    visibility: 'public',
  });

  // 相对"现在"的一批（按分钟取整，同一次运行里稳定）。
  const t0 = Math.floor(now / 60_000) * 60_000;
  drafts.push({
    at: t0 - 3 * HOUR,
    type: 'shop.status',
    anchorId: '_space',
    data: { status: '营业中' },
  });
  drafts.push({
    at: t0 - 20 * 60_000,
    type: 'table.occupancy',
    anchorId: 'table-01',
    data: { status: '有人', party: 3 },
  });
  // 座位默认不显示标签；有事件状态时要显示（锚点标签取舍的演示）。
  drafts.push({
    at: t0 - 15 * 60_000,
    type: 'table.occupancy',
    anchorId: 'seat-02',
    data: { status: '有人', party: 1 },
  });
  drafts.push({
    at: t0 - 10 * 60_000,
    type: 'staff.note',
    anchorId: 'counter-01',
    data: { note: '今日新品：桂花拿铁' },
    visibility: 'public',
  });
  for (let m = 55; m >= 2; m -= 4) {
    drafts.push({
      at: t0 - m * 60_000,
      type: 'visitor.count',
      anchorId: m % 3 === 0 ? 'door-01' : m % 3 === 1 ? 'zone-lounge' : 'counter-01',
      data: { count: 1 },
    });
  }

  const events = finish('evt', drafts);
  // 一条更正：第一次入座其实是预订。
  const first = events.find((e) => e.type === 'table.occupancy')!;
  events.push({
    ...first,
    id: 'evt-correction-1',
    sourceEventId: 'pos-correction-1',
    recordedAt: new Date(Date.parse(first.recordedAt) + HOUR).toISOString(),
    corrects: first.id,
    data: { status: '已预订', party: 2 },
  });
  return events;
}

/** 花店：营业状态、送花起点；相对"现在"有一单正在路上（只有起点）。 */
export function floristEvents(now: number = Date.now()): SpaceEvent[] {
  const drafts: Draft[] = [];
  for (let day = 17; day < 39; day += 1) {
    const base = START + day * DAY;
    drafts.push({
      at: base + 1.5 * HOUR,
      type: 'shop.status',
      anchorId: '_space',
      data: { status: '营业中' },
    });
    drafts.push({
      at: base + 10 * HOUR,
      type: 'shop.status',
      anchorId: '_space',
      data: { status: '已打烊' },
    });
  }
  deliveryDays().forEach((day, n) => {
    drafts.push({
      at: day + 10 * HOUR,
      type: 'delivery.sent',
      anchorId: 'counter',
      data: { item: '花束' },
      correlationId: `demo-florist:d${n + 1}`,
    });
  });
  const t0 = Math.floor(now / 60_000) * 60_000;
  drafts.push({
    at: t0 - 2 * HOUR,
    type: 'shop.status',
    anchorId: '_space',
    data: { status: '营业中' },
  });
  drafts.push({
    at: t0 - 8 * 60_000,
    type: 'delivery.sent',
    anchorId: 'counter',
    data: { item: '玫瑰花束' },
    correlationId: 'demo-florist:live',
  });
  return finish('flo', drafts);
}
