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

export interface SourceDelivery {
  /** direct 保持浏览器直连；server 经空间权限校验后由服务器获取。 */
  readonly delivery?: 'direct' | 'server';
  /** 三维外部依赖额外允许的 HTTPS 目录，必须以 / 结束。 */
  readonly resourcePrefixes?: readonly string[];
}

export interface ExternalRequest {
  readonly entity: string;
  readonly kind: 'map' | 'content';
  readonly source: number;
  readonly url: string;
}

export interface ExternalAccess {
  readonly key: string;
  readonly load: (request: ExternalRequest, signal: AbortSignal) => Promise<Response>;
}

export interface ExternalSource extends SourceCredit, SourceDelivery {
  readonly url: string;
  readonly cache?: SourceCache;
}

export interface GeographicReference {
  readonly latitude: number;
  readonly longitude: number;
  readonly origin: readonly [number, number, number];
  readonly heading: number;
}

export interface TilesContent {
  readonly version: 1;
  readonly format: '3d-tiles';
  readonly sources: readonly ExternalSource[];
  /** 缺省使用本地米制坐标，原点放在代理物件 bounds 的底面中心。 */
  readonly reference?: GeographicReference;
}

export interface RoadLayer {
  readonly layer: string;
  readonly classProperty: string;
  readonly classes: readonly string[];
  readonly exclude?: { readonly property: string; readonly value: string };
}

export interface GroundLayer {
  readonly layer: string;
  readonly property: string;
  readonly values: readonly string[];
  readonly material: 'turf' | 'pavers';
  /** Stable feature IDs from this source whose surveyed surface uses the underlying imagery. */
  readonly excludeFeatureIds?: readonly number[];
}

/** Replace the interior of one surveyed shoreline segment in source tile coordinates. */
export interface WaterlineEdit {
  readonly source: string;
  readonly tile: readonly [number, number, number];
  readonly featureId: number;
  readonly extent: number;
  readonly from: readonly (readonly [number, number])[];
  readonly interior: readonly (readonly [number, number])[];
}

export interface WaterSample {
  readonly source: string;
  readonly featureIds: readonly number[];
  readonly center: readonly [number, number];
  /** Blend into the surrounding water over the outer fifth of the sample radius in metres. */
  readonly radius: number;
  readonly reflectance: readonly [number, number, number];
  /** Root-mean-square slope of the metre-scale gravity waves. */
  readonly rmsGravitySlope?: number;
  /** RMS slope of short reservoir waves, before local wind modulation. */
  readonly rmsRippleSlope?: number;
}

export interface VectorBuildingPart {
  readonly featureId: number;
  readonly minHeight: number;
  readonly height: number;
  /** Bounds of the surveyed footprint in the vector source's local x/z plane. */
  readonly bounds: readonly [number, number, number, number];
}

export type FacadeReflectionBuilding = VectorBuildingPart;

export interface FacadeReflections {
  readonly source: string;
  readonly texture: string;
  readonly scale: number;
  /** Each atlas row holds panoramas at 20%, 50% and 80% of one building's height. */
  readonly buildings: readonly FacadeReflectionBuilding[];
}

export interface VectorContent {
  readonly version: 1;
  readonly format: 'mvt';
  /** 标准 TileJSON 入口；模板与层级从入口读取。 */
  readonly sources: readonly ExternalSource[];
  readonly reference: GeographicReference;
  readonly roads?: RoadLayer | false;
  readonly waterLayer?: string;
  /** Meteorological wind-from bearing for short water waves, clockwise from true north. */
  readonly rippleWindFrom?: number;
  readonly waterSample?: WaterSample;
  readonly facadeReflections?: FacadeReflections;
  readonly waterlineEdits?: readonly WaterlineEdit[];
  readonly groundLayers?: readonly GroundLayer[];
  readonly waterReflection?: 'scene';
  readonly extrusion: {
    readonly facade?: 'urban';
    readonly distantZoom?: number;
    readonly layer: string;
    readonly heightProperty: string;
    readonly minHeightProperty?: string;
    readonly hiddenProperty?: string;
    readonly defaultHeight: number;
    readonly maxHeight: number;
    readonly color: string;
    readonly maxDistance: number;
    /** 本地米制坐标中的覆盖区域 [minX,minZ,maxX,maxZ]，保留已有精细内容。 */
    readonly excludeBounds?: readonly (readonly [number, number, number, number])[];
    /** 已由模型替换的地图楼体部分，按编号、高度和位置匹配。 */
    readonly excludeBuildingParts?: readonly VectorBuildingPart[];
  };
}

export type ExternalContent = TilesContent | VectorContent;

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
    (value.delivery === undefined || value.delivery === 'direct' || value.delivery === 'server') &&
    (value.resourcePrefixes === undefined ||
      (Array.isArray(value.resourcePrefixes) &&
        value.resourcePrefixes.length <= 8 &&
        value.resourcePrefixes.every((prefix: unknown) => {
          if (!publicHttps(prefix)) return false;
          const url = new URL(prefix);
          return url.pathname.endsWith('/') && !url.search;
        }))) &&
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
  return {
    latitude: raw.latitude,
    longitude: raw.longitude,
    origin: raw.origin as [number, number, number],
    heading: (raw.heading as number | undefined) ?? 0,
  };
}

function validFacadeReflections(value: unknown, textures: readonly string[] | undefined): boolean {
  const atlas = record(value);
  if (
    !atlas ||
    !publicHttps(atlas.source) ||
    typeof atlas.texture !== 'string' ||
    !textures?.includes(atlas.texture) ||
    !/^[a-f0-9]{64}$/.test(atlas.texture) ||
    !finite(atlas.scale, 0.01, 64) ||
    !Array.isArray(atlas.buildings) ||
    atlas.buildings.length < 1 ||
    atlas.buildings.length > 64
  )
    return false;
  return atlas.buildings.every(validBuildingPart);
}

function validBuildingPart(item: unknown): boolean {
  const b = record(item);
  return (
    !!b &&
    Number.isSafeInteger(b.featureId) &&
    Number(b.featureId) >= 0 &&
    finite(b.minHeight, 0, 2000) &&
    finite(b.height, 0, 2000) &&
    Number(b.height) > Number(b.minHeight) &&
    Array.isArray(b.bounds) &&
    b.bounds.length === 4 &&
    b.bounds.every((n) => finite(n, -100000, 100000)) &&
    b.bounds[2]! > b.bounds[0]! &&
    b.bounds[3]! > b.bounds[1]!
  );
}

export function validWaterSample(value: unknown): value is WaterSample {
  const sample = record(value);
  return (
    !!sample &&
    publicHttps(sample.source) &&
    Array.isArray(sample.featureIds) &&
    sample.featureIds.length > 0 &&
    sample.featureIds.length <= 32 &&
    sample.featureIds.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    Array.isArray(sample.center) &&
    sample.center.length === 2 &&
    finite(sample.center[0], -180, 180) &&
    finite(sample.center[1], -85.05113, 85.05113) &&
    finite(sample.radius, 1, 50000) &&
    (sample.rmsGravitySlope === undefined || finite(sample.rmsGravitySlope, 0, 1)) &&
    (sample.rmsRippleSlope === undefined || finite(sample.rmsRippleSlope, 0, 1)) &&
    Array.isArray(sample.reflectance) &&
    sample.reflectance.length === 3 &&
    sample.reflectance.every((n) => finite(n, 0, 1))
  );
}

function validWaterlineEdit(value: unknown): boolean {
  const edit = record(value);
  if (
    !edit ||
    !publicHttps(edit.source) ||
    !Number.isSafeInteger(edit.featureId) ||
    Number(edit.featureId) < 0 ||
    !Number.isInteger(edit.extent) ||
    !finite(edit.extent, 1, 65536)
  )
    return false;
  const extent = edit.extent as number;
  const tile = edit.tile;
  if (
    !Array.isArray(tile) ||
    tile.length !== 3 ||
    !tile.every(Number.isInteger) ||
    !finite(tile[0], 14, 20) ||
    !tile.slice(1).every((n) => finite(n, 0, 2 ** tile[0] - 1))
  )
    return false;
  const path = (points: unknown, min: number) =>
    Array.isArray(points) &&
    points.length >= min &&
    points.length <= 64 &&
    points.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every((n) => Number.isInteger(n) && finite(n, 0, extent)),
    );
  return path(edit.from, 2) && path(edit.interior, 0);
}

/** 外部流式内容仍是普通背景物件，不改变代理范围和空间编辑权限。 */
export function externalContentOf(entity: EntityBody): ExternalContent | null {
  if (entity.props?.background !== true) return null;
  const raw = record(entity.props.externalContent);
  if (
    !raw ||
    raw.version !== 1 ||
    (raw.format !== '3d-tiles' && raw.format !== 'mvt') ||
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
  if (raw.format === 'mvt') {
    const style = record(raw.extrusion);
    const field = (value: unknown) =>
      typeof value === 'string' && value.length > 0 && value.length <= 100;
    const groundLayers = raw.groundLayers;
    if (
      groundLayers !== undefined &&
      (!Array.isArray(groundLayers) ||
        groundLayers.length > 4 ||
        !groundLayers.every((item) => {
          const g = record(item);
          return (
            g &&
            field(g.layer) &&
            field(g.property) &&
            Array.isArray(g.values) &&
            g.values.length > 0 &&
            g.values.length <= 32 &&
            g.values.every(field) &&
            (g.material === 'turf' || g.material === 'pavers') &&
            (g.excludeFeatureIds === undefined ||
              (Array.isArray(g.excludeFeatureIds) &&
                g.excludeFeatureIds.every((id) => Number.isSafeInteger(id) && id >= 0)))
          );
        }))
    )
      return null;
    const roads = record(raw.roads);
    if (raw.roads !== undefined && raw.roads !== false) {
      if (
        !roads ||
        !field(roads.layer) ||
        !field(roads.classProperty) ||
        !Array.isArray(roads.classes) ||
        roads.classes.length > 128 ||
        !roads.classes.every(field)
      )
        return null;
      const exclude = record(roads.exclude);
      if (
        roads.exclude !== undefined &&
        (!exclude || !field(exclude.property) || !field(exclude.value))
      )
        return null;
    }
    if (
      !reference ||
      !style ||
      !field(style.layer) ||
      (style.facade !== undefined && style.facade !== 'urban') ||
      (style.distantZoom !== undefined &&
        (!finite(style.distantZoom, 0, 20) || !Number.isInteger(style.distantZoom))) ||
      (raw.waterLayer !== undefined && !field(raw.waterLayer)) ||
      (raw.rippleWindFrom !== undefined &&
        (!raw.waterLayer || !finite(raw.rippleWindFrom, 0, 360))) ||
      (raw.facadeReflections !== undefined &&
        (style.facade !== 'urban' ||
          !validFacadeReflections(raw.facadeReflections, entity.textures))) ||
      (raw.waterSample !== undefined && (!raw.waterLayer || !validWaterSample(raw.waterSample))) ||
      (raw.waterlineEdits !== undefined &&
        (!raw.waterLayer ||
          !Array.isArray(raw.waterlineEdits) ||
          raw.waterlineEdits.length > 16 ||
          !raw.waterlineEdits.every(validWaterlineEdit))) ||
      (raw.waterReflection !== undefined && (raw.waterReflection !== 'scene' || !raw.waterLayer)) ||
      !field(style.heightProperty) ||
      (style.minHeightProperty !== undefined && !field(style.minHeightProperty)) ||
      (style.hiddenProperty !== undefined && !field(style.hiddenProperty)) ||
      !finite(style.defaultHeight, 0, 2000) ||
      !finite(style.maxHeight, 1, 2000) ||
      style.defaultHeight > style.maxHeight ||
      !finite(style.maxDistance, 100, 50000) ||
      typeof style.color !== 'string' ||
      !/^#[a-f0-9]{6}$/i.test(style.color)
    )
      return null;
    if (
      style.excludeBuildingParts !== undefined &&
      (!Array.isArray(style.excludeBuildingParts) ||
        style.excludeBuildingParts.length > 256 ||
        !style.excludeBuildingParts.every(validBuildingPart))
    )
      return null;
    if (
      style.excludeBounds !== undefined &&
      (!Array.isArray(style.excludeBounds) ||
        style.excludeBounds.length > 256 ||
        style.excludeBounds.some(
          (b: unknown) =>
            !Array.isArray(b) ||
            b.length !== 4 ||
            !b.every((v: unknown) => finite(v, -100000, 100000)) ||
            b[0]! >= b[2]! ||
            b[1]! >= b[3]!,
        ))
    )
      return null;
    return {
      version: 1,
      format: 'mvt',
      sources: raw.sources,
      reference,
      extrusion: style,
      ...(groundLayers ? { groundLayers } : {}),
      ...(raw.facadeReflections ? { facadeReflections: raw.facadeReflections } : {}),
      ...(raw.waterSample ? { waterSample: raw.waterSample } : {}),
      ...(raw.waterlineEdits ? { waterlineEdits: raw.waterlineEdits } : {}),
      ...(raw.waterReflection ? { waterReflection: raw.waterReflection } : {}),
      ...(raw.waterLayer !== undefined ? { waterLayer: raw.waterLayer } : {}),
      ...(raw.rippleWindFrom !== undefined ? { rippleWindFrom: raw.rippleWindFrom } : {}),
      ...(raw.roads !== undefined ? { roads: raw.roads } : {}),
    } as unknown as VectorContent;
  }
  return { version: 1, format: '3d-tiles', sources: raw.sources, reference } as ExternalContent;
}
