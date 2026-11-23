import { existsSync, readFileSync } from 'node:fs';
import type { BuildBase, EntityBody, Kit } from '@chrono-metaverse/sdk';
import { placeExterior, type Placement } from './placement.ts';
import { waterfront } from './waterfront.ts';

/** Keep the saved tile source and suppress the footprints replaced by the quay model. */
export function withBoatQuay(surroundings: EntityBody): EntityBody {
  const content = surroundings.props?.externalContent;
  if (!content || typeof content !== 'object' || !('extrusion' in content)) return surroundings;
  const style = content.extrusion;
  if (!style || typeof style !== 'object') return surroundings;
  const existing = 'excludeBounds' in style && Array.isArray(style.excludeBounds) ? style.excludeBounds : [];
  const masks: number[][] = JSON.parse(readFileSync(new URL('./boat-quay-exclusions.json', import.meta.url), 'utf8'));
  const saved = new Set(existing.map((bounds) => JSON.stringify(bounds)));
  const excludeBounds = [...existing, ...masks.filter((bounds) => !saved.has(JSON.stringify(bounds)))];
  return { ...surroundings, props: { ...surroundings.props, externalContent: {
    ...content, extrusion: { ...style, excludeBounds },
  } } };
}

interface BaySky {
  texture?: string;
  airHalfDistance?: number;
  daylight?: { directFraction?: number; diffuseProbe?: number[] };
}

/** Update this site's previous daylight preset while preserving the saved map and sky orientation. */
function bayDaylight(saved: EntityBody | undefined, configured: EntityBody | null): EntityBody | null {
  if (!saved || !configured) return saved ?? configured;
  const environment = saved.props?.environment as { sky?: BaySky } | undefined;
  const sky = environment?.sky;
  const target = (configured.props?.environment as { sky?: BaySky } | undefined)?.sky;
  if (!target?.daylight || !sky?.daylight || sky.texture !== target.texture ||
      sky.daylight.diffuseProbe !== undefined) return saved;
  const original = sky.airHalfDistance === undefined && sky.daylight.directFraction === 0.58;
  const clearDay = sky.airHalfDistance === target.airHalfDistance &&
    sky.daylight.directFraction === target.daylight.directFraction;
  if (!original && !clearDay) return saved;
  return {
    ...saved,
    props: {
      ...saved.props,
      日间照明: configured.props?.日间照明,
      environment: {
        ...environment,
        sky: { ...sky, airHalfDistance: target.airHalfDistance,
          daylight: { ...sky.daylight, directFraction: target.daylight.directFraction,
            diffuseProbe: target.daylight.diffuseProbe } },
      },
    },
  };
}

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
  const environment = bayDaylight(
    base.entities.find((entity) => entity.entityId === configured?.entityId), configured,
  );
  const ground: EntityBody[] = environment
    ? []
    : JSON.parse(readFileSync(new URL('./ground.json', import.meta.url), 'utf8'));
  const placement: Placement = JSON.parse(
    readFileSync(new URL('./placement.json', import.meta.url), 'utf8'),
  );
  const config = JSON.parse(readFileSync(new URL('../context.json', import.meta.url), 'utf8'));
  // Give surveyed exteriors the same daylight and cast shadows as the urban
  // ground and water. Preserve the looks supplied by individual asset authors.
  const cityBuildings = buildings.map((entity): EntityBody =>
    config.quay && entity.assetHash && !entity.material
      ? { ...entity, material: { shading: 'albedo' } }
      : entity,
  );
  const entities = [...cityBuildings, ...ground]
    .map((entity) => placeExterior(entity, placement))
    .concat(placement.hostEntities, environment ? [environment] : []);
  if (config.quay) {
    entities.push(...waterfront(kit, config.quay, placement, buildings[0]?.regionId));
    const streetscape: EntityBody[] = JSON.parse(
      readFileSync(new URL('./streetscape.json', import.meta.url), 'utf8'),
    );
    entities.push(...streetscape.map((entity) => placeExterior(entity, placement)));
    // The inherited census tiles already use final member coordinates.
    const streetTrees: EntityBody[] = JSON.parse(
      readFileSync(new URL('./city-street-trees.json', import.meta.url), 'utf8'),
    );
    entities.push(...streetTrees);
  }
  // 线上按视野流式加载的周边楼群独立于离线模型包，由空间保存其图层和保护范围。
  const surroundings = base.entities.find((entity) => entity.entityId === 'bay.city-surroundings');
  if (surroundings) entities.push(config.quay ? withBoatQuay(surroundings) : surroundings);
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
