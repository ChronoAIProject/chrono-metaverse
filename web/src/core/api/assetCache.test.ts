// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256HexOfText } from '../hash';
import { BrowserAssetCache } from './assetCache';

class StoredResponses {
  readonly values = new Map<string, Response>();
  async match(key: Request | string) {
    return this.values.get(typeof key === 'string' ? key : key.url)?.clone();
  }
  async put(key: string, response: Response) {
    this.values.set(key, response.clone());
  }
  async delete(key: string) {
    return this.values.delete(key);
  }
  async keys() {
    return [...this.values.keys()].map((key) => new Request(key));
  }
}

describe('浏览器资源持久缓存', () => {
  let stored: StoredResponses;
  beforeEach(() => {
    stored = new StoredResponses();
    vi.stubGlobal('caches', { open: async () => stored });
  });
  afterEach(() => vi.unstubAllGlobals());
  const blob = (text = 'model') => new Response(text).blob();
  const hash = sha256HexOfText('model');

  it('重建加载器后复用已保存的资源，不再次下载', async () => {
    const download = vi.fn(() => blob());
    await new BrowserAssetCache().get('grant', hash, download);
    const result = await new BrowserAssetCache().get('grant', hash, download);
    expect(await result.text()).toBe('model');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('授权或修订不同的作用域不共享私有资源', async () => {
    const download = vi.fn(() => blob());
    const cache = new BrowserAssetCache();
    await cache.get('grant-a', hash, download);
    await cache.get('grant-b', hash, download);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('缓存损坏后重新下载，并用正确的内容替换', async () => {
    await new BrowserAssetCache().get('grant', hash, () => blob());
    const key = [...stored.values.keys()][0]!;
    stored.values.set(key, new Response('broken'));
    const download = vi.fn(() => blob());
    expect(await (await new BrowserAssetCache().get('grant', hash, download)).text()).toBe('model');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('存储不可用时照常在线加载', async () => {
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('storage disabled');
      },
    });
    const download = vi.fn(() => blob());
    const cache = new BrowserAssetCache();
    await cache.get('grant', hash, download);
    await cache.get('grant', hash, download);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('超出容量时清除较早的资源', async () => {
    const cache = new BrowserAssetCache(8);
    await cache.get('grant', sha256HexOfText('first'), () => blob('first'));
    await cache.get('grant', sha256HexOfText('last'), () => blob('last'));
    expect(stored.values.size).toBe(1);
    expect([...stored.values.keys()][0]).toContain(sha256HexOfText('last'));
  });

  it('同一资源并发请求只下载一次', async () => {
    const download = vi.fn(() => blob());
    const cache = new BrowserAssetCache();
    await Promise.all([cache.get('grant', hash, download), cache.get('grant', hash, download)]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('不把哈希不符的网络内容写入缓存', async () => {
    await new BrowserAssetCache().get('grant', hash, () => blob('unexpected'));
    expect(stored.values.size).toBe(0);
  });
});
