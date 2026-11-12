import { readFileSync } from 'node:fs';
import { boxSubtract, boxUnion, coveredBy, type GridBox } from '../core/grid.js';
import { isObjectId } from '../core/ids.js';
import { isSha256Hex } from '../core/hash.js';
import { parseOps, type Op } from '../core/ops.js';
import { entityFootprint, type EntityBody } from '../core/record.js';
import { validateLayout } from '../commands/admin.js';
import { CliError } from '../commands/common.js';
import type { BaseState } from './files.js';

export interface EditAsset {
  hash: string;
  format: 'glb' | 'png' | 'jpg' | 'jpeg' | 'webp';
  /** 工作区内的相对文件路径；省略时按 assets/<hash>.<format> 查找。 */
  path?: string;
}

/** 直接复用空间操作协议，不再定义建筑、家具或背景专用的编辑模型。 */
export interface EditPlan {
  version: 1;
  message: string;
  baseSeq?: number;
  ops: Op[];
  assets?: EditAsset[];
}

export function parseEdit(raw: unknown): EditPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new CliError('编辑计划必须是对象');
  const plan = raw as Record<string, unknown>;
  if (
    Object.keys(plan).some(
      (key) => !['version', 'message', 'baseSeq', 'ops', 'assets'].includes(key),
    )
  )
    throw new CliError('编辑计划有未知字段');
  if (plan.version !== 1 || typeof plan.message !== 'string' || !Array.isArray(plan.ops))
    throw new CliError('编辑计划需要 version=1、message 和标准 ops 列表');
  if (
    plan.baseSeq !== undefined &&
    (!Number.isSafeInteger(plan.baseSeq) || Number(plan.baseSeq) < 0)
  )
    throw new CliError('编辑计划 baseSeq 必须是非负整数');
  if (plan.assets !== undefined && !Array.isArray(plan.assets))
    throw new CliError('assets 必须是列表');
  const assets = (plan.assets ?? []) as EditAsset[];
  const seen = new Set<string>();
  for (const asset of assets) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      !isSha256Hex(asset.hash) ||
      !['glb', 'png', 'jpg', 'jpeg', 'webp'].includes(asset.format) ||
      (asset.path !== undefined && (typeof asset.path !== 'string' || !asset.path)) ||
      Object.keys(asset).some((key) => !['hash', 'format', 'path'].includes(key)) ||
      seen.has(asset.hash)
    )
      throw new CliError('资源需要唯一内容哈希、受支持的格式及可选相对路径');
    seen.add(asset.hash);
  }
  return {
    version: 1,
    message: plan.message,
    ops: parseOps(plan.ops),
    assets,
    ...(plan.baseSeq !== undefined ? { baseSeq: Number(plan.baseSeq) } : {}),
  };
}

export function readEdit(file: string): EditPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`无法读取编辑计划：${(error as Error).message}`);
  }
  return parseEdit(raw);
}

/** 可选布局辅助：任何物件都可使用，既不要求背景标记，也不按名称判断用途。 */
export function placementLayout(
  base: BaseState,
  entities: readonly EntityBody[],
  plotId: string,
  message: string,
) {
  if (!isObjectId(plotId)) throw new CliError('地块编号不合法');
  if (!entities.length) throw new CliError('布局规划需要待放置物件');
  const plot = base.space.plots.find((item) => item.id === plotId);
  const regionId = plot?.regionId ?? plotId;
  const region = base.space.regions.find((item) => item.id === regionId);
  if (region && region.kind !== 'virtual') throw new CliError('地块必须位于虚拟区域');
  if (base.space.plots.some((item) => item.id !== plotId && item.regionId === regionId))
    throw new CliError('目标区域包含其他地块，不能自动调整；请新建独立地块');
  const bound = [
    ...entities.map(entityFootprint),
    ...(plot?.boxes ?? []),
    ...(region?.boxes ?? []),
  ].reduce(boxUnion);
  let boxes: GridBox[] = [bound];
  for (const occupied of base.space.regions
    .filter((item) => item.id !== regionId)
    .flatMap((item) => item.boxes)) {
    boxes = boxes.flatMap((box) => boxSubtract(box, occupied));
    if (boxes.length > 64) throw new CliError('可用区域超过 64 个盒子，请缩小范围或拆分地块');
  }
  for (const entity of entities)
    if (!coveredBy(entityFootprint(entity), boxes))
      throw new CliError(`物件 ${entity.entityId} 与已有区域重叠，请先移动模型或按区域边界切分`);
  const regions = base.space.regions
    .filter((item) => item.id !== regionId)
    .concat({
      ...region,
      id: regionId,
      kind: 'virtual',
      name: region?.name ?? message,
      boxes,
    });
  const plots = base.space.plots
    .filter((item) => item.id !== plotId)
    .concat({
      ...plot,
      id: plotId,
      regionId,
      name: plot?.name ?? message,
      boxes,
    });
  const error = validateLayout(regions, plots);
  if (error) throw new CliError(error);
  return { regions, plots, message };
}

/** 固定程序只读取经过校验的数据；用户不需要写建造脚本。 */
export const EDIT_SCRIPT = `import { readFileSync } from 'node:fs';
export default function build(base) {
  const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));
  if (plan.baseSeq !== undefined && plan.baseSeq !== base.seq)
    throw new Error('空间版本与编辑计划不一致，请重新读取空间并核对改动');
  return { message: plan.message, ops: plan.ops };
}
`;
