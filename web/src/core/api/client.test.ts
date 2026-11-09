import { describe, expect, it, vi } from 'vitest';
import { SHARE_TOKEN, SPACE_ID, fixtureStore } from '../../fixtures';
import { fixtureFetch } from '../../fixtures/server';
import { createPublicClient, PublicApiError, shareTokenFromHash } from './client';

describe('分享令牌', () => {
  it('从地址片段取出', () => {
    expect(shareTokenFromHash('#share=abc')).toBe('abc');
    expect(shareTokenFromHash('share=abc&x=1')).toBe('abc');
    expect(shareTokenFromHash('#t=preview')).toBeNull();
    expect(shareTokenFromHash('')).toBeNull();
    expect(shareTokenFromHash('#share=')).toBeNull();
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
    const timeline = await client.timeline(SPACE_ID);
    expect(timeline.items.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
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
    const events = await client.events(SPACE_ID, { types: ['order.served'] });
    expect(events.items.length).toBeGreaterThan(0);
    expect(events.items.every((e) => e.type === 'order.served')).toBe(true);
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

  it('编号为空或是 . / .. 时直接拒绝，不发请求', () => {
    expect(() => client.space('..')).toThrow(PublicApiError);
  });
});
