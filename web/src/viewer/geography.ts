import * as THREE from 'three';
import type { GeographicMap, TileSource } from '../core/environment';

export const EARTH_RADIUS = 6378137;
const ECCENTRICITY_SQUARED = 6.6943799901413165e-3;
export const MERCATOR_LATITUDE = 85.0511287798066;
const rad = THREE.MathUtils.degToRad;

export interface Tile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export function tileKey(tile: Tile): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

export function tileCoordinates(x: number, y: number, z: number): [number, number] {
  return [
    (x / 2 ** z) * 360 - 180,
    THREE.MathUtils.radToDeg(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)))),
  ];
}

export function tileBounds(tile: Tile): [number, number, number, number] {
  const [west, north] = tileCoordinates(tile.x, tile.y, tile.z);
  const [east, south] = tileCoordinates(tile.x + 1, tile.y + 1, tile.z);
  return [west, south, east, north];
}

export function children(tile: Tile): Tile[] {
  return [0, 1, 2, 3].map((n) => ({
    z: tile.z + 1,
    x: tile.x * 2 + (n & 1),
    y: tile.y * 2 + (n >> 1),
  }));
}

/** 来源按配置顺序回退；有范围的来源只接收整块都落在范围内的瓦片。 */
export function tileSources(tile: Tile, sources: readonly TileSource[]): TileSource[] {
  const [west, south, east, north] = tileBounds(tile);
  return sources.filter(
    (source) =>
      tile.z >= source.minZoom &&
      tile.z <= source.maxZoom &&
      (!source.bounds ||
        (west >= source.bounds[0] &&
          south >= source.bounds[1] &&
          east <= source.bounds[2] &&
          north <= source.bounds[3])),
  );
}

export function tileUrl(tile: Tile, source: TileSource): string {
  return source.urlTemplate
    .replaceAll('{z}', String(tile.z))
    .replaceAll('{x}', String(tile.x))
    .replaceAll('{y}', String(tile.y));
}

export function ecef(longitude: number, latitude: number, height = 0): THREE.Vector3 {
  const lon = rad(longitude),
    lat = rad(latitude);
  const n = EARTH_RADIUS / Math.sqrt(1 - ECCENTRICITY_SQUARED * Math.sin(lat) ** 2);
  return new THREE.Vector3(
    (n + height) * Math.cos(lat) * Math.cos(lon),
    (n + height) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - ECCENTRICITY_SQUARED) + height) * Math.sin(lat),
  );
}

/** WGS84 地心坐标与成员米制坐标共用同一参考，不让地球模型参与主体取景。 */
export class GeoReference {
  readonly center: THREE.Vector3;
  readonly ecefOrigin: THREE.Vector3;
  readonly rotation: THREE.Matrix4;
  private readonly inverseRotation: THREE.Matrix4;
  readonly origin: THREE.Vector3;

  constructor(map: GeographicMap) {
    this.origin = new THREE.Vector3(...map.origin);
    this.ecefOrigin = ecef(map.longitude, map.latitude);
    const lon = rad(map.longitude),
      lat = rad(map.latitude),
      heading = rad(map.heading);
    const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
    const north = new THREE.Vector3(
      -Math.sin(lat) * Math.cos(lon),
      -Math.sin(lat) * Math.sin(lon),
      Math.cos(lat),
    );
    const up = new THREE.Vector3(
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
    );
    const x = east
      .clone()
      .multiplyScalar(-Math.cos(heading))
      .addScaledVector(north, Math.sin(heading));
    const z = east
      .clone()
      .multiplyScalar(Math.sin(heading))
      .addScaledVector(north, Math.cos(heading));
    this.rotation = new THREE.Matrix4().makeBasis(x, up, z).transpose();
    this.inverseRotation = this.rotation.clone().transpose();
    this.center = this.ecefOrigin.clone().negate().applyMatrix4(this.rotation).add(this.origin);
  }

  point(longitude: number, latitude: number, height = 0): THREE.Vector3 {
    return ecef(longitude, latitude, height)
      .sub(this.ecefOrigin)
      .applyMatrix4(this.rotation)
      .add(this.origin);
  }

  toEcef(point: THREE.Vector3): THREE.Vector3 {
    return point.clone().sub(this.origin).applyMatrix4(this.inverseRotation).add(this.ecefOrigin);
  }
}

/** 子瓦片使用祖先影像时的采样范围；几何仍只画一份，避免共面闪烁。 */
export function ancestorUv(tile: Tile, ancestor: Tile): { x: number; y: number; size: number } {
  const scale = 2 ** (tile.z - ancestor.z);
  return {
    x: tile.x / scale - ancestor.x,
    y: tile.y / scale - ancestor.y,
    size: 1 / scale,
  };
}
