import type {
  Anchor,
  CommitSummary,
  EntityBody,
  EventTypeDef,
  PreviewView,
  Region,
  Plot,
  Snapshot,
  SpaceEvent,
  SpaceInfo,
  UniverseLink,
  UniverseMember,
} from '../core/api/types';
import { toMillis } from '../core/events';
import { sha256Hex } from '../core/hash';
import { DRAFT_TEXTURE, MODELS, TEXTURES, type FixtureAsset } from './assets';
import { chunksAt, chunksFrom, palette, storeChunks } from './chunks';
import {
  FLORIST_ID,
  FLORIST_NAME,
  FLORIST_SHARE_TOKEN,
  floristAnchors,
  floristEntities,
  floristRegions,
} from './florist';
import { SHARE_TOKEN, SPACE_ID, SPACE_NAME, anchors, entitiesAt, plots, regions } from './lobby';
import { SCAN_TRANSFORM, fixtureScanGlb } from './scanModel';
import {
  commits,
  eventTypes,
  fixtureEvents,
  floristCommits,
  floristEventTypes,
  floristEvents,
} from './timeline';

export { SHARE_TOKEN, SPACE_ID, SPACE_NAME } from './lobby';
export { FLORIST_ID, FLORIST_NAME, FLORIST_SHARE_TOKEN } from './florist';

/** 组合宇宙"街角"：前厅和花店，中间隔一条街。 */
export const UNIVERSE_ID = 'demo-street';
export const UNIVERSE_NAME = '街角';
export const UNIVERSE_SHARE_TOKEN = 'fixture-universe-token-00112233445566778899';
/** 草稿预览令牌（夹具里固定）。 */
export const PREVIEW_TOKEN = 'fixture-preview-token-aabbccddeeff00112233445566778899';

/**
 * 夹具数据仓库：公开读接口要返回的全部内容，按需生成一次后缓存。
 * 开发用夹具插件（build/devFixtures.ts）和组件测试都从这里取数据。
 *
 * "现在"模式的端到端测试可以往里追加事件和提交（emitFixture），用完 resetFixtureStore。
 */
export interface FixtureSpace {
  readonly id: string;
  readonly name: string;
  readonly shareToken: string;
  readonly description: string;
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly anchors: readonly Anchor[];
  readonly eventTypes: readonly EventTypeDef[];
  readonly commits: CommitSummary[];
  readonly events: SpaceEvent[];
  readonly snapshots: Map<number, Snapshot>;
}

export interface UniverseRevisionFixture {
  readonly seq: number;
  readonly at: string;
  readonly message: string;
  readonly members: readonly Omit<UniverseMember, 'seq'>[];
  readonly links: readonly UniverseLink[];
}

export interface FixtureStore {
  readonly now: number;
  readonly spaces: Map<string, FixtureSpace>;
  readonly universe: {
    readonly id: string;
    readonly name: string;
    readonly shareToken: string;
    readonly revisions: readonly UniverseRevisionFixture[];
  };
  readonly preview: { readonly token: string; readonly view: PreviewView };
  /** 已发布的区块（压缩字节）。 */
  readonly chunks: Map<string, Uint8Array>;
  /** 只有草稿里才有的区块。 */
  readonly draftChunks: Map<string, Uint8Array>;
  readonly assets: Map<string, FixtureAsset>;
  readonly draftAssets: Map<string, FixtureAsset>;
  readonly scanHash: string;
  /** 兼容旧测试：前厅的数据。 */
  readonly spaceId: string;
  readonly shareToken: string;
  readonly space: SpaceInfo;
  readonly commits: CommitSummary[];
  readonly events: SpaceEvent[];
  readonly eventTypes: readonly EventTypeDef[];
  readonly snapshot: (seq: number) => Snapshot | undefined;
  readonly chunk: (hash: string) => Uint8Array | undefined;
  readonly asset: (hash: string) => Uint8Array | undefined;
}

let store: FixtureStore | undefined;
let extraSeq = 0;

function lobbyEntities(seq: number): EntityBody[] {
  const base = entitiesAt(Math.min(seq, 4));
  if (seq < 5) return base;
  // "现在"模式测试追加的提交：前台旁边多了一盆绿植。
  const planter = base.find((e) => e.entityId === 'planter-01')!;
  return [
    ...base,
    {
      ...planter,
      entityId: 'planter-02',
      shape: { ...planter.shape!, transform: { position: [3.4, 0, 4.4] } },
      bounds: { min: [3.12, 0, 4.12], max: [3.68, 1.48, 4.68] },
    },
  ];
}

function snapshotFor(
  space: Omit<FixtureSpace, 'snapshots'>,
  seq: number,
  at: string,
  entities: EntityBody[],
  chunkRefs: Snapshot['chunks'],
  scan: Snapshot['scan'],
): Snapshot {
  return {
    spaceId: space.id,
    seq,
    at,
    palette,
    chunks: chunkRefs,
    entities: entities.map((body) => ({ id: body.entityId, body })),
    anchors: space.anchors.filter((a) => a.visibility === 'public'),
    regions: space.regions,
    plots: space.plots,
    scan,
  };
}

function headOf(space: FixtureSpace) {
  const head = space.commits[space.commits.length - 1]!;
  const recordedAt = space.events.reduce(
    (max, e) => (e.recordedAt > max ? e.recordedAt : max),
    head.at,
  );
  return { seq: head.seq, at: head.at, recordedAt };
}

export function spaceInfo(space: FixtureSpace): SpaceInfo {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    visibility: 'unlisted',
    regions: space.regions,
    plots: space.plots,
    anchors: space.anchors.filter((a) => a.visibility === 'public'),
    head: headOf(space),
    eventTypes: space.eventTypes.filter((t) => t.defaultVisibility !== 'internal'),
  };
}

/** 重新生成夹具（测试之间、端到端测试开始时用）。`now` 决定相对"现在"的那批事件。 */
export function resetFixtureStore(now: number = Date.now()): FixtureStore {
  store = undefined;
  extraSeq = 0;
  return fixtureStore(now);
}

export function fixtureStore(now: number = Date.now()): FixtureStore {
  if (store !== undefined) return store;
  const assets = new Map<string, FixtureAsset>();
  for (const asset of [...Object.values(TEXTURES), ...Object.values(MODELS)]) {
    assets.set(asset.hash, asset);
  }
  const scanBytes = fixtureScanGlb();
  const scanHash = sha256Hex(scanBytes);
  assets.set(scanHash, { hash: scanHash, bytes: scanBytes, type: 'model/gltf-binary' });
  const chunkBytes = new Map<string, Uint8Array>();

  const lobby: FixtureSpace = {
    id: SPACE_ID,
    name: SPACE_NAME,
    shareToken: SHARE_TOKEN,
    description: '本地夹具：一个按形状词表写成的小前厅，东侧是虚拟展区。',
    regions,
    plots,
    anchors,
    eventTypes,
    commits: commits.map((c) => ({ ...c })),
    events: fixtureEvents(now),
    snapshots: new Map(),
  };
  const lobbyScan = {
    webModelHashes: [scanHash],
    transform: SCAN_TRANSFORM,
    observedAt: commits[0]!.observedAt,
  };
  for (const commit of lobby.commits) {
    const stored = storeChunks(chunksAt(commit.seq));
    for (const { ref, compressed } of stored) chunkBytes.set(ref.hash, compressed);
    lobby.snapshots.set(
      commit.seq,
      snapshotFor(
        lobby,
        commit.seq,
        commit.at,
        lobbyEntities(commit.seq),
        stored.map((s) => s.ref),
        lobbyScan,
      ),
    );
  }

  const florist: FixtureSpace = {
    id: FLORIST_ID,
    name: FLORIST_NAME,
    shareToken: FLORIST_SHARE_TOKEN,
    description: '本地夹具：街角的小花店。',
    regions: floristRegions,
    plots: [],
    anchors: floristAnchors,
    eventTypes: floristEventTypes,
    commits: floristCommits.map((c) => ({ ...c })),
    events: floristEvents(now),
    snapshots: new Map(),
  };
  for (const commit of florist.commits) {
    florist.snapshots.set(
      commit.seq,
      snapshotFor(florist, commit.seq, commit.at, floristEntities(commit.seq), [], null),
    );
  }

  // 草稿预览：在前厅最新版本上，虚拟展区里加一张大理石长椅（新上传的贴图）和一座喷泉（草稿区块）。
  const base = lobby.snapshots.get(4)!;
  const fountain = storeChunks(
    chunksFrom('ext', [128, 0, 70], [150, 30, 90], (gx, gy, gz) => {
      const dx = gx - 138.5;
      const dz = gz - 79.5;
      const r = Math.hypot(dx, dz);
      if (gy === 2 && r < 8) return r > 6.5 ? 2 : 4;
      if (gy > 2 && gy < 26 && r < 1.6) return 4;
      if (gy === 26 && r < 2.5) return 6;
      return 0;
    }),
  );
  const draftChunks = new Map<string, Uint8Array>();
  for (const { ref, compressed } of fountain) draftChunks.set(ref.hash, compressed);
  const draftAssets = new Map<string, FixtureAsset>([[DRAFT_TEXTURE.hash, DRAFT_TEXTURE]]);
  const bench: EntityBody = {
    entityId: 'bench-draft',
    layer: 'ext',
    kind: 'object',
    label: '大理石长椅（草稿）',
    regionId: 'virtual',
    shape: {
      type: 'extrude',
      outline: {
        points: [
          [-0.9, -0.22],
          [0.9, -0.22],
          [0.9, 0.22],
          [-0.9, 0.22],
        ],
        arcs: [
          { from: 0, bulge: -0.08 },
          { from: 2, bulge: -0.08 },
        ],
      },
      height: 0.45,
      fillet: 0.04,
      transform: { position: [8.4, 0.1, 4.2] },
      material: { texture: DRAFT_TEXTURE.hash, uv: 'box' },
    },
    bounds: { min: [7.5, 0.1, 3.95], max: [9.3, 0.55, 4.45] },
  };
  const preview: PreviewView = {
    ...base,
    entities: [...base.entities, { id: bench.entityId, body: bench }],
    chunks: [...base.chunks, ...fountain.map((f) => f.ref)],
    spaceName: SPACE_NAME,
    preview: {
      draftId: 'draft-fixture-1',
      rev: 3,
      baseSeq: 4,
      scope: 'plot:p1',
      expiresAt: new Date(now + 24 * 3_600_000).toISOString(),
    },
  };

  const spaces = new Map([
    [lobby.id, lobby],
    [florist.id, florist],
  ]);
  store = {
    now,
    spaces,
    universe: {
      id: UNIVERSE_ID,
      name: UNIVERSE_NAME,
      shareToken: UNIVERSE_SHARE_TOKEN,
      revisions: [
        {
          seq: 1,
          at: '2026-10-02T08:00:00.000Z',
          message: '建立组合：前厅',
          members: [{ spaceId: SPACE_ID, offset: [0, 0, 0], rotation: 0 }],
          links: [],
        },
        {
          seq: 2,
          at: '2026-10-20T08:00:00.000Z',
          message: '花店加入，街道相连',
          members: [
            { spaceId: SPACE_ID, offset: [0, 0, 0], rotation: 0 },
            // 花店转 180°，门朝北对着前厅的门，中间隔一条 3 米宽的街。
            { spaceId: FLORIST_ID, offset: [120, 0, 240], rotation: 180 },
          ],
          links: [
            {
              from: { spaceId: FLORIST_ID, anchorId: 'door' },
              to: { spaceId: SPACE_ID, anchorId: 'door-01' },
              kind: 'street',
            },
          ],
        },
      ],
    },
    preview: { token: PREVIEW_TOKEN, view: preview },
    chunks: chunkBytes,
    draftChunks,
    assets,
    draftAssets,
    scanHash,
    spaceId: SPACE_ID,
    shareToken: SHARE_TOKEN,
    get space() {
      return spaceInfo(lobby);
    },
    commits: lobby.commits,
    events: lobby.events,
    eventTypes: lobby.eventTypes,
    snapshot: (seq) => lobby.snapshots.get(seq),
    chunk: (hash) => chunkBytes.get(hash),
    asset: (hash) => assets.get(hash)?.bytes,
  };
  return store;
}

/** 组合在 T 时刻生效的修订，和各成员在 T 时刻的 seq。 */
export function universeAt(fixtures: FixtureStore, at: number) {
  const revision = fixtures.universe.revisions.filter((r) => toMillis(r.at) <= at).at(-1);
  if (revision === undefined) return undefined;
  return {
    revision,
    members: revision.members.map((member) => {
      const space = fixtures.spaces.get(member.spaceId)!;
      const seq = space.commits.filter((c) => toMillis(c.at) <= at).at(-1)?.seq ?? null;
      return { ...member, seq, name: space.name };
    }),
  };
}

export type EmitKind = 'event' | 'commit' | 'delivery';

/**
 * 端到端测试用："现在"发生了点什么。记录时间都是当前时间，`/head` 随之变化。
 *
 * - event：前厅 1 号桌出了一份餐（图标）、营业状态改成"暂停营业"（标签）；
 * - commit：前厅多了一次提交（seq 5，前台旁边多一盆绿植）；
 * - delivery：花店刚送出、前厅刚收到一束花（完整路线）。
 */
export function emitFixture(kind: EmitKind, now: number = Date.now()): { seq: number } {
  const fixtures = fixtureStore();
  const lobby = fixtures.spaces.get(SPACE_ID)!;
  const florist = fixtures.spaces.get(FLORIST_ID)!;
  const time = new Date(now).toISOString();
  extraSeq += 1;
  const push = (space: FixtureSpace, event: Omit<SpaceEvent, 'id' | 'recordedAt' | 'source'>) =>
    space.events.push({
      id: `live-${extraSeq}-${space.events.length}`,
      recordedAt: time,
      source: 'pos',
      typeVersion: 1,
      visibility: 'public',
      ...event,
    });
  if (kind === 'event') {
    push(lobby, { at: time, type: 'order.served', anchorId: 'table-01', data: { dish: '热可可' } });
    push(lobby, {
      at: time,
      type: 'shop.status',
      anchorId: '_space',
      data: { status: '暂停营业' },
    });
  } else if (kind === 'delivery') {
    const correlationId = `demo-florist:live-${extraSeq}`;
    push(florist, {
      at: new Date(now - 90_000).toISOString(),
      type: 'delivery.sent',
      anchorId: 'counter',
      data: { item: '向日葵' },
      correlationId,
    });
    push(lobby, {
      at: time,
      type: 'delivery.arrived',
      anchorId: 'counter-01',
      data: { item: '向日葵' },
      correlationId,
    });
  } else {
    const last = lobby.commits[lobby.commits.length - 1]!;
    const seq = last.seq + 1;
    const commit: CommitSummary = {
      seq,
      at: time,
      message: '前台旁边加一盆绿植',
      actor: { kind: 'agent' },
    };
    lobby.commits.push(commit);
    const previous = lobby.snapshots.get(last.seq)!;
    lobby.snapshots.set(
      seq,
      snapshotFor(lobby, seq, time, lobbyEntities(5), previous.chunks, previous.scan ?? null),
    );
    return { seq };
  }
  return { seq: lobby.commits[lobby.commits.length - 1]!.seq };
}
