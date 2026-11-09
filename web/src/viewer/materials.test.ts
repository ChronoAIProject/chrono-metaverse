import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Material } from '../core/shapes/types';
import { TEXTURE_DIFFUSE, TEXTURE_EMISSIVE } from './lighting';
import {
  DEFAULT_METALNESS,
  DEFAULT_ROUGHNESS,
  GLASS_ROUGHNESS,
  TextureCache,
  bakeGlbMaterial,
  createShapeMaterial,
  prepareTexture,
  srgb,
  textureColorSpace,
  type MaterialContext,
  type TextureRole,
} from './materials';

const COLOR_MAP = 'aa'.repeat(32);
const NORMAL_MAP = 'bb'.repeat(32);
const ROUGH_MAP = 'cc'.repeat(32);

/** 记下取了哪些（哈希，用途）；贴图立刻到，或者下载失败。 */
function context(options: { fail?: boolean; disposed?: boolean; noLoader?: boolean } = {}) {
  const requests: [string, TextureRole][] = [];
  const textures = new Map<string, THREE.Texture>();
  const clipping = [new THREE.Plane()];
  const ctx: MaterialContext = {
    clipping,
    texture(hash, role) {
      if (options.noLoader) return null;
      requests.push([hash, role]);
      if (options.fail) return Promise.reject(new Error('下载失败'));
      const texture = new THREE.Texture();
      texture.name = `${role}:${hash}`;
      textures.set(`${role}|${hash}`, texture);
      return Promise.resolve(texture);
    },
    disposed: () => options.disposed === true,
  };
  return { ctx, requests, textures, clipping };
}

/** 等贴图的 then / catch 都跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function hex(color: THREE.Color): string {
  return color.getHexString();
}

describe('形状材质：旧数据画法不变', () => {
  it('颜色材质：完整受光，粗糙度 0.82、金属度 0.02，没有法线、粗糙度贴图', async () => {
    const { ctx, requests } = context();
    const material = createShapeMaterial({ color: [200, 100, 50] }, false, ctx);
    await settle();
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    const standard = material as THREE.MeshStandardMaterial;
    expect(standard.roughness).toBe(DEFAULT_ROUGHNESS);
    expect(standard.metalness).toBe(DEFAULT_METALNESS);
    expect(hex(standard.color)).toBe(hex(srgb([200, 100, 50])));
    expect(standard.normalMap).toBeNull();
    expect(standard.roughnessMap).toBeNull();
    expect(standard.emissiveMap).toBeNull();
    expect(standard.clippingPlanes).toBe(ctx.clipping);
    expect(requests).toEqual([]);
  });

  it('贴图材质（默认 baked）：0.3 倍受光 + 0.72 倍自发光，颜色贴图按 sRGB 用途取', async () => {
    const { ctx, requests, textures } = context();
    const material = createShapeMaterial(
      { texture: COLOR_MAP, uv: 'box', tint: [255, 128, 64] },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    // 贴图到之前：色调的 0.8 倍占位
    const tint = srgb([255, 128, 64]);
    expect(hex(material.color)).toBe(hex(tint.clone().multiplyScalar(0.8 * TEXTURE_DIFFUSE)));
    await settle();
    expect(requests).toEqual([[COLOR_MAP, 'color']]);
    const map = textures.get(`color|${COLOR_MAP}`);
    expect(material.map).toBe(map);
    expect(material.emissiveMap).toBe(map);
    expect(hex(material.color)).toBe(hex(tint.clone().multiplyScalar(TEXTURE_DIFFUSE)));
    expect(hex(material.emissive)).toBe(hex(tint.clone().multiplyScalar(TEXTURE_EMISSIVE)));
    expect(material.roughness).toBe(DEFAULT_ROUGHNESS);
    expect(material.metalness).toBe(DEFAULT_METALNESS);
    expect(material.normalMap).toBeNull();
  });

  it('显式写 shading: "baked" 与不写相同', async () => {
    const plain = context();
    const explicit = context();
    const a = createShapeMaterial({ texture: COLOR_MAP }, false, plain.ctx);
    const b = createShapeMaterial({ texture: COLOR_MAP, shading: 'baked' }, false, explicit.ctx);
    await settle();
    const pick = (m: THREE.Material) => {
      const s = m as THREE.MeshStandardMaterial;
      return [hex(s.color), hex(s.emissive), s.roughness, s.metalness, s.map?.name];
    };
    expect(pick(b)).toEqual(pick(a));
  });

  it('半透明与旧的玻璃：粗糙度 0.1、双面、不写深度', () => {
    const { ctx } = context();
    const glass = createShapeMaterial({ color: [200, 220, 230] }, true, ctx);
    expect(glass.opacity).toBe(0.32);
    expect((glass as THREE.MeshStandardMaterial).roughness).toBe(GLASS_ROUGHNESS);
    const clear = createShapeMaterial({ color: [200, 220, 230], opacity: 0.4 }, false, ctx);
    expect(clear.transparent).toBe(true);
    expect(clear.depthWrite).toBe(false);
    expect(clear.side).toBe(THREE.DoubleSide);
    expect((clear as THREE.MeshStandardMaterial).roughness).toBe(GLASS_ROUGHNESS);
  });

  it('贴图下载失败：baked 用纯色调，亮度与有贴图时一致', async () => {
    const { ctx } = context({ fail: true });
    const material = createShapeMaterial(
      { texture: COLOR_MAP, tint: [100, 150, 200] },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expect(material.map).toBeNull();
    const tint = srgb([100, 150, 200]);
    expect(hex(material.color)).toBe(hex(tint.clone().multiplyScalar(TEXTURE_DIFFUSE)));
    expect(hex(material.emissive)).toBe(hex(tint.clone().multiplyScalar(TEXTURE_EMISSIVE)));
  });
});

describe('形状材质：着色方式、法线、粗糙度', () => {
  it('albedo 的贴图材质：贴图 × tint 是固有色，完整受光，没有自发光', async () => {
    const { ctx, textures } = context();
    const material = createShapeMaterial(
      { texture: COLOR_MAP, uv: 'box', tint: [240, 220, 200], shading: 'albedo' },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    const tint = srgb([240, 220, 200]);
    // 贴图到之前：色调的 0.8 倍占位，同样没有自发光
    expect(hex(material.color)).toBe(hex(tint.clone().multiplyScalar(0.8)));
    await settle();
    expect(material.map).toBe(textures.get(`color|${COLOR_MAP}`));
    expect(material.emissiveMap).toBeNull();
    expect(hex(material.emissive)).toBe('000000');
    expect(hex(material.color)).toBe(hex(tint));
  });

  it('albedo 的贴图下载失败：按色调完整受光', async () => {
    const { ctx } = context({ fail: true });
    const material = createShapeMaterial(
      { texture: COLOR_MAP, shading: 'albedo' },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expect(material.map).toBeNull();
    expect(hex(material.color)).toBe('ffffff');
    expect(hex(material.emissive)).toBe('000000');
  });

  it('法线贴图按线性用途取，强度写进 normalScale（x、y 同号，不翻绿色通道）', async () => {
    const { ctx, requests, textures } = context();
    const material = createShapeMaterial(
      {
        texture: COLOR_MAP,
        uv: 'box',
        tile: [0.6, 0.6],
        shading: 'albedo',
        normalMap: NORMAL_MAP,
        normalScale: 0.7,
      },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expect(requests).toEqual([
      [COLOR_MAP, 'color'],
      [NORMAL_MAP, 'normal'],
    ]);
    expect(material.normalMap).toBe(textures.get(`normal|${NORMAL_MAP}`));
    expect(material.normalScale.toArray()).toEqual([0.7, 0.7]);
    // 不给 normalScale 时是 1
    const plain = createShapeMaterial(
      { texture: COLOR_MAP, normalMap: NORMAL_MAP },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    expect(plain.normalScale.toArray()).toEqual([1, 1]);
  });

  it('粗糙度贴图：roughness 是乘数、默认 1；只给标量时直接用；金属度只有标量', async () => {
    const { ctx, requests } = context();
    const withMap = createShapeMaterial(
      { texture: COLOR_MAP, shading: 'albedo', roughnessMap: ROUGH_MAP },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    expect(withMap.roughness).toBe(1);
    const scaled = createShapeMaterial(
      { texture: COLOR_MAP, roughnessMap: ROUGH_MAP, roughness: 0.6, metalness: 0.3 },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    expect(scaled.roughness).toBe(0.6);
    expect(scaled.metalness).toBe(0.3);
    const scalar = createShapeMaterial(
      { color: [90, 90, 90], roughness: 0.55, metalness: 1 },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    expect(scalar.roughness).toBe(0.55);
    expect(scalar.metalness).toBe(1);
    await settle();
    expect(requests.filter(([, role]) => role === 'roughness')).toEqual([
      [ROUGH_MAP, 'roughness'],
      [ROUGH_MAP, 'roughness'],
    ]);
    expect(withMap.roughnessMap?.name).toBe(`roughness:${ROUGH_MAP}`);
    expect(scaled.roughnessMap?.name).toBe(`roughness:${ROUGH_MAP}`);
  });

  it('颜色材质带法线、粗糙度贴图：颜色照旧完整受光，贴图加在上面；两种着色方式画法一样', async () => {
    const { ctx, requests } = context();
    const look: Material = {
      color: [180, 170, 160],
      uv: 'box',
      tile: [0.3, 0.3],
      normalMap: NORMAL_MAP,
      roughnessMap: ROUGH_MAP,
    };
    const baked = createShapeMaterial(look, false, ctx) as THREE.MeshStandardMaterial;
    const albedo = createShapeMaterial(
      { ...look, shading: 'albedo' },
      false,
      ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    for (const material of [baked, albedo]) {
      expect(hex(material.color)).toBe(hex(srgb([180, 170, 160])));
      expect(material.map).toBeNull();
      expect(material.emissiveMap).toBeNull();
      expect(material.normalMap?.name).toBe(`normal:${NORMAL_MAP}`);
      expect(material.roughnessMap?.name).toBe(`roughness:${ROUGH_MAP}`);
    }
    expect(requests.every(([, role]) => role !== 'color')).toBe(true);
  });

  it('unlit 优先：不打光，着色方式、法线、粗糙度、金属度都不起作用', async () => {
    const { ctx, requests } = context();
    const material = createShapeMaterial(
      {
        texture: COLOR_MAP,
        tint: [255, 255, 255],
        unlit: true,
        shading: 'albedo',
        normalMap: NORMAL_MAP,
        roughnessMap: ROUGH_MAP,
        metalness: 1,
      },
      false,
      ctx,
    );
    await settle();
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(material.toneMapped).toBe(false);
    expect((material as THREE.MeshBasicMaterial).map?.name).toBe(`color:${COLOR_MAP}`);
    expect(requests).toEqual([[COLOR_MAP, 'color']]);
  });

  it('查看器释放以后贴图到了也不改材质；没有加载函数时保留占位', async () => {
    const gone = context({ disposed: true });
    const material = createShapeMaterial(
      { texture: COLOR_MAP, shading: 'albedo', normalMap: NORMAL_MAP },
      false,
      gone.ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expect(material.map).toBeNull();
    expect(material.normalMap).toBeNull();
    const none = context({ noLoader: true });
    const placeholder = createShapeMaterial(
      { texture: COLOR_MAP, shading: 'albedo' },
      false,
      none.ctx,
    ) as THREE.MeshStandardMaterial;
    await settle();
    expect(hex(placeholder.color)).toBe(hex(new THREE.Color(0xffffff).multiplyScalar(0.8)));
  });
});

describe('贴图的用途和缓存', () => {
  it('颜色贴图是 sRGB，法线、粗糙度贴图是线性数据；一律重复采样', () => {
    expect(textureColorSpace('color')).toBe(THREE.SRGBColorSpace);
    expect(textureColorSpace('normal')).toBe(THREE.NoColorSpace);
    expect(textureColorSpace('roughness')).toBe(THREE.NoColorSpace);
    for (const role of ['color', 'normal', 'roughness'] as const) {
      const map = prepareTexture(new THREE.Texture(), role, 4);
      expect(map.colorSpace).toBe(textureColorSpace(role));
      expect(map.wrapS).toBe(THREE.RepeatWrapping);
      expect(map.wrapT).toBe(THREE.RepeatWrapping);
      expect(map.anisotropy).toBe(4);
    }
  });

  it('同一个哈希按用途各取一份、各设各的颜色空间；同一用途只下载一次', async () => {
    const load = vi.fn(async () => new THREE.Texture());
    const cache = new TextureCache(load, () => 8);
    const [color, normal, again] = await Promise.all([
      cache.get(COLOR_MAP, 'color'),
      cache.get(COLOR_MAP, 'normal'),
      cache.get(COLOR_MAP, 'color'),
    ]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(color).toBe(again);
    expect(color).not.toBe(normal);
    expect(color.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(normal.colorSpace).toBe(THREE.NoColorSpace);
    const dispose = vi.spyOn(color, 'dispose');
    cache.dispose();
    await settle();
    expect(dispose).toHaveBeenCalled();
  });

  it('下载失败的不留在缓存里，下次重新下载', async () => {
    let attempts = 0;
    const cache = new TextureCache(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('网络错误');
        return new THREE.Texture();
      },
      () => 1,
    );
    await expect(cache.get(NORMAL_MAP, 'normal')).rejects.toThrow('网络错误');
    await settle();
    await expect(cache.get(NORMAL_MAP, 'normal')).resolves.toBeInstanceOf(THREE.Texture);
    expect(attempts).toBe(2);
  });
});

describe('模型材质：着色方式', () => {
  it('带颜色贴图、受光照的材质改成扫描烘焙的看法，返回改之前的副本（albedo 用）', () => {
    const clipping = [new THREE.Plane()];
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      color: 0x808080,
      roughness: 0.6,
      metalness: 0.1,
    });
    material.clippingPlanes = clipping;
    const original = material.color.clone();
    const albedo = bakeGlbMaterial(material, clipping) as THREE.MeshStandardMaterial;
    // 原地改成 0.3 受光 + 0.72 自发光（与原来相同），原色记在 userData
    expect(material.emissiveMap).toBe(map);
    expect(hex(material.color)).toBe(hex(original.clone().multiplyScalar(TEXTURE_DIFFUSE)));
    expect(hex(material.emissive)).toBe(hex(original.clone().multiplyScalar(TEXTURE_EMISSIVE)));
    expect((material.userData.baseColor as THREE.Color).equals(original)).toBe(true);
    // 副本是 glb 原样的材质：同一张贴图，没有自发光，法线、粗糙度、金属度照常
    expect(albedo).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(albedo).not.toBe(material);
    expect(albedo.map).toBe(map);
    expect(albedo.normalMap).toBe(normalMap);
    expect(albedo.emissiveMap).toBeNull();
    expect(hex(albedo.emissive)).toBe('000000');
    expect(albedo.color.equals(original)).toBe(true);
    expect(albedo.roughness).toBe(0.6);
    expect(albedo.metalness).toBe(0.1);
    // 剖切平面用共用的那一份（clone 会复制一份新的）
    expect(albedo.clippingPlanes).toBe(clipping);
    // 改过一次以后不再改（几个网格共用一个材质时）
    expect(bakeGlbMaterial(material, clipping)).toBeNull();
  });

  it('不打光的、没有颜色贴图的、本来有自发光贴图的材质不改，两种着色方式一样', () => {
    const clipping = [new THREE.Plane()];
    const unlit = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
    const plain = new THREE.MeshStandardMaterial({ color: 0x336699 });
    const glowing = new THREE.MeshStandardMaterial({
      map: new THREE.Texture(),
      emissiveMap: new THREE.Texture(),
    });
    for (const material of [unlit, plain, glowing]) {
      const before = (material as THREE.MeshStandardMaterial).color.getHex();
      expect(bakeGlbMaterial(material, clipping)).toBeNull();
      expect((material as THREE.MeshStandardMaterial).color.getHex()).toBe(before);
    }
  });
});
