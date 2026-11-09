import { cross3, dot3, norm3, sub3, type V3 } from './vec';

/**
 * 与渲染库无关的三角网格：位置、法线、UV、索引。
 *
 * 网格生成先产出这个结构（node 和浏览器都能跑，测试直接检查数组），
 * 网站再用 `toBufferGeometry` 转成 three.js 的 BufferGeometry。
 * 三角形一律按"从外面看逆时针"排列，法线朝外。
 */
export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(p: readonly number[], n: readonly number[], uv: readonly number[] = [0, 0]): number {
    this.positions.push(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
    this.normals.push(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
    this.uvs.push(uv[0] ?? 0, uv[1] ?? 0);
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** 四边形 a→b→c→d（从外面看逆时针）。 */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  private at(array: readonly number[], index: number): V3 {
    return [array[index * 3] ?? 0, array[index * 3 + 1] ?? 0, array[index * 3 + 2] ?? 0];
  }

  /**
   * 四边形 a→b→c→d（沿边依次排列），绕向按顶点法线决定：几何法线与四个顶点法线之和同向。
   * 用对角线叉积算几何法线，所以一条边退化成一点（球的极点、圆锥顶点）时也成立。
   */
  orientedQuad(a: number, b: number, c: number, d: number): void {
    const pa = this.at(this.positions, a);
    const geometric = cross3(
      sub3(this.at(this.positions, c), pa),
      sub3(this.at(this.positions, d), this.at(this.positions, b)),
    );
    const expected = [a, b, c, d]
      .map((i) => this.at(this.normals, i))
      .reduce((sum, n) => [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]], [0, 0, 0]);
    if (dot3(geometric, expected) >= 0) this.quad(a, b, c, d);
    else this.quad(a, d, c, b);
  }

  /** 三角形，绕向按顶点法线决定。 */
  orientedTri(a: number, b: number, c: number): void {
    const pa = this.at(this.positions, a);
    const geometric = cross3(
      sub3(this.at(this.positions, b), pa),
      sub3(this.at(this.positions, c), pa),
    );
    const expected = [a, b, c]
      .map((i) => this.at(this.normals, i))
      .reduce((sum, n) => [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]], [0, 0, 0]);
    if (dot3(geometric, expected) >= 0) this.tri(a, b, c);
    else this.tri(a, c, b);
  }

  /** 平面三角形：三个顶点共用几何面法线。 */
  flatTri(
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    uvs: readonly (readonly number[])[] = [],
  ): void {
    const n = norm3(cross3(sub3(b, a), sub3(c, a)));
    const ia = this.vertex(a, n, uvs[0]);
    const ib = this.vertex(b, n, uvs[1]);
    const ic = this.vertex(c, n, uvs[2]);
    this.tri(ia, ib, ic);
  }

  append(mesh: MeshData): void {
    const offset = this.vertexCount;
    for (const value of mesh.positions) this.positions.push(value);
    for (const value of mesh.normals) this.normals.push(value);
    for (const value of mesh.uvs) this.uvs.push(value);
    for (const index of mesh.indices) this.indices.push(index + offset);
  }

  build(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

export function emptyMesh(): MeshData {
  return new MeshBuilder().build();
}

export function mergeMeshes(meshes: readonly MeshData[]): MeshData {
  const builder = new MeshBuilder();
  for (const mesh of meshes) builder.append(mesh);
  return builder.build();
}

export function vertexCount(mesh: MeshData): number {
  return mesh.positions.length / 3;
}

export function triangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

export function vertexAt(mesh: MeshData, index: number): V3 {
  return [
    mesh.positions[index * 3] ?? 0,
    mesh.positions[index * 3 + 1] ?? 0,
    mesh.positions[index * 3 + 2] ?? 0,
  ];
}

export function normalAt(mesh: MeshData, index: number): V3 {
  return [
    mesh.normals[index * 3] ?? 0,
    mesh.normals[index * 3 + 1] ?? 0,
    mesh.normals[index * 3 + 2] ?? 0,
  ];
}

export interface Bounds {
  readonly min: V3;
  readonly max: V3;
}

/** 网格的轴对齐包围盒；空网格返回 null。 */
export function meshBounds(mesh: MeshData): Bounds | null {
  if (mesh.positions.length === 0) return null;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const value = mesh.positions[i + k] ?? 0;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  }
  return { min, max };
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/**
 * 去掉面积为 0 的三角形（圆角半径等于半边长、圆锥顶点等情况会产生），
 * 避免渲染和法线计算碰到退化面。
 */
export function dropDegenerate(mesh: MeshData, minArea = 1e-14): MeshData {
  const kept: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = vertexAt(mesh, mesh.indices[t] ?? 0);
    const b = vertexAt(mesh, mesh.indices[t + 1] ?? 0);
    const c = vertexAt(mesh, mesh.indices[t + 2] ?? 0);
    const n = cross3(sub3(b, a), sub3(c, a));
    if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] > minArea * minArea * 4) {
      kept.push(mesh.indices[t] ?? 0, mesh.indices[t + 1] ?? 0, mesh.indices[t + 2] ?? 0);
    }
  }
  return { ...mesh, indices: new Uint32Array(kept) };
}

/**
 * 改成平面着色：每个三角形用自己的顶点和几何面法线。用于倒角——
 * 倒角面是平的，相邻面之间应当是硬边。
 */
export function flatShade(mesh: MeshData): MeshData {
  const builder = new MeshBuilder();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ids = [mesh.indices[t] ?? 0, mesh.indices[t + 1] ?? 0, mesh.indices[t + 2] ?? 0];
    const [a, b, c] = ids.map((i) => vertexAt(mesh, i)) as [V3, V3, V3];
    const uv = ids.map((i) => [mesh.uvs[i * 2] ?? 0, mesh.uvs[i * 2 + 1] ?? 0]);
    builder.flatTri(a, b, c, uv);
  }
  return builder.build();
}
