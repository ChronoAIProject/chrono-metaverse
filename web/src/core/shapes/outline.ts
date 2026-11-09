import type { Outline } from './types';
import {
  EPS,
  add2,
  clamp,
  cross2,
  dist2,
  dot2,
  len2,
  norm2,
  scale2,
  signedArea2,
  sub2,
  type V2,
} from './vec';

/**
 * 二维轮廓展开：把圆弧（bulge）和圆角换成折线点。
 *
 * 结果里的每个点都标了"硬"或"软"：转角超过 `HARD_ANGLE_DEG` 的点是硬边，
 * 生成侧面时在这里拆开法线；圆弧和圆角内部的点都是软的，侧面法线平滑过渡。
 */

/** 超过这个转角（度）就当作硬边。圆弧采样步长远小于它。 */
export const HARD_ANGLE_DEG = 30;
/** 圆弧采样的最大步长（弧度），即 11.25°。 */
const ARC_STEP = Math.PI / 16;

export interface Polyline2 {
  readonly points: V2[];
  readonly hard: boolean[];
  readonly closed: boolean;
}

/** 按转角重新标记硬点。闭合折线的首尾也按转角判断；开放折线的端点总是硬的。 */
export function markHard(points: readonly V2[], closed: boolean): boolean[] {
  const threshold = Math.cos((HARD_ANGLE_DEG * Math.PI) / 180);
  return points.map((point, i) => {
    if (!closed && (i === 0 || i === points.length - 1)) return true;
    const prev = points[(i - 1 + points.length) % points.length]!;
    const next = points[(i + 1) % points.length]!;
    const d1 = sub2(point, prev);
    const d2 = sub2(next, point);
    if (len2(d1) < EPS || len2(d2) < EPS) return false;
    return dot2(norm2(d1), norm2(d2)) < threshold;
  });
}

/** 去掉相邻重复点；闭合轮廓去掉与首点重合的末点。 */
export function dedupe(points: readonly (readonly number[])[], closed: boolean): V2[] {
  const out: V2[] = [];
  for (const p of points) {
    const point: V2 = [Number(p[0] ?? 0), Number(p[1] ?? 0)];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const last = out[out.length - 1];
    if (last === undefined || dist2(last, point) > 1e-9) out.push(point);
  }
  if (closed && out.length > 2 && dist2(out[0]!, out[out.length - 1]!) <= 1e-9) out.pop();
  return out;
}

/**
 * 弦 p0→p1 上 bulge 对应的圆弧采样点（不含两个端点）。
 * `outwardSign` 是轮廓方向：+1 表示逆时针（外侧在前进方向右边），-1 表示顺时针。
 * bulge 为正时向外凸。
 */
export function arcPoints(p0: V2, p1: V2, bulge: number, outwardSign: number): V2[] {
  const chord = sub2(p1, p0);
  const length = len2(chord);
  if (length < EPS || !Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return [];
  // 圆心角超过 360° 没有意义；bulge 限制在 tan(89.9°) 以内。
  const b = clamp(bulge, -1e3, 1e3);
  const half = length / 2;
  const sagitta = b * half;
  const outward: V2 = scale2([chord[1], -chord[0]], outwardSign / length);
  const mid = scale2(add2(p0, p1), 0.5);
  const radius = (half * half + sagitta * sagitta) / (2 * Math.abs(sagitta));
  const towardArc = scale2(outward, Math.sign(sagitta));
  const center = add2(mid, scale2(towardArc, Math.abs(sagitta) - radius));
  const arcMid = add2(mid, scale2(towardArc, Math.abs(sagitta)));
  const theta = 4 * Math.atan(Math.abs(b));
  const start = Math.atan2(p0[1] - center[1], p0[0] - center[0]);
  const direction = cross2(sub2(p0, center), sub2(arcMid, center)) >= 0 ? 1 : -1;
  // 步数取偶数，弧的顶点（弓高处）一定被采到，包围盒是精确的。
  const steps = Math.max(2, 2 * Math.ceil(theta / (2 * ARC_STEP)));
  const out: V2[] = [];
  for (let k = 1; k < steps; k += 1) {
    const angle = start + direction * theta * (k / steps);
    out.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return out;
}

/**
 * 在拐点 corner 处倒圆角，返回从切点 T1 到切点 T2 的圆弧点（含两个切点）。
 * `maxTangent` 是允许的切线长度上限，圆角半径会被相应缩小。
 */
export function filletPoints(
  prev: V2,
  corner: V2,
  next: V2,
  radius: number,
  maxTangent: number,
): V2[] {
  const d1 = norm2(sub2(corner, prev));
  const d2 = norm2(sub2(next, corner));
  const turn = Math.acos(clamp(dot2(d1, d2), -1, 1));
  if (!(radius > 0) || turn < 1e-6 || Math.PI - turn < 1e-6) return [corner];
  const halfTan = Math.tan(turn / 2);
  const tangent = Math.min(radius * halfTan, Math.max(0, maxTangent));
  if (tangent < 1e-9) return [corner];
  const r = tangent / halfTan;
  const t1 = sub2(corner, scale2(d1, tangent));
  const t2 = add2(corner, scale2(d2, tangent));
  const side = cross2(d1, d2) > 0 ? 1 : -1;
  const inward: V2 = side > 0 ? [-d1[1], d1[0]] : [d1[1], -d1[0]];
  const center = add2(t1, scale2(inward, r));
  const start = Math.atan2(t1[1] - center[1], t1[0] - center[0]);
  const steps = Math.max(2, Math.ceil(turn / ARC_STEP));
  const out: V2[] = [t1];
  for (let k = 1; k < steps; k += 1) {
    const angle = start + side * turn * (k / steps);
    out.push([center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)]);
  }
  out.push(t2);
  return out;
}

/**
 * 第 i 个点倒圆角后的点（没有圆角时就是这个点本身）。`radii[i]` 是第 i 个点的圆角半径。
 * 一条边两端都倒圆角时各用一半边长，只有一端倒时可以用满整条边。
 * 开放折线的端点不倒圆角。
 */
function cornerPoints(
  points: readonly V2[],
  radii: readonly number[],
  i: number,
  closed: boolean,
): V2[] {
  const n = points.length;
  const has = (k: number) => (radii[k] ?? 0) > 0 && (closed || (k > 0 && k < n - 1));
  const point = points[i]!;
  if (!has(i)) return [point];
  const iPrev = (i - 1 + n) % n;
  const iNext = (i + 1) % n;
  const prev = points[iPrev]!;
  const next = points[iNext]!;
  const prevShare = has(iPrev) ? 0.5 : 1;
  const nextShare = has(iNext) ? 0.5 : 1;
  const maxTangent = Math.min(dist2(prev, point) * prevShare, dist2(point, next) * nextShare);
  return filletPoints(prev, point, next, radii[i] ?? 0, maxTangent);
}

/** 给一串点倒圆角（用于圆柱的轮廓）。 */
export function filletPolyline(
  points: readonly V2[],
  radii: readonly number[],
  closed: boolean,
): V2[] {
  return dedupe(
    points.flatMap((_, i) => cornerPoints(points, radii, i, closed)),
    closed,
  );
}

/** 把形状词表里的二维轮廓展开成折线。 */
export function expandOutline(outline: Outline, forceClosed?: boolean): Polyline2 {
  const closed = forceClosed ?? outline.closed !== false;
  const base = dedupe(outline.points ?? [], closed);
  if (base.length < 2) return { points: base, hard: base.map(() => true), closed };
  const n = base.length;
  const orientation = closed && signedArea2(base) < 0 ? -1 : 1;
  const segmentCount = closed ? n : n - 1;

  const bulges = new Map<number, number>();
  for (const arc of outline.arcs ?? []) {
    if (Number.isInteger(arc.from) && arc.from >= 0 && arc.from < segmentCount) {
      bulges.set(arc.from, Number(arc.bulge));
    }
  }
  // 圆角只作用在两侧都是直线的顶点上；挨着圆弧的顶点忽略圆角。
  const radii = new Array<number>(n).fill(0);
  for (const fillet of outline.fillets ?? []) {
    const at = fillet.at;
    if (!Number.isInteger(at) || at < 0 || at >= n) continue;
    const before = (at - 1 + n) % n;
    if (bulges.has(at) || (closed || at > 0 ? bulges.has(before) : false)) continue;
    const radius = Number(fillet.radius);
    if (Number.isFinite(radius) && radius > 0) radii[at] = radius;
  }

  const out: V2[] = [];
  for (let i = 0; i < n; i += 1) {
    const point = base[i]!;
    out.push(...cornerPoints(base, radii, i, closed));
    const bulge = bulges.get(i);
    if (bulge !== undefined && (closed || i < n - 1)) {
      out.push(...arcPoints(point, base[(i + 1) % n]!, bulge, orientation));
    }
  }
  const points = dedupe(out, closed);
  return { points, hard: markHard(points, closed), closed };
}

/** 折线的二维包围盒。 */
export function bounds2(points: readonly V2[]): { min: V2; max: V2 } {
  const min: V2 = [Infinity, Infinity];
  const max: V2 = [-Infinity, -Infinity];
  for (const [x, y] of points) {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
  }
  return { min, max };
}

/** 闭合折线每条边的外法线（单位向量）。 */
export function edgeNormals(points: readonly V2[], closed: boolean): V2[] {
  const orientation = closed && signedArea2(points) < 0 ? -1 : 1;
  const count = closed ? points.length : points.length - 1;
  const normals: V2[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const d = norm2(sub2(b, a));
    normals.push([d[1] * orientation, -d[0] * orientation]);
  }
  return normals;
}

/**
 * 闭合折线向内偏移 `delta`：每个点沿两侧边法线的斜接方向移动，
 * 移动量是 delta / cos(半角)，保证偏移后的边与原边平行且相距 delta。
 */
export function offsetInward(points: readonly V2[], delta: number): V2[] {
  if (delta === 0) return points.map((p) => [p[0], p[1]] as V2);
  const normals = edgeNormals(points, true);
  const n = points.length;
  return points.map((point, i) => {
    const before = normals[(i - 1 + n) % n]!;
    const after = normals[i]!;
    const sum = add2(before, after);
    const denom = 1 + dot2(before, after);
    // 接近 180° 的回折角不做斜接，避免尖刺。
    const miter: V2 = denom > 0.05 ? scale2(sum, 1 / denom) : after;
    return sub2(point, scale2(miter, delta));
  });
}
