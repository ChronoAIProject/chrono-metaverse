import { MeshBuilder, dropDegenerate, type MeshData } from './meshData';
import type { SweepShape } from './types';
import {
  EPS,
  add3,
  clamp,
  cross3,
  dot3,
  len3,
  norm3,
  positiveOr,
  scale3,
  segmentsOr,
  sub3,
  type V2,
  type V3,
} from './vec';

/** 超过这个转角（度）的路径拐点当作硬边，拆开法线。 */
const HARD_TURN_DEG = 30;
const ARC_STEP = Math.PI / 16;

/** 截面上的一个点：偏移 (a, b) 和该点的截面内法线 (na, nb)。a 沿副法线，b 沿主法线。 */
interface SectionPoint {
  readonly offset: V2;
  readonly normal: V2;
  /** 截面上的周向参数 0–1，作为 u。 */
  readonly u: number;
  /** u 的米版本：沿截面边界从起点量的长度（圆：角度 × 半径；矩形：从 (w/2, −h/2) 起依次量四条边）。 */
  readonly meters: number;
}

function sectionPoints(shape: SweepShape): SectionPoint[] {
  const section = shape.section ?? { circle: 0.02 };
  if ('rect' in section) {
    const w = positiveOr(section.rect?.[0], 0.02) / 2;
    const h = positiveOr(section.rect?.[1], 0.02) / 2;
    // 四条边各自一对点：边之间是硬边。
    const sides: [V2, V2, V2][] = [
      [
        [w, -h],
        [w, h],
        [1, 0],
      ],
      [
        [w, h],
        [-w, h],
        [0, 1],
      ],
      [
        [-w, h],
        [-w, -h],
        [-1, 0],
      ],
      [
        [-w, -h],
        [w, -h],
        [0, -1],
      ],
    ];
    const along = [0, 2 * h, 2 * h + 2 * w, 4 * h + 2 * w, 4 * h + 4 * w];
    return sides.flatMap(([a, b, n], i) => [
      { offset: a, normal: n, u: i / 4, meters: along[i]! },
      { offset: b, normal: n, u: (i + 1) / 4, meters: along[i + 1]! },
    ]);
  }
  const radius = positiveOr('circle' in section ? section.circle : undefined, 0.02);
  const segments = segmentsOr(shape.segments, 16, 3, 64);
  const points: SectionPoint[] = [];
  for (let k = 0; k <= segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    points.push({
      offset: [radius * c, radius * s],
      normal: [c, s],
      u: k / segments,
      meters: angle * radius,
    });
  }
  return points;
}

/** 截面的边：成对的截面点下标。矩形是四条独立的边，圆是连续的一圈。 */
function sectionEdges(shape: SweepShape, count: number): [number, number][] {
  const edges: [number, number][] = [];
  const isRect = 'rect' in (shape.section ?? {});
  if (isRect) for (let i = 0; i < count; i += 2) edges.push([i, i + 1]);
  else for (let i = 0; i < count - 1; i += 1) edges.push([i, i + 1]);
  return edges;
}

/** 罗德里格斯公式：v 绕单位轴 axis 转 angle。 */
function rotate(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add3(
    add3(scale3(v, c), scale3(cross3(axis, v), s)),
    scale3(axis, dot3(axis, v) * (1 - c)),
  );
}

/**
 * 路径拐角圆滑：在每个内部拐点放一段半径为 `radius` 的圆弧，与两侧线段相切。
 * 切线长度不超过相邻线段的一半，半径会相应缩小。
 */
export function smoothPath(path: readonly V3[], radius: number): V3[] {
  if (!(radius > 0) || path.length < 3) return [...path];
  const out: V3[] = [path[0]!];
  for (let i = 1; i < path.length - 1; i += 1) {
    const prev = path[i - 1]!;
    const corner = path[i]!;
    const next = path[i + 1]!;
    const d1 = norm3(sub3(corner, prev));
    const d2 = norm3(sub3(next, corner));
    const turn = Math.acos(clamp(dot3(d1, d2), -1, 1));
    if (turn < 1e-6 || Math.PI - turn < 1e-6) {
      out.push(corner);
      continue;
    }
    const halfTan = Math.tan(turn / 2);
    const maxTangent = Math.min(len3(sub3(corner, prev)), len3(sub3(next, corner))) / 2;
    const tangent = Math.min(radius * halfTan, maxTangent);
    const r = tangent / halfTan;
    const t1 = sub3(corner, scale3(d1, tangent));
    const inward = norm3(sub3(d2, scale3(d1, dot3(d1, d2))));
    const center = add3(t1, scale3(inward, r));
    const u = sub3(t1, center);
    const w = scale3(d1, r);
    const steps = Math.max(2, Math.ceil(turn / ARC_STEP));
    for (let k = 0; k <= steps; k += 1) {
      const a = (k / steps) * turn;
      out.push(add3(center, add3(scale3(u, Math.cos(a)), scale3(w, Math.sin(a)))));
    }
  }
  out.push(path[path.length - 1]!);
  return out;
}

function dedupePath(path: readonly (readonly number[])[]): V3[] {
  const out: V3[] = [];
  for (const p of path) {
    const point: V3 = [Number(p[0] ?? 0), Number(p[1] ?? 0), Number(p[2] ?? 0)];
    if (!point.every(Number.isFinite)) continue;
    const last = out[out.length - 1];
    if (last === undefined || len3(sub3(point, last)) > 1e-9) out.push(point);
  }
  return out;
}

/** 起始主法线：路径不竖直时取世界上方向（矩形截面的高沿竖直方向），竖直时取 +z。 */
function initialNormal(tangent: V3): V3 {
  const reference: V3 = Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  return norm3(sub3(reference, scale3(tangent, dot3(reference, tangent))));
}

/**
 * 扫掠：截面（圆或矩形）沿路径移动。
 *
 * - 路径先按 `smooth` 圆滑拐角；
 * - 截面方向用平行移动（每一步做把前一段切线转到后一段切线的最小旋转），不会无故扭转；
 * - 拐点处截面落在两段的角平分面上（斜接），沿弯折方向放大 1/cos(半角)，保证管壁厚度不变；
 * - 转角超过 30° 的拐点拆开法线（硬边），其余平滑；
 * - `caps` 默认封口。
 * 自然 UV：u 沿截面一周 0–1，v 沿路径长度 0–1。
 */
export function sweepMesh(shape: SweepShape): MeshData {
  const raw = dedupePath(shape.path ?? []);
  const path = smoothPath(raw, positiveOr(shape.smooth, 0));
  if (path.length < 2) return new MeshBuilder().build();
  const section = sectionPoints(shape);
  const edges = sectionEdges(shape, section.length);

  const tangents: V3[] = [];
  for (let i = 0; i < path.length - 1; i += 1) tangents.push(norm3(sub3(path[i + 1]!, path[i]!)));
  const lengths = [0];
  for (let i = 1; i < path.length; i += 1) {
    lengths.push(lengths[i - 1]! + len3(sub3(path[i]!, path[i - 1]!)));
  }
  const total = Math.max(lengths[lengths.length - 1]!, EPS);

  // 每段的主法线：平行移动。
  const segmentNormals: V3[] = [initialNormal(tangents[0]!)];
  for (let i = 1; i < tangents.length; i += 1) {
    const before = tangents[i - 1]!;
    const after = tangents[i]!;
    const axis = cross3(before, after);
    const sin = len3(axis);
    const previous = segmentNormals[i - 1]!;
    const moved =
      sin > 1e-9
        ? rotate(previous, scale3(axis, 1 / sin), Math.atan2(sin, dot3(before, after)))
        : previous;
    segmentNormals.push(norm3(sub3(moved, scale3(after, dot3(moved, after)))));
  }

  const hardCos = Math.cos((HARD_TURN_DEG * Math.PI) / 180);
  const builder = new MeshBuilder();

  /** 第 i 个路径点的截面圈：位置（斜接）和对第 segment 段使用的法线。 */
  const ring = (i: number, segment: number): number[] => {
    const tIn = tangents[Math.max(0, i - 1)]!;
    const tOut = tangents[Math.min(tangents.length - 1, i)]!;
    const interior = i > 0 && i < path.length - 1;
    const tAvg = interior ? norm3(add3(tIn, tOut), tOut) : i === 0 ? tOut : tIn;
    const hard = interior && dot3(tIn, tOut) < hardCos;
    // 拐点处的截面方向：把前一段的主法线转半个拐角，正好落在角平分面上。
    let nRef = segmentNormals[Math.min(i, segmentNormals.length - 1)]!;
    if (interior) {
      const axis = cross3(tIn, tOut);
      const sin = len3(axis);
      nRef = segmentNormals[i - 1]!;
      if (sin > 1e-9)
        nRef = rotate(nRef, scale3(axis, 1 / sin), Math.atan2(sin, dot3(tIn, tOut)) / 2);
    }
    const nAxis = norm3(sub3(nRef, scale3(tAvg, dot3(nRef, tAvg))));
    const bAxis = norm3(cross3(tAvg, nAxis));
    const cosHalf = Math.max(dot3(tAvg, tOut), 0.2);
    const bend = interior ? norm3(sub3(tOut, tIn), nAxis) : nAxis;
    const tSegment = tangents[segment]!;
    return section.map(({ offset, normal, u, meters }) => {
      const o = add3(scale3(bAxis, offset[0]), scale3(nAxis, offset[1]));
      const stretched = add3(o, scale3(bend, dot3(o, bend) * (1 / cosHalf - 1)));
      let n = add3(scale3(bAxis, normal[0]), scale3(nAxis, normal[1]));
      if (hard) n = norm3(sub3(n, scale3(tSegment, dot3(n, tSegment))), n);
      return builder.vertex(
        add3(path[i]!, stretched),
        norm3(n),
        [u, lengths[i]! / total],
        [meters, lengths[i]!],
      );
    });
  };

  for (let s = 0; s < tangents.length; s += 1) {
    const a = ring(s, s);
    const b = ring(s + 1, s);
    for (const [e0, e1] of edges) builder.orientedQuad(a[e0]!, a[e1]!, b[e1]!, b[e0]!);
  }

  if (shape.caps !== false) {
    const ends: [number, V3][] = [
      [0, scale3(tangents[0]!, -1)],
      [path.length - 1, tangents[tangents.length - 1]!],
    ];
    for (const [i, normal] of ends) {
      const segment = i === 0 ? 0 : tangents.length - 1;
      const n = segmentNormals[segment]!;
      const t = tangents[segment]!;
      const bAxis = norm3(cross3(t, n));
      const center = builder.vertex(path[i]!, normal, [0.5, 0.5], [0, 0]);
      const rim = section
        .filter((_, k) => 'rect' in (shape.section ?? {}) || k < section.length - 1)
        .filter((_, k) => !('rect' in (shape.section ?? {})) || k % 2 === 0)
        .map(({ offset }) =>
          builder.vertex(
            add3(path[i]!, add3(scale3(bAxis, offset[0]), scale3(n, offset[1]))),
            normal,
            [0.5 + offset[0], 0.5 + offset[1]],
            [offset[0], offset[1]],
          ),
        );
      for (let k = 0; k < rim.length; k += 1) {
        builder.orientedTri(center, rim[k]!, rim[(k + 1) % rim.length]!);
      }
    }
  }
  return dropDegenerate(builder.build());
}
