import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { MeshData } from './meshData';
import type { Transform } from './types';

const DEG = Math.PI / 180;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 形状变换矩阵：M = T · Ry(yaw) · Rx(pitch) · Rz(roll) · S（docs/SHAPES.md 第 1 节）。
 * three.js 的欧拉角顺序 'YXZ' 正好是 Ry · Rx · Rz。
 */
export function transformMatrix(transform: Transform | undefined): Matrix4 {
  const t = transform ?? {};
  const position = new Vector3(
    finite(t.position?.[0], 0),
    finite(t.position?.[1], 0),
    finite(t.position?.[2], 0),
  );
  const rotation = new Quaternion().setFromEuler(
    new Euler(finite(t.pitch, 0) * DEG, finite(t.yaw, 0) * DEG, finite(t.roll, 0) * DEG, 'YXZ'),
  );
  const scale = new Vector3(
    finite(t.scale?.[0], 1),
    finite(t.scale?.[1], 1),
    finite(t.scale?.[2], 1),
  );
  return new Matrix4().compose(position, rotation, scale);
}

export function isIdentity(matrix: Matrix4): boolean {
  return matrix.equals(new Matrix4());
}

/**
 * 对网格应用矩阵：位置乘矩阵，法线乘法线矩阵（逆转置）后重新归一化。
 * 行列式为负（镜像缩放）时翻转三角形绕向，保证法线仍然朝外。
 */
export function applyMatrix(mesh: MeshData, matrix: Matrix4): MeshData {
  if (isIdentity(matrix)) return mesh;
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const v = new Vector3();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    v.set(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!).applyMatrix4(matrix);
    positions[i] = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
    v.set(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!).applyMatrix3(normalMatrix);
    const length = v.length();
    if (length > 1e-12) v.multiplyScalar(1 / length);
    normals[i] = v.x;
    normals[i + 1] = v.y;
    normals[i + 2] = v.z;
  }
  let indices = mesh.indices;
  if (matrix.determinant() < 0) {
    indices = new Uint32Array(mesh.indices.length);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      indices[t] = mesh.indices[t]!;
      indices[t + 1] = mesh.indices[t + 2]!;
      indices[t + 2] = mesh.indices[t + 1]!;
    }
  }
  return { positions, normals, uvs: mesh.uvs, indices };
}
