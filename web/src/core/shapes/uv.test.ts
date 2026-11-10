import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boxMesh } from './box';
import { buildShape, materialKey, uvModeOf } from './build';
import { cylinderMesh } from './lathe';
import { loftMesh } from './loft';
import { mergeMeshes, meterUvs, normalAt, vertexAt, vertexCount, type MeshData } from './meshData';
import { sweepMesh } from './sweep';
import { applyMatrix, transformMatrix } from './transform';
import type { Material, Shape, TemplateTable } from './types';
import { exactSinCos, projectUvs, tiledUvs } from './uv';
import { dot3, len3, type V3 } from './vec';

/**
 * 贴图坐标的跨语言向量（api/crates/metaverse-core/tests/vectors/uv/，由 tools/texture_vectors.py 按
 * docs/SHAPES.md 第 2 节独立算出）：按位置和法线找到顶点，最终贴图坐标与向量相同。
 * 目录不存在时（只检出了 web/）跳过；也可以用 METAVERSE_VECTORS_DIR 指定。
 */
const VECTORS = resolve(
  process.env.METAVERSE_VECTORS_DIR ??
    join(process.cwd(), '../api/crates/metaverse-core/tests/vectors'),
);
const UV = join(VECTORS, 'uv');

interface UvVector {
  readonly shape: Shape;
  readonly templates: TemplateTable;
  readonly wrap: 'repeat' | 'clamp';
  readonly tolerance: {
    readonly position: number;
    readonly normalDot: number;
    readonly uv: number;
  };
  readonly vertices: readonly {
    readonly where: string;
    readonly position: V3;
    readonly normal: V3;
    readonly uv: [number, number];
  }[];
}

function load(): [string, UvVector][] {
  if (!existsSync(UV)) return [];
  return readdirSync(UV)
    .filter((name) => /^uv_.*\.json$/.test(name))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(UV, name), 'utf8')) as UvVector]);
}

const vectors = load();

function uvAt(mesh: MeshData, index: number): [number, number] {
  return [mesh.uvs[index * 2] ?? NaN, mesh.uvs[index * 2 + 1] ?? NaN];
}

describe.skipIf(vectors.length === 0)('跨语言向量：贴图坐标', () => {
  it('向量齐全', () => {
    const names = vectors.map(([name]) => name);
    for (const name of [
      'uv_box_tile.json',
      'uv_mesh_cylinder_tile.json',
      'uv_mesh_sweep_tile.json',
    ]) {
      expect(names).toContain(name);
    }
  });

  for (const [name, vector] of vectors) {
    it(name, () => {
      // 最外层的 transform 去掉（贴图坐标在变换之前算）
      const local = { ...vector.shape, transform: undefined } as Shape;
      const built = buildShape(local, { templates: vector.templates });
      expect(built.warnings).toEqual([]);
      expect(built.parts).toHaveLength(1);
      expect(vector.wrap).toBe(built.parts[0]!.material.tile === undefined ? 'clamp' : 'repeat');
      const mesh = built.parts[0]!.mesh;
      const { tolerance } = vector;
      for (const row of vector.vertices) {
        const want = row.normal.map((v) => v / len3(row.normal)) as unknown as V3;
        const found: number[] = [];
        for (let i = 0; i < vertexCount(mesh); i += 1) {
          const p = vertexAt(mesh, i);
          const close = [0, 1, 2].every(
            (k) => Math.abs(p[k]! - row.position[k]!) <= tolerance.position,
          );
          const n = normalAt(mesh, i);
          if (close && dot3(n, want) / len3(n) >= tolerance.normalDot) found.push(i);
        }
        expect(found.length, row.where).toBeGreaterThan(0);
        for (const i of found) {
          const [u, v] = uvAt(mesh, i);
          expect(Math.abs(u - row.uv[0]), `${row.where} u`).toBeLessThanOrEqual(tolerance.uv);
          expect(Math.abs(v - row.uv[1]), `${row.where} v`).toBeLessThanOrEqual(tolerance.uv);
        }
      }
    });
  }
});

const TEXTURE = 'a'.repeat(64);

describe('平铺（tile、offset、rotate）', () => {
  it('90° 的整数倍取精确的 sin、cos，负角度也是', () => {
    expect(exactSinCos(0)).toEqual([0, 1]);
    expect(exactSinCos(90)).toEqual([1, 0]);
    expect(exactSinCos(-90)).toEqual([-1, 0]);
    expect(exactSinCos(540)).toEqual([0, -1]);
    const [s, c] = exactSinCos(30);
    expect(s).toBeCloseTo(0.5, 12);
    expect(c).toBeCloseTo(Math.sqrt(3) / 2, 12);
  });

  it('先加 offset、再转 rotate、再除 tile；不给 tile 时原样返回', () => {
    const st = new Float32Array([1, 0, 0, 2]);
    const material: Material = {
      texture: TEXTURE,
      uv: 'box',
      tile: [0.5, 2],
      offset: [1, 0],
      rotate: 90,
    };
    // (1+1, 0) 转 90° → (0, −2) → (0, −1)；(0+1, 2) → (2, −1) → (4, −0.5)
    expect([...tiledUvs(st, material)]).toEqual([0, -1, 4, -0.5]);
    expect(tiledUvs(st, { texture: TEXTURE, uv: 'box' })).toBe(st);
  });

  it('颜色材质带法线贴图时按它的 uv 投影；没有 uv 的颜色材质保留自然坐标', () => {
    expect(uvModeOf({ color: [1, 2, 3] })).toBe('mesh');
    expect(uvModeOf({ color: [1, 2, 3], uv: 'planar', normalMap: TEXTURE })).toBe('planar');
    expect(uvModeOf({ texture: TEXTURE })).toBe('box');
  });

  it('不给 tile 时与旧算法相同（mesh 模式原样返回，米版本不影响）', () => {
    const mesh = boxMesh({ type: 'box', size: [2, 1, 0.5] });
    expect(projectUvs(mesh, 'mesh', null, { texture: TEXTURE, uv: 'mesh' })).toBe(mesh);
    const plain = projectUvs(mesh, 'box');
    const withMaterial = projectUvs(mesh, 'box', null, { texture: TEXTURE, uv: 'box' });
    expect([...withMaterial.uvs]).toEqual([...plain.uvs]);
    // 盒子的自然坐标就是按自己包围盒的三面投影
    expect([...mesh.uvs]).toEqual([...plain.uvs]);
  });

  it('米版本的自然坐标经过变换、合并、倒角都保留', () => {
    const cylinder = cylinderMesh({ type: 'cylinder', radius: 0.5, height: 1, segments: 8 });
    expect(cylinder.meters).toBeDefined();
    const moved = applyMatrix(cylinder, transformMatrix({ position: [1, 0, 0], yaw: 30 }));
    expect(moved.meters).toBe(cylinder.meters);
    const merged = mergeMeshes([boxMesh({ type: 'box', size: [1, 1, 1] }), cylinder]);
    expect(merged.meters).toHaveLength(merged.uvs.length);
    const chamfered = boxMesh({ type: 'box', size: [1, 1, 1], chamfer: 0.1 });
    expect(chamfered.meters).toHaveLength(chamfered.uvs.length);
    // 挤出、板、凸包的自然坐标本来就是米，没有单独的米版本
    expect(meterUvs({ ...cylinder, meters: undefined })).toBe(cylinder.uvs);
  });

  it('放样的米版本：u 是截面弧长，v 从首截面量起', () => {
    const square = (half: number) => ({
      points: [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half],
      ] as [number, number][],
    });
    const mesh = loftMesh({
      type: 'loft',
      sections: [
        { y: 0.2, outline: square(0.5) },
        { y: 1.2, outline: square(0.25) },
      ],
    });
    const meters = mesh.meters!;
    let maxU = 0;
    let maxV = 0;
    for (let i = 0; i < vertexCount(mesh); i += 1) {
      if (Math.abs(normalAt(mesh, i)[1]) > 0.99) continue; // 顶面、底面是 (x, z)
      maxU = Math.max(maxU, meters[i * 2]!);
      maxV = Math.max(maxV, meters[i * 2 + 1]!);
    }
    expect(maxU).toBeCloseTo(4, 5); // 底截面周长 4 米
    expect(maxV).toBeCloseTo(1, 5);
  });

  it('矩形截面扫掠的米版本：从 (w/2, −h/2) 起依次量四条边', () => {
    const mesh = sweepMesh({
      type: 'sweep',
      path: [
        [0, 0, 0],
        [2, 0, 0],
      ],
      section: { rect: [0.4, 0.1] },
      caps: false,
    });
    const meters = mesh.meters!;
    const us = new Set<number>();
    for (let i = 0; i < vertexCount(mesh); i += 1) us.add(Math.round(meters[i * 2]! * 1e5) / 1e5);
    expect([...us].sort((a, b) => a - b)).toEqual([0, 0.1, 0.5, 0.6, 1]);
  });

  it('分组键包含新字段；都不给时与旧的键相同', () => {
    expect(materialKey({ texture: TEXTURE, uv: 'box' })).toBe(`t:${TEXTURE}:`);
    expect(materialKey({ color: [1, 2, 3] })).toBe('c:1,2,3');
    const tiled = materialKey({ texture: TEXTURE, uv: 'box', tile: [1, 1] });
    const albedo = materialKey({ texture: TEXTURE, uv: 'box', tile: [1, 1], shading: 'albedo' });
    expect(new Set([tiled, albedo, `t:${TEXTURE}:`]).size).toBe(3);
  });

  it('实例换颜色时保留模板部件自己的平铺、法线、粗糙度', () => {
    const templates: TemplateTable = {
      chair: {
        type: 'box',
        size: [1, 1, 1],
        material: {
          color: [9, 9, 9],
          uv: 'box',
          tile: [0.5, 0.5],
          normalMap: TEXTURE,
          roughness: 0.6,
        },
      },
    };
    const built = buildShape(
      { type: 'instance', template: 'chair', material: { color: [200, 10, 10], opacity: 0.5 } },
      { templates },
    );
    expect(built.parts).toHaveLength(1);
    expect(built.parts[0]!.material).toEqual({
      color: [200, 10, 10],
      uv: 'box',
      tile: [0.5, 0.5],
      normalMap: TEXTURE,
      roughness: 0.6,
      opacity: 0.5,
    });
  });
});
