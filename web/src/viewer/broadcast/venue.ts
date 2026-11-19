import * as T from 'three';
import type { MemberContent } from '../../core/scene';
import { GRID_UNIT } from '../../core/chunk';
import { environmentOf } from '../../core/environment';
import { EARTH_RADIUS as R, GeoReference } from '../geography';
import { liveScreenOf } from '../liveScreen';
import { buildCity } from './city';
import { loadHardware } from './hardware';
import { RelayScreen, screenGlass } from './screen';
import { WaterfrontMaterials } from './waterfront';
import { broadcastSky, orbitalEarth } from './sky';

export type BroadcastShot = 'office' | 'city' | 'orbit';
const vec = (x: number, y: number, z: number) => new T.Vector3(x, y, z);

export function broadcastConfig(member: MemberContent) {
  if (member.view.mode !== 'extended') return null;
  const source = member.view.entities.find((e) => e.entityId === 'tide-arena.mirror');
  const screen = source && liveScreenOf(source, window.location.origin);
  const map = member.view.entities.map(environmentOf).find((env) => env?.map)?.map;
  return source && screen && map ? { source, screen, map, placement: member.placement } : null;
}

type Config = NonNullable<ReturnType<typeof broadcastConfig>>;

/** 三个会场在同一坐标系中。播放器始终使用当前快照中前厅全息看台的配置。 */
export class BroadcastVenue {
  readonly root = new T.Group();
  readonly surfaces = new WaterfrontMaterials();
  private readonly sky = broadcastSky();
  private readonly abort = new AbortController();
  private readonly city = new T.Group();
  private readonly orbit = new T.Group();
  private readonly earth;
  private readonly hub = new T.Group();
  private readonly launch = new T.Group();
  private readonly cityScreen = new T.Group();
  private readonly orbitScreen = new T.Group();
  private readonly relay = new T.Group();
  private readonly panel = new T.Group();
  private readonly video: RelayScreen;
  private readonly traffic;
  private active: BroadcastShot | null = null;
  private readonly eye = new T.Vector3();
  private readonly officeCenter = new T.Vector3();
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly home: T.Object3D;
  private readonly relayMatrix: T.Matrix4;

  constructor(
    config: Config,
    private readonly player: T.Group,
    private readonly change: (shot: BroadcastShot) => void,
  ) {
    this.home = player.parent!;
    this.root.position.fromArray(config.placement.offset).multiplyScalar(GRID_UNIT);
    this.root.rotation.y = T.MathUtils.degToRad(config.placement.rotation);
    this.root.add(this.sky, this.city, this.orbit);
    this.city.position.set(-240, 0, 345);
    this.city.rotation.y = 0.88;
    this.traffic = buildCity(this.city);
    this.cityScreen.position.set(-40, 160, 96);
    this.cityScreen.scale.setScalar(15.8);
    this.cityScreen.rotation.y = -0.23;
    this.city.add(this.cityScreen);
    const ref = new GeoReference(config.map);
    this.earth = orbitalEarth(ref);
    this.root.add(this.earth.earth);
    this.orbit.position.copy(ref.center);
    this.orbit.scale.setScalar(R);
    this.orbit.rotation.set(-1.05, Math.PI, 0, 'YXZ');
    this.hub.position.set(1.04, 0.01, 0.55);
    loadHardware('station', this.hub, this.abort.signal);
    loadHardware('launch', this.launch, this.abort.signal);
    this.hub.rotation.set(0.51, 0.73, -0.36);

    this.launch.rotation.z = -0.5;
    this.orbit.add(this.hub, this.launch, this.orbitScreen);
    this.orbitScreen.position.set(1.1, 0.31, 0.72);
    this.orbitScreen.rotation.set(-0.11, -0.2, -0.03);
    this.orbitScreen.scale.setScalar(0.052);
    // 两个远景都沿用前厅镜像实体的外框与占位画面。
    this.video = new RelayScreen(player);
    this.relay.add(this.panel, screenGlass());
    this.panel.matrixAutoUpdate = false;
    this.panel.matrix
      .makeScale(16 / config.screen.width, 9 / config.screen.height, 16 / config.screen.width)
      .multiply(config.screen.matrix.clone().invert());
    const face = config.screen;
    this.officeCenter.setFromMatrixPosition(face.matrix);
    this.relayMatrix = new T.Matrix4()
      .makeTranslation(0, 0, 0.055)
      .multiply(new T.Matrix4().makeScale(16 / face.width, 9 / face.height, 1))
      .multiply(face.matrix.clone().invert());
    this.root.updateMatrixWorld(true);
  }

  setMirror(mesh: T.Mesh) {
    this.panel.add(mesh.clone(false));
  }

  camera(shot: BroadcastShot, aspect: number) {
    const widen = Math.max(1, 1.65 / aspect);
    if (shot === 'orbit')
      return {
        to: this.orbit.localToWorld(vec(0.38, 0.09, 2.98 * widen)),
        target: this.orbit.localToWorld(vec(0.38, 0.03, 0)),
      };
    if (shot === 'city')
      return {
        to: this.city.localToWorld(vec(8, 379, 890 * widen)),
        target: this.city.localToWorld(vec(0, 50, 0)),
      };
    const to = this.officeCenter.clone().add(vec(-2, 1.8, 14 * widen));
    return {
      to: this.root.localToWorld(to),
      target: this.root.localToWorld(this.officeCenter.clone().add(vec(0, -2, 0))),
    };
  }

  update(camera: T.PerspectiveCamera) {
    this.root.worldToLocal(this.eye.copy(camera.position));
    const distance = this.eye.distanceTo(this.officeCenter);
    const shot: BroadcastShot = distance > 180000 ? 'orbit' : distance >= 112 ? 'city' : 'office';
    if (shot !== this.active) {
      const parent =
        shot === 'office' ? this.home : shot === 'city' ? this.cityScreen : this.orbitScreen;
      if (shot === 'office') {
        this.home.add(this.player);
        this.relay.removeFromParent();
      } else {
        parent.add(this.relay);
        this.relay.add(this.player);
      }
      this.video.show(shot !== 'office');
      this.player.matrixAutoUpdate = false;
      if (shot === 'office') this.player.matrix.identity();
      else this.player.matrix.copy(this.relayMatrix);
      this.player.matrixWorldNeedsUpdate = true;
      this.surfaces.show(shot === 'city');
      this.active = shot;
      this.change(shot);
    }
    this.panel.visible = !this.video.playing;
    this.sky.visible = shot !== 'office';
    this.sky.material.uniforms.orbit!.value = T.MathUtils.smoothstep(
      Math.log10(Math.max(1, distance)),
      3.5,
      5.35,
    );
    this.city.visible = shot === 'city' && distance < 70000;
    this.orbit.visible = this.earth.earth.visible = shot === 'orbit';
    const t = this.reduced.matches ? 0 : performance.now() / 1000;
    if (this.city.visible) this.traffic(t);
    if (this.orbit.visible) {
      this.hub.rotation.y = 0.73 + 0.13 * Math.sin(t * 0.06);
      this.launch.position.set(
        -0.94 + 0.04 * Math.sin(t * 0.17),
        0.35 + 0.065 * Math.sin(t * 0.17),
        0.47,
      );
    }
    return shot;
  }

  dispose() {
    this.abort.abort();
    this.surfaces.dispose();
    this.panel.clear(); // 镜像几何和材质归原实体所有。
    this.video.dispose();
    this.home.add(this.player);
    this.player.matrix.identity();
    this.player.matrixWorldNeedsUpdate = true;
    this.root.removeFromParent();
    this.root.add(this.relay); // 室内机位时投影组处于游离状态，也需要释放。
    const geometries = new Set<T.BufferGeometry>(),
      materials = new Set<T.Material>();
    this.root.traverse((obj) => {
      if (obj instanceof T.Mesh || obj instanceof T.Points) {
        geometries.add(obj.geometry);
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material])
          materials.add(m);
        if (obj instanceof T.InstancedMesh) obj.dispose();
      }
    });
    for (const geo of geometries) geo.dispose();
    for (const mat of materials) {
      if ('map' in mat && mat.map instanceof T.Texture) mat.map.dispose();
      mat.dispose();
    }
    this.earth.dispose();
  }
}
