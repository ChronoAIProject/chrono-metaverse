import type { EntityBody } from './api/types';

/** 提供方是内容数据；加载器只识别协议，不识别服务商或地点。 */
export interface SourceCredit {
  readonly attribution: string;
  readonly page: string;
  readonly logo?: string;
  readonly license?: { readonly label: string; readonly url: string };
}

export interface SourceCache {
  /** 只能缩短服务端允许的新鲜期，不能延长；false 禁止写入持久缓存。 */
  readonly persist?: boolean;
  readonly maxAgeSeconds?: number;
}

export interface ExternalSource extends SourceCredit {
  readonly url: string;
  readonly cache?: SourceCache;
}

export interface GeographicReference {
  readonly latitude: number;
  readonly longitude: number;
  readonly origin: readonly [number, number, number];
  readonly heading: number;
}

export interface ExternalContent {
  readonly version: 1;
  readonly format: '3d-tiles';
  readonly sources: readonly ExternalSource[];
  /** 缺省使用本地米制坐标，原点放在代理物件 bounds 的底面中心。 */
  readonly reference?: GeographicReference;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function publicHttps(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function validSource(value: Record<string, unknown>): boolean {
  const license = record(value.license);
  const cache = record(value.cache);
  return (
    typeof value.attribution === 'string' &&
    value.attribution.trim().length > 0 &&
    value.attribution.length <= 500 &&
    publicHttps(value.page) &&
    (value.logo === undefined || publicHttps(value.logo)) &&
    (value.license === undefined ||
      (license !== null &&
        typeof license.label === 'string' &&
        license.label.trim().length > 0 &&
        license.label.length <= 100 &&
        publicHttps(license.url))) &&
    (value.cache === undefined ||
      (cache !== null &&
        (cache.persist === undefined || typeof cache.persist === 'boolean') &&
        (cache.maxAgeSeconds === undefined || finite(cache.maxAgeSeconds, 0, 604800))))
  );
}

export function geographicReference(value: unknown): GeographicReference | null {
  const raw = record(value);
  if (
    !raw ||
    !finite(raw.latitude, -85, 85) ||
    !finite(raw.longitude, -180, 180) ||
    !finite(raw.heading ?? 0, -360, 360) ||
    !Array.isArray(raw.origin) ||
    raw.origin.length !== 3 ||
    !raw.origin.every((n) => finite(n, -100000, 100000))
  )
    return null;
  return { ...raw, heading: raw.heading ?? 0 } as unknown as GeographicReference;
}

/** 外部流式内容仍是普通背景物件，不改变代理范围和空间编辑权限。 */
export function externalContentOf(entity: EntityBody): ExternalContent | null {
  if (entity.props?.background !== true) return null;
  const raw = record(entity.props.externalContent);
  if (
    !raw ||
    raw.version !== 1 ||
    raw.format !== '3d-tiles' ||
    !Array.isArray(raw.sources) ||
    raw.sources.length < 1 ||
    raw.sources.length > 4
  )
    return null;
  for (const value of raw.sources) {
    const source = record(value);
    if (!source || !publicHttps(source.url) || !validSource(source)) return null;
  }
  const reference = raw.reference === undefined ? undefined : geographicReference(raw.reference);
  if (reference === null) return null;
  return { version: 1, format: '3d-tiles', sources: raw.sources, reference } as ExternalContent;
}
