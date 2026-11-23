import { Float32BufferAttribute, type Mesh } from 'three';

/** 7 m 级小树的连续形变场。树皮和叶簇使用同一模型坐标，纹理接缝两侧的位移相同。 */
export function prepareTreeWind(mesh: Mesh): void {
  const geometry = mesh.geometry;
  if (!geometry.morphAttributes.position) {
    const position = geometry.getAttribute('position');
    const sine = new Float32BufferAttribute(new Float32Array(position.count * 3), 3);
    const cosine = new Float32BufferAttribute(new Float32Array(position.count * 3), 3);
    let margin = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const bend = 0.085 * Math.min(1, Math.max(0, (y - 1.1) / 6.7)) ** 1.7;
      const phase = 0.29 * z + 0.12 * x + 0.09 * y;
      const up = 0.11 * Math.sin(0.48 * x);
      const along = 0.32 + 0.13 * Math.sin(0.6 * z);
      const a = bend * Math.cos(phase);
      const b = bend * Math.sin(phase);
      sine.setXYZ(i, a, a * up, a * along);
      cosine.setXYZ(i, b, b * up, b * along);
      margin = Math.max(margin, bend * Math.hypot(1, up, along));
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    geometry.boundingBox?.expandByScalar(margin);
    if (geometry.boundingSphere) geometry.boundingSphere.radius += margin;
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [sine, cosine];
  }
  mesh.updateMorphTargets();
}

/** 两个权重驱动沿岸传播的同一阵风。主画面、阴影和倒影共用网格上的权重。 */
export function updateTreeWind(meshes: readonly Mesh[], seconds: number): void {
  const phase = ((seconds % 12) * Math.PI) / 6;
  const gust = 0.6 + 0.22 * Math.cos(phase) + 0.18 * Math.cos(3 * phase + 0.65);
  const a = gust * Math.sin(2 * phase);
  const b = gust * Math.cos(2 * phase);
  for (const mesh of meshes) {
    const weights = mesh.morphTargetInfluences!;
    weights[0] = a;
    weights[1] = b;
  }
}
