import type { Vec3 } from '../core/grid.js';
import {
  signedArea,
  validateShape,
  type BoxShape,
  type ConeShape,
  type CylinderShape,
  type ExtrudeShape,
  type GroupShape,
  type HullShape,
  type InstanceShape,
  type LatheShape,
  type LoftSection,
  type LoftShape,
  type Material,
  type Outline,
  type OutlineArc,
  type OutlineFillet,
  type PlateShape,
  type Rgb,
  type Shading,
  type Shape,
  type SweepSection,
  type SweepShape,
  type Transform,
  type UvMode,
  type Vec2,
} from '../core/shape.js';

/**
 * 形状构造函数（docs/SHAPES.md 第 2 节）。每个函数返回一个普通的形状 JSON 对象，
 * 构造时就按服务端的规则校验，写错了立刻报错（带 JSON 路径）。
 *
 * 局部原点：box、cylinder、cone、extrude、lathe、loft 都在**底面中心**，向 +y 延伸；
 * sweep 的原点就是路径坐标系的原点；plate、hull 直接用点的局部坐标。单位米，角度用度。
 */

/** 颜色：`[r, g, b]`（0–255）或 `'#rrggbb'`。 */
export type ColorInput = Rgb | string;

/**
 * 材质的外观选项，都要和 `color` 或 `texture` 一起给。平铺、着色、法线、粗糙度见 docs/SHAPES.md 第 2 节
 * "贴图坐标的平铺、着色、法线与粗糙度"；都不给时与旧数据完全相同。
 */
export interface MaterialOptions {
  /** 不透明度 0–1（小于 1 时半透明，用于玻璃）。 */
  readonly opacity?: number;
  /** 不受光照（屏幕、灯箱）；为真时着色方式、法线、粗糙度、金属度都不起作用。 */
  readonly unlit?: boolean;
  /**
   * 着色方式：`'baked'`（默认）是扫描烘焙贴图的看法（贴图里已经带了光照）；`'albedo'` 是固有色、完整受光，
   * 材质库、模型库的贴图用它。颜色材质两种取值画法一样。
   */
  readonly shading?: Shading;
  /**
   * 贴图在表面上每重复一次的实际尺寸（米，0 < x ≤ 100）：一个数是正方形，`[u, v]` 分开给。给了就按米算
   * 贴图坐标、重复平铺；只用于有贴图坐标的材质（`texture`，或带 `normalMap` / `roughnessMap` 的 `color`）。
   */
  readonly tile?: number | Vec2;
  /** 贴图坐标的平移 `[u, v]`（米，绝对值 ≤ 1000）；只能和 `tile` 一起给。 */
  readonly offset?: Vec2;
  /** 贴图在表面上逆时针转的角度（度，−360 到 360）；只能和 `tile` 一起给。 */
  readonly rotate?: number;
  /** 法线贴图的资源哈希（切线空间，OpenGL 约定，绿色朝 +v，与 glTF 相同）。 */
  readonly normalMap?: string;
  /** 法线贴图的强度 0–4，默认 1；只能和 `normalMap` 一起给。 */
  readonly normalScale?: number;
  /** 粗糙度贴图的资源哈希（灰度，白 = 粗糙）。 */
  readonly roughnessMap?: string;
  /** 粗糙度 0–1；和 `roughnessMap` 一起给时是乘数。网站没有环境贴图，不透明面不要低于 0.5。 */
  readonly roughness?: number;
  /** 金属度 0–1（只有标量）。 */
  readonly metalness?: number;
  /**
   * 颜色材质带 `normalMap` 或 `roughnessMap` 时的贴图坐标方式（这时必须给）；贴图材质写在 `texture.uv` 里。
   */
  readonly uv?: UvMode;
}

/** 所有形状共用的选项：位置、旋转、缩放和材质。 */
export interface ShapeOptions extends MaterialOptions {
  /** 位置（米）：局部原点放到哪里。 */
  readonly at?: Vec3;
  /** 绕 y 轴旋转（度）。 */
  readonly yaw?: number;
  /** 绕 x 轴旋转（度）。 */
  readonly pitch?: number;
  /** 绕 z 轴旋转（度）。 */
  readonly roll?: number;
  readonly scale?: Vec3;
  /** 纯色材质。 */
  readonly color?: ColorInput;
  /** 贴图材质：资源哈希 + 贴图坐标方式。 */
  readonly texture?: { readonly hash: string; readonly uv: UvMode; readonly tint?: ColorInput };
}

/** `'#rrggbb'` 或 `[r, g, b]` → `[r, g, b]`。 */
export function rgb(color: ColorInput): Rgb {
  if (typeof color !== 'string') return color;
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (match === null) throw new Error(`颜色格式不对：${color}（用 #rrggbb 或 [r, g, b]）`);
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}

function transformOf(options: ShapeOptions): Transform | undefined {
  const transform: { -readonly [K in keyof Transform]: Transform[K] } = {};
  if (options.at !== undefined) transform.position = options.at;
  if (options.yaw !== undefined && options.yaw !== 0) transform.yaw = options.yaw;
  if (options.pitch !== undefined && options.pitch !== 0) transform.pitch = options.pitch;
  if (options.roll !== undefined && options.roll !== 0) transform.roll = options.roll;
  if (options.scale !== undefined) transform.scale = options.scale;
  return Object.keys(transform).length === 0 ? undefined : transform;
}

/** 材质 JSON 里外观字段的顺序（与 SHAPES 的表格相同）。 */
const LOOK_FIELDS = [
  'opacity',
  'unlit',
  'shading',
  'tile',
  'offset',
  'rotate',
  'normalMap',
  'normalScale',
  'roughnessMap',
  'roughness',
  'metalness',
] as const;

function materialOf(options: ShapeOptions): Material | undefined {
  if (options.color !== undefined && options.texture !== undefined) {
    throw new Error('color 和 texture 只能给一个');
  }
  const look: Record<string, unknown> = {};
  for (const key of LOOK_FIELDS) {
    const value = options[key];
    if (value === undefined) continue;
    look[key] = key === 'tile' && typeof value === 'number' ? [value, value] : value;
  }
  if (options.color !== undefined) {
    return {
      color: rgb(options.color),
      ...(options.uv !== undefined ? { uv: options.uv } : {}),
      ...look,
    } as Material;
  }
  if (options.texture !== undefined) {
    if (options.uv !== undefined) throw new Error('贴图材质的 uv 写在 texture.uv 里');
    return {
      texture: options.texture.hash,
      uv: options.texture.uv,
      ...(options.texture.tint !== undefined ? { tint: rgb(options.texture.tint) } : {}),
      ...look,
    } as Material;
  }
  const stray = [...Object.keys(look), ...(options.uv !== undefined ? ['uv'] : [])];
  if (stray.length > 0)
    throw new Error(`材质选项 ${stray.join('、')} 要和 color 或 texture 一起给`);
  return undefined;
}

function finish<T extends Shape>(
  fields: Record<string, unknown>,
  options: ShapeOptions,
  keepMaterial?: Material,
): T {
  const shape: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) shape[key] = value;
  const transform = transformOf(options);
  const material = materialOf(options) ?? keepMaterial;
  if (transform !== undefined) shape.transform = transform;
  if (material !== undefined) shape.material = material;
  validateShape(shape);
  return shape as unknown as T;
}

/**
 * 给已有的形状换一组变换（替换原来的 transform）；给了 color / texture 时也替换材质，
 * 否则保留原来的材质。
 */
export function withOptions<T extends Shape>(shape: T, options: ShapeOptions): T {
  const fields: Record<string, unknown> = { ...shape };
  delete fields.transform;
  delete fields.material;
  return finish<T>(fields, options, shape.material);
}

/**
 * 长方体（家具板件、墙、台面）。`size = [宽 x, 高 y, 深 z]`；`fillet` 圆角半径、`chamfer` 倒角
 * （都会被限制到不超过最短边的一半；同时给时以 fillet 为准）。
 */
export function box(
  size: Vec3,
  options: ShapeOptions & { fillet?: number; chamfer?: number; segments?: number } = {},
): BoxShape {
  return finish<BoxShape>(
    {
      type: 'box',
      size,
      fillet: options.fillet,
      chamfer: options.chamfer,
      segments: options.segments,
    },
    options,
  );
}

/** 圆柱；给了 `radiusTop` 就是圆台。`fillet` 是上下边缘的圆角。 */
export function cylinder(
  radius: number,
  height: number,
  options: ShapeOptions & { radiusTop?: number; segments?: number; fillet?: number } = {},
): CylinderShape {
  return finish<CylinderShape>(
    {
      type: 'cylinder',
      radius,
      height,
      radiusTop: options.radiusTop,
      segments: options.segments,
      fillet: options.fillet,
    },
    options,
  );
}

/** 圆锥。 */
export function cone(
  radius: number,
  height: number,
  options: ShapeOptions & { segments?: number } = {},
): ConeShape {
  return finish<ConeShape>({ type: 'cone', radius, height, segments: options.segments }, options);
}

/** 二维轮廓的输入：轮廓对象，或者逆时针的点 `[[x, z], ...]`。 */
export type OutlineInput = Outline | readonly Vec2[];

function outlineOf(input: OutlineInput): Outline {
  return Array.isArray(input) ? { points: input as readonly Vec2[] } : (input as Outline);
}

/** 沿 +y 拉伸二维轮廓（xz 平面）。用于异形台面、L 形柜台、弧形吧台。 */
export function extrude(
  outline: OutlineInput,
  height: number,
  options: ShapeOptions & { fillet?: number; chamfer?: number } = {},
): ExtrudeShape {
  return finish<ExtrudeShape>(
    {
      type: 'extrude',
      outline: outlineOf(outline),
      height,
      fillet: options.fillet,
      chamfer: options.chamfer,
    },
    options,
  );
}

/** 旋转体：`profile = [[r, y], ...]`（r ≥ 0）绕 y 轴旋转。用于圆桌底座、立柱、灯、花瓶。 */
export function lathe(
  profile: readonly Vec2[],
  options: ShapeOptions & { segments?: number; angle?: number } = {},
): LatheShape {
  return finish<LatheShape>(
    { type: 'lathe', profile, segments: options.segments, angle: options.angle },
    options,
  );
}

/**
 * 沿路径扫掠截面：`section` 是圆截面半径（数字）、`{ circle: r }` 或 `{ rect: [w, h] }`。
 * 用于椅腿、扶手、管子、栏杆。注意包围盒会向各方向扩出截面半径：贴地的腿从 y = r 开始。
 */
export function sweep(
  path: readonly Vec3[],
  section: number | SweepSection,
  options: ShapeOptions & { smooth?: number; caps?: boolean } = {},
): SweepShape {
  return finish<SweepShape>(
    {
      type: 'sweep',
      path,
      section: typeof section === 'number' ? { circle: section } : section,
      smooth: options.smooth,
      caps: options.caps,
    },
    options,
  );
}

/** 在 2 到 8 个截面之间放样（截面的 y 递增）。用于花瓶、灯罩、渐变的柱子。 */
export function loft(
  sections: readonly { readonly y: number; readonly outline: OutlineInput }[],
  options: ShapeOptions = {},
): LoftShape {
  const list: LoftSection[] = sections.map((s) => ({ y: s.y, outline: outlineOf(s.outline) }));
  return finish<LoftShape>({ type: 'loft', sections: list }, options);
}

/**
 * 板：平面简单多边形（3 到 64 个点，局部坐标）沿 −法向 加厚 `thickness`（0 < t ≤ 1 米）。
 * 点的顺序按右手定则给出法向：从法向一侧看是逆时针，板从这一面往背后长。
 * 所有点到最佳拟合平面的距离不能超过 1 毫米。用于前台这类斜面折板、台面、玻璃。
 */
export function plate(
  points: readonly Vec3[],
  thickness: number,
  options: ShapeOptions = {},
): PlateShape {
  return finish<PlateShape>({ type: 'plate', points, thickness }, options);
}

/**
 * 凸包：这些点（4 到 256 个）的凸包实体，用于楔形、船头这类凸多面体。
 * 点不能全部共面或共线（容差 1 毫米）；内部的点不影响形状。
 */
export function hull(points: readonly Vec3[], options: ShapeOptions = {}): HullShape {
  return finish<HullShape>({ type: 'hull', points }, options);
}

/** 组合：`at`、`yaw` 等作用于全部子形状。 */
export function group(children: readonly Shape[], options: ShapeOptions = {}): GroupShape {
  return finish<GroupShape>({ type: 'group', children }, options);
}

/**
 * 模板实例（同款椅子）：引用同一空间里 `kind: "template"` 的物件。`color` 只覆盖模板的颜色（以及 `opacity`、
 * `unlit`），平铺、着色、法线、粗糙度不参与覆盖，模板部件保留自己的；`texture` 把全部部件换成这整个材质。
 */
export function instance(template: string, options: ShapeOptions = {}): InstanceShape {
  return finish<InstanceShape>({ type: 'instance', template }, options);
}

// ---------------------------------------------------------------------------
// 二维轮廓
// ---------------------------------------------------------------------------

/** 圆心角（度）→ bulge = tan(角 / 4)。正值向外凸（逆时针轮廓），负值向内凹。 */
export function bulgeFor(angleDegrees: number): number {
  return Math.tan((angleDegrees * Math.PI) / 180 / 4);
}

/** 点按逆时针排列（有向面积为正）；顺时针的点会被反过来（只适用于没有圆弧和圆角的轮廓）。 */
export function ccw(points: readonly Vec2[]): Vec2[] {
  return signedArea(points) > 0 ? [...points] : [...points].reverse();
}

/** 通用轮廓：点（逆时针）+ 可选的圆弧和圆角。 */
export function outline(
  points: readonly Vec2[],
  options: { arcs?: readonly OutlineArc[]; fillets?: readonly OutlineFillet[] } = {},
): Outline {
  return {
    points,
    ...(options.arcs && options.arcs.length > 0 ? { arcs: options.arcs } : {}),
    ...(options.fillets && options.fillets.length > 0 ? { fillets: options.fillets } : {}),
  };
}

/** 以 `center` 为中心、宽 `width`（x）深 `depth`（z）的矩形轮廓；`radius` 给四个角倒圆角。 */
export function rect(
  width: number,
  depth: number,
  options: { center?: Vec2; radius?: number } = {},
): Outline {
  const [cx, cz] = options.center ?? [0, 0];
  const w = width / 2;
  const d = depth / 2;
  const points: Vec2[] = [
    [cx - w, cz - d],
    [cx + w, cz - d],
    [cx + w, cz + d],
    [cx - w, cz + d],
  ];
  const radius = options.radius ?? 0;
  return outline(points, {
    fillets: radius > 0 ? [0, 1, 2, 3].map((at) => ({ at, radius })) : [],
  });
}

/** 圆形轮廓：四段 90° 圆弧（精确的圆）。 */
export function circle(radius: number, center: Vec2 = [0, 0]): Outline {
  const [cx, cz] = center;
  const bulge = bulgeFor(90);
  return outline(
    [
      [cx + radius, cz],
      [cx, cz + radius],
      [cx - radius, cz],
      [cx, cz - radius],
    ],
    { arcs: [0, 1, 2, 3].map((from) => ({ from, bulge })) },
  );
}

/**
 * 跑道形（两端半圆）轮廓：总长 `length`（x）、宽 `width`（z）。用于椭圆桌、吧台端头。
 */
export function stadium(length: number, width: number, center: Vec2 = [0, 0]): Outline {
  const [cx, cz] = center;
  const r = width / 2;
  const half = Math.max(length / 2 - r, 0);
  if (half === 0) return circle(r, center);
  return outline(
    [
      [cx - half, cz - r],
      [cx + half, cz - r],
      [cx + half, cz + r],
      [cx - half, cz + r],
    ],
    {
      arcs: [
        { from: 1, bulge: 1 },
        { from: 3, bulge: 1 },
      ],
    },
  );
}

/**
 * L 形轮廓（转角柜台）：外框 `width × depth`，两条边的进深都是 `arm`，缺口在 +x +z 一角。
 * 原点在外框中心。`radius` 给五个外凸角倒圆角。
 */
export function lShape(width: number, depth: number, arm: number, radius = 0): Outline {
  const w = width / 2;
  const d = depth / 2;
  const points: Vec2[] = [
    [-w, -d],
    [w, -d],
    [w, -d + arm],
    [-w + arm, -d + arm],
    [-w + arm, d],
    [-w, d],
  ];
  return outline(points, {
    fillets: radius > 0 ? [0, 1, 2, 4, 5].map((at) => ({ at, radius })) : [],
  });
}
