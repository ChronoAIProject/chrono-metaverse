import { gridBox, type Aabb, type GridBox, type Vec3 } from '../core/grid.js';
import {
  parseOp,
  validateBlockDef,
  type AddBlockOp,
  type BlockDef,
  type BlockKind,
  type BlockRef,
  type CopyRegionOp,
  type CreateAnchorOp,
  type FillOp,
  type HollowBoxOp,
  type MoveAnchorOp,
  type Op,
  type PlaceEntityOp,
  type RemoveAnchorOp,
  type RemoveEntityOp,
  type ReplaceOp,
  type UpdateAnchorOp,
} from '../core/ops.js';
import {
  normalizeEntityBody,
  validateAnchorBody,
  validateEntityBody,
  type AnchorBody,
  type AnchorKind,
  type DataVisibility,
  type EntityBody,
  type EntityKind,
} from '../core/record.js';
import { shapeBounds, type Shape, type TemplateTable } from '../core/shape.js';
import { rgb, type ColorInput } from './shapes.js';
import { tidy } from './units.js';

/**
 * 高层操作的构造函数（设计 8.3）：填充、空心盒、替换、复制区域、新增方块、放物件、
 * 新建 / 移动 / 修改锚点。返回的就是接口请求体里的 JSON，构造时按服务端的规则检查结构。
 *
 * 方块操作的盒子用**格** `[x0, y0, z0, x1, y1, z1]`（半开区间）；物件的形状和位置用**米**。
 * 方块编号：0 = 不覆盖（清掉扩展层这一格），1 = 空气覆盖（挖掉下层的方块），2 起是方块表；
 * 也可以用 `addBlock` 新增方块后用它的名称引用。
 */

function checked<T extends Op>(op: T): T {
  return parseOp(op) as T;
}

/** 盒子里的每一格写成 `block`。 */
export function fill(box: GridBox | readonly number[], block: BlockRef): FillOp {
  return checked({ op: 'fill', box: gridBox(box), block });
}

/** 空心盒：只写外壳（默认壁厚 1 格）。 */
export function hollowBox(
  box: GridBox | readonly number[],
  block: BlockRef,
  thickness?: number,
): HollowBoxOp {
  return checked({
    op: 'hollowBox',
    box: gridBox(box),
    block,
    ...(thickness !== undefined ? { thickness } : {}),
  });
}

/** 盒子里当前看得到的方块是 `from` 的格子，在扩展层写成 `to`。 */
export function replace(box: GridBox | readonly number[], from: BlockRef, to: BlockRef): ReplaceOp {
  return checked({ op: 'replace', box: gridBox(box), from, to });
}

/** 把 `source` 的扩展层内容原样复制到以 `to` 为最小角的位置（格）。 */
export function copyRegion(source: GridBox | readonly number[], to: Vec3): CopyRegionOp {
  return checked({ op: 'copyRegion', source: gridBox(source), to });
}

/** 新增方块：用名称引用，发布时由服务端分配正式编号。 */
export function addBlock(
  name: string,
  kind: BlockKind,
  look: { color: ColorInput } | { texture: { top: string; side: string; bottom: string } },
  tags: readonly string[] = [],
): AddBlockOp {
  const block: BlockDef =
    'color' in look
      ? { name, kind, color: rgb(look.color) as [number, number, number], tags }
      : { name, kind, texture: look.texture, tags };
  validateBlockDef(block);
  return checked({ op: 'addBlock', block });
}

/** 放物件（新建或替换同编号的扩展层物件）。 */
export function placeEntity(entity: EntityBody): PlaceEntityOp {
  return checked({ op: 'placeEntity', entity });
}

export function removeEntity(entityId: string): RemoveEntityOp {
  return checked({ op: 'removeEntity', entityId });
}

export function createAnchor(anchor: AnchorBody): CreateAnchorOp {
  validateAnchorBody(anchor);
  return checked({ op: 'createAnchor', anchor });
}

/** 移动锚点：给出新的 `box`（格）或 `position`（米）。 */
export function moveAnchor(
  anchorId: string,
  to: { box: GridBox | readonly number[] } | { position: Vec3 },
): MoveAnchorOp {
  return checked({
    op: 'moveAnchor',
    anchorId,
    ...('box' in to ? { box: gridBox(to.box) } : { position: to.position }),
  });
}

/** 修改锚点的标签、可见级别或类型（至少给一项）。 */
export function updateAnchor(
  anchorId: string,
  changes: { label?: string; visibility?: DataVisibility; kind?: AnchorKind },
): UpdateAnchorOp {
  return checked({ op: 'updateAnchor', anchorId, ...changes });
}

export function removeAnchor(anchorId: string): RemoveAnchorOp {
  return checked({ op: 'removeAnchor', anchorId });
}

// ---------------------------------------------------------------------------
// 物件和锚点记录
// ---------------------------------------------------------------------------

export interface EntityOptions {
  /** 默认 `object`；墙、地面、玻璃用 `structure`。 */
  readonly kind?: Exclude<EntityKind, 'template'>;
  /** 悬浮标签。 */
  readonly label?: string;
  readonly anchorId?: string;
  readonly regionId?: string;
  /** 不透明的键值，网站在信息面板里按纯文本列出。 */
  readonly props?: Readonly<Record<string, unknown>>;
  /** 形状里用到的模板（`instance`），计算包围盒需要。 */
  readonly templates?: TemplateTable;
}

/** 包围盒取到微米，去掉浮点噪声；误差远小于服务端允许的 1e-6 米。 */
function tidyBounds(bounds: Aabb): Aabb {
  return {
    min: [tidy(bounds.min[0]), tidy(bounds.min[1]), tidy(bounds.min[2])],
    max: [tidy(bounds.max[0]), tidy(bounds.max[1]), tidy(bounds.max[2])],
  };
}

/**
 * 扩展层物件记录：`bounds` 按形状自动计算（用到模板时要在 `templates` 里给出）。
 * 记录会按服务端的规则校验，不合法时立刻报错。
 */
export function entity(entityId: string, shape: Shape, options: EntityOptions = {}): EntityBody {
  const templates = options.templates ?? new Map<string, Shape>();
  const body = normalizeEntityBody({
    entityId,
    layer: 'ext',
    kind: options.kind ?? 'object',
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.anchorId !== undefined ? { anchorId: options.anchorId } : {}),
    ...(options.regionId !== undefined ? { regionId: options.regionId } : {}),
    shape,
    bounds: tidyBounds(shapeBounds(shape, templates)),
    props: options.props ?? {},
  });
  validateEntityBody(body, templates);
  return body;
}

/** 模板（同款物体）：形状写在模板自己的局部坐标里，物件用 `instance(编号)` 引用。 */
export function template(
  templateId: string,
  shape: Shape,
  options: { label?: string; templates?: TemplateTable } = {},
): EntityBody {
  const templates = new Map<string, Shape>(
    options.templates instanceof Map
      ? options.templates
      : Object.entries((options.templates ?? {}) as Record<string, Shape>),
  );
  templates.set(templateId, shape);
  const body = normalizeEntityBody({
    entityId: templateId,
    layer: 'ext',
    kind: 'template',
    ...(options.label !== undefined ? { label: options.label } : {}),
    shape,
    bounds: tidyBounds(shapeBounds(shape, templates)),
  });
  validateEntityBody(body, templates);
  return body;
}

/** 放一个物件：`place(id, shape, options)` = `placeEntity(entity(id, shape, options))`。 */
export function place(entityId: string, shape: Shape, options: EntityOptions = {}): PlaceEntityOp {
  return placeEntity(entity(entityId, shape, options));
}

/** 锚点记录：`box`（格）或 `position`（米）二选一；默认公开。 */
export function anchor(
  anchorId: string,
  kind: Exclude<AnchorKind, 'space'>,
  where: { box: GridBox | readonly number[] } | { position: Vec3 },
  options: { label?: string; visibility?: DataVisibility } = {},
): AnchorBody {
  const body: AnchorBody = {
    anchorId,
    kind,
    ...('box' in where ? { box: gridBox(where.box) } : { position: where.position }),
    ...(options.label !== undefined ? { label: options.label } : {}),
    visibility: options.visibility ?? 'public',
  };
  validateAnchorBody(body);
  return body;
}
