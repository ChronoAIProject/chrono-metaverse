import * as THREE from 'three';

/** 跟随地面观察点的平行光阴影，只在相机移出整格或城市内容变化时重画。 */
export class CitySun {
  private light?: THREE.DirectionalLight;
  private direction = new THREE.Vector3();
  private center = new THREE.Vector3();
  private last = -Infinity;

  setLight(light: THREE.DirectionalLight | undefined) {
    if (this.light) this.light.shadow.dispose();
    this.light = light;
    this.last = -Infinity;
    if (!light) return;
    this.direction.copy(light.position).normalize();
    light.castShadow = true;
    const shadow = light.shadow;
    Object.assign(shadow.camera, {
      left: -360,
      right: 360,
      top: 360,
      bottom: -360,
      near: 1,
      far: 2100,
    });
    shadow.camera.updateProjectionMatrix();
    shadow.mapSize.set(2048, 2048);
    shadow.bias = -0.0001;
    shadow.normalBias = 0.12;
    shadow.radius = 2;
    shadow.autoUpdate = false;
  }

  update(renderer: THREE.WebGLRenderer, focus: THREE.Vector3, globe: boolean) {
    const light = this.light;
    renderer.shadowMap.enabled = !!light && !globe;
    if (!light || globe) return;
    const now = performance.now();
    // 对齐成 24 米的网格，避免逐帧移动采样坐标。异步载入的楼体最多一秒后投影。
    this.center.copy(focus).divideScalar(24).round().multiplyScalar(24);
    if (now - this.last < 1000 && this.center.equals(light.target.position)) return;
    this.last = now;
    light.position.copy(this.direction).multiplyScalar(1000).add(this.center);
    light.target.position.copy(this.center);
    light.target.updateMatrixWorld();
    light.shadow.needsUpdate = true;
  }
}
