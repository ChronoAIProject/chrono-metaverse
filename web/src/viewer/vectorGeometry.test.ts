import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vectorGeometry, visibleVectorTiles } from './vectorGeometry';
import { GeoReference, tileCoordinates, tileKey } from './geography';
import { vectorTileFixture } from '../test/vectorTile';
import type { VectorContent, WaterlineEdit } from '../core/externalSource';

const tile = { z: 14, x: 14517, y: 6460 };
const [longitude, latitude] = tileCoordinates(tile.x + 0.5, tile.y + 0.5, tile.z);
const reference = new GeoReference({ longitude, latitude, origin: [4, -60, 8], heading: 37 });
const style: VectorContent['extrusion'] = {
  layer: 'shapes',
  heightProperty: 'elevation',
  defaultHeight: 8,
  maxHeight: 1000,
  maxDistance: 20000,
  color: '#aabbcc',
};

describe('通用矢量三维内容', () => {
  it('高度、地理配准和孔洞来自输入，保护已有内容且不生成超高几何', () => {
    const solid = vectorGeometry(vectorTileFixture(24), tile, reference, style);
    const hollow = vectorGeometry(vectorTileFixture(24, true), tile, reference, style);
    expect(solid.features).toBe(1);
    solid.geometry.computeBoundingBox();
    expect(solid.geometry.boundingBox!.min.y).toBeCloseTo(-60, 0);
    expect(solid.geometry.boundingBox!.max.y).toBeCloseTo(-36, 0);
    const roofArea = (geometry: THREE.BufferGeometry) => {
      const p = geometry.getAttribute('position');
      const index = geometry.index!;
      let sum = 0;
      for (let i = 0; i < index.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(p, index.getX(i)),
          b = new THREE.Vector3().fromBufferAttribute(p, index.getX(i + 1)),
          c = new THREE.Vector3().fromBufferAttribute(p, index.getX(i + 2));
        sum += Math.abs(b.sub(a).cross(c.sub(a)).y) / 2;
      }
      return sum;
    };
    expect(roofArea(hollow.geometry) / roofArea(solid.geometry)).toBeCloseTo(0.75, 2);
    expect(vectorGeometry(vectorTileFixture(2001), tile, reference, style).features).toBe(0);
    expect(
      vectorGeometry(vectorTileFixture(), tile, reference, {
        ...style,
        excludeBounds: [[-10000, -10000, 10000, 10000]],
      }).features,
    ).toBe(0);
    solid.geometry.dispose();
    hollow.geometry.dispose();
  });

  it('单面远楼从街道和内庭看都能命中最近的墙，屋顶的洞口仍然贯通', () => {
    const { geometry } = vectorGeometry(vectorTileFixture(24, true), tile, reference, style);
    const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
    const mesh = new THREE.Mesh(geometry, material);
    const point = (x: number, height: number) =>
      reference.point(...tileCoordinates(tile.x + x, tile.y + 0.5, tile.z), height);
    for (const [eye, wall] of [
      [0.2, 0.25],
      [0.5, 0.625],
    ] as const) {
      const from = point(eye, 12),
        to = point(wall, 12);
      const ray = new THREE.Raycaster(from, to.clone().sub(from).normalize());
      expect(ray.intersectObject(mesh)[0]!.point.distanceTo(to)).toBeLessThan(0.1);
    }
    expect(
      new THREE.Raycaster(point(0.5, 50), new THREE.Vector3(0, -1, 0)).intersectObject(mesh),
    ).toHaveLength(0);
    expect(geometry.getAttribute('position').count).toBeLessThan(geometry.index!.count);
    geometry.dispose();
    material.dispose();
  });

  it('分片共用编号时只移除被替换的塔身，保留相邻轮廓和下方裙楼', () => {
    const neighbors = [
      [
        [128, 640],
        [384, 640],
        [384, 896],
        [128, 896],
      ],
    ];
    const bounds = [-20, -20, 20, 20] as const;
    const config = {
      ...style,
      excludeBuildingParts: [{ featureId: 1, minHeight: 0, height: 24, bounds }],
    };
    const count = (height: number, footprints: number[][][], options: typeof style) => {
      const { geometry } = vectorGeometry(
        vectorTileFixture(height, false, undefined, footprints),
        tile,
        reference,
        options,
      );
      const vertices = geometry.getAttribute('position').count;
      geometry.dispose();
      return vertices;
    };
    expect(count(24, neighbors, config)).toBe(count(24, neighbors, style) - count(24, [], style));
    expect(count(8, neighbors, config)).toBe(count(8, neighbors, style));
  });

  it('只给高度和位置都匹配的同编号楼体绑定三层反射', () => {
    const data = vectorTileFixture(24, false, undefined, [
      [
        [128, 640],
        [384, 640],
        [384, 896],
        [128, 896],
      ],
    ]);
    const { geometry } = vectorGeometry(
      data,
      tile,
      reference,
      { ...style, facade: 'urban' },
      false,
      undefined,
      [],
      undefined,
      undefined,
      [{ featureId: 1, minHeight: 0, height: 24, bounds: [-20, -20, 20, 20] }],
    );
    const row = geometry.getAttribute('facadeProbe');
    const uv = geometry.getAttribute('uv');
    expect(row.array).toBeInstanceOf(Uint8Array);
    const normal = geometry.getAttribute('normal');
    expect(normal.array).toBeInstanceOf(Int16Array);
    const original = geometry.clone().deleteAttribute('normal');
    original.computeVertexNormals();
    const actual = new THREE.Vector3();
    const expected = new THREE.Vector3();
    for (let i = 0; i < normal.count; i++) {
      actual.fromBufferAttribute(normal, i);
      expected.fromBufferAttribute(original.getAttribute('normal'), i);
      expect(actual.distanceTo(expected)).toBeLessThan(0.00003);
    }
    original.dispose();
    const matched = new Set<number>();
    let other = 0;
    for (let i = 0; i < row.count; i++) {
      if (row.getX(i) === 1) {
        matched.add(uv.getX(i));
        expect(row.getY(i)).toBe(uv.getX(i) / 24);
      } else other++;
    }
    expect(matched).toEqual(new Set([0, 24]));
    expect(other).toBeGreaterThan(0);
    geometry.dispose();
  });

  it('近处细瓦片和远处概化瓦片同时可见，同一位置只绘制一次', () => {
    const camera = new THREE.PerspectiveCamera(48, 1.6, 0.1, 40000);
    camera.position.set(0, 180, 0);
    camera.lookAt(0, 0, -3000);
    camera.updateMatrixWorld();
    const tiles = visibleVectorTiles(camera, new THREE.Matrix4(), reference, 14, 24000, 13);
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([13, 14]));
    const keys = new Set(tiles.map(tileKey));
    for (const t of tiles.filter((t) => t.z === 14))
      expect(keys.has(tileKey({ z: 13, x: t.x >> 1, y: t.y >> 1 }))).toBe(false);
    const facade = vectorGeometry(vectorTileFixture(24), tile, reference, {
      ...style,
      facade: 'urban',
    }).geometry;
    const uv = facade.getAttribute('uv');
    expect(uv.count).toBe(facade.getAttribute('position').count);
    expect(uv.getX(0)).toBeCloseTo(24, 0);
    facade.dispose();
  });

  it('城市墙面读取建筑颜色，区分黑色、未知色和缺少标注', () => {
    for (const [value, expected] of [
      [' #AbC ', [170, 187, 204, 255]],
      ['#5a81a0', [90, 129, 160, 255]],
      ['black', [0, 0, 0, 255]],
      ['lightgrey', [211, 211, 211, 255]],
      ['unmapped', [0, 0, 0, 0]],
      [undefined, [0, 0, 0, 0]],
    ] as const) {
      const { geometry } = vectorGeometry(vectorTileFixture(24, true, value), tile, reference, {
        ...style,
        facade: 'urban',
      });
      const paint = geometry.getAttribute('facadePaint');
      expect(paint.normalized).toBe(true);
      expect(paint.count).toBe(geometry.getAttribute('position').count);
      expect(Array.from(paint.array.slice(-4))).toEqual(expected);
      geometry.dispose();
    }
  });

  it('同一要素内的独立楼体可区分，跨瓦片的墙面延续同一组窗格', () => {
    function variants(x: number, west: number, east: number) {
      const data = vectorTileFixture(60, false, undefined, [
        [
          [west, 640],
          [east, 640],
          [east, 896],
          [west, 896],
        ],
      ]);
      const { geometry, features } = vectorGeometry(data, { ...tile, x }, reference, {
        ...style,
        facade: 'urban',
      });
      expect(features).toBe(2);
      const uv = geometry.getAttribute('uv');
      const result = [uv.getY(0), uv.getY(uv.count - 1)];
      geometry.dispose();
      return result;
    }
    const [a, b] = variants(tile.x, 128, 384);
    expect(a).not.toBe(b);
    expect(variants(tile.x, 3968, 4224)[1]).toBe(variants(tile.x + 1, -128, 128)[1]);
  });

  it('仅重建已配置的地表，草坪保留洞口，铺装有独立的压顶石和立缘', () => {
    const mapping = { layer: 'shapes', property: 'elevation', values: ['24'] } as const;
    const surfaces = vectorGeometry(
      vectorTileFixture(24, true),
      tile,
      reference,
      style,
      false,
      undefined,
      [
        { ...mapping, material: 'turf' },
        { ...mapping, material: 'pavers', excludeFeatureIds: [2] },
        { ...mapping, material: 'pavers', excludeFeatureIds: [1] },
        { ...mapping, material: 'turf', values: ['30'] },
      ],
    ).ground;
    expect(surfaces.map((s) => s.material)).toEqual(['turf', 'pavers']);
    const [grass, paving] = surfaces.map((s) => s.geometry);
    expect(grass!.getAttribute('normal').getY(0)).toBeGreaterThan(0.99);
    expect(paving!.getAttribute('position').count).toBeGreaterThan(
      grass!.getAttribute('position').count,
    );
    const throughHole = reference.point(...tileCoordinates(tile.x + 0.5, tile.y + 0.5, tile.z), 5);
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    for (const s of surfaces) {
      expect(s.geometry.getAttribute('uv').count).toBe(s.geometry.getAttribute('position').count);
      expect(
        new THREE.Raycaster(throughHole, new THREE.Vector3(0, -1, 0)).intersectObject(
          new THREE.Mesh(s.geometry, material),
        ),
      ).toHaveLength(0);
      s.geometry.dispose();
    }
    material.dispose();
  });

  it('指定的水域图层保留岛屿，缺少图层时沿用航拍影像', () => {
    const tileData = vectorTileFixture(24, true);
    expect(vectorGeometry(tileData, tile, reference, style).water).toBeUndefined();
    expect(
      vectorGeometry(tileData, tile, reference, style, false, 'missing').water,
    ).toBeUndefined();
    const surface = vectorGeometry(tileData, tile, reference, style, false, 'shapes').water!;
    // 从岛屿中心向下投射不应击中水面，同一纬度向东移到水域内则应命中。
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(surface, material);
    function hits(x: number) {
      const point = reference.point(...tileCoordinates(tile.x + x, tile.y + 0.5, tile.z), 100);
      return new THREE.Raycaster(point, new THREE.Vector3(0, -1, 0)).intersectObject(mesh).length;
    }
    expect(hits(0.5)).toBe(0);
    expect(hits(0.7)).toBeGreaterThan(0);
    surface.dispose();
    material.dispose();
  });

  it('镜头移动到旧范围之外会发现新瓦片，远到不可见时不下载全球数据', () => {
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.02, 20000000);
    camera.position.set(0, 500, 3000);
    camera.lookAt(0, -60, 0);
    camera.updateMatrixWorld();
    const first = visibleVectorTiles(camera, new THREE.Matrix4(), reference, 14, 12000).map(
      tileKey,
    );
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(32);
    camera.position.x += 20000;
    camera.lookAt(20000, -60, 0);
    camera.updateMatrixWorld();
    const next = visibleVectorTiles(camera, new THREE.Matrix4(), reference, 14, 12000).map(tileKey);
    expect(next.length).toBeGreaterThan(0);
    expect(next.some((key) => !first.includes(key))).toBe(true);
    camera.position.set(0, 1000000, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    expect(visibleVectorTiles(camera, new THREE.Matrix4(), reference, 14, 12000)).toEqual([]);
  });

  it('复用瓦片范围时仍按当前成员变换裁剪', () => {
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.02, 30000);
    camera.position.set(0, 60, 250);
    camera.lookAt(0, 20, -1000);
    camera.updateMatrixWorld();
    const transform = new THREE.Matrix4().makeRotationY(0.85).setPosition(2700, 0, 1000);
    const fresh = new GeoReference({ longitude, latitude, origin: [4, -60, 8], heading: 37 });
    const initial = visibleVectorTiles(camera, new THREE.Matrix4(), reference, 14, 12000);
    const moved = visibleVectorTiles(camera, transform, reference, 14, 12000);
    expect(moved).toEqual(visibleVectorTiles(camera, transform, fresh, 14, 12000));
    expect(moved).not.toEqual(initial);
    expect(visibleVectorTiles(camera, new THREE.Matrix4(), reference, 14, 12000)).toEqual(initial);
  });
});

it('updates only a matching water boundary and retains its island', () => {
  const edit: WaterlineEdit = {
    tile: [tile.z, tile.x, tile.y],
    source: 'https://example.org/tiles',
    featureId: 1,
    extent: 4096,
    from: [
      [1024, 1024],
      [3072, 1024],
    ],
    interior: [
      [1024, 750],
      [3072, 750],
    ],
  };
  const water = (change?: WaterlineEdit) =>
    vectorGeometry(
      vectorTileFixture(24, true),
      tile,
      reference,
      style,
      false,
      'shapes',
      [],
      change ? [change] : [],
    ).water!;
  const baseline = water();
  const extended = water(edit);
  expect(extended.getAttribute('position').count).toBe(baseline.getAttribute('position').count + 2);
  const mesh = new THREE.Mesh(extended, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const hits = (y: number) => {
    const start = reference.point(...tileCoordinates(tile.x + 0.5, tile.y + y, tile.z), 30);
    return new THREE.Raycaster(start, new THREE.Vector3(0, -1, 0)).intersectObject(mesh);
  };
  expect(hits(0.2).length).toBeGreaterThan(0);
  expect(hits(0.5)).toHaveLength(0);
  for (const mismatch of [
    {
      ...edit,
      from: [
        [1024, 1025],
        [3072, 1024],
      ] as const,
    },
    { ...edit, extent: 8192 },
    { ...edit, featureId: 2 },
    { ...edit, tile: [14, tile.x + 1, tile.y] as const },
  ]) {
    const geometry = water(mismatch);
    expect(geometry.attributes.position!.array).toEqual(baseline.attributes.position!.array);
    geometry.dispose();
  }
  baseline.dispose();
  extended.dispose();
  mesh.material.dispose();
});

it('marks only surveyed water features for reflectance sampling', () => {
  const data = vectorTileFixture(24, true);
  for (const [ids, weight] of [
    [new Set([1]), 1],
    [new Set([2]), 0],
  ] as const) {
    const water = vectorGeometry(
      data,
      tile,
      reference,
      style,
      false,
      'shapes',
      [],
      undefined,
      ids,
    ).water!;
    const mask = water.getAttribute('sampledWater');
    expect(mask.count).toBe(water.getAttribute('position').count);
    expect(Array.from(mask.array).every((value) => value === weight)).toBe(true);
    water.dispose();
  }
});

it('marks the selected body colour independently of sampled reservoir waves', () => {
  const bytes = vectorTileFixture(24, true);
  for (const featureId of [1, 2, undefined]) {
    const water = vectorGeometry(
      bytes,
      tile,
      reference,
      style,
      false,
      'shapes',
      [],
      undefined,
      new Set([2]),
      undefined,
      undefined,
      featureId,
      new Set([2]),
    ).water!;
    expect(Array.from(water.getAttribute('sampledWater').array).every((n) => n === 0)).toBe(true);
    expect(Array.from(water.getAttribute('stationWater').array).every((v) => v === 0)).toBe(true);
    const mask = water.getAttribute('waterBodyMask');
    if (featureId === undefined) expect(mask).toBeUndefined();
    else {
      expect(mask.count).toBe(water.getAttribute('position').count);
      expect(Array.from(mask.array).every((n) => n === Number(featureId === 1))).toBe(true);
    }
    water.dispose();
  }
});

it('maps vector water to the same north-up ocean mask as the imagery tile', () => {
  const bytes = vectorTileFixture();
  const rect = new THREE.Vector4(0.25, 0.75, 0.5, 0.25);
  const water = vectorGeometry(
    bytes,
    tile,
    reference,
    style,
    false,
    'shapes',
    [],
    undefined,
    undefined,
    undefined,
    rect,
  ).water!;
  const uv = water.getAttribute('offshoreUv');
  const pairs = Array.from({ length: uv.count }, (_, i) => [uv.getX(i), uv.getY(i)]);
  expect(pairs).toEqual(
    expect.arrayContaining([
      [0.375, 0.6875],
      [0.625, 0.6875],
      [0.625, 0.5625],
      [0.375, 0.5625],
    ]),
  );
  expect(Array.from(water.getAttribute('oceanFeature').array).every((v) => v === 0)).toBe(true);
  water.dispose();
  for (const classification of ['ocean', 'lake']) {
    const classified = vectorGeometry(
      vectorTileFixture(24, false, classification, [], 'class'),
      tile,
      reference,
      style,
      false,
      'shapes',
      [],
      undefined,
      undefined,
      undefined,
      rect,
    ).water!;
    const flags = classified.getAttribute('oceanFeature');
    expect(flags.count).toBe(classified.getAttribute('position').count);
    expect(Array.from(flags.array).every((v) => v === Number(classification === 'ocean'))).toBe(
      true,
    );
    classified.dispose();
  }
  const inland = vectorGeometry(bytes, tile, reference, style, false, 'shapes').water!;
  expect(inland.hasAttribute('offshoreUv')).toBe(false);
  expect(inland.hasAttribute('oceanFeature')).toBe(false);
  inland.dispose();
});
