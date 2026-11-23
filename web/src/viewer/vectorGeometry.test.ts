import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vectorGeometry, visibleVectorTiles } from './vectorGeometry';
import { GeoReference, tileCoordinates, tileKey } from './geography';
import { vectorTileFixture } from '../test/vectorTile';
import type { VectorContent } from '../core/externalSource';

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
        { ...mapping, material: 'pavers' },
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
});
