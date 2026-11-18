import { externalContentOf } from '../core/externalSource';
import { FirstPersonView, type CameraPerspective } from './cameraPerspective';
import { attachCameraNavigation, type CameraStep } from './cameraNavigation';
import { ExternalContentView } from './externalContentView';
import * as THREE from 'three';
import type { CameraAction } from '../workspace/viewerActions';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { displayName, type Anchor, type EntityBody } from '../core/api/types';
import { GRID_UNIT } from '../core/chunk';
import {
  anchorPosition,
  isBackgroundEntity,
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
import { materialKey, shapeBounds } from '../core/shapes/build';
import type { VoxelPart, VoxelSource } from '../core/voxels';
import { sha256Hex } from '../core/hash';
import { anchorKey, linkRoute, type AnchorRef, type Visual } from '../core/visuals';
import {
  type FrameOptions,
  backgroundFarPlane,
  clipBox,
  frameBox,
  scanCeilingHeight,
  scanFrameBox,
} from './framing';
import { iconElement } from './icons';
import { createLights } from './lighting';
import {
  LABEL_PADDING,
  MIN_SCREEN_SIZE,
  anchorLabelPriority,
  EVENT_PRIORITY,
  layoutLabels,
  maxLabelsFor,
  type LabelCandidate,
} from './labelLayout';
import {
  bakeInPlace,
  createModelMaterial,
  createShapeMaterial,
  modelMaterialKey,
  srgb,
  TextureCache,
  type MaterialContext,
  type TextureRole,
} from './materials';
import { applyStyleLook } from './materials';
import { styleLookKey, type StyleLook } from '../core/styles';
import { createMeshService, type MeshService } from './meshService';
import { fitModelInto, measureModel, modelFit, modelFitWarning, type BoxLike } from './modelFit';
import { placedModelBox, placeRotatedModel } from './modelPlacement';
import type { ShapeJob, ShapeJobResult } from './meshJobs';
import { backgroundLandmark, backgroundView } from './background';
import { environmentOf } from '../core/environment';
import { EnvironmentView } from './environmentView';

/**
 * 只读查看器的 three.js 场景。React 组件（Viewer.tsx）只负责挂载和传参，
 * 渲染、相机、剖切、标签、事件可视化都在这里。
 *
 * - 物件：形状词表 → 网格在后台线程里生成（meshService），主线程只组装 BufferGeometry；
 *   最外层的 transform 拆出来当实例矩阵，同样的局部形状（同款椅子）共用一份几何体，
 *   两个以上时画成 InstancedMesh；
 * - 材质：颜色或贴图（按资源哈希下载，uv 投影和平铺在网格生成时算好，tint 作颜色）；着色方式
 *   `baked`（默认）的贴图材质一部分按自发光显示，亮度接近不打光的原始扫描，`albedo` 完整受光，
 *   可带法线、粗糙度贴图（materials.ts）；
 * - 灯光：半球光 + 主光 + 补光，强度按物理单位（π 的倍数，lighting.ts）；
 * - 物件模型：按 `bounds` 的底面中心摆放，实际比 `bounds` 大时等比缩进去（modelFit.ts）；
 * - 方块：叠加后的区块 → 可见面网格（后台线程），玻璃半透明、发光方块不受光照、贴图方块按贴图分块；
 * - 扫描：网页用 glb，按对齐变换（列主序 4×4）摆放；
 * - 组合：每个成员一组，按摆放（先绕 y 轴旋转、再平移）放进同一场景；连接画出来，点击飞到另一端；
 * - 虚拟区：边界光效 + "虚拟"标签；事件：高亮、图标、标签、路线、生成物件、热力；
 * - 锚点：纯文本标签，默认只显示有意义的几类，屏幕上避让、远处隐藏、总数有上限，
 *   悬停 / 点按时显示，可切换为显示更多（取舍规则见 labelLayout.ts）；
 * - 镜头：按实体区里内容的包围盒取景（framing.ts），斜上方 45° 俯视，房间占满画面；
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
  readonly onPerspectiveChange?: (mode: CameraPerspective) => void;
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
  /** 原始视图里扫描天花板的高度（米，见 framing.ts 的 scanCeilingHeight）；没有扫描或没扫到天花板时是 null。 */
  readonly scanCeiling: number | null;
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
  scanCeiling: null,
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
  /** 锚点覆盖的范围（世界坐标）：锚点自己的格子盒，没有就用挂在上面的物件；用来估计屏幕上的大小。 */
  readonly extent: THREE.Box3 | null;
  readonly memberName?: string;
}

/** 一个成员的取景来源：内容所在的组、取景范围（世界坐标）、只有模型的物件的包围盒、扫描。 */
interface FrameSource {
  readonly group: THREE.Object3D;
  readonly clips: readonly THREE.Box3[];
  readonly extraBoxes: readonly THREE.Box3[];
  /** 背景只用于远裁面，模型尚未下载时也能保留完整的窗外视距。 */
  readonly backgroundBoxes: readonly THREE.Box3[];
  /** 原始视图的扫描模型（组里的那一份）；取景用它表面的 2%–98% 分位包围盒，不用外包盒。 */
  readonly scan: THREE.Object3D | null;
}

/** 没有范围的锚点按这么大（米）估计屏幕上的大小。 */
const NOMINAL_ANCHOR_SIZE = 0.6;

interface VisualObject {
  readonly objects: THREE.Object3D[];
  update(visual: Visual): void;
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

/** 按图层、坐标、内容哈希、区域过滤和调色板复用体素几何，不包含样式外观。 */
function voxelGeometryKey(source: VoxelSource): string {
  return JSON.stringify([
    source.chunks.map(({ layer, cx, cy, cz, cells }) => [
      layer,
      cx,
      cy,
      cz,
      sha256Hex(new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength)),
    ]),
    source.keepBoxes,
    source.palette,
  ]);
}

interface VoxelGeometry {
  readonly parts: readonly { part: VoxelPart; geometry: THREE.BufferGeometry }[];
  readonly faceCount: number;
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
  private firstPerson: FirstPersonView | null = null;
  private readonly navigation: ReturnType<typeof attachCameraNavigation>;
  private readonly content = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly visualLayer = new THREE.Group();
  private readonly grid: THREE.GridHelper;
  private readonly resize: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private readonly meshes: MeshService;
  private readonly ownsMeshes: boolean;
  private readonly geometryCache = new Map<string, ShapeGeometry & { triangles: number }>();
  private readonly shapePending = new Map<string, Promise<void>>();
  private readonly voxelCache = new Map<
    string,
    { pending: Promise<VoxelGeometry>; result?: VoxelGeometry }
  >();
  private readonly materialCache = new Map<string, THREE.Material>();
  private readonly textures: TextureCache;
  private readonly environment: EnvironmentView;
  private readonly externalContent: ExternalContentView;
  private lights: THREE.Light[] = [];
  private readonly modelCache = new Map<string, Promise<THREE.Object3D>>();
  private readonly scanCache = new WeakMap<ArrayBuffer, Promise<THREE.Object3D>>();
  private readonly modelBoxes = new WeakMap<THREE.Object3D, BoxLike | null>();
  private readonly cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  private readonly clipping = [this.cut];
  private readonly materialContext: MaterialContext = {
    texture: (hash, role) => this.texture(hash, role),
    clipping: this.clipping,
    alive: () => !this.disposed,
  };
  private anchors = new Map<string, AnchorInfo>();
  private visuals = new Map<string, VisualObject>();
  private lastVisuals: readonly Visual[] = [];
  private pickables: THREE.Object3D[] = [];
  private selection: THREE.Box3Helper | null = null;
  private flight: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    rotationFrom: THREE.Quaternion;
    rotationTo: THREE.Quaternion;
    distanceFrom: number;
    targetTo: THREE.Vector3;
    zoomFrom: number;
    elapsed: number;
    lastFrame: number;
    duration: number;
  } | null = null;
  private accent = new THREE.Color(0xc8f542);
  private cutHeight: number | null = null;
  private generation = 0;
  private framed = false;
  /** 镜头还停在自动取景的位置（用户没动过）：画面大小变了、换了视图时重新取景。 */
  private autoFramed = false;
  private lastMode: SceneContent['mode'] | null = null;
  private lastSpaces = '';
  private frameSources: FrameSource[] = [];
  private distanceObjects: {
    object: THREE.Object3D;
    focus: THREE.Vector3;
    min: number;
    max: number;
  }[] = [];
  private landmarks: { object: CSS2DObject; focus: THREE.Vector3; min: number; max: number }[] = [];
  private overviewBox: {
    box: THREE.Box3;
    framing?: Pick<FrameOptions, 'azimuths' | 'elevation'>;
  } | null = null;
  /** 扫描的取景包围盒，按组里的那一份缓存（换了内容那一份就没人引用了）。 */
  private readonly scanBoxes = new WeakMap<THREE.Object3D, THREE.Box3>();
  private disposed = false;
  private pointerDown: { x: number; y: number } | null = null;
  /** 悬停：最多每 80 毫秒处理一次，处理的总是最后一个位置（尾随节流）。 */
  private hoverAt = 0;
  private hoverPoint: { readonly clientX: number; readonly clientY: number } | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private stats: SceneStats = EMPTY_STATS;
  /** 标签密度与交互状态。 */
  private moreLabels = false;
  private hoverAnchor: string | null = null;
  private focusedAnchorKey: string | null = null;
  private eventAnchors = new Set<string>();
  private labelsDirty = true;
  private readonly labelCamera = new THREE.Matrix4();
  private readonly labelProjection = new THREE.Matrix4();

  constructor(
    private readonly host: HTMLElement,
    private readonly options: SceneViewOptions = {},
  ) {
    // 对数深度让厘米级室内和地球远景共享深度缓冲，不用近共面的叠加网格补海面。
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // 背景透明，透出 .viewer 的背景（随深浅色主题变化）。
    this.renderer.setClearColor(0x000000, 0);
    // 剖切只作用在场景内容的材质上（虚拟区光效、标签不被切掉）。
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.className = 'viewer__canvas';
    const canvas = this.renderer.domElement;
    canvas.title =
      '点击画布后用 WASD 或方向键移动，Q 下降，E 上升。拖动旋转，右键拖动平移，滚轮或双指捏合缩放。';
    canvas.setAttribute('aria-label', '空间的三维视图。' + canvas.title);
    canvas.setAttribute('role', 'group');
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
    this.textures = new TextureCache(
      options.loadTexture,
      () => Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
      (count) => {
        if (!this.disposed) host.dataset.texturesPending = String(count);
      },
    );
    this.environment = new EnvironmentView(this.scene, host, options.loadTexture);
    this.externalContent = new ExternalContentView(this.scene, this.host);

    // 灯光按物理单位设置（强度是 π 的倍数），见 lighting.ts。
    this.lights = createLights();
    this.scene.add(...this.lights);
    this.grid = new THREE.GridHelper(60, 60, 0x6b6f78, 0x3b3f48);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.45;
    // 放在地面板下面，避免和地面抢深度（z-fighting）。
    this.grid.position.y = -0.08;
    this.scene.add(this.grid, this.content, this.overlay, this.visualLayer);

    this.camera.position.set(8, 7, 11);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = 0.1;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    // 触控：单指旋转，双指缩放加平移（OrbitControls 默认）。
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.target.set(3, 0.8, 2.5);
    // 用户动了镜头以后，不再自动重新取景。
    this.controls.addEventListener('start', this.onControlsStart);

    this.navigation = attachCameraNavigation(canvas, this.controls, this.onControlsStart);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.labels.domElement.addEventListener('wheel', this.onLabelWheel, { passive: false });
    host.addEventListener('pointermove', this.onPointerMove);
    host.addEventListener('pointerleave', this.onPointerLeave);

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
    this.labelsDirty = true;
    // 画面大小变了（转屏、页头换行）而镜头还是自动取景的：按新的宽高比重新取景。
    if (this.autoFramed) this.frameContent(false);
  }

  private frame(): void {
    if (this.disposed) return;
    const flight = this.flight;
    if (flight) {
      const now = performance.now();
      // 长帧或切回标签页时，仍渲染中间的镜头位置。
      flight.elapsed += Math.min(100, now - flight.lastFrame);
      flight.lastFrame = now;
      const t = Math.min(1, flight.elapsed / flight.duration);
      const ease = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(flight.from, flight.to, ease);
      this.camera.quaternion.slerpQuaternions(flight.rotationFrom, flight.rotationTo, ease);
      const distance = THREE.MathUtils.lerp(
        flight.distanceFrom,
        flight.to.distanceTo(flight.targetTo),
        ease,
      );
      this.camera
        .getWorldDirection(this.controls.target)
        .multiplyScalar(distance)
        .add(this.camera.position);
      if (flight.zoomFrom !== 1) {
        this.camera.zoom = THREE.MathUtils.lerp(flight.zoomFrom, 1, ease);
        this.camera.updateProjectionMatrix();
      }
      if (t >= 1) {
        this.controls.target.copy(flight.targetTo);
        this.flight = null;
      }
    } else {
      this.navigation.update();
      this.controls.update();
      this.firstPerson?.sync();
    }
    this.environment.update(this.camera);
    this.externalContent.update(this.camera);
    this.updateBackgroundViews();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.updateLabels();
  }

  // ---------------------------------------------------------------------------
  // 材质、贴图、模型
  // ---------------------------------------------------------------------------

  /** 按（哈希，用途）取贴图（颜色贴图 sRGB，法线、粗糙度贴图线性，见 materials.ts）。 */
  private texture(hash: string, role: TextureRole = 'color'): Promise<THREE.Texture> | null {
    return this.textures.get(hash, role);
  }

  /** 形状材质按材质、玻璃和背景状态共用一份（画法见 materials.ts）。 */
  private shapeMaterial(
    material: Material,
    glass: boolean,
    background = false,
    styleLook?: StyleLook,
    kind: 'structure' | 'object' = 'object',
  ): THREE.Material {
    const key = `${materialKey(material)}|${glass ? 'g' : 'o'}|${background}|${styleLookKey(styleLook)}|${kind}`;
    let cached = this.materialCache.get(key);
    if (cached === undefined) {
      const context = background ? { ...this.materialContext, clipping: [] } : this.materialContext;
      cached = createShapeMaterial(material, glass, context, styleLook, kind);
      this.materialCache.set(key, cached);
    }
    return cached;
  }

  private voxelMaterial(part: VoxelPart, styleLook?: StyleLook): THREE.Material {
    const key = `voxel|${part.key}|${styleLookKey(styleLook)}`;
    const cached = this.materialCache.get(key);
    if (cached !== undefined) return cached;
    let material: THREE.Material;
    if (part.kind === 'emissive' || styleLook?.unlit === true) {
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
      if (part.texture !== undefined && !styleLook?.stripTextures) {
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
    if (styleLook?.wireframe)
      (material as THREE.Material & { wireframe?: boolean }).wireframe = true;
    applyStyleLook(material, styleLook);
    this.materialCache.set(key, material);
    return material;
  }

  /**
   * glb → three.js 对象；材质都加上剖切平面。`bake` 为真时（扫描）受光照的贴图材质就地改成扫描烘焙的看法；
   * 物件模型不改原材质，按每个物件的 `material.shading` 派生（sharedClone）。
   */
  private parseGlb(
    bytes: ArrayBuffer,
    doubleSided: boolean,
    bake: boolean,
  ): Promise<THREE.Object3D> {
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
              if (bake) bakeInPlace(material);
            }
          });
          resolve(gltf.scene);
        },
        (error) => reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  /** 物件模型的实际包围盒（逐个顶点），按模型缓存，时间轴来回拖动时不重算。 */
  private modelBox(model: THREE.Object3D): BoxLike | null {
    if (!this.modelBoxes.has(model)) this.modelBoxes.set(model, measureModel(model));
    return this.modelBoxes.get(model) ?? null;
  }

  private model(hash: string): Promise<THREE.Object3D> | null {
    const load = this.options.loadModel;
    if (load === undefined) return null;
    let model = this.modelCache.get(hash);
    if (model === undefined) {
      model = load(hash).then((bytes) => this.parseGlb(bytes, false, false));
      this.modelCache.set(hash, model);
      model.catch(() => this.modelCache.delete(hash));
    }
    return model;
  }

  /**
   * 共用的模型实例：几何体和材质属于缓存，释放时跳过。材质按物件的外观（`tint`、`opacity`、`unlit`、
   * `shading`）派生，也进缓存；`albedo` 且没有别的外观时直接用模型里的材质（materials.ts）。
   */
  private sharedClone(
    model: THREE.Object3D,
    look?: EntityBody['material'],
    background = false,
    styleLook?: StyleLook,
    kind: 'structure' | 'object' = 'object',
  ): THREE.Object3D {
    const clone = model.clone(true);
    clone.traverse((object) => {
      object.userData.sharedGeometry = true;
      object.userData.sharedMaterial = true;
      object.userData.background = background;
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => this.modelMaterial(m, look, background, styleLook, kind))
        : this.modelMaterial(mesh.material, look, background, styleLook, kind);
    });
    return clone;
  }

  private modelMaterial(
    source: THREE.Material,
    look: EntityBody['material'],
    background = false,
    styleLook?: StyleLook,
    kind: 'structure' | 'object' = 'object',
  ): THREE.Material {
    const lookKey = modelMaterialKey(source, look, styleLook);
    if (lookKey === null && !background) return source;
    const key = `${lookKey ?? source.uuid}|${background}|${styleLookKey(styleLook)}|${kind}`;
    let material = this.materialCache.get(key);
    if (material === undefined) {
      material = createModelMaterial(
        source,
        look,
        background ? [] : this.clipping,
        styleLook,
        kind,
      );
      this.materialCache.set(key, material);
    }
    return material;
  }

  // ---------------------------------------------------------------------------
  // 内容
  // ---------------------------------------------------------------------------

  /** 正在生成的任务也共用；关闭后的异步结果不再创建几何缓冲。 */
  private cachedVoxels(key: string, source: VoxelSource): Promise<VoxelGeometry> {
    if (source.chunks.length === 0) return Promise.resolve({ parts: [], faceCount: 0 });
    const cached = this.voxelCache.get(key);
    if (cached) {
      this.voxelCache.delete(key);
      this.voxelCache.set(key, cached);
      return cached.pending;
    }
    const entry: { pending: Promise<VoxelGeometry>; result?: VoxelGeometry } = {
      pending: this.meshes
        .voxels(source)
        .then((meshes) => {
          if (this.disposed) return { parts: [], faceCount: 0 };
          const result = {
            parts: meshes.parts
              .filter((part) => part.indices.length > 0)
              .map((part) => ({
                part,
                geometry: voxelGeometry(part),
              })),
            faceCount: meshes.faceCount,
          };
          entry.result = result;
          return result;
        })
        .catch((error: unknown) => {
          this.voxelCache.delete(key);
          throw error;
        }),
    };
    this.voxelCache.set(key, entry);
    return entry.pending;
  }

  /**
   * 换内容。网格在后台线程里生成，生成好之前保留上一份内容，画面不闪；
   * 中途又来了新内容时，旧的一份生成完直接丢掉。
   */
  async setContent(content: SceneContent): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const warnings: string[] = [];

    // 1. 收集要生成的形状（按局部形状去重，已经缓存的跳过）。
    const jobs = new Map<string, ShapeJob>();
    const reusedShapes: Promise<void>[] = [];
    const reusedShapeKeys = new Set<string>();
    const plans = content.members.map((member) => {
      const entities = member.view.entities.map((entity) => {
        if (entity.shape === undefined || environmentOf(entity) || externalContentOf(entity))
          return { entity, key: null, matrix: null };
        const { local, matrix } = splitShape(entity.shape);
        const used = usedTemplates(local, member.view.templates);
        const key = geometryKey(local, used);
        const cached = this.geometryCache.get(key);
        const pending = this.shapePending.get(key);
        if (cached) {
          this.geometryCache.delete(key);
          this.geometryCache.set(key, cached);
        } else if (pending) {
          if (!reusedShapeKeys.has(key)) {
            reusedShapeKeys.add(key);
            reusedShapes.push(pending);
          }
        } else if (!jobs.has(key)) {
          jobs.set(key, { key, shape: local, templates: used });
        }
        return { entity, key, matrix };
      });
      return { member, entities, voxelKey: voxelGeometryKey(member.view.voxels) };
    });

    const report = this.options.onProgress;
    const voxelTotal = content.members.filter((m) => m.view.voxels.chunks.length > 0).length;
    const steps = reusedShapes.length + jobs.size + voxelTotal;
    let shapesDone = 0;
    let reusedShapesDone = 0;
    let voxelsDone = 0;
    const progress = (label: string) => {
      if (steps > 0 && !this.disposed && generation === this.generation)
        report?.({ label, done: shapesDone + reusedShapesDone + voxelsDone, total: steps });
    };
    progress('生成网格');

    try {
      let batchRun: Promise<void> | undefined;
      if (jobs.size > 0) {
        const batchKeys = [...jobs.keys()];
        let shapeRun: Promise<ShapeJobResult[]>;
        try {
          shapeRun = this.meshes.shapes([...jobs.values()], (done) => {
            shapesDone = done;
            progress('生成网格');
          });
        } catch (error) {
          shapeRun = Promise.reject(error);
        }
        batchRun = shapeRun
          .then((shapeResults) => {
            if (this.disposed) return;
            for (const result of shapeResults) {
              if (this.geometryCache.has(result.key)) continue;
              const geometry = partsToGeometry(result.parts, result.warnings);
              this.geometryCache.set(result.key, { ...geometry, triangles: result.triangles });
            }
          })
          .finally(() => {
            for (const key of batchKeys) {
              if (this.shapePending.get(key) === batchRun) this.shapePending.delete(key);
            }
          });
        for (const key of batchKeys) this.shapePending.set(key, batchRun);
      }
      const [, , voxelResults, scans] = await Promise.all([
        batchRun,
        Promise.all(
          reusedShapes.map(async (pending) => {
            await pending;
            reusedShapesDone += 1;
            progress('生成网格');
          }),
        ),
        Promise.all(
          plans.map(async ({ member, voxelKey }) => {
            const result = await this.cachedVoxels(voxelKey, member.view.voxels);
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
              parsed = this.parseGlb(member.scan, true, true);
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
      if (this.disposed || generation !== this.generation) return;
      this.build(content, plans, voxelResults, scans, warnings);
    } finally {
      if (generation === this.generation) report?.(null);
    }
  }

  /** 组合环境使用同一成员的灯光、样式色与天空，并在当前构建代次内生效。 */
  private updateStyleEnvironment(content: SceneContent): void {
    const generation = this.generation;
    const owner =
      content.members.find((member) =>
        member.view.entities.some((entity) => environmentOf(entity)),
      ) ??
      content.members.find(
        (member) =>
          member.view.lighting !== undefined ||
          member.lighting !== undefined ||
          member.view.backgroundColor !== undefined ||
          member.backgroundColor !== undefined,
      );
    for (const light of this.lights) this.scene.remove(light);
    this.lights = createLights(owner?.view.lighting ?? owner?.lighting);
    this.scene.add(...this.lights);
    this.environment.setContent(
      { ...content, members: owner ? [owner] : [] },
      owner?.view.backgroundColor ?? owner?.backgroundColor,
      () => !this.disposed && generation === this.generation,
    );
  }

  private build(
    content: SceneContent,
    plans: {
      member: MemberContent;
      entities: { entity: EntityBody; key: string | null; matrix: THREE.Matrix4 | null }[];
      voxelKey: string;
    }[],
    voxelResults: VoxelGeometry[],
    scans: (THREE.Object3D | null)[],
    warnings: string[],
  ): void {
    const generation = this.generation;
    disposeObject(this.content);
    disposeObject(this.overlay);
    this.content.clear();
    this.overlay.clear();
    this.clearVisuals();
    this.clearSelection();
    this.anchors = new Map();
    this.pickables = [];
    this.frameSources = [];
    this.distanceObjects = [];
    this.landmarks = [];
    this.overviewBox = null;
    this.updateStyleEnvironment(content);
    this.externalContent.setContent(content);
    this.grid.visible = !this.environment.hasMap;
    // 换了内容，原来选中的物件（信息面板随之关闭）不再固定显示标签。
    this.focusedAnchorKey = null;
    this.labelsDirty = true;
    let triangles = 0;
    let instancedBatches = 0;
    let instancedEntities = 0;
    let textured = 0;
    let entityCount = 0;
    let voxelFaces = 0;
    let hasScan = false;
    let modelsPending = 0;
    let modelsLoaded = 0;
    let modelsFailed = 0;
    const modelProgress = () => {
      if (this.disposed || generation !== this.generation) return;
      this.host.dataset.modelsPending = String(modelsPending);
      this.host.dataset.modelsLoaded = String(modelsLoaded);
      this.host.dataset.modelsFailed = String(modelsFailed);
    };
    modelProgress();
    const inUse = new Set<string>();

    plans.forEach(({ member, entities }, index) => {
      entityCount += entities.filter(
        ({ entity }) => environmentOf(entity) || externalContentOf(entity),
      ).length;
      const group = placementGroup(member.placement);
      group.name = `member:${member.spaceId}`;
      this.content.add(group);
      const overlay = placementGroup(member.placement);
      this.overlay.add(overlay);

      // 物件：按（几何体，玻璃）分批，两个以上画成 InstancedMesh。
      const batches = new Map<
        string,
        {
          key: string;
          glass: boolean;
          background: boolean;
          styleLook?: StyleLook;
          kind: 'structure' | 'object';
          items: { entity: EntityBody; matrix: THREE.Matrix4 }[];
        }
      >();
      for (const { entity, key, matrix } of entities) {
        if (key === null || matrix === null) continue;
        inUse.add(key);
        const glass = entity.props?.glass === true;
        const background = isBackgroundEntity(entity);
        const styleLook = member.view.styleLook ?? member.styleLook;
        const kind = entity.kind === 'structure' ? 'structure' : 'object';
        const batchKey = `${key}|${glass}|${background}|${kind}|${styleLookKey(styleLook)}|${JSON.stringify(entity.props?.backgroundView ?? null)}`;
        const batch = batches.get(batchKey) ?? {
          key,
          glass,
          background,
          styleLook,
          kind,
          items: [],
        };
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
        const materials = built.materials.map((m) =>
          this.shapeMaterial(m, batch.glass, batch.background, batch.styleLook, batch.kind),
        );
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
        mesh.userData = {
          sharedGeometry: true,
          sharedMaterial: true,
          entities: payload,
          background: batch.background,
        };
        mesh.name = batch.items.map((item) => item.entity.entityId).join(',');
        if (batch.glass) mesh.renderOrder = 2;
        group.add(mesh);
        this.addBackgroundView(mesh, batch.items[0]!.entity, member);
        if (!batch.background) this.pickables.push(mesh);
        triangles += (built.geometry.index.count / 3) * batch.items.length;
        entityCount += batch.items.length;
      }

      // 只有物件模型（assetHash）的物件：按物件的 transform 转好，转过之后的外包盒底面中心对齐 bounds 的
      // 底面中心（modelPlacement.ts）；这个外包盒实际比 bounds 大时等比缩小兜进 bounds（modelFit.ts，
      // 服务端已经实测过，这里只是兜底）。
      for (const { entity } of entities) {
        if (
          entity.shape !== undefined ||
          entity.assetHash === undefined ||
          environmentOf(entity) ||
          externalContentOf(entity)
        )
          continue;
        entityCount += 1;
        const background = isBackgroundEntity(entity);
        const holder = new THREE.Group();
        holder.userData = { entities: [{ spaceId: member.spaceId, entity }] };
        const bounds = entity.bounds;
        if (bounds) {
          holder.position.set(
            (bounds.min[0] + bounds.max[0]) / 2,
            bounds.min[1],
            (bounds.min[2] + bounds.max[2]) / 2,
          );
        }
        group.add(holder);
        this.addBackgroundView(holder, entity, member);
        if (!background) this.pickables.push(holder);
        const pending = this.model(entity.assetHash);
        if (pending === null) continue;
        modelsPending++;
        modelProgress();
        pending
          .then((model) => {
            if (!this.disposed && holder.parent !== null) {
              const box = bounds ? this.modelBox(model) : null;
              const placed = box ? placedModelBox(box, entity.transform) : null;
              const fit = bounds && placed ? modelFit(placed, bounds) : null;
              if (fit !== null) {
                const warning = modelFitWarning(entity.entityId, fit);
                console.warn(warning);
                warnings.push(warning);
              }
              const clone = this.sharedClone(
                model,
                entity.material,
                background,
                member.view.styleLook ?? member.styleLook,
                entity.kind === 'structure' ? 'structure' : 'object',
              );
              placeRotatedModel(clone, entity.transform, box ?? undefined);
              holder.add(fitModelInto(clone, fit));
            }
            modelsLoaded++;
          })
          .catch(() => {
            modelsFailed++;
            warnings.push(`${entity.entityId}：模型下载失败`);
          })
          .finally(() => {
            modelsPending--;
            modelProgress();
          });
      }

      // 方块。
      const voxels = voxelResults[index]!;
      voxelFaces += voxels.faceCount;
      for (const { part, geometry } of voxels.parts) {
        const mesh = new THREE.Mesh(
          geometry,
          this.voxelMaterial(part, member.view.styleLook ?? member.styleLook),
        );
        mesh.userData.sharedGeometry = true;
        mesh.userData.sharedMaterial = true;
        mesh.name = `voxels:${part.key}`;
        if (part.kind === 'glass') mesh.renderOrder = 3;
        if (part.texture !== undefined) textured += 1;
        group.add(mesh);
        triangles += part.indices.length / 3;
      }

      // 扫描。
      const scan = scans[index];
      let scanInstance: THREE.Object3D | null = null;
      if (scan) {
        hasScan = true;
        const instance = scan.clone(true);
        instance.traverse((object) => {
          object.userData.sharedGeometry = true;
          object.userData.sharedMaterial = true;
          // 取景时扫描单独算（分位包围盒），不按网格的外包盒算。
          object.userData.scanPart = true;
        });
        instance.userData.shared = true;
        if (member.scanTransform && member.scanTransform.length === 16) {
          instance.matrixAutoUpdate = false;
          instance.matrix.fromArray(member.scanTransform as number[]);
        }
        instance.name = 'scan';
        group.add(instance);
        scanInstance = instance;
        instance.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) triangles += (mesh.geometry.index?.count ?? 0) / 3;
        });
      }

      this.buildOverlay(member, overlay, content.members.length > 1);
      this.frameSources.push(frameSourceOf(member, group, scanInstance));
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
    // 体素缓冲较大，保留最近的内容；当前成员与尚未完成的任务不驱逐。
    if (this.voxelCache.size > 40) {
      const voxelKeys = new Set(plans.map((plan) => plan.voxelKey));
      for (const [key, cached] of this.voxelCache) {
        if (this.voxelCache.size <= 30) break;
        if (voxelKeys.has(key) || !cached.result) continue;
        for (const { geometry } of cached.result.parts) geometry.dispose();
        this.voxelCache.delete(key);
      }
    }

    // 扫描天花板的高度：几个成员都有扫描时取最低的（剖切要把每一份的天花板都切掉）。
    let scanCeiling: number | null = null;
    for (const source of this.frameSources) {
      if (source.scan === null) continue;
      source.scan.updateWorldMatrix(true, true);
      const height = scanCeilingHeight(source.scan);
      if (height !== null)
        scanCeiling = scanCeiling === null ? height : Math.min(scanCeiling, height);
    }
    this.stats = {
      entities: entityCount,
      triangles,
      voxelFaces,
      hasScan,
      scanCeiling,
      instancedBatches,
      instancedEntities,
      textured,
      threaded: this.meshes.threaded,
      members: content.members.length,
      warnings,
    };
    this.host.dataset.anchors = String(
      [...this.anchors.values()].filter((info) => info.element).length,
    );
    this.applyCut();
    this.setVisuals(this.lastVisuals);
    // 第一次有内容时取景；镜头没动过时换了视图（例如加上虚拟区）也重新取景。
    // 时间轴换版本不重新取景，免得回放时镜头跳来跳去。
    const modeChanged = this.lastMode !== null && this.lastMode !== content.mode;
    this.lastMode = content.mode;
    const spaces = content.members.map((member) => member.spaceId).join('\u0000');
    const spacesChanged = this.lastSpaces !== spaces;
    this.lastSpaces = spaces;
    if (!this.framed || spacesChanged || (this.autoFramed && modeChanged)) this.frameContent(false);
    else {
      // 用户移动过镜头时保留位置，新增的背景仍须能落入远裁面。
      this.camera.far = backgroundFarPlane(
        this.camera.position,
        this.camera.far,
        this.frameSources.flatMap((source) => source.backgroundBoxes),
      );
      this.camera.updateProjectionMatrix();
    }
    this.host.dataset.triangles = String(Math.round(triangles));
  }

  /** 成员的锚点、虚拟区光效、组合里的成员名。 */
  private buildOverlay(member: MemberContent, overlay: THREE.Group, universe: boolean): void {
    const placement = member.placement;
    for (const entity of member.view.entities) {
      const landmark = backgroundLandmark(entity);
      if (!landmark) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'viewer__landmark';
      button.dataset.labelPriority = String(EVENT_PRIORITY + 4);
      button.title = '点击查看此处';
      const caption = document.createElement('span');
      caption.className = 'viewer__landmark-caption';
      caption.textContent = landmark.label;
      const pin = document.createElement('span');
      pin.className = 'viewer__landmark-pin';
      pin.setAttribute('aria-hidden', 'true');
      button.append(caption, pin);
      const object = new CSS2DObject(button);
      object.center.set(0.5, 1);
      object.position.set(...landmark.position);
      object.visible = false;
      overlay.add(object);
      const box = placedBox(placement, landmark.bounds.min, landmark.bounds.max);
      if (landmark.overview && !universe && member.view.mode === 'extended')
        this.overviewBox ??= { box, framing: landmark.framing };
      button.addEventListener('click', () => this.frameBounds(box, true, landmark.framing));
      this.landmarks.push({
        object,
        focus: box.getCenter(new THREE.Vector3()),
        min: landmark.minDistance,
        max: landmark.maxDistance ?? Infinity,
      });
    }
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
        const tag = navigationLabel(() => this.frameBounds(placedGridBox(placement, box)));
        tag.className = 'viewer__virtual-tag';
        tag.dataset.labelPriority = String(EVENT_PRIORITY);
        const name = displayName(region);
        tag.textContent = name ? `虚拟 · ${name}` : '虚拟';
        const label = new CSS2DObject(tag);
        label.position.set(center.x, max.y + 0.15, center.z);
        overlay.add(edges, glow, label);
      }
    }

    // 挂在锚点上的物件包围盒（高亮用；方块画法下不画的重建层物件也算）。
    const bounds = new Map<string, THREE.Box3>();
    for (const entity of member.view.anchored) {
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
        element = navigationLabel(() => this.focusAnchor(ref));
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
      const attached = bounds.get(anchor.anchorId) ?? null;
      this.anchors.set(anchorKey(ref), {
        ref,
        anchor,
        world,
        element,
        label,
        bounds: attached,
        extent: anchor.box ? placedGridBox(placement, anchor.box) : attached,
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
      const tag = navigationLabel(() => this.focusMember(member.spaceId));
      tag.className = 'viewer__member-tag';
      tag.dataset.labelPriority = String(EVENT_PRIORITY + 1);
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
        button.dataset.labelPriority = String(EVENT_PRIORITY + 3);
        button.dataset.kind = link.kind;
        button.textContent = `${{ door: '门', portal: '传送门', street: '街道' }[link.kind] ?? '连接'} → ${there.memberName ?? there.ref.spaceId}`;
        button.title = `飞到 ${there.memberName ?? there.ref.spaceId} 的 ${there.label}`;
        button.addEventListener('click', () => this.focusAnchor(there.ref));
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

    // 有事件的锚点：标签最优先显示。
    const eventAnchors = new Set<string>();
    for (const visual of visuals) {
      if (visual.kind === 'path') {
        if (visual.from) eventAnchors.add(anchorKey(visual.from));
        if (visual.to) eventAnchors.add(anchorKey(visual.to));
      } else {
        eventAnchors.add(anchorKey(visual.anchor));
      }
    }
    if (!sameKeys(eventAnchors, this.eventAnchors)) {
      this.eventAnchors = eventAnchors;
      this.labelsDirty = true;
    }

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
      const text =
        highlight && highlight.texts.length > 0
          ? `${info.label} · ${highlight.texts.join('，')}`
          : info.label;
      if (highlight) info.element.style.setProperty('--event-color', cssColor(highlight.color));
      else info.element.style.removeProperty('--event-color');
      if (info.element.textContent !== text) {
        info.element.textContent = text;
        this.labelsDirty = true;
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

  private eventTag(
    onClick: () => void,
    className: string,
    color: readonly number[],
    icon?: string,
    text?: string,
  ) {
    const element = navigationLabel(onClick);
    element.className = className;
    element.dataset.labelPriority = String(EVENT_PRIORITY + 2);
    element.style.setProperty('--event-color', cssColor(color));
    if (icon) element.appendChild(iconElement(icon));
    if (!text && icon) element.setAttribute('aria-label', icon);
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
          () => this.focusAnchor(info.ref),
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
      // 用细管子画路线（WebGL 的线宽固定 1 像素，远看几乎看不见）。
      const line = new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3(points, false, 'centripetal'),
          Math.max(16, points.length * 2),
          0.025,
          8,
          false,
        ),
        new THREE.MeshBasicMaterial({
          color: srgb(visual.color),
          transparent: true,
          opacity: 0.85,
        }),
      );
      line.name = `path:${visual.correlationId}`;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 12),
        new THREE.MeshBasicMaterial({ color: srgb(visual.color) }),
      );
      const tag = this.eventTag(
        () => this.flyTo(marker.position),
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
        () => this.focusAnchor(end.ref),
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

  /**
   * 取景用的包围盒：每个成员里内容（物件、方块、扫描）的包围盒和它的取景范围（实体区，
   * 优化 + 扩展视图再加非背景虚拟区）求交后合并；背景不参与主体取景。
   * 扫描按表面（三角形按面积加权）的 2%–98% 分位包围盒算，去掉零星的离群点（framing.ts 的 `scanFrameBox`）。
   * 开着剖切时顶部压到剖切高度（上面的内容反正看不见）。
   */
  private frameTarget(): THREE.Box3 {
    this.content.updateMatrixWorld(true);
    const out = new THREE.Box3();
    for (const source of this.frameSources) {
      const box = new THREE.Box3();
      source.group.traverse((object) => {
        if (
          (object as THREE.Mesh).isMesh &&
          object.userData.scanPart !== true &&
          object.userData.background !== true
        ) {
          box.union(new THREE.Box3().expandByObject(object));
        }
      });
      if (source.scan !== null) box.union(this.scanBox(source.scan));
      for (const extra of source.extraBoxes) box.union(extra);
      out.union(clipBox(box, source.clips));
    }
    // 只有背景、没有主体的空间仍能查看全貌。
    if (out.isEmpty())
      for (const source of this.frameSources)
        for (const box of source.backgroundBoxes) out.union(box);
    if (out.isEmpty()) return out;
    if (this.cutHeight !== null && this.cutHeight > out.min.y + 0.2) {
      out.max.y = Math.min(out.max.y, this.cutHeight);
    }
    return out;
  }

  private scanBox(scan: THREE.Object3D): THREE.Box3 {
    let box = this.scanBoxes.get(scan);
    if (box === undefined) {
      box = scanFrameBox(scan);
      this.scanBoxes.set(scan, box);
    }
    return box;
  }

  /**
   * 镜头取景（第一次有内容时自动执行；"回到全景"也用它）：斜上方约 45° 俯视，
   * 实体区里的内容占满画面，四边各留 6%（合计约 12%）的边距。
   */
  frameContent(animate = true): void {
    this.frameBounds(
      this.overviewBox?.box ?? this.frameTarget(),
      animate,
      this.overviewBox?.framing,
    );
  }

  /** 聚焦组合中的一个成员空间；传 `null` 时回到全景总览。 */
  focusMember(spaceId: string | null): void {
    if (spaceId === null) {
      this.frameContent();
      return;
    }
    const source = this.frameSources.find((item) => item.group.name === `member:${spaceId}`);
    if (!source) return;
    this.content.updateMatrixWorld(true);
    const box = new THREE.Box3();
    source.group.traverse((object) => {
      if ((object as THREE.Mesh).isMesh && object.userData.background !== true)
        box.union(new THREE.Box3().setFromObject(object));
    });
    for (const clip of source.clips) box.union(clip);
    for (const extra of source.extraBoxes) box.union(extra);
    if (!box.isEmpty()) this.frameBounds(box);
  }

  /** 聚焦公开锚点并保留标签高亮；传 `null` 清除锚点聚焦。 */
  focusAnchor(ref: { readonly spaceId: string; readonly anchorId: string } | null): void {
    const key = ref === null ? null : anchorKey(ref);
    this.setFocus(key);
    if (key === null) return;
    const info = this.anchors.get(key);
    if (info?.world) this.flyTo(info.world);
  }

  setPerspective(mode: CameraPerspective): void {
    if ((this.firstPerson !== null) === (mode === 'first')) return;
    this.onControlsStart();
    if (mode === 'first') {
      this.firstPerson = new FirstPersonView(this.camera, this.controls, this.frameTarget());
    } else {
      this.firstPerson?.exit();
      this.firstPerson = null;
    }
    this.options.onPerspectiveChange?.(mode);
  }

  stepCamera(action: CameraStep): void {
    this.navigation.step(action, this.firstPerson !== null);
    this.firstPerson?.sync();
  }

  private frameBounds(
    box: THREE.Box3,
    animate = true,
    framing?: Pick<FrameOptions, 'azimuths' | 'elevation'>,
  ): void {
    const frame = frameBox(box, { fov: this.camera.fov, aspect: this.camera.aspect, ...framing });
    if (frame === null) return;
    this.leaveFirstPersonForFlight();
    this.moveCamera(frame.position, frame.target, animate);
    const diagonal = box.getSize(new THREE.Vector3()).length();
    this.camera.near = Math.max(0.02, frame.distance / 500);
    this.camera.far = backgroundFarPlane(
      frame.position,
      Math.max(50, frame.distance * 20 + diagonal * 2),
      this.frameSources.flatMap((source) => source.backgroundBoxes),
    );
    this.camera.updateProjectionMatrix();
    this.framed = true;
    this.autoFramed = !animate;
    this.labelsDirty = true;
    this.host.dataset.frame = [...box.min.toArray(), ...box.max.toArray()]
      .map((v) => v.toFixed(2))
      .join(',');
  }

  private addBackgroundView(
    object: THREE.Object3D,
    entity: EntityBody,
    member: MemberContent,
  ): void {
    const config = backgroundView(entity);
    if (!config) return;
    this.distanceObjects.push({
      object,
      focus: new THREE.Vector3(...placePoint(member.placement, config.focus)),
      min: config.min,
      max: config.max,
    });
    object.visible = false;
  }

  private updateBackgroundViews(): void {
    for (const item of this.distanceObjects) {
      const distance = this.camera.position.distanceTo(item.focus);
      item.object.visible = distance >= item.min && distance < item.max;
    }
    const projected = new THREE.Vector3();
    for (const item of this.landmarks) {
      item.object.getWorldPosition(projected).project(this.camera);
      const distance = this.camera.position.distanceTo(item.focus);
      item.object.visible =
        distance >= item.min &&
        distance < item.max &&
        projected.z >= -1 &&
        projected.z <= 1 &&
        Math.abs(projected.x) < 1.05 &&
        Math.abs(projected.y) < 1.05;
    }
    const count = this.distanceObjects.filter((item) => item.min > 0 && item.object.visible).length;
    this.host.dataset.overviewObjects = String(count);
  }

  /** Only bounded, read-only camera operations are exposed to the chat UI. */
  applyCamera(action: CameraAction, content: SceneContent): boolean {
    if (action.kind === 'overview') {
      this.flight = null;
      this.frameContent();
      return true;
    }
    if (action.kind === 'focus') {
      // 物件编号仅在成员空间内唯一，匹配前先限定成员范围。
      for (const member of content.members) {
        if (action.spaceId && member.spaceId !== action.spaceId) continue;
        const entity = member.view.entities.find((item) => item.entityId === action.entityId);
        if (!entity) continue;
        const bounds =
          entity.bounds ??
          (entity.shape ? shapeBounds(entity.shape, { templates: member.view.templates }) : null);
        if (!bounds) continue;
        const point = bounds.min.map((n, i) => (n + bounds.max[i]!) / 2) as [
          number,
          number,
          number,
        ];
        this.flyTo(new THREE.Vector3(...placePoint(member.placement, point)));
        this.select({ spaceId: member.spaceId, entity });
        this.options.onSelect?.({ spaceId: member.spaceId, entity });
        return true;
      }
      return false;
    }
    this.flight = null;
    this.autoFramed = false;
    const offset = new THREE.Vector3().subVectors(
      this.controls.object.position,
      this.controls.target,
    );
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (action.kind === 'zoom')
      spherical.radius = THREE.MathUtils.clamp(
        spherical.radius * action.factor,
        Math.max(this.camera.near * 4, 0.1),
        this.camera.far * 0.8,
      );
    else {
      spherical.theta += THREE.MathUtils.degToRad(action.yaw);
      spherical.phi = THREE.MathUtils.clamp(
        spherical.phi + THREE.MathUtils.degToRad(action.pitch),
        0.05,
        Math.PI - 0.05,
      );
    }
    this.controls.object.position
      .copy(this.controls.target)
      .add(offset.setFromSpherical(spherical));
    this.controls.update();
    this.firstPerson?.sync();
    return true;
  }

  private leaveFirstPersonForFlight(): void {
    if (!this.firstPerson) return;
    this.firstPerson.exit(true);
    this.firstPerson = null;
    this.options.onPerspectiveChange?.('third');
  }

  private moveCamera(to: THREE.Vector3, target: THREE.Vector3, animate = true): void {
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.flight = null;
      this.camera.position.copy(to);
      this.controls.target.copy(target);
      this.camera.zoom = 1;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      return;
    }
    const distance = this.camera.position.distanceTo(to);
    this.flight = {
      from: this.camera.position.clone(),
      to,
      rotationFrom: this.camera.quaternion.clone(),
      rotationTo: new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().lookAt(to, target, this.camera.up),
      ),
      distanceFrom: this.controls.getDistance(),
      targetTo: target.clone(),
      zoomFrom: this.camera.zoom,
      elapsed: 0,
      lastFrame: performance.now(),
      duration: Math.min(1650, 700 + distance * 12),
    };
  }

  /** 从当前眼位靠近目标，沿用当前方位。 */
  flyTo(point: THREE.Vector3): void {
    this.leaveFirstPersonForFlight();
    this.autoFramed = false;
    const orbit = new THREE.Spherical().setFromVector3(
      this.camera.position.clone().sub(this.controls.target),
    );
    orbit.phi = THREE.MathUtils.clamp(orbit.phi, 0.01, this.controls.maxPolarAngle);
    orbit.radius = Math.min(orbit.radius, 6);
    this.moveCamera(new THREE.Vector3().setFromSpherical(orbit).add(point), point);
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
    // 剖切高度以上的锚点标签隐藏，在标签布局里统一处理。
    this.labelsDirty = true;
  }

  // ---------------------------------------------------------------------------
  // 锚点标签
  // ---------------------------------------------------------------------------

  /** 扩大标签候选范围和数量上限，继续避让。 */
  setMoreLabels(more: boolean): void {
    if (this.moreLabels === more) return;
    this.moreLabels = more;
    this.labelsDirty = true;
  }

  private cutHides(world: THREE.Vector3): boolean {
    return this.cutHeight !== null && world.y > this.cutHeight + 0.3;
  }

  /** 锚点在屏幕上的大小（像素）：范围盒 8 个角投影后的外接矩形的长边。 */
  private screenSize(info: AnchorInfo, width: number, height: number): number {
    const world = info.world!;
    if (info.extent === null) {
      const depth = -world.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
      if (depth <= 0) return 0;
      const halfFov = THREE.MathUtils.degToRad(this.camera.getEffectiveFOV()) / 2;
      return (NOMINAL_ANCHOR_SIZE * height) / 2 / (depth * Math.tan(halfFov));
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const corner = new THREE.Vector3();
    const box = info.extent;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          corner.set(x, y, z).project(this.camera);
          // 有角在镜头后面：离得非常近，当作很大。
          if (corner.z > 1) return Math.max(width, height);
          minX = Math.min(minX, corner.x);
          maxX = Math.max(maxX, corner.x);
          minY = Math.min(minY, corner.y);
          maxY = Math.max(maxY, corner.y);
        }
      }
    }
    return Math.max(((maxX - minX) * width) / 2, ((maxY - minY) * height) / 2);
  }

  /** 投影完成后统一读取标签边界，再集中更新可见性。遮住的标签仍可在下一帧测量。 */
  private updateLabels(): void {
    const cameraMoved =
      !this.labelCamera.equals(this.camera.matrixWorld) ||
      !this.labelProjection.equals(this.camera.projectionMatrix);
    if (!this.labelsDirty && !cameraMoved) return;
    this.labelsDirty = false;
    this.labelCamera.copy(this.camera.matrixWorld);
    this.labelProjection.copy(this.camera.projectionMatrix);

    const viewport = this.labels.domElement.getBoundingClientRect();
    const elements = Array.from(this.labels.domElement.children) as HTMLElement[];
    const candidates: LabelCandidate[] = [];
    for (const [index, element] of elements.entries()) {
      const rect = element.getBoundingClientRect();
      if (
        !rect.width ||
        !rect.height ||
        rect.left < viewport.left ||
        rect.right > viewport.right ||
        rect.top < viewport.top ||
        rect.bottom > viewport.bottom
      )
        continue;
      const { spaceId, anchorId } = element.dataset;
      const key = spaceId && anchorId ? anchorKey({ spaceId, anchorId }) : '';
      const info = this.anchors.get(key);
      let forced = element === document.activeElement;
      let priority = Number(element.dataset.labelPriority ?? 0);
      let screenSize = 0;
      let group: string | undefined;
      if (info?.world) {
        if (this.cutHides(info.world)) continue;
        const hasEvent = this.eventAnchors.has(key);
        priority = anchorLabelPriority(info.anchor.kind, hasEvent);
        forced = key === this.hoverAnchor || key === this.focusedAnchorKey;
        if (key === this.hoverAnchor) priority = EVENT_PRIORITY + 20;
        screenSize = this.screenSize(info, viewport.width, viewport.height);
        if (!hasEvent && !forced) group = JSON.stringify([spaceId, info.label]);
      }
      candidates.push({
        key: String(index),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        priority,
        screenSize,
        forced,
        group,
      });
    }
    const shown = layoutLabels(candidates, {
      moreLabels: this.moreLabels,
      maxLabels: maxLabelsFor(viewport.width, viewport.height, this.moreLabels),
      minScreenSize: MIN_SCREEN_SIZE,
      padding: LABEL_PADDING,
    });
    let anchorsShown = 0;
    for (const [index, element] of elements.entries()) {
      const visible = shown.has(String(index));
      const visibility = visible ? '' : 'hidden';
      if (visibility !== element.style.visibility) element.style.visibility = visibility;
      if (visible && element.dataset.anchorId) anchorsShown += 1;
    }
    this.host.dataset.labels = String(anchorsShown);
    const hover = this.hoverAnchor === null ? undefined : this.anchors.get(this.hoverAnchor);
    if (hover?.element?.style.visibility === '' && hover.label === this.tooltip.textContent)
      this.tooltip.hidden = true;
  }

  /** 离屏幕上某一点最近、在 radius 像素以内的锚点（剖切掉的不算）。 */
  private anchorNear(clientX: number, clientY: number, radius: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector3();
    let best: string | null = null;
    let bestDistance = radius;
    for (const [key, info] of this.anchors) {
      if (info.element === null || info.world === null || this.cutHides(info.world)) continue;
      point.copy(info.world).project(this.camera);
      if (point.z > 1 || point.z < -1) continue;
      const x = rect.left + ((point.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - point.y) / 2) * rect.height;
      const distance = Math.hypot(x - clientX, y - clientY);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = key;
      }
    }
    return best;
  }

  /** 物件挂的锚点（有标签的才算）。 */
  private anchorOf(selection: Selection | null): string | null {
    if (selection === null || selection.entity.anchorId === undefined) return null;
    const key = anchorKey({ spaceId: selection.spaceId, anchorId: selection.entity.anchorId });
    return this.anchors.get(key)?.element ? key : null;
  }

  private setHover(key: string | null): void {
    if (this.hoverAnchor === key) return;
    this.hoverAnchor = key;
    this.labelsDirty = true;
  }

  private setFocus(key: string | null): void {
    if (this.focusedAnchorKey === key) return;
    if (this.focusedAnchorKey !== null)
      this.anchors.get(this.focusedAnchorKey)?.element?.removeAttribute('data-focused');
    this.focusedAnchorKey = key;
    if (key !== null) this.anchors.get(key)?.element?.setAttribute('data-focused', 'true');
    this.labelsDirty = true;
  }

  private raycast(event: { readonly clientX: number; readonly clientY: number }): Selection | null {
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
    // 选中的物件挂着锚点时，它的标签一直显示（手机上点按物件就能看到标签）。
    this.setFocus(this.anchorOf(selection));
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
    this.pointerDown =
      event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  };

  private onPointerCancel = () => {
    this.pointerDown = null;
  };

  private onPointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (down === null || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const picked = this.raycast(event);
    this.select(picked);
    // 点在锚点附近（没点到物件，或物件没挂锚点）：显示这个锚点的标签。
    if (this.focusedAnchorKey === null) {
      this.setFocus(
        this.anchorNear(event.clientX, event.clientY, event.pointerType === 'mouse' ? 18 : 28),
      );
    }
    this.options.onSelect?.(picked);
  };

  private onLabelWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.renderer.domElement.dispatchEvent(new WheelEvent('wheel', event));
  };

  private onControlsStart = () => {
    this.onPointerLeave();
    this.flight = null;
    this.autoFramed = false;
  };

  /** 悬浮标签：props.label（保留键），没有时用物件的 label。 */
  private onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || this.pointerDown !== null) return;
    if (
      event.target !== this.renderer.domElement &&
      !this.labels.domElement.contains(event.target as Node)
    ) {
      this.onPointerLeave();
      return;
    }
    this.hoverPoint = { clientX: event.clientX, clientY: event.clientY };
    if (this.hoverTimer !== null) return;
    const wait = Math.max(0, this.hoverAt + 80 - performance.now());
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.hover();
    }, wait);
  };

  private hover(): void {
    const event = this.hoverPoint;
    if (this.disposed || event === null) return;
    this.hoverAt = performance.now();
    const picked = this.raycast(event);
    // 悬停在物件或锚点上：显示它的锚点标签。
    const pickedKey = this.anchorOf(picked);
    const info = pickedKey === null ? undefined : this.anchors.get(pickedKey);
    this.setHover(
      info?.world && !this.cutHides(info.world)
        ? pickedKey
        : this.anchorNear(event.clientX, event.clientY, 18),
    );
    const text = picked
      ? ((typeof picked.entity.props?.label === 'string' ? picked.entity.props.label : undefined) ??
        picked.entity.label)
      : undefined;
    if (
      text === undefined ||
      (pickedKey === this.hoverAnchor &&
        text === info?.label &&
        info?.element?.style.visibility !== 'hidden')
    ) {
      this.tooltip.hidden = true;
      return;
    }
    const rect = this.host.getBoundingClientRect();
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${event.clientX - rect.left + 12}px`;
    this.tooltip.style.top = `${event.clientY - rect.top + 12}px`;
    this.tooltip.hidden = false;
  }

  private onPointerLeave = () => {
    this.hoverPoint = null;
    this.tooltip.hidden = true;
    this.setHover(null);
  };

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.hoverTimer !== null) clearTimeout(this.hoverTimer);
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.themeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.labels.domElement.removeEventListener('wheel', this.onLabelWheel);
    this.host.removeEventListener('pointermove', this.onPointerMove);
    this.host.removeEventListener('pointerleave', this.onPointerLeave);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.navigation.dispose();
    this.controls.dispose();
    this.clearVisuals();
    this.clearSelection();
    disposeObject(this.content);
    disposeObject(this.overlay);
    this.shapePending.clear();
    for (const { geometry } of this.geometryCache.values()) geometry.dispose();
    this.geometryCache.clear();
    for (const cached of this.voxelCache.values()) {
      for (const { geometry } of cached.result?.parts ?? []) geometry.dispose();
    }
    this.voxelCache.clear();
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
    this.textures.dispose();
    this.environment.dispose();
    this.externalContent.dispose();
    if (this.ownsMeshes) this.meshes.dispose();
    this.renderer.dispose();
    canvas.remove();
    this.labels.domElement.remove();
    this.hud.remove();
    this.tooltip.remove();
  }
}

type LinkLike = Parameters<typeof linkRoute>[2][number];

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/** 成员坐标里的米制盒子 → 世界坐标的盒子（摆放只绕 y 轴转 90° 的倍数，外接盒就是精确的）。 */
function navigationLabel(onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function placedBox(
  placement: Placement,
  min: readonly number[],
  max: readonly number[],
): THREE.Box3 {
  const box = new THREE.Box3();
  for (const x of [min[0] ?? 0, max[0] ?? 0]) {
    for (const y of [min[1] ?? 0, max[1] ?? 0]) {
      for (const z of [min[2] ?? 0, max[2] ?? 0]) {
        box.expandByPoint(new THREE.Vector3(...placePoint(placement, [x, y, z])));
      }
    }
  }
  return box;
}

/** 格子盒（格）→ 世界坐标的盒子。 */
function placedGridBox(placement: Placement, box: readonly number[]): THREE.Box3 {
  return placedBox(
    placement,
    [0, 1, 2].map((k) => (box[k] ?? 0) * GRID_UNIT),
    [3, 4, 5].map((k) => (box[k] ?? 0) * GRID_UNIT),
  );
}

/** 成员的取景来源：取景范围（实体区，扩展视图加虚拟区），只有模型、可能还没加载完的物件，虚拟区，扫描。 */
function frameSourceOf(
  member: MemberContent,
  group: THREE.Object3D,
  scan: THREE.Object3D | null,
): FrameSource {
  return {
    group,
    scan,
    clips: member.view.frameBoxes.map((box) => placedGridBox(member.placement, box)),
    backgroundBoxes: member.view.entities
      .filter((entity) => isBackgroundEntity(entity) && entity.bounds !== undefined)
      .map((entity) => placedBox(member.placement, entity.bounds!.min, entity.bounds!.max)),
    extraBoxes: [
      ...member.view.entities
        .filter((e) => e.shape === undefined && e.bounds !== undefined && !isBackgroundEntity(e))
        .map((e) => placedBox(member.placement, e.bounds!.min, e.bounds!.max)),
      // 优化 + 扩展视图画出了虚拟区的边界光效，整块虚拟区都纳入取景。
      ...member.view.virtualRegions.flatMap((r) =>
        r.boxes.map((box) => placedGridBox(member.placement, box)),
      ),
    ],
  };
}
