import { meshBounds, meterUvs, type Bounds, type MeshData } from './meshData';
import type { Material, UvMode } from './types';

/**
 * 贴图坐标的投影方式（docs/SHAPES.md 材质的 `uv` 字段）：
 *
 * - `box`：按顶点法线的主轴选投影面（三面投影），各轴按包围盒归一化到 [0, 1]；
 * - `planar`：沿包围盒最薄的轴投影（地面沿 y，墙沿它的厚度方向）；
 * - `cylindrical`：绕过包围盒中心的竖直轴展开，u 是方位角，v 是高度；
 * - `mesh`：保留网格生成时给的自然坐标（旋转体按角度和轮廓长度，挤出按周长和高度）。
 *
 * 材质给了 `tile` 时按米算（SHAPES 2"贴图坐标的平铺、着色、法线与粗糙度"）：投影不除包围盒尺寸，
 * 柱面是（弧长，高度），`mesh` 用米版本的自然坐标；再加 `offset`、逆时针转 `rotate`、除 `tile`。
 *
 * 投影在形状自己的局部坐标系里做（在变换之前），所以贴图跟着物体走。
 */
export function projectUvs(
  mesh: MeshData,
  mode: UvMode,
  bounds?: Bounds | null,
  material?: Material,
): MeshData {
  const tile = material?.tile;
  if (mode === 'mesh' && tile === undefined) return mesh;
  const st = surfaceCoords(mesh, mode, bounds, tile !== undefined);
  if (st === null) return mesh;
  return { ...mesh, uvs: material === undefined ? st : tiledUvs(st, material) };
}

/**
 * 贴图坐标第 1 步：每个顶点的 (s, t)。`meters` 为真时按米（不除包围盒尺寸）。
 * 网格为空时返回 null。
 */
export function surfaceCoords(
  mesh: MeshData,
  mode: UvMode,
  bounds?: Bounds | null,
  meters = false,
): Float32Array | null {
  if (mode === 'mesh') return meters ? meterUvs(mesh) : mesh.uvs;
  const box = bounds ?? meshBounds(mesh);
  if (box === null) return null;
  const size = [0, 1, 2].map((k) => Math.max(box.max[k]! - box.min[k]!, 1e-9));
  const unit = (value: number, axis: number) =>
    meters ? value - box.min[axis]! : (value - box.min[axis]!) / size[axis]!;
  const uvs = new Float32Array((mesh.positions.length / 3) * 2);
  const thinnest = size.indexOf(Math.min(...size));
  const cx = (box.min[0] + box.max[0]) / 2;
  const cz = (box.min[2] + box.max[2]) / 2;
  // 柱面按米时的半径：包围盒在 xz 上的平均半径
  const radius = (size[0]! + size[2]!) / 4;

  for (let i = 0; i < mesh.positions.length / 3; i += 1) {
    const x = mesh.positions[i * 3] ?? 0;
    const y = mesh.positions[i * 3 + 1] ?? 0;
    const z = mesh.positions[i * 3 + 2] ?? 0;
    let u = 0;
    let v = 0;
    if (mode === 'cylindrical') {
      const angle = Math.atan2(x - cx, z - cz);
      u = meters ? (angle + Math.PI) * radius : angle / (2 * Math.PI) + 0.5;
      v = unit(y, 1);
    } else {
      let axis = thinnest;
      if (mode === 'box') {
        const n = [
          Math.abs(mesh.normals[i * 3] ?? 0),
          Math.abs(mesh.normals[i * 3 + 1] ?? 0),
          Math.abs(mesh.normals[i * 3 + 2] ?? 0),
        ];
        axis = n[0]! >= n[1]! && n[0]! >= n[2]! ? 0 : n[1]! >= n[2]! ? 1 : 2;
      }
      if (axis === 0) [u, v] = [unit(z, 2), unit(y, 1)];
      else if (axis === 1) [u, v] = [unit(x, 0), unit(z, 2)];
      else [u, v] = [unit(x, 0), unit(y, 1)];
    }
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  return uvs;
}

/** 角度的 sin、cos；90° 的整数倍取精确的 0、±1。 */
export function exactSinCos(degrees: number): [number, number] {
  if (degrees % 90 === 0) {
    const quarter = (((degrees / 90) % 4) + 4) % 4;
    return (
      [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ] as [number, number][]
    )[quarter]!;
  }
  const radians = (degrees * Math.PI) / 180;
  return [Math.sin(radians), Math.cos(radians)];
}

/**
 * 贴图坐标第 2 步（只在给了 `tile` 时）：先加 offset、再逆时针转 rotate 度、再除 tile。
 * 没给 `tile` 时原样返回。
 */
export function tiledUvs(st: Float32Array, material: Material): Float32Array {
  const tile = material.tile;
  if (tile === undefined) return st;
  const [du, dv] = material.offset ?? [0, 0];
  const [sin, cos] = exactSinCos(material.rotate ?? 0);
  const out = new Float32Array(st.length);
  for (let i = 0; i < st.length; i += 2) {
    const a = st[i]! + du;
    const b = st[i + 1]! + dv;
    out[i] = (a * cos + b * sin) / tile[0];
    out[i + 1] = (-a * sin + b * cos) / tile[1];
  }
  return out;
}
