import { readFileSync } from 'node:fs';
import { boxSubtract, boxUnion, coveredBy, type GridBox } from '../core/grid.js';
import { isObjectId } from '../core/ids.js';
import {
  entityFootprint,
  parseEntityBody,
  validateEntityBody,
  type EntityBody,
} from '../core/record.js';
import { validateLayout } from '../commands/admin.js';
import { CliError } from '../commands/common.js';
import type { BaseState } from './files.js';

export interface ContextArtifact {
  version: 1;
  entityPrefix: string;
  message: string;
  entities: EntityBody[];
}

/** 只接受数据文件，下载或上传的内容不能变成建造代码。 */
export function readContext(file: string): ContextArtifact {
  let raw: ContextArtifact;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as ContextArtifact;
  } catch (error) {
    throw new CliError(`无法读取背景清单：${(error as Error).message}`);
  }
  if (
    raw === null ||
    typeof raw !== 'object' ||
    raw.version !== 1 ||
    typeof raw.entityPrefix !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}\.$/.test(raw.entityPrefix) ||
    typeof raw.message !== 'string' ||
    !Array.isArray(raw.entities) ||
    raw.entities.length === 0
  )
    throw new CliError('背景清单格式错误：需要 version=1、稳定前缀、说明和非空物件列表');
  const ids = new Set<string>();
  const entities = raw.entities.map((value) => {
    const entity = parseEntityBody(value);
    validateEntityBody(entity, new Map());
    if (
      entity.layer !== 'ext' ||
      !entity.entityId.startsWith(raw.entityPrefix) ||
      entity.props?.background !== true ||
      !entity.assetHash ||
      ids.has(entity.entityId)
    )
      throw new CliError(`背景物件 ${entity.entityId} 必须有独立编号、模型哈希和背景标记`);
    ids.add(entity.entityId);
    return entity;
  });
  return { ...raw, entities };
}

export function checkContextOwnership(base: BaseState, artifact: ContextArtifact): void {
  for (const entity of base.entities) {
    if (entity.entityId.startsWith(artifact.entityPrefix) && entity.props?.background !== true) {
      throw new CliError(`背景前缀与现有主体 ${entity.entityId} 冲突，请换一个前缀`);
    }
  }
}

/** 布局只生成计划；保留其他区域、地块以及目标地块原有范围。 */
export function contextLayout(base: BaseState, artifact: ContextArtifact, plotId: string) {
  if (!isObjectId(plotId)) throw new CliError('背景地块编号不合法');
  checkContextOwnership(base, artifact);
  const plot = base.space.plots.find((item) => item.id === plotId);
  const regionId = plot?.regionId ?? plotId;
  const region = base.space.regions.find((item) => item.id === regionId);
  if (region && region.kind !== 'virtual') throw new CliError('背景不能使用实体区域作为地块');
  if (base.space.plots.some((item) => item.id !== plotId && item.regionId === regionId)) {
    throw new CliError('目标区域包含其他地块，不能自动调整；请新建独立背景地块');
  }
  const bound = [
    ...artifact.entities.map(entityFootprint),
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
  for (const entity of artifact.entities) {
    if (!coveredBy(entityFootprint(entity), boxes))
      throw new CliError(`背景 ${entity.entityId} 与已有区域重叠，请先移动模型或按区域边界切分`);
  }
  const regions = base.space.regions
    .filter((item) => item.id !== regionId)
    .concat({
      ...region,
      id: regionId,
      kind: 'virtual',
      name: region?.name ?? artifact.message,
      boxes,
    });
  const plots = base.space.plots
    .filter((item) => item.id !== plotId)
    .concat({
      ...plot,
      id: plotId,
      regionId,
      name: plot?.name ?? artifact.message,
      boxes,
    });
  const error = validateLayout(regions, plots);
  if (error) throw new CliError(error);
  return { regions, plots, message: artifact.message };
}

/** 独立的生成脚本不覆盖用户已有的 build/main.ts。 */
export const CONTEXT_SCRIPT = `import { readFileSync } from 'node:fs';
export default function build(base, kit) {
  const artifact = JSON.parse(readFileSync(new URL('./entities.json', import.meta.url), 'utf8'));
  const ids = new Set(artifact.entities.map(entity => entity.entityId));
  return { message: artifact.message, ops: [
    ...base.entities.filter(entity => entity.layer === 'ext' && entity.props?.background === true &&
      entity.entityId.startsWith(artifact.entityPrefix) && !ids.has(entity.entityId))
      .map(entity => kit.removeEntity(entity.entityId)),
    ...artifact.entities.map(entity => kit.placeEntity(entity)),
  ] };
}
`;
