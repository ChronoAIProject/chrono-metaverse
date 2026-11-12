import { describe, expect, it } from 'vitest';
import { environmentOf } from './environment';
import type { EntityBody } from './api/types';

const hash = 'b'.repeat(64);
const source = {
  urlTemplate: 'https://maps.example.org/{z}/{x}/{y}.jpg',
  attribution: '示例地图',
  page: 'https://maps.example.org/',
  minZoom: 0,
  maxZoom: 18,
};
const entity: EntityBody = {
  entityId: 'environment',
  layer: 'ext',
  kind: 'object',
  textures: [hash],
  props: {
    background: true,
    environment: {
      version: 1,
      sky: { texture: hash },
      map: { latitude: 35, longitude: -120, origin: [4, -32, 7], sources: [source] },
    },
  },
};

describe('通用环境配置', () => {
  it('从空间资源引用天空并保留任意地点的地图来源', () => {
    expect(environmentOf(entity)).toMatchObject({
      sky: { texture: hash, yaw: 0 },
      map: { latitude: 35, longitude: -120, heading: 0, sources: [source] },
    });
  });

  it('资源没有声明归属时不读取天空，普通物件不启用环境', () => {
    expect(environmentOf({ ...entity, textures: [] })).toBeNull();
    expect(environmentOf({ ...entity, props: { ...entity.props, background: false } })).toBeNull();
  });

  it.each([
    { latitude: NaN },
    { longitude: 181 },
    { origin: [0, Infinity, 0] },
    { sources: [{ ...source, urlTemplate: 'http://maps.example.org/{z}/{x}/{y}' }] },
    { sources: [{ ...source, urlTemplate: 'https://name:secret@maps.example.org/{z}/{x}/{y}' }] },
    { sources: [{ ...source, urlTemplate: 'https://maps.example.org/no-placeholder' }] },
    { sources: [{ ...source, bounds: [10, 10, 20, 20] }] },
    { sources: [{ ...source, minZoom: 5 }] },
    { sources: [{ ...source, maxZoom: 28 }] },
  ])('拒绝无效或没有全球回退的地图配置 %j', (change) => {
    const raw = entity.props!.environment as Record<string, unknown>;
    const map = raw.map as Record<string, unknown>;
    expect(
      environmentOf({
        ...entity,
        props: { background: true, environment: { ...raw, map: { ...map, ...change } } },
      }),
    ).toBeNull();
  });
});
