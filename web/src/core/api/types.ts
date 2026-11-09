import type { Rgb, Shape, Vec3 } from '../shapes/types';

/**
 * 公开读接口（设计 8.2）的数据类型。字段名照抄设计文档第 4、5 节（驼峰），
 * 只包含公开投影里会出现的字段。接口服务（Rust）的 OpenAPI 定稿后以它为准核对一遍。
 */

/** 时间一律是 RFC 3339 字符串（服务端时间）。 */
export type Timestamp = string;

/** 轴对齐盒子 [x0, y0, z0, x1, y1, z1]，单位是格（GRID_UNIT），左闭右开。 */
export type GridBox = readonly [number, number, number, number, number, number];

export type RegionKind = 'physical' | 'virtual';

export interface Region {
  readonly id: string;
  readonly kind: RegionKind;
  readonly label?: string;
  readonly boxes: readonly GridBox[];
}

export interface Plot {
  readonly id: string;
  readonly regionId?: string;
  readonly label?: string;
  readonly boxes: readonly GridBox[];
}

export type AnchorKind = 'table' | 'seat' | 'zone' | 'door' | 'camera' | 'counter' | 'space';

export interface Anchor {
  readonly anchorId: string;
  readonly kind: AnchorKind | string;
  readonly label?: string;
  /** 锚点位置（米），或者用 `box`（格）表示一块范围。 */
  readonly position?: Vec3;
  readonly box?: GridBox;
  readonly visibility?: 'public' | 'internal';
}

export type Layer = 'rebuilt' | 'ext';

/** 物件记录的 body（docs/SHAPES.md 第 3 节）。模板也是物件，`kind: "template"`。 */
export interface EntityBody {
  readonly entityId: string;
  readonly layer: Layer;
  readonly kind: 'structure' | 'object' | 'template';
  readonly label?: string;
  readonly anchorId?: string;
  readonly regionId?: string;
  readonly shape?: Shape;
  readonly bounds?: { readonly min: Vec3; readonly max: Vec3 };
  readonly fit?: {
    readonly meanCm?: number;
    readonly p90Cm?: number;
    readonly coverage3cm?: number;
  };
  /** 不透明的键值，网站只按纯文本列出。 */
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface EntityRecord {
  readonly id: string;
  readonly hash?: string;
  readonly body: EntityBody;
}

export interface PaletteBlock {
  readonly id: number;
  readonly name: string;
  readonly kind: 'solid' | 'glass' | 'emissive' | string;
  readonly color?: Rgb;
  readonly texture?: { readonly top?: string; readonly side?: string; readonly bottom?: string };
  readonly tags?: readonly string[];
}

export interface Palette {
  readonly hash?: string;
  readonly blocks: readonly PaletteBlock[];
}

export interface ChunkRef {
  readonly layer: Layer;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly hash: string;
}

/** 扫描层：只给网页用模型的哈希和对齐变换（列主序 4×4 矩阵，与 three.js 相同）。 */
export interface ScanRef {
  readonly webModelHashes: readonly string[];
  readonly transform?: readonly number[];
  readonly observedAt?: Timestamp;
}

export interface Head {
  readonly seq: number;
  readonly at: Timestamp;
  /** 最新的公开事件记录时间（含晚到事件、更正和撤回）。 */
  readonly recordedAt: Timestamp | null;
}

export interface Snapshot {
  readonly spaceId: string;
  readonly seq: number;
  readonly at: Timestamp;
  readonly paletteHash?: string;
  readonly palette?: Palette;
  readonly chunks: readonly ChunkRef[];
  readonly entities: readonly EntityRecord[];
  readonly anchors: readonly Anchor[];
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly scan?: ScanRef | null;
}

export type EventDisplayKind = 'highlight' | 'icon' | 'label' | 'path' | 'spawnEntity' | 'heat';

export interface EventTypeDef {
  readonly type: string;
  readonly version: number;
  readonly publicFields?: readonly string[];
  readonly defaultVisibility?: 'public' | 'internal';
  /** 有 state 表示"从此刻起该锚点处于某状态"，直到同一 key 的下一条。 */
  readonly state?: {
    readonly key: string;
    /** 状态值取自 data 里的哪个字段；不给时状态值就是事件类型本身。 */
    readonly value?: string;
    /** 这类事件清除状态（例如离座）。 */
    readonly clears?: boolean;
  };
  readonly maxAgeSec?: number;
  readonly display: {
    readonly kind: EventDisplayKind;
    readonly icon?: string;
    readonly color?: Rgb;
    readonly durationSec?: number;
    readonly labelTemplate?: string;
    readonly entityAsset?: string;
    readonly pathRole?: 'origin' | 'destination';
    readonly heat?: { readonly windowSec: number; readonly weight?: number };
  };
}

export interface SpaceInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility?: 'unlisted' | 'public';
  readonly regions: readonly Region[];
  readonly anchors: readonly Anchor[];
  readonly head?: Head;
  /** 公开的事件类型及显示规则（只读查看器据此可视化事件）。 */
  readonly eventTypes?: readonly EventTypeDef[];
}

/** 提交列表的公开投影（设计 8.2 数据投影规则）。 */
export interface CommitSummary {
  readonly seq: number;
  readonly at: Timestamp;
  readonly observedAt?: Timestamp;
  readonly message: string;
  readonly actor: { readonly kind: string };
  readonly changedChunks?: readonly {
    layer: Layer;
    cx: number;
    cy: number;
    cz: number;
    hash: string | null;
  }[];
  readonly changedEntities?: readonly { id: string; hash: string | null }[];
  readonly changedAnchors?: readonly { id: string; hash: string | null }[];
}

export interface SpaceEvent {
  readonly id: string;
  readonly spaceId?: string;
  /** 现实发生时间。 */
  readonly at: Timestamp;
  /** 服务端记录时间。 */
  readonly recordedAt: Timestamp;
  readonly source: string;
  readonly sourceEventId?: string;
  readonly type: string;
  readonly typeVersion?: number;
  readonly anchorId: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly visibility?: 'public' | 'internal';
  readonly correlationId?: string;
  /** 更正：指向最初那条事件。 */
  readonly corrects?: string;
  readonly retracted?: boolean;
  readonly redacted?: boolean;
  /** 增量结果里的"撤下"标记：之前公开过、后来被撤回或改成内部级。 */
  readonly withdrawn?: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** 下一页的游标；没有更多时为 null。 */
  readonly nextAfter: string | null;
}

export interface DensityBucket {
  readonly start: Timestamp;
  readonly count: number;
}

export interface EventDensity {
  readonly from: Timestamp;
  readonly to: Timestamp;
  readonly bucketSec: number;
  readonly buckets: readonly DensityBucket[];
}

export interface AnchorState {
  readonly anchorId: string;
  readonly key: string;
  readonly value: unknown;
  readonly at: Timestamp;
  readonly eventId: string;
  readonly type: string;
}

export interface StateAt {
  readonly at: Timestamp;
  readonly states: readonly AnchorState[];
}

export interface UniverseMember {
  readonly spaceId: string;
  /** 以格为单位。 */
  readonly offset: Vec3;
  readonly rotation: 0 | 90 | 180 | 270;
  /** 该成员在 T 时刻的 seq。 */
  readonly seq?: number;
}

export interface UniverseLink {
  readonly from: { readonly spaceId: string; readonly anchorId: string };
  readonly to: { readonly spaceId: string; readonly anchorId: string };
  readonly kind: 'door' | 'portal' | 'street';
}

export interface UniverseView {
  readonly id: string;
  readonly name: string;
  readonly seq: number;
  readonly at: Timestamp;
  readonly members: readonly UniverseMember[];
  readonly links: readonly UniverseLink[];
}

export interface UniverseRevision {
  readonly universeId: string;
  readonly seq: number;
  readonly at: Timestamp;
  readonly message?: string;
  readonly state: {
    readonly members: readonly UniverseMember[];
    readonly links: readonly UniverseLink[];
  };
}
