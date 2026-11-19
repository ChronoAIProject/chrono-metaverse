import * as T from 'three';
import type { MemberContent } from '../../core/scene';
import { GRID_UNIT } from '../../core/chunk';
import { environmentOf } from '../../core/environment';
import { readBroadcastTour, type TourStop } from '../../core/broadcastTour';
import { EARTH_RADIUS, GeoReference } from '../geography';
import { liveScreenOf, type LiveScreen } from '../liveScreen';
import { EquipmentModels } from './hardware';
import { placeEquipment } from './city';
import { broadcastSky, orbitalEarth } from './sky';

export interface BroadcastView {
  active: string;
  stops: readonly Pick<TourStop, 'id' | 'label'>[];
}

export function broadcastConfig(member: MemberContent) {
  if (member.view.mode !== 'extended') return null;
  const entities = member.view.entities;
  for (const owner of entities) {
    const tour = readBroadcastTour(owner.props?.broadcastTour);
    if (!tour) continue;
    const mirror = entities.find((e) => e.entityId === tour.mirror);
    const program = entities.find((e) => e.entityId === tour.program);
    const source = program && liveScreenOf(program, window.location.origin)?.source;
    if (!mirror || !source) continue;
    const screen = liveScreenOf(mirror, window.location.origin, source);
    if (!screen) continue;
    const map = entities
      .filter((e) => !tour.environment || e.entityId === tour.environment)
      .map(environmentOf)
      .find((env) => env?.map)?.map;
    if (!map && tour.stops.some((s) => s.frame === 'earth')) continue;
    return { tour, mirror, screen, source, map, placement: member.placement };
  }
  return null;
}
type Config = NonNullable<ReturnType<typeof broadcastConfig>>;
interface Stage {
  stop: TourStop;
  root: T.Group;
  screen: T.Group | null;
  animate: (t: number) => void;
}

export class BroadcastVenue {
  readonly root = new T.Group();
  private readonly models: EquipmentModels;
  private readonly relay = new T.Group();
  private readonly panel = new T.Group();
  private readonly eye = new T.Vector3();
  private readonly center = new T.Vector3();
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly home: T.Object3D;
  private readonly relayMatrix: T.Matrix4;
  private readonly sky;
  private readonly earth;
  private readonly stages = new Map<string, Stage>();
  private readonly byDistance;
  private active: Stage | null = null;
  constructor(
    readonly config: Config,
    private readonly player: LiveScreen,
    private readonly change: (view: BroadcastView) => void,
    loadEntity: (id: string) => Promise<ArrayBuffer> | undefined,
  ) {
    this.models = new EquipmentModels(loadEntity);
    this.home = player.parent!;
    this.root.position.fromArray(config.placement.offset).multiplyScalar(GRID_UNIT);
    this.root.rotation.y = T.MathUtils.degToRad(config.placement.rotation);
    const hasEarth = config.tour.stops.some((s) => s.frame === 'earth');
    const ref = hasEarth && config.map ? new GeoReference(config.map) : null;
    this.earth = ref ? orbitalEarth(ref) : null;
    this.sky = ref ? broadcastSky() : null;
    if (this.earth && this.sky) this.root.add(this.earth.earth, this.sky);
    const face = config.screen;
    this.center.setFromMatrixPosition(face.matrix);
    for (const stop of config.tour.stops) {
      const root = new T.Group();
      if (stop.frame === 'earth' && ref) {
        root.position.copy(ref.center);
        root.scale.setScalar(EARTH_RADIUS);
      } else if (stop.frame === 'screen') root.position.copy(this.center);
      if (stop.position)
        root.position.add(new T.Vector3(...stop.position).multiplyScalar(root.scale.x));
      if (stop.rotation) root.rotation.set(...stop.rotation, 'YXZ');
      const screen = stop.screen ? new T.Group() : null;
      if (screen && stop.screen) {
        if (stop.screen.position) screen.position.fromArray(stop.screen.position);
        if (stop.screen.rotation) screen.rotation.set(...stop.screen.rotation);
        screen.scale.setScalar(stop.screen.scale ?? 1);
        root.add(screen);
      }
      const animate = placeEquipment(root, stop.equipment ?? [], this.models.attach);
      this.stages.set(stop.id, { stop, root, screen, animate });
      this.root.add(root);
    }
    this.byDistance = [...this.stages.values()].sort(
      (a, b) => b.stop.minDistance - a.stop.minDistance,
    );
    const align = face.matrix.clone().invert();
    this.relay.add(this.panel);
    this.relayMatrix = new T.Matrix4()
      .makeTranslation(0, 0, 0.055)
      .multiply(new T.Matrix4().makeScale(16 / face.width, 9 / face.height, 1))
      .multiply(align);
    this.panel.matrixAutoUpdate = false;
    this.panel.matrix.makeScale(16 / face.width, 9 / face.height, 10).multiply(align);
    this.root.updateMatrixWorld(true);
  }
  setMirror(mesh: T.Mesh) {
    this.panel.add(mesh);
  }

  camera(id: string, aspect: number) {
    const stage = this.stages.get(id);
    if (!stage) return null;
    const { camera } = stage.stop;
    const eye = new T.Vector3(...camera.eye);
    eye.z *= Math.max(1, 1.65 / aspect);
    return {
      to: stage.root.localToWorld(eye),
      target: stage.root.localToWorld(new T.Vector3(...camera.target)),
    };
  }

  update(camera: T.PerspectiveCamera, selected: string | null) {
    this.root.worldToLocal(this.eye.copy(camera.position));
    const distance = this.eye.distanceTo(this.center);
    const stage =
      (selected && this.stages.get(selected)) ||
      this.byDistance.find((s) => distance >= s.stop.minDistance)!;
    if (stage !== this.active) {
      if (this.active) this.active.root.visible = false;
      this.player.setRelayed(!!stage.screen);
      if (stage.screen) {
        stage.screen.add(this.relay);
        this.relay.add(this.player);
        this.player.matrix.copy(this.relayMatrix);
      } else {
        this.home.add(this.player);
        this.relay.removeFromParent();
        this.player.matrix.identity();
      }
      this.player.matrixAutoUpdate = false;
      this.player.matrixWorldNeedsUpdate = true;
      this.active = stage;
      this.change({ active: stage.stop.id, stops: this.config.tour.stops });
    }
    for (const entry of this.stages.values())
      entry.root.visible = entry === stage && distance < (entry.stop.hideBeyond ?? Infinity);
    const globe = stage.stop.frame === 'earth';
    if (this.earth && this.sky) this.sky.visible = this.earth.earth.visible = globe;
    if (stage.root.visible) stage.animate(this.reduced.matches ? 0 : performance.now() / 1000);
    return globe;
  }
  dispose() {
    this.models.dispose();
    this.player.setRelayed(false);
    this.panel.clear(); // 镜像几何和材质归原实体所有。
    this.home.add(this.player);
    this.player.matrix.identity();
    this.player.matrixWorldNeedsUpdate = true;
    this.root.removeFromParent();
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
    this.earth?.dispose();
  }
}
