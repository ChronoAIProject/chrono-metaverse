import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
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
  const survey: { tileSource: string; features: { featureId: number }[] } = JSON.parse(
    readFileSync(new URL('../references/pedestrian-asphalt.json', import.meta.url), 'utf8'),
  );
  let ground: { groundLayers?: unknown[] } = {};
  if ('sources' in content && Array.isArray(content.sources) && content.sources.length === 1 &&
      content.sources[0]?.url === survey.tileSource &&
      'groundLayers' in content && Array.isArray(content.groundLayers)) {
    // OpenMapTiles groups asphalt and stone areas under the same pedestrian subclass.
    ground = { groundLayers: content.groundLayers.map((layer) => {
      if (layer?.layer !== 'transportation' || layer.property !== 'subclass' ||
          layer.material !== 'pavers' || !Array.isArray(layer.values) || !layer.values.includes('pedestrian') ||
          (layer.excludeFeatureIds !== undefined && !Array.isArray(layer.excludeFeatureIds))) return layer;
      const ids = new Set<number>(layer.excludeFeatureIds);
      for (const { featureId } of survey.features) ids.add(featureId);
      return { ...layer, excludeFeatureIds: [...ids] };
    }) };
  }
  const shoreSurveys = ['ns-square-waterfront', 'bay-landings'].map(name =>
    JSON.parse(readFileSync(new URL(`../references/${name}.json`, import.meta.url), 'utf8')).waterlineEdit,
  );
  const sources = 'sources' in content && Array.isArray(content.sources) ? content.sources : [];
  const towerSurvey = JSON.parse(readFileSync(new URL('../references/marina-centre-towers.json', import.meta.url), 'utf8')) as {
    tileSource: string; layer: string; reference: unknown; excludeBuildingParts: unknown[];
  };
  const previousParts = 'excludeBuildingParts' in style ? style.excludeBuildingParts : [];
  let towerParts = {};
  if (sources.length === 1 && sources[0]?.url === towerSurvey.tileSource &&
      'layer' in style && style.layer === towerSurvey.layer &&
      'reference' in content && isDeepStrictEqual(content.reference, towerSurvey.reference) && Array.isArray(previousParts)) {
    const additions = towerSurvey.excludeBuildingParts.filter(part => !previousParts.some(saved => isDeepStrictEqual(saved, part)));
    if (previousParts.length + additions.length <= 256 && additions.length) {
      towerParts = { excludeBuildingParts: [...previousParts, ...additions] };
    }
  }
  const waterLayer = 'waterLayer' in content && content.waterLayer === 'water';
  let water = {};
  if (waterLayer) {
    const previous = 'waterlineEdits' in content ? content.waterlineEdits : [];
    if (Array.isArray(previous)) {
      const additions = shoreSurveys.filter(survey =>
        sources.some(s => s?.url === survey.source) &&
        !previous.some(edit => edit?.source === survey.source && edit.featureId === survey.featureId &&
          isDeepStrictEqual(edit.tile, survey.tile) && isDeepStrictEqual(edit.from, survey.from)),
      );
      const available = additions.slice(0, Math.max(0, 16 - previous.length));
      if (available.length) water = { waterlineEdits: [...previous, ...available] };
    }
  }
  const { waterSample, rippleWind } = JSON.parse(readFileSync(new URL('../references/marina-reservoir-water.json', import.meta.url), 'utf8'));
  const { rmsGravitySlope: _slope, ...previousSample } = waterSample;
  if (waterLayer && sources.some(s => s?.url === waterSample.source) &&
      (!('waterSample' in content) || isDeepStrictEqual(content.waterSample, previousSample))) {
    water = { ...water, waterSample };
  }
  if (waterLayer && sources.some(s => s?.url === waterSample.source) && !('rippleWindFrom' in content)) {
    water = { ...water, rippleWindFrom: rippleWind.fromDegrees };
  }
  const { facadeReflections, capture } = JSON.parse(readFileSync(new URL('../references/district-window-reflections.json', import.meta.url), 'utf8'));
  const oldAtlas = capture.previousTexture as string;
  const previousReflections = { ...facadeReflections, texture: oldAtlas };
  const migrateReflections = 'facadeReflections' in content &&
    isDeepStrictEqual(content.facadeReflections, previousReflections);
  const addReflections = (!('facadeReflections' in content) || migrateReflections) &&
    'facade' in style && style.facade === 'urban' && sources.some(source => source?.url === facadeReflections.source);
  const existingTextures = surroundings.textures ?? [];
  const textures = addReflections ? { textures: [...new Set([
    ...existingTextures.map(hash => migrateReflections && hash === oldAtlas ? facadeReflections.texture as string : hash),
    facadeReflections.texture as string,
  ])] } : {};
  return { ...surroundings, ...textures, props: { ...surroundings.props, externalContent: {
    ...content, ...ground, ...water, ...(addReflections ? { facadeReflections } : {}), extrusion: { ...style, excludeBounds, ...towerParts },
  } } };
}

/** Only migrate skies previously distributed with the scene. */
function bayDaylight(saved: EntityBody | undefined, configured: EntityBody | null): EntityBody | null {
  if (!saved || !configured) return saved ?? configured;
  const environment = saved.props?.environment as { sky?: Record<string, unknown> } | undefined;
  const target = configured.props?.environment as { sky?: { texture: string; radiance?: { texture: string } } } | undefined;
  if (!environment?.sky || !target?.sky) return saved;
  const previous = JSON.parse(readFileSync(new URL('../references/partly-cloudy-sky.json', import.meta.url), 'utf8'));
  const base = { texture: previous.texture, yaw: previous.yaw };
  const { diffuseProbe: _probe, ...daylight } = previous.daylight;
  const northFacing = JSON.parse(readFileSync(new URL('../references/north-facing-clear-sky.json', import.meta.url), 'utf8'));
  const { radiance: _oldRadiance, ...previousDisplaySky } = northFacing;
  const morningClear = JSON.parse(readFileSync(new URL('../references/morning-clear-sky.json', import.meta.url), 'utf8'));
  const { radiance: _clearRadiance, ...morningDisplaySky } = morningClear;
  const { radiance, ...displaySky } = target.sky;
  const presets = [
    morningClear,
    morningDisplaySky,
    displaySky,
    previousDisplaySky,
    northFacing,
    base,
    { ...base, daylight: { ...daylight, directFraction: 0.58 } },
    { ...previous, daylight },
    previous,
    JSON.parse(readFileSync(new URL('../references/first-clear-sky.json', import.meta.url), 'utf8')),
    JSON.parse(readFileSync(new URL('../references/integrated-clear-sky.json', import.meta.url), 'utf8')),
  ];
  if (!presets.some((preset) => isDeepStrictEqual(preset, environment.sky))) return saved;
  const textures = new Set(saved.textures);
  textures.delete(String(environment.sky.texture));
  const oldRadiance = environment.sky.radiance as { texture?: string } | undefined;
  if (oldRadiance?.texture) textures.delete(oldRadiance.texture);
  textures.add(target.sky.texture);
  if (radiance) textures.add(radiance.texture);
  return {
    ...saved,
    textures: [...textures],
    props: {
      ...saved.props,
      source: configured.props?.source,
      日间照明: configured.props?.日间照明,
      environment: { ...environment, sky: target.sky },
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
    // These surveyed towers are already aligned to the same final member coordinates as the census tiles.
    const marinaCentre: EntityBody[] = JSON.parse(
      readFileSync(new URL('./marina-centre-towers.json', import.meta.url), 'utf8'),
    );
    entities.push(...marinaCentre);
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
