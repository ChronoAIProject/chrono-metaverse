import type { ExternalAccess } from '../core/externalSource';
import * as THREE from 'three';
import { twilightSky } from './hologram';
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
  private skyPending: Promise<THREE.Texture> | null = null;
  private backgroundColor?: string;
  private isCurrent: () => boolean = () => true;
  private yaw = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly host: HTMLElement,
    private readonly loadTexture?: (hash: string) => Promise<THREE.Texture>,
    private readonly providerCreditsHost = host,
    private readonly sampling?: { pixelRatio: number; anisotropy: number },
  ) {}

  get hasMap(): boolean {
    return this.map !== null;
  }

  setContent(
    content: SceneContent,
    backgroundColor?: string,
    isCurrent: () => boolean = () => true,
  ): void {
    this.backgroundColor = backgroundColor;
    this.isCurrent = isCurrent;
    let selected: {
      environment: Environment;
      placement: Placement;
      entity: string;
      access?: ExternalAccess;
    } | null = null;
    for (const member of content.members) {
      for (const entity of member.view.entities) {
        const environment = environmentOf(entity);
        if (environment) {
          selected = {
            environment,
            placement: member.placement,
            entity: entity.entityId,
            access: member.external,
          };
          break;
        }
      }
      if (selected) break;
    }
    const hologram = !!content.members[0]?.view.styleLook?.hologram;
    const key = JSON.stringify([
      selected && { ...selected, access: selected.access?.key },
      hologram,
    ]);
    if (key !== this.key) {
      this.clear();
      this.key = key;
      if (hologram) {
        this.sky = twilightSky();
        this.host.dataset.sky = 'ready';
      }
      if (selected) {
        const { environment, placement } = selected;
        this.host.dataset.environment = 'true';
        this.yaw = THREE.MathUtils.degToRad((environment.sky?.yaw ?? 0) + placement.rotation);
        if (environment.map) {
          this.map = new GeographicMap(
            environment.map,
            this.host,
            {
              entity: selected.entity,
              access: selected.access,
              hologram,
            },
            this.providerCreditsHost,
            this.sampling,
          );
          this.map.group.rotation.y = THREE.MathUtils.degToRad(placement.rotation);
          this.map.group.position.fromArray(placement.offset).multiplyScalar(GRID_UNIT);
          this.scene.add(this.map.group);
        }
        if (!hologram && environment.sky && this.loadTexture) {
          this.host.dataset.sky = 'loading';
          this.skyPending = this.loadTexture(environment.sky.texture);
        }
      }
    }
    const generation = ++this.generation;
    this.applyBackground();
    if (this.skyPending && !this.sky) {
      void this.skyPending
        .then((texture) => {
          if (generation !== this.generation || !this.isCurrent()) return;
          // 贴图缓存还服务普通材质，这里只拥有副本，不修改缓存的采样方式。
          this.sky = texture.clone();
          this.sky.mapping = THREE.EquirectangularReflectionMapping;
          this.sky.colorSpace = THREE.SRGBColorSpace;
          this.sky.needsUpdate = true;
          this.host.dataset.sky = 'ready';
          this.applyBackground();
        })
        .catch(() => {
          if (generation === this.generation && this.isCurrent()) this.host.dataset.sky = 'failed';
        });
    }
  }

  /** 背景的唯一写入点：显式样式色优先，其次为当前环境天空。 */
  private applyBackground(): void {
    if (!this.isCurrent()) return;
    this.scene.background = this.backgroundColor
      ? new THREE.Color(this.backgroundColor)
      : (this.sky ?? (this.host.dataset.environment ? new THREE.Color(0xbad4e5) : null));
    this.scene.backgroundRotation.set(0, this.backgroundColor ? 0 : this.yaw, 0);
    this.map?.setSky(this.scene.background, this.scene.backgroundRotation.y);
  }

  update(camera: THREE.PerspectiveCamera, orbitalGlobe = false): void {
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
    this.map.group.visible = !orbitalGlobe;
    if (!orbitalGlobe) this.map.update(camera);
  }

  private clear(): void {
    this.generation++;
    this.map?.dispose();
    this.map = null;
    this.sky?.dispose();
    this.sky = null;
    this.skyPending = null;
    this.yaw = 0;
    delete this.host.dataset.environment;
    delete this.host.dataset.sky;
    delete this.host.dataset.mapDistance;
  }

  dispose(): void {
    this.clear();
    this.key = '';
    this.backgroundColor = undefined;
    this.isCurrent = () => true;
    this.applyBackground();
  }
}
