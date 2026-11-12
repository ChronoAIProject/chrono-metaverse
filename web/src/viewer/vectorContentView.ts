import * as THREE from 'three';
import type { EntityBody } from '../core/api/types';
import type { Placement } from '../core/scene';
import { GRID_UNIT } from '../core/chunk';
import {
  publicHttps,
  record,
  type ExternalAccess,
  type VectorContent,
} from '../core/externalSource';
import { backgroundView } from './background';
import { GeoReference, tileKey, type Tile } from './geography';
import { sourceResponse } from './externalResource';
import { sourceCredit } from './sourceCredit';
import { vectorGeometry, visibleVectorTiles } from './vectorGeometry';

interface Node {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
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
  ) {
    this.reference = new GeoReference(config.reference);
    this.material = new THREE.MeshLambertMaterial({
      color: config.extrusion.color,
      side: THREE.DoubleSide,
    });
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
    const selected = visibleVectorTiles(
      camera,
      this.group.matrixWorld,
      this.reference,
      this.zoom,
      this.config.extrusion.maxDistance,
    );
    this.wanted = new Set(selected.map(tileKey));
    for (const [key, node] of this.nodes) {
      node.mesh.visible = this.wanted.has(key);
      if (node.mesh.visible) node.used = now;
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
    const { geometry, features } = vectorGeometry(
      bytes,
      tile,
      this.reference,
      this.config.extrusion,
    );
    const size = Object.values(geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0);
    const total = () => [...this.nodes.values()].reduce((n, node) => n + node.bytes, 0);
    // 几何按瓦片合并；只淘汰当前视野之外的数据，限制内存。
    for (const [oldKey, node] of [...this.nodes]
      .filter(([k]) => !this.wanted.has(k))
      .sort((a, b) => a[1].used - b[1].used)) {
      if (this.nodes.size < 48 && total() + size <= 96 * 1024 * 1024) break;
      node.mesh.geometry.dispose();
      node.mesh.removeFromParent();
      this.nodes.delete(oldKey);
    }
    if (this.disposed || signal.aborted || total() + size > 96 * 1024 * 1024) {
      geometry.dispose();
      return;
    }
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.userData.background = true;
    mesh.visible = this.wanted.has(key);
    this.group.add(mesh);
    this.nodes.set(key, { mesh, features, bytes: size, used: performance.now() });
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
    for (const node of this.nodes.values()) node.mesh.geometry.dispose();
    this.nodes.clear();
    this.material.dispose();
    this.group.removeFromParent();
    this.credit.remove();
  }
}
