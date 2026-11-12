import { existsSync, readFileSync } from 'node:fs';
import type { BuildBase, EntityBody, Kit } from '@chrono-metaverse/sdk';
import { placeExterior, type Placement } from './placement.ts';

/** 滨海湾扩展引用 OneMap 转换结果，室内沿用已有的重建物件。 */
export default function build(base: BuildBase, kit: Kit) {
  const buildings: EntityBody[] = JSON.parse(
    readFileSync(new URL('./onemap-entities.json', import.meta.url), 'utf8'),
  );
  const environmentFile = new URL('./environment.json', import.meta.url);
  const configured: EntityBody | null = existsSync(environmentFile)
    ? JSON.parse(readFileSync(environmentFile, 'utf8'))
    : null;
  // 已保存的物件是权威状态；重新构建不能恢复已被用户替换的有限地板或天空壳。
  const environment =
    base.entities.find((entity) => entity.entityId === configured?.entityId) ?? configured;
  const ground: EntityBody[] = environment
    ? []
    : JSON.parse(readFileSync(new URL('./ground.json', import.meta.url), 'utf8'));
  const placement: Placement = JSON.parse(
    readFileSync(new URL('./placement.json', import.meta.url), 'utf8'),
  );
  const config = JSON.parse(readFileSync(new URL('../context.json', import.meta.url), 'utf8'));
  const entities = [...buildings, ...ground]
    .map((entity) => placeExterior(entity, placement))
    .concat(placement.hostEntities, environment ? [environment] : []);
  const ids = new Set(entities.map((entity) => entity.entityId));
  return {
    message: config.message,
    ops: [
      ...base.entities
        .filter(
          (entity) =>
            entity.layer === 'ext' &&
            entity.entityId.startsWith(config.entityPrefix) &&
            !ids.has(entity.entityId),
        )
        .map((entity) => kit.removeEntity(entity.entityId)),
      ...entities.map((entity) =>
        kit.placeEntity({
          ...entity,
          props: { ...entity.props, background: true },
        }),
      ),
    ],
  };
}
