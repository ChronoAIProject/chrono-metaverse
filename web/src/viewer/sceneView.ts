import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { displayName, type Anchor, type EntityBody } from '../core/api/types';
import { GRID_UNIT } from '../core/chunk';
import {
  anchorPosition,
  placePoint,
  type MemberContent,
  type Placement,
  type SceneContent,
} from '../core/scene';
import { partsToGeometry, type ShapeGeometry } from '../core/shapes/three';
import { transformMatrix } from '../core/shapes/transform';
import {
  isTextureMaterial,
  type Material,
  type Shape,
  type TemplateTable,
} from '../core/shapes/types';
import { materialKey } from '../core/shapes/build';
import type { VoxelPart } from '../core/voxels';
import { anchorKey, linkRoute, type AnchorRef, type Visual } from '../core/visuals';
import { iconElement } from './icons';
import { createMeshService, type MeshService } from './meshService';
import type { ShapeJob } from './meshJobs';

/**
 * 只读查看器的 three.js 场景。React 组件（Viewer.tsx）只负责挂载和传参，
 * 渲染、相机、剖切、标签、事件可视化都在这里。
 *
 * - 物件：形状词表 → 网格在后台线程里生成（meshService），主线程只组装 BufferGeometry；
 *   最外层的 transform 拆出来当实例矩阵，同样的局部形状（同款椅子）共用一份几何体，
 *   两个以上时画成 InstancedMesh；
 * - 材质：颜色或贴图（按资源哈希下载，uv 投影在网格生成时算好，tint 作颜色）；
 * - 方块：叠加后的区块 → 可见面网格（后台线程），玻璃半透明、发光方块不受光照、贴图方块按贴图分块；
 * - 扫描：网页用 glb，按对齐变换（列主序 4×4）摆放；
 * - 组合：每个成员一组，按摆放（先绕 y 轴旋转、再平移）放进同一场景；连接画出来，点击飞到另一端；
 * - 虚拟区：边界光效 + "虚拟"标签；锚点：纯文本标签；事件：高亮、图标、标签、路线、生成物件、热力；
 * - 剖切：内容材质共用一个裁剪平面（世界坐标），切掉某个高度以上的物件、方块和扫描。
 */

export interface LoadStep {
  readonly label: string;
  readonly done: number;
  readonly total: number;
}

export interface Selection {
  readonly spaceId: string;
  readonly entity: EntityBody;
}

export interface SceneViewOptions {
  /** 按资源哈希取贴图。没有时贴图材质退回成色调颜色。 */
  readonly loadTexture?: (hash: string) => Promise<THREE.Texture>;
  /** 按资源哈希取处理后的物件模型（glb 字节）。 */
  readonly loadModel?: (hash: string) => Promise<ArrayBuffer>;
  readonly meshService?: MeshService;
  /** 网格生成进度；null 表示完成。 */
  readonly onProgress?: (step: LoadStep | null) => void;
  /** 点选物件。 */
  readonly onSelect?: (selection: Selection | null) => void;
}

export interface SceneStats {
  readonly entities: number;
  readonly triangles: number;
  readonly voxelFaces: number;
  readonly hasScan: boolean;
  /** 画成 InstancedMesh 的批数（同款物件共用几何体）。 */
  readonly instancedBatches: number;
  /** 共用几何体的物件数。 */
  readonly instancedEntities: number;
  readonly textured: number;
  readonly threaded: boolean;
  readonly members: number;
  readonly warnings: readonly string[];
}

const EMPTY_STATS: SceneStats = {
  entities: 0,
  triangles: 0,
  voxelFaces: 0,
  hasScan: false,
  instancedBatches: 0,
  instancedEntities: 0,
  textured: 0,
  threaded: false,
  members: 0,
  warnings: [],
};

interface AnchorInfo {
  readonly ref: AnchorRef;
  readonly anchor: Anchor;
  /** 世界坐标；空间级锚点为 null。 */
  readonly world: THREE.Vector3 | null;
  readonly element: HTMLElement | null;
  readonly label: string;
  /** 挂在这个锚点上的物件的包围盒（世界坐标）。 */
  readonly bounds: THREE.Box3 | null;
  readonly memberName?: string;
}

interface VisualObject {
  readonly objects: THREE.Object3D[];
  update(visual: Visual): void;
}

function srgb(color: readonly number[]): THREE.Color {
  return new THREE.Color().setRGB(
    (color[0] ?? 200) / 255,
    (color[1] ?? 200) / 255,
    (color[2] ?? 200) / 255,
    THREE.SRGBColorSpace,
  );
}

function cssColor(color: readonly number[], alpha = 1): string {
  return `rgba(${color[0] ?? 0}, ${color[1] ?? 0}, ${color[2] ?? 0}, ${alpha})`;
}

/** 释放对象树；共用的几何体、材质和扫描模型由缓存管理，不在这里释放。 */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object.userData.shared === true) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh || (object as THREE.Line).isLine) {
      if (!mesh.userData.sharedGeometry) mesh.geometry?.dispose();
      if (!mesh.userData.sharedMaterial) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material?.dispose();
      }
    }
    if (object instanceof CSS2DObject) object.element.remove();
  });
}

/** 形状最外层的 transform 拆出来当矩阵，剩下的局部形状用来生成（可共用的）几何体。 */
function splitShape(shape: Shape): { local: Shape; matrix: THREE.Matrix4 } {
  if (shape.transform === undefined) return { local: shape, matrix: new THREE.Matrix4() };
  const { transform, ...rest } = shape;
  return { local: rest as Shape, matrix: transformMatrix(transform) };
}

/** 形状用到的模板（递归），只把这些交给后台线程，也作为缓存键的一部分。 */
function usedTemplates(shape: Shape, templates: TemplateTable): TemplateTable {
  const used: Record<string, Shape> = {};
  const visit = (node: Shape, depth: number) => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (node.type === 'instance') {
      const template = templates[node.template];
      if (template !== undefined && used[node.template] === undefined) {
        used[node.template] = template;
        visit(template, depth + 1);
      }
    }
    if (node.type === 'group') for (const child of node.children ?? []) visit(child, depth);
  };
  visit(shape, 0);
  return used;
}

function geometryKey(local: Shape, used: TemplateTable): string {
  return JSON.stringify([
    local,
    Object.keys(used)
      .sort()
      .map((id) => [id, used[id]]),
  ]);
}

function voxelGeometry(part: VoxelPart): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const colors = new Float32Array(part.colors.length);
  const c = new THREE.Color();
  for (let i = 0; i < part.colors.length; i += 3) {
    c.setRGB(part.colors[i]!, part.colors[i + 1]!, part.colors[i + 2]!, THREE.SRGBColorSpace);
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function placementGroup(placement: Placement): THREE.Group {
  const group = new THREE.Group();
  group.rotation.y = (placement.rotation * Math.PI) / 180;
  group.position.set(
    placement.offset[0] * GRID_UNIT,
    placement.offset[1] * GRID_UNIT,
    placement.offset[2] * GRID_UNIT,
  );
  group.updateMatrixWorld(true);
  return group;
}

/** 二次贝塞尔弧线（路线没有连接可走时用）。 */
function arcPoints(a: THREE.Vector3, b: THREE.Vector3, segments = 32): THREE.Vector3[] {
  const distance = a.distanceTo(b);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  mid.y = Math.max(a.y, b.y) + Math.max(0.6, distance * 0.3);
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
  return curve.getPoints(segments);
}

function polylineAt(points: readonly THREE.Vector3[], fraction: number): THREE.Vector3 {
  if (points.length === 0) return new THREE.Vector3();
  if (points.length === 1) return points[0]!.clone();
  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    lengths.push(lengths[i - 1]! + points[i]!.distanceTo(points[i - 1]!));
  }
  const total = lengths[lengths.length - 1]!;
  const target = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 1; i < points.length; i += 1) {
    if (lengths[i]! >= target) {
      const span = lengths[i]! - lengths[i - 1]!;
      const t = span > 0 ? (target - lengths[i - 1]!) / span : 0;
      return points[i - 1]!.clone().lerp(points[i]!, t);
    }
  }
  return points[points.length - 1]!.clone();
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly hud: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  private readonly controls: OrbitControls;
  private readonly content = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly visualLayer = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly resize: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private readonly meshes: MeshService;
  private readonly ownsMeshes: boolean;
  private readonly geometryCache = new Map<string, ShapeGeometry & { triangles: number }>();
  private readonly materialCache = new Map<string, THREE.Material>();
  private readonly textureCache = new Map<string, Promise<THREE.Texture>>();
  private readonly modelCache = new Map<string, Promise<THREE.Object3D>>();
  private readonly scanCache = new WeakMap<ArrayBuffer, Promise<THREE.Object3D>>();
  private readonly cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  private readonly clipping = [this.cut];
  private anchors = new Map<string, AnchorInfo>();
  private visuals = new Map<string, VisualObject>();
  private lastVisuals: readonly Visual[] = [];
  private pickables: THREE.Object3D[] = [];
  private selection: THREE.Box3Helper | null = null;
  private flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    targetFrom: THREE.Vector3;
    targetTo: THREE.Vector3;
    start: number;
  } | null = null;
  private accent = new THREE.Color(0xc8f542);
  private cutHeight: number | null = null;
  private generation = 0;
  private framed = false;
  private disposed = false;
  private pointerDown: { x: number; y: number } | null = null;
  private hoverAt = 0;
  private stats: SceneStats = EMPTY_STATS;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: SceneViewOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // 背景透明，透出 .viewer 的背景（随深浅色主题变化）。
    this.renderer.setClearColor(0x000000, 0);
    // 剖切只作用在场景内容的材质上（虚拟区光效、标签不被切掉）。
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.className = 'viewer__canvas';
    this.renderer.domElement.setAttribute(
      'aria-label',
      '空间的三维视图：拖动旋转，滚轮或双指缩放，右键或双指拖动平移',
    );
    this.renderer.domElement.setAttribute('role', 'img');
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'viewer__labels';
    host.appendChild(this.labels.domElement);

    this.hud = document.createElement('ul');
    this.hud.className = 'viewer__hud';
    this.hud.setAttribute('aria-label', '空间状态');
    host.appendChild(this.hud);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'viewer__tooltip';
    this.tooltip.hidden = true;
    host.appendChild(this.tooltip);

    this.meshes = options.meshService ?? createMeshService();
    this.ownsMeshes = options.meshService === undefined;

    this.scene.add(new THREE.HemisphereLight(0xf4f1ea, 0x3a3d44, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 12, 8);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
    fill.position.set(-8, 6, -4);
    this.scene.add(fill);
    this.grid = new THREE.GridHelper(60, 60, 0x6b6f78, 0x3b3f48);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.45;
    // 放在地面板下面，避免和地面抢深度（z-fighting）。
    this.grid.position.y = -0.08;
    this.scene.add(this.grid, this.content, this.overlay, this.visualLayer);

    this.camera.position.set(8, 7, 11);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    // 触控：单指旋转，双指缩放加平移（OrbitControls 默认）。
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.target.set(3, 0.8, 2.5);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.body, { attributes: true });
    this.applyTheme();
    this.fit();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** 当前场景的统计（测试和端到端截图用来确认真的画出了东西）。 */
  getStats(): SceneStats {
    return this.stats;
  }

  /** 颜色跟着主题走：从 CSS 令牌读取强调色。 */
  private applyTheme(): void {
    const style = getComputedStyle(this.host);
    const accent = style.getPropertyValue('--accent').trim();
    if (accent !== '') {
      try {
        this.accent = new THREE.Color().setStyle(accent, THREE.SRGBColorSpace);
      } catch {
        // 解析不了的颜色格式保留原值。
      }
    }
    const dark = document.body.hasAttribute('data-ds-dark-theme');
    const gridMaterial = this.grid.material as THREE.Material;
    gridMaterial.opacity = dark ? 0.45 : 0.3;
    this.overlay.traverse((object) => {
      if (object.userData.accent === true) {
        const material = (object as THREE.Mesh).material as THREE.MeshBasicMaterial;
        material.color.copy(this.accent);
      }
    });
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
    if (this.flight !== null) {
      const t = Math.min(1, (performance.now() - this.flight.start) / 700);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.camera.position.lerpVectors(this.flight.from, this.flight.to, ease);
      this.controls.target.lerpVectors(this.flight.targetFrom, this.flight.targetTo, ease);
      if (t >= 1) this.flight = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------------------
  // 材质、贴图、模型
  // ---------------------------------------------------------------------------

  private texture(hash: string): Promise<THREE.Texture> | null {
    const load = this.options.loadTexture;
    if (load === undefined) return null;
    let texture = this.textureCache.get(hash);
    if (texture === undefined) {
      texture = load(hash).then((map) => {
        map.colorSpace = THREE.SRGBColorSpace;
        map.wrapS = THREE.RepeatWrapping;
        map.wrapT = THREE.RepeatWrapping;
        map.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        map.needsUpdate = true;
        return map;
      });
      this.textureCache.set(hash, texture);
      texture.catch(() => this.textureCache.delete(hash));
    }
    return texture;
  }

  /** 形状材质（按材质和"玻璃"共用一份）。 */
  private shapeMaterial(material: Material, glass: boolean): THREE.Material {
    const key = `${materialKey(material)}|${glass ? 'g' : 'o'}`;
    const cached = this.materialCache.get(key);
    if (cached !== undefined) return cached;
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
      const tint = material.tint ? srgb(material.tint) : new THREE.Color(0xffffff);
      // 贴图到之前先用色调的灰一点的版本占位。
      base.color = tint.clone().multiplyScalar(0.8);
      const texture = this.texture(material.texture);
      texture
        ?.then((map) => {
          if (this.disposed) return;
          base.map = map;
          base.color = tint;
          base.needsUpdate = true;
        })
        .catch(() => {
          base.color = tint;
        });
    } else {
      base.color = srgb(material.color);
    }
    this.materialCache.set(key, base);
    return base;
  }

  private voxelMaterial(part: VoxelPart): THREE.Material {
    const key = `voxel|${part.key}`;
    const cached = this.materialCache.get(key);
    if (cached !== undefined) return cached;
    let material: THREE.Material;
    if (part.kind === 'emissive') {
      // 发光方块不受光照，按方块颜色原样显示。
      material = new THREE.MeshBasicMaterial({ vertexColors: true, clippingPlanes: this.clipping });
    } else {
      const glass = part.kind === 'glass';
      const standard = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: glass ? 0.1 : 0.9,
        transparent: glass,
        opacity: glass ? 0.4 : 1,
        depthWrite: !glass,
        clippingPlanes: this.clipping,
      });
      if (part.texture !== undefined) {
        this.texture(part.texture)
          ?.then((map) => {
            if (this.disposed) return;
            standard.map = map;
            standard.needsUpdate = true;
          })
          .catch(() => undefined);
      }
      material = standard;
    }
    this.materialCache.set(key, material);
    return material;
  }

  /** glb → three.js 对象；材质都加上剖切平面。 */
  private parseGlb(bytes: ArrayBuffer, doubleSided: boolean): Promise<THREE.Object3D> {
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(
        bytes,
        '',
        (gltf) => {
          gltf.scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const material of materials) {
              if (doubleSided) material.side = THREE.DoubleSide;
              material.clippingPlanes = this.clipping;
            }
          });
          resolve(gltf.scene);
        },
        (error) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  private model(hash: string): Promise<THREE.Object3D> | null {
    const load = this.options.loadModel;
    if (load === undefined) return null;
    let model = this.modelCache.get(hash);
    if (model === undefined) {
      model = load(hash).then((bytes) => this.parseGlb(bytes, false));
      this.modelCache.set(hash, model);
      model.catch(() => this.modelCache.delete(hash));
    }
    return model;
  }

  /** 共用的模型实例：几何体和材质属于缓存，释放时跳过。 */
  private sharedClone(model: THREE.Object3D): THREE.Object3D {
    const clone = model.clone(true);
    clone.traverse((object) => {
      object.userData.sharedGeometry = true;
      object.userData.sharedMaterial = true;
    });
    return clone;
  }

  // ---------------------------------------------------------------------------
  // 内容
  // ---------------------------------------------------------------------------

  /**
   * 换内容。网格在后台线程里生成，生成好之前保留上一份内容，画面不闪；
   * 中途又来了新内容时，旧的一份生成完直接丢掉。
   */
  async setContent(content: SceneContent): Promise<void> {
    const generation = ++this.generation;
    const warnings: string[] = [];

    // 1. 收集要生成的形状（按局部形状去重，已经缓存的跳过）。
    const jobs = new Map<string, ShapeJob>();
    const plans = content.members.map((member) => {
      const entities = member.view.entities.map((entity) => {
        if (entity.shape === undefined) return { entity, key: null, matrix: null };
        const { local, matrix } = splitShape(entity.shape);
        const used = usedTemplates(local, member.view.templates);
        const key = geometryKey(local, used);
        if (!this.geometryCache.has(key) && !jobs.has(key)) {
          jobs.set(key, { key, shape: local, templates: used });
        }
        return { entity, key, matrix };
      });
      return { member, entities };
    });

    const report = this.options.onProgress;
    const voxelTotal = content.members.filter((m) => m.view.voxels.chunks.length > 0).length;
    const steps = jobs.size + voxelTotal;
    let shapesDone = 0;
    let voxelsDone = 0;
    const progress = (label: string) => {
      if (steps > 0) report?.({ label, done: shapesDone + voxelsDone, total: steps });
    };
    progress('生成网格');

    try {
      const [shapeResults, voxelResults, scans] = await Promise.all([
        this.meshes.shapes([...jobs.values()], (done) => {
          shapesDone = done;
          progress('生成网格');
        }),
        Promise.all(
          content.members.map(async (member) => {
            const result = await this.meshes.voxels(member.view.voxels);
            if (member.view.voxels.chunks.length > 0) {
              voxelsDone += 1;
              progress('生成方块');
            }
            return result;
          }),
        ),
        Promise.all(
          content.members.map(async (member) => {
            if (!member.view.showScan || !member.scan) return null;
            let parsed = this.scanCache.get(member.scan);
            if (parsed === undefined) {
              parsed = this.parseGlb(member.scan, true);
              this.scanCache.set(member.scan, parsed);
            }
            try {
              return await parsed;
            } catch (error) {
              warnings.push(`扫描模型解析失败：${String(error)}`);
              return null;
            }
          }),
        ),
      ]);
      if (this.disposed) return;
      for (const result of shapeResults) {
        const geometry = partsToGeometry(result.parts, result.warnings);
        this.geometryCache.set(result.key, { ...geometry, triangles: result.triangles });
      }
      if (generation !== this.generation) return;
      this.build(content, plans, voxelResults, scans, warnings);
    } finally {
      if (generation === this.generation) report?.(null);
    }
  }

  private build(
    content: SceneContent,
    plans: {
      member: MemberContent;
      entities: { entity: EntityBody; key: string | null; matrix: THREE.Matrix4 | null }[];
    }[],
    voxelResults: { parts: readonly VoxelPart[]; faceCount: number }[],
    scans: (THREE.Object3D | null)[],
    warnings: string[],
  ): void {
    disposeObject(this.content);
    disposeObject(this.overlay);
    this.content.clear();
    this.overlay.clear();
    this.clearVisuals();
    this.clearSelection();
    this.anchors = new Map();
    this.pickables = [];
    let triangles = 0;
    let instancedBatches = 0;
    let instancedEntities = 0;
    let textured = 0;
    let entityCount = 0;
    let voxelFaces = 0;
    let hasScan = false;
    const inUse = new Set<string>();

    plans.forEach(({ member, entities }, index) => {
      const group = placementGroup(member.placement);
      group.name = `member:${member.spaceId}`;
      this.content.add(group);
      const overlay = placementGroup(member.placement);
      this.overlay.add(overlay);

      // 物件：按（几何体，玻璃）分批，两个以上画成 InstancedMesh。
      const batches = new Map<
        string,
        { key: string; glass: boolean; items: { entity: EntityBody; matrix: THREE.Matrix4 }[] }
      >();
      for (const { entity, key, matrix } of entities) {
        if (key === null || matrix === null) continue;
        inUse.add(key);
        const glass = entity.props?.glass === true;
        const batchKey = `${key}|${glass}`;
        const batch = batches.get(batchKey) ?? { key, glass, items: [] };
        batch.items.push({ entity, matrix });
        batches.set(batchKey, batch);
      }
      for (const batch of batches.values()) {
        const built = this.geometryCache.get(batch.key);
        if (built === undefined) continue;
        for (const item of batch.items) {
          warnings.push(...built.warnings.map((w) => `${item.entity.entityId}：${w}`));
        }
        if (built.geometry.index === null || built.geometry.index.count === 0) continue;
        const materials = built.materials.map((m) => this.shapeMaterial(m, batch.glass));
        textured += built.materials.filter(isTextureMaterial).length;
        const payload = batch.items.map((item) => ({
          spaceId: member.spaceId,
          entity: item.entity,
        }));
        let mesh: THREE.Mesh;
        if (batch.items.length > 1) {
          const instanced = new THREE.InstancedMesh(built.geometry, materials, batch.items.length);
          batch.items.forEach((item, i) => instanced.setMatrixAt(i, item.matrix));
          instanced.instanceMatrix.needsUpdate = true;
          instanced.computeBoundingSphere();
          instanced.computeBoundingBox();
          mesh = instanced;
          instancedBatches += 1;
          instancedEntities += batch.items.length;
        } else {
          mesh = new THREE.Mesh(built.geometry, materials);
          mesh.matrixAutoUpdate = false;
          mesh.matrix.copy(batch.items[0]!.matrix);
        }
        mesh.userData = { sharedGeometry: true, sharedMaterial: true, entities: payload };
        mesh.name = batch.items.map((item) => item.entity.entityId).join(',');
        if (batch.glass) mesh.renderOrder = 2;
        group.add(mesh);
        this.pickables.push(mesh);
        triangles += (built.geometry.index.count / 3) * batch.items.length;
        entityCount += batch.items.length;
      }

      // 只有处理后模型（assetHash）的物件：按包围盒的底面中心摆放。
      for (const { entity } of entities) {
        if (entity.shape !== undefined || entity.assetHash === undefined) continue;
        entityCount += 1;
        const holder = new THREE.Group();
        holder.userData = { entities: [{ spaceId: member.spaceId, entity }] };
        if (entity.bounds) {
          holder.position.set(
            (entity.bounds.min[0] + entity.bounds.max[0]) / 2,
            entity.bounds.min[1],
            (entity.bounds.min[2] + entity.bounds.max[2]) / 2,
          );
        }
        group.add(holder);
        this.pickables.push(holder);
        this.model(entity.assetHash)
          ?.then((model) => {
            if (!this.disposed && holder.parent !== null) holder.add(this.sharedClone(model));
          })
          .catch(() => warnings.push(`${entity.entityId}：模型下载失败`));
      }

      // 方块。
      const voxels = voxelResults[index]!;
      voxelFaces += voxels.faceCount;
      for (const part of voxels.parts) {
        if (part.indices.length === 0) continue;
        const mesh = new THREE.Mesh(voxelGeometry(part), this.voxelMaterial(part));
        mesh.userData.sharedMaterial = true;
        mesh.name = `voxels:${part.key}`;
        if (part.kind === 'glass') mesh.renderOrder = 3;
        if (part.texture !== undefined) textured += 1;
        group.add(mesh);
        triangles += part.indices.length / 3;
      }

      // 扫描。
      const scan = scans[index];
      if (scan) {
        hasScan = true;
        const instance = scan.clone(true);
        instance.traverse((object) => {
          object.userData.sharedGeometry = true;
          object.userData.sharedMaterial = true;
        });
        instance.userData.shared = true;
        if (member.scanTransform && member.scanTransform.length === 16) {
          instance.matrixAutoUpdate = false;
          instance.matrix.fromArray(member.scanTransform as number[]);
        }
        instance.name = 'scan';
        group.add(instance);
        instance.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) triangles += (mesh.geometry.index?.count ?? 0) / 3;
        });
      }

      this.buildOverlay(member, overlay, content.members.length > 1);
    });

    this.links = content.links;
    this.buildLinks(content);

    // 缓存只保留最近的一批，时间轴来回拖动时不会无限增长；正在用的不清。
    if (this.geometryCache.size > 400) {
      for (const [key, cached] of this.geometryCache) {
        if (this.geometryCache.size <= 300) break;
        if (inUse.has(key)) continue;
        cached.geometry.dispose();
        this.geometryCache.delete(key);
      }
    }

    this.stats = {
      entities: entityCount,
      triangles,
      voxelFaces,
      hasScan,
      instancedBatches,
      instancedEntities,
      textured,
      threaded: this.meshes.threaded,
      members: content.members.length,
      warnings,
    };
    this.applyCut();
    this.setVisuals(this.lastVisuals);
    if (!this.framed) this.frameContent();
    this.host.dataset.triangles = String(Math.round(triangles));
  }

  /** 成员的锚点、虚拟区光效、组合里的成员名。 */
  private buildOverlay(member: MemberContent, overlay: THREE.Group, universe: boolean): void {
    const placement = member.placement;
    for (const region of member.view.virtualRegions) {
      for (const box of region.boxes) {
        const min = new THREE.Vector3(box[0], box[1], box[2]).multiplyScalar(GRID_UNIT);
        const max = new THREE.Vector3(box[3], box[4], box[5]).multiplyScalar(GRID_UNIT);
        const size = new THREE.Vector3().subVectors(max, min);
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
        const shell = new THREE.BoxGeometry(size.x, size.y, size.z);
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(shell),
          new THREE.LineBasicMaterial({ color: this.accent, transparent: true, opacity: 0.9 }),
        );
        edges.userData.accent = true;
        edges.position.copy(center);
        const glow = new THREE.Mesh(
          shell,
          new THREE.MeshBasicMaterial({
            color: this.accent,
            transparent: true,
            opacity: 0.07,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        glow.userData.accent = true;
        glow.position.copy(center);
        const tag = document.createElement('div');
        tag.className = 'viewer__virtual-tag';
        const name = displayName(region);
        tag.textContent = name ? `虚拟 · ${name}` : '虚拟';
        const label = new CSS2DObject(tag);
        label.position.set(center.x, max.y + 0.15, center.z);
        overlay.add(edges, glow, label);
      }
    }

    // 挂在锚点上的物件包围盒（高亮用）。
    const bounds = new Map<string, THREE.Box3>();
    for (const entity of member.view.entities) {
      if (entity.anchorId === undefined || entity.bounds === undefined) continue;
      const box = new THREE.Box3();
      for (const x of [entity.bounds.min[0], entity.bounds.max[0]]) {
        for (const y of [entity.bounds.min[1], entity.bounds.max[1]]) {
          for (const z of [entity.bounds.min[2], entity.bounds.max[2]]) {
            box.expandByPoint(new THREE.Vector3(...placePoint(placement, [x, y, z])));
          }
        }
      }
      const existing = bounds.get(entity.anchorId);
      bounds.set(entity.anchorId, existing ? existing.union(box) : box);
    }

    for (const anchor of member.view.anchors) {
      const local = anchorPosition(anchor);
      const ref = { spaceId: member.spaceId, anchorId: anchor.anchorId };
      const label = anchor.label ?? anchor.anchorId;
      let element: HTMLElement | null = null;
      let world: THREE.Vector3 | null = null;
      if (local !== null) {
        world = new THREE.Vector3(...placePoint(placement, local));
        element = document.createElement('div');
        element.className = 'viewer__anchor';
        element.dataset.anchorId = anchor.anchorId;
        element.dataset.spaceId = member.spaceId;
        element.textContent = label;
        const object = new CSS2DObject(element);
        object.position.set(...local);
        overlay.add(object);
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.035, 12, 8),
          // 锚点圆点和标签一样，在剖切高度以上时不显示。
          new THREE.MeshBasicMaterial({ color: this.accent, clippingPlanes: this.clipping }),
        );
        marker.userData.accent = true;
        marker.position.set(...local);
        overlay.add(marker);
      }
      this.anchors.set(anchorKey(ref), {
        ref,
        anchor,
        world,
        element,
        label,
        bounds: bounds.get(anchor.anchorId) ?? null,
        memberName: member.name,
      });
    }

    if (universe && member.name) {
      const box = new THREE.Box3();
      for (const entity of member.view.entities) {
        if (entity.bounds) {
          box.expandByPoint(new THREE.Vector3(...entity.bounds.min));
          box.expandByPoint(new THREE.Vector3(...entity.bounds.max));
        }
      }
      if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 2.5, 3));
      const tag = document.createElement('div');
      tag.className = 'viewer__member-tag';
      tag.textContent = member.name;
      const object = new CSS2DObject(tag);
      const center = box.getCenter(new THREE.Vector3());
      object.position.set(center.x, box.max.y + 0.5, center.z);
      overlay.add(object);
    }
  }

  /** 组合的连接：两端锚点画连接标识和一条弧线，点击标识飞到另一端。 */
  private buildLinks(content: SceneContent): void {
    for (const link of content.links) {
      const from = this.anchors.get(anchorKey(link.from));
      const to = this.anchors.get(anchorKey(link.to));
      if (from?.world == null || to?.world == null) continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(arcPoints(from.world, to.world, 24)),
        new THREE.LineDashedMaterial({
          color: this.accent,
          dashSize: 0.25,
          gapSize: 0.15,
          transparent: true,
          opacity: 0.8,
        }),
      );
      line.computeLineDistances();
      line.userData.accent = true;
      this.overlay.add(line);
      for (const [here, there] of [
        [from, to],
        [to, from],
      ] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'viewer__link';
        button.dataset.kind = link.kind;
        button.textContent = `${{ door: '门', portal: '传送门', street: '街道' }[link.kind] ?? '连接'} → ${there.memberName ?? there.ref.spaceId}`;
        button.title = `飞到 ${there.memberName ?? there.ref.spaceId} 的 ${there.label}`;
        button.addEventListener('click', () => this.flyTo(there.world!));
        const object = new CSS2DObject(button);
        object.position.copy(here.world!).add(new THREE.Vector3(0, 0.45, 0));
        this.overlay.add(object);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 事件可视化
  // ---------------------------------------------------------------------------

  private clearVisuals(): void {
    for (const visual of this.visuals.values()) {
      for (const object of visual.objects) {
        disposeObject(object);
        object.removeFromParent();
      }
    }
    this.visuals.clear();
    this.hud.replaceChildren();
    for (const info of this.anchors.values()) {
      if (info.element) {
        info.element.classList.remove('is-active');
        info.element.style.removeProperty('--event-color');
        info.element.textContent = info.label;
      }
    }
  }

  /** 事件可视化：按编号复用对象，T 变化时只更新位置和进度。 */
  setVisuals(visuals: readonly Visual[]): void {
    this.lastVisuals = visuals;
    if (this.disposed) return;
    const seen = new Set<string>();
    const highlights = new Map<string, { color: readonly number[]; texts: string[] }>();
    const hudItems: { key: string; text: string; color: readonly number[]; icon?: string }[] = [];

    for (const visual of visuals) {
      if (visual.kind === 'path') {
        seen.add(visual.id);
        this.upsertPath(visual);
        continue;
      }
      const info = this.anchors.get(anchorKey(visual.anchor));
      if (info === undefined) continue;
      if (info.world === null) {
        // 空间级锚点（营业状态这类）没有位置，放在左上角的状态栏里。
        if (visual.kind === 'label' || visual.kind === 'highlight' || visual.kind === 'icon') {
          const text = visual.text ?? visual.type;
          hudItems.push({
            key: visual.id,
            text: info.memberName ? `${info.memberName}：${text}` : text,
            color: visual.color,
            icon: visual.kind === 'icon' ? visual.icon : undefined,
          });
        }
        continue;
      }
      if (visual.kind === 'highlight') {
        const key = anchorKey(visual.anchor);
        const entry = highlights.get(key) ?? { color: visual.color, texts: [] };
        if (visual.text) entry.texts.push(visual.text);
        highlights.set(key, entry);
      }
      seen.add(visual.id);
      const existing = this.visuals.get(visual.id);
      if (existing) existing.update(visual);
      else {
        const created = this.createVisual(visual, info);
        if (created) this.visuals.set(visual.id, created);
      }
    }

    for (const [id, visual] of this.visuals) {
      if (seen.has(id)) continue;
      for (const object of visual.objects) {
        disposeObject(object);
        object.removeFromParent();
      }
      this.visuals.delete(id);
    }

    // 锚点标签：处于状态里的高亮，并显示状态文本（纯文本）。
    for (const [key, info] of this.anchors) {
      if (info.element === null) continue;
      const highlight = highlights.get(key);
      info.element.classList.toggle('is-active', highlight !== undefined);
      if (highlight) {
        info.element.style.setProperty('--event-color', cssColor(highlight.color));
        info.element.textContent =
          highlight.texts.length > 0 ? `${info.label} · ${highlight.texts.join('，')}` : info.label;
      } else {
        info.element.style.removeProperty('--event-color');
        info.element.textContent = info.label;
      }
    }

    this.hud.replaceChildren(
      ...hudItems.map((item) => {
        const li = document.createElement('li');
        li.className = 'viewer__hud-item';
        li.style.setProperty('--event-color', cssColor(item.color));
        if (item.icon) li.appendChild(iconElement(item.icon));
        const span = document.createElement('span');
        span.textContent = item.text;
        li.appendChild(span);
        return li;
      }),
    );
    this.hud.hidden = hudItems.length === 0;
    this.host.dataset.visuals = String(this.visuals.size + hudItems.length);
    this.applyCut();
  }

  private eventTag(className: string, color: readonly number[], icon?: string, text?: string) {
    const element = document.createElement('div');
    element.className = className;
    element.style.setProperty('--event-color', cssColor(color));
    if (icon) element.appendChild(iconElement(icon));
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      element.appendChild(span);
    }
    return element;
  }

  private createVisual(visual: Visual, info: AnchorInfo): VisualObject | null {
    const world = info.world!;
    switch (visual.kind) {
      case 'highlight': {
        const box = info.bounds?.clone().expandByScalar(0.04);
        const geometry = box
          ? new THREE.BoxGeometry(...box.getSize(new THREE.Vector3()).toArray())
          : new THREE.CylinderGeometry(0.35, 0.35, 0.02, 32);
        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: srgb(visual.color),
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            clippingPlanes: this.clipping,
          }),
        );
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry),
          new THREE.LineBasicMaterial({ color: srgb(visual.color), clippingPlanes: this.clipping }),
        );
        if (box) {
          const center = box.getCenter(new THREE.Vector3());
          mesh.position.copy(center);
          edges.position.copy(center);
        } else {
          mesh.position.set(world.x, world.y - 0.4, world.z);
          edges.position.copy(mesh.position);
        }
        mesh.name = `highlight:${visual.id}`;
        this.visualLayer.add(mesh, edges);
        return {
          objects: [mesh, edges],
          update: (next) => {
            const color = srgb(next.color);
            (mesh.material as THREE.MeshBasicMaterial).color.copy(color);
            (edges.material as THREE.LineBasicMaterial).color.copy(color);
          },
        };
      }
      case 'icon':
      case 'label': {
        const element = this.eventTag(
          visual.kind === 'icon' ? 'viewer__event viewer__event--icon' : 'viewer__event',
          visual.color,
          visual.kind === 'icon' ? visual.icon : undefined,
          visual.text,
        );
        element.dataset.visual = visual.kind;
        element.dataset.type = visual.type;
        const object = new CSS2DObject(element);
        object.position
          .copy(world)
          .add(new THREE.Vector3(0, visual.kind === 'icon' ? 0.4 : 0.6, 0));
        this.visualLayer.add(object);
        return { objects: [object], update: () => undefined };
      }
      case 'spawn': {
        const holder = new THREE.Group();
        holder.position.copy(world);
        holder.name = `spawn:${visual.id}`;
        this.visualLayer.add(holder);
        this.model(visual.asset)
          ?.then((model) => {
            if (!this.disposed && holder.parent !== null) holder.add(this.sharedClone(model));
          })
          .catch(() => undefined);
        return { objects: [holder], update: () => undefined };
      }
      case 'heat': {
        // 柔和的圆斑：中心不透明、边缘透明（顶点颜色带透明度）。
        const geometry = new THREE.CircleGeometry(0.75, 48);
        geometry.rotateX(-Math.PI / 2);
        const count = geometry.getAttribute('position').count;
        const colors = new Float32Array(count * 4);
        const base = srgb(visual.color);
        for (let i = 0; i < count; i += 1) {
          colors.set([base.r, base.g, base.b, i === 0 ? 1 : 0], i * 4);
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
        const material = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const disc = new THREE.Mesh(geometry, material);
        // 贴在锚点所在空间的地面上。
        const floor = this.memberFloor(visual.anchor.spaceId);
        disc.position.set(world.x, floor + 0.02, world.z);
        disc.renderOrder = 4;
        disc.name = `heat:${visual.id}`;
        const apply = (next: Visual) => {
          if (next.kind !== 'heat') return;
          disc.scale.setScalar(0.45 + 0.55 * next.intensity);
          material.opacity = 0.25 + 0.6 * next.intensity;
        };
        apply(visual);
        this.visualLayer.add(disc);
        return { objects: [disc], update: apply };
      }
      default:
        return null;
    }
  }

  private memberFloor(spaceId: string): number {
    for (const group of this.content.children) {
      if (group.name === `member:${spaceId}`) return group.position.y;
    }
    return 0;
  }

  /** 路线：沿连接走最短路径（经过每条连接两端的锚点），没有连接就画弧线；不完整时只在起点显示图标。 */
  private routePoints(
    from: AnchorInfo,
    to: AnchorInfo,
    links: readonly LinkLike[],
  ): THREE.Vector3[] {
    const hops = linkRoute(from.ref.spaceId, to.ref.spaceId, links);
    if (hops === null || hops.length === 0) {
      if (from.ref.spaceId === to.ref.spaceId) {
        const lift = new THREE.Vector3(0, 0.2, 0);
        return arcPoints(from.world!.clone().add(lift), to.world!.clone().add(lift), 24);
      }
      return arcPoints(from.world!, to.world!, 48);
    }
    const waypoints: THREE.Vector3[] = [from.world!];
    for (const hop of hops) {
      const exit = this.anchors.get(anchorKey(hop.exit))?.world;
      const enter = this.anchors.get(anchorKey(hop.enter))?.world;
      if (exit) waypoints.push(exit);
      if (enter) waypoints.push(enter);
    }
    waypoints.push(to.world!);
    const points: THREE.Vector3[] = [];
    for (let i = 1; i < waypoints.length; i += 1) {
      const segment = arcPoints(waypoints[i - 1]!, waypoints[i]!, 16);
      points.push(...(i === 1 ? segment : segment.slice(1)));
    }
    return points;
  }

  private links: readonly LinkLike[] = [];

  private upsertPath(visual: Extract<Visual, { kind: 'path' }>): void {
    const from = visual.from ? this.anchors.get(anchorKey(visual.from)) : undefined;
    const to = visual.to ? this.anchors.get(anchorKey(visual.to)) : undefined;
    const signature = `${from?.world ? anchorKey(from.ref) : ''}>${to?.world ? anchorKey(to.ref) : ''}`;
    let existing = this.visuals.get(visual.id) as
      (VisualObject & { signature?: string }) | undefined;
    if (existing && existing.signature !== signature) {
      for (const object of existing.objects) {
        disposeObject(object);
        object.removeFromParent();
      }
      this.visuals.delete(visual.id);
      existing = undefined;
    }
    if (existing) {
      existing.update(visual);
      return;
    }
    const objects: THREE.Object3D[] = [];
    let update: (next: Visual) => void = () => undefined;
    if (from?.world && to?.world) {
      const points = this.routePoints(from, to, this.links);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: srgb(visual.color), transparent: true, opacity: 0.9 }),
      );
      line.name = `path:${visual.correlationId}`;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 12),
        new THREE.MeshBasicMaterial({ color: srgb(visual.color) }),
      );
      const tag = this.eventTag(
        'viewer__event viewer__event--icon',
        visual.color,
        visual.icon,
        visual.text,
      );
      tag.dataset.visual = 'path';
      tag.dataset.type = visual.type;
      const label = new CSS2DObject(tag);
      objects.push(line, marker, label);
      update = (next) => {
        if (next.kind !== 'path') return;
        const position = polylineAt(points, next.progress ?? 0);
        marker.position.copy(position);
        label.position.copy(position).add(new THREE.Vector3(0, 0.3, 0));
      };
    } else {
      // 不完整：只在有位置的那一端显示图标。
      const end = from?.world ? from : to?.world ? to : undefined;
      if (end === undefined) return;
      const tag = this.eventTag(
        'viewer__event viewer__event--icon',
        visual.color,
        visual.icon,
        visual.text,
      );
      tag.dataset.visual = 'path';
      tag.dataset.type = visual.type;
      tag.dataset.pending = from?.world ? 'origin' : 'destination';
      const label = new CSS2DObject(tag);
      label.position.copy(end.world!).add(new THREE.Vector3(0, 0.4, 0));
      objects.push(label);
    }
    this.visualLayer.add(...objects);
    const created: VisualObject & { signature: string } = { objects, update, signature };
    update(visual);
    this.visuals.set(visual.id, created);
  }

  // ---------------------------------------------------------------------------
  // 相机、剖切、点选
  // ---------------------------------------------------------------------------

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

  /** 镜头飞到某一点（连接的另一端）。 */
  flyTo(point: THREE.Vector3): void {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    offset.setLength(Math.min(offset.length(), 6));
    this.flight = {
      from: this.camera.position.clone(),
      to: point.clone().add(offset),
      targetFrom: this.controls.target.clone(),
      targetTo: point.clone(),
      start: performance.now(),
    };
    this.host.dataset.flyTarget = point
      .toArray()
      .map((v) => v.toFixed(2))
      .join(',');
  }

  /** 剖切：切掉 height 以上的内容；null 表示不剖切。 */
  setCutaway(height: number | null): void {
    this.cutHeight = height;
    this.applyCut();
  }

  private applyCut(): void {
    // 所有内容材质共用同一个平面对象，只改常数，不用重新编译着色器。
    this.cut.constant = this.cutHeight ?? 1e6;
    const hidden = (y: number) => this.cutHeight !== null && y > this.cutHeight + 0.3;
    for (const info of this.anchors.values()) {
      if (info.element && info.world) info.element.hidden = hidden(info.world.y);
    }
  }

  private raycast(event: PointerEvent): Selection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.camera);
    const hits = raycaster.intersectObjects(this.pickables, true);
    for (const hit of hits) {
      // 剖切掉的部分点不到。
      if (this.cutHeight !== null && hit.point.y > this.cutHeight) continue;
      let object: THREE.Object3D | null = hit.object;
      while (object !== null && object.userData.entities === undefined) object = object.parent;
      const entities = object?.userData.entities as Selection[] | undefined;
      if (entities === undefined) continue;
      const index = hit.instanceId ?? 0;
      return entities[index] ?? entities[0] ?? null;
    }
    return null;
  }

  private clearSelection(): void {
    if (this.selection) {
      this.selection.removeFromParent();
      this.selection.dispose();
      this.selection = null;
    }
  }

  /** 选中的物件画一个包围盒。 */
  select(selection: Selection | null): void {
    this.clearSelection();
    if (selection === null || selection.entity.bounds === undefined) return;
    const group = this.content.children.find((g) => g.name === `member:${selection.spaceId}`);
    const box = new THREE.Box3(
      new THREE.Vector3(...selection.entity.bounds.min),
      new THREE.Vector3(...selection.entity.bounds.max),
    );
    if (group) box.applyMatrix4(group.matrixWorld);
    this.selection = new THREE.Box3Helper(box, this.accent);
    this.visualLayer.add(this.selection);
  }

  private onPointerDown = (event: PointerEvent) => {
    this.pointerDown = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (down === null || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const picked = this.raycast(event);
    this.select(picked);
    this.options.onSelect?.(picked);
  };

  /** 悬浮标签：props.label（保留键），没有时用物件的 label。 */
  private onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || this.pointerDown !== null) return;
    const now = performance.now();
    if (now - this.hoverAt < 80) return;
    this.hoverAt = now;
    const picked = this.raycast(event);
    const text = picked
      ? ((typeof picked.entity.props?.label === 'string' ? picked.entity.props.label : undefined) ??
        picked.entity.label)
      : undefined;
    if (text === undefined) {
      this.tooltip.hidden = true;
      return;
    }
    const rect = this.host.getBoundingClientRect();
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${event.clientX - rect.left + 12}px`;
    this.tooltip.style.top = `${event.clientY - rect.top + 12}px`;
    this.tooltip.hidden = false;
  };

  private onPointerLeave = () => {
    this.tooltip.hidden = true;
  };

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.themeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.controls.dispose();
    this.clearVisuals();
    this.clearSelection();
    disposeObject(this.content);
    disposeObject(this.overlay);
    for (const { geometry } of this.geometryCache.values()) geometry.dispose();
    this.geometryCache.clear();
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
    for (const texture of this.textureCache.values()) {
      texture.then((t) => t.dispose()).catch(() => undefined);
    }
    if (this.ownsMeshes) this.meshes.dispose();
    this.renderer.dispose();
    canvas.remove();
    this.labels.domElement.remove();
    this.hud.remove();
    this.tooltip.remove();
  }
}

type LinkLike = Parameters<typeof linkRoute>[2][number];
