import {
  BLOCK_AIR,
  BLOCK_EMPTY,
  CHUNK_SIZE,
  chunkHash,
  chunkKeyString,
  compareChunkKeys,
  emptyChunk,
  isEmptyChunk,
  locateCell,
  parseChunkKey,
  type ChunkKey,
  type Layer,
} from './chunk.js';
import { canonicalJson, CanonicalError } from './canonical.js';
import {
  boxIntersection,
  boxSubtract,
  boxTranslated,
  boxVolume,
  gridBoxError,
  GridError,
  MAX_GRID_COORD,
  type GridBox,
  type Vec3,
} from './grid.js';
import { isSha256Hex } from './hash.js';
import { isObjectId, SPACE_ANCHOR_ID } from './ids.js';
import {
  anchorFootprint,
  entityFootprint,
  parseAnchorBody,
  parseEntityBody,
  RecordError,
  validateAnchorBody,
  validateEntityBody,
  type AnchorBody,
  type AnchorKind,
  type DataVisibility,
  type EntityBody,
  ANCHOR_KINDS,
  isRebuiltId,
  REBUILT_ID_PREFIX,
} from './record.js';
import { ScopeError, type AllowedArea, type Footprint, type PathScope } from './scope.js';
import { MAX_COORD, templateRefs, type Shape } from './shape.js';
import { isRfc3339 } from './timestamp.js';

/**
 * 高层操作（设计 8.3；Rust `ops.rs` 的移植）、作用到工作状态、影响范围。
 *
 * 方块操作里 `0` 表示"不覆盖"（清掉扩展层在这一格的内容），`1` 表示"空气覆盖"（删掉下层的方块）。
 * 每个操作先按当前状态算影响范围，判断是否落在路径范围内，再作用到工作状态；一批里任何一条失败，
 * 状态保持不变。
 *
 * 工作状态带范围种类（docs/design/server-slim.md 2.4）：扩展（实体区、地块草稿，写扩展层）或重建
 * （重建草稿，只由重建包展开产生）。所有草稿通用的规则（2.5）：重建层新放的编号以 `rb.` 开头、扩展层
 * 新放的不能用 `rb.`；模板只能被同一层引用；`removeEntity` 可带 `ifPresent`；`createAnchor` 可带
 * `ifNew`（出现过的锚点编号由调用方放进 `anchorHistory`）。
 */

/** 每批操作的条数上限。 */
export const MAX_OPS_PER_BATCH = 200;
/** 单个方块操作涉及的格子数上限（约 128 个区块）。 */
export const MAX_OP_CELLS = 2 ** 22;
/** 空心盒壁厚上限（格）。 */
export const MAX_HOLLOW_THICKNESS = 64;
/** `setScan` 的网页用模型最多几档。 */
export const MAX_WEB_MODELS = 2;
/** `scan.alignment` 规范化后的字节数上限。 */
export const MAX_ALIGNMENT_BYTES = 4 * 1024;
/** 扫描变换线性部分行列式的下限（不含）、平移的绝对值上限（米）、各元素的绝对值上限。 */
export const MIN_TRANSFORM_DET = 1e-6;
export const MAX_TRANSFORM_TRANSLATION = MAX_COORD;
export const MAX_TRANSFORM_ELEMENT = 1e7;

/** `invalid`：操作本身不合法；`notAllowed`：这种草稿不能用这个操作；`scope`：超出路径范围。 */
export type OpErrorKind = 'invalid' | 'notAllowed' | 'scope' | 'tooManyOps';

export class OpError extends Error {
  constructor(
    readonly kind: OpErrorKind,
    readonly index: number,
    readonly detail: string,
  ) {
    super(kind === 'tooManyOps' ? detail : `第 ${index} 条操作：${detail}`);
    this.name = 'OpError';
  }
}

function invalid(detail: string): OpError {
  return new OpError('invalid', 0, detail);
}

function notAllowed(detail: string): OpError {
  return new OpError('notAllowed', 0, detail);
}

function atIndex(error: unknown, index: number): OpError {
  if (error instanceof OpError) return new OpError(error.kind, index, error.detail);
  if (error instanceof RecordError || error instanceof GridError) {
    return new OpError('invalid', index, error.message);
  }
  if (error instanceof ScopeError) return new OpError('scope', index, error.message);
  throw error;
}

/** 方块引用：方块表里的正式编号，或草稿里新增方块的临时名称。 */
export type BlockRef = number | string;

export type BlockKind = 'solid' | 'glass' | 'emissive' | 'liquid' | 'foliage';
export const BLOCK_KINDS: readonly BlockKind[] = [
  'solid',
  'glass',
  'emissive',
  'liquid',
  'foliage',
];

export interface BlockTexture {
  readonly top: string;
  readonly side: string;
  readonly bottom: string;
}

/** 方块定义（不含编号）。 */
export interface BlockDef {
  readonly name: string;
  readonly kind: BlockKind;
  readonly color?: readonly [number, number, number];
  readonly texture?: BlockTexture;
  readonly tags?: readonly string[];
}

/** 方块表里的一项。编号只增不改。 */
export interface PaletteBlock extends BlockDef {
  readonly id: number;
}

export interface FillOp {
  readonly op: 'fill';
  readonly box: GridBox;
  readonly block: BlockRef;
}
export interface HollowBoxOp {
  readonly op: 'hollowBox';
  readonly box: GridBox;
  readonly block: BlockRef;
  readonly thickness?: number;
}
export interface ReplaceOp {
  readonly op: 'replace';
  readonly box: GridBox;
  readonly from: BlockRef;
  readonly to: BlockRef;
}
export interface CopyRegionOp {
  readonly op: 'copyRegion';
  readonly source: GridBox;
  readonly to: Vec3;
}
export interface AddBlockOp {
  readonly op: 'addBlock';
  readonly block: BlockDef;
}
export interface PlaceEntityOp {
  readonly op: 'placeEntity';
  readonly entity: EntityBody;
}
export interface RemoveEntityOp {
  readonly op: 'removeEntity';
  readonly entityId: string;
  /** 为 true 时物件不存在就什么都不做。 */
  readonly ifPresent?: boolean;
}
export interface CreateAnchorOp {
  readonly op: 'createAnchor';
  readonly anchor: AnchorBody;
  /** 为 true 时编号在本空间时间线上出现过（不论现在还在不在）就什么都不做。 */
  readonly ifNew?: boolean;
}
export interface MoveAnchorOp {
  readonly op: 'moveAnchor';
  readonly anchorId: string;
  readonly box?: GridBox;
  readonly position?: Vec3;
}
export interface UpdateAnchorOp {
  readonly op: 'updateAnchor';
  readonly anchorId: string;
  readonly label?: string;
  readonly visibility?: DataVisibility;
  readonly kind?: AnchorKind;
}
export interface RemoveAnchorOp {
  readonly op: 'removeAnchor';
  readonly anchorId: string;
}
/** `setScan` 的扫描层：扫描资源、网页用模型、变换和可选的对齐信息。 */
export interface ScanSpec {
  readonly assetHash: string;
  readonly webModelHashes: readonly string[];
  readonly transform: readonly number[];
  readonly alignment?: Readonly<Record<string, unknown>>;
}
/** 设置这次提交的扫描层（只在重建草稿里，一个草稿最多一次）。 */
export interface SetScanOp {
  readonly op: 'setScan';
  readonly scan: ScanSpec;
  readonly observedAt?: string;
}
/** 删掉重建层的全部物件（只在重建草稿里）。 */
export interface ClearRebuiltOp {
  readonly op: 'clearRebuilt';
}

/** 一条高层操作。JSON 里用 `op` 区分类型。 */
export type Op =
  | FillOp
  | HollowBoxOp
  | ReplaceOp
  | CopyRegionOp
  | AddBlockOp
  | PlaceEntityOp
  | RemoveEntityOp
  | CreateAnchorOp
  | MoveAnchorOp
  | UpdateAnchorOp
  | RemoveAnchorOp
  | SetScanOp
  | ClearRebuiltOp;

export type OpName = Op['op'];

// ---------------------------------------------------------------------------
// 结构检查（相当于服务端的反序列化）
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const OP_FIELDS: Record<OpName, readonly string[]> = {
  fill: ['box', 'block'],
  hollowBox: ['box', 'block', 'thickness'],
  replace: ['box', 'from', 'to'],
  copyRegion: ['source', 'to'],
  addBlock: ['block'],
  placeEntity: ['entity'],
  removeEntity: ['entityId', 'ifPresent'],
  createAnchor: ['anchor', 'ifNew'],
  moveAnchor: ['anchorId', 'box', 'position'],
  updateAnchor: ['anchorId', 'label', 'visibility', 'kind'],
  removeAnchor: ['anchorId'],
  setScan: ['scan', 'observedAt'],
  clearRebuilt: [],
};

export const OP_NAMES = Object.keys(OP_FIELDS) as OpName[];

function given(object: Json, key: string): boolean {
  return object[key] !== undefined && object[key] !== null;
}

function parseBox(value: unknown, name: string): GridBox {
  const error = Array.isArray(value) ? gridBoxError(value as number[]) : '盒子必须是数组';
  if (error !== null) throw invalid(`${name}：${error}`);
  return value as GridBox;
}

function parseBlockRef(value: unknown, name: string): BlockRef {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff) {
    return value;
  }
  throw invalid(`${name} 必须是 0–65535 的方块编号或临时方块名称`);
}

function parseRgb(value: unknown, name: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
  ) {
    throw invalid(`${name} 必须是 3 个 0–255 的整数`);
  }
}

function parseBlockDef(value: unknown): BlockDef {
  if (!isPlainObject(value)) throw invalid('block 必须是对象');
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined && !['name', 'kind', 'color', 'texture', 'tags'].includes(key)) {
      throw invalid(`block 里不认识的字段 ${key}`);
    }
  }
  if (typeof value.name !== 'string') throw invalid('block.name 必须是字符串');
  if (!BLOCK_KINDS.includes(value.kind as BlockKind)) throw invalid('block.kind 不认识');
  if (given(value, 'color')) parseRgb(value.color, 'block.color');
  if (given(value, 'texture')) {
    const texture = value.texture;
    if (
      !isPlainObject(texture) ||
      Object.keys(texture).some((k) => !['top', 'side', 'bottom'].includes(k)) ||
      !['top', 'side', 'bottom'].every((k) => typeof texture[k] === 'string')
    ) {
      throw invalid('block.texture 必须是 { top, side, bottom }');
    }
  }
  if (given(value, 'tags')) {
    if (!Array.isArray(value.tags) || !value.tags.every((t) => typeof t === 'string')) {
      throw invalid('block.tags 必须是字符串数组');
    }
  }
  const out: Json = { name: value.name, kind: value.kind, tags: value.tags ?? [] };
  if (given(value, 'color')) out.color = value.color;
  if (given(value, 'texture')) out.texture = value.texture;
  return out as unknown as BlockDef;
}

function parseVec3(value: unknown, name: string, integer: boolean): Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((v) => typeof v === 'number' && (!integer || Number.isInteger(v)))
  ) {
    throw invalid(`${name} 必须是 3 个${integer ? '整数' : '数字'}`);
  }
  return value as unknown as Vec3;
}

function parseOptionalBool(object: Json, key: string): boolean | undefined {
  if (!given(object, key)) return undefined;
  if (typeof object[key] !== 'boolean') throw invalid(`${key} 必须是布尔值`);
  return object[key];
}

function parseScanSpec(value: unknown): ScanSpec {
  if (!isPlainObject(value)) throw invalid('scan 必须是对象');
  for (const key of Object.keys(value)) {
    if (
      value[key] !== undefined &&
      !['assetHash', 'webModelHashes', 'transform', 'alignment'].includes(key)
    ) {
      throw invalid(`scan 里不认识的字段 ${key}`);
    }
  }
  if (typeof value.assetHash !== 'string') throw invalid('scan.assetHash 必须是字符串');
  if (
    !Array.isArray(value.webModelHashes) ||
    !value.webModelHashes.every((hash) => typeof hash === 'string')
  ) {
    throw invalid('scan.webModelHashes 必须是字符串数组');
  }
  if (
    !Array.isArray(value.transform) ||
    value.transform.length !== 16 ||
    !value.transform.every((v) => typeof v === 'number')
  ) {
    throw invalid('scan.transform 必须是 16 个数');
  }
  const out: Json = {
    assetHash: value.assetHash,
    webModelHashes: value.webModelHashes,
    transform: value.transform,
  };
  if (given(value, 'alignment')) {
    if (!isPlainObject(value.alignment)) throw invalid('scan.alignment 必须是对象');
    out.alignment = value.alignment;
  }
  return out as unknown as ScanSpec;
}

/**
 * 4×4 列主序仿射变换（Rust `model::check_transform`）：16 个有限数（绝对值 ≤ 1e7），最后一行 [0,0,0,1]，
 * 线性部分可逆且不镜像（行列式 > 1e-6），平移的绝对值 ≤ 100000 米。不合法时返回说明。
 */
export function transformError(values: readonly number[]): string | null {
  const message =
    'transform 必须是 16 个有限数（列主序 4×4），最后一行 [0,0,0,1]，线性部分可逆且不镜像（行列式 > 1e-6），平移的绝对值不超过 100000 米';
  if (
    values.length !== 16 ||
    !values.every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_TRANSFORM_ELEMENT)
  ) {
    return message;
  }
  const m = (row: number, col: number) => values[col * 4 + row]!;
  if (m(3, 0) !== 0 || m(3, 1) !== 0 || m(3, 2) !== 0 || m(3, 3) !== 1) return message;
  if ([m(0, 3), m(1, 3), m(2, 3)].some((t) => Math.abs(t) > MAX_TRANSFORM_TRANSLATION)) {
    return message;
  }
  const det =
    m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) -
    m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0)) +
    m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0));
  return det > MIN_TRANSFORM_DET ? null : message;
}

/** 扫描层的取值检查（Rust `ScanSpec::validate`）。 */
export function validateScanSpec(scan: ScanSpec): void {
  if (!isSha256Hex(scan.assetHash)) throw invalid('scan.assetHash 必须是 64 位小写十六进制');
  const count = scan.webModelHashes.length;
  if (count === 0 || count > MAX_WEB_MODELS) {
    throw invalid('scan.webModelHashes 必须是 1 到 2 个资源哈希');
  }
  if (!scan.webModelHashes.every((hash) => isSha256Hex(hash))) {
    throw invalid('scan.webModelHashes 必须是资源哈希');
  }
  if (count === 2 && scan.webModelHashes[0] === scan.webModelHashes[1]) {
    throw invalid('scan.webModelHashes 不能重复');
  }
  const transform = transformError(scan.transform);
  if (transform !== null) throw invalid(`scan.${transform}`);
  if (scan.alignment !== undefined) {
    let text: string;
    try {
      text = canonicalJson(scan.alignment);
    } catch (error) {
      if (error instanceof CanonicalError) {
        throw invalid(`scan.alignment 无法规范化：${error.message}`);
      }
      throw error;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_ALIGNMENT_BYTES) {
      throw invalid(`scan.alignment 规范化后 ${bytes} 字节，超过 ${MAX_ALIGNMENT_BYTES}`);
    }
  }
}

function wrapRecord<T>(make: () => T): T {
  try {
    return make();
  } catch (error) {
    if (error instanceof RecordError) throw invalid(error.message);
    throw error;
  }
}

/**
 * 检查一条操作的结构（字段名、类型、未知字段），返回整理过的操作（去掉值为 null 的可选字段，
 * 物件 `props` 缺省为 `{}`）。不合法时抛出 OpError（`index` 为 0）。
 */
export function parseOp(value: unknown): Op {
  if (!isPlainObject(value)) throw invalid('操作必须是对象');
  const name = value.op;
  if (typeof name !== 'string' || !(name in OP_FIELDS)) {
    throw invalid(`不认识的操作 ${String(name)}`);
  }
  const allowed = ['op', ...OP_FIELDS[name as OpName]];
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined && !allowed.includes(key)) {
      throw invalid(`${name} 里不认识的字段 ${key}`);
    }
  }
  const str = (key: string): string => {
    if (typeof value[key] !== 'string') throw invalid(`${key} 必须是字符串`);
    return value[key];
  };
  switch (name as OpName) {
    case 'fill':
      return {
        op: 'fill',
        box: parseBox(value.box, 'box'),
        block: parseBlockRef(value.block, 'block'),
      };
    case 'hollowBox': {
      const op: Json = {
        op: 'hollowBox',
        box: parseBox(value.box, 'box'),
        block: parseBlockRef(value.block, 'block'),
      };
      if (given(value, 'thickness')) {
        const t = value.thickness;
        if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > 0xffff_ffff) {
          throw invalid('thickness 必须是非负整数');
        }
        op.thickness = t;
      }
      return op as unknown as HollowBoxOp;
    }
    case 'replace':
      return {
        op: 'replace',
        box: parseBox(value.box, 'box'),
        from: parseBlockRef(value.from, 'from'),
        to: parseBlockRef(value.to, 'to'),
      };
    case 'copyRegion':
      return {
        op: 'copyRegion',
        source: parseBox(value.source, 'source'),
        to: parseVec3(value.to, 'to', true),
      };
    case 'addBlock':
      return { op: 'addBlock', block: parseBlockDef(value.block) };
    case 'placeEntity':
      return { op: 'placeEntity', entity: wrapRecord(() => parseEntityBody(value.entity)) };
    case 'removeEntity': {
      const op: Json = { op: 'removeEntity', entityId: str('entityId') };
      const ifPresent = parseOptionalBool(value, 'ifPresent');
      if (ifPresent !== undefined) op.ifPresent = ifPresent;
      return op as unknown as RemoveEntityOp;
    }
    case 'createAnchor': {
      const op: Json = {
        op: 'createAnchor',
        anchor: wrapRecord(() => parseAnchorBody(value.anchor)),
      };
      const ifNew = parseOptionalBool(value, 'ifNew');
      if (ifNew !== undefined) op.ifNew = ifNew;
      return op as unknown as CreateAnchorOp;
    }
    case 'setScan': {
      const op: Json = { op: 'setScan', scan: parseScanSpec(value.scan) };
      if (given(value, 'observedAt')) {
        if (!isRfc3339(value.observedAt)) throw invalid('observedAt 必须是 RFC 3339 时间');
        op.observedAt = value.observedAt;
      }
      return op as unknown as SetScanOp;
    }
    case 'clearRebuilt':
      return { op: 'clearRebuilt' };
    case 'moveAnchor': {
      const op: Json = { op: 'moveAnchor', anchorId: str('anchorId') };
      if (given(value, 'box')) op.box = parseBox(value.box, 'box');
      if (given(value, 'position')) op.position = parseVec3(value.position, 'position', false);
      return op as unknown as MoveAnchorOp;
    }
    case 'updateAnchor': {
      const op: Json = { op: 'updateAnchor', anchorId: str('anchorId') };
      if (given(value, 'label')) op.label = str('label');
      if (given(value, 'visibility')) {
        if (value.visibility !== 'public' && value.visibility !== 'internal') {
          throw invalid('visibility 只能是 public 或 internal');
        }
        op.visibility = value.visibility;
      }
      if (given(value, 'kind')) {
        if (!ANCHOR_KINDS.includes(value.kind as AnchorKind)) throw invalid('锚点 kind 不认识');
        op.kind = value.kind;
      }
      return op as unknown as UpdateAnchorOp;
    }
    case 'removeAnchor':
      return { op: 'removeAnchor', anchorId: str('anchorId') };
  }
}

/** 检查一批操作的结构；错误带上第几条。 */
export function parseOps(values: readonly unknown[]): Op[] {
  return values.map((value, index) => {
    try {
      return parseOp(value);
    } catch (error) {
      throw atIndex(error, index);
    }
  });
}

/** 方块定义的取值检查（Rust `BlockDef::validate`）。 */
export function validateBlockDef(block: BlockDef): void {
  if (!isObjectId(block.name)) throw invalid('方块名称格式不对');
  const hasColor = block.color !== undefined;
  const hasTexture = block.texture !== undefined;
  if (hasColor && !hasTexture) {
    // 纯色
  } else if (!hasColor && hasTexture) {
    const t = block.texture!;
    if (![t.top, t.side, t.bottom].every((hash) => isSha256Hex(hash))) {
      throw invalid('方块贴图必须是资源哈希');
    }
  } else {
    throw invalid('方块必须且只能给出 color 或 texture');
  }
  const tags = block.tags ?? [];
  if (tags.length > 16 || tags.some((tag) => !isObjectId(tag))) {
    throw invalid('方块标签至多 16 个且格式要合法');
  }
}

// ---------------------------------------------------------------------------
// 工作状态
// ---------------------------------------------------------------------------

/** `createAnchor` 带 `ifNew` 时为什么跳过：现在就有（`exists`），或曾经有过（`existed`）。 */
export type AnchorSkip = 'exists' | 'existed';

/** 一批操作碰过的键。区块键是 `layer:cx:cy:cz`。 */
export interface TouchedSet {
  readonly chunks: Set<string>;
  readonly entities: Set<string>;
  readonly anchors: Set<string>;
  palette: boolean;
  /** 有 `setScan`。 */
  scan: boolean;
  /** 有 `clearRebuilt`。 */
  rebuiltLayer: boolean;
  /** 带 `ifNew` 而跳过的锚点（不算碰过，只用来报告）。 */
  readonly skippedAnchors: Map<string, AnchorSkip>;
}

export function emptyTouched(): TouchedSet {
  return {
    chunks: new Set(),
    entities: new Set(),
    anchors: new Set(),
    palette: false,
    scan: false,
    rebuiltLayer: false,
    skippedAnchors: new Map(),
  };
}

export function mergeTouched(into: TouchedSet, other: TouchedSet): void {
  other.chunks.forEach((key) => into.chunks.add(key));
  other.entities.forEach((key) => into.entities.add(key));
  other.anchors.forEach((key) => into.anchors.add(key));
  into.palette ||= other.palette;
  into.scan ||= other.scan;
  into.rebuiltLayer ||= other.rebuiltLayer;
  other.skippedAnchors.forEach((reason, id) => into.skippedAnchors.set(id, reason));
}

/** 与 Rust `String` 的排序相同（按 UTF-8 字节，即按码点）。 */
export function compareIds(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 碰过的键，按 Rust 的顺序排好（草稿 `touched` 的 JSON 形状；`scan`、`rebuiltLayer` 只在为 true 时写）。 */
export function touchedToModel(touched: TouchedSet): {
  chunks: ChunkKey[];
  entities: string[];
  anchors: string[];
  palette: boolean;
  scan?: true;
  rebuiltLayer?: true;
} {
  return {
    chunks: [...touched.chunks].map(parseChunkKey).sort(compareChunkKeys),
    entities: [...touched.entities].sort(compareIds),
    anchors: [...touched.anchors].sort(compareIds),
    palette: touched.palette,
    ...(touched.scan ? { scan: true as const } : {}),
    ...(touched.rebuiltLayer ? { rebuiltLayer: true as const } : {}),
  };
}

/** 工作状态的范围种类：扩展（实体区、地块草稿）或重建（重建草稿）。 */
export type ScopeKind = 'ext' | 'rebuild';

/** 路径范围对应的种类：重建路径是重建，其余都是扩展。 */
export function scopeKindOf(scope: PathScope): ScopeKind {
  return scope === 'rebuild' ? 'rebuild' : 'ext';
}

/** 这种草稿写的那一层。 */
export function layerOfKind(kind: ScopeKind): Layer {
  return kind === 'rebuild' ? 'rebuilt' : 'ext';
}

/** 草稿里的 `setScan`。 */
export interface DraftScan {
  readonly scan: ScanSpec;
  readonly observedAt?: string;
}

/** 区块变化；`hash = null` 表示删除这个区块。 */
export interface ChunkChange extends ChunkKey {
  readonly hash: string | null;
}

/** 盒子按区块切开：[区块坐标, 落在这个区块里的格子盒子]。 */
function chunkSpans(region: GridBox): [Vec3, GridBox][] {
  const [low] = locateCell([region[0], region[1], region[2]]);
  const [high] = locateCell([region[3] - 1, region[4] - 1, region[5] - 1]);
  const spans: [Vec3, GridBox][] = [];
  for (let cy = low[1]; cy <= high[1]; cy += 1) {
    for (let cz = low[2]; cz <= high[2]; cz += 1) {
      for (let cx = low[0]; cx <= high[0]; cx += 1) {
        const base = [cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE];
        const chunkBox: GridBox = [
          base[0]!,
          base[1]!,
          base[2]!,
          base[0]! + CHUNK_SIZE,
          base[1]! + CHUNK_SIZE,
          base[2]! + CHUNK_SIZE,
        ];
        const part = boxIntersection(chunkBox, region);
        if (part !== null) spans.push([[cx, cy, cz], part]);
      }
    }
  }
  return spans;
}

function localIndex(cell: Vec3): number {
  const [, [x, y, z]] = locateCell(cell);
  return x + CHUNK_SIZE * (z + CHUNK_SIZE * y);
}

function* cellsOf(region: GridBox): Generator<Vec3> {
  for (let y = region[1]; y < region[4]; y += 1) {
    for (let z = region[2]; z < region[5]; z += 1) {
      for (let x = region[0]; x < region[3]; x += 1) yield [x, y, z];
    }
  }
}

function checkCellCount(region: GridBox): void {
  if (boxVolume(region) > MAX_OP_CELLS) throw invalid('单个操作最多涉及 4194304 格');
}

function keyOf(layer: Layer, chunk: Vec3): string {
  return chunkKeyString({ layer, cx: chunk[0], cy: chunk[1], cz: chunk[2] });
}

interface FootprintBuilder {
  cells: GridBox[];
  spaceWide: boolean;
}

function addAnchor(footprint: FootprintBuilder, cells: GridBox | 'space'): void {
  if (cells === 'space') footprint.spaceWide = true;
  else footprint.cells.push(cells);
}

/** 操作作用的对象：区块、物件、锚点、方块表的当前内容。 */
export class WorkingState {
  /** 区块（键 `layer:cx:cy:cz`）。数组按写时复制：克隆后共用，写入时才复制。 */
  readonly chunks: Map<string, Uint16Array>;
  readonly entities: Map<string, EntityBody>;
  readonly anchors: Map<string, AnchorBody>;
  palette: PaletteBlock[];
  /** 草稿里新增的方块：临时名称 → (临时编号, 定义)。 */
  readonly provisionalBlocks: Map<string, { readonly id: number; readonly def: BlockDef }>;
  /** 范围种类（默认扩展）。 */
  kind: ScopeKind;
  /**
   * 本空间时间线上出现过的锚点编号（草稿基础版本及更早）。只在操作里有 `ifNew` 时才需要，
   * 由调用方传入。
   */
  readonly anchorHistory: Set<string>;
  /** 草稿的 `setScan`（一个草稿最多一次）。 */
  scan: DraftScan | null;
  private readonly owned: Set<string>;

  constructor(init?: {
    chunks?: Map<string, Uint16Array>;
    entities?: Map<string, EntityBody>;
    anchors?: Map<string, AnchorBody>;
    palette?: PaletteBlock[];
    provisionalBlocks?: Map<string, { readonly id: number; readonly def: BlockDef }>;
    kind?: ScopeKind;
    anchorHistory?: Iterable<string>;
    scan?: DraftScan | null;
  }) {
    this.chunks = init?.chunks ?? new Map();
    this.entities = init?.entities ?? new Map();
    this.anchors = init?.anchors ?? new Map();
    this.palette = init?.palette ?? [];
    this.provisionalBlocks = init?.provisionalBlocks ?? new Map();
    this.kind = init?.kind ?? 'ext';
    this.anchorHistory = new Set(init?.anchorHistory ?? []);
    this.scan = init?.scan ?? null;
    this.owned = new Set();
  }

  clone(): WorkingState {
    // 写时复制：克隆之后两边都不再独占任何区块数组，谁先写谁复制。
    this.owned.clear();
    return new WorkingState({
      chunks: new Map(this.chunks),
      entities: new Map(this.entities),
      anchors: new Map(this.anchors),
      palette: [...this.palette],
      provisionalBlocks: new Map(this.provisionalBlocks),
      kind: this.kind,
      anchorHistory: this.anchorHistory,
      scan: this.scan,
    });
  }

  /** 可写的区块（不存在就新建一个全 0 的）。 */
  mutableChunk(key: string): Uint16Array {
    let cells = this.chunks.get(key);
    if (cells === undefined) {
      cells = emptyChunk();
      this.chunks.set(key, cells);
      this.owned.add(key);
    } else if (!this.owned.has(key)) {
      cells = cells.slice();
      this.chunks.set(key, cells);
      this.owned.add(key);
    }
    return cells;
  }

  /** 某图层某一格的方块编号。 */
  blockAt(layer: Layer, cell: Vec3): number {
    const [chunk] = locateCell(cell);
    const cells = this.chunks.get(keyOf(layer, chunk));
    return cells === undefined ? BLOCK_EMPTY : cells[localIndex(cell)]!;
  }

  /** 看得到的方块：扩展层优先；空气覆盖算作空。 */
  effectiveBlock(cell: Vec3): number {
    const ext = this.blockAt('ext', cell);
    if (ext === BLOCK_EMPTY) return this.blockAt('rebuilt', cell);
    if (ext === BLOCK_AIR) return BLOCK_EMPTY;
    return ext;
  }

  /** 把方块引用解析成编号。0、1 是保留编号，其余必须在方块表或草稿新增的方块里。 */
  resolveBlock(reference: BlockRef): number {
    if (typeof reference === 'number') {
      if (reference === BLOCK_EMPTY || reference === BLOCK_AIR) return reference;
      const known =
        this.palette.some((block) => block.id === reference) ||
        [...this.provisionalBlocks.values()].some((p) => p.id === reference);
      if (!known) throw invalid(`方块表里没有编号 ${reference}`);
      return reference;
    }
    const provisional = this.provisionalBlocks.get(reference);
    if (provisional === undefined) throw invalid(`草稿里没有新增名为 ${reference} 的方块`);
    return provisional.id;
  }

  /** 空间里的全部模板（`kind: "template"` 的物件，两层都算；放物件时只能引用同一层的）。 */
  templates(): Map<string, Shape> {
    const out = new Map<string, Shape>();
    for (const id of this.sortedEntityIds()) {
      const entity = this.entities.get(id)!;
      if (entity.kind === 'template' && entity.shape !== undefined) out.set(id, entity.shape);
    }
    return out;
  }

  /** 某一层的模板。物件只能引用同一层的模板。 */
  templatesOf(layer: Layer): Map<string, Shape> {
    const out = new Map<string, Shape>();
    for (const id of this.sortedEntityIds()) {
      const entity = this.entities.get(id)!;
      if (entity.kind === 'template' && entity.layer === layer && entity.shape !== undefined) {
        out.set(id, entity.shape);
      }
    }
    return out;
  }

  private sortedEntityIds(): string[] {
    return [...this.entities.keys()].sort(compareIds);
  }

  /**
   * 同一层里直接或间接引用了某个模板的物件（不含模板自己，也不含其他模板）。`layer` 不给时按模板
   * 自己所在的层（模板不存在时按扩展层）。
   */
  usersOfTemplate(template: string, layer?: Layer): EntityBody[] {
    const inLayer = layer ?? this.entities.get(template)?.layer ?? 'ext';
    const affected = new Set([template]);
    const ids = this.sortedEntityIds().filter((id) => this.entities.get(id)!.layer === inLayer);
    for (;;) {
      const before = affected.size;
      for (const id of ids) {
        const entity = this.entities.get(id)!;
        if (
          entity.shape !== undefined &&
          [...templateRefs(entity.shape)].some((r) => affected.has(r))
        ) {
          affected.add(entity.entityId);
        }
      }
      if (affected.size === before) break;
    }
    return ids
      .map((id) => this.entities.get(id)!)
      .filter((e) => e.entityId !== template && affected.has(e.entityId) && e.kind !== 'template');
  }

  private entityFootprints(entity: EntityBody): GridBox[] {
    if (entity.kind === 'template') {
      // 模板没有世界坐标；改模板等于改同一层里所有用到它的物件。
      return this.usersOfTemplate(entity.entityId, entity.layer).map(entityFootprint);
    }
    return [entityFootprint(entity)];
  }

  /** 这种草稿能不能用这个操作（Rust `check_allowed`）。 */
  private checkAllowed(op: Op): void {
    if (this.kind === 'ext') {
      if (op.op === 'setScan' || op.op === 'clearRebuilt') {
        throw notAllowed(`${op.op} 只能出现在重建草稿里（由重建包展开产生）`);
      }
      return;
    }
    switch (op.op) {
      case 'fill':
      case 'hollowBox':
      case 'replace':
      case 'copyRegion':
      case 'addBlock':
      case 'moveAnchor':
      case 'updateAnchor':
      case 'removeAnchor':
        throw notAllowed(`重建草稿里不能有 ${op.op}（重建包不写方块，锚点只能新建）`);
      case 'createAnchor':
        if (op.ifNew !== true) throw notAllowed('重建草稿里新建锚点必须带 ifNew');
        return;
      default:
        return;
    }
  }

  /** 同编号的现有物件；属于另一层时报错（两层共用一个编号空间）。 */
  private existingEntity(id: string): EntityBody | undefined {
    const entity = this.entities.get(id);
    if (entity !== undefined && entity.layer !== layerOfKind(this.kind)) {
      throw invalid(
        this.kind === 'ext'
          ? `物件 ${id} 属于重建层，只能经重建路径修改`
          : `物件 ${id} 属于扩展层，重建草稿不能修改`,
      );
    }
    return entity;
  }

  /** 带 `ifNew` 的锚点要不要跳过；跳过时给出原因。 */
  private anchorSkip(anchorId: string, ifNew: boolean | undefined): AnchorSkip | null {
    if (ifNew !== true) return null;
    if (this.anchors.has(anchorId)) return 'exists';
    if (this.anchorHistory.has(anchorId)) return 'existed';
    return null;
  }

  /** 物件编号分区：重建层新放的必须以 `rb.` 开头；扩展层新放的不能以 `rb.` 开头。 */
  private checkEntityId(entity: EntityBody): void {
    const id = entity.entityId;
    if (this.kind === 'rebuild' && !isRebuiltId(id)) {
      throw invalid(`重建层新放的物件编号必须以 ${REBUILT_ID_PREFIX} 开头（旧编号 ${id} 只能删）`);
    }
    if (this.kind === 'ext' && isRebuiltId(id) && !this.entities.has(id)) {
      throw invalid(`${REBUILT_ID_PREFIX} 开头的编号留给重建层，扩展层不能新放 ${id}`);
    }
  }

  /**
   * 模板引用的完整性（Rust `broken_template_refs`）：每个物件（含模板）形状里引用的模板都要在
   * 同一层存在。返回缺的引用（按物件编号排好）；空表示完整。
   */
  brokenTemplateRefs(): { entityId: string; template: string }[] {
    const broken: { entityId: string; template: string }[] = [];
    for (const id of this.sortedEntityIds()) {
      const entity = this.entities.get(id)!;
      if (entity.shape === undefined) continue;
      for (const template of [...templateRefs(entity.shape)].sort(compareIds)) {
        const target = this.entities.get(template);
        if (target === undefined || target.kind !== 'template' || target.layer !== entity.layer) {
          broken.push({ entityId: id, template });
        }
      }
    }
    return broken;
  }

  private existingAnchor(id: string): AnchorBody {
    const anchor = this.anchors.get(id);
    if (anchor === undefined) throw invalid(`锚点 ${id} 不存在`);
    return anchor;
  }

  /** 操作的影响范围（按操作之前的状态计算）。 */
  footprint(op: Op): Footprint {
    const footprint: FootprintBuilder = { cells: [], spaceWide: false };
    try {
      this.checkAllowed(op);
      switch (op.op) {
        case 'fill':
        case 'hollowBox':
        case 'replace':
          footprint.cells.push(op.box);
          break;
        case 'copyRegion': {
          const offset: Vec3 = [
            op.to[0] - op.source[0],
            op.to[1] - op.source[1],
            op.to[2] - op.source[2],
          ];
          footprint.cells.push(boxTranslated(op.source, offset));
          break;
        }
        case 'addBlock':
        case 'setScan':
          break;
        case 'placeEntity': {
          footprint.cells.push(...this.entityFootprints(op.entity));
          const old = this.existingEntity(op.entity.entityId);
          if (old !== undefined) footprint.cells.push(...this.entityFootprints(old));
          break;
        }
        case 'removeEntity': {
          const old = this.existingEntity(op.entityId);
          if (old !== undefined) footprint.cells.push(...this.entityFootprints(old));
          else if (op.ifPresent !== true) throw invalid(`物件 ${op.entityId} 不存在`);
          break;
        }
        case 'clearRebuilt':
          for (const id of this.sortedEntityIds()) {
            const entity = this.entities.get(id)!;
            if (entity.layer === 'rebuilt' && entity.kind !== 'template') {
              footprint.cells.push(entityFootprint(entity));
            }
          }
          break;
        case 'createAnchor':
          if (this.anchorSkip(op.anchor.anchorId, op.ifNew) === null) {
            addAnchor(footprint, anchorFootprint(op.anchor));
          }
          break;
        case 'moveAnchor': {
          const old = this.existingAnchor(op.anchorId);
          addAnchor(footprint, anchorFootprint(old));
          addAnchor(footprint, anchorFootprint(moved(old, op)));
          break;
        }
        case 'updateAnchor':
        case 'removeAnchor':
          addAnchor(footprint, anchorFootprint(this.existingAnchor(op.anchorId)));
          break;
      }
    } catch (error) {
      throw atIndex(error, 0);
    }
    return footprint;
  }

  private writeCells(region: GridBox, block: number, touched: TouchedSet): void {
    for (const [chunk, part] of chunkSpans(region)) {
      const key = keyOf('ext', chunk);
      const cells = this.mutableChunk(key);
      const base = [chunk[0] * CHUNK_SIZE, chunk[1] * CHUNK_SIZE, chunk[2] * CHUNK_SIZE];
      for (let y = part[1]; y < part[4]; y += 1) {
        for (let z = part[2]; z < part[5]; z += 1) {
          const row = x0Index(part[0] - base[0]!, y - base[1]!, z - base[2]!);
          cells.fill(block, row, row + (part[3] - part[0]));
        }
      }
      touched.chunks.add(key);
    }
  }

  private writeCell(cell: Vec3, block: number, touched: TouchedSet): void {
    const [chunk] = locateCell(cell);
    const key = keyOf('ext', chunk);
    this.mutableChunk(key)[localIndex(cell)] = block;
    touched.chunks.add(key);
  }

  /** 作用一条操作（不检查路径范围）。失败时抛出 OpError（`index` 为 0），状态可能已部分改变。 */
  apply(op: Op): TouchedSet {
    try {
      return this.applyUnchecked(op);
    } catch (error) {
      throw atIndex(error, 0);
    }
  }

  private applyUnchecked(op: Op): TouchedSet {
    this.checkAllowed(op);
    const touched = emptyTouched();
    switch (op.op) {
      case 'fill': {
        checkCellCount(op.box);
        this.writeCells(op.box, this.resolveBlock(op.block), touched);
        break;
      }
      case 'hollowBox': {
        checkCellCount(op.box);
        const thickness = op.thickness ?? 1;
        if (thickness === 0 || thickness > MAX_HOLLOW_THICKNESS) {
          throw invalid('壁厚必须在 1 到 64 之间');
        }
        const block = this.resolveBlock(op.block);
        const t = thickness;
        const inner: GridBox = [
          op.box[0] + t,
          op.box[1] + t,
          op.box[2] + t,
          op.box[3] - t,
          op.box[4] - t,
          op.box[5] - t,
        ];
        const shell = gridBoxError(inner) === null ? boxSubtract(op.box, inner) : [op.box];
        for (const part of shell) this.writeCells(part, block, touched);
        break;
      }
      case 'replace': {
        checkCellCount(op.box);
        const from = this.resolveBlock(op.from);
        const to = this.resolveBlock(op.to);
        const matching: Vec3[] = [];
        for (const cell of cellsOf(op.box)) {
          if (this.effectiveBlock(cell) === from) matching.push(cell);
        }
        for (const cell of matching) this.writeCell(cell, to, touched);
        break;
      }
      case 'copyRegion': {
        checkCellCount(op.source);
        const offset: Vec3 = [
          op.to[0] - op.source[0],
          op.to[1] - op.source[1],
          op.to[2] - op.source[2],
        ];
        boxTranslated(op.source, offset);
        const values: [Vec3, number][] = [];
        for (const cell of cellsOf(op.source)) values.push([cell, this.blockAt('ext', cell)]);
        for (const [cell, block] of values) {
          this.writeCell(
            [cell[0] + offset[0], cell[1] + offset[1], cell[2] + offset[2]],
            block,
            touched,
          );
        }
        break;
      }
      case 'addBlock': {
        validateBlockDef(op.block);
        const name = op.block.name;
        if (this.palette.some((b) => b.name === name) || this.provisionalBlocks.has(name)) {
          throw invalid(`方块名称 ${name} 已存在`);
        }
        let highest = BLOCK_AIR;
        for (const b of this.palette) highest = Math.max(highest, b.id);
        for (const p of this.provisionalBlocks.values()) highest = Math.max(highest, p.id);
        const next = highest + 1;
        if (next > 0xffff) throw invalid('方块编号已用完');
        this.provisionalBlocks.set(name, { id: next, def: op.block });
        touched.palette = true;
        break;
      }
      case 'placeEntity': {
        const entity = op.entity;
        const layer = layerOfKind(this.kind);
        if (entity.layer !== layer) {
          throw invalid(
            this.kind === 'ext' ? '操作只能放扩展层的物件' : '重建草稿只能放重建层的物件',
          );
        }
        this.checkEntityId(entity);
        this.existingEntity(entity.entityId);
        // 模板只能被同一层引用：只把这一层的模板交给校验。
        const templates = this.templatesOf(layer);
        if (entity.kind === 'template' && entity.shape !== undefined) {
          templates.set(entity.entityId, entity.shape);
        }
        validateEntityBody(entity, templates);
        this.entities.set(entity.entityId, entity);
        touched.entities.add(entity.entityId);
        break;
      }
      case 'removeEntity': {
        const existing = this.existingEntity(op.entityId);
        if (existing === undefined) {
          if (op.ifPresent === true) break;
          throw invalid(`物件 ${op.entityId} 不存在`);
        }
        if (this.usersOfTemplate(op.entityId, existing.layer).length > 0) {
          throw invalid(`模板 ${op.entityId} 仍被物件使用`);
        }
        this.entities.delete(op.entityId);
        touched.entities.add(op.entityId);
        break;
      }
      case 'clearRebuilt': {
        for (const id of this.sortedEntityIds()) {
          if (this.entities.get(id)!.layer === 'rebuilt') {
            this.entities.delete(id);
            touched.entities.add(id);
          }
        }
        touched.rebuiltLayer = true;
        break;
      }
      case 'setScan': {
        if (this.scan !== null) throw invalid('一个草稿最多一次 setScan');
        validateScanSpec(op.scan);
        this.scan = {
          scan: op.scan,
          ...(op.observedAt !== undefined ? { observedAt: op.observedAt } : {}),
        };
        touched.scan = true;
        break;
      }
      case 'createAnchor': {
        validateAnchorBody(op.anchor);
        const skip = this.anchorSkip(op.anchor.anchorId, op.ifNew);
        if (skip !== null) {
          touched.skippedAnchors.set(op.anchor.anchorId, skip);
          break;
        }
        if (this.anchors.has(op.anchor.anchorId)) {
          throw invalid(`锚点 ${op.anchor.anchorId} 已存在`);
        }
        this.anchors.set(op.anchor.anchorId, op.anchor);
        touched.anchors.add(op.anchor.anchorId);
        break;
      }
      case 'moveAnchor': {
        const next = moved(this.existingAnchor(op.anchorId), op);
        validateAnchorBody(next);
        if (next.kind === 'space') throw invalid('空间级锚点没有位置');
        this.anchors.set(op.anchorId, next);
        touched.anchors.add(op.anchorId);
        break;
      }
      case 'updateAnchor': {
        if (op.label === undefined && op.visibility === undefined && op.kind === undefined) {
          throw invalid('修改锚点至少要给出一个字段');
        }
        const current = this.existingAnchor(op.anchorId);
        const updated: AnchorBody = {
          ...current,
          ...(op.label !== undefined ? { label: op.label } : {}),
          ...(op.visibility !== undefined ? { visibility: op.visibility } : {}),
          ...(op.kind !== undefined ? { kind: op.kind } : {}),
        };
        validateAnchorBody(updated);
        this.anchors.set(op.anchorId, updated);
        touched.anchors.add(op.anchorId);
        break;
      }
      case 'removeAnchor': {
        if (op.anchorId === SPACE_ANCHOR_ID) throw invalid('空间级锚点不能删除');
        this.existingAnchor(op.anchorId);
        this.anchors.delete(op.anchorId);
        touched.anchors.add(op.anchorId);
        break;
      }
    }
    return touched;
  }

  /**
   * 逐条检查影响范围并作用（Rust `apply_in_scope`）：一批最多 200 条，任何一条失败都抛出
   * OpError，状态保持不变。`area` 为 null 时不检查范围。
   */
  applyInScope(ops: readonly Op[], area: AllowedArea | null): TouchedSet {
    if (ops.length > MAX_OPS_PER_BATCH) throw new OpError('tooManyOps', 0, '一批最多 200 条操作');
    return this.applySequence(ops, area);
  }

  /**
   * 同 `applyInScope`，但不限条数（本地建造用：服务端从上传应用操作时也不受每批 200 条的限制）。
   * `onFootprint` 收到每条操作的影响范围。
   */
  applySequence(
    ops: readonly Op[],
    area: AllowedArea | null,
    onFootprint?: (index: number, footprint: Footprint) => void,
  ): TouchedSet {
    const next = this.clone();
    const touched = emptyTouched();
    ops.forEach((op, index) => {
      let footprint: Footprint;
      try {
        footprint = next.footprint(op);
      } catch (error) {
        throw atIndex(error, index);
      }
      onFootprint?.(index, footprint);
      if (area !== null) {
        try {
          area.check(footprint);
        } catch (error) {
          throw atIndex(error, index);
        }
      }
      try {
        mergeTouched(touched, next.applyUnchecked(op));
      } catch (error) {
        throw atIndex(error, index);
      }
    });
    this.adopt(next);
    return touched;
  }

  private adopt(next: WorkingState): void {
    this.chunks.clear();
    next.chunks.forEach((cells, key) => this.chunks.set(key, cells));
    this.entities.clear();
    next.entities.forEach((value, key) => this.entities.set(key, value));
    this.anchors.clear();
    next.anchors.forEach((value, key) => this.anchors.set(key, value));
    this.palette = next.palette;
    this.provisionalBlocks.clear();
    next.provisionalBlocks.forEach((value, key) => this.provisionalBlocks.set(key, value));
    this.kind = next.kind;
    this.scan = next.scan;
    // next 复制或新建的数组只有它自己引用，next 用完即弃，这些数组转归本对象独占。
    this.owned.clear();
    next.owned.forEach((key) => this.owned.add(key));
  }

  /** 与基础版本相比，碰过的区块有哪些变化；全 0 的区块记为删除（`hash = null`）。 */
  chunkChanges(base: ReadonlyMap<string, string>, touched: Iterable<string>): ChunkChange[] {
    return [...touched]
      .map(parseChunkKey)
      .sort(compareChunkKeys)
      .flatMap((key) => {
        const text = chunkKeyString(key);
        const cells = this.chunks.get(text);
        const hash = cells === undefined || isEmptyChunk(cells) ? null : chunkHash(cells);
        return hash !== (base.get(text) ?? null) ? [{ ...key, hash }] : [];
      });
  }

  /** 全部非空区块的哈希（键 `layer:cx:cy:cz`）。 */
  chunkHashes(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, cells] of this.chunks)
      if (!isEmptyChunk(cells)) out.set(key, chunkHash(cells));
    return out;
  }
}

function x0Index(x: number, y: number, z: number): number {
  return x + CHUNK_SIZE * (z + CHUNK_SIZE * y);
}

function moved(old: AnchorBody, op: MoveAnchorOp): AnchorBody {
  const { box: _box, position: _position, ...rest } = old;
  void _box;
  void _position;
  return {
    ...rest,
    ...(op.box !== undefined ? { box: op.box } : {}),
    ...(op.position !== undefined ? { position: op.position } : {}),
  };
}

/** 盒子坐标是否在网格允许的范围内（给工具包用）。 */
export function withinGridRange(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= MAX_GRID_COORD;
}
