import { canonicalJson, contentHash } from './canonical.js';
import type { Layer } from './chunk.js';
import {
  aabbContains,
  aabbGridCover,
  aabbIsValid,
  gridBoxError,
  GridError,
  type Aabb,
  type GridBox,
  type Vec3,
} from './grid.js';
import { isSha256Hex } from './hash.js';
import { isObjectId, SPACE_ANCHOR_ID } from './ids.js';
import {
  normalizeShape,
  shapeBounds,
  SHADING_MODES,
  ShapeError,
  validateOpacity,
  validateShape,
  type Shading,
  type Shape,
  type TemplateTable,
} from './shape.js';

/**
 * 物件和锚点记录（设计 4.4、SHAPES 3；Rust `record.rs` 的移植）。
 *
 * 记录的内容哈希 = `{"body": …, "kind": …, "spaceId": …}` 的规范化 JSON 的 sha256。
 * body 先按服务端的存法整理（去掉值为 null 的可选字段、`props` 缺省为 `{}`），
 * 这样本地算出的哈希和服务端一致。
 */

/** 物件 `props` 规范化后的最大字节数。 */
export const MAX_PROPS_BYTES = 16 * 1024;
/** 标签最大字符数。 */
export const MAX_LABEL_CHARS = 200;
/** 声明的包围盒允许比计算结果小这么多（米）。 */
export const BOUNDS_TOLERANCE = 1e-6;
/**
 * 重建层新放的物件（含模板）编号的前缀；扩展层新放的物件不能用它（docs/design/server-slim.md 2.5
 * 第 1 条）。物件和模板共用一个编号空间，两层各用一段。
 */
export const REBUILT_ID_PREFIX = 'rb.';

/** 编号是不是重建层的编号（以 `rb.` 开头）。 */
export function isRebuiltId(id: string): boolean {
  return id.startsWith(REBUILT_ID_PREFIX);
}

export type EntityKind = 'structure' | 'object' | 'template';
export type DataVisibility = 'public' | 'internal';
export type AnchorKind = 'table' | 'seat' | 'zone' | 'door' | 'camera' | 'counter' | 'space';

export const ENTITY_KINDS: readonly EntityKind[] = ['structure', 'object', 'template'];
export const ANCHOR_KINDS: readonly AnchorKind[] = [
  'table',
  'seat',
  'zone',
  'door',
  'camera',
  'counter',
  'space',
];

export interface Fit {
  readonly meanCm: number;
  readonly p90Cm: number;
  readonly coverage3cm: number;
}

/** 物件记录的 body。结构元素（墙、地面、玻璃）也是物件；模板也存成物件。 */
export interface EntityBody {
  readonly entityId: string;
  readonly layer: Layer;
  readonly kind: EntityKind;
  readonly label?: string;
  readonly anchorId?: string;
  readonly regionId?: string;
  readonly shape?: Shape;
  readonly assetHash?: string;
  /** 模型（assetHash）整体的调色、半透明、不受光照、着色方式；只能和 assetHash 一起给。 */
  readonly material?: ModelMaterial;
  readonly textures?: readonly string[];
  /** 由生成方计算，用于权限范围检查和网站裁剪。 */
  readonly bounds: Aabb;
  readonly fit?: Fit;
  /** 不透明的键值；`source` 是对象时是外部模型的署名（ModelSource），按结构校验。 */
  readonly props?: Readonly<Record<string, unknown>>;
}

/** 物件模型整体的外观（docs/SHAPES.md 第 3 节）。 */
export interface ModelMaterial {
  /** 乘到模型原来的颜色上（sRGB 0–255）。 */
  readonly tint?: readonly [number, number, number];
  /** 0–1。 */
  readonly opacity?: number;
  readonly unlit?: boolean;
  /**
   * 网站怎么画模型里的材质，默认 `baked`：扫描切出来的模型按烘焙贴图的看法画（0.3 倍受光 + 0.72 倍自发光）；
   * `albedo`：模型库（Poly Haven、Objaverse 等）的贴图是固有色，按 glb 里的材质原样完整受光。
   */
  readonly shading?: Shading;
}

/** 外部模型的可选库。 */
export const SOURCE_LIBRARIES = ['polyhaven', 'objaverse', 'sketchfab'] as const;
/** 外部模型允许的许可：明确可商用、不传染（NC、ND、SA 一律排除）。 */
export const SOURCE_LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0'] as const;
/** 来源里编号、作者、标题的最大字符数。 */
export const MAX_SOURCE_TEXT_CHARS = 200;
/** 来源页地址的最大字符数。 */
export const MAX_SOURCE_URL_CHARS = 2000;

/** 外部模型的来源（`props.source` 是对象时），网站据此显示署名。 */
export interface ModelSource {
  readonly library: (typeof SOURCE_LIBRARIES)[number];
  readonly id: string;
  /** 来源页（https 地址）。 */
  readonly page: string;
  readonly author: string;
  /** SPDX 风格的许可名。 */
  readonly license: (typeof SOURCE_LICENSES)[number];
  readonly title: string;
}

/** 锚点记录的 body。位置用盒子（格）或点（米）表示，二选一；`_space` 没有位置。 */
export interface AnchorBody {
  readonly anchorId: string;
  readonly kind: AnchorKind;
  readonly box?: GridBox;
  readonly position?: Vec3;
  readonly label?: string;
  readonly visibility: DataVisibility;
}

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function given(object: Json, key: string): boolean {
  return object[key] !== undefined && object[key] !== null;
}

function onlyKeys(object: Json, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(object)) {
    if (object[key] !== undefined && !allowed.includes(key)) {
      throw new RecordError(`${what} 里不认识的字段 ${key}`);
    }
  }
}

function numberTuple(value: unknown, length: number, what: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((v) => typeof v === 'number')
  ) {
    throw new RecordError(`${what} 必须是 ${length} 个数字`);
  }
}

function optionalString(object: Json, key: string, what: string): void {
  if (given(object, key) && typeof object[key] !== 'string') {
    throw new RecordError(`${what}.${key} 必须是字符串`);
  }
}

/** 是否含 Unicode 控制字符（与 Rust `char::is_control` 相同：U+0000–U+001F、U+007F–U+009F）。 */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function checkLabel(label: string): void {
  if ([...label].length > MAX_LABEL_CHARS || hasControl(label)) {
    throw new RecordError('label 太长或含控制字符');
  }
}

/** 是否含空白（与 Rust `char::is_whitespace` 相同的 Unicode White_Space 字符）。 */
function hasWhitespace(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x09 && code <= 0x0d) ||
      code === 0x20 ||
      code === 0x85 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000
    ) {
      return true;
    }
  }
  return false;
}

/** 来源页地址：`https://` 开头、后面至少一个字符，不超过 2000 个字符，不含空白和控制字符。 */
export function isHttpsUrl(url: string): boolean {
  return (
    url.length > 'https://'.length &&
    url.startsWith('https://') &&
    [...url].length <= MAX_SOURCE_URL_CHARS &&
    !hasWhitespace(url) &&
    !hasControl(url)
  );
}

const SOURCE_FIELDS = ['library', 'id', 'page', 'author', 'license', 'title'];

/**
 * 外部模型的署名（Rust `ModelSource`）：六个字段都必须是字符串，不能有别的字段；
 * 库和许可只能取白名单里的值，来源页必须是 https 地址。
 */
export function validateModelSource(value: unknown): ModelSource {
  if (!isPlainObject(value)) throw new RecordError('props.source 必须是对象');
  for (const key of Object.keys(value)) {
    if (!SOURCE_FIELDS.includes(key)) throw new RecordError(`props.source 里不认识的字段 ${key}`);
  }
  for (const key of SOURCE_FIELDS) {
    if (typeof value[key] !== 'string') throw new RecordError(`props.source.${key} 必须是字符串`);
  }
  const source = value as unknown as ModelSource;
  if (!(SOURCE_LIBRARIES as readonly string[]).includes(source.library)) {
    throw new RecordError('props.source.library 只能是 polyhaven、objaverse 或 sketchfab');
  }
  if (!(SOURCE_LICENSES as readonly string[]).includes(source.license)) {
    throw new RecordError(
      'props.source.license 只能是 CC0-1.0、CC-BY-4.0 或 CC-BY-3.0（可商用、不传染）',
    );
  }
  for (const key of ['id', 'author', 'title'] as const) {
    const chars = [...source[key]].length;
    if (chars === 0 || chars > MAX_SOURCE_TEXT_CHARS || hasControl(source[key])) {
      throw new RecordError(`props.source.${key} 必须是 1 到 200 个字符，不含控制字符`);
    }
  }
  if (!isHttpsUrl(source.page)) {
    throw new RecordError(
      'props.source.page 必须是 https 地址（不超过 2000 个字符，不含空白和控制字符）',
    );
  }
  return source;
}

/**
 * `props` 里有结构的键（Rust `validate_props`）：`source` 是对象时按署名校验；
 * 不是对象的 `source`（旧数据里识别来源的字符串）照旧当不透明的值。
 */
export function validateProps(props: Readonly<Record<string, unknown>>): void {
  if (isPlainObject(props.source)) validateModelSource(props.source);
}

// ---------------------------------------------------------------------------
// 物件
// ---------------------------------------------------------------------------

const ENTITY_FIELDS = [
  'entityId',
  'layer',
  'kind',
  'label',
  'anchorId',
  'regionId',
  'shape',
  'assetHash',
  'material',
  'textures',
  'bounds',
  'fit',
  'props',
];

/** 结构检查（相当于服务端的反序列化：字段名、类型、未知字段）。 */
export function parseEntityBody(value: unknown): EntityBody {
  if (!isPlainObject(value)) throw new RecordError('物件必须是对象');
  onlyKeys(value, ENTITY_FIELDS, 'entity');
  if (typeof value.entityId !== 'string') throw new RecordError('entityId 必须是字符串');
  if (value.layer !== 'rebuilt' && value.layer !== 'ext') {
    throw new RecordError('layer 只能是 rebuilt 或 ext');
  }
  if (!ENTITY_KINDS.includes(value.kind as EntityKind)) {
    throw new RecordError('kind 只能是 structure、object、template');
  }
  for (const key of ['label', 'anchorId', 'regionId', 'assetHash'])
    optionalString(value, key, 'entity');
  if (given(value, 'textures')) {
    if (!Array.isArray(value.textures) || !value.textures.every((t) => typeof t === 'string')) {
      throw new RecordError('textures 必须是字符串数组');
    }
  }
  const bounds = value.bounds;
  if (!isPlainObject(bounds)) throw new RecordError('bounds 必须是 { min, max }');
  onlyKeys(bounds, ['min', 'max'], 'bounds');
  numberTuple(bounds.min, 3, 'bounds.min');
  numberTuple(bounds.max, 3, 'bounds.max');
  if (given(value, 'fit')) {
    const fit = value.fit;
    if (!isPlainObject(fit)) throw new RecordError('fit 必须是对象');
    onlyKeys(fit, ['meanCm', 'p90Cm', 'coverage3cm'], 'fit');
    for (const key of ['meanCm', 'p90Cm', 'coverage3cm']) {
      if (typeof fit[key] !== 'number') throw new RecordError(`fit.${key} 必须是数字`);
    }
  }
  if (given(value, 'props') && !isPlainObject(value.props)) {
    throw new RecordError('props 必须是对象');
  }
  if (given(value, 'material')) {
    const material = value.material;
    if (!isPlainObject(material)) throw new RecordError('material 必须是对象');
    onlyKeys(material, ['tint', 'opacity', 'unlit', 'shading'], 'material');
    if (given(material, 'tint')) {
      const tint = material.tint;
      if (
        !Array.isArray(tint) ||
        tint.length !== 3 ||
        !tint.every((c) => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 255)
      ) {
        throw new RecordError('material.tint 必须是 3 个 0–255 的整数');
      }
    }
    if (given(material, 'opacity') && typeof material.opacity !== 'number') {
      throw new RecordError('material.opacity 必须是数字');
    }
    if (given(material, 'unlit') && typeof material.unlit !== 'boolean') {
      throw new RecordError('material.unlit 必须是布尔值');
    }
    if (given(material, 'shading') && !SHADING_MODES.includes(material.shading as Shading)) {
      throw new RecordError('material.shading 只能是 baked 或 albedo');
    }
  }
  if (given(value, 'shape')) {
    try {
      validateShape(value.shape);
    } catch (error) {
      if (error instanceof ShapeError) throw new RecordError(error.message);
      throw error;
    }
  }
  return normalizeEntityBody(value as unknown as EntityBody);
}

/** 按服务端的存法整理 body：去掉 null 可选字段，`props` 缺省为 `{}`。 */
export function normalizeEntityBody(body: EntityBody): EntityBody {
  const raw = body as unknown as Json;
  const out: Json = {};
  for (const key of ENTITY_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  if (out.shape !== undefined) out.shape = normalizeShape(out.shape as Shape);
  out.props = out.props ?? {};
  return out as unknown as EntityBody;
}

/** 结构校验，并核对声明的包围盒包住了按形状算出的包围盒（Rust `EntityBody::validate`）。 */
export function validateEntityBody(body: EntityBody, templates: TemplateTable): void {
  if (!isObjectId(body.entityId) || body.entityId.startsWith('_')) {
    throw new RecordError('entityId 格式不对');
  }
  if (body.label !== undefined) checkLabel(body.label);
  for (const [name, id] of [
    ['anchorId', body.anchorId],
    ['regionId', body.regionId],
  ] as const) {
    if (id !== undefined && !isObjectId(id)) throw new RecordError(`${name} 格式不对`);
  }
  if (body.shape === undefined && body.assetHash === undefined) {
    throw new RecordError('物件至少要有 shape 或 assetHash');
  }
  if (body.kind === 'template' && body.shape === undefined)
    throw new RecordError('模板必须给出 shape');
  if (body.assetHash !== undefined && !isSha256Hex(body.assetHash)) {
    throw new RecordError('assetHash 必须是 64 位小写十六进制');
  }
  if (body.material !== undefined) {
    if (body.assetHash === undefined) {
      throw new RecordError('material 只用于模型，必须和 assetHash 一起给');
    }
    try {
      validateOpacity('material.opacity', body.material.opacity);
    } catch (error) {
      if (error instanceof ShapeError) throw new RecordError(error.message);
      throw error;
    }
  }
  if (
    body.textures !== undefined &&
    (body.textures.length > 64 || !body.textures.every((hash) => isSha256Hex(hash)))
  ) {
    throw new RecordError('textures 必须是至多 64 个资源哈希');
  }
  if (!aabbIsValid(body.bounds)) throw new RecordError('bounds 必须是有限值且 min ≤ max');
  if (body.fit !== undefined) {
    const values = [body.fit.meanCm, body.fit.p90Cm, body.fit.coverage3cm];
    if (!values.every((v) => Number.isFinite(v) && v >= 0) || body.fit.coverage3cm > 1) {
      throw new RecordError('fit 取值不合法');
    }
  }
  if (Buffer.byteLength(canonicalJson(body.props ?? {}), 'utf8') > MAX_PROPS_BYTES) {
    throw new RecordError('props 超过 16KB');
  }
  validateProps(body.props ?? {});
  if (body.shape !== undefined) {
    try {
      validateShape(body.shape);
      const computed = shapeBounds(body.shape, templates);
      if (!aabbContains(body.bounds, computed, BOUNDS_TOLERANCE)) {
        throw new RecordError('bounds 没有包住形状的实际范围');
      }
    } catch (error) {
      if (error instanceof ShapeError) throw new RecordError(error.message);
      throw error;
    }
  }
}

/** 物件在格子坐标下占的范围（权限检查用）。 */
export function entityFootprint(body: EntityBody): GridBox {
  try {
    return aabbGridCover(body.bounds);
  } catch (error) {
    if (error instanceof GridError)
      throw new RecordError(`bounds 无法换算成格子：${error.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 锚点
// ---------------------------------------------------------------------------

const ANCHOR_FIELDS = ['anchorId', 'kind', 'box', 'position', 'label', 'visibility'];

export function parseAnchorBody(value: unknown): AnchorBody {
  if (!isPlainObject(value)) throw new RecordError('锚点必须是对象');
  onlyKeys(value, ANCHOR_FIELDS, 'anchor');
  if (typeof value.anchorId !== 'string') throw new RecordError('anchorId 必须是字符串');
  if (!ANCHOR_KINDS.includes(value.kind as AnchorKind)) throw new RecordError('锚点 kind 不认识');
  if (value.visibility !== 'public' && value.visibility !== 'internal') {
    throw new RecordError('visibility 只能是 public 或 internal');
  }
  if (given(value, 'box')) {
    const error = Array.isArray(value.box) ? gridBoxError(value.box as number[]) : '盒子必须是数组';
    if (error !== null) throw new RecordError(`box：${error}`);
  }
  if (given(value, 'position')) numberTuple(value.position, 3, 'position');
  optionalString(value, 'label', 'anchor');
  const out: Json = {};
  for (const key of ANCHOR_FIELDS) {
    if (value[key] !== undefined && value[key] !== null) out[key] = value[key];
  }
  return out as unknown as AnchorBody;
}

export function validateAnchorBody(body: AnchorBody): void {
  const reserved = body.anchorId === SPACE_ANCHOR_ID;
  if (!isObjectId(body.anchorId) || (body.anchorId.startsWith('_') && !reserved)) {
    throw new RecordError('anchorId 格式不对（以 _ 开头的编号保留）');
  }
  if (reserved !== (body.kind === 'space')) throw new RecordError('只有 _space 锚点的类型是 space');
  if (body.label !== undefined) checkLabel(body.label);
  const hasBox = body.box !== undefined;
  const hasPosition = body.position !== undefined;
  if (body.kind === 'space') {
    if (hasBox || hasPosition) throw new RecordError('_space 锚点没有位置');
    return;
  }
  if (hasBox && !hasPosition) return;
  if (!hasBox && hasPosition) {
    if (!body.position!.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e5)) {
      throw new RecordError('position 必须是有限值');
    }
    return;
  }
  throw new RecordError('锚点必须且只能给出 box 或 position');
}

/** 锚点占的范围：`'space'` 表示空间级锚点（涉及整个空间）。 */
export function anchorFootprint(body: AnchorBody): GridBox | 'space' {
  if (body.box !== undefined) return body.box;
  if (body.position !== undefined) {
    try {
      return aabbGridCover({ min: body.position, max: body.position });
    } catch (error) {
      if (error instanceof GridError) {
        throw new RecordError(`position 无法换算成格子：${error.message}`);
      }
      throw error;
    }
  }
  return 'space';
}

// ---------------------------------------------------------------------------
// 内容哈希
// ---------------------------------------------------------------------------

export type RecordKind = 'entity' | 'anchor';

/** 记录的内容哈希（`records._id`）。 */
export function recordHash(kind: RecordKind, spaceId: string, body: unknown): string {
  return contentHash({ body, kind, spaceId });
}

export function entityRecordHash(spaceId: string, body: EntityBody): string {
  return recordHash('entity', spaceId, normalizeEntityBody(body));
}

export function anchorRecordHash(spaceId: string, body: AnchorBody): string {
  return recordHash('anchor', spaceId, body);
}
