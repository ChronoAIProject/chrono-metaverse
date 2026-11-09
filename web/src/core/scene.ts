import type {
  Anchor,
  EntityBody,
  GridBox,
  Palette,
  Plot,
  Region,
  ScanRef,
  Snapshot,
  UniverseLink,
} from './api/types';
import type { PublicClient } from './api/client';
import { GRID_UNIT } from './chunk';
import type { TemplateTable, Vec3 } from './shapes/types';
import type { LayerChunk, VoxelSource } from './voxels';

/**
 * 查看器渲染的场景文档：某个 seq 的快照，区块已经下载并解码。
 * 结构元素和物体都是物件（形状词表），方块风格内容是区块。
 */
export interface SceneDocument {
  readonly spaceId: string;
  readonly name?: string;
  readonly seq: number;
  readonly at: string;
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly anchors: readonly Anchor[];
  readonly entities: readonly EntityBody[];
  readonly palette: Palette;
  readonly chunks: readonly LayerChunk[];
  readonly scan?: ScanRef | null;
}

/** 同时下载的区块数上限。 */
const CHUNK_CONCURRENCY = 6;

/** 加载进度：已完成的区块数和总数。 */
export type ChunkProgress = (done: number, total: number) => void;

/** 快照 → 场景文档：并发下载区块（每个都核对哈希）。 */
export async function loadScene(
  client: Pick<PublicClient, 'chunk'>,
  snapshot: Snapshot,
  name?: string,
  onProgress?: ChunkProgress,
): Promise<SceneDocument> {
  const refs = [...snapshot.chunks];
  const chunks: LayerChunk[] = new Array(refs.length);
  let next = 0;
  let done = 0;
  onProgress?.(0, refs.length);
  const worker = async () => {
    while (next < refs.length) {
      const index = next;
      next += 1;
      const ref = refs[index]!;
      chunks[index] = {
        layer: ref.layer,
        cx: ref.cx,
        cy: ref.cy,
        cz: ref.cz,
        cells: await client.chunk(ref.hash),
      };
      done += 1;
      onProgress?.(done, refs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, refs.length) }, worker));
  return {
    spaceId: snapshot.spaceId,
    name,
    seq: snapshot.seq,
    at: snapshot.at,
    regions: snapshot.regions,
    plots: snapshot.plots,
    anchors: snapshot.anchors,
    entities: snapshot.entities.map((record) => record.body),
    palette: snapshot.palette ?? { blocks: [] },
    chunks,
    scan: snapshot.scan ?? null,
  };
}

/** 模板表：物件里 `kind: "template"` 的那些，按 entityId 索引。 */
export function templatesOf(entities: readonly EntityBody[]): TemplateTable {
  const table: Record<string, NonNullable<EntityBody['shape']>> = {};
  for (const entity of entities) {
    if (entity.kind === 'template' && entity.shape !== undefined)
      table[entity.entityId] = entity.shape;
  }
  return table;
}

export type ViewMode = 'raw' | 'optimized' | 'extended';

/** 三种视图（设计 7.1）。 */
export const VIEW_MODES: readonly {
  readonly id: ViewMode;
  readonly label: string;
  readonly hint: string;
}[] = [
  { id: 'raw', label: '原始', hint: '扫描得到的原始模型' },
  { id: 'optimized', label: '优化', hint: 'AI 重建的实体区' },
  { id: 'extended', label: '优化 + 扩展', hint: '实体区加上虚拟扩展' },
];

/** 米坐标是否落在格子盒里（左闭右开）。 */
export function boxContains(box: GridBox, point: readonly number[]): boolean {
  for (let k = 0; k < 3; k += 1) {
    const g = (point[k] ?? 0) / GRID_UNIT;
    if (g < box[k]! || g >= box[k + 3]!) return false;
  }
  return true;
}

/** 全局格坐标是否落在格子盒里。 */
export function boxContainsCell(box: GridBox, gx: number, gy: number, gz: number): boolean {
  return gx >= box[0] && gy >= box[1] && gz >= box[2] && gx < box[3] && gy < box[4] && gz < box[5];
}

function entityAnchorPoint(entity: EntityBody): number[] | null {
  if (entity.bounds) {
    return [0, 1, 2].map((k) => (entity.bounds!.min[k]! + entity.bounds!.max[k]!) / 2);
  }
  const position = entity.shape?.transform?.position;
  return position ? [...position] : null;
}

/** 物件属于实体区还是虚拟区。 */
export function entityRegionKind(
  entity: EntityBody,
  regions: readonly Region[],
): 'physical' | 'virtual' {
  if (entity.regionId !== undefined) {
    const region = regions.find((r) => r.id === entity.regionId);
    if (region) return region.kind;
  }
  // 重建层只在实体区（设计 4.2）。
  if (entity.layer === 'rebuilt') return 'physical';
  const point = entityAnchorPoint(entity);
  if (point === null) return 'physical';
  const inVirtual = regions.some(
    (r) => r.kind === 'virtual' && r.boxes.some((b) => boxContains(b, point)),
  );
  return inVirtual ? 'virtual' : 'physical';
}

export interface ViewContent {
  readonly mode: ViewMode;
  /** 原始视图显示扫描模型。 */
  readonly showScan: boolean;
  /** 原始视图下 T 之前没有扫描时为 true，界面提示。 */
  readonly scanMissing: boolean;
  /** 要画的物件（不含模板）：有形状的，或者有处理后模型（assetHash）的。 */
  readonly entities: readonly EntityBody[];
  readonly templates: TemplateTable;
  /** 方块风格内容的来源（两层区块、区域过滤、方块表），在后台线程里叠加并生成网格。 */
  readonly voxels: VoxelSource;
  /** 需要画边界光效和"虚拟"标签的区域。 */
  readonly virtualRegions: readonly Region[];
  readonly anchors: readonly Anchor[];
}

/** 视图里有没有可画的内容（物件或方块）。 */
export function viewHasGeometry(view: ViewContent): boolean {
  return view.entities.length > 0 || view.voxels.chunks.length > 0;
}

/** 物件能不能画：有形状，或者有处理后的模型。模板只作为实例的来源。 */
export function isDrawable(entity: EntityBody): boolean {
  return (
    entity.kind !== 'template' && (entity.shape !== undefined || entity.assetHash !== undefined)
  );
}

/**
 * 视图 = 取哪些图层，按区域过滤（设计 7.1）：
 *
 * | 视图 | 模型 | 物件 | 虚拟区标识 |
 * | 原始 | 扫描（网页用模型） | 不显示 | 无 |
 * | 优化 | 重建层 ⊕ 扩展层，只取实体区 | 实体区物件 | 无 |
 * | 优化 + 扩展 | 重建层 ⊕ 全部扩展层（含虚拟区的方块） | 全部物件 | 有 |
 *
 * 公开锚点三种视图都显示。没有定义任何实体区时，整个空间都算实体区。
 */
export function selectView(scene: SceneDocument, mode: ViewMode): ViewContent {
  const templates = templatesOf(scene.entities);
  const anchors = scene.anchors.filter((a) => a.visibility !== 'internal');
  const palette = scene.palette;
  if (mode === 'raw') {
    const hasScan = (scene.scan?.webModelHashes.length ?? 0) > 0;
    return {
      mode,
      showScan: hasScan,
      scanMissing: !hasScan,
      entities: [],
      templates,
      voxels: { chunks: [], keepBoxes: null, palette },
      virtualRegions: [],
      anchors,
    };
  }
  const drawable = scene.entities.filter(isDrawable);
  if (mode === 'extended') {
    return {
      mode,
      showScan: false,
      scanMissing: false,
      entities: drawable,
      templates,
      voxels: { chunks: scene.chunks, keepBoxes: null, palette },
      virtualRegions: scene.regions.filter((r) => r.kind === 'virtual'),
      anchors,
    };
  }
  const physical = scene.regions.filter((r) => r.kind === 'physical');
  const keepBoxes = physical.length === 0 ? null : physical.flatMap((r) => r.boxes);
  // 只取实体区：区块里完全落在实体区外的整块直接不送去生成网格。
  const chunks =
    keepBoxes === null
      ? scene.chunks
      : scene.chunks.filter((chunk) => keepBoxes.some((box) => chunkTouchesBox(chunk, box)));
  return {
    mode,
    showScan: false,
    scanMissing: false,
    entities: drawable.filter((e) => entityRegionKind(e, scene.regions) === 'physical'),
    templates,
    voxels: { chunks, keepBoxes, palette },
    virtualRegions: [],
    anchors,
  };
}

/** 区块（32³ 格）和格子盒是否相交。 */
function chunkTouchesBox(chunk: LayerChunk, box: GridBox): boolean {
  const size = 32;
  const min = [chunk.cx * size, chunk.cy * size, chunk.cz * size];
  return [0, 1, 2].every((k) => min[k]! < box[k + 3]! && min[k]! + size > box[k]!);
}

/** 组合里一个成员的摆放：偏移（格）和绕 y 轴的旋转（度）。单个空间是零摆放。 */
export interface Placement {
  readonly offset: Vec3;
  readonly rotation: number;
}

export const IDENTITY_PLACEMENT: Placement = { offset: [0, 0, 0], rotation: 0 };

/**
 * 成员空间坐标（米）→ 组合坐标（米）：先绕成员原点按 y 轴旋转，再平移 offset·GRID_UNIT。
 * 旋转方向与形状的 yaw 相同（x' = x cos + z sin，z' = −x sin + z cos）。
 */
export function placePoint(
  placement: Placement,
  point: readonly number[],
): [number, number, number] {
  const theta = (placement.rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(theta) * 1e12) / 1e12;
  const sin = Math.round(Math.sin(theta) * 1e12) / 1e12;
  const x = point[0] ?? 0;
  const y = point[1] ?? 0;
  const z = point[2] ?? 0;
  return [
    x * cos + z * sin + placement.offset[0] * GRID_UNIT,
    y + placement.offset[1] * GRID_UNIT,
    -x * sin + z * cos + placement.offset[2] * GRID_UNIT,
  ];
}

/** 锚点的位置（米，成员空间坐标）：点锚点取点，盒子锚点取顶面中心；空间级锚点没有位置。 */
export function anchorPosition(anchor: Anchor): [number, number, number] | null {
  if (anchor.position) return [anchor.position[0], anchor.position[1], anchor.position[2]];
  if (anchor.box) {
    const b = anchor.box;
    return [((b[0] + b[3]) / 2) * GRID_UNIT, b[4] * GRID_UNIT, ((b[2] + b[5]) / 2) * GRID_UNIT];
  }
  return null;
}

/** 交给三维场景的一个成员：某个空间在某个视图下的内容和它的摆放。 */
export interface MemberContent {
  readonly spaceId: string;
  /** 组合页给成员标名字（纯文本）。 */
  readonly name?: string;
  readonly view: ViewContent;
  /** 原始视图的扫描模型（glb 字节）和对齐变换（列主序 4×4）。 */
  readonly scan?: ArrayBuffer | null;
  readonly scanTransform?: readonly number[];
  readonly placement: Placement;
}

/** 三维场景的全部内容：单个空间就是一个零摆放的成员；组合页有多个成员和连接。 */
export interface SceneContent {
  readonly mode: ViewMode;
  readonly members: readonly MemberContent[];
  readonly links: readonly UniverseLink[];
}

/** 场景的高度范围（米），用于剖切滑块的上下限。 */
export function sceneHeightRange(scene: SceneDocument): { min: number; max: number } {
  let max = 0;
  for (const entity of scene.entities) {
    if (entity.kind !== 'template' && entity.bounds) max = Math.max(max, entity.bounds.max[1]);
  }
  for (const region of scene.regions) {
    for (const box of region.boxes) max = Math.max(max, box[4] * GRID_UNIT);
  }
  return { min: 0, max: max > 0 ? max : 3 };
}
