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

  update(renderer: THREE.WebGLRenderer, eye: THREE.Vector3, focus: THREE.Vector3, globe: boolean) {
    const light = this.light;
    renderer.shadowMap.enabled = !!light && !globe;
    if (!light || globe) return;
    const now = performance.now();
    const distance = eye.distanceTo(focus);
    const shadow = light.shadow;
    const previous = shadow.camera.right;
    // 近处的立柱直径约 6 厘米，需要厘米级阴影采样。切换距离留有回差。
    const radius =
      distance < (previous === 40 ? 88 : 72)
        ? 40
        : distance < (previous === 112 ? 286 : 248)
          ? 112
          : 360;
    if (radius === 360) this.center.copy(focus);
    else this.center.lerpVectors(eye, focus, Math.min(1, (radius * 0.5) / Math.max(1, distance)));
    const grid = radius / 15;
    this.center.divideScalar(grid).round().multiplyScalar(grid);
    if (previous === radius && now - this.last < 1000 && this.center.equals(light.target.position))
      return;
    this.last = now;
    if (previous !== radius) {
      Object.assign(shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius });
      shadow.camera.updateProjectionMatrix();
    }
    shadow.normalBias = radius / 3000;
    light.position.copy(this.direction).multiplyScalar(1000).add(this.center);
    light.target.position.copy(this.center);
    light.target.updateMatrixWorld();
    shadow.needsUpdate = true;
  }
}
