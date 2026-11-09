/**
 * 形状词表（docs/SHAPES.md 第 2 节）的 TypeScript 类型。
 *
 * 单位米，y 轴向上，右手坐标系；角度用度。字段名与 JSON 完全一致，
 * 接口服务（Rust）和处理服务（Python）输出的就是这套 JSON。
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Rgb = readonly [number, number, number];

export interface Transform {
  readonly position?: Vec3;
  /** 绕 y 轴，度。 */
  readonly yaw?: number;
  /** 绕 x 轴，度。 */
  readonly pitch?: number;
  /** 绕 z 轴，度。 */
  readonly roll?: number;
  readonly scale?: Vec3;
}

export type UvMode = 'box' | 'planar' | 'cylindrical' | 'mesh';

/** 两种材质都可以带的外观选项（docs/SHAPES.md 第 2 节）。 */
export interface MaterialLook {
  /** 不透明度 0–1，默认 1；小于 1 时半透明（玻璃）。 */
  readonly opacity?: number;
  /** 不受光照，按颜色或贴图原样显示（屏幕、灯箱），默认 false。 */
  readonly unlit?: boolean;
}

export interface ColorMaterial extends MaterialLook {
  /** sRGB 0–255。 */
  readonly color: Rgb;
}

export interface TextureMaterial extends MaterialLook {
  /** 资源哈希（`/api/public/assets/{hash}.bin`）。 */
  readonly texture: string;
  readonly uv?: UvMode;
  readonly tint?: Rgb;
}

export type Material = ColorMaterial | TextureMaterial;

export interface ArcSpec {
  /** 把第 from 点到第 from+1 点之间的直线换成圆弧。 */
  readonly from: number;
  /** tan(圆心角 / 4)：正值向外凸，负值向内凹。 */
  readonly bulge: number;
}

export interface FilletSpec {
  /** 在第 at 个顶点处倒圆角。 */
  readonly at: number;
  readonly radius: number;
}

/** 二维轮廓，坐标是 [x, z]。 */
export interface Outline {
  readonly points: readonly Vec2[];
  readonly closed?: boolean;
  readonly arcs?: readonly ArcSpec[];
  readonly fillets?: readonly FilletSpec[];
}

interface ShapeBase {
  readonly transform?: Transform;
  readonly material?: Material;
}

export interface BoxShape extends ShapeBase {
  readonly type: 'box';
  readonly size: Vec3;
  readonly fillet?: number;
  readonly chamfer?: number;
  /** 圆角分段，默认 4。 */
  readonly segments?: number;
}

export interface CylinderShape extends ShapeBase {
  readonly type: 'cylinder';
  readonly radius: number;
  readonly height: number;
  /** 不给就是圆柱，给了就是圆台。 */
  readonly radiusTop?: number;
  /** 默认 32。 */
  readonly segments?: number;
  /** 上下边缘圆角。 */
  readonly fillet?: number;
}

export interface ConeShape extends ShapeBase {
  readonly type: 'cone';
  readonly radius: number;
  readonly height: number;
  readonly segments?: number;
}

export interface ExtrudeShape extends ShapeBase {
  readonly type: 'extrude';
  readonly outline: Outline;
  readonly height: number;
  /** 顶面和底面边缘的圆角。 */
  readonly fillet?: number;
  /** 顶面和底面边缘的倒角。 */
  readonly chamfer?: number;
}

export interface LatheShape extends ShapeBase {
  readonly type: 'lathe';
  /** [[r, y], ...]，r ≥ 0。 */
  readonly profile: readonly Vec2[];
  /** 默认 32。 */
  readonly segments?: number;
  /** 默认 360。 */
  readonly angle?: number;
}

export type SweepSection = { readonly circle: number } | { readonly rect: Vec2 };

export interface SweepShape extends ShapeBase {
  readonly type: 'sweep';
  readonly path: readonly Vec3[];
  readonly section: SweepSection;
  /** 拐角圆滑半径。 */
  readonly smooth?: number;
  /** 两端封口，默认 true。 */
  readonly caps?: boolean;
  /** 圆截面的分段数（词表之外的可选项），默认 16。 */
  readonly segments?: number;
}

export interface LoftSection {
  readonly y: number;
  readonly outline: Outline;
}

export interface LoftShape extends ShapeBase {
  readonly type: 'loft';
  /** 2 到 8 个截面，y 递增。 */
  readonly sections: readonly LoftSection[];
}

/**
 * 板：平面简单多边形（3 到 64 个点，局部坐标）沿 −法向 加厚 `thickness`。
 * 点按右手定则给出法向（从法向一侧看是逆时针）。用于前台这类斜面折板。
 */
export interface PlateShape extends ShapeBase {
  readonly type: 'plate';
  readonly points: readonly Vec3[];
  /** 0 < t ≤ 1（米）。 */
  readonly thickness: number;
}

/** 凸包：这些点（4 到 256 个）的凸包实体，用于楔形、船头这类凸多面体。 */
export interface HullShape extends ShapeBase {
  readonly type: 'hull';
  readonly points: readonly Vec3[];
}

export interface GroupShape extends ShapeBase {
  readonly type: 'group';
  readonly children: readonly Shape[];
}

export interface InstanceShape extends ShapeBase {
  readonly type: 'instance';
  readonly template: string;
}

export type Shape =
  | BoxShape
  | CylinderShape
  | ConeShape
  | ExtrudeShape
  | LatheShape
  | SweepShape
  | LoftShape
  | PlateShape
  | HullShape
  | GroupShape
  | InstanceShape;

export type ShapeType = Shape['type'];

export const SHAPE_TYPES: readonly ShapeType[] = [
  'box',
  'cylinder',
  'cone',
  'extrude',
  'lathe',
  'sweep',
  'loft',
  'plate',
  'hull',
  'group',
  'instance',
];

/** 模板表：模板编号 → 形状。 */
export type TemplateTable = Readonly<Record<string, Shape>>;

export function isTextureMaterial(material: Material): material is TextureMaterial {
  return 'texture' in material;
}
