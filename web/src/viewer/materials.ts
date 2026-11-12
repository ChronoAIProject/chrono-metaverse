import * as THREE from 'three';
import type { EntityBody } from '../core/api/types';
import { shadingLook } from '../core/shapes/look';
import { isTextureMaterial, type Material } from '../core/shapes/types';
import { applyTexturedLook } from './lighting';

/**
 * 形状材质和物件模型材质的画法（docs/SHAPES.md 第 2 节"着色、法线、粗糙度"、第 3 节 `material.shading`）。
 *
 * - 着色方式 `baked`（默认，与以前相同）：贴图材质的贴图 × tint 只有 0.3 倍受光照，另加 0.72 倍自发光
 *   （`applyTexturedLook`），亮度接近不打光的原始扫描；
 * - `albedo`：贴图 × tint 是固有色，标准的金属度—粗糙度材质完整受光，没有自发光；
 * - 颜色材质两种取值画法一样：完整受光（与以前相同）；
 * - 法线贴图、粗糙度贴图、粗糙度、金属度作用在受光照的部分（`albedo` 是全部，`baked` 只有那 0.3 倍）；
 *   切线按贴图坐标在着色时推出（网格不带切线）；
 * - `unlit: true` 优先：不打光，按颜色或贴图原样显示，着色方式、法线、粗糙度都不起作用；
 * - 颜色贴图按 sRGB 解码，法线、粗糙度贴图是线性数据，所以贴图按（哈希，用途）分开设置。
 */

/** 贴图的用途：颜色贴图是 sRGB，法线、粗糙度贴图是线性数据。 */
export type TextureRole = 'color' | 'normal' | 'roughness';

/** 按（哈希，用途）取设置好的贴图；没有加载函数时返回 null。 */
export type TextureLookup = (hash: string, role: TextureRole) => Promise<THREE.Texture> | null;

export interface MaterialContext {
  readonly texture: TextureLookup;
  /** 剖切平面（内容材质共用）。 */
  readonly clipping: THREE.Plane[];
  /** 场景还在时为 true；释放以后到达的贴图不再挂上。 */
  readonly alive: () => boolean;
}

/** sRGB 0–255 的颜色 → three.js 颜色（线性）。 */
export function srgb(color: readonly number[]): THREE.Color {
  return new THREE.Color().setRGB(
    (color[0] ?? 200) / 255,
    (color[1] ?? 200) / 255,
    (color[2] ?? 200) / 255,
    THREE.SRGBColorSpace,
  );
}

/**
 * 按用途设置贴图：颜色贴图 sRGB，法线、粗糙度贴图不做颜色空间转换。一律重复采样：给了 `tile` 的
 * 材质按米重复（SHAPES 2"采样方式"）；没给 `tile` 的网站一直用重复，保持不变。
 */
export function configureTexture(
  texture: THREE.Texture,
  role: TextureRole,
  anisotropy: number,
): THREE.Texture {
  texture.colorSpace = role === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 按（哈希，用途）缓存的贴图：同一个资源只下载、解码一次；颜色贴图直接用下载的那一份（与以前相同），
 * 法线、粗糙度贴图各复制一份再设置（复制的贴图共用同一张图片，只是颜色空间不同）。
 */
export class TextureCache {
  private readonly images = new Map<string, Promise<THREE.Texture>>();
  private readonly textures = new Map<string, Promise<THREE.Texture>>();
  private pending = 0;

  constructor(
    private readonly load: ((hash: string) => Promise<THREE.Texture>) | undefined,
    /** 各向异性过滤的级数（按显卡的上限，用到时才取）。 */
    private readonly anisotropy: () => number,
    private readonly onPending?: (count: number) => void,
  ) {
    onPending?.(0);
  }

  get(hash: string, role: TextureRole): Promise<THREE.Texture> | null {
    const load = this.load;
    if (load === undefined) return null;
    const key = `${role}|${hash}`;
    let texture = this.textures.get(key);
    if (texture === undefined) {
      let image = this.images.get(hash);
      if (image === undefined) {
        this.pending++;
        this.onPending?.(this.pending);
        image = load(hash).finally(() => {
          this.pending--;
          this.onPending?.(this.pending);
        });
        this.images.set(hash, image);
        image.catch(() => this.images.delete(hash));
      }
      texture = image.then((map) =>
        configureTexture(role === 'color' ? map : map.clone(), role, this.anisotropy()),
      );
      this.textures.set(key, texture);
      texture.catch(() => this.textures.delete(key));
    }
    return texture;
  }

  dispose(): void {
    for (const texture of this.textures.values()) {
      texture.then((t) => t.dispose()).catch(() => undefined);
    }
    this.textures.clear();
    this.images.clear();
  }
}

/** 贴图到了挂上去（场景还在时），失败时走 `onError`；没有加载函数时什么都不做（保持占位）。 */
function whenLoaded(
  ctx: MaterialContext,
  hash: string,
  role: TextureRole,
  material: THREE.Material,
  onMap: (map: THREE.Texture) => void,
  onError: () => void = () => undefined,
): void {
  ctx
    .texture(hash, role)
    ?.then((map) => {
      if (!ctx.alive()) return;
      onMap(map);
      material.needsUpdate = true;
    })
    .catch(() => {
      onError();
      material.needsUpdate = true;
    });
}

/** 旧数据的 `props.glass === true`：按原来的玻璃外观画（不透明度 0.32）。 */
const LEGACY_GLASS_OPACITY = 0.32;

/**
 * 形状材质 → three.js 材质（调用方按材质的分组键和"玻璃"缓存，共用一份）。
 *
 * - `opacity < 1`：半透明，不写深度、双面；three.js 把透明的材质组放到不透明物体之后、
 *   按远近排序再画，所以玻璃后面的东西能透出来；
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
      whenLoaded(ctx, material.texture, 'color', basic, (map) => {
        basic.map = map;
      });
    } else {
      basic.color = srgb(material.color);
    }
    return basic;
  }
  const look = shadingLook(material, transparent);
  const standard = new THREE.MeshStandardMaterial({
    roughness: look.roughness,
    metalness: look.metalness,
    transparent,
    opacity,
    depthWrite: !transparent,
    side,
    clippingPlanes: ctx.clipping,
  });
  if (isTextureMaterial(material)) {
    const tint = material.tint ? srgb(material.tint) : new THREE.Color(0xffffff);
    // 贴图到之前先用色调的灰一点的版本占位。
    const placeholder = tint.clone().multiplyScalar(0.8);
    if (look.shading === 'albedo') {
      // 固有色、完整受光：贴图 × tint 就是颜色，没有自发光。
      standard.color.copy(placeholder);
      whenLoaded(
        ctx,
        material.texture,
        'color',
        standard,
        (map) => {
          standard.map = map;
          standard.color.copy(tint);
        },
        () => standard.color.copy(tint),
      );
    } else {
      // 扫描烘焙的看法：只有一部分受光照，另一部分按自发光直接显示贴图，亮度接近原始扫描。
      applyTexturedLook(standard, placeholder, null);
      whenLoaded(
        ctx,
        material.texture,
        'color',
        standard,
        (map) => applyTexturedLook(standard, tint, map),
        () => applyTexturedLook(standard, tint, null),
      );
    }
  } else {
    standard.color = srgb(material.color);
  }
  if (look.normalMap !== null) {
    standard.normalScale.set(look.normalScale, look.normalScale);
    whenLoaded(ctx, look.normalMap, 'normal', standard, (map) => {
      standard.normalMap = map;
    });
  }
  if (look.roughnessMap !== null) {
    whenLoaded(ctx, look.roughnessMap, 'roughness', standard, (map) => {
      standard.roughnessMap = map;
    });
  }
  return standard;
}

/** 物件模型（`assetHash`）整体的外观：`tint`、`opacity`、`unlit`、`shading`。 */
export type ModelLook = EntityBody['material'];

/**
 * glb 里受光照、带颜色贴图、还没有自发光贴图的材质：`baked` 时按扫描烘焙的看法画。
 * glb 自带 `KHR_materials_unlit` 的材质（MeshBasicMaterial）两种取值都不打光，不在此列。
 */
export function isBakeable(material: THREE.Material): material is THREE.MeshStandardMaterial {
  return (
    material instanceof THREE.MeshStandardMaterial &&
    material.map !== null &&
    material.emissiveMap === null
  );
}

/** 扫描（网页用模型）一律按扫描烘焙的看法：受光照的贴图材质就地改成 0.3 受光 + 0.72 自发光。 */
export function bakeInPlace(material: THREE.Material): void {
  if (isBakeable(material)) applyTexturedLook(material, material.color.clone(), material.map);
}

function modelLook(look: ModelLook) {
  return {
    tint: look?.tint ? srgb(look.tint) : null,
    opacity: Math.min(1, Math.max(0, look?.opacity ?? 1)),
    unlit: look?.unlit === true,
    shading: look?.shading === 'albedo' ? ('albedo' as const) : ('baked' as const),
  };
}

/**
 * 物件模型里一份材质按物件外观派生时的缓存键；不用派生（原样用模型里的材质）时返回 null：
 * `albedo` 且没有 tint、opacity、unlit，或者这份材质本来就不受 `baked` 影响。
 */
export function modelMaterialKey(source: THREE.Material, look: ModelLook): string | null {
  const { tint, opacity, unlit, shading } = modelLook(look);
  const bake = !unlit && shading === 'baked' && isBakeable(source);
  if (!bake && tint === null && opacity === 1 && !unlit) return null;
  return `model|${source.uuid}|${bake ? 'baked' : 'albedo'}|${tint?.getHexString() ?? ''}|${opacity}|${unlit}`;
}

/**
 * 物件模型的材质按物件的外观派生（不改模型里的原材质）：`baked` 时受光照的贴图材质按扫描烘焙的看法画；
 * 颜色和自发光乘上 tint；opacity 叠到原来的透明度上；unlit 换成不打光的材质（按模型原来的颜色和贴图）。
 */
export function createModelMaterial(
  source: THREE.Material,
  look: ModelLook,
  clipping: THREE.Plane[],
): THREE.Material {
  const { tint, opacity: lookOpacity, unlit, shading } = modelLook(look);
  const opacity = lookOpacity * source.opacity;
  const transparent = source.transparent || opacity < 1;
  if (unlit) {
    const colored = source as THREE.MeshStandardMaterial;
    const basic = new THREE.MeshBasicMaterial({
      map: colored.map ?? null,
      color: colored.color?.clone() ?? new THREE.Color(0xffffff),
      side: source.side,
      transparent,
      opacity,
      depthWrite: !transparent,
      clippingPlanes: clipping,
      toneMapped: false,
    });
    if (tint) basic.color.multiply(tint);
    return basic;
  }
  const copy = source.clone() as THREE.MeshStandardMaterial;
  if (shading === 'baked') bakeInPlace(copy);
  if (tint && copy.color instanceof THREE.Color) copy.color.multiply(tint);
  if (tint && copy.emissive instanceof THREE.Color) copy.emissive.multiply(tint);
  copy.transparent = transparent;
  copy.opacity = opacity;
  if (opacity < 1) copy.depthWrite = false;
  // clone() 会把剖切平面复制一份，换回共用的那一个。
  copy.clippingPlanes = clipping;
  return copy;
}
