import { describe, expect, it, vi } from 'vitest';
import {
  FLORIST_ID,
  PREVIEW_TOKEN,
  SHARE_TOKEN,
  SPACE_ID,
  UNIVERSE_ID,
  UNIVERSE_SHARE_TOKEN,
  fixtureStore,
} from '../../fixtures';
import { fixtureFetch } from '../../fixtures/server';
import {
  allEvents,
  allTimeline,
  createPublicClient,
  previewTokenFromHash,
  PublicApiError,
  shareTokenFromHash,
} from './client';

describe('分享令牌', () => {
  it('从地址片段取出', () => {
    expect(shareTokenFromHash('#share=abc')).toBe('abc');
    expect(shareTokenFromHash('share=abc&x=1')).toBe('abc');
    expect(shareTokenFromHash('#t=preview')).toBeNull();
    expect(shareTokenFromHash('')).toBeNull();
    expect(shareTokenFromHash('#share=')).toBeNull();
    expect(previewTokenFromHash('#t=abc')).toBe('abc');
    expect(previewTokenFromHash('#share=abc')).toBeNull();
  });
});

describe('公开读接口客户端', () => {
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });

  it('请求头带 Authorization: Share <令牌>，不带 Referer 和 Cookie', async () => {
    const spy = vi.fn(fixtureFetch);
    await createPublicClient({ share: 'tok', fetch: spy, baseUrl: 'https://x.test/' })
      .space('a b')
      .catch(() => undefined);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://x.test/api/public/spaces/a%20b');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Share tok');
    expect(init!.referrerPolicy).toBe('no-referrer');
    expect(init!.credentials).toBe('omit');
  });

  it('没有令牌时返回 404 问题文档', async () => {
    const anonymous = createPublicClient({ fetch: fixtureFetch });
    const error = await anonymous.space(SPACE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublicApiError);
    expect((error as PublicApiError).isNotFound).toBe(true);
    expect((error as PublicApiError).code).toBe('not_found');
  });

  it('读空间、提交、快照', async () => {
    const space = await client.space(SPACE_ID);
    expect(space.name).toBe('演示前厅');
    // 夹具每页 3 条：第一页带 nextAfter，allTimeline 取完全部。
    const first = await client.timeline(SPACE_ID);
    expect(first.items.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(first.nextAfter).not.toBeNull();
    expect((await allTimeline(client, SPACE_ID)).map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    const snapshot = await client.snapshot(SPACE_ID, { seq: 3 });
    expect(snapshot.seq).toBe(3);
    expect(snapshot.chunks.length).toBeGreaterThan(0);
    const byTime = await client.snapshot(SPACE_ID, { at: '2026-10-10T00:00:00Z' });
    expect(byTime.seq).toBe(2);
  });

  it('head 支持 ETag：第二次返回 304', async () => {
    const first = await client.head(SPACE_ID);
    expect(first.notModified).toBe(false);
    expect(first.head!.seq).toBe(4);
    const second = await client.head(SPACE_ID, first.etag);
    expect(second.notModified).toBe(true);
    expect(second.etag).toBe(first.etag);
  });

  it('区块下载后解压并核对哈希', async () => {
    const snapshot = await client.snapshot(SPACE_ID, { seq: 3 });
    const ref = snapshot.chunks[0]!;
    const cells = await client.chunk(ref.hash);
    expect(cells.length).toBe(32 * 32 * 32);
    expect(cells.some((v) => v >= 2)).toBe(true);
    await expect(client.chunk('not-a-hash')).rejects.toThrow(/无效/);
  });

  it('资源、事件、密度、状态', async () => {
    const glb = new Uint8Array(await client.asset(fixtureStore().scanHash));
    expect(String.fromCharCode(...glb.slice(0, 4))).toBe('glTF');
    const events = await allEvents(client, SPACE_ID, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
      types: ['order.served'],
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === 'order.served')).toBe(true);
    // 公开投影：data 只含公开字段，内部级事件不返回。
    const day = await allEvents(client, SPACE_ID, {
      from: '2026-10-03T00:00:00Z',
      to: '2026-10-04T00:00:00Z',
    });
    expect(day.some((e) => e.type === 'staff.note')).toBe(false);
    await expect(
      client.events(SPACE_ID, { from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }),
    ).rejects.toThrow(/24 小时/);
    const density = await client.eventDensity(SPACE_ID, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-08T00:00:00Z',
      bucket: 86_400,
    });
    expect(density.buckets).toHaveLength(7);
    const state = await client.state(SPACE_ID, '2026-10-01T01:30:00Z');
    expect(Array.isArray(state.states)).toBe(true);
  });

  it('预览用预览令牌，不带分享令牌，不缓存', async () => {
    const spy = vi.fn(fixtureFetch);
    const previewClient = createPublicClient({ share: SHARE_TOKEN, fetch: spy });
    await previewClient.preview('preview-token').catch(() => undefined);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('/api/public/previews');
    expect(init!.headers).toEqual({ Authorization: 'Preview preview-token' });
    expect(init!.cache).toBe('no-store');
  });

  it('资源下载报告进度，带 Content-Length 时总数已知', async () => {
    const progress: [number, number | null][] = [];
    const bytes = await client.asset(fixtureStore().scanHash, (loaded, total) =>
      progress.push([loaded, total]),
    );
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toEqual([bytes.byteLength, bytes.byteLength]);
    expect(progress[0]![1]).toBe(bytes.byteLength);
  });

  it('组合页：用组合令牌读成员空间，每个请求带 ?universe=', async () => {
    const spy = vi.fn(fixtureFetch);
    const universe = createPublicClient({
      share: UNIVERSE_SHARE_TOKEN,
      universe: UNIVERSE_ID,
      fetch: spy,
    });
    const view = await universe.universe(UNIVERSE_ID, '2026-10-26T00:00:00Z');
    expect(view.members.map((m) => [m.spaceId, m.seq])).toEqual([
      [SPACE_ID, 3],
      [FLORIST_ID, 2],
    ]);
    expect(view.links).toHaveLength(1);
    const early = await universe.universe(UNIVERSE_ID, '2026-10-05T00:00:00Z');
    expect(early.members.map((m) => m.spaceId)).toEqual([SPACE_ID]);
    const florist = await universe.space(FLORIST_ID);
    expect(florist.name).toBe('街角花店');
    const snapshot = await universe.snapshot(FLORIST_ID, { seq: 2 });
    expect(snapshot.entities.some((e) => e.body.assetHash !== undefined)).toBe(true);
    expect(spy.mock.calls.at(-1)![0]).toBe(
      `/api/public/spaces/${FLORIST_ID}/snapshot?seq=2&universe=${UNIVERSE_ID}`,
    );
    // 不带 universe 参数时，组合令牌读不了成员空间。
    const plain = createPublicClient({ share: UNIVERSE_SHARE_TOKEN, fetch: fixtureFetch });
    await expect(plain.space(FLORIST_ID)).rejects.toMatchObject({ status: 404 });
    // 组合令牌错了也是 404。
    const wrong = createPublicClient({ share: 'nope', universe: UNIVERSE_ID, fetch: fixtureFetch });
    await expect(wrong.universe(UNIVERSE_ID)).rejects.toMatchObject({ status: 404 });
  });

  it('预览：草稿区块和草稿贴图只能经预览接口读取', async () => {
    const view = await client.preview(PREVIEW_TOKEN);
    expect(view.preview.baseSeq).toBe(4);
    expect(view.entities.some((e) => e.id === 'bench-draft')).toBe(true);
    const draftHashes = [...fixtureStore().draftChunks.keys()];
    expect(draftHashes.length).toBeGreaterThan(0);
    const cells = await client.previewChunk(PREVIEW_TOKEN, draftHashes[0]!);
    expect(cells.some((v) => v >= 2)).toBe(true);
    // 公开地址拿不到草稿区块。
    await expect(client.chunk(draftHashes[0]!)).rejects.toMatchObject({ status: 404 });
    const [texture] = fixtureStore().draftAssets.keys();
    expect((await client.previewAsset(PREVIEW_TOKEN, texture!)).byteLength).toBeGreaterThan(0);
    await expect(client.asset(texture!)).rejects.toMatchObject({ status: 404 });
    await expect(client.preview('wrong')).rejects.toMatchObject({ status: 404 });
  });

  it('编号为空或是 . / .. 时直接拒绝，不发请求', () => {
    expect(() => client.space('..')).toThrow(PublicApiError);
  });
});
