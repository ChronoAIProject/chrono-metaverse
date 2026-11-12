import { sha256Hex } from '../hash';

export const ASSET_CACHE_NAME = 'chrono-metaverse-models-v1';
export const ASSET_CACHE_LIMIT = 512 * 1024 * 1024;

/** 只存资源字节；调用方先重新验证预览授权，作用域使用令牌的哈希，不保存令牌原文。 */
export class BrowserAssetCache {
  private opened: Promise<Cache | null> | null = null;
  private readonly pending = new Map<string, Promise<Blob>>();
  private entries: Map<string, { bytes: number; saved: number }> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly limit = ASSET_CACHE_LIMIT) {}

  private open(): Promise<Cache | null> {
    return (this.opened ??= Promise.resolve().then(async () => {
      try {
        return typeof caches === 'undefined' ? null : await caches.open(ASSET_CACHE_NAME);
      } catch {
        // 浏览器禁用存储时仍然可以在线加载。
        return null;
      }
    }));
  }

  private async valid(blob: Blob, hash: string): Promise<boolean> {
    const bytes = await blob.arrayBuffer();
    if (globalThis.crypto?.subtle) {
      try {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') === hash;
      } catch {
        // WebCrypto 不可用时使用同一份同步校验实现。
      }
    }
    return sha256Hex(new Uint8Array(bytes)) === hash;
  }

  get(scope: string, hash: string, load: () => Promise<Blob>): Promise<Blob> {
    const origin = globalThis.location?.origin ?? 'https://cache.invalid';
    const key = `${origin}/__metaverse_asset_cache__/${scope}/${hash}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = this.read(key, hash, load);
    this.pending.set(key, result);
    void result.finally(() => this.pending.delete(key)).catch(() => undefined);
    return result;
  }

  private async read(key: string, hash: string, load: () => Promise<Blob>): Promise<Blob> {
    const cache = await this.open();
    if (cache) {
      try {
        const stored = await cache.match(key);
        if (stored) {
          const blob = await stored.blob();
          if (await this.valid(blob, hash)) return blob;
          await cache.delete(key);
          this.entries?.delete(key);
        }
      } catch {
        // 缓存读取失败或内容损坏时重新下载。
      }
    }
    const blob = await load();
    if (!cache || blob.size > this.limit) return blob;
    try {
      if (!(await this.valid(blob, hash))) return blob;
    } catch {
      // 本地校验不可用时正常返回在线资源。
      return blob;
    }
    // 串行写入和清理，避免多个大模型同时写入时超出总量。
    const write = this.writes.then(() => this.store(cache, key, blob));
    this.writes = write.catch(() => undefined);
    await this.writes;
    return blob;
  }

  private async store(cache: Cache, key: string, blob: Blob): Promise<void> {
    if (this.entries === null) {
      const keys = await cache.keys();
      const entries = await Promise.all(
        keys.map(async (request) => {
          const response = await cache.match(request);
          return [
            request.url,
            {
              bytes: Number(response?.headers.get('x-asset-bytes')) || 0,
              saved: Number(response?.headers.get('x-asset-saved')) || 0,
            },
          ] as const;
        }),
      );
      this.entries = new Map(entries);
    }
    const entries = this.entries;
    let total = [...entries.values()].reduce((sum, value) => sum + value.bytes, 0);
    for (const [oldKey, value] of [...entries].sort((a, b) => a[1].saved - b[1].saved)) {
      if (total + blob.size <= this.limit) break;
      await cache.delete(oldKey);
      entries.delete(oldKey);
      total -= value.bytes;
    }
    const saved = Date.now();
    const response = () =>
      new Response(blob, {
        headers: {
          'content-type': blob.type || 'application/octet-stream',
          'x-asset-bytes': String(blob.size),
          'x-asset-saved': String(saved),
        },
      });
    try {
      await cache.put(key, response());
    } catch {
      // 实际可用配额可能比上限小，释放一份旧资源后重试；失败也不影响查看。
      const oldest = [...entries].sort((a, b) => a[1].saved - b[1].saved)[0];
      if (!oldest) return;
      await cache.delete(oldest[0]);
      entries.delete(oldest[0]);
      await cache.put(key, response());
    }
    entries.set(key, { bytes: blob.size, saved });
  }
}

export const browserAssetCache = new BrowserAssetCache();
