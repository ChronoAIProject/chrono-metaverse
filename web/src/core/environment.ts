import type { EntityBody } from './api/types';

export interface TileSource {
  readonly urlTemplate: string;
  readonly attribution: string;
  readonly page: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** 经度西界、纬度南界、经度东界、纬度北界。 */
  readonly bounds?: readonly [number, number, number, number];
}

export interface GeographicMap {
  readonly latitude: number;
  readonly longitude: number;
  /** 地理参考点在成员空间中的海平面位置，单位为米。 */
  readonly origin: readonly [number, number, number];
  /** 局部 +z 相对于正北顺时针旋转的角度。 */
  readonly heading: number;
  readonly sources: readonly TileSource[];
}

export interface Environment {
  readonly version: 1;
  readonly sky?: { readonly texture: string; readonly yaw: number };
  readonly map?: GeographicMap;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function https(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function tileSource(value: unknown): TileSource | null {
  const raw = record(value);
  if (!raw || !https(raw.urlTemplate) || !https(raw.page)) return null;
  if (!['{z}', '{x}', '{y}'].every((key) => (raw.urlTemplate as string).includes(key))) return null;
  if (
    typeof raw.attribution !== 'string' ||
    !raw.attribution.trim() ||
    raw.attribution.length > 500
  )
    return null;
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
    sky = { texture: value.texture, yaw: (value.yaw as number | undefined) ?? 0 };
  }
  let map: GeographicMap | undefined;
  if (raw.map !== undefined) {
    const value = record(raw.map);
    if (
      !value ||
      !finite(value.latitude, -85, 85) ||
      !finite(value.longitude, -180, 180) ||
      !finite(value.heading ?? 0, -360, 360) ||
      !Array.isArray(value.origin) ||
      value.origin.length !== 3 ||
      !value.origin.every((n) => finite(n, -100000, 100000)) ||
      !Array.isArray(value.sources) ||
      value.sources.length < 1 ||
      value.sources.length > 4
    )
      return null;
    const sources = value.sources.map(tileSource);
    // 至少一个无范围限制的低精度全球来源，确保远景不会落到地图矩形外。
    if (sources.some((source) => !source) || !sources.some((s) => s?.minZoom === 0 && !s.bounds))
      return null;
    map = { ...value, heading: value.heading ?? 0, sources } as unknown as GeographicMap;
  }
  return sky || map ? { version: 1, sky, map } : null;
}
