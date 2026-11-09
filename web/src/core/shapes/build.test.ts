import { describe, expect, it } from 'vitest';
import { buildShape, materialKey, shapeBounds, shapeMesh } from './build';
import { meshBounds, normalAt, vertexAt, vertexCount } from './meshData';
import { expectBounds, expectWellFormed } from './testUtils';
import { shapeToGeometry, toBufferGeometry } from './three';
import { transformMatrix } from './transform';
import type { Shape, TemplateTable } from './types';
import { projectUvs } from './uv';
import { boxMesh } from './box';

const leg: Shape = {
  type: 'sweep',
  path: [
    [0, 0, 0],
    [0, 0.45, 0],
  ],
  section: { circle: 0.012 },
};

const chair: Shape = {
  type: 'group',
  material: { color: [60, 60, 70] },
  children: [
    { type: 'box', size: [0.45, 0.04, 0.45], fillet: 0.01, transform: { position: [0, 0.45, 0] } },
    {
      type: 'box',
      size: [0.45, 0.4, 0.03],
      fillet: 0.01,
      transform: { position: [0, 0.49, -0.21] },
      material: { color: [150, 30, 30] },
    },
    { ...leg, transform: { position: [-0.2, 0, -0.2] } },
    { ...leg, transform: { position: [0.2, 0, -0.2] } },
    { ...leg, transform: { position: [-0.2, 0, 0.2] } },
    { ...leg, transform: { position: [0.2, 0, 0.2] } },
  ],
};

const templates: TemplateTable = { 'chair-a': chair };

describe('变换', () => {
  it('顺序是 T · Ry · Rx · Rz · S', () => {
    const m = transformMatrix({ position: [1, 2, 3], yaw: 90, scale: [2, 1, 1] });
    const e = m.elements;
    // x 轴先放大 2 倍，再绕 y 转 90° 变成 -z 方向。
    expect(e[0]).toBeCloseTo(0, 9);
    expect(e[2]).toBeCloseTo(-2, 9);
    expect([e[12], e[13], e[14]]).toEqual([1, 2, 3]);
  });

  it('偏航 90° 把盒子的宽和深对调', () => {
    const mesh = shapeMesh({
      type: 'box',
      size: [1, 0.5, 0.2],
      transform: { yaw: 90, position: [0, 1, 0] },
    });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.1, 1, -0.5], [0.1, 1.5, 0.5]);
  });

  it('镜像缩放时翻转绕向，法线仍然朝外', () => {
    const mesh = shapeMesh({
      type: 'box',
      size: [1, 1, 1],
      fillet: 0.1,
      transform: { scale: [-1, 1, 1] },
    });
    expectWellFormed(mesh);
  });

  it('非均匀缩放后法线重新归一化', () => {
    const mesh = shapeMesh({
      type: 'cylinder',
      radius: 0.5,
      height: 1,
      transform: { scale: [3, 1, 0.5] },
    });
    expectWellFormed(mesh);
    expectBounds(mesh, [-1.5, 0, -0.25], [1.5, 1, 0.25]);
  });

  it('翻滚和俯仰', () => {
    const mesh = shapeMesh({ type: 'box', size: [1, 2, 1], transform: { roll: 90 } });
    // 绕 z 转 90°：高度方向的 +y 变成 -x。
    expectBounds(mesh, [-2, -0.5, -0.5], [0, 0.5, 0.5]);
    const pitched = shapeMesh({ type: 'box', size: [1, 2, 1], transform: { pitch: 90 } });
    // 绕 x 转 90°：+y 变成 +z。
    expectBounds(pitched, [-0.5, -0.5, 0], [0.5, 0.5, 2]);
  });
});

describe('组合与模板', () => {
  it('组合的包围盒包含全部子形状', () => {
    const bounds = shapeBounds(chair);
    expect(bounds).not.toBeNull();
    expect(bounds!.min[1]).toBeCloseTo(0, 5);
    expect(bounds!.max[1]).toBeCloseTo(0.89, 5);
    expect(bounds!.min[0]).toBeCloseTo(-0.225, 5);
  });

  it('子形状没有材质时继承组合的材质，有的保留自己的', () => {
    const result = buildShape(chair);
    expect(result.warnings).toEqual([]);
    expect(result.parts.map((p) => materialKey(p.material)).sort()).toEqual([
      'c:150,30,30',
      'c:60,60,70',
    ]);
  });

  it('实例按模板生成，并应用自己的变换', () => {
    const instance: Shape = {
      type: 'instance',
      template: 'chair-a',
      transform: { position: [2, 0, 0], yaw: 180 },
    };
    const bounds = shapeBounds(instance, { templates });
    expect(bounds!.min[0]).toBeCloseTo(2 - 0.225, 5);
    expect(bounds!.max[0]).toBeCloseTo(2 + 0.225, 5);
    // 转 180° 后靠背到了 +z 一侧。
    const mesh = shapeMesh(instance, { templates });
    expectWellFormed(mesh);
    const high = [] as number[];
    for (let i = 0; i < vertexCount(mesh); i += 1)
      if (vertexAt(mesh, i)[1] > 0.8) high.push(vertexAt(mesh, i)[2]);
    expect(Math.min(...high)).toBeGreaterThan(0.15);
  });

  it('实例的材质覆盖模板里的颜色', () => {
    const result = buildShape(
      { type: 'instance', template: 'chair-a', material: { color: [10, 120, 200] } },
      { templates },
    );
    expect(result.parts.map((p) => materialKey(p.material))).toEqual(['c:10,120,200']);
  });

  it('实例颜色作用在模板贴图上是色调', () => {
    const textured: TemplateTable = {
      t: { type: 'box', size: [1, 1, 1], material: { texture: 'abc', uv: 'box' } },
    };
    const result = buildShape(
      { type: 'instance', template: 't', material: { color: [1, 2, 3] } },
      { templates: textured },
    );
    expect(result.parts[0]!.material).toEqual({ texture: 'abc', uv: 'box', tint: [1, 2, 3] });
  });

  it('找不到模板、循环引用都只给警告，不抛错', () => {
    expect(buildShape({ type: 'instance', template: 'missing' }).warnings[0]).toContain('missing');
    const loop: TemplateTable = {
      a: { type: 'instance', template: 'b' },
      b: { type: 'group', children: [{ type: 'instance', template: 'a' }] },
    };
    const result = buildShape({ type: 'instance', template: 'a' }, { templates: loop });
    expect(result.parts).toEqual([]);
    expect(result.warnings.join()).toContain('循环');
  });

  it('三角形超过上限时停止生成', () => {
    const result = buildShape(
      {
        type: 'group',
        children: Array.from({ length: 5 }, () => ({ type: 'box', size: [1, 1, 1] }) as Shape),
      },
      { maxTriangles: 30 },
    );
    expect(result.warnings.join()).toContain('上限');
  });
});

describe('贴图坐标', () => {
  it('box / planar / cylindrical 投影都落在 [0, 1]', () => {
    const mesh = boxMesh({ type: 'box', size: [2, 0.1, 1] });
    for (const mode of ['box', 'planar', 'cylindrical'] as const) {
      const projected = projectUvs(mesh, mode);
      for (const value of projected.uvs) {
        expect(value).toBeGreaterThanOrEqual(-1e-6);
        expect(value).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });

  it('planar 沿最薄的轴投影：地面的 uv 就是 x、z 的比例', () => {
    const floor = projectUvs(boxMesh({ type: 'box', size: [4, 0.02, 2] }), 'planar');
    for (let i = 0; i < vertexCount(floor); i += 1) {
      const [x, , z] = vertexAt(floor, i);
      expect(floor.uvs[i * 2]).toBeCloseTo((x + 2) / 4, 5);
      expect(floor.uvs[i * 2 + 1]).toBeCloseTo((z + 1) / 2, 5);
    }
  });

  it('贴图材质在组合层按组合的包围盒投影', () => {
    const result = buildShape({
      type: 'group',
      material: { texture: 'wood', uv: 'planar' },
      children: [
        { type: 'box', size: [1, 0.02, 1], transform: { position: [-0.5, 0, 0] } },
        { type: 'box', size: [1, 0.02, 1], transform: { position: [0.5, 0, 0] } },
      ],
    });
    const mesh = result.parts[0]!.mesh;
    const us = Array.from({ length: vertexCount(mesh) }, (_, i) => mesh.uvs[i * 2]!);
    expect(Math.min(...us)).toBeCloseTo(0, 5);
    expect(Math.max(...us)).toBeCloseTo(1, 5);
  });
});

describe('three.js 几何体', () => {
  it('toBufferGeometry 带位置、法线、UV 和索引', () => {
    const geometry = toBufferGeometry(boxMesh({ type: 'box', size: [1, 1, 1], fillet: 0.1 }));
    expect(geometry.getAttribute('position').count).toBeGreaterThan(24);
    expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count);
    expect(geometry.getAttribute('uv').itemSize).toBe(2);
    expect(geometry.index).not.toBeNull();
    expect(geometry.boundingBox!.max.y).toBeCloseTo(1, 5);
  });

  it('shapeToGeometry 按材质分组', () => {
    const { geometry, materials } = shapeToGeometry(
      { type: 'instance', template: 'chair-a' },
      { templates },
    );
    expect(materials).toHaveLength(2);
    expect(geometry.groups).toHaveLength(2);
    expect(geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    const total = geometry.groups.reduce((s, g) => s + g.count, 0);
    expect(total).toBe(geometry.index!.count);
    const mesh = shapeMesh({ type: 'instance', template: 'chair-a' }, { templates });
    expect(meshBounds(mesh)!.max[1]).toBeCloseTo(geometry.boundingBox!.max.y, 5);
    expect(normalAt(mesh, 0)).toHaveLength(3);
  });
});
