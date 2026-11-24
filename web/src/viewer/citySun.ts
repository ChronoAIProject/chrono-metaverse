import * as THREE from 'three';

/** 跟随地面观察点的平行光阴影，只在相机移出整格或城市内容变化时重画。 */
export class CitySun {
  private light?: THREE.DirectionalLight;
  private direction = new THREE.Vector3();
  private center = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private last = -Infinity;

  setLight(light: THREE.DirectionalLight | undefined) {
    if (this.light) this.light.shadow.dispose();
    this.light = light;
    this.last = -Infinity;
    if (!light) return;
    this.direction.copy(light.position).normalize();
    light.castShadow = true;
    const shadow = light.shadow;
    const basis = new THREE.Matrix4().lookAt(this.direction, new THREE.Vector3(), shadow.camera.up);
    this.right.setFromMatrixColumn(basis, 0);
    this.up.setFromMatrixColumn(basis, 1);
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
    // Only retain the resolution while tracking the same part of the city.
    const nearby =
      Number.isFinite(this.last) &&
      focus.distanceToSquared(light.target.position) <= previous * previous;
    const trackingRadius = nearby ? previous : 0;
    // 近处的立柱直径约 6 厘米，需要厘米级阴影采样。切换距离留有回差。
    // Long views across water include buildings well behind and beside the focus.
    const farRadius = distance < (trackingRadius === 360 ? 430 : 390) ? 360 : 760;
    const radius =
      distance < (trackingRadius === 40 ? 88 : 72)
        ? 40
        : distance < (trackingRadius === 112 ? 286 : 248)
          ? 112
          : farRadius;
    if (radius >= 360) this.center.copy(focus);
    else {
      // Frame the walk and its subject together. Near a tier boundary reserve
      // enough space around the subject for its shadow and the snapped centre.
      const towardEye = Math.min(0.5, (radius * 0.8) / Math.max(1, distance));
      this.center.lerpVectors(focus, eye, towardEye);
    }
    const grid = radius / 15;
    this.center.divideScalar(grid).round().multiplyScalar(grid);
    // 快速跟随时仍按粗格更新，但让固定物体总落在同一组阴影纹素上。
    const texelX = (2 * radius) / shadow.mapSize.x;
    const texelY = (2 * radius) / shadow.mapSize.y;
    const x = this.center.dot(this.right);
    const y = this.center.dot(this.up);
    this.center.addScaledVector(this.right, Math.round(x / texelX) * texelX - x);
    this.center.addScaledVector(this.up, Math.round(y / texelY) * texelY - y);
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
