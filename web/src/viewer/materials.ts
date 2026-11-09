import * as THREE from 'three';
import { isTextureMaterial, type Material } from '../core/shapes/types';
import { applyTexturedLook } from './lighting';

/**
 * 形状材质和模型材质的画法（docs/SHAPES.md 第 2 节"着色、法线、粗糙度"，第 3 节 `material.shading`）。
 *
 * - 贴图分用途：颜色贴图（`texture`）是 sRGB，法线贴图、粗糙度贴图是线性数据。同一个资源哈希可能被不同用途
 *   引用，所以贴图按（哈希，用途）各取一份；
 * - 采样一律重复（`RepeatWrapping`）：给了 `tile` 的材质必须重复，不给 `tile` 时网站原来也是重复；
 * - 着色方式 `baked`（默认）：贴图材质 0.3 倍受光 + 0.72 倍自发光（`applyTexturedLook`，与原来相同）；
 *   `albedo`：贴图 × tint 是固有色，标准的金属度—粗糙度材质完整受光，没有自发光；颜色材质两种取值画法一样；
 * - 法线、粗糙度、金属度作用在受光的部分；`unlit: true` 优先，这些都不起作用；
 * - 新字段都不给时与原来完全相同（粗糙度不透明 0.82、半透明 0.1，金属度 0.02）。
 */

/** 贴图的用途。 */
export type TextureRole = 'color' | 'normal' | 'roughness';

/** 不透明形状材质默认的粗糙度。 */
export const DEFAULT_ROUGHNESS = 0.82;
/** 半透明（玻璃）默认的粗糙度。 */
export const GLASS_ROUGHNESS = 0.1;
/** 默认的金属度。 */
export const DEFAULT_METALNESS = 0.02;
/** 旧数据里 `props.glass === true` 的不透明度。 */
export const LEGACY_GLASS_OPACITY = 0.32;

/** sRGB 0–255 → three.js 颜色（线性）。 */
export function srgb(color: readonly number[]): THREE.Color {
  return new THREE.Color().setRGB(
    (color[0] ?? 200) / 255,
    (color[1] ?? 200) / 255,
    (color[2] ?? 200) / 255,
    THREE.SRGBColorSpace,
  );
}

/** 用途对应的颜色空间：颜色贴图 sRGB，其余是线性数据（不做 sRGB 解码）。 */
export function textureColorSpace(role: TextureRole): THREE.ColorSpace {
  return role === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
}

/** 下载好的贴图按用途设好颜色空间、重复采样和各向异性。 */
export function prepareTexture(
  map: THREE.Texture,
  role: TextureRole,
  anisotropy: number,
): THREE.Texture {
  map.colorSpace = textureColorSpace(role);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = anisotropy;
  map.needsUpdate = true;
  return map;
}

/**
 * 贴图缓存：按（用途，哈希）各取一份、各设各的颜色空间（同一个哈希既当颜色贴图又当法线贴图时是两份）；
 * 下载失败的不留在缓存里，下次再取。
 */
export class TextureCache {
  private readonly entries = new Map<string, Promise<THREE.Texture>>();

  constructor(
    private readonly load: (hash: string) => Promise<THREE.Texture>,
    private readonly anisotropy: () => number,
  ) {}

  get(hash: string, role: TextureRole): Promise<THREE.Texture> {
    const key = `${role}|${hash}`;
    let texture = this.entries.get(key);
    if (texture === undefined) {
      texture = this.load(hash).then((map) => prepareTexture(map, role, this.anisotropy()));
      this.entries.set(key, texture);
      texture.catch(() => this.entries.delete(key));
    }
    return texture;
  }

  /** 释放已经下载好的贴图。 */
  dispose(): void {
    for (const texture of this.entries.values()) {
      texture.then((t) => t.dispose()).catch(() => undefined);
    }
    this.entries.clear();
  }
}

export interface MaterialContext {
  /** 剖切平面（所有内容材质共用）。 */
  readonly clipping: THREE.Plane[];
  /** 按（哈希，用途）取贴图；没有加载函数时返回 null。 */
  texture(hash: string, role: TextureRole): Promise<THREE.Texture> | null;
  /** 查看器已经释放：贴图到了也不再改材质。 */
  disposed(): boolean;
}

/** 贴图到了以后改材质；下载失败时调用 `failed`（可选）。 */
function whenLoaded(
  ctx: MaterialContext,
  hash: string,
  role: TextureRole,
  loaded: (map: THREE.Texture) => void,
  failed?: () => void,
): void {
  ctx
    .texture(hash, role)
    ?.then((map) => {
      if (!ctx.disposed()) loaded(map);
    })
    .catch(() => {
      if (!ctx.disposed()) failed?.();
    });
}

/**
 * 形状材质（调用方按材质和"玻璃"缓存，共用一份）。
 *
 * - `opacity < 1`：半透明，不写深度、双面；three.js 把透明的材质组放到不透明物体之后、按远近排序再画，
 *   所以玻璃后面的东西能透出来；旧数据里的 `props.glass === true` 仍按原来的玻璃外观画；
 * - `unlit`：不打光的 MeshBasicMaterial，按颜色或贴图原样显示（不做色调映射），用于屏幕、灯箱；
 * - 其余是 MeshStandardMaterial，着色方式、法线、粗糙度、金属度见本文件开头。
 */
export function createShapeMaterial(
  material: Material,
  glass: boolean,
  ctx: MaterialContext,
): THREE.Material {
  const opacity = glass ? LEGACY_GLASS_OPACITY : Math.min(1, Math.max(0, material.opacity ?? 1));
  const transparent = opacity < 1;
  const side = transparent ? THREE.DoubleSide : THREE.FrontSide;
  if (material.unlit === true && !glass) {
    const basic = new THREE.MeshBasicMaterial({
      transparent,
      opacity,
      depthWrite: !transparent,
      side,
      clippingPlanes: ctx.clipping,
      toneMapped: false,
    });
    if (isTextureMaterial(material)) {
      basic.color = material.tint ? srgb(material.tint) : new THREE.Color(0xffffff);
      whenLoaded(ctx, material.texture, 'color', (map) => {
        basic.map = map;
        basic.needsUpdate = true;
      });
    } else {
      basic.color = srgb(material.color);
    }
    return basic;
  }
  const roughnessMap = material.roughnessMap;
  const base = new THREE.MeshStandardMaterial({
    // 给了粗糙度贴图时 roughness 是乘数，默认 1；没给时默认是原来的值
    roughness:
      material.roughness ??
      (roughnessMap !== undefined ? 1 : transparent ? GLASS_ROUGHNESS : DEFAULT_ROUGHNESS),
    metalness: material.metalness ?? DEFAULT_METALNESS,
    transparent,
    opacity,
    depthWrite: !transparent,
    side,
    clippingPlanes: ctx.clipping,
  });
  if (isTextureMaterial(material)) {
    const tint = material.tint ? srgb(material.tint) : new THREE.Color(0xffffff);
    if (material.shading === 'albedo') {
      // 固有色：贴图 × tint 完整受光，没有自发光。贴图到之前用色调的灰一点的版本占位。
      base.color.copy(tint).multiplyScalar(0.8);
      whenLoaded(
        ctx,
        material.texture,
        'color',
        (map) => {
          base.map = map;
          base.color.copy(tint);
          base.needsUpdate = true;
        },
        () => base.color.copy(tint),
      );
    } else {
      // 扫描烘焙的看法：只有一部分受光照（另一部分按自发光直接显示贴图），亮度接近原始扫描。
      // 贴图到之前先用色调的灰一点的版本占位。
      applyTexturedLook(base, tint.clone().multiplyScalar(0.8), null);
      whenLoaded(
        ctx,
        material.texture,
        'color',
        (map) => applyTexturedLook(base, tint, map),
        () => applyTexturedLook(base, tint, null),
      );
    }
  } else {
    base.color = srgb(material.color);
  }
  if (material.normalMap !== undefined) {
    const scale = material.normalScale ?? 1;
    // 法线贴图按 OpenGL 约定（绿 = 贴图上方 = +v），与 three.js 自己贴图（flipY）的约定相同，不翻 y
    base.normalScale.set(scale, scale);
    whenLoaded(ctx, material.normalMap, 'normal', (map) => {
      base.normalMap = map;
      base.needsUpdate = true;
    });
  }
  if (roughnessMap !== undefined) {
    // three.js 读粗糙度贴图的 G 通道，乘以 roughness，与 SHAPES 2 相同
    whenLoaded(ctx, roughnessMap, 'roughness', (map) => {
      base.roughnessMap = map;
      base.needsUpdate = true;
    });
  }
  return base;
}

/**
 * glb 里受光照、带颜色贴图的材质按扫描烘焙的看法改（0.3 倍受光 + 0.72 倍自发光，原地修改，与原来相同），
 * 返回改之前的副本：物件的 `material.shading` 是 `albedo` 时用它，按 glb 里的材质原样完整受光
 * （模型自带的法线、粗糙度、金属度照常用）。不用改的材质（不打光的、没有颜色贴图的、本来就有自发光贴图的）
 * 返回 null，两种着色方式画法一样。原来的颜色记在 `userData.baseColor`：物件要求不打光时按原色显示。
 */
export function bakeGlbMaterial(
  material: THREE.Material,
  clipping: THREE.Plane[],
): THREE.Material | null {
  if (
    !(material instanceof THREE.MeshStandardMaterial) ||
    material.map === null ||
    material.emissiveMap !== null
  ) {
    return null;
  }
  const albedo = material.clone();
  // clone 会复制一份剖切平面，换回共用的那一份
  albedo.clippingPlanes = clipping;
  material.userData.baseColor = material.color.clone();
  applyTexturedLook(material, material.color.clone(), material.map);
  return albedo;
}
