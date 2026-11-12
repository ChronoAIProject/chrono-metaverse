import type { ExternalAccess } from '../core/externalSource';
import * as THREE from 'three';
import type { GeographicMap as MapConfig } from '../core/environment';
import {
  ancestorUv,
  children,
  ecef,
  EARTH_RADIUS,
  GeoReference,
  MERCATOR_LATITUDE,
  tileBounds,
  tileCoordinates,
  tileKey,
  tileSources,
  tileUrl,
  type Tile,
} from './geography';
import { mapTileImage } from './mapTileCache';
import { sourceCredit } from './sourceCredit';

const MAX_LEAVES = 96;
const MAX_TEXTURES = 192;
const CONCURRENCY = 6;

interface Node extends Tile {
  readonly center: THREE.Vector3;
  readonly sphere: THREE.Sphere;
  readonly direction: THREE.Vector3;
  readonly angle: number;
  readonly width: number;
  texture?: THREE.Texture;
  failedAt?: number;
  lastUsed: number;
}

interface Patch {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly node: Node;
  ancestor: string | null;
}

export interface MapStats {
  readonly tiles: number;
  readonly pending: number;
  readonly failed: number;
  readonly zoom: number;
}

/** 同一个渲染器中的 WGS84 地图；网格不重叠，未加载的细节使用祖先影像。 */
export class GeographicMap {
  readonly group = new THREE.Group();
  readonly reference: GeoReference;
  private readonly nodes = new Map<string, Node>();
  private readonly patches = new Map<string, Patch>();
  private readonly pending = new Set<string>();
  private readonly abort = new AbortController();
  private readonly credit = document.createElement('div');
  private queue: Node[] = [];
  private active: Node[] = [];
  private visible: Node[] = [];
  private disposed = false;
  private lastUpdate = -Infinity;
  private readonly cameraWorld = new THREE.Matrix4();
  private readonly cameraProjection = new THREE.Matrix4();
  private viewport = '';
  private maxZoom: number;
  private failures = 0;
  private stats: MapStats = { tiles: 0, pending: 0, failed: 0, zoom: 0 };

  constructor(
    private readonly config: MapConfig,
    private readonly host: HTMLElement,
    private readonly resource?: { entity: string; access?: ExternalAccess },
  ) {
    this.reference = new GeoReference(config);
    this.maxZoom = Math.max(...config.sources.map((source) => source.maxZoom));
    this.group.name = 'geographic-map';
    this.credit.className = 'viewer__map-credit';
    this.credit.setAttribute('aria-label', '地图来源');
    for (const source of config.sources) this.credit.append(sourceCredit(source));
    host.appendChild(this.credit);
    // 两极超出 Web Mercator 覆盖的部分仍有地球表面，不露出透明背景。
    for (const north of [true, false]) {
      const geometry = this.cap(north);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xd8e3e6 }));
      mesh.userData.background = true;
      this.group.add(mesh);
    }
  }

  getStats(): MapStats {
    return this.stats;
  }

  private cap(north: boolean): THREE.BufferGeometry {
    const vertices: number[] = [],
      indices: number[] = [];
    for (let row = 0; row <= 4; row++) {
      const latitude =
        (north ? 1 : -1) * (MERCATOR_LATITUDE + ((90 - MERCATOR_LATITUDE) * row) / 4);
      for (let col = 0; col <= 64; col++)
        vertices.push(...this.reference.point((col / 64) * 360 - 180, latitude).toArray());
    }
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 64; col++) {
        const i = row * 65 + col;
        indices.push(i, i + 1, i + 66, i, i + 66, i + 65);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(north ? indices : indices.reverse());
    geometry.computeVertexNormals();
    return geometry;
  }

  private node(tile: Tile): Node {
    const key = tileKey(tile);
    const existing = this.nodes.get(key);
    if (existing) return existing;
    const [west, south, east, north] = tileBounds(tile);
    const center = this.reference.point((west + east) / 2, (south + north) / 2);
    const box = new THREE.Box3();
    for (let y = 0; y <= 4; y++)
      for (let x = 0; x <= 4; x++)
        box.expandByPoint(
          this.reference.point(west + ((east - west) * x) / 4, south + ((north - south) * y) / 4),
        );
    const value: Node = {
      ...tile,
      center,
      sphere: box.getBoundingSphere(new THREE.Sphere()),
      direction: ecef((west + east) / 2, (south + north) / 2).normalize(),
      angle: Math.min(Math.PI, THREE.MathUtils.degToRad((east - west + north - south) / 2)),
      width: Math.max(
        1,
        EARTH_RADIUS *
          THREE.MathUtils.degToRad(
            Math.max(
              (east - west) * Math.cos(THREE.MathUtils.degToRad((north + south) / 2)),
              north - south,
            ),
          ),
      ),
      lastUsed: performance.now(),
    };
    this.nodes.set(key, value);
    return value;
  }

  private geometry(node: Node): THREE.BufferGeometry {
    const divisions = node.z < 5 ? 32 : node.z < 10 ? 16 : 4;
    const positions: number[] = [],
      uv: number[] = [],
      indices: number[] = [];
    for (let row = 0; row <= divisions; row++) {
      for (let col = 0; col <= divisions; col++) {
        const [lon, lat] = tileCoordinates(
          node.x + col / divisions,
          node.y + row / divisions,
          node.z,
        );
        positions.push(...this.reference.point(lon, lat).sub(node.center).toArray());
        uv.push(col / divisions, 1 - row / divisions);
      }
    }
    for (let row = 0; row < divisions; row++)
      for (let col = 0; col < divisions; col++) {
        const i = row * (divisions + 1) + col;
        indices.push(i, i + divisions + 1, i + 1, i + 1, i + divisions + 1, i + divisions + 2);
      }
    // 相邻精度的边界弦长不同，用向地心下垂的裙边遮住曲面裂缝。
    const boundary = [
      ...Array.from({ length: divisions }, (_, i) => i),
      ...Array.from({ length: divisions }, (_, i) => i * (divisions + 1) + divisions),
      ...Array.from({ length: divisions }, (_, i) => (divisions + 1) ** 2 - 1 - i),
      ...Array.from({ length: divisions }, (_, i) => (divisions - i) * (divisions + 1)),
    ];
    const skirtStart = positions.length / 3;
    const depth = Math.max(10, node.width * 0.03);
    for (const index of boundary) {
      const point = new THREE.Vector3().fromArray(positions, index * 3).add(node.center);
      point.addScaledVector(point.clone().sub(this.reference.center).normalize(), -depth);
      positions.push(...point.sub(node.center).toArray());
      uv.push(uv[index * 2]!, uv[index * 2 + 1]!);
    }
    for (let i = 0; i < boundary.length; i++) {
      const next = (i + 1) % boundary.length;
      indices.push(boundary[i]!, skirtStart + i, boundary[next]!);
      indices.push(boundary[next]!, skirtStart + i, skirtStart + next);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute('tileUv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  private select(camera: THREE.PerspectiveCamera): Node[] {
    const inverse = this.group.matrixWorld.clone().invert();
    const position = camera.position.clone().applyMatrix4(inverse);
    const earthCamera = this.reference.toEcef(position);
    const horizon = Math.acos(Math.min(1, 6356752 / earthCamera.length()));
    const direction = earthCamera.normalize();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const pixels =
      this.host.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const visible = (node: Node) =>
      Math.acos(THREE.MathUtils.clamp(node.direction.dot(direction), -1, 1)) <=
        horizon + node.angle + 0.02 &&
      frustum.intersectsSphere(node.sphere.clone().applyMatrix4(this.group.matrixWorld));
    const error = (node: Node) =>
      (node.width * pixels) /
      Math.max(1, position.distanceTo(node.sphere.center) - node.sphere.radius);
    let leaves = [this.node({ z: 0, x: 0, y: 0 })];
    const blocked = new Set<Node>();
    for (let pass = 0; pass < MAX_LEAVES * 2; pass++) {
      let best: Node | null = null,
        score = 512;
      for (const leaf of leaves) {
        const value = error(leaf);
        const [west, south, east, north] = tileBounds(leaf);
        const canRefine = this.config.sources.some(
          (source) =>
            leaf.z < source.maxZoom &&
            (!source.bounds ||
              (west < source.bounds[2] &&
                east > source.bounds[0] &&
                south < source.bounds[3] &&
                north > source.bounds[1])),
        );
        if (!blocked.has(leaf) && leaf.z < this.maxZoom && canRefine && value > score) {
          score = value;
          best = leaf;
        }
      }
      if (!best) break;
      const next = children(best)
        .map((tile) => this.node(tile))
        .filter(visible);
      if (leaves.length - 1 + next.length > MAX_LEAVES) {
        blocked.add(best);
        continue;
      }
      leaves = leaves.filter((leaf) => leaf !== best).concat(next);
    }
    return leaves;
  }

  update(camera: THREE.PerspectiveCamera, force = false): void {
    if (this.disposed) return;
    const now = performance.now();
    if (!force && now - this.lastUpdate < 180) return;
    this.group.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    const viewport = `${this.host.clientWidth}/${this.host.clientHeight}`;
    // 镜头静止时由下载完成回调补贴图；仅定期重新选择以重试失败来源。
    if (
      !force &&
      now - this.lastUpdate < 30000 &&
      this.viewport === viewport &&
      this.cameraWorld.equals(camera.matrixWorld) &&
      this.cameraProjection.equals(camera.projectionMatrix)
    )
      return;
    this.lastUpdate = now;
    this.viewport = viewport;
    this.cameraWorld.copy(camera.matrixWorld);
    this.cameraProjection.copy(camera.projectionMatrix);
    this.visible = this.select(camera);
    const wanted = new Map<string, Node>();
    const keep = new Set(this.visible.map(tileKey));
    const active = new Map<string, Node>();
    for (const leaf of this.visible) {
      let node = leaf;
      let nearestAvailable = false;
      for (;;) {
        const key = tileKey(node);
        active.set(key, node);
        node.lastUsed = now;
        // 逐四级保留低精度回退，避免每次移动都下载完整的祖先链。
        const available = tileSources(node, this.config.sources).length > 0;
        if (available && (!nearestAvailable || node.z % 4 === 0)) wanted.set(key, node);
        if (available) nearestAvailable = true;
        if (node.z === 0) break;
        node = this.node({ z: node.z - 1, x: Math.floor(node.x / 2), y: Math.floor(node.y / 2) });
      }
    }
    this.active = [...active.values()];
    this.queue = [...wanted.values()]
      .filter(
        (node) =>
          !node.texture &&
          tileSources(node, this.config.sources).length > 0 &&
          !this.pending.has(tileKey(node)) &&
          (!node.failedAt || now - node.failedAt > 30000),
      )
      .sort(
        (a, b) =>
          a.z - b.z || a.center.distanceTo(camera.position) - b.center.distanceTo(camera.position),
      );
    for (const [key, patch] of this.patches) {
      if (!keep.has(key)) {
        this.group.remove(patch.mesh);
        patch.mesh.geometry.dispose();
        patch.mesh.material.dispose();
        this.patches.delete(key);
      }
    }
    this.paint();
    this.pump();
    this.prune();
  }

  private paint(): void {
    let loaded = 0;
    for (const node of this.visible) {
      const key = tileKey(node);
      let patch = this.patches.get(key);
      if (!patch) {
        const mesh = new THREE.Mesh(
          this.geometry(node),
          new THREE.MeshBasicMaterial({ color: 0x557e8e }),
        );
        mesh.position.copy(node.center);
        mesh.userData.background = true;
        mesh.name = `map:${key}`;
        this.group.add(mesh);
        patch = { node, mesh, ancestor: null };
        this.patches.set(key, patch);
      }
      let ancestor = node;
      while (!ancestor.texture && ancestor.z > 0)
        ancestor = this.node({
          z: ancestor.z - 1,
          x: Math.floor(ancestor.x / 2),
          y: Math.floor(ancestor.y / 2),
        });
      const ancestorKey = ancestor.texture ? tileKey(ancestor) : null;
      if (ancestorKey) loaded++;
      if (ancestorKey === patch.ancestor) continue;
      patch.ancestor = ancestorKey;
      patch.mesh.material.map = ancestor.texture ?? null;
      patch.mesh.material.color.setHex(ancestor.texture ? 0xffffff : 0x557e8e);
      patch.mesh.material.needsUpdate = true;
      if (ancestor.texture) {
        const offset = ancestorUv(node, ancestor);
        const uv = patch.mesh.geometry.getAttribute('uv');
        for (let i = 0; i < uv.count; i++)
          uv.setXY(
            i,
            offset.x + patch.mesh.geometry.getAttribute('tileUv').getX(i) * offset.size,
            1 - offset.y - (1 - patch.mesh.geometry.getAttribute('tileUv').getY(i)) * offset.size,
          );
        uv.needsUpdate = true;
      }
    }
    this.stats = {
      tiles: loaded,
      pending: this.queue.length + this.pending.size,
      failed: this.failures,
      zoom: Math.max(0, ...this.visible.map((node) => node.z)),
    };
    this.host.dataset.mapTiles = String(loaded);
    this.host.dataset.mapPending = String(this.stats.pending);
    this.host.dataset.mapFailed = String(this.failures);
    this.host.dataset.mapZoom = String(this.stats.zoom);
    this.host.dataset.mapReady = String(loaded === this.visible.length && loaded > 0);
    this.credit.title = this.failures
      ? '部分地图影像暂不可用，使用较低精度影像回退'
      : '地图按视野加载，支持浏览器缓存';
  }

  private pump(): void {
    while (!this.disposed && this.pending.size < CONCURRENCY && this.queue.length) {
      const node = this.queue.shift()!;
      const key = tileKey(node);
      if (node.texture || this.pending.has(key)) continue;
      this.pending.add(key);
      void this.load(node).finally(() => {
        this.pending.delete(key);
        if (!this.disposed) {
          this.paint();
          this.pump();
        }
      });
    }
  }

  private async load(node: Node): Promise<void> {
    for (const source of tileSources(node, this.config.sources)) {
      try {
        const image = await mapTileImage(tileUrl(node, source), this.abort.signal, source.cache, {
          source,
          access: this.resource?.access,
          request: {
            entity: this.resource?.entity ?? '',
            kind: 'map',
            source: this.config.sources.indexOf(source),
            url: tileUrl(node, source),
          },
        });
        if (this.disposed) {
          image.close();
          return;
        }
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        node.texture = texture;
        node.failedAt = undefined;
        return;
      } catch {
        if (this.disposed) return;
      }
    }
    node.failedAt = performance.now();
    this.failures++;
  }

  private release(node: Node): void {
    if (!node.texture) return;
    (node.texture.image as ImageBitmap).close();
    node.texture.dispose();
    node.texture = undefined;
  }

  private prune(): void {
    const active = new Set(this.active.map(tileKey));
    const textures = [...this.nodes.values()].filter((node) => node.texture);
    let remaining = textures.length;
    for (const node of textures.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (remaining <= MAX_TEXTURES) break;
      if (active.has(tileKey(node))) continue;
      this.release(node);
      remaining--;
    }
    if (this.nodes.size > 2000)
      for (const [key, node] of this.nodes)
        if (!node.texture && !active.has(key) && !this.pending.has(key)) this.nodes.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.credit.remove();
    for (const patch of this.patches.values()) {
      patch.mesh.geometry.dispose();
      patch.mesh.material.dispose();
    }
    for (const node of this.nodes.values()) this.release(node);
    for (const mesh of this.group.children.slice(0, 2) as THREE.Mesh[]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
    this.group.clear();
    for (const key of ['mapTiles', 'mapPending', 'mapFailed', 'mapZoom', 'mapReady'])
      delete this.host.dataset[key];
  }
}
