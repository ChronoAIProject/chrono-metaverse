import * as THREE from 'three';
import { skyRadiance } from './skyRadiance';
import { Reflector } from 'three/addons/objects/Reflector.js';

/** 镜像相机只绘制背景建筑、场景灯与天空，不递归绘制水面、界面或室内。 */
export const CITY_REFLECTION_LAYER = 1;

/** 岸线共用镜像缓冲。步行时每秒更新六次，切换机位时立即采样新视野。 */
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
  readonly depth: THREE.DepthTexture;
  private last = -Infinity;
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly capturedPosition = new THREE.Vector3();
  private readonly capturedRotation = new THREE.Quaternion();

  constructor() {
    const target = this.mirror.getRenderTarget();
    this.depth = new THREE.DepthTexture(target.width, target.height, THREE.UnsignedIntType);
    target.depthTexture = this.depth;
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
    this.position.setFromMatrixPosition(camera.matrixWorld);
    this.rotation.setFromRotationMatrix(camera.matrixWorld);
    if (now - this.last < 166) {
      // 同一水域的瓦片可在一帧内多次进入这里。大幅切镜才打断正常的刷新间隔。
      if (Math.abs(this.mirror.position.y - level) >= 0.03) return false;
      const reach = Math.max(8, (this.position.y - level) * 0.3);
      const projection = camera.projectionMatrix.elements;
      const captured = this.eye.projectionMatrix.elements;
      if (
        this.eye.far === camera.far &&
        this.position.distanceToSquared(this.capturedPosition) <= reach * reach &&
        Math.abs(this.rotation.dot(this.capturedRotation)) >= Math.cos(Math.PI / 15) &&
        Math.abs(projection[0]! / captured[0]! - 1) <= 0.2 &&
        Math.abs(projection[5]! / captured[5]! - 1) <= 0.2
      )
        return true;
    }
    this.capturedPosition.copy(this.position);
    this.capturedRotation.copy(this.rotation);
    this.last = -Infinity;
    this.mirror.position.y = level;
    this.mirror.updateMatrixWorld();
    this.eye.matrixWorld.copy(camera.matrixWorld);
    this.eye.projectionMatrix.copy(camera.projectionMatrix);
    this.eye.far = camera.far;
    const background = scene.background;
    const radiance = background instanceof THREE.Texture ? skyRadiance.get(background) : undefined;
    if (radiance) scene.background = radiance;
    try {
      this.mirror.onBeforeRender(
        renderer,
        scene,
        this.eye,
        this.mirror.geometry,
        this.mirror.material as THREE.Material,
        null!,
      );
    } finally {
      scene.background = background;
    }
    this.last = now;
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
