import {
  publicHttps,
  type SourceCache,
  type SourceDelivery,
  type ExternalAccess,
  type ExternalRequest,
} from '../core/externalSource';

export const EXTERNAL_RESOURCE_CACHE = 'chrono-metaverse-external-resources-v1';
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
let writes: Promise<void> = Promise.resolve();

/** 浏览器共享缓存只保存无凭据公开请求，并尊重服务端的新鲜期。 */
export function freshness(headers: Headers, policy?: SourceCache, now = Date.now()): number {
  if (policy?.persist === false) return 0;
  const control = headers.get('cache-control') ?? '';
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(control)) return 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control);
  const date = Date.parse(headers.get('date') ?? '');
  const age = Math.max(
    Number(headers.get('age')) || 0,
    Number.isFinite(date) ? (now - date) / 1000 : 0,
  );
  const expires = Date.parse(headers.get('expires') ?? '');
  const seconds = maxAge ? Number(maxAge[1]) - age : (expires - now) / 1000;
  return Math.max(0, Math.min(seconds || 0, policy?.maxAgeSeconds ?? 604800, 604800)) * 1000;
}

async function storage(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(EXTERNAL_RESOURCE_CACHE);
  } catch {
    return null;
  }
}

async function save(cache: Cache, url: string, response: Response): Promise<void> {
  const entries = await Promise.all(
    (await cache.keys()).map(async (key) => {
      const stored = await cache.match(key);
      return {
        key,
        bytes: Number(stored?.headers.get('x-resource-bytes')) || 0,
        saved: Number(stored?.headers.get('x-resource-saved')) || 0,
      };
    }),
  );
  let bytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  const incoming = Number(response.headers.get('x-resource-bytes'));
  for (const entry of entries.sort((a, b) => a.saved - b.saved)) {
    if (bytes + incoming <= MAX_CACHE_BYTES && entry.key.url !== url) continue;
    await cache.delete(entry.key);
    bytes -= entry.bytes;
  }
  await cache.put(url, response);
}

async function boundedBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('外部资源超过大小上限');
  }
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('外部资源超过大小上限');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}

export async function externalResponse(
  url: string,
  signal: AbortSignal,
  policy?: SourceCache,
  maxBytes = 32 * 1024 * 1024,
): Promise<Response> {
  if (!publicHttps(url)) throw new Error('外部资源必须使用公开 HTTPS 地址');
  signal.throwIfAborted();
  const cache = await storage();
  const stored = await cache?.match(url).catch(() => undefined);
  if (stored && policy?.persist !== false) {
    const saved = Number(stored.headers.get('x-resource-saved'));
    const expires = Number(stored.headers.get('x-resource-expires'));
    if (
      Number(stored.headers.get('x-resource-bytes')) <= maxBytes &&
      Date.now() < Math.min(expires, saved + (policy?.maxAgeSeconds ?? 604800) * 1000)
    )
      return stored;
  }
  const response = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: policy?.persist === false ? 'no-store' : stored ? 'no-cache' : 'default',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw new Error(`外部资源请求失败（${response.status}）`);
  const bytes = await boundedBody(response, maxBytes);
  signal.throwIfAborted();
  const now = Date.now();
  // 跨域响应隐藏日期时无法计算原生 HTTP 缓存已消耗的时间，交由浏览器自身管理。
  const canDate =
    response.type !== 'cors' || response.headers.has('date') || response.headers.has('expires');
  const duration = canDate ? freshness(response.headers, policy, now) : 0;
  const headers = new Headers({
    'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
    'x-resource-saved': String(now),
    'x-resource-expires': String(now + duration),
    'x-resource-bytes': String(bytes.byteLength),
  });
  const result = new Response(bytes, { headers });
  if (cache) {
    const copy = result.clone();
    writes = writes
      .then(async () => {
        if (duration > 0) await save(cache, url, copy);
        else await cache.delete(url);
      })
      .catch(() => undefined);
  }
  return result;
}

/** 服务端来源不降级为浏览器直连，避免绕过来源拒绝和空间权限。 */
export async function sourceResponse(
  source: SourceDelivery & { readonly cache?: SourceCache },
  access: ExternalAccess | undefined,
  request: ExternalRequest,
  signal: AbortSignal,
  maxBytes = 32 * 1024 * 1024,
): Promise<Response> {
  if (source.delivery !== 'server')
    return externalResponse(request.url, signal, source.cache, maxBytes);
  if (!access) throw new Error('当前查看方式未提供服务端资源访问权限');
  const response = await access.load(
    request,
    AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  );
  if (!response.ok) throw new Error(`外部资源请求失败（${response.status}）`);
  const bytes = await boundedBody(response, maxBytes);
  signal.throwIfAborted();
  return new Response(bytes, { headers: response.headers });
}
