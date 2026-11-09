import { ShapeUtils, Vector2 } from 'three';
import { MeshBuilder, dropDegenerate, type MeshData } from './meshData';
import { bounds2, edgeNormals, expandOutline, offsetInward, type Polyline2 } from './outline';
import type { ExtrudeShape } from './types';
import { add2, len2, norm2, positiveOr, sub2, type V2 } from './vec';

/** 圆角分段数：顶面和底面边缘各用这么多段。 */
const EDGE_SEGMENTS = 4;

interface Ring {
  /** 向内偏移量。 */
  readonly inset: number;
  readonly y: number;
  /** 法线的水平分量系数（乘以轮廓外法线）。 */
  readonly horizontal: number;
  /** 法线的竖直分量。 */
  readonly vertical: number;
}

/**
 * 侧面从下到上分成几条带，每条带内相邻两圈连成四边形，带与带之间法线不共享。
 *
 * - 没有圆角：一条带，两圈；
 * - 圆角：一条带。底边和顶边各是一段四分之一圆弧，弧的端点法线正好是水平的，与侧壁连续；
 * - 倒角：三条带（底部斜面、侧壁、顶部斜面），斜面两圈都用 45° 法线，斜面是平的，
 *   沿弧形轮廓又是光滑的。
 */
function sideBands(height: number, edge: number, chamfer: boolean): Ring[][] {
  const wall = (y0: number, y1: number): Ring[] => [
    { inset: 0, y: y0, horizontal: 1, vertical: 0 },
    { inset: 0, y: y1, horizontal: 1, vertical: 0 },
  ];
  if (edge <= 0) return [wall(0, height)];
  if (chamfer) {
    const d = Math.SQRT1_2;
    return [
      [
        { inset: edge, y: 0, horizontal: d, vertical: -d },
        { inset: 0, y: edge, horizontal: d, vertical: -d },
      ],
      wall(edge, height - edge),
      [
        { inset: 0, y: height - edge, horizontal: d, vertical: d },
        { inset: edge, y: height, horizontal: d, vertical: d },
      ],
    ];
  }
  const rings: Ring[] = [];
  for (let k = 0; k <= EDGE_SEGMENTS; k += 1) {
    const a = (k / EDGE_SEGMENTS) * (Math.PI / 2);
    rings.push({
      inset: edge * (1 - Math.sin(a)),
      y: edge * (1 - Math.cos(a)),
      horizontal: Math.sin(a),
      vertical: -Math.cos(a),
    });
  }
  for (let k = 0; k <= EDGE_SEGMENTS; k += 1) {
    const a = (k / EDGE_SEGMENTS) * (Math.PI / 2);
    rings.push({
      inset: edge * (1 - Math.cos(a)),
      y: height - edge + edge * Math.sin(a),
      horizontal: Math.cos(a),
      vertical: Math.sin(a),
    });
  }
  return [rings];
}

function triangulate(points: readonly V2[]): number[][] {
  return ShapeUtils.triangulateShape(
    points.map(([x, z]) => new Vector2(x, z)),
    [],
  );
}

/** 开放轮廓：只生成双面的侧壁带。 */
function openStrip(polyline: Polyline2, height: number): MeshData {
  const builder = new MeshBuilder();
  const { points } = polyline;
  let along = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const d = norm2(sub2(b, a));
    const step = len2(sub2(b, a));
    for (const side of [1, -1]) {
      const n = [d[1] * side, 0, -d[0] * side];
      const ids = [
        builder.vertex([a[0], 0, a[1]], n, [along, 0]),
        builder.vertex([b[0], 0, b[1]], n, [along + step, 0]),
        builder.vertex([b[0], height, b[1]], n, [along + step, height]),
        builder.vertex([a[0], height, a[1]], n, [along, height]),
      ];
      builder.orientedQuad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
    }
    along += step;
  }
  return builder.build();
}

/**
 * 挤出：二维轮廓在 xz 平面，沿 +y 拉伸到 `height`。
 *
 * 轮廓先展开圆弧和圆角（见 outline.ts），侧面在硬点处拆开法线。
 * `fillet` / `chamfer` 作用在顶面和底面的边缘：限制到不超过高度的一半和轮廓较短边长的四分之一，
 * 两者同时给时以 `fillet` 为准。自然 UV：u 是沿轮廓的长度（米），v 是高度（米）；顶面和底面按 xz 坐标。
 */
export function extrudeMesh(shape: ExtrudeShape): MeshData {
  const height = positiveOr(shape.height, 0);
  const polyline = expandOutline(shape.outline ?? { points: [] });
  if (polyline.points.length < 2 || height <= 0) return new MeshBuilder().build();
  if (!polyline.closed) return openStrip(polyline, height);
  if (polyline.points.length < 3) return new MeshBuilder().build();

  const { min, max } = bounds2(polyline.points);
  const limit = Math.min(height / 2, Math.min(max[0] - min[0], max[1] - min[1]) / 4);
  const filletInput = positiveOr(shape.fillet, 0);
  const chamfer = filletInput > 0 ? false : positiveOr(shape.chamfer, 0) > 0;
  const edge = Math.min(filletInput > 0 ? filletInput : positiveOr(shape.chamfer, 0), limit);
  const bands = sideBands(height, edge, chamfer);

  const points = polyline.points;
  const n = points.length;
  const normals = edgeNormals(points, true);
  const insetCache = new Map<number, V2[]>();
  const inset = (delta: number) => {
    let cached = insetCache.get(delta);
    if (cached === undefined) {
      cached = offsetInward(points, delta);
      insetCache.set(delta, cached);
    }
    return cached;
  };
  const vertexNormal = (i: number, segment: number): V2 => {
    if (polyline.hard[i]) return normals[segment]!;
    return norm2(add2(normals[(i - 1 + n) % n]!, normals[i]!));
  };

  const builder = new MeshBuilder();
  let along = 0;
  for (let s = 0; s < n; s += 1) {
    const iA = s;
    const iB = (s + 1) % n;
    const step = len2(sub2(points[iB]!, points[iA]!));
    const columns = [
      { index: iA, normal: vertexNormal(iA, s), u: along },
      { index: iB, normal: vertexNormal(iB, s), u: along + step },
    ];
    for (const rings of bands) {
      const ids = columns.map(({ index, normal, u }) =>
        rings.map((ring) => {
          const p = inset(ring.inset)[index]!;
          return builder.vertex(
            [p[0], ring.y, p[1]],
            [normal[0] * ring.horizontal, ring.vertical, normal[1] * ring.horizontal],
            [u, ring.y],
          );
        }),
      );
      for (let k = 0; k < rings.length - 1; k += 1) {
        builder.orientedQuad(ids[0]![k]!, ids[1]![k]!, ids[1]![k + 1]!, ids[0]![k + 1]!);
      }
    }
    along += step;
  }

  // 顶面和底面：用偏移后的轮廓三角化。
  const cap = inset(edge);
  const triangles = triangulate(cap);
  for (const [y, ny] of [
    [0, -1],
    [height, 1],
  ] as const) {
    const ids = cap.map(([x, z]) => builder.vertex([x, y, z], [0, ny, 0], [x, z]));
    for (const [a, b, c] of triangles) builder.orientedTri(ids[a!]!, ids[b!]!, ids[c!]!);
  }
  return dropDegenerate(builder.build());
}
