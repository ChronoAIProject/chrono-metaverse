import { ShapeUtils, Vector2 } from 'three';
import { MeshBuilder, dropDegenerate, type MeshData } from './meshData';
import { dedupe, filletPolyline, markHard } from './outline';
import type { ConeShape, CylinderShape, LatheShape } from './types';
import {
  add2,
  clamp,
  len2,
  norm2,
  positiveOr,
  segmentsOr,
  signedArea2,
  sub2,
  type V2,
} from './vec';

/**
 * 旋转体：轮廓 [[r, y], ...] 绕 y 轴旋转。
 *
 * 轮廓的转角超过 30° 的点是硬边（例如圆柱侧面和顶面的交线），在那里拆开法线；
 * 其余点用相邻两段的平均法线，曲面平滑。轮廓方向不限：按"轮廓 + 轴上的闭合边"
 * 的有向面积判断哪边朝外。`angle` 小于 360° 时，两个切面用轮廓多边形封口。
 */
export function latheProfileMesh(
  profileInput: readonly (readonly number[])[],
  segmentsInput: number | undefined,
  angleInput: number | undefined,
): MeshData {
  const profile = dedupe(profileInput, false).map(([r, y]) => [Math.max(0, r), y] as V2);
  if (profile.length < 2) return new MeshBuilder().build();
  const segments = segmentsOr(segmentsInput, 32, 3, 256);
  const angleDeg = clamp(positiveOr(angleInput, 360), 1e-3, 360);
  const angle = (angleDeg * Math.PI) / 180;
  const full = angleDeg >= 360 - 1e-6;
  const steps = full ? segments : Math.max(1, Math.ceil((segments * angleDeg) / 360));

  // 轮廓按 (r, y) 平面的数学方向排列时，外侧在前进方向右边。
  const orientation = signedArea2(profile) < 0 ? -1 : 1;
  const segmentNormals: V2[] = [];
  for (let j = 0; j < profile.length - 1; j += 1) {
    const d = norm2(sub2(profile[j + 1]!, profile[j]!));
    segmentNormals.push([d[1] * orientation, -d[0] * orientation]);
  }
  const hard = markHard(profile, false);
  const vertexNormal = (j: number, segment: number): V2 => {
    if (hard[j]) return segmentNormals[segment]!;
    return norm2(add2(segmentNormals[j - 1]!, segmentNormals[j]!));
  };

  const lengths = [0];
  for (let j = 1; j < profile.length; j += 1) {
    lengths.push(lengths[j - 1]! + len2(sub2(profile[j]!, profile[j - 1]!)));
  }
  const total = Math.max(lengths[lengths.length - 1]!, 1e-9);

  const builder = new MeshBuilder();
  const ring = (point: V2, normal: V2, v: number): number[] => {
    const ids: number[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const theta = (i / steps) * angle;
      const s = Math.sin(theta);
      const c = Math.cos(theta);
      ids.push(
        builder.vertex(
          [point[0] * s, point[1], point[0] * c],
          [normal[0] * s, normal[1], normal[0] * c],
          [i / steps, v],
        ),
      );
    }
    return ids;
  };
  for (let j = 0; j < profile.length - 1; j += 1) {
    const a = ring(profile[j]!, vertexNormal(j, j), lengths[j]! / total);
    const b = ring(profile[j + 1]!, vertexNormal(j + 1, j), lengths[j + 1]! / total);
    for (let i = 0; i < steps; i += 1) builder.orientedQuad(a[i]!, a[i + 1]!, b[i + 1]!, b[i]!);
  }

  if (!full) {
    // 切面封口：轮廓连同它在轴上的投影围成的多边形。
    const polygon: V2[] = [...profile];
    const first = profile[0]!;
    const last = profile[profile.length - 1]!;
    if (last[0] > 1e-9) polygon.push([0, last[1]]);
    if (first[0] > 1e-9) polygon.push([0, first[1]]);
    const contour = dedupe(polygon, true);
    const triangles = ShapeUtils.triangulateShape(
      contour.map(([r, y]) => new Vector2(r, y)),
      [],
    );
    for (const [theta, sign] of [
      [0, -1],
      [angle, 1],
    ] as const) {
      const s = Math.sin(theta);
      const c = Math.cos(theta);
      // 切面法线：沿旋转方向的切线，起始面朝后，结束面朝前。
      const normal = [c * sign, 0, -s * sign];
      const ids = contour.map(([r, y]) => builder.vertex([r * s, y, r * c], normal, [r, y]));
      for (const [i0, i1, i2] of triangles) builder.orientedTri(ids[i0!]!, ids[i1!]!, ids[i2!]!);
    }
  }
  return dropDegenerate(builder.build());
}

export function latheMesh(shape: LatheShape): MeshData {
  return latheProfileMesh(shape.profile ?? [], shape.segments, shape.angle);
}

/**
 * 圆柱和圆台：轮廓 (0,0)→(r,0)→(rTop,h)→(0,h) 的旋转体；`fillet` 在上下两条边缘倒圆角。
 * 圆角半径受相邻边长限制（两端都倒圆角的侧边各用一半）。
 */
export function cylinderMesh(shape: CylinderShape): MeshData {
  const radius = positiveOr(shape.radius, 0);
  const height = positiveOr(shape.height, 0);
  const top = shape.radiusTop === undefined ? radius : Math.max(0, Number(shape.radiusTop) || 0);
  const profile: V2[] = [
    [0, 0],
    [radius, 0],
    [top, height],
    [0, height],
  ];
  const fillet = positiveOr(shape.fillet, 0);
  const radii = [0, fillet, top > 0 ? fillet : 0, 0];
  const points = fillet > 0 ? filletPolyline(profile, radii, false) : profile;
  return latheProfileMesh(points, shape.segments, 360);
}

/** 圆锥：轮廓 (0,0)→(r,0)→(0,h) 的旋转体。 */
export function coneMesh(shape: ConeShape): MeshData {
  const radius = positiveOr(shape.radius, 0);
  const height = positiveOr(shape.height, 0);
  return latheProfileMesh(
    [
      [0, 0],
      [radius, 0],
      [0, height],
    ],
    shape.segments,
    360,
  );
}
