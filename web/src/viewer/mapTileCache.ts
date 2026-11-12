/** 地图瓦片按公开 URL 缓存，与需要空间授权的模型缓存分开。 */
export const MAP_TILE_CACHE = 'chrono-metaverse-map-tiles-v1';
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 3600 * 1000;
let writes: Promise<void> = Promise.resolve();

async function open(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(MAP_TILE_CACHE);
  } catch {
    return null;
  }
}

async function save(cache: Cache, url: string, blob: Blob): Promise<void> {
  const entries = await Promise.all(
    (await cache.keys()).map(async (key) => {
      const response = await cache.match(key);
      return {
        key,
        bytes: Number(response?.headers.get('x-map-bytes')) || 0,
        saved: Number(response?.headers.get('x-map-saved')) || 0,
      };
    }),
  );
  let bytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  for (const entry of entries.sort((a, b) => a.saved - b.saved)) {
    if (bytes + blob.size <= MAX_BYTES && entry.saved > Date.now() - MAX_AGE) break;
    await cache.delete(entry.key);
    bytes -= entry.bytes;
  }
  await cache.put(
    url,
    new Response(blob, {
      headers: {
        'content-type': blob.type,
        'x-map-bytes': String(blob.size),
        'x-map-saved': String(Date.now()),
      },
    }),
  );
}

export async function mapTileImage(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const cache = await open();
  let blob: Blob | undefined;
  try {
    const stored = await cache?.match(url);
    if (stored && Number(stored.headers.get('x-map-saved')) > Date.now() - MAX_AGE)
      blob = await stored.blob();
  } catch {
    // 缓存不可用时正常联网。
  }
  const decode = async (value: Blob) => {
    const image = await createImageBitmap(value, { imageOrientation: 'flipY' });
    if (image.width > 2048 || image.height > 2048) {
      image.close();
      throw new Error('地图瓦片尺寸超过 2048 像素');
    }
    return image;
  };
  if (blob) {
    try {
      return await decode(blob);
    } catch {
      await cache?.delete(url).catch(() => false);
    }
  }
  const response = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw new Error(`地图影像 ${response.status}`);
  blob = await response.blob();
  if (blob.size > 8 * 1024 * 1024) throw new Error('地图瓦片超过 8 MiB');
  const image = await decode(blob);
  if (cache) {
    const data = blob;
    writes = writes.then(() => save(cache, url, data)).catch(() => undefined);
  }
  return image;
}
