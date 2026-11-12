import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';
import {
  LRUCache,
  DownloadPriorityQueue,
  PriorityQueue,
  DEFAULT_LRU_CACHE,
  DEFAULT_DOWNLOAD_QUEUE,
  DEFAULT_PARSE_QUEUE,
  type Tile,
} from '3d-tiles-renderer/core';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/three/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import dracoWrapper from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasm from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import type { EntityBody } from '../core/api/types';
import { GRID_UNIT } from '../core/chunk';
import type { Placement, SceneContent } from '../core/scene';
import { externalContentOf, publicHttps, type ExternalContent } from '../core/externalSource';
import { GeoReference } from './geography';
import { externalResponse } from './externalResource';
import { sourceCredit } from './sourceCredit';
import { backgroundView } from './background';

/** 标准三维分片的显示实例；与物件模型哈希、提供方及具体地点无关。 */
class ExternalItem {
  readonly group = new THREE.Group();
  readonly credit = document.createElement('div');
  private tiles: TilesRenderer | null = null;
  private decoder: DRACOLoader | null = null;
  private abort = new AbortController();
  private sourceIndex = 0;
  private disposed = false;
  private readonly blobs = new Set<string>();
  private readonly status = document.createElement('span');
  private loaded = 0;
  private failed = false;
  private readonly view: ReturnType<typeof backgroundView>;

  constructor(
    private readonly config: ExternalContent,
    entity: EntityBody,
    placement: Placement,
    host: HTMLElement,
    private readonly downloadQueue: DownloadPriorityQueue,
    private readonly parseQueue: PriorityQueue,
    private readonly lruCache: LRUCache,
  ) {
    this.view = backgroundView(entity);
    this.group.rotation.y = THREE.MathUtils.degToRad(placement.rotation);
    this.group.position.fromArray(placement.offset).multiplyScalar(GRID_UNIT);
    this.group.userData.background = true;
    this.group.name = `external:${entity.entityId}`;
    this.credit.className = 'viewer__external-credit';
    this.credit.dataset.entityId = entity.entityId;
    for (const source of config.sources) this.credit.append(sourceCredit(source));
    this.credit.append(this.status);
    host.append(this.credit);
    this.start(entity);
  }

  private start(entity: EntityBody): void {
    const source = this.config.sources[this.sourceIndex]!;
    const tiles = new TilesRenderer(source.url);
    this.tiles = tiles;
    this.loaded = 0;
    this.failed = false;
    this.setState('loading', '正在加载');
    this.credit.dataset.sourceIndex = String(this.sourceIndex);
    this.abort = new AbortController();
    const signal = this.abort.signal;
    tiles.downloadQueue = this.downloadQueue;
    tiles.parseQueue = this.parseQueue;
    tiles.lruCache = this.lruCache;
    // 禁止为了预取而下载视野之外的兄弟分片及整条祖先链。
    tiles.loadSiblings = false;
    tiles.loadAncestors = false;
    tiles.errorTarget = 12;
    tiles.maxDepth = 32;
    tiles.maxTilesProcessed = 250;
    tiles.fetchOptions = { credentials: 'omit', mode: 'cors' };
    tiles.registerPlugin({
      name: 'public-resource',
      // 域名根目录的索引也按标准 URL 解析，避免库拼接出多余的斜线。
      preprocessURL: (url: string, tile: Tile | null) =>
        tile?.content?.uri
          ? new URL(tile.content.uri, `${tile.internal.basePath.replace(/\/$/, '')}/`).href
          : url,
      fetchData: (url: string, options: RequestInit) =>
        externalResponse(
          url,
          options.signal ? AbortSignal.any([signal, options.signal]) : signal,
          source.cache,
        ),
    });
    const decoderManager = new THREE.LoadingManager();
    decoderManager.setURLModifier((url) => {
      if (url.endsWith('draco_wasm_wrapper.js')) return dracoWrapper;
      if (url.endsWith('draco_decoder.wasm')) return dracoWasm;
      throw new Error('未知的三维解码资源');
    });
    this.decoder = new DRACOLoader(decoderManager)
      .setDecoderPath('/__decoder__/')
      .setDecoderConfig({ type: 'wasm' })
      .setWorkerLimit(2);
    tiles.manager.setURLModifier((url) => {
      if (url.startsWith('data:') || this.blobs.has(url) || publicHttps(url)) return url;
      throw new Error('三维内容包含不支持的资源地址');
    });
    tiles.registerPlugin(
      new GLTFExtensionsPlugin({
        dracoLoader: this.decoder,
        meshoptDecoder: MeshoptDecoder,
        autoDispose: false,
        plugins: [
          (parser) => {
            const allocated: string[] = [];
            return {
              name: 'public-gltf-dependencies',
              beforeRoot: async () => {
                const json = parser.json as {
                  buffers?: { uri?: string }[];
                  images?: { uri?: string }[];
                };
                // glTF 的外部依赖也使用同一缓存与无凭据请求，不能旁路到默认加载器。
                for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
                  if (!entry.uri || entry.uri.startsWith('data:')) continue;
                  const url = new URL(entry.uri, parser.options.path).href;
                  const response = await externalResponse(url, signal, source.cache);
                  const blob = await response.blob();
                  signal.throwIfAborted();
                  entry.uri = URL.createObjectURL(blob);
                  allocated.push(entry.uri);
                  this.blobs.add(entry.uri);
                }
              },
              afterRoot: async () => {
                for (const url of allocated) {
                  URL.revokeObjectURL(url);
                  this.blobs.delete(url);
                }
              },
            };
          },
        ],
      }),
    );
    if (this.config.reference) {
      const reference = new GeoReference(this.config.reference);
      tiles.group.matrixAutoUpdate = false;
      tiles.group.matrix.copy(reference.rotation);
      tiles.group.matrix.setPosition(reference.center);
    } else {
      // 三维分片的局部坐标为 z 向上，空间采用 y 向上。
      tiles.group.rotation.x = -Math.PI / 2;
      if (entity.bounds) {
        const { min, max } = entity.bounds;
        tiles.group.position.set((min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2);
      }
    }
    this.group.add(tiles.group);
    tiles.addEventListener('load-model', () => {
      if (this.tiles !== tiles || this.disposed) return;
      this.loaded++;
      this.credit.dataset.loaded = String(this.loaded);
      this.setState(this.failed ? 'partial' : 'ready', this.failed ? '来源暂不可用' : '');
    });
    tiles.addEventListener('load-error', ({ tile }) => {
      if (this.tiles !== tiles || this.disposed) return;
      if (tile === null && this.sourceIndex + 1 < this.config.sources.length) {
        // 只尝试显式配置的备用来源；不改变来源标识或请求身份。
        queueMicrotask(() => {
          if (this.tiles !== tiles || this.disposed) return;
          this.stop();
          this.sourceIndex++;
          this.start(entity);
        });
      } else {
        this.failed = true;
        this.setState(this.loaded ? 'partial' : 'failed', '来源暂不可用');
      }
    });
  }

  private setState(state: string, message: string): void {
    this.credit.dataset.state = state;
    this.status.textContent = message;
  }

  update(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const tiles = this.tiles;
    if (!tiles) return;
    if (this.view) {
      this.group.updateWorldMatrix(true, false);
      const focus = new THREE.Vector3(...this.view.focus).applyMatrix4(this.group.matrixWorld);
      const distance = camera.position.distanceTo(focus);
      this.group.visible = distance >= this.view.min && distance < this.view.max;
      if (!this.group.visible) return;
    }
    tiles.setCamera(camera);
    tiles.setResolution(camera, width, height);
    this.group.updateWorldMatrix(true, true);
    tiles.update();
    this.credit.dataset.visibleTiles = String(tiles.visibleTiles.size);
    const sphere = new THREE.Sphere();
    if (tiles.getBoundingSphere(sphere)) {
      sphere.applyMatrix4(tiles.group.matrixWorld);
      const far = camera.position.distanceTo(sphere.center) + sphere.radius;
      if (far > camera.far) {
        camera.far = Math.min(far * 1.05, 100000000);
        camera.updateProjectionMatrix();
      }
    }
  }

  private stop(): void {
    this.abort.abort();
    const tiles = this.tiles;
    this.tiles = null;
    if (tiles) {
      this.group.remove(tiles.group);
      tiles.dispose();
    }
    this.decoder?.dispose();
    this.decoder = null;
    for (const url of this.blobs) URL.revokeObjectURL(url);
    this.blobs.clear();
  }

  fail(): void {
    this.setState('failed', '来源暂不可用');
    this.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.group.removeFromParent();
    this.credit.remove();
  }
}

export class ExternalContentView {
  private key = '';
  private items: ExternalItem[] = [];
  private readonly credit = document.createElement('div');
  private readonly downloadQueue = new DownloadPriorityQueue();
  private readonly parseQueue = new PriorityQueue();
  private readonly lruCache = new LRUCache();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly host: HTMLElement,
  ) {
    this.downloadQueue.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback;
    this.parseQueue.priorityCallback = DEFAULT_PARSE_QUEUE.priorityCallback;
    this.lruCache.unloadPriorityCallback = DEFAULT_LRU_CACHE.unloadPriorityCallback;
    this.downloadQueue.maxJobsPerOrigin = 4;
    this.parseQueue.maxJobs = 2;
    this.lruCache.maxSize = 128;
    this.lruCache.minSize = 96;
    this.lruCache.maxBytesSize = 128 * 1024 * 1024;
    this.lruCache.minBytesSize = 96 * 1024 * 1024;
    this.credit.className = 'viewer__external-credits';
    this.credit.setAttribute('aria-label', '外部内容来源');
  }

  setContent(content: SceneContent): void {
    const selected = content.members.flatMap((member) =>
      member.view.entities.flatMap((entity) => {
        const config = externalContentOf(entity);
        return config ? [{ config, entity, placement: member.placement }] : [];
      }),
    );
    const key = JSON.stringify(selected);
    if (key === this.key) return;
    this.clear();
    this.key = key;
    if (!selected.length) return;
    this.host.append(this.credit);
    for (const { config, entity, placement } of selected) {
      const item = new ExternalItem(
        config,
        entity,
        placement,
        this.credit,
        this.downloadQueue,
        this.parseQueue,
        this.lruCache,
      );
      this.items.push(item);
      this.scene.add(item.group);
    }
  }

  update(camera: THREE.PerspectiveCamera): void {
    for (const item of this.items) {
      try {
        item.update(camera, this.host.clientWidth || 1, this.host.clientHeight || 1);
      } catch {
        // 外部数据解析或渲染异常只影响当前来源，不能中断空间的动画循环。
        item.fail();
      }
    }
  }

  private clear(): void {
    for (const item of this.items) item.dispose();
    this.items = [];
    this.credit.remove();
  }

  dispose(): void {
    this.clear();
    this.key = '';
  }
}
