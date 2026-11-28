import * as THREE from 'three';

type Surface = {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  mirror: boolean;
  key: string;
  size: number;
};

function materialVariant(material: THREE.MeshStandardMaterial): string {
  // This key ranks representatives for speculative work. Three keeps ownership of its program cache.
  const maps = Object.entries(material)
    .filter(([, value]) => value instanceof THREE.Texture)
    .map(([key, value]) => [key, (value as THREE.Texture).channel])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return JSON.stringify([
    material.type,
    material.customProgramCacheKey(),
    maps,
    material.side,
    material.transparent,
    material.alphaTest > 0,
    material.alphaToCoverage,
    material.normalMapType,
    material.flatShading,
    material.vertexColors,
    material.fog,
  ]);
}

/** Prepare nearby city materials during spare foreground frames after a panoramic camera change. */
export class CityTurnPrograms {
  private lastEye?: THREE.Vector3;
  private readonly lastHeading = new THREE.Quaternion();
  private idle?: number;
  private frame?: number;
  private readonly attempted = new Set<string>();
  private readonly pending: Surface[] = [];

  observe(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    mirrorEye: THREE.PerspectiveCamera,
    mirrorTarget: THREE.WebGLRenderTarget,
    level: number,
  ) {
    // The measured cold turn occurs in elevated overviews. Keep street and lake visits out of this work.
    if (!window.requestIdleCallback) return;
    if (document.hidden || camera.position.y - level < 300) {
      if (this.pending.length || this.idle !== undefined || this.frame !== undefined) {
        this.cancel();
        this.lastEye = undefined;
      }
      return;
    }
    if (
      this.lastEye &&
      this.lastEye.distanceToSquared(camera.position) < 100 ** 2 &&
      Math.abs(this.lastHeading.dot(camera.quaternion)) > Math.cos(Math.PI / 6)
    )
      return;
    if (!renderer.extensions.has('KHR_parallel_shader_compile')) return;
    this.cancel();
    const eye = camera.position.clone();
    this.lastEye = eye;
    this.lastHeading.copy(camera.quaternion);
    const stillHere = () =>
      !document.hidden &&
      !renderer.getContext().isContextLost() &&
      eye.distanceToSquared(camera.position) < 100 ** 2;
    const submit = () => {
      this.frame = undefined;
      if (!stillHere() || !this.pending.length) return;
      this.idle = window.requestIdleCallback((deadline) => {
        this.idle = undefined;
        if (!stillHere()) return;
        if (deadline.timeRemaining() > 2) {
          const next = this.pending.pop()!;
          if (next.mesh.parent) {
            const primitive = new THREE.Mesh(next.mesh.geometry, next.material);
            const previous = renderer.getRenderTarget();
            try {
              renderer.setRenderTarget(next.mirror ? mirrorTarget : null);
              renderer.compile(primitive, next.mirror ? mirrorEye : camera, scene);
              this.attempted.add(next.key);
            } finally {
              renderer.setRenderTarget(previous);
            }
          }
        }
        if (this.pending.length) this.frame = requestAnimationFrame(submit);
      });
    };
    this.idle = window.requestIdleCallback(() => {
      this.idle = undefined;
      if (!stillHere()) return;
      this.select(renderer, scene, camera, mirrorEye);
      if (this.pending.length) this.frame = requestAnimationFrame(submit);
    });
  }

  private select(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    mirrorEye: THREE.PerspectiveCamera,
  ) {
    const seen = new Set<string>();
    const materials = new Map<THREE.MeshStandardMaterial, string>();
    const signature = (mesh: THREE.Mesh, material: THREE.MeshStandardMaterial) => {
      let key = materials.get(material);
      if (key === undefined) {
        key = materialVariant(material);
        materials.set(material, key);
      }
      const attributes = mesh.geometry.attributes;
      return [
        key,
        attributes.color?.itemSize,
        !!attributes.tangent,
        !!attributes.uv1,
        mesh instanceof THREE.InstancedMesh,
        mesh instanceof THREE.SkinnedMesh,
      ].join('|');
    };
    for (const depth of [0, 1]) {
      const list = renderer.renderLists.get(scene, depth);
      for (const batch of [list.opaque, list.transparent, list.transmissive]) {
        for (const { object, material } of batch) {
          if (object instanceof THREE.Mesh && material instanceof THREE.MeshStandardMaterial) {
            seen.add(depth + signature(object, material));
          }
        }
      }
    }
    const up = new THREE.Vector3(0, 1, 0);
    const views = [-70, -35, 35, 70].map((angle) => {
      const eye = camera.clone();
      const dir = eye
        .getWorldDirection(new THREE.Vector3())
        .applyAxisAngle(up, (angle * Math.PI) / 180);
      eye.lookAt(eye.position.clone().add(dir));
      eye.updateMatrixWorld();
      return new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse),
      );
    });
    const center = new THREE.Vector3();
    const ranked = new Map<string, Surface>();
    scene.traverseVisible((mesh) => {
      if (
        !(mesh instanceof THREE.Mesh) ||
        mesh instanceof THREE.InstancedMesh ||
        mesh instanceof THREE.SkinnedMesh ||
        mesh instanceof THREE.BatchedMesh ||
        !views.some((view) => view.intersectsObject(mesh))
      )
        return;
      const sphere = mesh.geometry.boundingSphere;
      if (!sphere) return;
      center.copy(sphere.center).applyMatrix4(mesh.matrixWorld);
      const size =
        (sphere.radius * mesh.matrixWorld.getMaxScaleOnAxis()) /
        Math.max(1, center.distanceTo(camera.position));
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        const id = signature(mesh, material);
        for (const depth of [0, 1]) {
          const key = depth + id;
          if (
            seen.has(key) ||
            this.attempted.has(key) ||
            !mesh.layers.test((depth ? mirrorEye : camera).layers)
          )
            continue;
          if ((ranked.get(key)?.size ?? -1) < size)
            ranked.set(key, { key, mesh, material, mirror: depth === 1, size });
        }
      }
    });
    this.pending.push(...[...ranked.values()].sort((a, b) => a.size - b.size));
  }

  private cancel() {
    if (this.idle !== undefined) window.cancelIdleCallback(this.idle);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.idle = undefined;
    this.frame = undefined;
    this.pending.length = 0;
  }

  dispose() {
    this.cancel();
    this.attempted.clear();
    this.lastEye = undefined;
  }
}
