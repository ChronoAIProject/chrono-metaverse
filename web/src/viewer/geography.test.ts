import { describe, expect, it } from 'vitest';
import {
  ancestorUv,
  children,
  ecef,
  EARTH_RADIUS,
  GeoReference,
  tileCoordinates,
  tileSources,
  tileUrl,
} from './geography';
import type { GeographicMap } from '../core/environment';

const global = {
  urlTemplate: 'https://example.org/{z}/{y}/{x}',
  page: 'https://example.org/',
  attribution: '示例影像',
  minZoom: 0,
  maxZoom: 18,
};
const local = { ...global, minZoom: 5, bounds: [0, 0, 20, 20] as const };

it('TMS 来源反转行号，其他协议坐标保持一致', () => {
  expect(tileUrl({ z: 5, x: 17, y: 15 }, { ...global, scheme: 'tms' })).toBe(
    'https://example.org/5/16/17',
  );
});

describe('地图坐标与瓦片来源', () => {
  it('覆盖 Web Mercator 整个世界，经度接缝和四个子块连续', () => {
    expect(tileCoordinates(0, 0, 0)).toEqual([-180, expect.closeTo(85.0511288)]);
    expect(tileCoordinates(1, 1, 0)).toEqual([180, expect.closeTo(-85.0511288)]);
    expect(children({ z: 0, x: 0, y: 0 })).toEqual([
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ]);
  });

  it('局部来源不接收跨边界的瓦片，全球来源继续提供外海与远景', () => {
    expect(tileSources({ z: 0, x: 0, y: 0 }, [local, global])).toEqual([global]);
    expect(tileSources({ z: 5, x: 16, y: 15 }, [local, global])).toEqual([local, global]);
    expect(tileSources({ z: 5, x: 17, y: 15 }, [local, global])).toEqual([global]);
    expect(tileUrl({ z: 5, x: 17, y: 15 }, global)).toBe('https://example.org/5/15/17');
  });

  it('祖先纹理的子区间精确衔接，不需要重叠地面网格', () => {
    expect(ancestorUv({ z: 3, x: 5, y: 6 }, { z: 1, x: 1, y: 1 })).toEqual({
      x: 0.25,
      y: 0.5,
      size: 0.25,
    });
  });
});

describe('WGS84 配准', () => {
  it.each([
    { latitude: 1.28, longitude: 103.85, heading: 18.45 },
    { latitude: -33.86, longitude: 151.2, heading: 90 },
    { latitude: 51.5, longitude: -0.12, heading: -45 },
  ])('任意半球参考点和旋转均可往返 %j', (reference) => {
    const config: GeographicMap = { ...reference, origin: [7, -60, -11], sources: [global] };
    const geo = new GeoReference(config);
    expect(geo.point(reference.longitude, reference.latitude).toArray()).toEqual(config.origin);
    const world = geo.point(reference.longitude + 0.001, reference.latitude + 0.001, 3);
    expect(
      geo
        .toEcef(world)
        .distanceTo(ecef(reference.longitude + 0.001, reference.latitude + 0.001, 3)),
    ).toBeLessThan(1e-8);
    expect(geo.point(reference.longitude, reference.latitude, 10).y).toBeCloseTo(-50, 7);
  });

  it('地面采用地球曲率，海平面远处向地平线落下，不是有限矩形地板', () => {
    const geo = new GeoReference({
      latitude: 0,
      longitude: 0,
      heading: 0,
      origin: [0, 0, 0],
      sources: [global],
    });
    expect(geo.point(0.1, 0).x).toBeLessThan(-11000);
    expect(geo.point(0.1, 0).y).toBeLessThan(-9);
    expect(geo.center.length()).toBeCloseTo(EARTH_RADIUS, 6);
  });
});
