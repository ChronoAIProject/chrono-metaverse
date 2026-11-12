// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalResponse, freshness, sourceResponse } from './externalResource';

const url = 'https://source.example.org/tile';
const signal = () => new AbortController().signal;
const stored = new Map<string, Response>();
const cache = {
  match: async (key: string) => stored.get(key)?.clone(),
  keys: async () => [...stored.keys()].map((key) => new Request(key)),
  put: async (key: string, response: Response) => {
    stored.set(key, response.clone());
  },
  delete: async (key: string | Request) => stored.delete(typeof key === 'string' ? key : key.url),
};

beforeEach(() => {
  stored.clear();
  vi.stubGlobal('caches', { open: async () => cache });
});
afterEach(() => vi.unstubAllGlobals());

describe('公开资源的 HTTP 缓存', () => {
  it('尊重 max-age、Age、Expires、禁止存储，并且来源配置只能缩短时间', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    expect(
      freshness(
        new Headers({ 'cache-control': 'public, max-age=14400', age: '60' }),
        undefined,
        now,
      ),
    ).toBe(14340000);
    expect(
      freshness(new Headers({ 'cache-control': 'max-age=14400' }), { maxAgeSeconds: 300 }, now),
    ).toBe(300000);
    expect(
      freshness(new Headers({ expires: 'Fri, 13 Nov 2026 01:00:00 GMT' }), undefined, now),
    ).toBe(3600000);
    for (const control of ['no-store, max-age=14400', 'no-cache', 's-maxage=14400', ''])
      expect(freshness(new Headers({ 'cache-control': control }), undefined, now)).toBe(0);
  });

  it('刷新复用新鲜内容，过期后重新验证，所有请求都不携带登录身份', async () => {
    const request = vi.fn(
      async () => new Response('tile', { headers: { 'cache-control': 'max-age=3600' } }),
    );
    vi.stubGlobal('fetch', request);
    expect(await (await externalResponse(url, signal())).text()).toBe('tile');
    await vi.waitFor(() => expect(stored.size).toBe(1));
    expect(await (await externalResponse(url, signal())).text()).toBe('tile');
    expect(request).toHaveBeenCalledTimes(1);
    const old = stored.get(url)!;
    old.headers.set('x-resource-expires', '0');
    await externalResponse(url, signal());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual([
      url,
      expect.objectContaining({ credentials: 'omit', mode: 'cors', cache: 'no-cache' }),
    ]);
    await vi.waitFor(() =>
      expect(Number(stored.get(url)?.headers.get('x-resource-expires'))).toBeGreaterThan(
        Date.now(),
      ),
    );
  });

  it('禁止存储的索引不会进入缓存，存储失效仍能加载', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('index', { headers: { 'cache-control': 'no-store' } })),
    );
    await externalResponse(url, signal());
    await externalResponse(url, signal());
    expect(stored.size).toBe(0);
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('disabled');
      },
    });
    expect(await (await externalResponse(url, signal())).text()).toBe('index');
  });

  it('跨域日期不可读取时使用原生 HTTP 缓存，不错误延长已缓存内容的新鲜期', async () => {
    const request = vi.fn(async () => {
      const response = new Response('tile', { headers: { 'cache-control': 'max-age=3600' } });
      Object.defineProperty(response, 'type', { value: 'cors' });
      return response;
    });
    vi.stubGlobal('fetch', request);
    await externalResponse(url, signal());
    await externalResponse(url, signal());
    expect(stored.size).toBe(0);
    expect(request.mock.calls[1]).toEqual([url, expect.objectContaining({ cache: 'default' })]);
  });

  it('拒绝错误状态及超大流，不使用旧缓存掩盖来源拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 })),
    );
    await expect(externalResponse(url, signal())).rejects.toThrow('403');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(100))),
    );
    await expect(externalResponse(url, signal(), undefined, 50)).rejects.toThrow('大小上限');
    expect(stored.size).toBe(0);
  });
});

describe('服务端外部资源', () => {
  it('每次经空间授权回调读取，不复用公开浏览器缓存或退回直连', async () => {
    const direct = vi.fn();
    vi.stubGlobal('fetch', direct);
    const load = vi.fn(async () => new Response('server data'));
    const request = { entity: 'context', kind: 'content' as const, source: 0, url };
    for (let i = 0; i < 2; i++) {
      expect(
        await (
          await sourceResponse({ delivery: 'server' }, { key: 'space:4', load }, request, signal())
        ).text(),
      ).toBe('server data');
    }
    expect(load).toHaveBeenCalledTimes(2);
    expect(direct).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
    load.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    await expect(
      sourceResponse({ delivery: 'server' }, { key: 'space:4', load }, request, signal()),
    ).rejects.toThrow('403');
    await expect(
      sourceResponse({ delivery: 'server' }, undefined, request, signal()),
    ).rejects.toThrow('权限');
    expect(direct).not.toHaveBeenCalled();
  });
});
