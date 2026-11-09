import { aabbCorners, aabbFromPoints, aabbUnion, type Aabb, type Vec3 } from './grid.js';
import { isSha256Hex } from './hash.js';
import { isObjectId } from './ids.js';

/**
 * 形状词表（docs/SHAPES.md 第 2 节；Rust `shape.rs` 的移植）：类型、校验、包围盒。
 *
 * 校验与服务端一致：拼错或多余的字段、类型不对、取值超出范围一律拒绝。包围盒规则见
 * Rust 模块文档：先求局部包围盒（与分段数无关，圆角、倒角、smooth 忽略，lathe 一律按整圈，
 * sweep 向各方向扩出截面外接半径，轮廓圆弧算上坐标轴方向的极值点），再用 transform
 * 变换 8 个角点取包围盒；变换顺序 缩放 → 翻滚 → 俯仰 → 偏航 → 平移。
 */

export type Vec2 = readonly [number, number];
export type Rgb = readonly [number, number, number];

export interface Transform {
  readonly position?: Vec3;
  /** 绕 y 轴，度。 */
  readonly yaw?: number;
  /** 绕 x 轴，度。 */
  readonly pitch?: number;
  /** 绕 z 轴，度。 */
  readonly roll?: number;
  readonly scale?: Vec3;
}

export type UvMode = 'box' | 'planar' | 'cylindrical' | 'mesh';

export interface ColorMaterial {
  /** sRGB 0–255。 */
  readonly color: Rgb;
}

export interface TextureMaterial {
  /** 资源哈希。 */
  readonly texture: string;
  readonly uv: UvMode;
  readonly tint?: Rgb;
}

export type Material = ColorMaterial | TextureMaterial;

export interface OutlineArc {
  /** 把第 from 点到下一点之间的直线换成圆弧。 */
  readonly from: number;
  /** tan(圆心角 / 4)：正值向外凸，负值向内凹。 */
  readonly bulge: number;
}

export interface OutlineFillet {
  readonly at: number;
  readonly radius: number;
}

/** 二维轮廓，点是 `[x, z]`，逆时针排列。 */
export interface Outline {
  readonly points: readonly Vec2[];
  readonly closed?: boolean;
  readonly arcs?: readonly OutlineArc[];
  readonly fillets?: readonly OutlineFillet[];
}

interface ShapeBase {
  readonly transform?: Transform;
  readonly material?: Material;
}

export interface BoxShape extends ShapeBase {
  readonly type: 'box';
  readonly size: Vec3;
  readonly fillet?: number;
  readonly chamfer?: number;
  readonly segments?: number;
}

export interface CylinderShape extends ShapeBase {
  readonly type: 'cylinder';
  readonly radius: number;
  readonly height: number;
  readonly radiusTop?: number;
  readonly segments?: number;
  readonly fillet?: number;
}

export interface ConeShape extends ShapeBase {
  readonly type: 'cone';
  readonly radius: number;
  readonly height: number;
  readonly segments?: number;
}

export interface ExtrudeShape extends ShapeBase {
  readonly type: 'extrude';
  readonly outline: Outline;
  readonly height: number;
  readonly fillet?: number;
  readonly chamfer?: number;
}

export interface LatheShape extends ShapeBase {
  readonly type: 'lathe';
  /** `[[r, y], ...]`，r ≥ 0。 */
  readonly profile: readonly Vec2[];
  readonly segments?: number;
  readonly angle?: number;
}

export type SweepSection = { readonly circle: number } | { readonly rect: Vec2 };

export interface SweepShape extends ShapeBase {
  readonly type: 'sweep';
  readonly path: readonly Vec3[];
  readonly section: SweepSection;
  readonly smooth?: number;
  readonly caps?: boolean;
}

export interface LoftSection {
  readonly y: number;
  readonly outline: Outline;
}

export interface LoftShape extends ShapeBase {
  readonly type: 'loft';
  readonly sections: readonly LoftSection[];
}

export interface GroupShape extends ShapeBase {
  readonly type: 'group';
  readonly children: readonly Shape[];
}

export interface InstanceShape extends ShapeBase {
  readonly type: 'instance';
  readonly template: string;
}

export type Shape =
  | BoxShape
  | CylinderShape
  | ConeShape
  | ExtrudeShape
  | LatheShape
  | SweepShape
  | LoftShape
  | GroupShape
  | InstanceShape;

export type ShapeType = Shape['type'];

/** 模板表：模板编号 → 形状。 */
export type TemplateTable = ReadonlyMap<string, Shape> | Readonly<Record<string, Shape>>;

export const MAX_SHAPE_NODES = 4096;
export const MAX_SHAPE_DEPTH = 16;
export const MAX_POINTS = 1024;
export const MAX_SEGMENTS = 256;
export const MAX_FILLET_SEGMENTS = 32;
export const MAX_COORD = 100_000;
export const MAX_SCALE = 1000;
export const MAX_ANGLE = 3600;
export const MAX_BULGE = 1000;
export const MIN_LOFT_SECTIONS = 2;
export const MAX_LOFT_SECTIONS = 8;

/** 校验或计算失败：`path` 是 JSON 路径，例如 `$.children[2].outline.points[3]`。 */
export class ShapeError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'ShapeError';
  }
}

// ---------------------------------------------------------------------------
// 结构（相当于 serde 的反序列化：字段名、类型、未知字段）
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(object: Json, key: string): boolean {
  return object[key] !== undefined && object[key] !== null;
}

function onlyKeys(object: Json, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) continue;
    if (!allowed.includes(key)) throw new ShapeError(path, `不认识的字段 ${key}`);
  }
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number') throw new ShapeError(path, '必须是数字');
  return value;
}

function expectUint(value: unknown, path: string, max = 0xffff_ffff): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ShapeError(path, '必须是非负整数');
  }
  return value;
}

function expectTuple(value: unknown, length: number, path: string): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new ShapeError(path, `必须是 ${length} 个数字`);
  }
  return value.map((item, index) => expectNumber(item, `${path}[${index}]`));
}

function expectRgb(value: unknown, path: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
  ) {
    throw new ShapeError(path, '颜色必须是 3 个 0–255 的整数');
  }
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(path, '必须是数组');
  return value;
}

function optionalNumber(object: Json, key: string, path: string): number | undefined {
  return present(object, key) ? expectNumber(object[key], `${path}.${key}`) : undefined;
}

function optionalUint(object: Json, key: string, path: string): number | undefined {
  return present(object, key) ? expectUint(object[key], `${path}.${key}`) : undefined;
}

function required(object: Json, key: string, path: string): unknown {
  if (!present(object, key)) throw new ShapeError(path, `缺少字段 ${key}`);
  return object[key];
}

// ---------------------------------------------------------------------------
// 取值检查
// ---------------------------------------------------------------------------

function finite(path: string, value: number): void {
  if (!(Number.isFinite(value) && Math.abs(value) <= MAX_COORD)) {
    throw new ShapeError(path, '必须是有限值且绝对值不超过 100000');
  }
}

function positive(path: string, value: number): void {
  finite(path, value);
  if (!(value > 0)) throw new ShapeError(path, '必须大于 0');
}

function nonNegative(path: string, value: number): void {
  finite(path, value);
  if (!(value >= 0)) throw new ShapeError(path, '不能小于 0');
}

function coords(path: string, values: readonly number[]): void {
  values.forEach((value, index) => finite(`${path}[${index}]`, value));
}

function segments(path: string, value: number | undefined, min: number, max: number): void {
  if (value !== undefined && !(value >= min && value <= max)) {
    throw new ShapeError(path, `分段数必须在 ${min} 到 ${max} 之间`);
  }
}

/** 有向面积（逆时针为正）。 */
export function signedArea(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function validateTransform(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new ShapeError(path, 'transform 必须是对象');
  onlyKeys(value, ['position', 'yaw', 'pitch', 'roll', 'scale'], path);
  if (present(value, 'position')) {
    coords(`${path}.position`, expectTuple(value.position, 3, `${path}.position`));
  }
  for (const name of ['yaw', 'pitch', 'roll']) {
    const angle = optionalNumber(value, name, path);
    if (angle !== undefined && !(Number.isFinite(angle) && Math.abs(angle) <= MAX_ANGLE)) {
      throw new ShapeError(`${path}.${name}`, '角度必须是有限值且绝对值不超过 3600');
    }
  }
  if (present(value, 'scale')) {
    expectTuple(value.scale, 3, `${path}.scale`).forEach((v, axis) => {
      if (!Number.isFinite(v) || v === 0 || Math.abs(v) > MAX_SCALE) {
        throw new ShapeError(`${path}.scale[${axis}]`, '缩放必须是非零有限值且绝对值不超过 1000');
      }
    });
  }
}

function validateMaterial(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new ShapeError(path, 'material 必须是对象');
  onlyKeys(value, ['color', 'texture', 'uv', 'tint'], path);
  if (present(value, 'color')) expectRgb(value.color, `${path}.color`);
  if (present(value, 'tint')) expectRgb(value.tint, `${path}.tint`);
  if (present(value, 'texture') && typeof value.texture !== 'string') {
    throw new ShapeError(`${path}.texture`, '必须是字符串');
  }
  if (
    present(value, 'uv') &&
    !['box', 'planar', 'cylindrical', 'mesh'].includes(value.uv as string)
  ) {
    throw new ShapeError(`${path}.uv`, 'uv 只能是 box、planar、cylindrical、mesh');
  }
  const color = present(value, 'color');
  const texture = present(value, 'texture');
  if (color && !texture) {
    if (present(value, 'uv') || present(value, 'tint')) {
      throw new ShapeError(path, '纯色材质不能带 uv 或 tint');
    }
  } else if (!color && texture) {
    if (!isSha256Hex(value.texture)) {
      throw new ShapeError(`${path}.texture`, '贴图必须是 64 位小写十六进制的资源哈希');
    }
    if (!present(value, 'uv')) throw new ShapeError(path, '贴图材质必须给出 uv');
  } else {
    throw new ShapeError(path, '材质必须且只能给出 color 或 texture');
  }
}

function validateOutline(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new ShapeError(path, '轮廓必须是对象');
  onlyKeys(value, ['points', 'closed', 'arcs', 'fillets'], path);
  if (present(value, 'closed') && typeof value.closed !== 'boolean') {
    throw new ShapeError(`${path}.closed`, '必须是布尔值');
  }
  const points = expectArray(required(value, 'points', path), `${path}.points`).map((p, i) =>
    expectTuple(p, 2, `${path}.points[${i}]`),
  ) as unknown as Vec2[];
  const arcs = present(value, 'arcs')
    ? expectArray(value.arcs, `${path}.arcs`).map((arc, i) => {
        const at = `${path}.arcs[${i}]`;
        if (!isPlainObject(arc)) throw new ShapeError(at, '圆弧必须是对象');
        onlyKeys(arc, ['from', 'bulge'], at);
        return {
          from: expectUint(required(arc, 'from', at), `${at}.from`, Number.MAX_SAFE_INTEGER),
          bulge: expectNumber(required(arc, 'bulge', at), `${at}.bulge`),
        };
      })
    : [];
  const fillets = present(value, 'fillets')
    ? expectArray(value.fillets, `${path}.fillets`).map((fillet, i) => {
        const at = `${path}.fillets[${i}]`;
        if (!isPlainObject(fillet)) throw new ShapeError(at, '圆角必须是对象');
        onlyKeys(fillet, ['at', 'radius'], at);
        return {
          at: expectUint(required(fillet, 'at', at), `${at}.at`, Number.MAX_SAFE_INTEGER),
          radius: expectNumber(required(fillet, 'radius', at), `${at}.radius`),
        };
      })
    : [];
  // 以下是 Rust `Outline::validate`。
  if (value.closed === false) throw new ShapeError(`${path}.closed`, '拉伸和放样的轮廓必须闭合');
  const count = points.length;
  if (count < 3 || count > MAX_POINTS)
    throw new ShapeError(`${path}.points`, '轮廓需要 3 到 1024 个点');
  points.forEach((point, index) => coords(`${path}.points[${index}]`, point));
  if (!(signedArea(points) > 0)) {
    throw new ShapeError(`${path}.points`, '轮廓的点必须逆时针排列（有向面积为正）');
  }
  const seenArcs = new Set<number>();
  arcs.forEach((arc, index) => {
    const at = `${path}.arcs[${index}]`;
    if (arc.from >= count || seenArcs.has(arc.from))
      throw new ShapeError(at, 'from 超出点数或重复');
    seenArcs.add(arc.from);
    if (!(Number.isFinite(arc.bulge) && Math.abs(arc.bulge) <= MAX_BULGE)) {
      throw new ShapeError(at, 'bulge 必须是有限值且绝对值不超过 1000');
    }
  });
  const seenFillets = new Set<number>();
  fillets.forEach((fillet, index) => {
    const at = `${path}.fillets[${index}]`;
    if (fillet.at >= count || seenFillets.has(fillet.at))
      throw new ShapeError(at, 'at 超出点数或重复');
    seenFillets.add(fillet.at);
    positive(`${at}.radius`, fillet.radius);
  });
}

const KIND_FIELDS: Record<ShapeType, readonly string[]> = {
  box: ['size', 'fillet', 'chamfer', 'segments'],
  cylinder: ['radius', 'height', 'radiusTop', 'segments', 'fillet'],
  cone: ['radius', 'height', 'segments'],
  extrude: ['outline', 'height', 'fillet', 'chamfer'],
  lathe: ['profile', 'segments', 'angle'],
  sweep: ['path', 'section', 'smooth', 'caps'],
  loft: ['sections'],
  group: ['children'],
  instance: ['template'],
};

export const SHAPE_TYPES = Object.keys(KIND_FIELDS) as ShapeType[];

interface Counter {
  nodes: number;
}

function validateAt(value: unknown, path: string, depth: number, counter: Counter): void {
  counter.nodes += 1;
  if (counter.nodes > MAX_SHAPE_NODES) throw new ShapeError(path, '形状节点数超过 4096');
  if (depth > MAX_SHAPE_DEPTH) throw new ShapeError(path, '形状嵌套超过 16 层');
  if (!isPlainObject(value)) throw new ShapeError(path, '形状必须是对象');
  const type = value.type;
  if (typeof type !== 'string' || !(type in KIND_FIELDS)) {
    throw new ShapeError(path, `不认识的形状类型 ${String(type)}`);
  }
  onlyKeys(value, ['type', 'transform', 'material', ...KIND_FIELDS[type as ShapeType]], path);
  // 服务端把 transform、material 单独取出再解析，写成 null 会被拒绝。
  if (value.transform === null) throw new ShapeError(`${path}.transform`, 'transform 不能是 null');
  if (value.material === null) throw new ShapeError(`${path}.material`, 'material 不能是 null');
  if (present(value, 'transform')) validateTransform(value.transform, `${path}.transform`);
  if (present(value, 'material')) validateMaterial(value.material, `${path}.material`);
  switch (type as ShapeType) {
    case 'box': {
      expectTuple(required(value, 'size', path), 3, `${path}.size`).forEach((v, axis) =>
        positive(`${path}.size[${axis}]`, v),
      );
      const fillet = optionalNumber(value, 'fillet', path);
      if (fillet !== undefined) nonNegative(`${path}.fillet`, fillet);
      const chamfer = optionalNumber(value, 'chamfer', path);
      if (chamfer !== undefined) nonNegative(`${path}.chamfer`, chamfer);
      segments(`${path}.segments`, optionalUint(value, 'segments', path), 1, MAX_FILLET_SEGMENTS);
      return;
    }
    case 'cylinder': {
      positive(`${path}.radius`, expectNumber(required(value, 'radius', path), `${path}.radius`));
      positive(`${path}.height`, expectNumber(required(value, 'height', path), `${path}.height`));
      const radiusTop = optionalNumber(value, 'radiusTop', path);
      if (radiusTop !== undefined) nonNegative(`${path}.radiusTop`, radiusTop);
      segments(`${path}.segments`, optionalUint(value, 'segments', path), 3, MAX_SEGMENTS);
      const fillet = optionalNumber(value, 'fillet', path);
      if (fillet !== undefined) nonNegative(`${path}.fillet`, fillet);
      return;
    }
    case 'cone': {
      positive(`${path}.radius`, expectNumber(required(value, 'radius', path), `${path}.radius`));
      positive(`${path}.height`, expectNumber(required(value, 'height', path), `${path}.height`));
      segments(`${path}.segments`, optionalUint(value, 'segments', path), 3, MAX_SEGMENTS);
      return;
    }
    case 'extrude': {
      const height = expectNumber(required(value, 'height', path), `${path}.height`);
      const fillet = optionalNumber(value, 'fillet', path);
      const chamfer = optionalNumber(value, 'chamfer', path);
      validateOutline(required(value, 'outline', path), `${path}.outline`);
      positive(`${path}.height`, height);
      if (fillet !== undefined) nonNegative(`${path}.fillet`, fillet);
      if (chamfer !== undefined) nonNegative(`${path}.chamfer`, chamfer);
      return;
    }
    case 'lathe': {
      const profile = expectArray(required(value, 'profile', path), `${path}.profile`).map((p, i) =>
        expectTuple(p, 2, `${path}.profile[${i}]`),
      );
      const count = optionalUint(value, 'segments', path);
      const angle = optionalNumber(value, 'angle', path);
      if (profile.length < 2 || profile.length > MAX_POINTS) {
        throw new ShapeError(`${path}.profile`, '旋转体轮廓需要 2 到 1024 个点');
      }
      profile.forEach(([r, y], index) => {
        nonNegative(`${path}.profile[${index}][0]`, r!);
        finite(`${path}.profile[${index}][1]`, y!);
      });
      if (profile.every(([r]) => r === 0)) {
        throw new ShapeError(`${path}.profile`, '旋转体轮廓至少要有一个点不在轴上');
      }
      segments(`${path}.segments`, count, 3, MAX_SEGMENTS);
      if (angle !== undefined && !(Number.isFinite(angle) && angle > 0 && angle <= 360)) {
        throw new ShapeError(`${path}.angle`, '旋转角度必须在 (0, 360] 之间');
      }
      return;
    }
    case 'sweep': {
      const points = expectArray(required(value, 'path', path), `${path}.path`).map((p, i) =>
        expectTuple(p, 3, `${path}.path[${i}]`),
      );
      const section = required(value, 'section', path);
      const at = `${path}.section`;
      if (!isPlainObject(section)) throw new ShapeError(at, '截面必须是对象');
      const keys = Object.keys(section).filter((k) => section[k] !== undefined);
      if (keys.length !== 1 || (keys[0] !== 'circle' && keys[0] !== 'rect')) {
        throw new ShapeError(at, '截面必须是 { circle: r } 或 { rect: [w, h] }');
      }
      const circle = keys[0] === 'circle' ? expectNumber(section.circle, `${at}.circle`) : null;
      const rect = keys[0] === 'rect' ? expectTuple(section.rect, 2, `${at}.rect`) : null;
      const smooth = optionalNumber(value, 'smooth', path);
      if (present(value, 'caps') && typeof value.caps !== 'boolean') {
        throw new ShapeError(`${path}.caps`, '必须是布尔值');
      }
      if (points.length < 2 || points.length > MAX_POINTS) {
        throw new ShapeError(`${path}.path`, '扫掠路径需要 2 到 1024 个点');
      }
      points.forEach((point, index) => coords(`${path}.path[${index}]`, point));
      if (circle !== null) positive(`${at}.circle`, circle);
      if (rect !== null) {
        positive(`${at}.rect[0]`, rect[0]!);
        positive(`${at}.rect[1]`, rect[1]!);
      }
      if (smooth !== undefined) nonNegative(`${path}.smooth`, smooth);
      return;
    }
    case 'loft': {
      const sections = expectArray(required(value, 'sections', path), `${path}.sections`);
      sections.forEach((section, index) => {
        const at = `${path}.sections[${index}]`;
        if (!isPlainObject(section)) throw new ShapeError(at, '截面必须是对象');
        onlyKeys(section, ['y', 'outline'], at);
        expectNumber(required(section, 'y', at), `${at}.y`);
        if (!present(section, 'outline')) throw new ShapeError(at, '缺少字段 outline');
      });
      if (sections.length < MIN_LOFT_SECTIONS || sections.length > MAX_LOFT_SECTIONS) {
        throw new ShapeError(`${path}.sections`, '放样需要 2 到 8 个截面');
      }
      let previous = -Infinity;
      sections.forEach((section, index) => {
        const at = `${path}.sections[${index}]`;
        const s = section as Json;
        const y = s.y as number;
        finite(`${at}.y`, y);
        if (index > 0 && y <= previous) throw new ShapeError(`${at}.y`, '截面的 y 必须递增');
        previous = y;
        validateOutline(s.outline, `${at}.outline`);
      });
      return;
    }
    case 'group': {
      const children = expectArray(required(value, 'children', path), `${path}.children`);
      if (children.length === 0) throw new ShapeError(`${path}.children`, '组合至少要有一个子形状');
      children.forEach((child, index) =>
        validateAt(child, `${path}.children[${index}]`, depth + 1, counter),
      );
      return;
    }
    case 'instance': {
      const template = required(value, 'template', path);
      if (typeof template !== 'string') throw new ShapeError(`${path}.template`, '必须是字符串');
      if (!isObjectId(template)) throw new ShapeError(`${path}.template`, '模板编号格式不对');
      return;
    }
  }
}

/** 结构校验：字段、类型、取值、点数、嵌套深度、节点数。不解析模板引用。 */
export function validateShape(value: unknown, path = '$'): asserts value is Shape {
  validateAt(value, path, 0, { nodes: 0 });
}

/** 去掉值为 null 的可选字段（服务端把 null 当作没给），得到服务端会存下的形状 JSON。 */
export function normalizeShape(shape: Shape): Shape {
  return stripNulls(shape) as Shape;
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (isPlainObject(value)) {
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) continue;
      out[key] = stripNulls(item);
    }
    return out;
  }
  return value;
}

/** 引用到的全部模板编号（不展开模板本身）。 */
export function templateRefs(shape: Shape): Set<string> {
  const refs = new Set<string>();
  const walk = (node: Shape) => {
    if (node.type === 'group') node.children.forEach(walk);
    else if (node.type === 'instance') refs.add(node.template);
  };
  walk(shape);
  return refs;
}

// ---------------------------------------------------------------------------
// 包围盒
// ---------------------------------------------------------------------------

/** f64 的 rem_euclid（与 Rust 相同）。 */
function remEuclid(value: number, modulus: number): number {
  const r = value % modulus;
  return r < 0 ? r + Math.abs(modulus) : r;
}

const RADS_PER_DEG = Math.PI / 180;

/** 角度的正弦和余弦；90° 的整数倍取精确值。 */
export function sinCosDegrees(degrees: number): [number, number] {
  const reduced = remEuclid(degrees, 360);
  if (reduced === 0) return [0, 1];
  if (reduced === 90) return [1, 0];
  if (reduced === 180) return [0, -1];
  if (reduced === 270) return [-1, 0];
  const radians = degrees * RADS_PER_DEG;
  return [Math.sin(radians), Math.cos(radians)];
}

/** `M · p`，其中 `M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S`。 */
export function applyTransform(transform: Transform | undefined, point: Vec3): Vec3 {
  if (transform === undefined) return point;
  const scale = transform.scale ?? [1, 1, 1];
  let x = point[0] * scale[0];
  let y = point[1] * scale[1];
  let z = point[2] * scale[2];
  if (transform.roll !== undefined && transform.roll !== null) {
    const [s, c] = sinCosDegrees(transform.roll);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  if (transform.pitch !== undefined && transform.pitch !== null) {
    const [s, c] = sinCosDegrees(transform.pitch);
    [y, z] = [y * c - z * s, y * s + z * c];
  }
  if (transform.yaw !== undefined && transform.yaw !== null) {
    const [s, c] = sinCosDegrees(transform.yaw);
    [x, z] = [x * c + z * s, -x * s + z * c];
  }
  const position = transform.position ?? [0, 0, 0];
  return [x + position[0], y + position[1], z + position[2]];
}

/** 变换包围盒的 8 个角点，再取包围盒。 */
export function transformAabb(transform: Transform | undefined, aabb: Aabb): Aabb {
  if (transform === undefined) return aabb;
  return aabbFromPoints(aabbCorners(aabb).map((corner) => applyTransform(transform, corner)))!;
}

/**
 * 从 `start` 到 `end`、凸度为 `bulge` 的圆弧上，落在 u、v 轴向极值处的点。
 * 圆心 = 弦中点 + 弦的左法向 × `c(1 − b²) / (4b)`，半径 = `c(1 + b²) / (4|b|)`，
 * 圆心角 = `4·atan(b)`（正值逆时针）。
 */
export function arcExtremes(start: Vec2, end: Vec2, bulge: number): Vec2[] {
  const du = end[0] - start[0];
  const dv = end[1] - start[1];
  const chord = Math.sqrt(du * du + dv * dv);
  if (bulge === 0 || chord === 0) return [];
  const left = [-dv / chord, du / chord];
  const offset = (chord * (1 - bulge * bulge)) / (4 * bulge);
  const center = [
    (start[0] + end[0]) / 2 + left[0]! * offset,
    (start[1] + end[1]) / 2 + left[1]! * offset,
  ];
  const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const sweep = 4 * Math.atan(bulge);
  const begin = Math.atan2(start[1] - center[1]!, start[0] - center[0]!);
  const TAU = 2 * Math.PI;
  const candidates: [number, Vec2][] = [
    [0, [1, 0]],
    [Math.PI / 2, [0, 1]],
    [Math.PI, [-1, 0]],
    [3 * (Math.PI / 2), [0, -1]],
  ];
  return candidates
    .filter(([angle]) => {
      const delta = sweep > 0 ? remEuclid(angle - begin, TAU) : remEuclid(begin - angle, TAU);
      return delta <= Math.abs(sweep);
    })
    .map(([, direction]) => [
      center[0]! + radius * direction[0],
      center[1]! + radius * direction[1],
    ]);
}

/** 轮廓的二维包围盒 `[min, max]`，含圆弧极值点，忽略圆角。 */
export function outlineBounds2d(outline: Outline): [Vec2, Vec2] {
  const min = [outline.points[0]![0], outline.points[0]![1]];
  const max = [outline.points[0]![0], outline.points[0]![1]];
  const include = (p: Vec2) => {
    for (let axis = 0; axis < 2; axis += 1) {
      min[axis] = Math.min(min[axis]!, p[axis]!);
      max[axis] = Math.max(max[axis]!, p[axis]!);
    }
  };
  outline.points.forEach(include);
  const count = outline.points.length;
  for (const arc of outline.arcs ?? []) {
    const start = outline.points[arc.from]!;
    const end = outline.points[(arc.from + 1) % count]!;
    arcExtremes(start, end, arc.bulge).forEach(include);
  }
  return [
    [min[0]!, min[1]!],
    [max[0]!, max[1]!],
  ];
}

/** 截面的外接半径。 */
export function sectionReach(section: SweepSection): number {
  if ('circle' in section) return section.circle;
  const [w, h] = section.rect;
  return Math.sqrt(w * w + h * h) / 2;
}

function lookupTemplate(templates: TemplateTable, id: string): Shape | undefined {
  if (templates instanceof Map) return templates.get(id);
  const table = templates as Readonly<Record<string, Shape>>;
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
}

interface BoundsCache {
  readonly done: Map<string, Aabb>;
  readonly visiting: Set<string>;
}

function localBounds(
  shape: Shape,
  path: string,
  depth: number,
  templates: TemplateTable,
  cache: BoundsCache,
): Aabb {
  switch (shape.type) {
    case 'box':
      return {
        min: [-shape.size[0] / 2, 0, -shape.size[2] / 2],
        max: [shape.size[0] / 2, shape.size[1], shape.size[2] / 2],
      };
    case 'cylinder': {
      const r = Math.max(shape.radius, shape.radiusTop ?? shape.radius);
      return { min: [-r, 0, -r], max: [r, shape.height, r] };
    }
    case 'cone':
      return {
        min: [-shape.radius, 0, -shape.radius],
        max: [shape.radius, shape.height, shape.radius],
      };
    case 'extrude': {
      const [min, max] = outlineBounds2d(shape.outline);
      return { min: [min[0], 0, min[1]], max: [max[0], shape.height, max[1]] };
    }
    case 'lathe': {
      const reach = shape.profile.reduce((m, [r]) => Math.max(m, r), 0);
      const low = shape.profile.reduce((m, [, y]) => Math.min(m, y), Infinity);
      const high = shape.profile.reduce((m, [, y]) => Math.max(m, y), -Infinity);
      return { min: [-reach, low, -reach], max: [reach, high, reach] };
    }
    case 'sweep': {
      const reach = sectionReach(shape.section);
      const aabb = aabbFromPoints(shape.path);
      if (aabb === null) throw new ShapeError(path, '扫掠路径为空');
      return {
        min: [aabb.min[0] - reach, aabb.min[1] - reach, aabb.min[2] - reach],
        max: [aabb.max[0] + reach, aabb.max[1] + reach, aabb.max[2] + reach],
      };
    }
    case 'loft': {
      const first = shape.sections[0];
      const last = shape.sections[shape.sections.length - 1];
      if (first === undefined || last === undefined) throw new ShapeError(path, '放样没有截面');
      const min2 = [Infinity, Infinity];
      const max2 = [-Infinity, -Infinity];
      for (const section of shape.sections) {
        const [min, max] = outlineBounds2d(section.outline);
        for (let axis = 0; axis < 2; axis += 1) {
          min2[axis] = Math.min(min2[axis]!, min[axis]!);
          max2[axis] = Math.max(max2[axis]!, max[axis]!);
        }
      }
      return { min: [min2[0]!, first.y, min2[1]!], max: [max2[0]!, last.y, max2[1]!] };
    }
    case 'group': {
      let result: Aabb | null = null;
      shape.children.forEach((child, index) => {
        const bounds = boundsAt(child, `${path}.children[${index}]`, depth + 1, templates, cache);
        result = result === null ? bounds : aabbUnion(result, bounds);
      });
      if (result === null) throw new ShapeError(path, '组合没有子形状');
      return result;
    }
    case 'instance': {
      const id = shape.template;
      const done = cache.done.get(id);
      if (done !== undefined) return done;
      if (cache.visiting.has(id)) throw new ShapeError(path, `模板 ${id} 循环引用`);
      cache.visiting.add(id);
      const template = lookupTemplate(templates, id);
      if (template === undefined) throw new ShapeError(path, `找不到模板 ${id}`);
      const bounds = boundsAt(template, `${path}<${id}>`, depth + 1, templates, cache);
      cache.visiting.delete(id);
      cache.done.set(id, bounds);
      return bounds;
    }
  }
}

function boundsAt(
  shape: Shape,
  path: string,
  depth: number,
  templates: TemplateTable,
  cache: BoundsCache,
): Aabb {
  if (depth > MAX_SHAPE_DEPTH) throw new ShapeError(path, '形状嵌套超过 16 层');
  return transformAabb(shape.transform, localBounds(shape, path, depth, templates, cache));
}

/** 包围盒（含本形状自己的 `transform`）。模板循环引用、找不到模板或嵌套过深时抛出 ShapeError。 */
export function shapeBounds(shape: Shape, templates: TemplateTable = new Map()): Aabb {
  return boundsAt(shape, '$', 0, templates, { done: new Map(), visiting: new Set() });
}
