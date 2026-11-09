/** 网格生成用的小型向量运算。用可变元组，避免在热路径上创建类实例。 */

export type V2 = [number, number];
export type V3 = [number, number, number];

export const EPS = 1e-9;

export function add3(a: readonly number[], b: readonly number[]): V3 {
  return [(a[0] ?? 0) + (b[0] ?? 0), (a[1] ?? 0) + (b[1] ?? 0), (a[2] ?? 0) + (b[2] ?? 0)];
}

export function sub3(a: readonly number[], b: readonly number[]): V3 {
  return [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)];
}

export function scale3(a: readonly number[], s: number): V3 {
  return [(a[0] ?? 0) * s, (a[1] ?? 0) * s, (a[2] ?? 0) * s];
}

export function dot3(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

export function cross3(a: readonly number[], b: readonly number[]): V3 {
  const [ax = 0, ay = 0, az = 0] = a;
  const [bx = 0, by = 0, bz = 0] = b;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function len3(a: readonly number[]): number {
  return Math.sqrt(dot3(a, a));
}

export function norm3(a: readonly number[], fallback: V3 = [0, 1, 0]): V3 {
  const l = len3(a);
  return l > EPS ? scale3(a, 1 / l) : [...fallback];
}

export function lerp3(a: readonly number[], b: readonly number[], t: number): V3 {
  return add3(scale3(a, 1 - t), scale3(b, t));
}

export function add2(a: readonly number[], b: readonly number[]): V2 {
  return [(a[0] ?? 0) + (b[0] ?? 0), (a[1] ?? 0) + (b[1] ?? 0)];
}

export function sub2(a: readonly number[], b: readonly number[]): V2 {
  return [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0)];
}

export function scale2(a: readonly number[], s: number): V2 {
  return [(a[0] ?? 0) * s, (a[1] ?? 0) * s];
}

export function dot2(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0);
}

/** 二维叉积（z 分量）。 */
export function cross2(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0);
}

export function len2(a: readonly number[]): number {
  return Math.hypot(a[0] ?? 0, a[1] ?? 0);
}

export function norm2(a: readonly number[], fallback: V2 = [1, 0]): V2 {
  const l = len2(a);
  return l > EPS ? scale2(a, 1 / l) : [...fallback];
}

export function dist2(a: readonly number[], b: readonly number[]): number {
  return len2(sub2(a, b));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 有限正数，否则给默认值。 */
export function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 分段数：取整并限制在 [min, max]，防止恶意或笔误的参数生成巨大的网格。 */
export function segmentsOr(
  value: number | undefined,
  fallback: number,
  min = 3,
  max = 128,
): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return clamp(raw, min, max);
}

/** 简单多边形的有符号面积（二维，正值表示按数学意义的逆时针排列）。 */
export function signedArea2(points: readonly (readonly number[])[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] ?? [0, 0];
    const b = points[(i + 1) % points.length] ?? [0, 0];
    area += cross2(a, b);
  }
  return area / 2;
}
