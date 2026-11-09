import { expect } from 'vitest';
import { meshBounds, normalAt, vertexAt, vertexCount, type MeshData } from './meshData';
import { cross3, dot3, len3, sub3, type V3 } from './vec';

/** 测试用：检查网格的基本几何性质。 */

export function expectBounds(
  mesh: MeshData,
  min: readonly number[],
  max: readonly number[],
  tolerance = 1e-5,
): void {
  const bounds = meshBounds(mesh);
  expect(bounds).not.toBeNull();
  for (let k = 0; k < 3; k += 1) {
    expect(bounds!.min[k]).toBeCloseTo(min[k]!, -Math.log10(tolerance));
    expect(bounds!.max[k]).toBeCloseTo(max[k]!, -Math.log10(tolerance));
  }
}

/** 所有法线都是单位长度（误差 1e-4）。 */
export function expectUnitNormals(mesh: MeshData): void {
  let worst = 0;
  for (let i = 0; i < vertexCount(mesh); i += 1) {
    worst = Math.max(worst, Math.abs(len3(normalAt(mesh, i)) - 1));
  }
  expect(worst).toBeLessThan(1e-4);
}

/** 每个三角形的几何法线与它三个顶点法线的平均方向一致（绕向和法线自洽）。 */
export function expectConsistentWinding(mesh: MeshData): void {
  let bad = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ids = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
    const [a, b, c] = ids.map((i) => vertexAt(mesh, i)) as [V3, V3, V3];
    const face = cross3(sub3(b, a), sub3(c, a));
    if (len3(face) < 1e-12) continue;
    const average = ids
      .map((i) => normalAt(mesh, i))
      .reduce((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]], [0, 0, 0]);
    if (dot3(face, average) <= 0) bad += 1;
  }
  expect(bad).toBe(0);
}

/** 凸形体：每个顶点的法线都背离给定的内部点（允许极小的数值误差）。 */
export function expectOutwardFrom(mesh: MeshData, inside: readonly number[]): void {
  let bad = 0;
  for (let i = 0; i < vertexCount(mesh); i += 1) {
    const away = sub3(vertexAt(mesh, i), inside);
    if (len3(away) < 1e-9) continue;
    if (dot3(away, normalAt(mesh, i)) < -1e-6) bad += 1;
  }
  expect(bad).toBe(0);
}

/** 所有顶点到给定点的最大距离。 */
export function maxDistanceFrom(mesh: MeshData, point: readonly number[]): number {
  let worst = 0;
  for (let i = 0; i < vertexCount(mesh); i += 1) {
    worst = Math.max(worst, len3(sub3(vertexAt(mesh, i), point)));
  }
  return worst;
}

/** 点到折线（三维）的最短距离。 */
export function distanceToPolyline(point: readonly number[], path: readonly V3[]): number {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const ab = sub3(b, a);
    const t = Math.max(0, Math.min(1, dot3(sub3(point, a), ab) / Math.max(dot3(ab, ab), 1e-18)));
    const closest: V3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    best = Math.min(best, len3(sub3(point, closest)));
  }
  return best;
}

/** 通用检查：法线单位长度、绕向自洽、没有 NaN。 */
export function expectWellFormed(mesh: MeshData): void {
  expect(mesh.indices.length % 3).toBe(0);
  expect(mesh.indices.length).toBeGreaterThan(0);
  expect(mesh.uvs.length / 2).toBe(vertexCount(mesh));
  expect(mesh.normals.length).toBe(mesh.positions.length);
  for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
  for (const value of mesh.uvs) expect(Number.isFinite(value)).toBe(true);
  for (const index of mesh.indices) expect(index).toBeLessThan(vertexCount(mesh));
  expectUnitNormals(mesh);
  expectConsistentWinding(mesh);
}
