import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Texture } from 'three';
import type { PublicClient } from '../core/api/client';
import type { DensityBucket } from '../core/api/types';
import type { RuntimeState, SpaceRuntime } from './spaceRuntime';

const NO_RUNTIME: RuntimeState = {
  status: 'loading',
  error: null,
  info: null,
  commits: [],
  seq: null,
  scene: null,
  sceneLoading: false,
  progress: null,
  events: [],
  states: new Map(),
  live: false,
  changes: 0,
};

const noop = () => () => undefined;

/** 订阅一个空间的数据；还没建好时返回"加载中"。 */
export function useRuntimeState(runtime: SpaceRuntime | null): RuntimeState {
  return useSyncExternalStore(
    runtime === null ? noop : (listener) => runtime.subscribe(listener),
    () => (runtime === null ? NO_RUNTIME : runtime.getState()),
  );
}

/** 订阅一组空间（组合页的各成员）；任何一个变化都重新渲染。 */
export function useRuntimeStates(runtimes: readonly SpaceRuntime[]): RuntimeState[] {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const offs = runtimes.map((runtime) => runtime.subscribe(() => setVersion((v) => v + 1)));
    return () => offs.forEach((off) => off());
  }, [runtimes]);
  return runtimes.map((runtime) => runtime.getState());
}

/** 资源的取法：公开接口（凭分享令牌）或预览接口（凭预览令牌）。 */
export interface BlobSource {
  assetBlob(hash: string): Promise<Blob>;
  asset(hash: string): Promise<ArrayBuffer>;
}

/** 按资源哈希取贴图：下载、解码成图片、做成 three.js 贴图（按哈希缓存）。 */
export function useAssetLoaders(source: BlobSource): {
  loadTexture: (hash: string) => Promise<Texture>;
  loadModel: (hash: string) => Promise<ArrayBuffer>;
} {
  return useMemo(() => {
    const models = new Map<string, Promise<ArrayBuffer>>();
    return {
      async loadTexture(hash: string) {
        const blob = await source.assetBlob(hash);
        const url = URL.createObjectURL(blob);
        try {
          const image = new Image();
          image.decoding = 'async';
          image.src = url;
          await image.decode();
          const texture = new Texture(image);
          texture.needsUpdate = true;
          return texture;
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      loadModel(hash: string) {
        let pending = models.get(hash);
        if (pending === undefined) {
          pending = source.asset(hash);
          models.set(hash, pending);
          pending.catch(() => models.delete(hash));
        }
        return pending;
      },
    };
  }, [source]);
}

/** 聚合接口每次最多 90 天。 */
const DENSITY_MAX_MS = 90 * 86_400_000;
const DENSITY_BUCKETS = 160;

/**
 * 时间轴上的事件密度（设计 7.2，用聚合接口取数）：范围超过 90 天时分段取再拼起来；
 * 组合页把各成员的密度按桶相加。取不到时返回空数组，时间轴照常可用。
 */
export function useDensity(
  client: PublicClient,
  spaceIds: readonly string[],
  from: number,
  to: number,
  version: number,
  enabled: boolean,
): DensityBucket[] {
  const [density, setDensity] = useState<DensityBucket[]>([]);
  const key = spaceIds.join('\u0000');
  // 范围随"现在"推移而变：按分钟取整，避免每次时刻变化都重新请求。
  const fromKey = Math.floor(from / 3_600_000);
  const toKey = Math.ceil(to / 3_600_000);
  useEffect(() => {
    if (!enabled || spaceIds.length === 0) return;
    let cancelled = false;
    const start = fromKey * 3_600_000;
    const end = toKey * 3_600_000;
    const bucketSec = Math.max(60, Math.ceil((end - start) / 1000 / DENSITY_BUCKETS));
    const bucketMs = bucketSec * 1000;
    const count = Math.ceil((end - start) / bucketMs);
    const ranges: [number, number][] = [];
    const span = Math.floor(DENSITY_MAX_MS / bucketMs) * bucketMs;
    for (let t = start; t < end; t += span) ranges.push([t, Math.min(end, t + span)]);
    Promise.all(
      spaceIds.flatMap((spaceId) =>
        ranges.map(([a, b]) =>
          client
            .eventDensity(spaceId, {
              from: new Date(a).toISOString(),
              to: new Date(b).toISOString(),
              bucket: bucketSec,
            })
            .then((result) => result.buckets)
            .catch(() => [] as DensityBucket[]),
        ),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const counts = new Array<number>(count).fill(0);
      for (const list of lists) {
        for (const bucket of list) {
          const index = Math.floor((Date.parse(bucket.start) - start) / bucketMs);
          if (index >= 0 && index < count) counts[index] = counts[index]! + bucket.count;
        }
      }
      setDensity(
        counts.map((n, i) => ({ start: new Date(start + i * bucketMs).toISOString(), count: n })),
      );
    });
    return () => {
      cancelled = true;
    };
    // spaceIds 用拼接后的 key 比较。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, fromKey, toKey, version, enabled]);
  return density;
}
