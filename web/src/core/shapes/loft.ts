import { ShapeUtils, Vector2 } from 'three';
import { MeshBuilder, dropDegenerate, type MeshData } from './meshData';
import { expandOutline } from './outline';
import type { LoftShape } from './types';
import { add3, cross3, len2, norm3, signedArea2, sub2, sub3, type V2, type V3 } from './vec';

export const LOFT_MIN_SECTIONS = 2;
export const LOFT_MAX_SECTIONS = 8;
/** 每个截面至少重采样成这么多点（另加各截面原有顶点的位置）。 */
const UNIFORM_SAMPLES = 48;
const MAX_SAMPLES = 512;
const PARAM_EPS = 1e-4;

interface Section {
  readonly y: number;
  readonly points: V2[];
  readonly hard: boolean[];
  /** 每个点的归一化弧长参数（0–1），从"东侧"起点开始。 */
  readonly params: number[];
  readonly perimeter: number;
}

/**
 * 截面统一成逆时针，并把起点旋到从形心向 +x 方向的射线与轮廓的交点：
 * 这样不同截面的同一参数大致对应同一方位，放样不会扭。
 */
function prepareSection(y: number, rawPoints: V2[], rawHard: boolean[]): Section | null {
  if (rawPoints.length < 3) return null;
  let points = rawPoints;
  let hard = rawHard;
  if (signedArea2(points) < 0) {
    points = [...points].reverse();
    hard = [...hard].reverse();
  }
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cz = points.reduce((s, p) => s + p[1], 0) / points.length;

  // 找射线 (cx, cz) + t·(1, 0) 与哪条边相交（取 t 最小的正值）。
  let best: { edge: number; t: number; s: number } | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if ((a[1] - cz) * (b[1] - cz) > 0 || a[1] === b[1]) continue;
    const s = (cz - a[1]) / (b[1] - a[1]);
    const x = a[0] + s * (b[0] - a[0]);
    const t = x - cx;
    if (t >= 0 && (best === null || t < best.t)) best = { edge: i, t, s };
  }
  if (best !== null) {
    const a = points[best.edge]!;
    const b = points[(best.edge + 1) % points.length]!;
    const start: V2 = [a[0] + best.s * (b[0] - a[0]), a[1] + best.s * (b[1] - a[1])];
    const rotated: V2[] = [];
    const rotatedHard: boolean[] = [];
    for (let k = 1; k <= points.length; k += 1) {
      const index = (best.edge + k) % points.length;
      rotated.push(points[index]!);
      rotatedHard.push(hard[index]!);
    }
    // 起点是一个新插入的软点；如果它与原有顶点重合就不重复插入。
    const first = rotated[0]!;
    const last = rotated[rotated.length - 1]!;
    if (len2(sub2(start, first)) > 1e-9 && len2(sub2(start, last)) > 1e-9) {
      rotated.unshift(start);
      rotatedHard.unshift(false);
    } else if (len2(sub2(start, last)) <= 1e-9) {
      rotated.unshift(rotated.pop()!);
      rotatedHard.unshift(rotatedHard.pop()!);
    }
    points = rotated;
    hard = rotatedHard;
  }
  const lengths = [0];
  for (let i = 1; i <= points.length; i += 1) {
    lengths.push(lengths[i - 1]! + len2(sub2(points[i % points.length]!, points[i - 1]!)));
  }
  const perimeter = lengths[points.length]!;
  if (!(perimeter > 0)) return null;
  return { y, points, hard, params: lengths.slice(0, -1).map((l) => l / perimeter), perimeter };
}

/** 截面在参数 t 处的点（按弧长线性插值）。 */
function sampleAt(section: Section, t: number): V2 {
  const { points, params } = section;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const t0 = params[i]!;
    const t1 = i + 1 < n ? params[i + 1]! : 1;
    if (t >= t0 - 1e-12 && t <= t1 + 1e-12) {
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    }
  }
  return points[0]!;
}

/** 合并参数：所有截面的原有顶点位置 + 均匀采样，去掉过近的重复。 */
function sampleParams(sections: readonly Section[]): { params: number[]; hard: boolean[] } {
  const entries: { t: number; hard: boolean }[] = [];
  for (let k = 0; k < UNIFORM_SAMPLES; k += 1)
    entries.push({ t: k / UNIFORM_SAMPLES, hard: false });
  for (const section of sections) {
    section.params.forEach((t, i) => entries.push({ t, hard: section.hard[i] ?? false }));
  }
  entries.sort((a, b) => a.t - b.t);
  const params: number[] = [];
  const hard: boolean[] = [];
  for (const entry of entries) {
    const last = params.length - 1;
    if (last >= 0 && entry.t - params[last]! < PARAM_EPS) {
      hard[last] = hard[last]! || entry.hard;
      continue;
    }
    if (1 - entry.t < PARAM_EPS) {
      hard[0] = hard[0]! || entry.hard;
      continue;
    }
    params.push(entry.t);
    hard.push(entry.hard);
  }
  if (params.length > MAX_SAMPLES) {
    // 极端输入：保留硬点，其余按步长抽稀。
    const stride = Math.ceil(params.length / MAX_SAMPLES);
    const keep = params.map((_, i) => hard[i] || i % stride === 0);
    return { params: params.filter((_, i) => keep[i]), hard: hard.filter((_, i) => keep[i]) };
  }
  return { params, hard };
}

/**
 * 放样：2 到 8 个水平截面（y 递增），截面之间直纹连接，上下封口。
 *
 * 各截面先展开圆弧和圆角，再按归一化弧长重采样到相同点数：采样点是各截面原有顶点的位置
 * 加 48 个均匀点，所以每个截面自己的角点都被精确保留。任一截面在某参数处是硬点，
 * 整列就当作硬边，两侧的侧面法线分开算。
 * 自然 UV：u 是截面参数 0–1，v 是高度在首末截面之间的比例。
 */
export function loftMesh(shape: LoftShape): MeshData {
  const sections = [...(shape.sections ?? [])]
    .slice(0, LOFT_MAX_SECTIONS)
    .filter((s) => Number.isFinite(s.y))
    .sort((a, b) => a.y - b.y)
    .map((s) => {
      const polyline = expandOutline(s.outline ?? { points: [] }, true);
      return prepareSection(s.y, polyline.points, polyline.hard);
    })
    .filter((s): s is Section => s !== null);
  if (sections.length < LOFT_MIN_SECTIONS) return new MeshBuilder().build();

  const { params, hard } = sampleParams(sections);
  const columns = params.length;
  const rings: V3[][] = sections.map((section) =>
    params.map((t) => {
      const [x, z] = sampleAt(section, t);
      return [x, section.y, z] as V3;
    }),
  );
  const y0 = sections[0]!.y;
  const yN = sections[sections.length - 1]!.y;
  const vOf = (y: number) => (yN > y0 ? (y - y0) / (yN - y0) : 0);

  // 侧面按硬列拆成若干片，每片内部按相邻面的面积加权平均法线。
  const builder = new MeshBuilder();
  const hardColumns = hard.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
  const starts = hardColumns.length > 0 ? hardColumns : [0];
  for (let p = 0; p < starts.length; p += 1) {
    const from = starts[p]!;
    const to = p + 1 < starts.length ? starts[p + 1]! : starts[0]! + columns;
    const span = to - from;
    if (span <= 0) continue;
    const cols = Array.from({ length: span + 1 }, (_, k) => (from + k) % columns);
    const normals: V3[][] = rings.map(() => cols.map(() => [0, 0, 0] as V3));
    for (let r = 0; r < rings.length - 1; r += 1) {
      for (let c = 0; c < span; c += 1) {
        const a = rings[r]![cols[c]!]!;
        const b = rings[r]![cols[c + 1]!]!;
        const cTop = rings[r + 1]![cols[c + 1]!]!;
        const d = rings[r + 1]![cols[c]!]!;
        // 截面在 (x, z) 里逆时针时，沿截面方向 × 向上 = 左法线，朝里；所以反过来取。
        const face = cross3(sub3(d, b), sub3(cTop, a));
        for (const [rr, cc] of [
          [r, c],
          [r, c + 1],
          [r + 1, c + 1],
          [r + 1, c],
        ] as const) {
          normals[rr]![cc] = add3(normals[rr]![cc]!, face);
        }
      }
    }
    // 米版本：截面上的弧长（参数 × 这一截面的周长），高度从首截面量起
    const ids = rings.map((ring, r) =>
      cols.map((col, c) => {
        const u = from + c >= columns ? 1 : params[col]!;
        const y = ring[col]![1];
        return builder.vertex(
          ring[col]!,
          norm3(normals[r]![c]!),
          [u, vOf(y)],
          [u * sections[r]!.perimeter, y - y0],
        );
      }),
    );
    for (let r = 0; r < rings.length - 1; r += 1) {
      for (let c = 0; c < span; c += 1) {
        builder.orientedQuad(ids[r]![c]!, ids[r]![c + 1]!, ids[r + 1]![c + 1]!, ids[r + 1]![c]!);
      }
    }
  }

  // 上下封口：用最下和最上截面原本的折线三角化。
  for (const [section, ny] of [
    [sections[0]!, -1],
    [sections[sections.length - 1]!, 1],
  ] as const) {
    const triangles = ShapeUtils.triangulateShape(
      section.points.map(([x, z]) => new Vector2(x, z)),
      [],
    );
    const ids = section.points.map(([x, z]) =>
      builder.vertex([x, section.y, z], [0, ny, 0], [x, z]),
    );
    for (const [a, b, c] of triangles) builder.orientedTri(ids[a!]!, ids[b!]!, ids[c!]!);
  }
  return dropDegenerate(builder.build());
}
