import type { EntityBody } from './api/types';
import {
  record,
  finite,
  publicHttps,
  validSource,
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

export interface GeographicMap extends GeographicReference {
  readonly surfaceDetail?: 'urban';
  /** WGS84 hardscape footprints. Each polygon starts with its shell, followed by holes. */
  readonly grassExclusions?: readonly GeographicPolygon[];
  readonly sources: readonly TileSource[];
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
    if (
      exclusions !== undefined &&
      !(
        Array.isArray(exclusions) &&
        exclusions.every(
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
        )
      )
    )
      return null;
    map = {
      ...reference,
      ...(exclusions ? { grassExclusions: exclusions } : {}),
      sources,
      ...(value.surfaceDetail ? { surfaceDetail: value.surfaceDetail } : {}),
    } as GeographicMap;
  }
  if (!sky && !map) return null;
  return {
    version: 1,
    sky,
    map,
    ...(raw.multisampleCutouts === true ? { multisampleCutouts: true } : {}),
    ...(raw.daylightToneMapping === 'agx' ? { daylightToneMapping: 'agx' } : {}),
  };
}
