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
  it('识别日间 AgX 配置，未知的色调映射保留默认值', () => {
    const sky = { texture: hash };
    const parse = (daylightToneMapping: string) =>
      environmentOf({
        ...entity,
        props: { background: true, environment: { version: 1, sky, daylightToneMapping } },
      });
    expect(parse('agx')?.daylightToneMapping).toBe('agx');
    expect(parse('other')?.sky?.texture).toBe(hash);
    expect(parse('other')?.daylightToneMapping).toBeUndefined();
  });

  it('解析带负系数的方向天光，残缺数据仍可使用日光', () => {
    const probe = Array.from({ length: 27 }, (_, i) => Math.sin(i));
    const parse = (diffuseProbe: unknown) =>
      environmentOf({
        ...entity,
        props: {
          background: true,
          environment: {
            version: 1,
            sky: {
              texture: hash,
              daylight: {
                azimuth: 0,
                elevation: 45,
                directFraction: 0.5,
                sunColor: [1, 1, 1],
                skyColor: [1, 1, 1],
                diffuseProbe,
              },
            },
          },
        },
      })?.sky?.daylight;
    expect(parse(probe)?.diffuseProbe).toEqual(probe);
    expect(parse(probe.slice(1))).toBeDefined();
    expect(parse(probe.slice(1))?.diffuseProbe).toBeUndefined();
  });
  it('可选日光参数无效时仍载入同一张天空', () => {
    const env = {
      version: 1,
      sky: {
        texture: hash,
        daylight: {
          azimuth: 30,
          elevation: 45,
          directFraction: 0.6,
          sunColor: [1, 1, 1],
          skyColor: [0, 0, 0],
        },
      },
    };
    const result = environmentOf({ ...entity, props: { background: true, environment: env } });
    expect(result?.sky?.texture).toBe(hash);
    expect(result?.sky?.daylight).toBeUndefined();
  });
  it('读取天空的空气透视距离，无效距离沿用原有衰减', () => {
    const sky = (airHalfDistance: number) =>
      environmentOf({
        ...entity,
        props: {
          background: true,
          environment: { version: 1, sky: { texture: hash, airHalfDistance } },
        },
      })?.sky;
    expect(sky(14400)?.airHalfDistance).toBe(14400);
    expect(sky(0)).toMatchObject({ texture: hash });
    expect(sky(0)?.airHalfDistance).toBeUndefined();
  });
  it('从空间资源引用天空并保留任意地点的地图来源', () => {
    expect(environmentOf(entity)).toMatchObject({
      sky: { texture: hash, yaw: 0 },
      map: { latitude: 35, longitude: -120, heading: 0, sources: [source] },
    });
  });

  it('植被曝光只接受已声明的贴图和有效边界，缺图时基础地图仍可用', () => {
    const env = entity.props!.environment as Record<string, unknown>;
    const map = env.map as Record<string, unknown>;
    const region = { texture: hash, rect: [0, 0.25, 0.5, 1], stops: -0.75 };
    const parse = (vegetationExposure: unknown) =>
      environmentOf({
        ...entity,
        props: { ...entity.props, environment: { ...env, map: { ...map, vegetationExposure } } },
      })?.map;
    expect(parse(region)?.vegetationExposure).toEqual(region);
    for (const change of [{ texture: 'c'.repeat(64) }, { rect: [0.5, 0, 0, 1] }, { stops: NaN }]) {
      const result = parse({ ...region, ...change });
      expect(result?.sources).toHaveLength(1);
      expect(result?.vegetationExposure).toBeUndefined();
    }
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
