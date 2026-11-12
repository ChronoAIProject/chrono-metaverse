import { readFileSync } from 'node:fs';
import { parseEntityBody, validateEntityBody, type EntityBody } from '../core/record.js';
import { CliError } from '../commands/common.js';
import type { BaseState } from './files.js';
import { placementLayout, type EditPlan } from './edit.js';

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

/** 旧背景格式只是内容提供方；进入统一编辑流程前转成标准空间操作。 */
export function contextEdit(base: BaseState, artifact: ContextArtifact): EditPlan {
  checkContextOwnership(base, artifact);
  const ids = new Set(artifact.entities.map((entity) => entity.entityId));
  return {
    version: 1,
    message: artifact.message,
    baseSeq: base.space.seq,
    assets: [...new Set(artifact.entities.map((entity) => entity.assetHash!))].map((hash) => ({
      hash,
      format: 'glb',
    })),
    ops: [
      ...base.entities
        .filter(
          (entity) =>
            entity.layer === 'ext' &&
            entity.props?.background === true &&
            entity.entityId.startsWith(artifact.entityPrefix) &&
            !ids.has(entity.entityId),
        )
        .map((entity) => ({ op: 'removeEntity' as const, entityId: entity.entityId })),
      ...artifact.entities.map((entity) => ({ op: 'placeEntity' as const, entity })),
    ],
  };
}

export function contextLayout(base: BaseState, artifact: ContextArtifact, plotId: string) {
  checkContextOwnership(base, artifact);
  return placementLayout(base, artifact.entities, plotId, artifact.message);
}
