import type {
  Anchor,
  EntityBody,
  GridBox,
  Palette,
  Plot,
  Region,
  ScanRef,
  Snapshot,
} from './api/types';
import type { PublicClient } from './api/client';
import { GRID_UNIT } from './chunk';
import type { TemplateTable } from './shapes/types';
import { composeVoxels, type LayerChunk, type VoxelWorld } from './voxels';

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

/** 快照 → 场景文档：并发下载区块（每个都核对哈希）。 */
export async function loadScene(
  client: Pick<PublicClient, 'chunk'>,
  snapshot: Snapshot,
  name?: string,
): Promise<SceneDocument> {
  const refs = [...snapshot.chunks];
  const chunks: LayerChunk[] = new Array(refs.length);
  let next = 0;
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
  /** 要画的物件（不含模板）。 */
  readonly entities: readonly EntityBody[];
  readonly templates: TemplateTable;
  readonly voxels: VoxelWorld;
  /** 方块表（方块编号 → 颜色、类别）。 */
  readonly palette: Palette;
  /** 需要画边界光效和"虚拟"标签的区域。 */
  readonly virtualRegions: readonly Region[];
  readonly anchors: readonly Anchor[];
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
  if (mode === 'raw') {
    const hasScan = (scene.scan?.webModelHashes.length ?? 0) > 0;
    return {
      mode,
      showScan: hasScan,
      scanMissing: !hasScan,
      entities: [],
      templates,
      voxels: new Map(),
      palette: scene.palette,
      virtualRegions: [],
      anchors,
    };
  }
  const drawable = scene.entities.filter((e) => e.kind !== 'template' && e.shape !== undefined);
  if (mode === 'extended') {
    return {
      mode,
      showScan: false,
      scanMissing: false,
      entities: drawable,
      templates,
      voxels: composeVoxels(scene.chunks),
      palette: scene.palette,
      virtualRegions: scene.regions.filter((r) => r.kind === 'virtual'),
      anchors,
    };
  }
  const physical = scene.regions.filter((r) => r.kind === 'physical');
  const keep =
    physical.length === 0
      ? undefined
      : (gx: number, gy: number, gz: number) =>
          physical.some((r) => r.boxes.some((b) => boxContainsCell(b, gx, gy, gz)));
  return {
    mode,
    showScan: false,
    scanMissing: false,
    entities: drawable.filter((e) => entityRegionKind(e, scene.regions) === 'physical'),
    templates,
    voxels: composeVoxels(scene.chunks, keep),
    palette: scene.palette,
    virtualRegions: [],
    anchors,
  };
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
