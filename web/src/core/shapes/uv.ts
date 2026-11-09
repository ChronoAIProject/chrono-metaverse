import { meshBounds, type Bounds, type MeshData } from './meshData';
import type { UvMode } from './types';

/**
 * 贴图坐标的投影方式（docs/SHAPES.md 材质的 `uv` 字段）：
 *
 * - `box`：按顶点法线的主轴选投影面（三面投影），各轴按包围盒归一化到 [0, 1]；
 * - `planar`：沿包围盒最薄的轴投影（地面沿 y，墙沿它的厚度方向）；
 * - `cylindrical`：绕过包围盒中心的竖直轴展开，u 是方位角，v 是高度；
 * - `mesh`：保留网格生成时给的自然坐标（旋转体按角度和轮廓长度，挤出按周长和高度）。
 *
 * 投影在形状自己的局部坐标系里做（在变换之前），所以贴图跟着物体走。
 */
export function projectUvs(mesh: MeshData, mode: UvMode, bounds?: Bounds | null): MeshData {
  if (mode === 'mesh') return mesh;
  const box = bounds ?? meshBounds(mesh);
  if (box === null) return mesh;
  const size = [0, 1, 2].map((k) => Math.max(box.max[k]! - box.min[k]!, 1e-9));
  const unit = (value: number, axis: number) => (value - box.min[axis]!) / size[axis]!;
  const uvs = new Float32Array((mesh.positions.length / 3) * 2);
  const thinnest = size.indexOf(Math.min(...size));
  const cx = (box.min[0] + box.max[0]) / 2;
  const cz = (box.min[2] + box.max[2]) / 2;

  for (let i = 0; i < mesh.positions.length / 3; i += 1) {
    const x = mesh.positions[i * 3] ?? 0;
    const y = mesh.positions[i * 3 + 1] ?? 0;
    const z = mesh.positions[i * 3 + 2] ?? 0;
    let u = 0;
    let v = 0;
    if (mode === 'cylindrical') {
      u = Math.atan2(x - cx, z - cz) / (2 * Math.PI) + 0.5;
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
  return { ...mesh, uvs };
}
