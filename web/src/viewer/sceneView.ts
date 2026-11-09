import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AnchorState, EntityBody } from '../core/api/types';
import { GRID_UNIT } from '../core/chunk';
import type { ViewContent } from '../core/scene';
import { shapeToGeometry, type ShapeGeometry } from '../core/shapes/three';
import {
  isTextureMaterial,
  type Material,
  type Shape,
  type TemplateTable,
} from '../core/shapes/types';
import { voxelMeshes, type VoxelMesh } from '../core/voxels';

/**
 * 只读查看器的 three.js 场景。React 组件（Viewer.tsx）只负责挂载和传参，
 * 渲染、相机、剖切、标签都在这里。
 *
 * - 物件：形状词表 → BufferGeometry（按材质分组），同样的形状只生成一次（缓存）；
 * - 方块：叠加后的区块 → 可见面网格，玻璃单独半透明；
 * - 扫描：网页用 glb，按对齐变换摆放；
 * - 虚拟区：边界光效 + "虚拟"标签；锚点：纯文本标签，处于某状态时高亮；
 * - 剖切：内容材质共用一个裁剪平面，切掉某个高度以上的物件、方块和扫描；虚拟区光效和标签不切。
 */

export interface SceneViewOptions {
  /** 按资源哈希取贴图（凭分享令牌下载）。没有时贴图材质退回成色调颜色。 */
  readonly loadTexture?: (hash: string) => Promise<THREE.Texture>;
}

export interface SceneStats {
  readonly entities: number;
  readonly triangles: number;
  readonly voxelFaces: number;
  readonly hasScan: boolean;
  readonly warnings: readonly string[];
}

const ANCHOR_COLOR = '#c8f542';

function srgb(color: readonly number[]): THREE.Color {
  return new THREE.Color().setRGB(
    (color[0] ?? 200) / 255,
    (color[1] ?? 200) / 255,
    (color[2] ?? 200) / 255,
    THREE.SRGBColorSpace,
  );
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh || (object as THREE.LineSegments).isLineSegments) {
      // 共享的形状几何体由缓存管理，这里只释放各自的材质。
      if (!mesh.userData.sharedGeometry) mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material?.dispose();
    }
    if (object instanceof CSS2DObject) object.element.remove();
  });
}

function voxelGeometry(mesh: VoxelMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const colors = new Float32Array(mesh.colors.length);
  const c = new THREE.Color();
  for (let i = 0; i < mesh.colors.length; i += 3) {
    c.setRGB(mesh.colors[i]!, mesh.colors[i + 1]!, mesh.colors[i + 2]!, THREE.SRGBColorSpace);
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** 物件所用模板的内容也进缓存键：模板变了，实例要重新生成。 */
function geometryKey(shape: Shape, templates: TemplateTable): string {
  const used = new Set<string>();
  const visit = (node: Shape, depth: number) => {
    if (depth > 8) return;
    if (node.type === 'instance' && !used.has(node.template)) {
      used.add(node.template);
      const template = templates[node.template];
      if (template) visit(template, depth + 1);
    }
    if (node.type === 'group') for (const child of node.children ?? []) visit(child, depth);
  };
  visit(shape, 0);
  return JSON.stringify([shape, [...used].sort().map((id) => [id, templates[id] ?? null])]);
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  private readonly controls: OrbitControls;
  private readonly content = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly resize: ResizeObserver;
  private readonly geometryCache = new Map<string, ShapeGeometry>();
  private readonly textureCache = new Map<string, Promise<THREE.Texture>>();
  private readonly cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  private readonly clipping = [this.cut];
  private anchorLabels = new Map<string, { element: HTMLElement; label: string; y: number }>();
  private cutHeight: number | null = null;
  private framed = false;
  private disposed = false;
  private stats: SceneStats = {
    entities: 0,
    triangles: 0,
    voxelFaces: 0,
    hasScan: false,
    warnings: [],
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly options: SceneViewOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // 剖切只作用在场景内容的材质上（虚拟区光效、标签不被切掉）。
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.className = 'viewer__canvas';
    this.renderer.domElement.setAttribute('aria-label', '空间的三维视图，可拖动旋转、滚轮缩放');
    this.renderer.domElement.setAttribute('role', 'img');
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'viewer__labels';
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(0x15171b);
    this.scene.add(new THREE.HemisphereLight(0xf4f1ea, 0x3a3d44, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 12, 8);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
    fill.position.set(-8, 6, -4);
    this.scene.add(fill);
    const grid = new THREE.GridHelper(40, 40, 0x3b3f48, 0x262930);
    // 放在地面板下面，避免和地面抢深度（z-fighting）。
    grid.position.y = -0.08;
    this.scene.add(grid, this.content, this.overlay);

    this.camera.position.set(8, 7, 11);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(3, 0.8, 2.5);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** 当前场景的统计（测试和端到端截图用来确认真的画出了东西）。 */
  getStats(): SceneStats {
    return this.stats;
  }

  private fit(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.labels.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    if (this.disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private shapeGeometry(shape: Shape, templates: TemplateTable): ShapeGeometry {
    const key = geometryKey(shape, templates);
    let cached = this.geometryCache.get(key);
    if (cached === undefined) {
      cached = shapeToGeometry(shape, { templates });
      this.geometryCache.set(key, cached);
      // 缓存只保留最近的一批，时间轴来回拖动时不会无限增长。
      if (this.geometryCache.size > 400) {
        const oldest = this.geometryCache.keys().next().value!;
        this.geometryCache.get(oldest)?.geometry.dispose();
        this.geometryCache.delete(oldest);
      }
    }
    return cached;
  }

  private material(material: Material, entity: EntityBody): THREE.MeshStandardMaterial {
    const glass = entity.props?.glass === true;
    const base = new THREE.MeshStandardMaterial({
      roughness: glass ? 0.1 : 0.82,
      metalness: 0.02,
      transparent: glass,
      opacity: glass ? 0.32 : 1,
      depthWrite: !glass,
      side: glass ? THREE.DoubleSide : THREE.FrontSide,
      clippingPlanes: this.clipping,
    });
    if (isTextureMaterial(material)) {
      base.color = material.tint ? srgb(material.tint) : new THREE.Color(0xffffff);
      const load = this.options.loadTexture;
      if (load) {
        let texture = this.textureCache.get(material.texture);
        if (texture === undefined) {
          texture = load(material.texture);
          this.textureCache.set(material.texture, texture);
        }
        texture
          .then((map) => {
            if (this.disposed) return;
            map.colorSpace = THREE.SRGBColorSpace;
            base.map = map;
            base.needsUpdate = true;
          })
          .catch(() => {
            // 贴图拿不到时保留色调颜色。
          });
      }
    } else {
      base.color = srgb(material.color);
    }
    return base;
  }

  /** 换内容：物件、方块、扫描、虚拟区、锚点。 */
  setContent(
    view: ViewContent,
    scan?: ArrayBuffer | null,
    scanTransform?: readonly number[],
  ): void {
    disposeObject(this.content);
    disposeObject(this.overlay);
    this.content.clear();
    this.overlay.clear();
    this.anchorLabels = new Map();
    const warnings: string[] = [];
    let triangles = 0;

    for (const entity of view.entities) {
      if (entity.shape === undefined) continue;
      const built = this.shapeGeometry(entity.shape, view.templates);
      warnings.push(...built.warnings.map((w) => `${entity.entityId}：${w}`));
      if (built.geometry.index === null || built.geometry.index.count === 0) continue;
      const mesh = new THREE.Mesh(
        built.geometry,
        built.materials.map((m) => this.material(m, entity)),
      );
      mesh.userData = { sharedGeometry: true, entityId: entity.entityId, label: entity.label };
      mesh.name = entity.entityId;
      if (entity.props?.glass === true) mesh.renderOrder = 2;
      this.content.add(mesh);
      triangles += built.geometry.index.count / 3;
    }

    const voxels = voxelMeshes(view.voxels, view.palette);
    for (const [part, glass] of [
      [voxels.opaque, false],
      [voxels.glass, true],
    ] as const) {
      if (part.indices.length === 0) continue;
      const mesh = new THREE.Mesh(
        voxelGeometry(part),
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: glass ? 0.1 : 0.9,
          transparent: glass,
          opacity: glass ? 0.4 : 1,
          depthWrite: !glass,
          clippingPlanes: this.clipping,
        }),
      );
      mesh.name = glass ? 'voxels-glass' : 'voxels';
      if (glass) mesh.renderOrder = 3;
      this.content.add(mesh);
      triangles += part.indices.length / 3;
    }

    let hasScan = false;
    if (view.showScan && scan) {
      hasScan = true;
      new GLTFLoader().parse(
        scan,
        '',
        (gltf) => {
          if (this.disposed) return;
          if (scanTransform && scanTransform.length === 16) {
            gltf.scene.applyMatrix4(new THREE.Matrix4().fromArray(scanTransform as number[]));
          }
          gltf.scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (mesh.isMesh) {
              const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              for (const material of materials) {
                material.side = THREE.DoubleSide;
                material.clippingPlanes = this.clipping;
              }
            }
          });
          gltf.scene.name = 'scan';
          this.content.add(gltf.scene);
          this.frameContent();
        },
        (error) => {
          warnings.push(`扫描模型解析失败：${String(error)}`);
        },
      );
    }

    for (const region of view.virtualRegions) {
      for (const box of region.boxes) {
        const min = new THREE.Vector3(box[0], box[1], box[2]).multiplyScalar(GRID_UNIT);
        const max = new THREE.Vector3(box[3], box[4], box[5]).multiplyScalar(GRID_UNIT);
        const size = new THREE.Vector3().subVectors(max, min);
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
        const shell = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(shell),
          new THREE.LineBasicMaterial({ color: 0x5fd8ff, transparent: true, opacity: 0.9 }),
        );
        edges.position.copy(center);
        const glow = new THREE.Mesh(
          shell,
          new THREE.MeshBasicMaterial({
            color: 0x5fd8ff,
            transparent: true,
            opacity: 0.06,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        glow.position.copy(center);
        const tag = document.createElement('div');
        tag.className = 'viewer__virtual-tag';
        tag.textContent = region.label ? `虚拟 · ${region.label}` : '虚拟';
        const label = new CSS2DObject(tag);
        label.position.set(center.x, max.y + 0.15, center.z);
        this.overlay.add(edges, glow, label);
      }
    }

    for (const anchor of view.anchors) {
      const position = anchor.position
        ? new THREE.Vector3(...anchor.position)
        : anchor.box
          ? new THREE.Vector3(
              (anchor.box[0] + anchor.box[3]) / 2,
              anchor.box[4],
              (anchor.box[2] + anchor.box[5]) / 2,
            ).multiplyScalar(GRID_UNIT)
          : null;
      if (position === null) continue;
      const element = document.createElement('div');
      element.className = 'viewer__anchor';
      element.dataset.anchorId = anchor.anchorId;
      const label = anchor.label ?? anchor.anchorId;
      element.textContent = label;
      const object = new CSS2DObject(element);
      object.position.copy(position);
      this.overlay.add(object);
      this.anchorLabels.set(anchor.anchorId, { element, label, y: position.y });
    }
    for (const anchor of view.anchors) {
      if (!anchor.position) continue;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 12, 8),
        // 锚点圆点和标签一样，在剖切高度以上时不显示。
        new THREE.MeshBasicMaterial({ color: ANCHOR_COLOR, clippingPlanes: this.clipping }),
      );
      marker.position.set(...anchor.position);
      this.overlay.add(marker);
    }

    this.stats = {
      entities: view.entities.length,
      triangles,
      voxelFaces: voxels.faceCount,
      hasScan,
      warnings,
    };
    this.applyCut();
    if (!this.framed) this.frameContent();
    this.host.dataset.triangles = String(triangles);
  }

  /** 镜头对准内容（第一次有内容时自动执行）。 */
  frameContent(): void {
    const box = new THREE.Box3().setFromObject(this.content);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, size.y, 1) * 0.58;
    this.controls.target.set(center.x, Math.min(center.y, 1), center.z);
    const distance = radius / Math.tan((this.camera.fov * Math.PI) / 360);
    this.camera.position.set(
      center.x + distance * 0.55,
      center.y + distance * 0.75,
      center.z + distance * 0.75,
    );
    this.camera.near = Math.max(0.02, distance / 500);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.framed = true;
  }

  /** 剖切：切掉 height 以上的内容；null 表示不剖切。 */
  setCutaway(height: number | null): void {
    this.cutHeight = height;
    this.applyCut();
  }

  private applyCut(): void {
    // 所有内容材质共用同一个平面对象，只改常数，不用重新编译着色器。
    this.cut.constant = this.cutHeight ?? 1e6;
    for (const { element, y } of this.anchorLabels.values()) {
      element.hidden = this.cutHeight !== null && y > this.cutHeight + 0.3;
    }
  }

  /** 锚点状态：处于某个状态的锚点标签高亮，并显示状态值（纯文本）。 */
  setAnchorStates(states: ReadonlyMap<string, ReadonlyMap<string, AnchorState>>): void {
    for (const [anchorId, { element, label }] of this.anchorLabels) {
      const current = states.get(anchorId);
      const values = current ? [...current.values()].map((s) => String(s.value ?? '')) : [];
      element.classList.toggle('is-active', values.length > 0);
      element.textContent = values.length > 0 ? `${label} · ${values.join('，')}` : label;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.controls.dispose();
    disposeObject(this.content);
    disposeObject(this.overlay);
    for (const { geometry } of this.geometryCache.values()) geometry.dispose();
    this.geometryCache.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
