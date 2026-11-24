import { MapReflection, CITY_REFLECTION_LAYER } from './mapReflection';
import { groundSurfaceMaterial } from './groundSurface';
import { mapWaterMaterial } from './mapWater';
import { urbanFacade } from './mapFacade';
import { hologramMaterial } from './hologram';
import * as THREE from 'three';
import type { EntityBody } from '../core/api/types';
import type { Placement } from '../core/scene';
import { GRID_UNIT } from '../core/chunk';
import {
  publicHttps,
  record,
  type ExternalAccess,
  type GroundLayer,
  type VectorContent,
} from '../core/externalSource';
import { backgroundView } from './background';
import { GeoReference, tileKey, type Tile } from './geography';
import { sourceResponse } from './externalResource';
import { sourceCredit } from './sourceCredit';
import { vectorGeometry, visibleVectorTiles } from './vectorGeometry';

interface Node {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  roads?: THREE.BufferGeometry;
  water?: THREE.BufferGeometry;
  ground: THREE.BufferGeometry[];
  features: number;
  bytes: number;
  used: number;
}

/** 标准 MVT 多边形按属性拉伸；提供方、图层和字段都来自普通物件。 */
export class VectorContentItem {
  readonly group = new THREE.Group();
  private readonly credit = document.createElement('div');
  private readonly status = document.createElement('span');
  private readonly reference: GeoReference;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly exteriorMaterial?: THREE.MeshLambertMaterial;
  private readonly localEye = new THREE.Vector3();
  private reflectionAtlas?: THREE.Texture;
  private readonly sampledWaterIds?: ReadonlySet<number>;
  private readonly waterMaterial?: ReturnType<typeof mapWaterMaterial>;
  private readonly reflection?: MapReflection;
  private readonly roadMaterial?: THREE.LineBasicMaterial;
  private readonly groundMaterials = new Map<GroundLayer['material'], THREE.MeshStandardMaterial>();
  private readonly nodes = new Map<string, Node>();
  private readonly pending = new Map<string, AbortController>();
  private readonly failed = new Map<string, number>();
  private readonly abort = new AbortController();
  private readonly view: ReturnType<typeof backgroundView>;
  private readonly cameraWorld = new THREE.Matrix4();
  private readonly projection = new THREE.Matrix4();
  private wanted = new Set<string>();
  private queue: Tile[] = [];
  private sourceIndex = 0;
  private template: string | null = null;
  private zoom = 0;
  private lastUpdate = -Infinity;
  private disposed = false;
  private indexFailed = false;

  constructor(
    private readonly config: VectorContent,
    private readonly entity: EntityBody,
    placement: Placement,
    host: HTMLElement,
    private readonly access?: ExternalAccess,
    hologram = false,
    loadTexture?: (hash: string) => Promise<THREE.Texture>,
  ) {
    this.reference = new GeoReference(config.reference);
    this.material = new THREE.MeshLambertMaterial({
      color: config.extrusion.color,
      side: THREE.DoubleSide,
    });
    if (!hologram)
      for (const { material } of config.groundLayers ?? []) {
        if (!this.groundMaterials.has(material))
          this.groundMaterials.set(material, groundSurfaceMaterial(material));
      }
    if (config.extrusion.facade && !hologram) {
      this.exteriorMaterial = new THREE.MeshLambertMaterial({ color: config.extrusion.color });
      this.exteriorMaterial.shadowSide = THREE.DoubleSide;
      const atlas = config.facadeReflections;
      const reflections =
        atlas && loadTexture
          ? {
              map: { value: null as THREE.Texture | null },
              ready: { value: false },
              scale: atlas.scale,
              rows: atlas.buildings.length,
            }
          : undefined;
      urbanFacade(this.exteriorMaterial, reflections);
      urbanFacade(this.material, reflections);
      if (atlas && reflections && loadTexture) {
        void loadTexture(atlas.texture)
          .then((source) => {
            if (
              this.disposed ||
              !(source.image instanceof HTMLImageElement) ||
              source.image.width % 3 ||
              source.image.height % reflections.rows ||
              source.image.width / 3 < 4 ||
              source.image.height / reflections.rows < 2
            )
              return;
            const texture = source.clone();
            texture.flipY = false;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = false;
            texture.minFilter = texture.magFilter = THREE.LinearFilter;
            texture.needsUpdate = true;
            this.reflectionAtlas = texture;
            reflections.map.value = texture;
            reflections.ready.value = true;
          })
          .catch(() => {
            /* Continue with the live sky when the baked atlas is unavailable. */
          });
      }
    }
    if (config.waterLayer) {
      if (!hologram && config.waterReflection === 'scene') this.reflection = new MapReflection();
      const sample = !hologram ? config.waterSample : undefined;
      const center = sample && this.reference.point(...sample.center, 0);
      // Geographic east is local -X at heading zero. Positive placement yaw turns +Z toward +X.
      const downwindHeading =
        config.rippleWindFrom === undefined || hologram
          ? undefined
          : THREE.MathUtils.degToRad(
              180 - config.rippleWindFrom + config.reference.heading + placement.rotation,
            );
      if (sample) this.sampledWaterIds = new Set(sample.featureIds);
      this.waterMaterial = mapWaterMaterial(
        hologram,
        this.reflection,
        sample && center
          ? {
              center: new THREE.Vector3(center.x, center.z, sample.radius),
              reflectance: new THREE.Color().fromArray(sample.reflectance),
              rmsGravitySlope: sample.rmsGravitySlope,
            }
          : undefined,
        downwindHeading,
      );
    }
    if (hologram) {
      hologramMaterial(this.material, 'facade');
      this.roadMaterial = new THREE.LineBasicMaterial({ color: 0x43556b });
    }
    this.group.name = `vector:${entity.entityId}`;
    this.group.userData.background = true;
    this.group.rotation.y = THREE.MathUtils.degToRad(placement.rotation);
    this.group.position.fromArray(placement.offset).multiplyScalar(GRID_UNIT);
    this.view = backgroundView(entity);
    this.credit.className = 'viewer__external-credit';
    this.credit.dataset.entityId = entity.entityId;
    this.credit.dataset.format = 'mvt';
    for (const source of config.sources) this.credit.append(sourceCredit(source));
    this.credit.append(this.status);
    host.append(this.credit);
    this.credit.dataset.state = 'loading';
    this.status.textContent = '正在加载';
    void this.start();
  }

  private async start(): Promise<void> {
    for (let index = 0; index < this.config.sources.length; index++) {
      if (this.disposed) return;
      const source = this.config.sources[index]!;
      try {
        const response = await sourceResponse(
          source,
          this.access,
          {
            entity: this.entity.entityId,
            kind: 'content',
            source: index,
            url: source.url,
          },
          this.abort.signal,
          8 * 1024 * 1024,
        );
        const data = record(await response.json());
        if (
          !data ||
          typeof data.tilejson !== 'string' ||
          !Array.isArray(data.tiles) ||
          data.tiles.length < 1 ||
          data.tiles.length > 4 ||
          !data.tiles.every(publicHttps) ||
          !Number.isInteger(data.maxzoom) ||
          Number(data.maxzoom) < 0 ||
          Number(data.maxzoom) > 20 ||
          !(data.tiles[0] as string).includes('{z}') ||
          !(data.tiles[0] as string).includes('{x}') ||
          !(data.tiles[0] as string).includes('{y}') ||
          (data.scheme !== undefined && data.scheme !== 'xyz')
        ) {
          throw new Error('TileJSON 内容无效');
        }
        if (this.disposed) return;
        this.sourceIndex = index;
        this.zoom = Number(data.maxzoom);
        this.template = data.tiles[0] as string;
        this.credit.dataset.sourceIndex = String(index);
        this.credit.dataset.zoom = String(this.zoom);
        this.paint();
        return;
      } catch {
        if (this.disposed) return;
      }
    }
    this.indexFailed = true;
    this.paint();
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (this.disposed || !this.template) return;
    if (this.waterMaterial) this.waterMaterial.uniforms.time!.value = performance.now() / 1000;
    this.group.updateWorldMatrix(true, false);
    if (this.view) {
      const focus = new THREE.Vector3(...this.view.focus).applyMatrix4(this.group.matrixWorld);
      const distance = camera.position.distanceTo(focus);
      this.group.visible = distance >= this.view.min && distance < this.view.max;
      if (!this.group.visible) return;
    }
    const now = performance.now();
    if (now - this.lastUpdate < 250) return;
    camera.updateMatrixWorld();
    if (camera.far < this.config.extrusion.maxDistance + 2000) {
      camera.far = this.config.extrusion.maxDistance + 2000;
      camera.updateProjectionMatrix();
    }
    if (
      now - this.lastUpdate < 30000 &&
      this.cameraWorld.equals(camera.matrixWorld) &&
      this.projection.equals(camera.projectionMatrix)
    )
      return;
    this.lastUpdate = now;
    this.cameraWorld.copy(camera.matrixWorld);
    this.projection.copy(camera.projectionMatrix);
    this.group.worldToLocal(this.localEye.copy(camera.position));
    const selected = visibleVectorTiles(
      camera,
      this.group.matrixWorld,
      this.reference,
      this.zoom,
      this.config.extrusion.maxDistance,
      this.config.extrusion.distantZoom,
    );
    this.wanted = new Set(selected.map(tileKey));
    for (const [key, node] of this.nodes) {
      node.mesh.visible = this.wanted.has(key);
      if (node.mesh.visible) {
        node.used = now;
        node.mesh.material = this.buildingMaterial(node.mesh.geometry);
      }
    }
    for (const [key, pending] of this.pending) if (!this.wanted.has(key)) pending.abort();
    this.queue = selected.filter(
      (tile) =>
        !this.nodes.has(tileKey(tile)) &&
        !this.pending.has(tileKey(tile)) &&
        now - (this.failed.get(tileKey(tile)) ?? -Infinity) > 30000,
    );
    this.pump();
    this.paint();
  }

  private buildingMaterial(geometry: THREE.BufferGeometry) {
    // 靠近楼群或进入楼体时仍绘制内壁；远处仅着色朝外的屋面和外墙。
    return this.exteriorMaterial && geometry.boundingBox!.distanceToPoint(this.localEye) > 50
      ? this.exteriorMaterial
      : this.material;
  }

  private pump(): void {
    while (!this.disposed && this.pending.size < 4 && this.queue.length) {
      const tile = this.queue.shift()!,
        key = tileKey(tile);
      if (!this.wanted.has(key)) continue;
      const controller = new AbortController();
      this.pending.set(key, controller);
      void this.load(tile, AbortSignal.any([this.abort.signal, controller.signal]))
        .catch(() => {
          if (!controller.signal.aborted && !this.disposed) this.failed.set(key, performance.now());
        })
        .finally(() => {
          this.pending.delete(key);
          if (!this.disposed) {
            this.pump();
            this.paint();
          }
        });
    }
  }

  private async load(tile: Tile, signal: AbortSignal): Promise<void> {
    const key = tileKey(tile);
    const url = this.template!.replaceAll('{z}', String(tile.z))
      .replaceAll('{x}', String(tile.x))
      .replaceAll('{y}', String(tile.y));
    const source = this.config.sources[this.sourceIndex]!;
    const response = await sourceResponse(
      source,
      this.access,
      {
        entity: this.entity.entityId,
        kind: 'content',
        source: this.sourceIndex,
        url,
      },
      signal,
      8 * 1024 * 1024,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    const { geometry, features, roads, water, ground } = vectorGeometry(
      bytes,
      tile,
      this.reference,
      this.config.extrusion,
      this.roadMaterial ? (this.config.roads ?? true) : false,
      this.config.waterLayer,
      this.groundMaterials.size ? this.config.groundLayers : [],
      this.config.waterlineEdits?.filter((edit) => edit.source === source.url),
      this.config.waterSample?.source === source.url ? this.sampledWaterIds : undefined,
      this.exteriorMaterial && this.config.facadeReflections
        ? this.config.facadeReflections.source === source.url
          ? this.config.facadeReflections.buildings
          : []
        : undefined,
    );
    const size =
      Object.values(geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0) +
      (geometry.index?.array.byteLength ?? 0) +
      (roads?.getAttribute('position').array.byteLength ?? 0) +
      Object.values(water?.attributes ?? {}).reduce((n, a) => n + a.array.byteLength, 0) +
      (water?.index?.array.byteLength ?? 0) +
      ground.reduce(
        (sum, { geometry: g }) =>
          sum +
          Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, 0) +
          (g.index?.array.byteLength ?? 0),
        0,
      );
    const total = () => [...this.nodes.values()].reduce((n, node) => n + node.bytes, 0);
    // 几何按瓦片合并；只淘汰当前视野之外的数据，限制内存。
    for (const [oldKey, node] of [...this.nodes]
      .filter(([k]) => !this.wanted.has(k))
      .sort((a, b) => a[1].used - b[1].used)) {
      if (this.nodes.size < 48 && total() + size <= 96 * 1024 * 1024) break;
      node.roads?.dispose();
      node.water?.dispose();
      node.ground.forEach((g) => g.dispose());
      node.mesh.geometry.dispose();
      node.mesh.removeFromParent();
      this.nodes.delete(oldKey);
    }
    if (this.disposed || signal.aborted || total() + size > 96 * 1024 * 1024) {
      roads?.dispose();
      water?.dispose();
      ground.forEach((s) => s.geometry.dispose());
      geometry.dispose();
      return;
    }
    const mesh = new THREE.Mesh(geometry, this.buildingMaterial(geometry));
    mesh.layers.enable(CITY_REFLECTION_LAYER);
    mesh.castShadow = this.groundMaterials.size > 0;
    mesh.receiveShadow = mesh.castShadow;
    for (const part of ground) {
      const surface = new THREE.Mesh(part.geometry, this.groundMaterials.get(part.material)!);
      surface.name = 'ground:' + part.material;
      surface.userData.background = true;
      surface.receiveShadow = true;
      surface.layers.enable(CITY_REFLECTION_LAYER);
      mesh.add(surface);
    }
    if (water && this.waterMaterial) {
      const surface = new THREE.Mesh(water, this.waterMaterial);
      surface.userData.background = true;
      surface.name = 'map-water';
      const reflection = this.reflection;
      surface.receiveShadow = !!reflection;
      if (reflection)
        surface.onBeforeRender = (renderer, scene, camera) => {
          this.waterMaterial!.uniforms.hasReflection!.value = reflection.update(
            renderer,
            scene,
            camera,
            this.reference.origin.y + this.group.position.y + 0.3,
          );
        };
      mesh.add(surface);
    }
    if (roads && this.roadMaterial) {
      const lines = new THREE.LineSegments(roads, this.roadMaterial);
      lines.userData.background = true;
      mesh.add(lines);
    }
    mesh.userData.background = true;
    mesh.visible = this.wanted.has(key);
    this.group.add(mesh);
    this.nodes.set(key, {
      mesh,
      roads,
      water,
      ground: ground.map((s) => s.geometry),
      features,
      bytes: size,
      used: performance.now(),
    });
    this.failed.delete(key);
  }

  private paint(): void {
    const visible = [...this.nodes.values()].filter((node) => node.mesh.visible);
    const pending = this.pending.size + this.queue.length;
    const failed = this.indexFailed || [...this.failed.keys()].some((k) => this.wanted.has(k));
    this.credit.dataset.state = failed
      ? visible.length
        ? 'partial'
        : 'failed'
      : pending || !this.template
        ? 'loading'
        : 'ready';
    this.credit.dataset.visibleTiles = String(visible.length);
    this.credit.dataset.loaded = String(visible.reduce((n, node) => n + node.features, 0));
    this.credit.dataset.pending = String(pending);
    this.status.textContent = failed ? '部分内容暂不可用' : pending ? '正在加载' : '';
  }

  fail(): void {
    this.indexFailed = true;
    this.paint();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const node of this.nodes.values()) {
      node.roads?.dispose();
      node.water?.dispose();
      node.ground.forEach((g) => g.dispose());
      node.mesh.geometry.dispose();
    }
    this.roadMaterial?.dispose();
    for (const material of this.groundMaterials.values()) material.dispose();
    this.waterMaterial?.dispose();
    this.reflection?.dispose();
    this.reflectionAtlas?.dispose();
    this.nodes.clear();
    this.exteriorMaterial?.dispose();
    this.material.dispose();
    this.group.removeFromParent();
    this.credit.remove();
  }
}
