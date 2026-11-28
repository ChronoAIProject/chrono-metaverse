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
  const buildingSurveys = ['marina-centre-towers', 'garden-conservatories'].map(name =>
    JSON.parse(readFileSync(new URL(`../references/${name}.json`, import.meta.url), 'utf8')) as {
      tileSource: string; layer: string; reference: unknown; excludeBuildingParts: unknown[]; supersededBuildingParts?: unknown[];
    },
  );
  const previousParts = 'excludeBuildingParts' in style ? style.excludeBuildingParts : [];
  let towerParts = {};
  if (sources.length === 1 && 'layer' in style && 'reference' in content && Array.isArray(previousParts)) {
    const applicable = buildingSurveys.filter(survey => sources[0]?.url === survey.tileSource &&
      style.layer === survey.layer && isDeepStrictEqual(content.reference, survey.reference));
    const superseded = applicable.flatMap(survey => survey.supersededBuildingParts ?? []);
    const retained = previousParts.filter(saved => !superseded.some(part => isDeepStrictEqual(saved, part)));
    const additions = applicable.flatMap(survey => survey.excludeBuildingParts).filter(part =>
      !retained.some(saved => isDeepStrictEqual(saved, part)));
    if (retained.length + additions.length <= 256 && (additions.length || retained.length !== previousParts.length)) {
      towerParts = { excludeBuildingParts: [...retained, ...additions] };
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
  const { waterSample, rippleWind, multiDateReflectance } = JSON.parse(readFileSync(new URL('../references/marina-reservoir-water.json', import.meta.url), 'utf8'));
  const centralSample = { ...waterSample, radius: 440 };
  const multiDateSample = { ...centralSample, reflectance: multiDateReflectance };
  const { rmsRippleSlope: _ripple, ...gravitySample } = multiDateSample;
  const { rmsGravitySlope: _slope, ...previousSample } = gravitySample;
  const originalRippleSample = { ...gravitySample, rmsRippleSlope: 0.115 };
  if (waterLayer && sources.some(s => s?.url === waterSample.source) &&
      (!('waterSample' in content) || isDeepStrictEqual(content.waterSample, centralSample) ||
       isDeepStrictEqual(content.waterSample, multiDateSample) ||
       isDeepStrictEqual(content.waterSample, originalRippleSample) ||
       isDeepStrictEqual(content.waterSample, gravitySample) ||
       isDeepStrictEqual(content.waterSample, previousSample))) {
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
  // Leave room for the cross-tile dome exclusions in the saved 16 KiB props record.
  const credit = surroundings.props?.['说明'] === '按现有精细模型的局部范围保护原楼体，其余位置按开放轮廓和高度绘制远近建筑；窗格与材质为程序化外观。' && 'excludeBuildingParts' in towerParts
    ? { '说明': '实测楼体优先，轮廓楼按地图高度绘制，窗面材质为估算。' } : {};
  return { ...surroundings, ...textures, props: { ...surroundings.props, ...credit, externalContent: {
    ...content, ...ground, ...water, ...(addReflections ? { facadeReflections } : {}), extrusion: { ...style, excludeBounds, ...towerParts },
  } } };
}

/** Facade cladding is surveyed against one source in final member coordinates. */
function withSkylineFacades(surroundings: EntityBody): EntityBody[] {
  const content = surroundings.props?.externalContent;
  if (!content || typeof content !== 'object' || !('extrusion' in content)) return [surroundings];
  const style = content.extrusion;
  const survey = JSON.parse(readFileSync(new URL('../references/skyline-finishes/footprints.json', import.meta.url), 'utf8'));
  if (!style || typeof style !== 'object' || !('layer' in style) || style.layer !== survey.layer ||
      !('heightProperty' in style) || style.heightProperty !== 'render_height' ||
      !('minHeightProperty' in style) || style.minHeightProperty !== 'render_min_height' ||
      !('sources' in content) || !Array.isArray(content.sources) || content.sources.length !== 1 ||
      content.sources[0]?.url !== survey.source ||
      !('reference' in content) || !isDeepStrictEqual(content.reference, survey.reference)) return [surroundings];
  const models: EntityBody[] = JSON.parse(readFileSync(new URL('./skyline-facades.json', import.meta.url), 'utf8'));
  return [surroundings, ...models];
}

/** Replace the four registered vector lawns and their shared survey mesh together. */
function withPromontoryLawns(surroundings: EntityBody, environment: EntityBody | null): EntityBody[] {
  const content = surroundings.props?.externalContent;
  const map = (environment?.props?.environment as { map?: {
    origin?: unknown; longitude?: number; latitude?: number; heading?: number;
    sources?: { urlTemplate?: string }[]; surfaceDetail?: string;
  } } | undefined)?.map;
  if (!map || map.surfaceDetail !== 'urban' || !content || typeof content !== 'object' ||
      !('groundLayers' in content) || !Array.isArray(content.groundLayers)) return [surroundings];
  const survey = JSON.parse(readFileSync(new URL('../references/promontory-turf.json', import.meta.url), 'utf8'));
  const ref = survey.reference;
  if (map.sources?.[0]?.urlTemplate !== survey.imagery || !isDeepStrictEqual(map.origin, ref.origin) ||
      map.heading !== ref.heading || Math.abs((map.longitude ?? Infinity) - ref.longitude) > 1e-9 ||
      Math.abs((map.latitude ?? Infinity) - ref.latitude) > 1e-9 ||
      !('sources' in content) || !Array.isArray(content.sources) || content.sources.length !== 1 ||
      content.sources[0]?.url !== survey.tileSource || !('reference' in content) ||
      !isDeepStrictEqual(content.reference, ref)) return [surroundings];
  const eligible = content.groundLayers.find(layer => layer?.material === 'turf' &&
    layer.layer === survey.layer && layer.property === survey.property &&
    isDeepStrictEqual(layer.values, survey.values) &&
    (layer.excludeFeatureIds === undefined || Array.isArray(layer.excludeFeatureIds)));
  if (!eligible) return [surroundings];
  const ids = new Set<number>(eligible.excludeFeatureIds);
  for (const row of survey.features) ids.add(row.featureId);
  const groundLayers = content.groundLayers.map(layer =>
    layer === eligible ? { ...layer, excludeFeatureIds: [...ids] } : layer);
  const mesh: EntityBody = JSON.parse(readFileSync(new URL('./promontory-turf.json', import.meta.url), 'utf8'));
  return [{ ...surroundings, props: { ...surroundings.props, externalContent: { ...content, groundLayers } } }, mesh];
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
  const cloudyMorning = JSON.parse(readFileSync(new URL('../references/sunflowers-morning-sky.json', import.meta.url), 'utf8'));
  const { radiance: _cloudRadiance, ...cloudyDisplaySky } = cloudyMorning;
  const clearQwantani = JSON.parse(readFileSync(new URL('../references/qwantani-clear-sky.json', import.meta.url), 'utf8'));
  const { radiance: _qwantaniRadiance, ...clearQwantaniDisplay } = clearQwantani;
  const balancedQwantani = JSON.parse(readFileSync(new URL('../references/qwantani-balanced-sky.json', import.meta.url), 'utf8'));
  const { radiance: _balancedRadiance, ...balancedDisplaySky } = balancedQwantani;
  const scatteredMorning = JSON.parse(readFileSync(new URL('../references/qwantani-scattered-sky.json', import.meta.url), 'utf8'));
  const { radiance: _scatteredRadiance, ...scatteredDisplaySky } = scatteredMorning;
  const midMorning = JSON.parse(readFileSync(new URL('../references/qwantani-mid-morning-sky.json', import.meta.url), 'utf8'));
  const { radiance: _midMorningRadiance, ...midMorningDisplay } = midMorning;
  const diffuseMorning = JSON.parse(readFileSync(new URL('../references/qwantani-diffuse-morning-sky.json', import.meta.url), 'utf8'));
  const { radiance: _diffuseRadiance, ...diffuseDisplaySky } = diffuseMorning;
  const exposedMorning = JSON.parse(readFileSync(new URL('../references/qwantani-exposed-morning-sky.json', import.meta.url), 'utf8'));
  const { radiance: _exposedRadiance, ...exposedDisplay } = exposedMorning;
  const cloudHighlightSky = JSON.parse(readFileSync(new URL('../references/qwantani-cloud-highlight-sky.json', import.meta.url), 'utf8'));
  const { radiance: _highlightRadiance, ...cloudHighlightDisplay } = cloudHighlightSky;
  const { radiance, ...displaySky } = target.sky;
  const previousAir = { ...target.sky, airHalfDistance: 28800 };
  const { radiance: _previousProbe, ...previousAirDisplay } = previousAir;
  const previousTextures = [
    previousAir.texture,
    'd7538511f26c40e4a32424cf8d9eca1f1c9e151daca1e3b607444b837a333419',
    'ed15daa79ace156cf0db282fbeddbff900882d7253580f6e1705e57fd8822400',
  ];
  const presets = [
    ...previousTextures.flatMap(texture => [
      { ...previousAir, texture },
      { ...previousAirDisplay, texture },
    ]),
    cloudHighlightSky,
    cloudHighlightDisplay,
    exposedMorning,
    exposedDisplay,
    diffuseMorning,
    diffuseDisplaySky,
    midMorning,
    midMorningDisplay,
    scatteredMorning,
    scatteredDisplaySky,
    balancedQwantani,
    balancedDisplaySky,
    clearQwantani,
    clearQwantaniDisplay,
    cloudyMorning,
    cloudyDisplaySky,
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
      版权: configured.props?.版权,
      日间照明: configured.props?.日间照明,
      environment: { ...environment, sky: target.sky },
    },
  };
}

/** Use the surveyed paving and cut playing fields to bound the map's taller wild grass. */
function surveyedGrassCoverage(environment: EntityBody | null, hasSurveyedCover: boolean): EntityBody | null {
  const settings = environment?.props?.environment as { map?: { surfaceDetail?: string; grassExclusions?: unknown[]; mownLawns?: unknown[]; mownLawnSurfaceOffset?: number } } | undefined;
  if (!environment || settings?.map?.surfaceDetail !== 'urban') return environment;
  const survey = JSON.parse(readFileSync(new URL('../references/marina-promenade-ground.json', import.meta.url), 'utf8'));
  const padang = JSON.parse(readFileSync(new URL('../references/padang-playing-fields.json', import.meta.url), 'utf8')) as {
    zoom: number;
    tilePixelOrigin: [number, number];
    fields: { corners: [number, number][] }[];
  };
  const geographicRing = (pixels: number[][], origin: number[], zoom: number) => {
    const worldPixels = 256 * 2 ** zoom;
    return pixels.map(([x, y]) => {
      const longitude = (origin[0] + x) * 360 / worldPixels - 180;
      const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (origin[1] + y) / worldPixels))) * 180 / Math.PI;
      return [longitude, latitude];
    });
  };
  const playingFields = padang.fields.map(({ corners }) => [geographicRing(corners, padang.tilePixelOrigin, padang.zoom)]);
  const museum = JSON.parse(readFileSync(new URL('../references/artscience-promenade.json', import.meta.url), 'utf8')) as {
    zoom: number; pixelOrigin: number[]; palmCourt: number[][];
    segments: { bayEdge: number[][]; museumEdge: number[][] }[];
  };
  const museumPaving = [museum.palmCourt, ...museum.segments.map(({ bayEdge, museumEdge }) =>
    [...bayEdge, ...[...museumEdge].reverse()])].map(ring => [geographicRing(ring, museum.pixelOrigin, museum.zoom)]);
  const verges = JSON.parse(readFileSync(new URL('../references/marina-centre-roads/verges.json', import.meta.url), 'utf8')) as {
    surfaces: { surface: string; ring: number[][] }[];
  };
  const streetPaving = verges.surfaces.filter(row => row.surface === 'paving').map(row => [row.ring]);
  const beachRoad = JSON.parse(readFileSync(new URL('../references/beach-road-carriageways.json', import.meta.url), 'utf8')) as {
    grassExclusions: number[][][][];
  };
  const existing = settings.map.grassExclusions ?? [];
  // Equivalent longitude/latitude coordinates can differ at double precision after a draft roundtrip.
  const ringKey = (rings: unknown) => JSON.stringify(rings, (_, item: unknown) =>
    typeof item === 'number' ? Number(item.toFixed(9)) : item);
  const known = new Set(existing.map(ringKey));
  const additional = [...survey.concrete, ...playingFields, ...museumPaving, ...streetPaving, ...beachRoad.grassExclusions].filter(
    polygon => !known.has(ringKey(polygon)),
  );
  const turf = JSON.parse(readFileSync(new URL('../references/promontory-turf.json', import.meta.url), 'utf8')) as {
    features: { rings: number[][][] }[]; surfaceOffset: number;
  };
  const lawns = settings.map.mownLawns ?? [];
  const knownLawns = new Set(lawns.map(ringKey));
  const newLawns = turf.features.map(feature => feature.rings).filter(rings => !knownLawns.has(ringKey(rings)));
  const surveyedRings = new Set(turf.features.map(feature => ringKey(feature.rings)));
  const addSurfaceOffset = hasSurveyedCover && settings.map.mownLawnSurfaceOffset === undefined &&
    lawns.every(rings => surveyedRings.has(ringKey(rings)));
  if (!additional.length && !newLawns.length && !addSurfaceOffset) return environment;
  return { ...environment, props: { ...environment.props, environment: {
    ...settings, map: { ...settings.map, grassExclusions: [...existing, ...additional], mownLawns: [...lawns, ...newLawns],
      ...(addSurfaceOffset && { mownLawnSurfaceOffset: turf.surfaceOffset }) },
  } } };
}

/** 滨海湾扩展引用 OneMap 转换结果，室内沿用已有的重建物件。 */
// Unstructured grains can be sampled in any direction. The Fullerton paint follows separate road geometry.
const groundScanMaterials: Record<string, string[]> = {
  'bay.bayfront-bridge': [
    'Bayfront asphalt',
    'Walkway kerbs and median',
    'Deck and pier concrete',
    'Bridge footway aggregate',
  ],
  'bay.empress-lawn-obelisk-court': ['Empress Lawn turf'],
  'bay.esplanade-road-bridge': ['Esplanade carriageways', 'Esplanade footways'],
  'bay.fullerton-carriageways': ['Fullerton verge grass', 'Asphalt', 'Lane paint', 'Bus lane paint'],
  'bay.fullerton-courtyard-trees': ['Courtyard paving', 'Dark planter edging'],
  'bay.fullerton-dining-terraces': ['Recessed shop cladding'],
  'bay.fullerton-entrance-trees': ['Fullerton planted soil', 'Dark planter edging'],
  'bay.gallery-landing': ['Exposed deck edge', 'Deck soffit and piles', 'Landing wearing course'],
  'bay.helix-bridge': ['Asphalt wearing course', 'Pier concrete'],
  'bay.jubilee-bridge': ['Jubilee deck aggregate'],
  'bay.marina-centre-carriageways': [
    'Marina Centre planted verges',
    'Flyover parapets, box girders and piers',
    'Marina Centre road paint',
  ],
  'bay.marina-centre-worksite': ['Compacted gravel', 'Graded soil'],
  'bay.marina-promenade-park-ground': [
    'Marina Promenade ground cover',
    'Marina Promenade compacted gravel',
    'Marina Promenade concrete',
  ],
  'bay.merlion-lookout': ['Exposed deck edge', 'Deck soffit and piles', 'Landing wearing course'],
  'bay.merlion-park-steps': ['Merlion Park granite'],
  'bay.padang-playing-fields': ['Padang playing turf'],
  'bay.sands-skypark-gardens': ['Garden soil'],
  'bay.south-bay-landing': ['Exposed deck edge', 'Deck soffit and piles', 'Landing wearing course'],
  'bay.south-service-court': ['South court asphalt', 'South court faded guides'],
  'bay.straits-boulevard': ['Compacted gravel', 'Graded soil'],
  'bay.waterfront-skyline-facades.bayfront': ['ConcreteRoof'],
  'bay.waterfront-skyline-facades.beach-road': ['ConcreteRoof'],
  'bay.waterfront-skyline-facades.downtown': ['ConcreteRoof'],
  'bay.waterfront-skyline-facades.north': ['ConcreteRoof'],
  'bay.waterfront-skyline-facades.service-centre': ['ConcreteRoof'],
  'bay.west-bay-boat-landing': ['Exposed deck edge', 'Deck soffit and piles', 'Landing wearing course'],
};

const skyReflectionMaterials: Record<string, string[]> = JSON.parse(
  readFileSync(new URL('./waterfront-reflectors.json', import.meta.url), 'utf8'),
);

// Bind the charts independently of baked tree shade on the second UV channel.
const squareGranite = { grid: [5, 5], bond: 'stack', originU: .0955 };
const pavedSurfaces: Record<string, Record<string, number[] | typeof squareGranite>> = {
  'bay.empress-lawn-obelisk-court': { 'Dalhousie court granite': [4, 6] },
  'bay.padang-playing-fields': { 'Padang crossing': [4, 6] },
  'bay.artscience-promenade': { 'Museum promenade granite': [4, 6] },
  'bay.marina-centre-carriageways': { 'Marina Centre granite paving': [4, 6] },
  'bay.straits-boulevard': { 'Straits Boulevard footway': [4, 6] },
  'bay.esplanade-east-quay': { 'Esplanade promenade paving': [2, 4], 'Esplanade landing deck': [2, 4] },
  'bay.queen-elizabeth-walk-paving': { 'Queen Elizabeth Walk paving stones': squareGranite },
  'bay.fullerton-road-sidewalk': { 'Coursed granite': squareGranite },
  'bay.sands-skypark-gardens': { 'SkyPark garden pavers': squareGranite },
};

export default function build(base: BuildBase, kit: Kit) {
  const buildings: EntityBody[] = JSON.parse(
    readFileSync(new URL('./onemap-entities.json', import.meta.url), 'utf8'),
  );
  const environmentFile = new URL('./environment.json', import.meta.url);
  const configured: EntityBody | null = existsSync(environmentFile)
    ? JSON.parse(readFileSync(environmentFile, 'utf8'))
    : null;
  // 已保存的物件是权威状态；重新构建不能恢复已被用户替换的有限地板或天空壳。
  const daylight = bayDaylight(
    base.entities.find((entity) => entity.entityId === configured?.entityId), configured,
  );
  const config = JSON.parse(readFileSync(new URL('../context.json', import.meta.url), 'utf8'));
  const surroundings = base.entities.find((entity) => entity.entityId === 'bay.city-surroundings');
  const registered = surroundings && config.quay
    ? withPromontoryLawns(withBoatQuay(surroundings), daylight)
    : [];
  let currentEnvironment = surveyedGrassCoverage(daylight, registered.length > 1);
  type SurfaceMap = { waterBodyColor?: unknown; longitude?: number; latitude?: number; offshore?: { texture: string }; turfColorSurvey?: { texture: string }; vegetationExposure?: { texture: string }; rippleShelter?: { texture: string } };
  const authoredMap = (configured?.props?.environment as { map?: SurfaceMap } | undefined)?.map;
  const savedEnvironment = currentEnvironment?.props?.environment as { map?: SurfaceMap } | undefined;
  // Published coordinates can differ by a few floating-point units after a JSON round trip.
  const sameCoordinate = (a?: number, b?: number) =>
    a !== undefined && b !== undefined && Math.abs(a - b) < 1e-9;
  if (currentEnvironment && authoredMap && savedEnvironment?.map &&
      sameCoordinate(savedEnvironment.map.longitude, authoredMap.longitude) &&
      sameCoordinate(savedEnvironment.map.latitude, authoredMap.latitude)) {
    const map = { ...savedEnvironment.map };
    if (map.waterBodyColor === undefined && authoredMap.waterBodyColor !== undefined) {
      map.waterBodyColor = authoredMap.waterBodyColor;
    }
    const textures = new Set(currentEnvironment.textures);
    const oldShelter = 'ba8ef4fc904bc4727126ba831b17f4fbc3b910342decf404d4f65bbdc17540a6';
    if (authoredMap.rippleShelter?.texture && isDeepStrictEqual(map.rippleShelter, {
      ...authoredMap.rippleShelter, texture: oldShelter,
    })) {
      map.rippleShelter = authoredMap.rippleShelter;
      textures.delete(oldShelter);
      textures.add(authoredMap.rippleShelter.texture);
    }
    for (const key of ['offshore', 'turfColorSurvey', 'vegetationExposure', 'rippleShelter'] as const) {
      if (!map[key] && authoredMap[key]) {
        map[key] = authoredMap[key];
        textures.add(authoredMap[key].texture);
      }
    }
    currentEnvironment = { ...currentEnvironment, textures: [...textures],
      props: { ...currentEnvironment.props, environment: { ...savedEnvironment, map } }
    };
  }
  const authoredArea = (configured?.props?.environment as { cameraArea?: unknown } | undefined)?.cameraArea;
  const currentSettings = currentEnvironment?.props?.environment as Record<string, unknown> | undefined;
  const environment = currentEnvironment && currentSettings && authoredArea !== undefined && currentSettings.cameraArea === undefined
    ? { ...currentEnvironment, props: { ...currentEnvironment.props, environment: { ...currentSettings, cameraArea: authoredArea } } }
    : currentEnvironment;
  const ground: EntityBody[] = environment
    ? []
    : JSON.parse(readFileSync(new URL('./ground.json', import.meta.url), 'utf8'));
  const placement: Placement = JSON.parse(
    readFileSync(new URL('./placement.json', import.meta.url), 'utf8'),
  );
  // Landmark positions and framing bounds use the final member coordinates.
  const overview = config.overview;
  const savedLandmark = overview && base.entities.find(
    (entity) => entity.entityId === overview.entityId,
  )?.props?.landmark;
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
    const anchorage: EntityBody = JSON.parse(readFileSync(new URL('./eastern-anchorage.json', import.meta.url), 'utf8'));
    entities.push(base.entities.find(entity => entity.entityId === anchorage.entityId) ?? anchorage);
    const finishes = JSON.parse(readFileSync(new URL('../references/waterfront-finishes.json', import.meta.url), 'utf8'));
    entities.push(...waterfront(kit, config.quay, placement, finishes, buildings[0]?.regionId));
    const streetscape: EntityBody[] = JSON.parse(
      readFileSync(new URL('./streetscape.json', import.meta.url), 'utf8'),
    );
    entities.push(...streetscape.map((entity) => placeExterior(entity, placement)));
    // The inherited census tiles already use final member coordinates.
    const streetTrees: EntityBody[] = JSON.parse(
      readFileSync(new URL('./city-street-trees.json', import.meta.url), 'utf8'),
    );
    entities.push(...streetTrees);
    entities.push(JSON.parse(
      readFileSync(new URL('./esplanade-promenade-trees.json', import.meta.url), 'utf8'),
    ));
    entities.push(JSON.parse(
      readFileSync(new URL('./esplanade-east-quay.json', import.meta.url), 'utf8'),
    ));
    entities.push(JSON.parse(
      readFileSync(new URL('./promontory-canopy.json', import.meta.url), 'utf8'),
    ));
    // These surveyed towers are already aligned to the same final member coordinates as the census tiles.
    const marinaCentre: EntityBody[] = JSON.parse(
      readFileSync(new URL('./marina-centre-towers.json', import.meta.url), 'utf8'),
    );
    entities.push(...marinaCentre);
    entities.push(JSON.parse(
      readFileSync(new URL('./garden-conservatories.json', import.meta.url), 'utf8'),
    ));
    const gardenCanopy: EntityBody[] = JSON.parse(
      readFileSync(new URL('./garden-lake-canopy.json', import.meta.url), 'utf8'),
    );
    entities.push(...gardenCanopy);
    entities.push(JSON.parse(
      readFileSync(new URL('./dragonfly-lake-understorey.json', import.meta.url), 'utf8'),
    ));
    entities.push(JSON.parse(
      readFileSync(new URL('./dragonfly-palms.json', import.meta.url), 'utf8'),
    ));
    entities.push(JSON.parse(
      readFileSync(new URL('./dragonfly-bridge.json', import.meta.url), 'utf8'),
    ));
  }
  // 线上按视野流式加载的周边楼群独立于离线模型包，由空间保存其图层和保护范围。
  const [city, ...lawns] = registered;
  if (city) {
    entities.push(...withSkylineFacades(city), ...lawns);
  } else if (surroundings) {
    entities.push(surroundings);
  }
  // Sky visibility belongs to each facade at its surveyed location and to the sampled mesh revision.
  const facadeFinishes = ['district-skylight/survey', 'financial-facade-exposure', 'waterfront-facade-daylight', 'sands-daylight/survey'].map((name) => {
    const survey: { buildings: { entityId: string; source: string; output: string }[] } = JSON.parse(
      readFileSync(new URL(`../references/${name}.json`, import.meta.url), 'utf8'),
    );
    return new Map(survey.buildings.map((row) => [row.entityId, row]));
  });
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
      ...entities.map((entity) => {
        let assetHash = entity.assetHash;
        if (config.quay && assetHash) {
          for (const finishes of facadeFinishes) {
            const finish = finishes.get(entity.entityId);
            if (finish && finish.source === assetHash) assetHash = finish.output;
          }
        }
        const reflectors = config.quay && skyReflectionMaterials[entity.entityId];
        const scans = config.quay && groundScanMaterials[entity.entityId];
        const pavers = config.quay && pavedSurfaces[entity.entityId];
        return kit.placeEntity({
          ...entity,
          ...(assetHash && { assetHash }),
          props: {
            ...entity.props,
            background: true,
            ...(overview && entity.entityId === overview.entityId && {
              landmark: savedLandmark ?? entity.props?.landmark ?? overview.landmark,
            }),
            ...(scans && { groundScanMaterials: scans }),
            ...(reflectors && { skyReflectionMaterials: reflectors }),
            ...(pavers && { pavingCourseAtlas: pavers }),
          },
        });
      }),
    ],
  };
}
