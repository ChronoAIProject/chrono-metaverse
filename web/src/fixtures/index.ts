import type { Snapshot, SpaceInfo } from '../core/api/types';
import { sha256Hex } from '../core/hash';
import { palette, chunksAt, storeChunks } from './chunks';
import { SHARE_TOKEN, SPACE_ID, SPACE_NAME, anchors, entitiesAt, plots, regions } from './lobby';
import { fixtureScanGlb } from './scanModel';
import { commits, eventTypes, fixtureEvents } from './timeline';

export { SHARE_TOKEN, SPACE_ID, SPACE_NAME } from './lobby';

/**
 * 夹具数据仓库：公开读接口要返回的全部内容，按需生成一次后缓存。
 * 开发用夹具插件（build/devFixtures.ts）和组件测试都从这里取数据。
 */
export interface FixtureStore {
  readonly spaceId: string;
  readonly shareToken: string;
  readonly space: SpaceInfo;
  readonly commits: typeof commits;
  readonly events: ReturnType<typeof fixtureEvents>;
  readonly eventTypes: typeof eventTypes;
  readonly snapshot: (seq: number) => Snapshot | undefined;
  readonly chunk: (hash: string) => Uint8Array | undefined;
  readonly asset: (hash: string) => Uint8Array | undefined;
  readonly scanHash: string;
}

let store: FixtureStore | undefined;

export function fixtureStore(): FixtureStore {
  if (store !== undefined) return store;
  const scan = fixtureScanGlb();
  const scanHash = sha256Hex(scan);
  const chunkBytes = new Map<string, Uint8Array>();
  const snapshots = new Map<number, Snapshot>();
  for (const commit of commits) {
    const stored = storeChunks(chunksAt(commit.seq));
    for (const { ref, compressed } of stored) chunkBytes.set(ref.hash, compressed);
    snapshots.set(commit.seq, {
      spaceId: SPACE_ID,
      seq: commit.seq,
      at: commit.at,
      palette,
      chunks: stored.map((s) => s.ref),
      entities: entitiesAt(commit.seq).map((body) => ({ id: body.entityId, body })),
      anchors: anchors.filter((a) => a.visibility === 'public'),
      regions,
      plots,
      scan: { webModelHashes: [scanHash], observedAt: commits[0]!.observedAt },
    });
  }
  const head = commits[commits.length - 1]!;
  const events = fixtureEvents();
  store = {
    spaceId: SPACE_ID,
    shareToken: SHARE_TOKEN,
    space: {
      id: SPACE_ID,
      name: SPACE_NAME,
      description: '本地夹具：一个按形状词表写成的小前厅，东侧是虚拟展区。',
      visibility: 'unlisted',
      regions,
      anchors: anchors.filter((a) => a.visibility === 'public'),
      head: {
        seq: head.seq,
        at: head.at,
        recordedAt: events.reduce((max, e) => (e.recordedAt > max ? e.recordedAt : max), head.at),
      },
      eventTypes,
    },
    commits,
    events,
    eventTypes,
    snapshot: (seq) => snapshots.get(seq),
    chunk: (hash) => chunkBytes.get(hash),
    asset: (hash) => (hash === scanHash ? scan : undefined),
    scanHash,
  };
  return store;
}
