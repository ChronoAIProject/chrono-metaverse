import type { EntityBody } from './api/types';
import {
  record,
  finite,
  publicHttps,
  validSource,
  validWaterSample,
  type WaterSample,
  geographicReference,
  type SourceCredit,
  type SourceDelivery,
  type SourceCache,
  type GeographicReference,
} from './externalSource';

export interface TileSource extends SourceCredit, SourceDelivery {
  readonly urlTemplate: string;
  readonly scheme?: 'xyz' | 'tms';
  readonly cache?: SourceCache;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** 经度西界、纬度南界、经度东界、纬度北界。 */
  readonly bounds?: readonly [number, number, number, number];
}

export type GeographicPolygon = readonly (readonly (readonly [number, number])[])[];

export interface SurfaceRaster {
  readonly texture: string;
  /** WGS84 image corners in bottom-left, bottom-right, top-left order. */
  readonly corners: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
}

export interface TurfColorSurvey extends SurfaceRaster {
  /** Linear RGB multipliers at full survey coverage. */
  readonly reflectanceScale?: readonly [number, number, number];
  readonly credit?: Pick<SourceCredit, 'attribution' | 'page'>;
}

export interface MapCoverage {
  readonly texture: string;
  /** Left, top, right, bottom in normalized Web Mercator coordinates. */
  readonly rect: readonly [number, number, number, number];
}

export interface GeographicMap extends GeographicReference {
  /** Linear body colour for one water polygon in its originating vector layer. */
  readonly waterBodyColor?: {
    readonly source: string;
    readonly layer: string;
    readonly featureId: number;
    readonly linearRGB: readonly [number, number, number];
  };
  readonly waterReflectanceStation?: Pick<
    WaterSample,
    'source' | 'featureIds' | 'center' | 'radius' | 'reflectance'
  > & { readonly layer: string };
  readonly vegetationExposure?: MapCoverage & { readonly stops: number };
  readonly turfColorSurvey?: TurfColorSurvey;
  readonly rippleShelter?: SurfaceRaster & { readonly windFrom: number };
  /** Ocean coverage in normalized Web Mercator coordinates, north-west origin. */
  readonly offshore?: MapCoverage & {
    readonly rmsSlope: number;
  };
  readonly surfaceDetail?: 'urban';
  /** WGS84 hardscape footprints. Each polygon starts with its shell, followed by holes. */
  readonly grassExclusions?: readonly GeographicPolygon[];
  /** Surveyed lawns with short, individually spaced blades. */
  readonly mownLawns?: readonly GeographicPolygon[];
  /** Vertical distance in member metres from the map surface to the surveyed lawn cover. */
  readonly mownLawnSurfaceOffset?: number;
  readonly sources: readonly TileSource[];
}

function mapCoverage(
  value: Record<string, unknown> | null,
  entity: EntityBody,
): MapCoverage | undefined {
  const rect = value?.rect;
  if (
    !value ||
    typeof value.texture !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.texture) ||
    !entity.textures?.includes(value.texture) ||
    !Array.isArray(rect) ||
    rect.length !== 4 ||
    !rect.every((n) => finite(n, 0, 1)) ||
    rect[2]! <= rect[0]! ||
    rect[3]! <= rect[1]!
  )
    return;
  return { texture: value.texture, rect: rect as [number, number, number, number] };
}

function validFootprints(polygons: unknown): polygons is GeographicPolygon[] | undefined {
  return (
    polygons === undefined ||
    (Array.isArray(polygons) &&
      polygons.every(
        (polygon) =>
          Array.isArray(polygon) &&
          polygon.length > 0 &&
          polygon.every(
            (ring) =>
              Array.isArray(ring) &&
              ring.length >= 3 &&
              ring.every(
                (point) =>
                  Array.isArray(point) &&
                  point.length === 2 &&
                  finite(point[0], -180, 180) &&
                  finite(point[1], -85.051129, 85.051129),
              ),
          ),
      ))
  );
}

/** 天空全景自身坐标系中的太阳方位，以及线性 RGB 下的日光、天光色度。 */
export interface SkyDaylight {
  readonly azimuth: number;
  readonly elevation: number;
  readonly directFraction: number;
  readonly sunColor: readonly [number, number, number];
  readonly skyColor: readonly [number, number, number];
  /** Nine RGB radiance SH coefficients in panorama coordinates, normalized to skyColor's zenith irradiance. */
  readonly diffuseProbe?: readonly number[];
}

function skyDaylight(value: unknown): SkyDaylight | undefined {
  const d = record(value);
  const color = (v: unknown): v is [number, number, number] =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((c) => finite(c, 0, 4)) &&
    v.some((c) => c >= 0.001);
  if (
    !d ||
    !finite(d.azimuth, -180, 180) ||
    !finite(d.elevation, 1, 90) ||
    !finite(d.directFraction, 0, 1) ||
    !color(d.sunColor) ||
    !color(d.skyColor)
  )
    return undefined;
  return {
    azimuth: d.azimuth,
    elevation: d.elevation,
    directFraction: d.directFraction,
    sunColor: d.sunColor,
    skyColor: d.skyColor,
    ...(Array.isArray(d.diffuseProbe) &&
    d.diffuseProbe.length === 27 &&
    d.diffuseProbe.every((v) => finite(v, -64, 64))
      ? { diffuseProbe: d.diffuseProbe as number[] }
      : {}),
  };
}

export interface Environment {
  readonly version: 1;
  /** Playable camera cylinder in member metres, centered on the XZ plane. */
  readonly cameraArea?: { center: [number, number]; radius: number; floor: number; height: number };
  readonly daylightToneMapping?: 'agx';
  readonly multisampleCutouts?: boolean;
  readonly sky?: {
    readonly texture: string;
    readonly yaw: number;
    /** 米。经过这段空气后，地物与地平线之间的亮度差减半。 */
    readonly airHalfDistance?: number;
    /** Sun-free sky radiance encoded as sRGB times a linear scale. */
    readonly radiance?: { readonly texture: string; readonly scale: number };
    readonly daylight?: SkyDaylight;
  };
  readonly map?: GeographicMap;
}

function tileSource(value: unknown): TileSource | null {
  const raw = record(value);
  if (!raw || !publicHttps(raw.urlTemplate) || !validSource(raw)) return null;
  if (!['{z}', '{x}', '{y}'].every((key) => (raw.urlTemplate as string).includes(key))) return null;
  if (raw.scheme !== undefined && raw.scheme !== 'xyz' && raw.scheme !== 'tms') return null;
  if (!finite(raw.minZoom, 0, 20) || !Number.isInteger(raw.minZoom)) return null;
  if (!finite(raw.maxZoom, raw.minZoom, 20) || !Number.isInteger(raw.maxZoom)) return null;
  const bounds = raw.bounds;
  if (
    bounds !== undefined &&
    (!Array.isArray(bounds) ||
      bounds.length !== 4 ||
      !finite(bounds[0], -180, 180) ||
      !finite(bounds[1], -85.051129, 85.051129) ||
      !finite(bounds[2], bounds[0], 180) ||
      !finite(bounds[3], bounds[1], 85.051129) ||
      bounds[0] === bounds[2] ||
      bounds[1] === bounds[3])
  )
    return null;
  return raw as unknown as TileSource;
}

function surfaceRaster(
  survey: Record<string, unknown> | null,
  entity: EntityBody,
): SurfaceRaster | undefined {
  if (
    survey &&
    typeof survey.texture === 'string' &&
    /^[a-f0-9]{64}$/.test(survey.texture) &&
    entity.textures?.includes(survey.texture) &&
    Array.isArray(survey.corners) &&
    survey.corners.length === 3 &&
    survey.corners.every(
      (p) => Array.isArray(p) && p.length === 2 && finite(p[0], -180, 180) && finite(p[1], -85, 85),
    )
  ) {
    return {
      texture: survey.texture,
      corners: survey.corners as unknown as SurfaceRaster['corners'],
    };
  }
}

/** 环境由普通背景物件配置；无效配置按普通物件处理，不发起外部请求。 */
export function environmentOf(entity: EntityBody): Environment | null {
  if (entity.props?.background !== true) return null;
  const raw = record(entity.props.environment);
  if (!raw || raw.version !== 1) return null;
  let sky: Environment['sky'];
  if (raw.sky !== undefined) {
    const value = record(raw.sky);
    if (
      !value ||
      typeof value.texture !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.texture) ||
      !entity.textures?.includes(value.texture) ||
      !finite(value.yaw ?? 0, -360, 360)
    )
      return null;
    const radiance = record(value.radiance);
    sky = {
      ...(radiance &&
      typeof radiance.texture === 'string' &&
      /^[a-f0-9]{64}$/.test(radiance.texture) &&
      entity.textures?.includes(radiance.texture) &&
      finite(radiance.scale, 0.001, 65504)
        ? { radiance: { texture: radiance.texture, scale: radiance.scale } }
        : {}),
      texture: value.texture,
      yaw: (value.yaw as number | undefined) ?? 0,
      ...(finite(value.airHalfDistance, 1, 100000)
        ? { airHalfDistance: value.airHalfDistance }
        : {}),
      daylight: skyDaylight(value.daylight),
    };
  }
  let map: GeographicMap | undefined;
  if (raw.map !== undefined) {
    const value = record(raw.map);
    const reference = geographicReference(value);
    if (
      !value ||
      !reference ||
      !Array.isArray(value.sources) ||
      value.sources.length < 1 ||
      value.sources.length > 4
    )
      return null;
    const sources = value.sources.map(tileSource);
    // 至少一个无范围限制的低精度全球来源，确保远景不会落到地图矩形外。
    if (sources.some((source) => !source) || !sources.some((s) => s?.minZoom === 0 && !s.bounds))
      return null;
    if (value.surfaceDetail !== undefined && value.surfaceDetail !== 'urban') return null;
    const exclusions = value.grassExclusions;
    const lawns = value.mownLawns;
    if (!validFootprints(exclusions) || !validFootprints(lawns)) return null;
    const survey = record(value.turfColorSurvey);
    const credit = record(survey?.credit);
    const surveyCredit =
      credit &&
      typeof credit.attribution === 'string' &&
      credit.attribution.trim().length > 0 &&
      credit.attribution.length <= 500 &&
      publicHttps(credit.page)
        ? { attribution: credit.attribution, page: credit.page }
        : undefined;
    const turfRaster = surfaceRaster(survey, entity);
    const gain = survey?.reflectanceScale;
    const reflectanceScale =
      Array.isArray(gain) &&
      gain.length === 3 &&
      gain.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
        ? ([gain[0], gain[1], gain[2]] as const)
        : undefined;
    const turfColorSurvey = turfRaster && {
      ...(reflectanceScale ? { reflectanceScale } : {}),
      ...turfRaster,
      ...(surveyCredit ? { credit: surveyCredit } : {}),
    };
    const shelter = record(value.rippleShelter);
    const shelterRaster = surfaceRaster(shelter, entity);
    const rippleShelter =
      shelterRaster && finite(shelter?.windFrom, 0, 360)
        ? { ...shelterRaster, windFrom: shelter.windFrom }
        : undefined;
    const offshore = record(value.offshore);
    const oceanCoverage = mapCoverage(offshore, entity);
    const ocean =
      oceanCoverage && finite(offshore?.rmsSlope, 0.001, 1)
        ? { ...oceanCoverage, rmsSlope: offshore.rmsSlope }
        : undefined;
    const body = record(value.waterBodyColor);
    const rgb = body?.linearRGB;
    const waterBodyColor =
      body &&
      publicHttps(body.source) &&
      typeof body.layer === 'string' &&
      body.layer.length > 0 &&
      typeof body.featureId === 'number' &&
      Number.isSafeInteger(body.featureId) &&
      body.featureId >= 0 &&
      Array.isArray(rgb) &&
      rgb.length === 3 &&
      rgb.every((v) => finite(v, 0, 1))
        ? {
            source: body.source,
            layer: body.layer,
            featureId: body.featureId,
            linearRGB: [rgb[0], rgb[1], rgb[2]] as const,
          }
        : undefined;
    const station = record(value.waterReflectanceStation);
    const layer = station?.layer;
    const waterReflectanceStation =
      typeof layer === 'string' && layer.length > 0 && validWaterSample(station)
        ? {
            source: station.source,
            featureIds: station.featureIds,
            center: station.center,
            radius: station.radius,
            reflectance: station.reflectance,
            layer,
          }
        : undefined;
    const vegetation = record(value.vegetationExposure);
    const coverage = mapCoverage(vegetation, entity);
    const vegetationExposure =
      coverage && finite(vegetation?.stops, -4, 4)
        ? { ...coverage, stops: vegetation.stops }
        : undefined;
    map = {
      ...reference,
      ...(waterBodyColor ? { waterBodyColor } : {}),
      ...(waterReflectanceStation ? { waterReflectanceStation } : {}),
      ...(ocean ? { offshore: ocean } : {}),
      ...(vegetationExposure ? { vegetationExposure } : {}),
      ...(turfColorSurvey ? { turfColorSurvey } : {}),
      ...(rippleShelter ? { rippleShelter } : {}),
      ...(exclusions ? { grassExclusions: exclusions } : {}),
      ...(lawns ? { mownLawns: lawns } : {}),
      ...(lawns?.length && Number.isFinite(value.mownLawnSurfaceOffset)
        ? { mownLawnSurfaceOffset: value.mownLawnSurfaceOffset }
        : {}),
      sources,
      ...(value.surfaceDetail ? { surfaceDetail: value.surfaceDetail } : {}),
    } as GeographicMap;
  }
  if (!sky && !map) return null;
  const area = record(raw.cameraArea);
  const cameraArea =
    area &&
    Array.isArray(area.center) &&
    area.center.length === 2 &&
    area.center.every(Number.isFinite) &&
    Number.isFinite(area.floor) &&
    typeof area.radius === 'number' &&
    Number.isFinite(area.radius) &&
    area.radius > 0 &&
    typeof area.height === 'number' &&
    Number.isFinite(area.height) &&
    area.height > 0
      ? {
          center: area.center as [number, number],
          floor: area.floor as number,
          radius: area.radius,
          height: area.height,
        }
      : undefined;
  return {
    version: 1,
    ...(cameraArea ? { cameraArea } : {}),
    sky,
    map,
    ...(raw.multisampleCutouts === true ? { multisampleCutouts: true } : {}),
    ...(raw.daylightToneMapping === 'agx' ? { daylightToneMapping: 'agx' } : {}),
  };
}
