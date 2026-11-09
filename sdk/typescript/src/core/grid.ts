/**
 * 全局定位网格（设计第 2 节、SHAPES 1；Rust `grid.rs` 的移植）。
 *
 * 网格只用于定位、区域和地块边界、锚点吸附、占用索引；形状的尺寸和位置都是连续值，
 * 不吸附到网格。盒子写成 `[x0, y0, z0, x1, y1, z1]`，单位是格，半开区间：包含
 * `x0 ≤ x < x1` 的格子。
 */

/** 网格单位，米。全系统统一，上线后不可改。 */
export const GRID_UNIT = 0.05;

/** 盒子坐标的绝对值上限（格）。 */
export const MAX_GRID_COORD = 2 ** 30;

/** 米换算成格时，离整数这么近就当作整数（避免 0.15 / 0.05 = 2.9999999999999996）。 */
const SNAP_EPSILON = 1e-6;

export type Vec3 = readonly [number, number, number];

/** 轴对齐的格子盒子 `[x0, y0, z0, x1, y1, z1]`，半开区间。 */
export type GridBox = readonly [number, number, number, number, number, number];

/** 米坐标下的轴对齐包围盒（闭区间）。 */
export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

export class GridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridError';
  }
}

export const GRID_ERROR_EMPTY = '盒子的每一维都必须满足 min < max';
export const GRID_ERROR_RANGE = '盒子坐标超出范围（绝对值不超过 2^30 格）';

/** 与 Rust `f64::round` 相同：.5 远离 0 取整（`Math.round` 对负数是向上取整）。 */
export function roundHalfAway(value: number): number {
  // `+ 0` 把 -0 变成 0。
  return Math.sign(value) * Math.round(Math.abs(value)) + 0;
}

/** 米 → 格（连续值）。 */
export function metresToGrid(metres: number): number {
  return metres / GRID_UNIT;
}

/** 格 → 米。 */
export function gridToMetres(cells: number): number {
  return cells * GRID_UNIT;
}

function snapped(value: number): number | null {
  const rounded = roundHalfAway(value);
  return Math.abs(value - rounded) < SNAP_EPSILON ? rounded : null;
}

/** 不大于该位置的格坐标（接近整数时先吸附）。 */
export function floorToGrid(metres: number): number {
  const cells = metresToGrid(metres);
  return snapped(cells) ?? Math.floor(cells);
}

/** 不小于该位置的格坐标（接近整数时先吸附）。 */
export function ceilToGrid(metres: number): number {
  const cells = metresToGrid(metres);
  return snapped(cells) ?? Math.ceil(cells);
}

/** 最近的格坐标（锚点吸附用）。 */
export function roundToGrid(metres: number): number {
  return roundHalfAway(metresToGrid(metres));
}

function isGridInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 校验盒子；失败时返回错误说明，成功返回 null。 */
export function gridBoxError(box: readonly number[]): string | null {
  if (box.length !== 6 || !box.every(isGridInt)) return '盒子必须是 6 个整数';
  if (box.some((v) => Math.abs(v) > MAX_GRID_COORD)) return GRID_ERROR_RANGE;
  for (let axis = 0; axis < 3; axis += 1) {
    if (box[axis]! >= box[axis + 3]!) return GRID_ERROR_EMPTY;
  }
  return null;
}

/** 校验并返回盒子；不合法时抛出 GridError。 */
export function gridBox(value: readonly number[]): GridBox {
  const error = gridBoxError(value);
  if (error !== null) throw new GridError(error);
  return [value[0]!, value[1]!, value[2]!, value[3]!, value[4]!, value[5]!];
}

export function boxMin(box: GridBox): Vec3 {
  return [box[0], box[1], box[2]];
}

export function boxMax(box: GridBox): Vec3 {
  return [box[3], box[4], box[5]];
}

/** 格子数。 */
export function boxVolume(box: GridBox): number {
  let volume = 1;
  for (let axis = 0; axis < 3; axis += 1) volume *= Math.max(0, box[axis + 3]! - box[axis]!);
  return volume;
}

export function boxSize(box: GridBox): Vec3 {
  return [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
}

export function boxContainsCell(box: GridBox, cell: Vec3): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (cell[axis]! < box[axis]! || cell[axis]! >= box[axis + 3]!) return false;
  }
  return true;
}

export function boxContainsBox(outer: GridBox, inner: GridBox): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (outer[axis]! > inner[axis]! || inner[axis + 3]! > outer[axis + 3]!) return false;
  }
  return true;
}

/** 是否有共同的格子（只碰到边界不算）。 */
export function boxesIntersect(a: GridBox, b: GridBox): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!(a[axis]! < b[axis + 3]! && b[axis]! < a[axis + 3]!)) return false;
  }
  return true;
}

export function boxIntersection(a: GridBox, b: GridBox): GridBox | null {
  if (!boxesIntersect(a, b)) return null;
  return [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.min(a[3], b[3]),
    Math.min(a[4], b[4]),
    Math.min(a[5], b[5]),
  ];
}

/** 同时包住两个盒子的最小盒子。 */
export function boxUnion(a: GridBox, b: GridBox): GridBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.max(a[3], b[3]),
    Math.max(a[4], b[4]),
    Math.max(a[5], b[5]),
  ];
}

/** 平移；结果超出范围时抛出 GridError。 */
export function boxTranslated(box: GridBox, offset: Vec3): GridBox {
  return gridBox([
    box[0] + offset[0],
    box[1] + offset[1],
    box[2] + offset[2],
    box[3] + offset[0],
    box[4] + offset[1],
    box[5] + offset[2],
  ]);
}

/** `box` 减去 `cut` 后剩下的部分，拆成最多 6 个互不重叠的盒子（顺序与 Rust 相同）。 */
export function boxSubtract(box: GridBox, other: GridBox): GridBox[] {
  const cut = boxIntersection(box, other);
  if (cut === null) return [box];
  const pieces: GridBox[] = [];
  const rest = [...box];
  for (let axis = 0; axis < 3; axis += 1) {
    if (rest[axis]! < cut[axis]!) {
      const piece = [...rest];
      piece[axis + 3] = cut[axis]!;
      pieces.push(piece as unknown as GridBox);
      rest[axis] = cut[axis]!;
    }
    if (cut[axis + 3]! < rest[axis + 3]!) {
      const piece = [...rest];
      piece[axis] = cut[axis + 3]!;
      pieces.push(piece as unknown as GridBox);
      rest[axis + 3] = cut[axis + 3]!;
    }
  }
  return pieces;
}

/** `target` 是否完全落在 `cover` 这组盒子的并集里（精确判断）。 */
export function coveredBy(target: GridBox, cover: readonly GridBox[]): boolean {
  let remaining: GridBox[] = [target];
  for (const piece of cover) {
    remaining = remaining.flatMap((part) => boxSubtract(part, piece));
    if (remaining.length === 0) return true;
    // 碎片数有上限：超过就保守地判为不在范围内。
    if (remaining.length > 4096) return false;
  }
  return remaining.length === 0;
}

/** 两组盒子是否有重叠。 */
export function anyOverlap(left: readonly GridBox[], right: readonly GridBox[]): boolean {
  return left.some((a) => right.some((b) => boxesIntersect(a, b)));
}

/** 盒子在米坐标下占的范围。 */
export function boxToMetres(box: GridBox): Aabb {
  return {
    min: [gridToMetres(box[0]), gridToMetres(box[1]), gridToMetres(box[2])],
    max: [gridToMetres(box[3]), gridToMetres(box[4]), gridToMetres(box[5])],
  };
}

// ---------------------------------------------------------------------------
// 米坐标包围盒
// ---------------------------------------------------------------------------

export function aabbFromPoints(points: Iterable<Vec3>): Aabb | null {
  let min: [number, number, number] | null = null;
  let max: [number, number, number] = [0, 0, 0];
  for (const point of points) {
    if (min === null) {
      min = [point[0], point[1], point[2]];
      max = [point[0], point[1], point[2]];
      continue;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  return min === null ? null : { min, max };
}

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function aabbIsValid(aabb: Aabb): boolean {
  const values = [...aabb.min, ...aabb.max];
  if (values.length !== 6 || !values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return false;
  }
  return [0, 1, 2].every((axis) => aabb.min[axis]! <= aabb.max[axis]!);
}

/** 是否包住另一个包围盒（允许 `tolerance` 米的误差）。 */
export function aabbContains(outer: Aabb, inner: Aabb, tolerance: number): boolean {
  return [0, 1, 2].every(
    (axis) =>
      outer.min[axis]! - tolerance <= inner.min[axis]! &&
      inner.max[axis]! <= outer.max[axis]! + tolerance,
  );
}

export function aabbCorners(aabb: Aabb): Vec3[] {
  const [a, b] = [aabb.min, aabb.max];
  return [
    [a[0], a[1], a[2]],
    [b[0], a[1], a[2]],
    [a[0], b[1], a[2]],
    [b[0], b[1], a[2]],
    [a[0], a[1], b[2]],
    [b[0], a[1], b[2]],
    [a[0], b[1], b[2]],
    [b[0], b[1], b[2]],
  ];
}

/**
 * 覆盖这个包围盒的格子盒子：min 向下取整、max 向上取整；某一维厚度为 0 时（平面、点），
 * 按占一格处理。不合法时抛出 GridError（说明与 Rust 相同）。
 */
export function aabbGridCover(aabb: Aabb): GridBox {
  if (!aabbIsValid(aabb)) throw new GridError(GRID_ERROR_EMPTY);
  const min: number[] = [];
  const max: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const low = metresToGrid(aabb.min[axis]!);
    const high = metresToGrid(aabb.max[axis]!);
    if (!(Math.abs(low) <= MAX_GRID_COORD && Math.abs(high) <= MAX_GRID_COORD)) {
      throw new GridError(GRID_ERROR_RANGE);
    }
    min[axis] = floorToGrid(aabb.min[axis]!);
    max[axis] = Math.max(ceilToGrid(aabb.max[axis]!), min[axis]! + 1);
  }
  return gridBox([...min, ...max]);
}

/** 米坐标的盒子换成覆盖它的格子盒子（`[x0,y0,z0,x1,y1,z1]`，米）。 */
export function metresBoxToGrid(box: readonly number[]): GridBox {
  return aabbGridCover({
    min: [box[0]!, box[1]!, box[2]!],
    max: [box[3]!, box[4]!, box[5]!],
  });
}
