import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicClient } from '../core/api/client';
import type { AnchorState, CommitSummary, DensityBucket, SpaceInfo } from '../core/api/types';
import { commitAt, toMillis } from '../core/events';
import { loadScene, type SceneDocument } from '../core/scene';

/**
 * 一个空间的数据：空间信息、提交列表、事件密度、当前时刻的场景和锚点状态。
 *
 * - 时刻 T 的场景 = at ≤ T 的最后一次提交的快照（按 seq 缓存，来回拖动不重复下载）；
 * - "现在"模式每 5 秒带 ETag 查一次 /head，有变化才刷新提交和状态（设计 5.5）；
 * - 锚点状态按 T 取 `state?at=`，拖动和播放时节流。
 */

export type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly notFound: boolean }
  | { readonly status: 'ready' };

export const HEAD_POLL_MS = 5000;
const DENSITY_BUCKETS = 160;
const STATE_THROTTLE_MS = 400;

export interface SpaceData {
  readonly load: LoadState;
  readonly space: SpaceInfo | null;
  readonly commits: readonly CommitSummary[];
  readonly density: readonly DensityBucket[];
  readonly range: { readonly from: number; readonly to: number };
  /** 当前时刻生效的提交；时刻早于第一次提交时为 null。 */
  readonly commit: CommitSummary | null;
  readonly scene: SceneDocument | null;
  readonly sceneLoading: boolean;
  readonly states: ReadonlyMap<string, ReadonlyMap<string, AnchorState>>;
  readonly loadScan: (hash: string) => Promise<ArrayBuffer>;
}

function errorMessage(error: unknown): { message: string; notFound: boolean } {
  const status = (error as { status?: number }).status;
  if (status === 404) {
    return {
      message: '找不到这个空间，或者分享链接已失效。请确认链接完整（包含 # 后面的部分）。',
      notFound: true,
    };
  }
  return { message: error instanceof Error ? error.message : String(error), notFound: false };
}

export function useSpace(
  client: PublicClient,
  spaceId: string,
  time: number,
  live: boolean,
  now: () => number = Date.now,
): SpaceData {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [space, setSpace] = useState<SpaceInfo | null>(null);
  const [commits, setCommits] = useState<readonly CommitSummary[]>([]);
  const [density, setDensity] = useState<readonly DensityBucket[]>([]);
  // 最近一次加载完成的场景；切换版本时先保留旧的，新的到了再换，画面不闪。
  const [loadedScene, setLoadedScene] = useState<SceneDocument | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, ReadonlyMap<string, AnchorState>>>(
    new Map(),
  );
  const [headVersion, setHeadVersion] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => now());
  const scenes = useRef(new Map<number, Promise<SceneDocument>>());
  const scans = useRef(new Map<string, Promise<ArrayBuffer>>());

  // 空间信息和提交列表。
  useEffect(() => {
    // 空间或令牌变了，页面会整个重新挂载（App 里按它们设 key），所以这里不用先重置状态。
    let cancelled = false;
    Promise.all([client.space(spaceId), client.timeline(spaceId)])
      .then(([info, timeline]) => {
        if (cancelled) return;
        setSpace(info);
        setCommits(timeline.items);
        setLoadedAt(now());
        setLoad({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', ...errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
    // now 只用来取当前时间，不作为依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, spaceId]);

  const range = useMemo(() => {
    const first = commits.length > 0 ? toMillis(commits[0]!.at) : loadedAt - 7 * 86_400_000;
    const last = commits.length > 0 ? toMillis(commits[commits.length - 1]!.at) : loadedAt;
    const to = Math.max(loadedAt, last, time);
    const from = Math.min(first - 86_400_000, to - 86_400_000);
    return { from, to };
  }, [commits, loadedAt, time]);

  // 事件密度（只按加载时的范围取一次；"现在"模式有新事件时再取）。
  const densityFrom = range.from;
  const densityTo = Math.max(range.to, loadedAt);
  useEffect(() => {
    if (load.status !== 'ready') return;
    let cancelled = false;
    const bucket = Math.max(60, Math.ceil((densityTo - densityFrom) / 1000 / DENSITY_BUCKETS));
    client
      .eventDensity(spaceId, {
        from: new Date(densityFrom).toISOString(),
        to: new Date(densityTo).toISOString(),
        bucket,
      })
      .then((result) => {
        if (!cancelled) setDensity(result.buckets);
      })
      .catch(() => {
        // 密度只是辅助信息，取不到时时间轴照常可用。
      });
    return () => {
      cancelled = true;
    };
    // 范围随时间推移会变化；只在加载、空间变化或 head 变化时重新取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, spaceId, load.status, headVersion]);

  const commit = useMemo(() => commitAt(commits, time), [commits, time]);
  const seq = commit?.seq ?? null;

  // 当前 seq 的场景。
  useEffect(() => {
    if (seq === null) return;
    let cancelled = false;
    let pending = scenes.current.get(seq);
    if (pending === undefined) {
      pending = client
        .snapshot(spaceId, { seq })
        .then((snapshot) => loadScene(client, snapshot, space?.name));
      scenes.current.set(seq, pending);
      pending.catch(() => scenes.current.delete(seq));
    }
    pending
      .then((next) => {
        if (!cancelled) setLoadedScene(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', ...errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, spaceId, seq, space?.name]);
  const scene = seq === null ? null : loadedScene;
  const sceneLoading = seq !== null && loadedScene?.seq !== seq;

  // 锚点状态：节流（最多每 400 毫秒取一次，并保证最后一个时刻一定会取），播放时也能跟上。
  const lastStateFetch = useRef(0);
  useEffect(() => {
    if (load.status !== 'ready') return;
    let cancelled = false;
    const fetchState = () => {
      lastStateFetch.current = Date.now();
      client
        .state(spaceId, new Date(time).toISOString())
        .then((result) => {
          if (cancelled) return;
          const map = new Map<string, Map<string, AnchorState>>();
          for (const state of result.states) {
            const entry = map.get(state.anchorId) ?? new Map<string, AnchorState>();
            entry.set(state.key, state);
            map.set(state.anchorId, entry);
          }
          setStates(map);
        })
        .catch(() => {
          // 状态取不到时不影响场景显示。
        });
    };
    const wait = Math.max(0, STATE_THROTTLE_MS - (Date.now() - lastStateFetch.current));
    const timer = setTimeout(fetchState, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, spaceId, time, load.status, headVersion]);

  // "现在"模式：轮询 /head。
  useEffect(() => {
    if (!live || load.status !== 'ready') return;
    let etag: string | null = null;
    let lastSeq = commits.length > 0 ? commits[commits.length - 1]!.seq : 0;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await client.head(spaceId, etag);
        etag = result.etag;
        if (stopped || result.notModified || result.head === undefined) return;
        if (result.head.seq !== lastSeq) {
          lastSeq = result.head.seq;
          const timeline = await client.timeline(spaceId);
          if (!stopped) setCommits(timeline.items);
        }
        setHeadVersion((v) => v + 1);
      } catch {
        // 下一轮再试。
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), HEAD_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // commits 的变化由轮询自己更新，不作为依赖，避免重复启动定时器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, spaceId, live, load.status]);

  const loadScan = useCallback(
    (hash: string) => {
      let pending = scans.current.get(hash);
      if (pending === undefined) {
        pending = client.asset(hash);
        scans.current.set(hash, pending);
        pending.catch(() => scans.current.delete(hash));
      }
      return pending;
    },
    [client],
  );

  return { load, space, commits, density, range, commit, scene, sceneLoading, states, loadScan };
}
