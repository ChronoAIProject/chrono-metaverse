import { Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { MeshBuilder, type MeshData } from './meshData';
import type { HullShape, PlateShape, Vec3 } from './types';
import { cross3, dot3, len3, norm3, scale3, sub3, type V2, type V3 } from './vec';

/**
 * 板（`plate`）和凸包（`hull`）：校验和网格生成（docs/SHAPES.md 第 2 节）。
 *
 * 判定规则与接口服务 `shape.rs`、命令行 `core/shape.ts`、处理服务 `shapes.py` 用同样的公式和
 * 比较顺序，所以三边对同一份数据给出同样的"合法 / 不合法"：
 *
 * - 板：中心是各点平均，Newell 法向 `N = Σ (Pᵢ − c) × (Pᵢ₊₁ − c)`；面积不小于 1 平方毫米，
 *   每点到最佳拟合平面不超过 1 毫米，投影平面上相邻边不折回、不相邻的边不相交；
 * - 凸包：依次找离第 0 点最远的点、离这条直线最远的点、离这个平面最远的点，
 *   三个距离都要超过 1 毫米（否则重合、共线或共面）。
 *
 * 网格：板的正面是给出的多边形，背面沿 −法向 平移厚度，耳切法三角化（保留共线的点），
 * 三角形数 4n − 4；凸包用 three.js 的 ConvexHull（quickhull），每个面平着色，
 * 一般位置下三角形数 2V − 4。
 */

export const MIN_PLATE_POINTS = 3;
export const MAX_PLATE_POINTS = 64;
export const MAX_PLATE_THICKNESS = 1;
export const MIN_PLATE_AREA = 1e-6;
export const MIN_EDGE_LENGTH = 1e-6;
/** 平面度、凸包退化的容差（米）。 */
export const FLAT_TOLERANCE = 0.001;
export const MIN_HULL_POINTS = 4;
export const MAX_HULL_POINTS = 256;
/** 坐标的绝对值上限（米），与形状词表其他字段相同。 */
const MAX_COORD = 100_000;

export interface PlateFrame {
  readonly center: V3;
  readonly normal: V3;
  readonly area: number;
}

/** 板的中心、Newell 单位法向和面积；面积小于 1 平方毫米时返回 null。 */
export function plateFrame(points: readonly Vec3[]): PlateFrame | null {
  if (points.length < MIN_PLATE_POINTS) return null;
  const sum = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k += 1) sum[k]! += p[k]!;
  const count = points.length;
  const center: V3 = [sum[0]! / count, sum[1]! / count, sum[2]! / count];
  const newell = [0, 0, 0];
  points.forEach((p, i) => {
    const c = cross3(sub3(p, center), sub3(points[(i + 1) % count]!, center));
    for (let k = 0; k < 3; k += 1) newell[k]! += c[k]!;
  });
  const length = Math.sqrt(dot3(newell, newell));
  const area = length / 2;
  if (Number.isNaN(area) || area < MIN_PLATE_AREA) return null;
  return { center, normal: [newell[0]! / length, newell[1]! / length, newell[2]! / length], area };
}

/** 去掉法向分量绝对值最大的轴（并列时先去 x、再 y），返回剩下两个轴的下标。 */
export function plateProjectionAxes(normal: readonly number[]): [number, number] {
  const [x, y, z] = [Math.abs(normal[0] ?? 0), Math.abs(normal[1] ?? 0), Math.abs(normal[2] ?? 0)];
  if (x >= y && x >= z) return [1, 2];
  if (y >= z) return [0, 2];
  return [0, 1];
}

function orient2(a: V2, b: V2, c: V2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function within(a: V2, b: V2, p: V2): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/** 两条线段是否相交（含端点接触、共线重叠）。 */
export function segmentsIntersect(p1: V2, p2: V2, p3: V2, p4: V2): boolean {
  const d1 = orient2(p3, p4, p1);
  const d2 = orient2(p3, p4, p2);
  const d3 = orient2(p1, p2, p3);
  const d4 = orient2(p1, p2, p4);
  const straddle = (a: number, b: number) => (a > 0 && b < 0) || (a < 0 && b > 0);
  if (straddle(d1, d2) && straddle(d3, d4)) return true;
  return (
    (d1 === 0 && within(p3, p4, p1)) ||
    (d2 === 0 && within(p3, p4, p2)) ||
    (d3 === 0 && within(p1, p2, p3)) ||
    (d4 === 0 && within(p1, p2, p4))
  );
}

function finitePoints(points: unknown): points is Vec3[] {
  return (
    Array.isArray(points) &&
    points.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 3 &&
        p.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD),
    )
  );
}

/** 板不合法的原因；合法时返回 null。 */
export function plateProblem(shape: PlateShape): string | null {
  const points = shape.points;
  if (!finitePoints(points)) return '点必须是有限的 [x, y, z]';
  if (points.length < MIN_PLATE_POINTS || points.length > MAX_PLATE_POINTS) {
    return '板需要 3 到 64 个点';
  }
  const t = shape.thickness;
  if (!(typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= MAX_PLATE_THICKNESS)) {
    return '厚度必须大于 0 且不超过 1 米';
  }
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const edge = sub3(points[(i + 1) % count]!, points[i]!);
    if (dot3(edge, edge) <= MIN_EDGE_LENGTH * MIN_EDGE_LENGTH) return `第 ${i} 点与下一点重合`;
  }
  const frame = plateFrame(points);
  if (frame === null) return '面积太小（点几乎共线）';
  for (let i = 0; i < count; i += 1) {
    if (Math.abs(dot3(sub3(points[i]!, frame.center), frame.normal)) > FLAT_TOLERANCE) {
      return `第 ${i} 点离最佳拟合平面超过 1 毫米`;
    }
  }
  const [u, v] = plateProjectionAxes(frame.normal);
  const flat: V2[] = points.map((p) => [p[u]!, p[v]!]);
  for (let i = 0; i < count; i += 1) {
    const here = flat[i]!;
    const prev = flat[(i + count - 1) % count]!;
    const next = flat[(i + 1) % count]!;
    const a = [prev[0] - here[0], prev[1] - here[1]] as const;
    const b = [next[0] - here[0], next[1] - here[1]] as const;
    if (a[0] * b[1] - a[1] * b[0] === 0 && a[0] * b[0] + a[1] * b[1] > 0) {
      return `相邻两条边在第 ${i} 点折回`;
    }
  }
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue;
      if (segmentsIntersect(flat[i]!, flat[i + 1]!, flat[j]!, flat[(j + 1) % count]!)) {
        return '多边形自相交';
      }
    }
  }
  return null;
}

/** 凸包退化判定（容差 1 毫米）：点重合、共线或共面时返回说明，否则返回 null。 */
export function hullDegeneracy(points: readonly Vec3[]): string | null {
  const a = points[0];
  if (a === undefined) return '没有点';
  const tolerance = FLAT_TOLERANCE * FLAT_TOLERANCE;
  const farthest = (measure: (p: Vec3) => number): [number, number] => {
    let best: [number, number] = [0, -Infinity];
    points.forEach((p, index) => {
      const value = measure(p);
      if (value > best[1]) best = [index, value];
    });
    return best;
  };
  const [b, spread] = farthest((p) => {
    const d = sub3(p, a);
    return dot3(d, d);
  });
  if (spread <= tolerance) return '点全部重合（容差 1 毫米）';
  const axis = sub3(points[b]!, a);
  const axisSq = dot3(axis, axis);
  const [c, offset] = farthest((p) => {
    const k = cross3(sub3(p, a), axis);
    return dot3(k, k) / axisSq;
  });
  if (offset <= tolerance) return '点全部共线（容差 1 毫米）';
  const normal = cross3(axis, sub3(points[c]!, a));
  const normalSq = dot3(normal, normal);
  const [, height] = farthest((p) => {
    const h = dot3(sub3(p, a), normal);
    return (h * h) / normalSq;
  });
  if (height <= tolerance) return '点全部共面（容差 1 毫米）';
  return null;
}

/** 凸包不合法的原因；合法时返回 null。 */
export function hullProblem(shape: HullShape): string | null {
  const points = shape.points;
  if (!finitePoints(points)) return '点必须是有限的 [x, y, z]';
  if (points.length < MIN_HULL_POINTS || points.length > MAX_HULL_POINTS) {
    return '凸包需要 4 到 256 个点';
  }
  return hullDegeneracy(points);
}

function cross2(a: V2, b: V2): number {
  return a[0] * b[1] - a[1] * b[0];
}

/**
 * 简单多边形的耳切法三角化，返回 n − 2 个三角形（顶点下标）。与处理服务
 * `shape_mesh.triangulate` 相同：共线的点保留（不像 earcut 那样删掉），所以三角形数固定。
 * 只有凸顶点能当耳尖；耳朵里不能有凹点（共线的点也算凹点）。万一找不到耳朵就退回扇形。
 */
export function earClip(points: readonly V2[]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i += 1) area += cross2(points[i]!, points[(i + 1) % n]!);
  const order = [...Array(n).keys()];
  if (area < 0) order.reverse();
  const out: [number, number, number][] = [];
  const inside = (p: V2, a: V2, b: V2, c: V2) =>
    cross2([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]) >= -1e-12 &&
    cross2([c[0] - b[0], c[1] - b[1]], [p[0] - b[0], p[1] - b[1]]) >= -1e-12 &&
    cross2([a[0] - c[0], a[1] - c[1]], [p[0] - c[0], p[1] - c[1]]) >= -1e-12;
  const reflexSet = () => {
    const m = order.length;
    const set = new Set<number>();
    for (let k = 0; k < m; k += 1) {
      const a = points[order[(k - 1 + m) % m]!]!;
      const b = points[order[k]!]!;
      const c = points[order[(k + 1) % m]!]!;
      if (cross2([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]) <= 1e-14) {
        set.add(order[k]!);
      }
    }
    return set;
  };
  const same = (p: V2, q: V2) => p[0] === q[0] && p[1] === q[1];
  let guard = 0;
  while (order.length > 3 && guard < 4 * n * n) {
    guard += 1;
    const m = order.length;
    const reflex = reflexSet();
    let clipped = false;
    for (let k = 0; k < m; k += 1) {
      const i0 = order[(k - 1 + m) % m]!;
      const i1 = order[k]!;
      const i2 = order[(k + 1) % m]!;
      if (reflex.has(i1)) continue;
      const [a, b, c] = [points[i0]!, points[i1]!, points[i2]!];
      let blocked = false;
      for (const j of reflex) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = points[j]!;
        if (same(p, a) || same(p, b) || same(p, c)) continue;
        if (inside(p, a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push([i0, i1, i2]);
      order.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // 退化（共线、自相交）时退回扇形，保证有封口。
      for (let k = 1; k < order.length - 1; k += 1) {
        out.push([order[0]!, order[k]!, order[k + 1]!]);
      }
      return out;
    }
  }
  if (order.length === 3) out.push([order[0]!, order[1]!, order[2]!]);
  return out;
}

/**
 * 板的网格（局部坐标）。正面法向 n、背面 −n，每条边一个平的侧面；三角形数 4n − 4。
 * 自然贴图坐标（米）：正面和背面用面内坐标（u 沿第 0 点到第 1 点、v = n × u），
 * 侧面 u 是沿轮廓累计的边长、v 从背面 0 到正面 thickness。不合法时返回空网格。
 */
export function plateMesh(shape: PlateShape): MeshData {
  const builder = new MeshBuilder();
  if (plateProblem(shape) !== null) return builder.build();
  const points = shape.points;
  const frame = plateFrame(points)!;
  const n = frame.normal;
  const t = shape.thickness;
  const count = points.length;
  const back = points.map((p) => sub3(p, scale3(n, t)));
  const first = sub3(points[1]!, points[0]!);
  const u = norm3(sub3(first, scale3(n, dot3(first, n))));
  const v = cross3(n, u);
  const planeUv = (p: readonly number[], origin: readonly number[]) => {
    const d = sub3(p, origin);
    return [dot3(d, u), dot3(d, v)];
  };
  const [ia, ib] = plateProjectionAxes(n);
  const triangles = earClip(points.map((p): V2 => [p[ia]!, p[ib]!]));
  const minus = scale3(n, -1);
  const top = points.map((p) => builder.vertex(p, n, planeUv(p, points[0]!)));
  const bottom = back.map((p) => builder.vertex(p, minus, planeUv(p, back[0]!)));
  for (const [a, b, c] of triangles) {
    builder.orientedTri(top[a]!, top[b]!, top[c]!);
    builder.orientedTri(bottom[a]!, bottom[b]!, bottom[c]!);
  }
  let along = 0;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    const edge = sub3(points[j]!, points[i]!);
    const out = norm3(cross3(edge, n));
    const step = len3(edge);
    const ids = [
      builder.vertex(points[i]!, out, [along, t]),
      builder.vertex(points[j]!, out, [along + step, t]),
      builder.vertex(back[j]!, out, [along + step, 0]),
      builder.vertex(back[i]!, out, [along, 0]),
    ];
    builder.orientedQuad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
    along += step;
  }
  return builder.build();
}

/** 按面法向的主轴投影的自然贴图坐标（米），轴的选法与 `uv: "box"` 相同。 */
function faceUv(p: readonly number[], normal: readonly number[]): number[] {
  const [x, y, z] = [Math.abs(normal[0]!), Math.abs(normal[1]!), Math.abs(normal[2]!)];
  if (x >= y && x >= z) return [p[2]!, p[1]!];
  if (y >= z) return [p[0]!, p[2]!];
  return [p[0]!, p[1]!];
}

/**
 * 凸包的网格（局部坐标）：每个面平着色，三角形朝外（按全部点的平均判断朝向，凸包里它一定在内部）。
 * 不合法时返回空网格。
 */
export function hullMesh(shape: HullShape): MeshData {
  const builder = new MeshBuilder();
  if (hullProblem(shape) !== null) return builder.build();
  const hull = new ConvexHull().setFromPoints(
    shape.points.map((p) => new Vector3(p[0], p[1], p[2])),
  );
  const center = [0, 0, 0];
  for (const p of shape.points)
    for (let k = 0; k < 3; k += 1) center[k]! += p[k]! / shape.points.length;
  for (const face of hull.faces) {
    const e = face.edge;
    const [a, b, c] = [e.tail()!.point, e.head().point, e.next.head().point].map((q): V3 => [
      q.x,
      q.y,
      q.z,
    ]) as [V3, V3, V3];
    const forward = cross3(sub3(b, a), sub3(c, a));
    const outward = dot3(forward, sub3(a, center)) >= 0;
    const unit = norm3(outward ? forward : scale3(forward, -1));
    const corners = outward ? [a, b, c] : [a, c, b];
    const ids = corners.map((p) => builder.vertex(p, unit, faceUv(p, unit)));
    builder.tri(ids[0]!, ids[1]!, ids[2]!);
  }
  return builder.build();
}
