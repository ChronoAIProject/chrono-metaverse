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
      let sum = 0;
      for (let i = 0; i < p.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(p, i),
          b = new THREE.Vector3().fromBufferAttribute(p, i + 1),
          c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
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
