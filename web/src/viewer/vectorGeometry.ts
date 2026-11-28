import * as THREE from 'three';
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type {
  VectorBuildingPart,
  GroundLayer,
  RoadLayer,
  VectorContent,
  WaterlineEdit,
} from '../core/externalSource';
import { GeoReference, tileBounds, tileCoordinates, tileKey, type Tile } from './geography';

import { continueStackedFacades, type FacadeSection } from './stackedFacades';

export const surfaceZoom = 14;
export const detailedTileDistance = 4200;

type Point = { x: number; y: number };

function matchesBuildingPart(
  part: VectorBuildingPart,
  id: number | undefined,
  minHeight: number,
  height: number,
  box: THREE.Box3,
) {
  return (
    part.featureId === id &&
    part.minHeight === minHeight &&
    part.height === height &&
    part.bounds[0] < box.max.x &&
    part.bounds[2] > box.min.x &&
    part.bounds[1] < box.max.z &&
    part.bounds[3] > box.min.z
  );
}

/** Same-height buildings may all share one MVT feature. Clipped footprints only
 * use attributes available on both tiles, including when their feature IDs differ. */
function facadeVariant(
  ring: readonly Point[],
  extent: number,
  tile: Tile,
  height: number,
  tint?: number,
) {
  let seed = Math.round(height * 100) ^ (tint ?? 0);
  let west = extent,
    north = extent;
  for (const { x, y } of ring) {
    if (x <= 0 || y <= 0 || x >= extent || y >= extent) {
      west = -1;
      break;
    }
    west = Math.min(west, x);
    north = Math.min(north, y);
  }
  if (west >= 0) {
    const scale = 2 ** (26 - tile.z);
    seed ^= Math.imul(Math.round((tile.x + west / extent) * scale), 73856093);
    seed ^= Math.imul(Math.round((tile.y + north / extent) * scale), 19349663);
  }
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  const sample = (seed ^ (seed >>> 16)) >>> 0;
  const choice = (sample & 255) / 256;
  const curtain = height >= 45 && choice < 0.65;
  const ribbon = height >= 12 && choice > 0.5;
  // Integer selects punched windows, ribbon windows or curtain wall. The
  // fractional part varies the module and palette within that family.
  return (height < 5.5 ? 3 : curtain ? 2 : ribbon ? 1 : 0) + ((sample >>> 8) & 1023) / 1024;
}

/** OpenMapTiles colour is an sRGB hex triplet or a CSS colour name. */
function buildingPaint(property: unknown): number | undefined {
  if (typeof property !== 'string') return;
  const value = property.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return Number.parseInt(value.slice(1), 16);
  if (/^#[0-9a-f]{3}$/.test(value))
    return Number.parseInt(
      value.slice(1).replace(/./g, (digit) => digit + digit),
      16,
    );
  if (Object.hasOwn(THREE.Color.NAMES, value))
    return THREE.Color.NAMES[value as keyof typeof THREE.Color.NAMES];
}

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

// OpenMapTiles 的主干道可作为全息地面的浅色嵌线。没有交通图层的来源仍使用底图。
const openMapTilesRoads: RoadLayer = {
  layer: 'transportation',
  classProperty: 'class',
  classes: ['motorway', 'trunk', 'primary', 'secondary'],
  exclude: { property: 'brunnel', value: 'tunnel' },
};
function roadLines(data: VectorTile, tile: Tile, reference: GeoReference, mapping: RoadLayer) {
  const layer = data.layers[mapping.layer];
  if (!layer || layer.length > 10000) return;
  const roads = new Set(mapping.classes);
  const positions: number[] = [];
  let vertices = 0;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (
      f.type !== 2 ||
      !roads.has(String(f.properties[mapping.classProperty])) ||
      (mapping.exclude && f.properties[mapping.exclude.property] === mapping.exclude.value) ||
      f.extent < 1 ||
      f.extent > 65536
    )
      continue;
    for (const path of f.loadGeometry()) {
      vertices += path.length;
      if (vertices > 50000) return;
      let previous: THREE.Vector3 | undefined;
      for (const p of path) {
        const [lon, lat] = tileCoordinates(
          tile.x + p.x / f.extent,
          tile.y + p.y / f.extent,
          tile.z,
        );
        const next = reference.point(lon, lat, 0.65);
        if (previous) positions.push(...previous.toArray(), ...next.toArray());
        previous = next;
      }
    }
  }
  if (!positions.length) return;
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
}

/** 压顶石用斜接转角收口。只沿真实轮廓建模，舍去裁片产生的边。 */
function pavingEdge(
  ring: THREE.Vector2[],
  hole: boolean,
  start: number,
  extent: number,
  positions: number[],
  indices: number[],
  uv: number[],
) {
  const points = ring.map((_, i) => new THREE.Vector3().fromArray(positions, (start + i) * 3));
  const sign = (THREE.ShapeUtils.isClockWise(ring) ? -1 : 1) * (hole ? -1 : 1);
  const inward = points.map((p, i) => {
    const next = points[(i + 1) % points.length]!;
    return new THREE.Vector2(p.z - next.z, next.x - p.x).normalize().multiplyScalar(sign);
  });
  const inset = inward.map((n, i) => {
    const miter = n
      .clone()
      .add(inward[(i + inward.length - 1) % inward.length]!)
      .normalize();
    return miter.multiplyScalar(0.34 / Math.max(0.4, miter.dot(n)));
  });
  let along = 0;
  for (let j = 0; j < ring.length; j++) {
    const k = (j + 1) % ring.length,
      a = ring[j]!,
      b = ring[k]!;
    const head = points[j]!,
      tail = points[k]!,
      length = head.distanceTo(tail);
    const previous = along;
    along += length;
    if (
      (a.x === b.x && (a.x === 0 || a.x === extent)) ||
      (a.y === b.y && (a.y === 0 || a.y === extent))
    )
      continue;
    const side = positions.length / 3;
    for (const [p, m, u] of [
      [head, inset[j]!, previous],
      [tail, inset[k]!, along],
    ] as const) {
      positions.push(
        p.x,
        p.y - 0.36,
        p.z,
        p.x,
        p.y + 0.027,
        p.z,
        p.x + m.x * 0.12,
        p.y + 0.056,
        p.z + m.y * 0.12,
        p.x + m.x,
        p.y + 0.018,
        p.z + m.y,
      );
      // 压顶石沿边铺成长条；顶面、倒角和立面共用同一排石材。
      const alongStone = u * 0.52;
      uv.push(alongStone, 0.035, alongStone, 0.205, alongStone, 0.225, alongStone, 0.365);
    }
    for (let i = 0; i < 3; i++) {
      const v = side + i;
      indices.push(v, v + 4, v + 1, v + 1, v + 4, v + 5);
    }
  }
}

function surveyedWaterline(ring: Point[], edits: readonly WaterlineEdit[]): Point[] {
  for (const edit of edits) {
    const start = ring.findIndex(
      ({ x, y }, i) =>
        x === edit.from[0]![0] &&
        y === edit.from[0]![1] &&
        edit.from.every(([a, b], j) => ring[i + j]?.x === a && ring[i + j]?.y === b),
    );
    if (start >= 0) {
      ring = [
        ...ring.slice(0, start + 1),
        ...edit.interior.map(([x, y]) => ({ x, y })),
        ...ring.slice(start + edit.from.length - 1),
      ];
    }
  }
  return ring;
}

/** 从同一份矢量数据生成水面或游戏地表。贴着椭球绘制并保留所有内环。 */
function polygonSurface(
  data: VectorTile,
  name: string,
  tile: Tile,
  reference: GeoReference,
  ground?: GroundLayer,
  edits?: readonly WaterlineEdit[],
  sampledIds?: ReadonlySet<number>,
  oceanRect?: THREE.Vector4,
) {
  const layer = data.layers[name];
  if (!layer || tile.z < surfaceZoom || layer.length > 10000) return;
  const excluded = new Set(ground?.excludeFeatureIds);
  const mask: number[] = [];
  const oceanCoords: number[] = [];
  const positions: number[] = [];
  const indices: number[] = [];
  const uv: number[] = [];
  const height = ground ? (ground.material === 'pavers' ? 0.34 : 0.055) : 0.3;
  let vertices = 0;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 3 || feature.extent < 1 || feature.extent > 65536) continue;
    if (
      ground &&
      (!ground.values.includes(String(feature.properties[ground.property])) ||
        (feature.id !== undefined && excluded.has(feature.id)) ||
        feature.properties.brunnel ||
        Number(feature.properties.layer ?? 0) !== 0)
    )
      continue;
    const rings = feature.loadGeometry();
    vertices += rings.reduce((n, ring) => n + ring.length, 0);
    if (vertices > 50000) return;
    const matching = edits?.filter(
      (edit) => edit.featureId === feature.id && edit.extent === feature.extent,
    );
    for (const polygon of classifyRings(rings)) {
      const [outer, ...holes] = polygon.map((ring, i) =>
        clip(
          i === 0 && matching?.length ? surveyedWaterline(ring, matching) : ring,
          feature.extent,
        ),
      );
      if (!outer || outer.length < 3) continue;
      const contours = [outer, ...holes.filter((hole) => hole.length >= 3)].map((ring) =>
        ring.map((p) => new THREE.Vector2(p.x, p.y)),
      );
      const faces = THREE.ShapeUtils.triangulateShape(contours[0]!, contours.slice(1));
      const offset = positions.length / 3;
      for (const p of contours.flat()) {
        const [lon, lat] = tileCoordinates(
          tile.x + p.x / feature.extent,
          tile.y + p.y / feature.extent,
          tile.z,
        );
        // 14 级瓦片对角线的弦高小于 0.25 米，略微抬高以免水面与影像交错。
        const point = reference.point(lon, lat, height);
        positions.push(...point.toArray());
        if (ground) uv.push(point.x, -point.z);
        if (oceanRect)
          oceanCoords.push(
            oceanRect.x + (p.x / feature.extent) * oceanRect.z,
            oceanRect.y - (p.y / feature.extent) * oceanRect.w,
          );
        if (sampledIds) mask.push(feature.id !== undefined && sampledIds.has(feature.id) ? 1 : 0);
      }
      for (const [a, b, c] of faces) {
        if (ground) indices.push(offset + a!, offset + c!, offset + b!);
        else indices.push(offset + a!, offset + b!, offset + c!);
      }
      if (ground?.material === 'pavers') {
        let start = offset;
        contours.forEach((ring, index) => {
          pavingEdge(ring, index > 0, start, feature.extent, positions, indices, uv);
          start += ring.length;
        });
      }
    }
  }
  if (!indices.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  if (oceanRect)
    geometry.setAttribute('offshoreUv', new THREE.Float32BufferAttribute(oceanCoords, 2));
  if (sampledIds) geometry.setAttribute('sampledWater', new THREE.Uint8BufferAttribute(mask, 1));
  if (ground) {
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.computeVertexNormals();
  }
  return geometry;
}

export function vectorGeometry(
  bytes: Uint8Array,
  tile: Tile,
  reference: GeoReference,
  style: VectorContent['extrusion'],
  groundRoads: RoadLayer | boolean = false,
  waterLayer?: string,
  groundLayers: readonly GroundLayer[] = [],
  waterlineEdits?: readonly WaterlineEdit[],
  sampledWaterIds?: ReadonlySet<number>,
  reflectionBuildings?: readonly VectorBuildingPart[],
  oceanRect?: THREE.Vector4,
) {
  const data = new VectorTile(new Pbf(bytes));
  const layer = data.layers[style.layer];
  const positions: number[] = [];
  const facade: number[] = [];
  const paint: number[] = [];
  const reflectionRows: number[] = [];
  const sections: FacadeSection[] = [];
  const indices: number[] = [];
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
    const tint = style.facade ? buildingPaint(feature.properties.colour) : undefined;
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
        ) ||
        style.excludeBuildingParts?.some((part) =>
          matchesBuildingPart(part, feature.id, minHeight, height, box),
        )
      )
        continue;
      const variant = style.facade
        ? facadeVariant(polygon[0]!, feature.extent, tile, height, tint)
        : 0;
      const flat = top.flat();
      const shape = top.map((ring) => ring.map((p) => new THREE.Vector2(p.x, p.z)));
      const triangles = THREE.ShapeUtils.triangulateShape(shape[0]!, shape.slice(1));
      // 屋面共享顶点，每段立面单独保留四个顶点，让窗面与转角保持平整。
      const roof = positions.length / 3;
      for (const p of flat) positions.push(p.x, p.y, p.z);
      if (style.facade) for (let j = 0; j < flat.length; j++) facade.push(height, variant);
      for (const [ia, ib, ic] of triangles) {
        const a = flat[ia!]!,
          b = flat[ib!]!,
          c = flat[ic!]!;
        const upward = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) >= 0;
        indices.push(roof + ia!, roof + (upward ? ib! : ic!), roof + (upward ? ic! : ib!));
      }
      for (let r = 0; r < top.length; r++) {
        const high = top[r]!,
          low = bottom[r]!;
        // 在本地水平面判断绕序；外墙朝街道，内庭的墙朝洞口。
        const hole = r > 0;
        const reverse = THREE.ShapeUtils.isClockWise(shape[r]!) === hole;
        for (let j = 0; j < high.length; j++) {
          const next = (j + 1) % high.length;
          const wall = positions.length / 3;
          const a = reverse ? next : j,
            b = reverse ? j : next;
          for (const p of [low[a]!, low[b]!, high[a]!, high[b]!]) positions.push(p.x, p.y, p.z);
          if (style.facade)
            facade.push(minHeight, variant, minHeight, variant, height, variant, height, variant);
          indices.push(wall, wall + 1, wall + 2, wall + 2, wall + 1, wall + 3);
        }
      }
      if (indices.length > 600000) throw new Error('矢量瓦片生成几何过大');
      if (style.facade) {
        sections.push({
          outline: polygon[0]!,
          extent: feature.extent,
          bottom: minHeight,
          top: height,
          tint,
          firstVertex: roof,
          endVertex: positions.length / 3,
        });
        // IDs can group separate footprints. Check the surveyed height and position too.
        const row =
          reflectionBuildings?.findIndex((part) =>
            matchesBuildingPart(part, feature.id, minHeight, height, box),
          ) ?? -1;
        const rgb = tint ?? 0;
        for (let k = roof; k < positions.length / 3; k++) {
          if (reflectionBuildings) {
            // Each vertex lies at the base or roof. The shader blends the three probe heights.
            reflectionRows.push(row + 1, facade[k * 2] === height ? 1 : 0);
          }
          paint.push(rgb >>> 16, (rgb >>> 8) & 255, rgb & 255, tint === undefined ? 0 : 255);
        }
      }
      features++;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  if (style.facade) {
    continueStackedFacades(sections, facade);
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(facade, 2));
    if (reflectionBuildings)
      geometry.setAttribute('facadeProbe', new THREE.Uint8BufferAttribute(reflectionRows, 2));
    geometry.setAttribute('facadePaint', new THREE.Uint8BufferAttribute(paint, 4, true));
  }
  geometry.computeVertexNormals();
  // Accumulate normals in float32, then fit each unit component into a normalized signed short.
  const normals = geometry.getAttribute('normal');
  const packed = Int16Array.from(normals.array, (component) => Math.round(component * 32767));
  geometry.setAttribute('normal', new THREE.BufferAttribute(packed, 3, true));
  geometry.computeBoundingSphere();
  return {
    geometry,
    features,
    ground: groundLayers.flatMap((layer) => {
      const surface = polygonSurface(data, layer.layer, tile, reference, layer);
      return surface ? [{ material: layer.material, geometry: surface }] : [];
    }),
    water: waterLayer
      ? polygonSurface(
          data,
          waterLayer,
          tile,
          reference,
          undefined,
          waterlineEdits?.filter(
            ({ tile: [z, x, y] }) => z === tile.z && x === tile.x && y === tile.y,
          ),
          sampledWaterIds,
          oceanRect,
        )
      : undefined,
    roads: groundRoads
      ? roadLines(data, tile, reference, groundRoads === true ? openMapTilesRoads : groundRoads)
      : undefined,
  };
}

const boundsByReference = new WeakMap<GeoReference, Map<string, THREE.Sphere>>();

function vectorTileSphere(tile: Tile, reference: GeoReference): THREE.Sphere {
  const [west, south, east, north] = tileBounds(tile);
  const box = new THREE.Box3();
  for (let row = 0; row <= 4; row++)
    for (let col = 0; col <= 4; col++) {
      const lon = west + ((east - west) * col) / 4,
        lat = south + ((north - south) * row) / 4;
      box.expandByPoint(reference.point(lon, lat, 0));
      box.expandByPoint(reference.point(lon, lat, 2000));
    }
  return box.getBoundingSphere(new THREE.Sphere());
}

/** 从全球四叉树按视锥和距离发现瓦片，输入只含标准地理参考。 */
export function visibleVectorTiles(
  camera: THREE.PerspectiveCamera,
  matrixWorld: THREE.Matrix4,
  reference: GeoReference,
  zoom: number,
  maxDistance: number,
  distantZoom = zoom,
): Tile[] {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const leaves: { tile: Tile; distance: number }[] = [];
  const queue: Tile[] = [{ z: 0, x: 0, y: 0 }];
  let bounds = boundsByReference.get(reference);
  if (!bounds) {
    bounds = new Map();
    boundsByReference.set(reference, bounds);
  }
  const sphere = new THREE.Sphere();
  for (let visited = 0; queue.length && visited < 16000; visited++) {
    const tile = queue.shift()!;
    const key = tileKey(tile);
    let local = bounds.get(key);
    if (!local) {
      local = vectorTileSphere(tile, reference);
      if (bounds.size >= 2048) bounds.delete(bounds.keys().next().value!);
      bounds.set(key, local);
    }
    // 地理范围属于成员的本地坐标，移动成员时仍按当前变换测试视锥。
    sphere.copy(local).applyMatrix4(matrixWorld);
    const distance = camera.position.distanceTo(sphere.center);
    if (distance - sphere.radius > maxDistance || !frustum.intersectsSphere(sphere)) continue;
    // 近岸保留最高精度；远端优先使用来源确实提供建筑的概化层。
    const distant = tile.z === distantZoom && distance - sphere.radius > detailedTileDistance;
    if (tile.z === zoom || distant) leaves.push({ tile, distance });
    else
      for (let i = 0; i < 4; i++)
        queue.push({ z: tile.z + 1, x: tile.x * 2 + (i & 1), y: tile.y * 2 + (i >> 1) });
  }
  return leaves
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 32)
    .map((item) => item.tile);
}
