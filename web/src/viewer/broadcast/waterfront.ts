import * as T from 'three';
import { hologramMaterial } from '../hologram';

/** 只替换已加载实体的绘制材质；由原始网格决定楼体轮廓、遮挡和位置。 */
export class WaterfrontMaterials {
  private readonly meshes: {
    mesh: T.Mesh;
    original: T.Material | T.Material[];
    projection: T.Material;
  }[] = [];
  private readonly wall = new T.MeshBasicMaterial();
  private enabled = false;
  constructor() {
    hologramMaterial(this.wall, 'facade');
  }
  add(object: T.Object3D) {
    const projection = this.wall;
    object.traverse((mesh) => {
      if (!(mesh instanceof T.Mesh)) return;
      const original = mesh.material;
      // 保留树冠、地面阴影等依赖透明遮罩的材质。
      const materials = Array.isArray(original) ? original : [original];
      if (materials.some((m) => m.alphaTest > 0 || m.alphaMap || m.opacity < 0.5)) return;
      this.meshes.push({ mesh, original, projection });
      if (this.enabled) mesh.material = projection;
    });
  }
  show(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    for (const { mesh, original, projection } of this.meshes)
      mesh.material = enabled ? projection : original;
  }
  dispose() {
    this.show(false);
    this.wall.dispose();
  }
}
