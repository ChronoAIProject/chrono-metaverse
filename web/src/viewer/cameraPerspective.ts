import { Box3, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraPerspective = 'first' | 'third';

const EYE_HEIGHT = 1.6;
const LOOK_RADIUS = 2;

/** 第一视角的观察点是眼睛。OrbitControls 负责手势，绕眼睛转动的辅助相机只提供朝向和变焦比例。 */
export class FirstPersonView {
  private readonly orbitPosition: Vector3;
  private readonly orbitTarget: Vector3;
  private readonly orbitNear: number;
  private readonly orbitLimits: {
    minDistance: number;
    maxDistance: number;
    maxPolarAngle: number;
    enableDamping: boolean;
  };
  private readonly look: PerspectiveCamera;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly controls: OrbitControls,
    bounds: Box3,
  ) {
    this.orbitPosition = camera.position.clone();
    this.orbitTarget = controls.target.clone();
    this.orbitNear = camera.near;
    const { minDistance, maxDistance, maxPolarAngle, enableDamping } = controls;
    this.orbitLimits = { minDistance, maxDistance, maxPolarAngle, enableDamping };

    // 切换时结清上一个拖动的阻尼，避免松开鼠标后仍绕新的眼位旋转。
    controls.enableDamping = false;
    controls.update();
    const yaw = controls.getAzimuthalAngle();
    const back = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const eye = this.orbitTarget.clone();
    if (!bounds.isEmpty()) {
      const size = bounds.getSize(new Vector3());
      eye.x = MathUtils.clamp(
        eye.x + back.x * size.x * 0.3,
        bounds.min.x + size.x * 0.05,
        bounds.max.x - size.x * 0.05,
      );
      eye.z = MathUtils.clamp(
        eye.z + back.z * size.z * 0.3,
        bounds.min.z + size.z * 0.05,
        bounds.max.z - size.z * 0.05,
      );
      eye.y = bounds.min.y + EYE_HEIGHT;
    }
    this.look = camera.clone();
    this.look.position.copy(eye).addScaledVector(back, LOOK_RADIUS);
    controls.object = this.look;
    controls.target.copy(eye);
    controls.minDistance = LOOK_RADIUS / 3;
    controls.maxDistance = LOOK_RADIUS * 1.5;
    controls.maxPolarAngle = Math.PI - 0.01;
    controls.update();
    camera.near = 0.02;
    camera.updateProjectionMatrix();
    this.sync();
  }

  sync() {
    this.camera.position.copy(this.controls.target);
    this.camera.quaternion.copy(this.look.quaternion);
    const zoom = LOOK_RADIUS / this.controls.getDistance();
    if (Math.abs(this.camera.zoom - zoom) > 1e-6) {
      this.camera.zoom = zoom;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  exit() {
    this.controls.object = this.camera;
    Object.assign(this.controls, this.orbitLimits);
    this.camera.position.copy(this.orbitPosition);
    this.controls.target.copy(this.orbitTarget);
    this.camera.near = this.orbitNear;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
