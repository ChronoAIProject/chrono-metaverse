import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

/** A zero normal in a surveyed mesh can poison every mip of a floating-point reflection. */
export function repairModelNormals(geometry: BufferGeometry): void {
  const normals = geometry.getAttribute('normal');
  const positions = geometry.getAttribute('position');
  if (!normals || !positions || normals.count !== positions.count) return;

  const vertex = new Vector3();
  const missing: number[] = [];
  for (let i = 0; i < normals.count; i++) {
    const lengthSq = vertex.fromBufferAttribute(normals, i).lengthSq();
    if (!Number.isFinite(lengthSq) || lengthSq < 1e-16) missing.push(i);
  }
  if (!missing.length) return;

  // Generate area-weighted directions from this primitive's topology. glTF can
  // share normal accessors between primitives with different index buffers.
  const surface = new BufferGeometry();
  surface.setAttribute('position', positions);
  surface.setIndex(geometry.index);
  surface.computeVertexNormals();
  const generated = surface.getAttribute('normal');
  const repaired = new Float32BufferAttribute(new Float32Array(normals.count * 3), 3);
  for (let i = 0; i < normals.count; i++) {
    repaired.setXYZ(i, normals.getX(i), normals.getY(i), normals.getZ(i));
  }
  for (const i of missing) {
    vertex.fromBufferAttribute(generated, i);
    // Unused vertices and zero-area faces have no geometric normal.
    if (!(vertex.lengthSq() > 0)) vertex.set(0, 1, 0);
    repaired.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }
  geometry.setAttribute('normal', repaired);
}
