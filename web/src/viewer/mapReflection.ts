import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

/** 镜像相机只绘制背景建筑、场景灯与天空，不递归绘制水面、界面或室内。 */
export const CITY_REFLECTION_LAYER = 1;

/** 整片岸线共享一个反射缓冲；波纹每帧更新，建筑倒影最多每秒更新六次。 */
export class MapReflection {
  private readonly mirror = new Reflector(new THREE.BufferGeometry(), {
    textureWidth: 512,
    textureHeight: 384,
    multisample: 0,
  });
  private readonly eye = new THREE.PerspectiveCamera();
  private readonly inverse = new THREE.Matrix4();
  readonly matrix = new THREE.Matrix4();
  readonly texture = this.mirror.getRenderTarget().texture;
  private last = -Infinity;

  constructor() {
    this.mirror.rotation.x = -Math.PI / 2;
    this.eye.layers.set(CITY_REFLECTION_LAYER);
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, level: number) {
    if (
      !(camera instanceof THREE.PerspectiveCamera) ||
      camera.position.y <= level ||
      camera.position.y - level > 1800 ||
      renderer.getRenderTarget()
    )
      return false;
    const now = performance.now();
    if (now - this.last < 166) return Math.abs(this.mirror.position.y - level) < 0.03;
    this.last = now;
    this.mirror.position.y = level;
    this.mirror.updateMatrixWorld();
    this.eye.matrixWorld.copy(camera.matrixWorld);
    this.eye.projectionMatrix.copy(camera.projectionMatrix);
    this.eye.far = camera.far;
    this.mirror.onBeforeRender(
      renderer,
      scene,
      this.eye,
      this.mirror.geometry,
      this.mirror.material as THREE.Material,
      null!,
    );
    const uniforms = (this.mirror.material as THREE.ShaderMaterial).uniforms;
    this.matrix
      .copy(uniforms.textureMatrix!.value)
      .multiply(this.inverse.copy(this.mirror.matrixWorld).invert());
    return true;
  }

  dispose() {
    this.mirror.geometry.dispose();
    this.mirror.dispose();
  }
}
