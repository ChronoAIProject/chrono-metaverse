import * as THREE from 'three';
import { environmentOf, type Environment } from '../core/environment';
import { GRID_UNIT } from '../core/chunk';
import type { Placement, SceneContent } from '../core/scene';
import { EARTH_RADIUS } from './geography';
import { GeographicMap } from './geographicMap';

/** 环境独立于内容网格，天空没有有限半径，也不参与主体剖切、取景和点选。 */
export class EnvironmentView {
  private key = '';
  private map: GeographicMap | null = null;
  private sky: THREE.Texture | null = null;
  private generation = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly host: HTMLElement,
    private readonly loadTexture?: (hash: string) => Promise<THREE.Texture>,
  ) {}

  get hasMap(): boolean {
    return this.map !== null;
  }

  setContent(content: SceneContent): void {
    let selected: { environment: Environment; placement: Placement } | null = null;
    for (const member of content.members) {
      for (const entity of member.view.entities) {
        const environment = environmentOf(entity);
        if (environment) {
          selected = { environment, placement: member.placement };
          break;
        }
      }
      if (selected) break;
    }
    const key = JSON.stringify(selected);
    if (key === this.key) return;
    this.clear();
    this.key = key;
    if (!selected) return;
    const { environment, placement } = selected;
    const generation = this.generation;
    this.scene.background = new THREE.Color(0xbad4e5);
    this.host.dataset.environment = 'true';
    if (environment.map) {
      this.map = new GeographicMap(environment.map, this.host);
      this.map.group.rotation.y = THREE.MathUtils.degToRad(placement.rotation);
      this.map.group.position.fromArray(placement.offset).multiplyScalar(GRID_UNIT);
      this.scene.add(this.map.group);
    }
    if (environment.sky && this.loadTexture) {
      const sky = environment.sky;
      this.host.dataset.sky = 'loading';
      void this.loadTexture(sky.texture)
        .then((texture) => {
          if (generation !== this.generation) return;
          // 贴图缓存还服务普通材质，这里只拥有副本，不修改缓存的采样方式。
          this.sky = texture.clone();
          this.sky.mapping = THREE.EquirectangularReflectionMapping;
          this.sky.colorSpace = THREE.SRGBColorSpace;
          this.sky.needsUpdate = true;
          this.scene.background = this.sky;
          this.scene.backgroundRotation.set(
            0,
            THREE.MathUtils.degToRad(sky.yaw + placement.rotation),
            0,
          );
          this.host.dataset.sky = 'ready';
        })
        .catch(() => {
          if (generation === this.generation) this.host.dataset.sky = 'failed';
        });
    }
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (!this.map) return;
    this.map.group.updateWorldMatrix(true, false);
    const center = this.map.reference.center.clone().applyMatrix4(this.map.group.matrixWorld);
    const origin = this.map.reference.origin.clone().applyMatrix4(this.map.group.matrixWorld);
    this.host.dataset.mapDistance = String(Math.round(camera.position.distanceTo(origin)));
    const far = camera.position.distanceTo(center) + EARTH_RADIUS * 1.01;
    if (Math.abs(camera.far - far) > 1) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    this.map.update(camera);
  }

  private clear(): void {
    this.generation++;
    this.map?.dispose();
    this.map = null;
    this.sky?.dispose();
    this.sky = null;
    this.scene.background = null;
    this.scene.backgroundRotation.set(0, 0, 0);
    delete this.host.dataset.environment;
    delete this.host.dataset.sky;
    delete this.host.dataset.mapDistance;
  }

  dispose(): void {
    this.clear();
    this.key = '';
  }
}
