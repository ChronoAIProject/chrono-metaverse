import * as THREE from 'three';
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { VectorContent } from '../core/externalSource';
import { GeoReference, tileBounds, tileCoordinates, type Tile } from './geography';

type Point = { x: number; y: number };

/** 瓦片缓冲区不参与绘制，避免相邻瓦片的同一面重复叠加。 */
function clip(ring: readonly Point[], extent: number): Point[] {
  let points = ring.slice();
  for (const [axis, boundary, greater] of [
    ['x', 0, true],
    ['x', extent, false],
    ['y', 0, true],
    ['y', extent, false],
  ] as const) {
    const output: Point[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!,
        b = points[(i + 1) % points.length]!;
      const insideA = greater ? a[axis] >= boundary : a[axis] <= boundary;
      const insideB = greater ? b[axis] >= boundary : b[axis] <= boundary;
      if (insideA) output.push(a);
      if (insideA !== insideB) {
        const t = (boundary - a[axis]) / (b[axis] - a[axis]);
        output.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    points = output;
  }
  return points.filter((p, i) => {
    const next = points[(i + 1) % points.length]!;
    return p.x !== next.x || p.y !== next.y;
  });
}

export function vectorGeometry(
  bytes: Uint8Array,
  tile: Tile,
  reference: GeoReference,
  style: VectorContent['extrusion'],
): { geometry: THREE.BufferGeometry; features: number } {
  const layer = new VectorTile(new Pbf(bytes)).layers[style.layer];
  const positions: number[] = [];
  let features = 0,
    vertices = 0;
  if (layer && layer.length > 10000) throw new Error('矢量瓦片要素过多');
  for (let i = 0; layer && i < layer.length; i++) {
    const feature = layer.feature(i);
    if (!Number.isInteger(feature.extent) || feature.extent < 1 || feature.extent > 65536)
      throw new Error('矢量瓦片范围无效');
    if (feature.type !== 3 || (style.hiddenProperty && feature.properties[style.hiddenProperty]))
      continue;
    const rawHeight = feature.properties[style.heightProperty];
    const height = typeof rawHeight === 'number' ? rawHeight : style.defaultHeight;
    const rawMin = style.minHeightProperty ? feature.properties[style.minHeightProperty] : 0;
    const minHeight = typeof rawMin === 'number' ? rawMin : 0;
    if (
      !Number.isFinite(height) ||
      !Number.isFinite(minHeight) ||
      height <= minHeight ||
      minHeight < 0 ||
      height > style.maxHeight
    )
      continue;
    const rings = feature.loadGeometry();
    vertices += rings.reduce((n, ring) => n + ring.length, 0);
    if (vertices > 50000) throw new Error('矢量瓦片顶点过多');
    for (const polygon of classifyRings(rings)) {
      const clipped = polygon.map((ring) => clip(ring, feature.extent));
      if (!clipped[0] || clipped[0].length < 3) continue;
      const valid = [clipped[0], ...clipped.slice(1).filter((ring) => ring.length >= 3)];
      const bottom: THREE.Vector3[][] = [],
        top: THREE.Vector3[][] = [];
      const box = new THREE.Box3();
      for (const ring of valid) {
        const low: THREE.Vector3[] = [],
          high: THREE.Vector3[] = [];
        for (const p of ring) {
          const [lon, lat] = tileCoordinates(
            tile.x + p.x / feature.extent,
            tile.y + p.y / feature.extent,
            tile.z,
          );
          const a = reference.point(lon, lat, minHeight),
            b = reference.point(lon, lat, height);
          low.push(a);
          high.push(b);
          box.expandByPoint(a);
        }
        bottom.push(low);
        top.push(high);
      }
      if (
        style.excludeBounds?.some(
          ([x0, z0, x1, z1]) =>
            box.min.x < x1 && box.max.x > x0 && box.min.z < z1 && box.max.z > z0,
        )
      )
        continue;
      const flat = top.flat();
      const shape = top.map((ring) => ring.map((p) => new THREE.Vector2(p.x, p.z)));
      const triangles = THREE.ShapeUtils.triangulateShape(shape[0]!, shape.slice(1));
      for (const face of triangles) {
        const a = flat[face[0]!]!,
          b = flat[face[1]!]!,
          c = flat[face[2]!]!;
        if (b.clone().sub(a).cross(c.clone().sub(a)).y < 0)
          positions.push(...a.toArray(), ...c.toArray(), ...b.toArray());
        else positions.push(...a.toArray(), ...b.toArray(), ...c.toArray());
      }
      for (let r = 0; r < top.length; r++) {
        const high = top[r]!,
          low = bottom[r]!;
        for (let j = 0; j < high.length; j++) {
          const next = (j + 1) % high.length;
          positions.push(
            ...low[j]!.toArray(),
            ...low[next]!.toArray(),
            ...high[j]!.toArray(),
            ...high[j]!.toArray(),
            ...low[next]!.toArray(),
            ...high[next]!.toArray(),
          );
        }
      }
      if (positions.length > 1800000) throw new Error('矢量瓦片生成几何过大');
      features++;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, features };
}

/** 从全球四叉树按视锥和距离发现瓦片，输入只含标准地理参考。 */
export function visibleVectorTiles(
  camera: THREE.PerspectiveCamera,
  matrixWorld: THREE.Matrix4,
  reference: GeoReference,
  zoom: number,
  maxDistance: number,
): Tile[] {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const leaves: { tile: Tile; distance: number }[] = [];
  const queue: Tile[] = [{ z: 0, x: 0, y: 0 }];
  for (let visited = 0; queue.length && visited < 16000; visited++) {
    const tile = queue.shift()!;
    const [west, south, east, north] = tileBounds(tile);
    const box = new THREE.Box3();
    for (let row = 0; row <= 4; row++)
      for (let col = 0; col <= 4; col++) {
        const lon = west + ((east - west) * col) / 4,
          lat = south + ((north - south) * row) / 4;
        box.expandByPoint(reference.point(lon, lat, 0));
        box.expandByPoint(reference.point(lon, lat, 2000));
      }
    const sphere = box.getBoundingSphere(new THREE.Sphere()).applyMatrix4(matrixWorld);
    const distance = camera.position.distanceTo(sphere.center);
    if (distance - sphere.radius > maxDistance || !frustum.intersectsSphere(sphere)) continue;
    if (tile.z === zoom) leaves.push({ tile, distance });
    else
      for (let i = 0; i < 4; i++)
        queue.push({ z: tile.z + 1, x: tile.x * 2 + (i & 1), y: tile.y * 2 + (i >> 1) });
  }
  return leaves
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 32)
    .map((item) => item.tile);
}
