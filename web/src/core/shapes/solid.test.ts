import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildShape, materialKey, shapeMesh } from './build';
import { meshBounds, normalAt, triangleCount, vertexAt, vertexCount } from './meshData';
import {
  earClip,
  hullDegeneracy,
  hullMesh,
  hullProblem,
  plateFrame,
  plateMesh,
  plateProblem,
  plateProjectionAxes,
  segmentsIntersect,
} from './solid';
import { expectConsistentWinding, expectUnitNormals } from './testUtils';
import { transformMatrix } from './transform';
import type { HullShape, PlateShape, Shape, TemplateTable } from './types';
import { dot3, sub3 } from './vec';

/**
 * 跨语言测试向量（api/crates/metaverse-core/tests/vectors/，由 Rust 生成）里的板、凸包和材质用例：
 * 网格的三角形数、包围盒（Float32 存的坐标，按 1e-5 比较），以及不合法的数据同样被拒绝。
 * 目录不存在时（只检出了 web/）跳过；也可以用 METAVERSE_VECTORS_DIR 指定。
 */
const VECTORS = resolve(
  process.env.METAVERSE_VECTORS_DIR ??
    join(process.cwd(), '../api/crates/metaverse-core/tests/vectors'),
);

interface ShapeVector {
  readonly name: string;
  readonly shape: Shape;
  readonly templates: TemplateTable;
  readonly valid: boolean;
  readonly bounds?: { readonly min: number[]; readonly max: number[] };
  readonly triangles?: number;
}

function load(): [string, ShapeVector][] {
  if (!existsSync(VECTORS)) return [];
  return readdirSync(VECTORS)
    .filter((name) => /^shape_(invalid_)?(plate|hull|material)/.test(name))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(VECTORS, name), 'utf8')) as ShapeVector]);
}

const vectors = load();

describe.skipIf(vectors.length === 0)('跨语言向量：板、凸包、材质', () => {
  it('向量齐全', () => {
    const names = vectors.map(([name]) => name);
    expect(names.filter((n) => n.includes('plate')).length).toBeGreaterThanOrEqual(10);
    expect(names.filter((n) => n.includes('hull')).length).toBeGreaterThanOrEqual(7);
  });

  for (const [name, vector] of vectors) {
    it(name, () => {
      const { shape } = vector;
      if (shape.type === 'plate' || shape.type === 'hull') {
        const problem = shape.type === 'plate' ? plateProblem(shape) : hullProblem(shape);
        if (!vector.valid) {
          expect(problem, name).not.toBeNull();
          const built = buildShape(shape, { templates: vector.templates });
          expect(built.parts).toHaveLength(0);
          expect(built.warnings.join()).toContain('不合法');
          return;
        }
        expect(problem, name).toBeNull();
      }
      if (!vector.valid) return; // 材质的取值由接口服务和命令行校验，网站只管画。
      // 包围盒规则：先求局部网格的包围盒，再变换它的 8 个角点取包围盒（与 Rust 相同）。
      const { transform, ...local } = shape;
      const mesh = shapeMesh(local as Shape, { templates: vector.templates });
      if (vector.triangles !== undefined) expect(triangleCount(mesh)).toBe(vector.triangles);
      const box = meshBounds(mesh)!;
      const matrix = transformMatrix(transform ?? {});
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
        new Vector3(
          i & 1 ? box.max[0] : box.min[0],
          i & 2 ? box.max[1] : box.min[1],
          i & 4 ? box.max[2] : box.min[2],
        ).applyMatrix4(matrix),
      );
      const bounds = new Box3().setFromPoints(corners);
      for (const [key, actual] of [
        ['min', bounds.min],
        ['max', bounds.max],
      ] as const) {
        actual.toArray().forEach((value, k) => {
          expect(Math.abs(value - vector.bounds![key][k]!), `${key}[${k}]`).toBeLessThan(1e-5);
        });
      }
      expectUnitNormals(mesh);
      expectConsistentWinding(mesh);
    });
  }
});

const slanted: PlateShape = {
  type: 'plate',
  points: [
    [0, 0, 0],
    [2, 0, 0],
    [2, 0.9, 0.3],
    [0, 0.9, 0.3],
  ],
  thickness: 0.02,
};

describe('板', () => {
  it('Newell 法向按右手定则；投影去掉法向最大的轴', () => {
    const frame = plateFrame(slanted.points)!;
    expect(frame.normal[1]).toBeLessThan(0);
    expect(frame.normal[2]).toBeGreaterThan(0.9);
    expect(plateProjectionAxes(frame.normal)).toEqual([0, 1]);
    expect(plateProjectionAxes([0.6, 0.6, 0.1])).toEqual([1, 2]);
    expect(plateProjectionAxes([0.1, 0.6, 0.6])).toEqual([0, 2]);
  });

  it('网格：正面朝法向、背面朝反方向，侧面朝外，4n − 4 个三角形', () => {
    const mesh = plateMesh(slanted);
    expect(triangleCount(mesh)).toBe(12);
    expectUnitNormals(mesh);
    expectConsistentWinding(mesh);
    const frame = plateFrame(slanted.points)!;
    // 每个顶点的法线都背离板的中心（板是凸的）。
    const middle = sub3(
      frame.center,
      frame.normal.map((v) => v * 0.01),
    );
    for (let i = 0; i < vertexCount(mesh); i += 1) {
      expect(dot3(sub3(vertexAt(mesh, i), middle), normalAt(mesh, i))).toBeGreaterThan(0);
    }
  });

  it('耳切法保留共线的点，凹多边形也是 n − 2 个三角形', () => {
    const square = [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as [number, number][];
    expect(earClip(square)).toHaveLength(3);
    const lShape = [
      [0, 0],
      [2, 0],
      [2, 0.6],
      [0.6, 0.6],
      [0.6, 2],
      [0, 2],
    ] as [number, number][];
    expect(earClip(lShape)).toHaveLength(4);
    expect(earClip([...lShape].reverse())).toHaveLength(4);
    expect(earClip(lShape.slice(0, 2))).toEqual([]);
  });

  it('自然贴图坐标：面内按米，侧面沿边长', () => {
    const mesh = plateMesh(slanted);
    const us = [...mesh.uvs].filter((_, i) => i % 2 === 0);
    expect(Math.max(...us)).toBeCloseTo(2 * 2 + 2 * Math.hypot(0.9, 0.3), 5);
  });

  it('不合法的板给出原因', () => {
    expect(plateProblem({ ...slanted, thickness: 0 })).toContain('厚度');
    expect(plateProblem({ ...slanted, points: [[0, 0, 0]] })).toContain('3 到 64');
    expect(plateProblem({ ...slanted, points: [[0, 0, Number.NaN], ...slanted.points] })).toContain(
      '有限',
    );
    const repeated: PlateShape = {
      ...slanted,
      points: [[0, 0, 0], [0, 0, 0], ...slanted.points.slice(1)],
    };
    expect(plateProblem(repeated)).toContain('重合');
    expect(plateMesh({ ...slanted, thickness: 2 }).indices).toHaveLength(0);
    expect(segmentsIntersect([0, 0], [2, 0], [1, 0], [1, 1])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 0], [2, 0], [3, 0])).toBe(false);
  });
});

describe('凸包', () => {
  const bow: HullShape = {
    type: 'hull',
    points: [
      [0, 0, 0],
      [0.82, 0.03, 0.11],
      [0.79, 0.62, 0.07],
      [0.04, 0.58, -0.21],
      [0.43, 0.05, 0.93],
      [0.36, 0.66, 0.84],
      [0.4, 0.3, 1.42],
    ],
  };

  it('一般位置：2V − 4 个三角形，面平着色、朝外', () => {
    const mesh = hullMesh(bow);
    expect(triangleCount(mesh)).toBe(10);
    expectUnitNormals(mesh);
    expectConsistentWinding(mesh);
    const center = [0.4, 0.3, 0.45];
    for (let i = 0; i < vertexCount(mesh); i += 1) {
      expect(dot3(sub3(vertexAt(mesh, i), center), normalAt(mesh, i))).toBeGreaterThan(0);
    }
  });

  it('内部的点不是顶点；退化的点集被拒绝', () => {
    const inner: HullShape = { ...bow, points: [...bow.points, [0.4, 0.3, 0.4]] };
    expect(triangleCount(hullMesh(inner))).toBe(10);
    expect(hullDegeneracy([])).toBe('没有点');
    expect(hullDegeneracy([[0, 0, 0]])).toContain('重合');
    expect(
      hullProblem({
        type: 'hull',
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0.5, 0.5, 0.0009],
        ],
      }),
    ).toContain('共面');
    expect(hullProblem({ type: 'hull', points: 'x' as unknown as HullShape['points'] })).toContain(
      '有限',
    );
    expect(hullMesh({ type: 'hull', points: bow.points.slice(0, 3) }).indices).toHaveLength(0);
  });
});

describe('材质的 opacity 和 unlit', () => {
  it('分组键区分透明度和不受光照', () => {
    const keys = [
      { color: [200, 200, 200] as const },
      { color: [200, 200, 200] as const, opacity: 0.3 },
      { color: [200, 200, 200] as const, unlit: true },
      { texture: 'ab'.repeat(32), uv: 'box' as const, unlit: true },
      { texture: 'ab'.repeat(32), uv: 'box' as const },
    ].map(materialKey);
    expect(new Set(keys).size).toBe(5);
  });

  it('实例换颜色时，模板里玻璃部件的透明度保留；实例给了就覆盖', () => {
    const templates: TemplateTable = {
      cabinet: {
        type: 'group',
        children: [
          { type: 'box', size: [1, 1, 0.5], material: { color: [120, 90, 60] } },
          {
            type: 'plate',
            points: [
              [-0.5, 0.1, 0.26],
              [0.5, 0.1, 0.26],
              [0.5, 0.9, 0.26],
              [-0.5, 0.9, 0.26],
            ],
            thickness: 0.01,
            material: { color: [210, 230, 240], opacity: 0.3 },
          },
          {
            type: 'box',
            size: [0.8, 0.4, 0.02],
            transform: { position: [0, 1, 0] },
            material: { texture: 'cd'.repeat(32), uv: 'planar', unlit: true },
          },
        ],
      },
    };
    const recolored = buildShape(
      { type: 'instance', template: 'cabinet', material: { color: [30, 60, 200] } },
      { templates },
    );
    const materials = recolored.parts.map((part) => part.material);
    expect(materials).toContainEqual({ color: [30, 60, 200] });
    expect(materials).toContainEqual({ color: [30, 60, 200], opacity: 0.3 });
    expect(materials).toContainEqual({
      texture: 'cd'.repeat(32),
      uv: 'planar',
      unlit: true,
      tint: [30, 60, 200],
    });
    const frosted = buildShape(
      { type: 'instance', template: 'cabinet', material: { color: [255, 255, 255], opacity: 0.8 } },
      { templates },
    );
    expect(frosted.parts.every((part) => part.material.opacity === 0.8)).toBe(true);
  });
});
