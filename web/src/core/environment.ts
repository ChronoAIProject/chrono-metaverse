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

export interface GeographicMap extends GeographicReference {
  readonly sources: readonly TileSource[];
}

export interface Environment {
  readonly version: 1;
  readonly sky?: { readonly texture: string; readonly yaw: number };
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
    sky = { texture: value.texture, yaw: (value.yaw as number | undefined) ?? 0 };
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
    map = { ...reference, sources } as GeographicMap;
  }
  return sky || map ? { version: 1, sky, map } : null;
}
