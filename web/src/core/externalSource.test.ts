import { describe, expect, it } from 'vitest';
import { externalContentOf } from './externalSource';
import { environmentOf } from './environment';
import type { EntityBody } from './api/types';

const source = {
  url: 'https://city.example.org/tileset.json',
  attribution: '示例提供方',
  page: 'https://city.example.org/',
  logo: 'https://city.example.org/logo.png',
  license: { label: '数据许可', url: 'https://city.example.org/license' },
};
const config = { version: 1, format: '3d-tiles', sources: [source] };
const entity: EntityBody = {
  entityId: 'external',
  layer: 'ext',
  kind: 'object',
  props: { background: true, externalContent: config },
};

describe('外部数据源协议', () => {
  it('矢量源通过相同的普通物件声明，字段、参考和保护范围必须有效', () => {
    const vector = {
      ...config,
      format: 'mvt',
      reference: { latitude: 35, longitude: 139, origin: [0, -60, 0] },
      extrusion: {
        layer: 'shapes',
        heightProperty: 'elevation',
        defaultHeight: 8,
        maxHeight: 1000,
        color: '#aabbcc',
        maxDistance: 20000,
        excludeBounds: [[-10, -10, 10, 10]],
      },
    };
    expect(
      externalContentOf({ ...entity, props: { background: true, externalContent: vector } })
        ?.format,
    ).toBe('mvt');
    for (const change of [
      { reference: undefined },
      { extrusion: { ...vector.extrusion, maxHeight: Infinity } },
      { extrusion: { ...vector.extrusion, excludeBounds: [[1, 1, 0, 0]] } },
    ]) {
      expect(
        externalContentOf({
          ...entity,
          props: { background: true, externalContent: { ...vector, ...change } },
        }),
      ).toBeNull();
    }
  });
  it('不同提供方与本地、地理坐标共用普通物件配置', () => {
    expect(externalContentOf(entity)).toMatchObject(config);
    const reference = { latitude: -33.8, longitude: 151.2, origin: [6, -10, 3] };
    expect(
      externalContentOf({
        ...entity,
        props: {
          background: true,
          externalContent: {
            ...config,
            reference,
            sources: [source, { ...source, url: 'https://other.example.org/city.json' }],
          },
        },
      }),
    ).toMatchObject({
      reference: { ...reference, heading: 0 },
      sources: [source, expect.anything()],
    });
    expect(externalContentOf({ ...entity, props: { externalContent: config } })).toBeNull();
  });

  it.each([
    { url: 'http://city.example.org/tileset.json' },
    { url: 'https://user:secret@city.example.org/tileset.json' },
    { logo: 'javascript:alert(1)' },
    { license: { label: '许可', url: 'data:text/html,hello' } },
    { cache: { maxAgeSeconds: Infinity } },
    { cache: { persist: 'yes' } },
    { attribution: '' },
  ])('拒绝无效或有凭据的数据源 %j', (change) => {
    expect(
      externalContentOf({
        ...entity,
        props: {
          background: true,
          externalContent: {
            ...config,
            sources: [{ ...source, ...change }],
          },
        },
      }),
    ).toBeNull();
  });

  it('影像源共用署名、缓存规则，并支持标准 TMS 行号', () => {
    const tile = {
      ...source,
      urlTemplate: 'https://raster.example.org/{z}/{x}/{y}',
      scheme: 'tms',
      minZoom: 0,
      maxZoom: 14,
      cache: { persist: false },
    };
    expect(
      environmentOf({
        ...entity,
        props: {
          background: true,
          environment: {
            version: 1,
            map: { latitude: 35, longitude: 139, origin: [0, 0, 0], sources: [tile] },
          },
        },
      }),
    ).toMatchObject({ map: { sources: [tile] } });
  });
});
