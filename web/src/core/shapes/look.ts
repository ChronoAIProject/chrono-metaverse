import type { Material, Shading } from './types';

/**
 * 形状材质的着色参数（docs/SHAPES.md 第 2 节"着色、法线、粗糙度"），按规格补上默认值。
 *
 * 网站只管画：接口服务、命令行、本地工具写入时已经按同一套规则拒绝了不合法的材质，这里不报错，
 * 取值不合法的字段（类型不对、超出范围、哈希不是 64 位小写十六进制）按没给处理，保证坏数据也画得出来。
 * 新字段都不给时得到的就是以前的画法：`baked`、不透明粗糙度 0.82、半透明 0.1、金属度 0.02。
 */

/** 不透明材质没给 `roughness`、也没给粗糙度贴图时的粗糙度（网站一直用的值）。 */
export const DEFAULT_ROUGHNESS = 0.82;
/** 半透明材质（玻璃）没给 `roughness`、也没给粗糙度贴图时的粗糙度。 */
export const TRANSPARENT_ROUGHNESS = 0.1;
/** 没给 `metalness` 时的金属度。 */
export const DEFAULT_METALNESS = 0.02;

export interface ShadingLook {
  /** `baked`：扫描烘焙贴图的看法（贴图材质 0.3 受光 + 0.72 自发光）；`albedo`：固有色、完整受光。 */
  readonly shading: Shading;
  /** 法线贴图的资源哈希；没有时为 null。 */
  readonly normalMap: string | null;
  /** 法线贴图的强度，同时乘到 x、y 两个分量上。 */
  readonly normalScale: number;
  /** 粗糙度贴图的资源哈希（读 G 通道，白 = 粗糙）；没有时为 null。 */
  readonly roughnessMap: string | null;
  /** 粗糙度；有贴图时是乘数。 */
  readonly roughness: number;
  readonly metalness: number;
}

const HASH = /^[0-9a-f]{64}$/;

/** 64 位小写十六进制的资源哈希。 */
export function isAssetHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

function within(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * 材质的着色参数。`transparent` 是这份材质最终画不画成半透明（`opacity < 1`，或旧数据的
 * `props.glass`），只影响没给 `roughness`、也没给粗糙度贴图时的默认粗糙度。
 */
export function shadingLook(material: Material, transparent: boolean): ShadingLook {
  const normalMap = isAssetHash(material.normalMap) ? material.normalMap : null;
  const roughnessMap = isAssetHash(material.roughnessMap) ? material.roughnessMap : null;
  const fallbackRoughness =
    roughnessMap !== null ? 1 : transparent ? TRANSPARENT_ROUGHNESS : DEFAULT_ROUGHNESS;
  return {
    shading: material.shading === 'albedo' ? 'albedo' : 'baked',
    normalMap,
    normalScale:
      normalMap !== null && within(material.normalScale, 0, 4) ? material.normalScale : 1,
    roughnessMap,
    roughness: within(material.roughness, 0, 1) ? material.roughness : fallbackRoughness,
    metalness: within(material.metalness, 0, 1) ? material.metalness : DEFAULT_METALNESS,
  };
}
