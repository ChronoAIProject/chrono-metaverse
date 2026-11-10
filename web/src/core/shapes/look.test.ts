import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METALNESS,
  DEFAULT_ROUGHNESS,
  TRANSPARENT_ROUGHNESS,
  isAssetHash,
  shadingLook,
} from './look';
import type { Material, Shape } from './types';

const VECTORS = resolve(
  process.env.METAVERSE_VECTORS_DIR ??
    join(process.cwd(), '../api/crates/metaverse-core/tests/vectors'),
);

interface MaterialVector {
  readonly shape: Shape;
  readonly templates: Readonly<Record<string, Shape>>;
  readonly valid: boolean;
}

/** 形状和模板里声明的全部材质。 */
function materialsOf(shape: Shape): Material[] {
  const own = shape.material ? [shape.material] : [];
  return shape.type === 'group' ? [...own, ...shape.children.flatMap(materialsOf)] : own;
}

function load(): [string, MaterialVector][] {
  if (!existsSync(VECTORS)) return [];
  return readdirSync(VECTORS)
    .filter((name) => /^shape_(invalid_)?material/.test(name))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(VECTORS, name), 'utf8')) as MaterialVector]);
}

const HASH_A = '9f2c7d4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d';
const HASH_N = '4b1e0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d9f2c7d';
const HASH_R = '0a3f5c6d8e7b9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d9f2c7d4b1e';

describe('着色参数（SHAPES 2"着色、法线、粗糙度"）', () => {
  it('新字段都不给：与以前的画法相同', () => {
    const base = {
      shading: 'baked',
      normalMap: null,
      normalScale: 1,
      roughnessMap: null,
      metalness: DEFAULT_METALNESS,
    };
    expect(shadingLook({ color: [1, 2, 3] }, false)).toEqual({
      ...base,
      roughness: DEFAULT_ROUGHNESS,
    });
    expect(shadingLook({ texture: HASH_A, uv: 'box' }, true)).toEqual({
      ...base,
      roughness: TRANSPARENT_ROUGHNESS,
    });
    expect([DEFAULT_ROUGHNESS, TRANSPARENT_ROUGHNESS, DEFAULT_METALNESS]).toEqual([
      0.82, 0.1, 0.02,
    ]);
  });

  it('给了的按给的；有粗糙度贴图时粗糙度默认 1（是乘数）', () => {
    expect(
      shadingLook(
        {
          texture: HASH_A,
          uv: 'box',
          shading: 'albedo',
          normalMap: HASH_N,
          normalScale: 1.5,
          roughnessMap: HASH_R,
          metalness: 0,
        },
        false,
      ),
    ).toEqual({
      shading: 'albedo',
      normalMap: HASH_N,
      normalScale: 1.5,
      roughnessMap: HASH_R,
      roughness: 1,
      metalness: 0,
    });
    expect(shadingLook({ color: [1, 2, 3], roughness: 0.55, metalness: 0.8 }, true)).toMatchObject({
      roughness: 0.55,
      metalness: 0.8,
    });
  });

  it('不合法的字段按没给处理，不报错（写入时已经拒绝，这里只防坏数据）', () => {
    const bad = {
      texture: HASH_A,
      uv: 'box',
      shading: 'pbr',
      normalMap: 'NORMAL-MAP',
      normalScale: 2,
      roughnessMap: HASH_R.toUpperCase(),
      roughness: 1.2,
      metalness: Number.NaN,
    } as unknown as Material;
    expect(shadingLook(bad, false)).toEqual({
      shading: 'baked',
      normalMap: null,
      // 没有有效的法线贴图时 normalScale 不起作用
      normalScale: 1,
      roughnessMap: null,
      roughness: DEFAULT_ROUGHNESS,
      metalness: DEFAULT_METALNESS,
    });
    expect(
      shadingLook({ color: [1, 2, 3], uv: 'box', normalMap: HASH_N, normalScale: 4.5 }, false)
        .normalScale,
    ).toBe(1);
    expect(isAssetHash(HASH_A)).toBe(true);
    expect(isAssetHash(HASH_A.slice(1))).toBe(false);
    expect(isAssetHash(42)).toBe(false);
  });
});

const vectors = load();

describe.skipIf(vectors.length === 0)('跨语言向量：材质的着色参数', () => {
  it('向量齐全', () => {
    expect(vectors.filter(([, v]) => v.valid).length).toBeGreaterThanOrEqual(8);
    expect(vectors.filter(([, v]) => !v.valid).length).toBeGreaterThanOrEqual(19);
  });

  for (const [name, vector] of vectors) {
    it(name, () => {
      const materials = [
        ...materialsOf(vector.shape),
        ...Object.values(vector.templates ?? {}).flatMap(materialsOf),
      ];
      expect(materials.length).toBeGreaterThan(0);
      for (const material of materials) {
        const transparent = (material.opacity ?? 1) < 1;
        const look = shadingLook(material, transparent);
        // 不管合不合法，结果都在规格的取值范围里
        expect(['baked', 'albedo']).toContain(look.shading);
        expect(look.normalMap === null || isAssetHash(look.normalMap)).toBe(true);
        expect(look.roughnessMap === null || isAssetHash(look.roughnessMap)).toBe(true);
        expect(look.normalScale).toBeGreaterThanOrEqual(0);
        expect(look.normalScale).toBeLessThanOrEqual(4);
        for (const value of [look.roughness, look.metalness]) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
        if (!vector.valid) continue;
        // 合法的材质：写了的字段原样用，没写的取默认值
        expect(look).toEqual({
          shading: material.shading ?? 'baked',
          normalMap: material.normalMap ?? null,
          normalScale: material.normalScale ?? 1,
          roughnessMap: material.roughnessMap ?? null,
          roughness:
            material.roughness ??
            (material.roughnessMap ? 1 : transparent ? TRANSPARENT_ROUGHNESS : DEFAULT_ROUGHNESS),
          metalness: material.metalness ?? DEFAULT_METALNESS,
        });
      }
    });
  }
});
