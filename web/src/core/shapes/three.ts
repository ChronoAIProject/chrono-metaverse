import { BufferAttribute, BufferGeometry } from 'three';
import { buildShape, type BuildOptions } from './build';
import type { MeshData } from './meshData';
import type { Material, Shape } from './types';

/** MeshData 转 three.js BufferGeometry（位置、法线、UV、索引，外加包围盒和包围球）。 */
export function toBufferGeometry(mesh: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export interface ShapeGeometry {
  /** 一个几何体，按材质分组（`geometry.groups[i].materialIndex` 对应 `materials[i]`）。 */
  readonly geometry: BufferGeometry;
  readonly materials: Material[];
  readonly warnings: string[];
}

/** 形状 → 一个带材质分组的 BufferGeometry。 */
export function shapeToGeometry(shape: Shape, options: BuildOptions = {}): ShapeGeometry {
  const { parts, warnings } = buildShape(shape, options);
  return partsToGeometry(parts, warnings);
}

/**
 * 按材质分好的网格块 → 一个带材质分组的 BufferGeometry（`geometry.groups[i]` 对应 `materials[i]`）。
 * 网格在后台线程里生成，主线程只做这一步组装。
 */
export function partsToGeometry(
  parts: readonly { readonly mesh: MeshData; readonly material: Material }[],
  warnings: readonly string[] = [],
): ShapeGeometry {
  const vertexTotal = parts.reduce((sum, part) => sum + part.mesh.positions.length / 3, 0);
  const indexTotal = parts.reduce((sum, part) => sum + part.mesh.indices.length, 0);
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const uvs = new Float32Array(vertexTotal * 2);
  const indices = new Uint32Array(indexTotal);
  const geometry = new BufferGeometry();
  let vertexOffset = 0;
  let indexOffset = 0;
  parts.forEach((part, materialIndex) => {
    positions.set(part.mesh.positions, vertexOffset * 3);
    normals.set(part.mesh.normals, vertexOffset * 3);
    uvs.set(part.mesh.uvs, vertexOffset * 2);
    for (let i = 0; i < part.mesh.indices.length; i += 1) {
      indices[indexOffset + i] = part.mesh.indices[i]! + vertexOffset;
    }
    geometry.addGroup(indexOffset, part.mesh.indices.length, materialIndex);
    vertexOffset += part.mesh.positions.length / 3;
    indexOffset += part.mesh.indices.length;
  });
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, materials: parts.map((part) => part.material), warnings: [...warnings] };
}
