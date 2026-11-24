import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Material } from '../core/shapes/types';
import { BUILTIN_SPACE_STYLES, type StyleLook } from '../core/styles';
import { TEXTURE_DIFFUSE, TEXTURE_EMISSIVE } from './lighting';
import {
  TextureCache,
  bakeInPlace,
  configureTexture,
  createModelMaterial,
  createShapeMaterial,
  modelMaterialKey,
  srgb,
  type MaterialContext,
  type TextureRole,
} from './materials';

const COLOR = 'c'.repeat(64);
const NORMAL = 'a'.repeat(64);
const ROUGH = 'b'.repeat(64);

/** 假的贴图来源：按（哈希，用途）记下请求，返回设置好的贴图；`fail` 里的哈希下载失败。 */
function fakeContext(options: { alive?: boolean; fail?: string[] } = {}) {
  const requests: [string, TextureRole][] = [];
  const maps = new Map<string, THREE.Texture>();
  const clipping = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 2)];
  const ctx: MaterialContext = {
    clipping,
    alive: () => options.alive ?? true,
    texture: (hash, role) => {
      requests.push([hash, role]);
      if (options.fail?.includes(hash)) return Promise.reject(new Error('下载失败'));
      const map = configureTexture(new THREE.Texture(), role, 4);
      map.name = `${role}:${hash.slice(0, 4)}`;
      maps.set(`${role}|${hash}`, map);
      return Promise.resolve(map);
    },
  };
  return { ctx, requests, maps, clipping };
}

/** 等贴图的 then 回调跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function expectColor(actual: THREE.Color, expected: THREE.Color) {
  expect(actual.r).toBeCloseTo(expected.r, 6);
  expect(actual.g).toBeCloseTo(expected.g, 6);
  expect(actual.b).toBeCloseTo(expected.b, 6);
}

describe('形状材质：旧数据画出来不变', () => {
  it('颜色材质：完整受光，粗糙度 0.82、金属度 0.02，没有贴图', () => {
    const { ctx, requests, clipping } = fakeContext();
    const material = createShapeMaterial({ color: [200, 100, 50] }, false, ctx);
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    const standard = material as THREE.MeshStandardMaterial;
    expectColor(standard.color, srgb([200, 100, 50]));
    expect([standard.roughness, standard.metalness]).toEqual([0.82, 0.02]);
    expect(standard.emissive.getHex()).toBe(0);
    expect([standard.map, standard.normalMap, standard.roughnessMap]).toEqual([null, null, null]);
    expect(standard.transparent).toBe(false);
    expect(standard.clippingPlanes).toBe(clipping);
    expect(requests).toEqual([]);
  });

  it('半透明和旧的 props.glass：双面、不写深度，粗糙度 0.1', () => {
    const { ctx } = fakeContext();
    const glass = createShapeMaterial({ color: [210, 230, 240], opacity: 0.25 }, false, ctx);
    expect(glass).toMatchObject({
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.1,
    });
    const legacy = createShapeMaterial({ color: [210, 230, 240] }, true, ctx);
    expect(legacy).toMatchObject({ transparent: true, opacity: 0.32, roughness: 0.1 });
  });

  it('贴图材质（不写 shading 就是 baked）：贴图 × tint 0.3 受光 + 0.72 自发光', async () => {
    const { ctx, requests, maps } = fakeContext();
    const tint = srgb([255, 250, 240]);
    const material = createShapeMaterial(
      { texture: COLOR, uv: 'planar', tint: [255, 250, 240] },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    // 贴图到之前：灰一点的色调占位
    expectColor(material.color, tint.clone().multiplyScalar(0.8 * TEXTURE_DIFFUSE));
    await settle();
    const map = maps.get(`color|${COLOR}`)!;
    expect(material.map).toBe(map);
    expect(material.emissiveMap).toBe(map);
    expectColor(material.color, tint.clone().multiplyScalar(TEXTURE_DIFFUSE));
    expectColor(material.emissive, tint.clone().multiplyScalar(TEXTURE_EMISSIVE));
    expect([material.roughness, material.metalness]).toEqual([0.82, 0.02]);
    expect(requests).toEqual([[COLOR, 'color']]);
    // 写明 baked 与不写相同
    const explicit = createShapeMaterial(
      { texture: COLOR, uv: 'planar', tint: [255, 250, 240], shading: 'baked' },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expectColor(explicit.emissive, tint.clone().multiplyScalar(TEXTURE_EMISSIVE));
  });

  it('贴图下载失败：按色调显示，亮度与有贴图时一致', async () => {
    const { ctx } = fakeContext({ fail: [COLOR] });
    const material = createShapeMaterial(
      { texture: COLOR, uv: 'box' },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expect(material.map).toBeNull();
    expectColor(material.color, new THREE.Color(1, 1, 1).multiplyScalar(TEXTURE_DIFFUSE));
    expectColor(material.emissive, new THREE.Color(1, 1, 1).multiplyScalar(TEXTURE_EMISSIVE));
  });

  it('不打光（unlit）：MeshBasicMaterial 按原色，不做色调映射', async () => {
    const { ctx, requests, maps } = fakeContext();
    const material = createShapeMaterial(
      { texture: COLOR, uv: 'planar', unlit: true, normalMap: NORMAL, shading: 'albedo' },
      false,
      ctx,
    );
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(material.toneMapped).toBe(false);
    await settle();
    expect((material as THREE.MeshBasicMaterial).map).toBe(maps.get(`color|${COLOR}`));
    // unlit 优先：着色方式、法线都不起作用，法线贴图也不下载
    expect(requests).toEqual([[COLOR, 'color']]);
  });
});

describe('形状材质：着色方式、法线和粗糙度', () => {
  const albedo: Material = {
    texture: COLOR,
    uv: 'box',
    tint: [240, 220, 200],
    tile: [0.5, 0.5],
    shading: 'albedo',
    normalMap: NORMAL,
    normalScale: 1.5,
    roughnessMap: ROUGH,
    roughness: 0.9,
    metalness: 0,
  };

  it('albedo：贴图 × tint 是固有色，完整受光、没有自发光；法线、粗糙度贴图按各自的用途取', async () => {
    const { ctx, requests, maps } = fakeContext();
    const material = createShapeMaterial(albedo, false, ctx) as THREE.MeshStandardMaterial;
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    await settle();
    expect(material.map).toBe(maps.get(`color|${COLOR}`));
    expect(material.emissiveMap).toBeNull();
    expect(material.emissive.getHex()).toBe(0);
    expectColor(material.color, srgb([240, 220, 200]));
    expect(material.normalMap).toBe(maps.get(`normal|${NORMAL}`));
    expect(material.normalScale.toArray()).toEqual([1.5, 1.5]);
    expect(material.roughnessMap).toBe(maps.get(`roughness|${ROUGH}`));
    expect([material.roughness, material.metalness]).toEqual([0.9, 0]);
    expect(requests).toEqual([
      [COLOR, 'color'],
      [NORMAL, 'normal'],
      [ROUGH, 'roughness'],
    ]);
    // 颜色贴图 sRGB，法线和粗糙度是线性数据；一律重复采样（给了 tile 按米重复）
    expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.roughnessMap!.colorSpace).toBe(THREE.NoColorSpace);
    for (const map of [material.map!, material.normalMap!, material.roughnessMap!]) {
      expect([map.wrapS, map.wrapT]).toEqual([THREE.RepeatWrapping, THREE.RepeatWrapping]);
    }
  });

  it('baked 的贴图也能带法线和粗糙度：作用在受光照的那 0.3 倍上', async () => {
    const { ctx, maps } = fakeContext();
    const material = createShapeMaterial(
      { ...albedo, shading: 'baked' },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expect(material.emissiveMap).toBe(maps.get(`color|${COLOR}`));
    expectColor(material.color, srgb([240, 220, 200]).multiplyScalar(TEXTURE_DIFFUSE));
    expect(material.normalMap).toBe(maps.get(`normal|${NORMAL}`));
    expect(material.roughnessMap).toBe(maps.get(`roughness|${ROUGH}`));
  });

  it('颜色材质带法线贴图和粗糙度贴图：颜色不变，粗糙度默认 1（贴图是乘数）', async () => {
    const { ctx, maps } = fakeContext();
    const material = createShapeMaterial(
      {
        color: [182, 140, 96],
        uv: 'box',
        tile: [0.3, 0.3],
        normalMap: NORMAL,
        roughnessMap: ROUGH,
      },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expectColor(material.color, srgb([182, 140, 96]));
    expect(material.map).toBeNull();
    expect(material.normalMap).toBe(maps.get(`normal|${NORMAL}`));
    expect(material.normalScale.toArray()).toEqual([1, 1]);
    expect(material.roughnessMap).toBe(maps.get(`roughness|${ROUGH}`));
    expect(material.roughness).toBe(1);
  });

  it('场景释放以后到达的贴图不再挂上', async () => {
    const { ctx } = fakeContext({ alive: false });
    const material = createShapeMaterial(albedo, false, ctx) as THREE.MeshStandardMaterial;
    await settle();
    expect([material.map, material.normalMap, material.roughnessMap]).toEqual([null, null, null]);
  });
});

describe('贴图缓存：按（哈希，用途）', () => {
  it('同一个资源只下载一次；当颜色和当法线用时是两份设置不同、共用图片的贴图', async () => {
    const image = new THREE.Texture();
    const load = vi.fn(() => Promise.resolve(image));
    const counts: number[] = [];
    const cache = new TextureCache(
      load,
      () => 8,
      (count) => counts.push(count),
    );
    const [color, normal, again, occlusion] = await Promise.all([
      cache.get(COLOR, 'color'),
      cache.get(COLOR, 'normal'),
      cache.get(COLOR, 'color'),
      cache.get(COLOR, 'model-occlusion'),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(color).toBe(image);
    expect(again).toBe(color);
    expect(normal).not.toBe(color);
    expect(normal!.source).toBe(color!.source);
    expect(color!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(normal!.colorSpace).toBe(THREE.NoColorSpace);
    expect(normal!.anisotropy).toBe(8);
    expect(occlusion).not.toBe(normal);
    expect(occlusion!.flipY).toBe(false);
    expect(occlusion!.colorSpace).toBe(THREE.NoColorSpace);
    expect(color!.flipY).toBe(true);
    expect(counts).toEqual([0, 1, 0]);
    cache.dispose();
  });

  it('下载失败的不留在缓存里，下次重新下载；没有加载函数时返回 null', async () => {
    const load = vi
      .fn<(hash: string) => Promise<THREE.Texture>>()
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValue(new THREE.Texture());
    const counts: number[] = [];
    const cache = new TextureCache(
      load,
      () => 1,
      (count) => counts.push(count),
    );
    await expect(cache.get(COLOR, 'color')).rejects.toThrow('网络错误');
    await expect(cache.get(COLOR, 'color')).resolves.toBeInstanceOf(THREE.Texture);
    expect(load).toHaveBeenCalledTimes(2);
    expect(counts).toEqual([0, 1, 0, 1, 0]);
    expect(new TextureCache(undefined, () => 1).get(COLOR, 'color')).toBeNull();
  });
});

describe('物件模型的材质：material.shading', () => {
  /** glb 里受光照、带颜色贴图的材质（GLTFLoader 解析出来的样子）。 */
  function textured() {
    const map = new THREE.Texture();
    const source = new THREE.MeshStandardMaterial({ color: 0xd0a080, map, roughness: 0.6 });
    return { source, map, original: source.color.clone() };
  }
  const clipping = [new THREE.Plane()];

  it('baked（不写时）：贴图材质按扫描烘焙的看法派生，不改模型里的原材质', () => {
    const { source, map, original } = textured();
    const key = modelMaterialKey(source, undefined);
    expect(key).not.toBeNull();
    expect(modelMaterialKey(source, { shading: 'baked' })).toBe(key);
    const material = createModelMaterial(source, undefined, clipping) as THREE.MeshStandardMaterial;
    expect(material).not.toBe(source);
    expect(material.emissiveMap).toBe(map);
    expectColor(material.color, original.clone().multiplyScalar(TEXTURE_DIFFUSE));
    expectColor(material.emissive, original.clone().multiplyScalar(TEXTURE_EMISSIVE));
    expect(material.clippingPlanes).toBe(clipping);
    expectColor(source.color, original);
    expect(source.emissiveMap).toBeNull();
  });

  it('albedo：模型里的材质原样完整受光；带 tint 时只乘颜色，不加自发光', () => {
    const { source, original } = textured();
    expect(modelMaterialKey(source, { shading: 'albedo' })).toBeNull();
    const look = { shading: 'albedo', tint: [255, 128, 128] } as const;
    const key = modelMaterialKey(source, look)!;
    expect(key).not.toBe(modelMaterialKey(source, { tint: [255, 128, 128] }));
    const material = createModelMaterial(source, look, clipping) as THREE.MeshStandardMaterial;
    expect(material.emissiveMap).toBeNull();
    expect(material.emissive.getHex()).toBe(0);
    expectColor(material.color, original.clone().multiply(srgb([255, 128, 128])));
    expect(material.roughness).toBe(0.6);
  });

  it('unlit 优先：两种看法都换成按原色显示的不打光材质', () => {
    const { source, map, original } = textured();
    for (const shading of ['baked', 'albedo'] as const) {
      const material = createModelMaterial(source, { shading, unlit: true }, clipping);
      expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
      expect((material as THREE.MeshBasicMaterial).map).toBe(map);
      expectColor((material as THREE.MeshBasicMaterial).color, original);
    }
    expect(modelMaterialKey(source, { shading: 'albedo', unlit: true })).toBe(
      modelMaterialKey(source, { unlit: true }),
    );
  });

  it('glb 自带的不打光材质、没有贴图的材质不受 shading 影响', () => {
    const unlit = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
    const plain = new THREE.MeshStandardMaterial({ vertexColors: true });
    for (const source of [unlit, plain]) {
      expect(modelMaterialKey(source, undefined)).toBeNull();
      expect(modelMaterialKey(source, { shading: 'albedo' })).toBeNull();
    }
    // 半透明照样派生
    expect(modelMaterialKey(plain, { opacity: 0.5 })).not.toBeNull();
  });

  it('扫描一律按烘焙的看法就地改', () => {
    const { source, map, original } = textured();
    bakeInPlace(source);
    expect(source.emissiveMap).toBe(map);
    expectColor(source.color, original.clone().multiplyScalar(TEXTURE_DIFFUSE));
    // 已经有自发光贴图的不再改
    bakeInPlace(source);
    expectColor(source.color, original.clone().multiplyScalar(TEXTURE_DIFFUSE));
  });
});

it('不打光的形状在贴图加载前后只叠加一次样式色调', async () => {
  const { ctx } = fakeContext();
  const material = createShapeMaterial(
    { texture: COLOR, tint: [220, 180, 140], unlit: true },
    false,
    ctx,
    { tint: [128, 200, 240] },
  ) as THREE.MeshBasicMaterial;
  const expected = srgb([220, 180, 140]).multiply(srgb([128, 200, 240]));
  expectColor(material.color, expected);
  await settle();
  expect(material.map).not.toBeNull();
  expectColor(material.color, expected);
});

it.each(['完成', '失败'] as const)(
  '形状颜色与表面贴图异步`%s`后仍保留样式配方，白模与蓝图始终剥离贴图',
  async (outcome) => {
    const pending: { resolve: (map: THREE.Texture) => void; reject: (error: Error) => void }[] = [];
    const texture = vi.fn(
      () =>
        new Promise<THREE.Texture>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const ctx: MaterialContext = { texture, clipping: [], alive: () => true };
    const look: StyleLook = {
      objectColor: [210, 190, 170],
      tint: [180, 200, 220],
      roughness: 0.31,
      metalness: 0.42,
      wireframe: true,
      opacity: 0.7,
    };
    const source: Material = {
      texture: COLOR,
      tint: [240, 220, 200],
      normalMap: NORMAL,
      roughnessMap: ROUGH,
    };
    const materials = (['albedo', 'baked'] as const).map(
      (shading) =>
        createShapeMaterial({ ...source, shading }, false, ctx, look) as THREE.MeshStandardMaterial,
    );
    const requests = texture.mock.calls.length;
    const stripped = ['maquette', 'blueprint'].map((id) => {
      const style = BUILTIN_SPACE_STYLES.find((item) => item.id === id)!;
      return createShapeMaterial(source, false, ctx, style.look) as THREE.MeshStandardMaterial;
    });
    expect(texture).toHaveBeenCalledTimes(requests);
    const verify = () => {
      for (const material of materials) {
        expectColor(material.color, srgb(look.objectColor!).multiply(srgb(look.tint!)));
        expect(material).toMatchObject({
          roughness: 0.31,
          metalness: 0.42,
          wireframe: true,
          opacity: 0.7,
        });
      }
      for (const material of stripped) {
        expect(material.map).toBeNull();
        if (material instanceof THREE.MeshStandardMaterial) {
          expect([material.emissiveMap, material.normalMap, material.roughnessMap]).toEqual([
            null,
            null,
            null,
          ]);
        }
      }
    };
    verify();
    for (const resource of pending) {
      if (outcome === '完成') resource.resolve(new THREE.Texture());
      else resource.reject(new Error('资源加载失败'));
    }
    await settle();
    verify();
    for (const material of materials) {
      expect(material.map !== null).toBe(outcome === '完成');
      expect(material.normalMap !== null).toBe(outcome === '完成');
      expect(material.roughnessMap !== null).toBe(outcome === '完成');
    }
  },
);

it('模型克隆剥离所有表面贴图且保留共享源材质，其他样式继续显示贴图', () => {
  const map = new THREE.Texture();
  const source = new THREE.MeshPhysicalMaterial({
    map,
    normalMap: map,
    roughnessMap: map,
    metalnessMap: map,
    bumpMap: map,
    displacementMap: map,
    alphaMap: map,
    aoMap: map,
    lightMap: map,
    emissiveMap: map,
    clearcoatMap: map,
    clearcoatNormalMap: map,
    transmissionMap: map,
    sheenColorMap: map,
  });
  const slots = Object.entries(source)
    .filter(([, value]) => value === map)
    .map(([key]) => key);
  for (const id of ['maquette', 'blueprint', 'arch-realistic', 'voxel-blocks', 'extended-full']) {
    const style = BUILTIN_SPACE_STYLES.find((item) => item.id === id)!;
    const derived = createModelMaterial(source, undefined, [], style.look);
    for (const slot of slots) {
      expect(Reflect.get(derived, slot) ?? null).toBe(style.look?.stripTextures ? null : map);
      expect(Reflect.get(source, slot)).toBe(map);
    }
  }
});
