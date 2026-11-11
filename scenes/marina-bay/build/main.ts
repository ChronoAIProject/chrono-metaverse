import { readFileSync } from 'node:fs';
import type { BuildBase, EntityBody, Kit } from '@chrono-metaverse/sdk';

/** 滨海湾扩展引用 OneMap 转换结果，室内沿用已有的重建物件。 */
export default function build(base: BuildBase, kit: Kit) {
  const buildings: EntityBody[] = JSON.parse(
    readFileSync(new URL('./onemap-entities.json', import.meta.url), 'utf8'),
  );
  const ground: EntityBody[] = JSON.parse(
    readFileSync(new URL('./ground.json', import.meta.url), 'utf8'),
  );
  const ids = new Set([...buildings, ...ground].map((entity) => entity.entityId));
  return {
    message: '基于 OneMap 官方三维建筑和正射影像，增加 MBFC Tower 1 十四层窗外的滨海湾扩展场景',
    ops: [
      ...base.entities
        .filter((entity) => entity.layer === 'ext' && entity.entityId.startsWith('bay.') && !ids.has(entity.entityId))
        .map((entity) => kit.removeEntity(entity.entityId)),
      ...[...buildings, ...ground].map((entity) => kit.placeEntity({
        ...entity,
        props: { ...entity.props, background: true },
      })),
    ],
  };
}
