import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient } from '../core/api/client';
import {
  FLORIST_ID,
  SHARE_TOKEN,
  SPACE_ID,
  UNIVERSE_ID,
  UNIVERSE_SHARE_TOKEN,
  emitFixture,
  resetFixtureStore,
} from '../fixtures';
import { fixtureFetch } from '../fixtures/server';
import { SpaceRuntime, runtimeError } from './spaceRuntime';

/** 等到条件成立（最多 3 秒）。 */
async function until(check: () => boolean, label = '条件'): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等不到${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let runtime: SpaceRuntime | null = null;

beforeEach(() => {
  resetFixtureStore();
});

afterEach(() => {
  runtime?.stop();
  runtime = null;
});

function setup(options: { universe?: boolean } = {}) {
  const fetch = vi.fn(fixtureFetch);
  const client = createPublicClient({
    share: options.universe ? UNIVERSE_SHARE_TOKEN : SHARE_TOKEN,
    universe: options.universe ? UNIVERSE_ID : undefined,
    fetch,
  });
  const urls = () => fetch.mock.calls.map((call) => String(call[0]));
  const headers = () =>
    fetch.mock.calls.map((call) => (call[1]?.headers ?? {}) as Record<string, string>);
  return { client, fetch, urls, headers };
}

describe('回放', () => {
  it('提交取完全部页；时刻换算成 seq 取快照，不走 ?at=；事件按不超过 24 小时一段取', async () => {
    const { client, urls } = setup();
    runtime = new SpaceRuntime(client, SPACE_ID);
    runtime.start();
    await until(() => runtime!.getState().status === 'ready', '加载完');
    expect(runtime.getState().commits.map((c) => c.seq)).toEqual([1, 2, 3, 4]);

    runtime.setTime(Date.parse('2026-10-27T10:40:00Z'), false, 15 * 60_000);
    await until(() => runtime!.getState().scene?.seq === 3, '版本 3 的场景');
    await until(() => runtime!.getState().events.length > 0, '事件');
    await until(() => runtime!.getState().states.size > 0, '锚点状态');
    const state = runtime.getState();
    expect(state.events.some((e) => e.type === 'delivery.arrived')).toBe(true);
    expect(state.states.get('counter-01')?.get('decor')).toBeDefined();

    const snapshots = urls().filter((u) => u.includes('/snapshot'));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.every((u) => u.includes('seq=') && !u.includes('at='))).toBe(true);
    for (const url of urls().filter((u) => /\/events\?/.test(u))) {
      const params = new URL(url, 'http://x').searchParams;
      const span = Date.parse(params.get('to')!) - Date.parse(params.get('from')!);
      expect(span).toBeLessThanOrEqual(24 * 3_600_000);
    }

    // 拖到第一次提交之前：没有版本。
    runtime.setTime(Date.parse('2026-09-01T00:00:00Z'), false);
    expect(runtime.getState().seq).toBeNull();
    // 同一个版本不重复下载。
    const before = urls().filter((u) => u.includes('/snapshot')).length;
    runtime.setTime(Date.parse('2026-10-28T10:40:00Z'), false);
    await until(() => runtime!.getState().scene?.seq === 3);
    expect(urls().filter((u) => u.includes('/snapshot')).length).toBe(before);
  });

  it('组合页的成员：seq 由外面给出，请求都带 universe 参数', async () => {
    const { client, urls } = setup({ universe: true });
    runtime = new SpaceRuntime(client, FLORIST_ID, client, { seqSource: 'external' });
    runtime.start();
    await until(() => runtime!.getState().status === 'ready');
    runtime.setTime(Date.parse('2026-11-01T00:00:00Z'), false);
    expect(runtime.getState().seq).toBeNull();
    runtime.setSeq(1);
    await until(() => runtime!.getState().scene?.seq === 1);
    expect(urls().every((u) => u.includes(`universe=${UNIVERSE_ID}`))).toBe(true);
  });

  it('错误：404 统一说链接无效；断网另给提示', async () => {
    const client = createPublicClient({ share: 'wrong', fetch: fixtureFetch });
    runtime = new SpaceRuntime(client, SPACE_ID);
    runtime.start();
    await until(() => runtime!.getState().status === 'error');
    expect(runtime.getState().error).toMatchObject({ notFound: true });
    expect(runtimeError(new TypeError('Failed to fetch'))).toMatchObject({ notFound: false });
    expect(runtimeError(new Error('x')).message).toBe('x');
  });
});

describe('"现在"模式', () => {
  it('先取 state?at=now，再带 ETag 查 /head；变了按 since 增量拉事件；seq 变了换新快照', async () => {
    const { client, urls, headers } = setup();
    // 轮询间隔设得很长，由测试自己调 poll()。
    runtime = new SpaceRuntime(client, SPACE_ID, client, { pollMs: 1e9 });
    runtime.start();
    await until(() => runtime!.getState().status === 'ready');
    runtime.setTime(Date.now(), true, 10_000);
    await until(
      () => runtime!.getState().states.get('_space')?.get('open')?.value === '营业中',
      '营业状态',
    );
    expect(urls().some((u) => /\/state\?at=/.test(u))).toBe(true);
    expect(runtime.getState().states.get('table-01')?.get('occupancy')?.value).toBe('有人');

    // 没有变化：304，不再拉事件。
    const count = urls().length;
    await runtime.poll();
    expect(urls().length).toBe(count + 1);
    expect(urls().at(-1)).toContain('/head');
    expect(headers().at(-1)!['If-None-Match']).toMatch(/^"/);

    // 现实中发生了点什么。
    emitFixture('event');
    await runtime.poll();
    const since = urls().find((u) => u.includes('since='));
    expect(since).toBeDefined();
    runtime.setTime(Date.now(), true, 10_000);
    const state = runtime.getState();
    expect(state.events.some((e) => e.type === 'order.served' && e.data?.dish === '热可可')).toBe(
      true,
    );
    expect(state.states.get('_space')?.get('open')?.value).toBe('暂停营业');
    expect(state.changes).toBe(1);

    // 游标回退 5 秒会拿到重复的：按编号去重。
    await runtime.poll();
    const served = runtime.getState().events.filter((e) => e.data?.dish === '热可可');
    expect(served).toHaveLength(1);

    // 新的提交：补拉提交列表，换成新版本的快照。
    emitFixture('commit');
    await runtime.poll();
    expect(runtime.getState().commits.at(-1)?.seq).toBe(5);
    await until(() => runtime!.getState().scene?.seq === 5, '新版本的场景');
    expect(runtime.getState().scene?.entities.some((e) => e.entityId === 'planter-02')).toBe(true);
  });

  it('离开"现在"模式后停止轮询，可以再进入', async () => {
    const { client } = setup();
    runtime = new SpaceRuntime(client, SPACE_ID, client, { pollMs: 1e9 });
    runtime.start();
    await until(() => runtime!.getState().status === 'ready');
    runtime.setTime(Date.now(), true);
    expect(runtime.getState().live).toBe(true);
    runtime.setTime(Date.parse('2026-10-20T00:00:00Z'), false);
    expect(runtime.getState().live).toBe(false);
    runtime.stop();
    runtime.start();
    runtime.setTime(Date.now(), true);
    expect(runtime.getState().live).toBe(true);
  });
});
