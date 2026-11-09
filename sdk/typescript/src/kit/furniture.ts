import type { Vec3 } from '../core/grid.js';
import type { GroupShape, Shape, Vec2 } from '../core/shape.js';
import {
  box,
  cylinder,
  extrude,
  group,
  lShape,
  lathe,
  stadium,
  sweep,
  type ColorInput,
  type ShapeOptions,
} from './shapes.js';

/**
 * 常用家具和结构的便捷函数。尺寸默认取真实的常见尺寸（米），都可以改。
 * 每个函数返回一个 `group` 形状（局部原点在底面中心，向 +y 延伸），再用
 * `place(编号, 形状, { label })` 放进空间；`at`、`yaw` 决定摆放位置和朝向。
 *
 * 朝向约定：椅子、柜子、柜台的"正面"朝 +z；`yaw = 180` 就转向 -z。
 */

/** 摆放：位置和朝向（不含材质，材质由各部件自己的颜色决定）。 */
export interface Placement {
  readonly at?: Vec3;
  readonly yaw?: number;
}

function placed(children: Shape[], placement: Placement): GroupShape {
  const options: ShapeOptions = {
    ...(placement.at !== undefined ? { at: placement.at } : {}),
    ...(placement.yaw !== undefined ? { yaw: placement.yaw } : {}),
  };
  return group(children, options);
}

const WOOD: ColorInput = '#b08a5a';
const DARK_WOOD: ColorInput = '#5b4632';
const METAL: ColorInput = '#8a8d93';

export interface TableOptions extends Placement {
  /** 桌面形状：矩形（默认）、圆形（直径 = width）、跑道形。 */
  readonly top?: 'rect' | 'round' | 'stadium';
  readonly width?: number;
  readonly depth?: number;
  readonly height?: number;
  readonly topThickness?: number;
  readonly legSize?: number;
  /** 桌腿离桌边的距离。 */
  readonly legInset?: number;
  /** 桌面边缘圆角。 */
  readonly fillet?: number;
  readonly topColor?: ColorInput;
  readonly legColor?: ColorInput;
}

/** 餐桌：默认 1.2 × 0.75 米、高 0.75 米、桌面厚 3 厘米，四条方腿。圆桌用旋转体底座。 */
export function table(options: TableOptions = {}): GroupShape {
  const kind = options.top ?? 'rect';
  const width = options.width ?? (kind === 'round' ? 0.9 : 1.2);
  const depth = kind === 'round' ? width : (options.depth ?? 0.75);
  const height = options.height ?? 0.75;
  const t = options.topThickness ?? 0.03;
  const fillet = options.fillet ?? 0.01;
  const topColor = options.topColor ?? WOOD;
  const legColor = options.legColor ?? DARK_WOOD;
  const legHeight = height - t;
  const parts: Shape[] = [];
  if (kind === 'round') {
    parts.push(cylinder(width / 2, t, { at: [0, legHeight, 0], fillet, color: topColor }));
    parts.push(pedestal(Math.min(0.25, width * 0.3), legHeight, legColor, [0, 0]));
  } else if (kind === 'stadium') {
    parts.push(
      extrude(stadium(width, depth), t, { at: [0, legHeight, 0], fillet, color: topColor }),
    );
    const offset = Math.max(width / 2 - depth / 2, 0);
    parts.push(pedestal(Math.min(0.22, depth * 0.35), legHeight, legColor, [-offset, 0]));
    parts.push(pedestal(Math.min(0.22, depth * 0.35), legHeight, legColor, [offset, 0]));
  } else {
    const leg = options.legSize ?? 0.05;
    const inset = options.legInset ?? 0.06;
    parts.push(box([width, t, depth], { at: [0, legHeight, 0], fillet, color: topColor }));
    const x = width / 2 - inset - leg / 2;
    const z = depth / 2 - inset - leg / 2;
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      parts.push(box([leg, legHeight, leg], { at: [sx * x, 0, sz * z], color: legColor }));
    }
  }
  return placed(parts, options);
}

/** 旋转体底座（圆桌、高脚凳）：圆盘底 + 细柱。 */
function pedestal(baseRadius: number, height: number, color: ColorInput, at: Vec2): Shape {
  const pole = Math.max(0.025, baseRadius * 0.18);
  return lathe(
    [
      [0, 0],
      [baseRadius, 0],
      [baseRadius, 0.02],
      [pole * 1.6, 0.06],
      [pole, 0.1],
      [pole, height],
      [0, height],
    ],
    { at: [at[0], 0, at[1]], color, segments: 32 },
  );
}

export interface ChairOptions extends Placement {
  readonly seatWidth?: number;
  readonly seatDepth?: number;
  readonly seatHeight?: number;
  readonly seatThickness?: number;
  /** 靠背顶端高出座面的距离。 */
  readonly backHeight?: number;
  readonly legRadius?: number;
  readonly fillet?: number;
  readonly color?: ColorInput;
  readonly seatColor?: ColorInput;
  readonly legColor?: ColorInput;
}

/**
 * 椅子：座面 0.45 × 0.45 米、座高 0.45 米、靠背高出座面 0.42 米，四条圆腿（扫掠）。
 * 面朝 +z（靠背在 -z 一侧）。
 */
export function chair(options: ChairOptions = {}): GroupShape {
  const w = options.seatWidth ?? 0.45;
  const d = options.seatDepth ?? 0.45;
  const h = options.seatHeight ?? 0.45;
  const t = options.seatThickness ?? 0.04;
  const back = options.backHeight ?? 0.42;
  const r = options.legRadius ?? 0.015;
  const fillet = options.fillet ?? 0.01;
  const color = options.color ?? WOOD;
  const seatColor = options.seatColor ?? color;
  const legColor = options.legColor ?? DARK_WOOD;
  const x = w / 2 - r - 0.02;
  const z = d / 2 - r - 0.02;
  const parts: Shape[] = [
    box([w, t, d], { at: [0, h - t, 0], fillet, color: seatColor }),
    // 靠背板：在座面以上 40% 到顶。
    box([w, back * 0.6, 0.03], { at: [0, h + back * 0.4, -d / 2 + 0.015], fillet, color }),
  ];
  // 腿从 y = r 开始：扫掠的包围盒会向下扩出截面半径，这样不会穿到地面以下。
  for (const sx of [-1, 1]) {
    parts.push(
      sweep(
        [
          [sx * x, r, z],
          [sx * x, h - t, z],
        ],
        r,
        { color: legColor },
      ),
    );
    // 后腿一直伸到靠背顶端，兼作靠背立柱（顶端留出截面半径，总高不超过靠背）。
    parts.push(
      sweep(
        [
          [sx * x, r, -z],
          [sx * x, h + back - r, -z],
        ],
        r,
        { color: legColor },
      ),
    );
  }
  return placed(parts, options);
}

export interface StoolOptions extends Placement {
  readonly height?: number;
  readonly seatRadius?: number;
  readonly seatColor?: ColorInput;
  readonly frameColor?: ColorInput;
}

/** 高脚凳（吧台用）：座高 0.75 米、座面半径 0.18 米，旋转体底座。 */
export function stool(options: StoolOptions = {}): GroupShape {
  const height = options.height ?? 0.75;
  const radius = options.seatRadius ?? 0.18;
  const seat = 0.05;
  return placed(
    [
      cylinder(radius, seat, {
        at: [0, height - seat, 0],
        fillet: 0.015,
        color: options.seatColor ?? '#3c3c42',
      }),
      pedestal(radius * 1.1, height - seat, options.frameColor ?? METAL, [0, 0]),
    ],
    options,
  );
}

export interface CounterOptions extends Placement {
  readonly length?: number;
  readonly depth?: number;
  readonly height?: number;
  readonly topThickness?: number;
  /** 台面比柜体每边多出的距离。 */
  readonly overhang?: number;
  /** 底部踢脚的内缩深度（0 表示没有）。 */
  readonly toeKick?: number;
  readonly chamfer?: number;
  readonly bodyColor?: ColorInput;
  readonly topColor?: ColorInput;
}

/** 柜台 / 吧台：长 2.4 米、深 0.6 米、高 1.1 米，台面厚 4 厘米带倒角，底部踢脚内缩。 */
export function counter(options: CounterOptions = {}): GroupShape {
  const length = options.length ?? 2.4;
  const depth = options.depth ?? 0.6;
  const height = options.height ?? 1.1;
  const t = options.topThickness ?? 0.04;
  const overhang = options.overhang ?? 0.03;
  const kick = options.toeKick ?? 0.05;
  const plinth = kick > 0 ? 0.1 : 0;
  const parts: Shape[] = [
    box([length + 2 * overhang, t, depth + 2 * overhang], {
      at: [0, height - t, 0],
      chamfer: options.chamfer ?? 0.008,
      color: options.topColor ?? '#e8e2d6',
    }),
    box([length, height - t - plinth, depth], {
      at: [0, plinth, 0],
      color: options.bodyColor ?? '#6d5643',
    }),
  ];
  if (plinth > 0) {
    parts.push(
      box([length - 2 * kick, plinth, depth - kick], {
        at: [0, 0, -kick / 2],
        color: '#2f2a26',
      }),
    );
  }
  return placed(parts, options);
}

/** L 形转角柜台：外框 `width × depth`，两边进深 `arm`，缺口在 +x +z 一角。 */
export function cornerCounter(
  options: Placement & {
    width?: number;
    depth?: number;
    arm?: number;
    height?: number;
    topThickness?: number;
    bodyColor?: ColorInput;
    topColor?: ColorInput;
  } = {},
): GroupShape {
  const width = options.width ?? 2.4;
  const depth = options.depth ?? 1.8;
  const arm = options.arm ?? 0.6;
  const height = options.height ?? 1.1;
  const t = options.topThickness ?? 0.04;
  return placed(
    [
      extrude(lShape(width, depth, arm), height - t, { color: options.bodyColor ?? '#6d5643' }),
      extrude(lShape(width + 0.06, depth + 0.06, arm + 0.06, 0.02), t, {
        at: [0, height - t, 0],
        chamfer: 0.008,
        color: options.topColor ?? '#e8e2d6',
      }),
    ],
    options,
  );
}

export interface CabinetOptions extends Placement {
  readonly width?: number;
  readonly depth?: number;
  readonly height?: number;
  /** 门的数量（正面画出门缝和把手）。 */
  readonly doors?: number;
  readonly color?: ColorInput;
  readonly handleColor?: ColorInput;
}

/** 柜子：宽 0.8、深 0.45、高 0.9 米，正面（+z）两扇门带把手。 */
export function cabinet(options: CabinetOptions = {}): GroupShape {
  const width = options.width ?? 0.8;
  const depth = options.depth ?? 0.45;
  const height = options.height ?? 0.9;
  const doors = Math.max(1, Math.round(options.doors ?? 2));
  const color = options.color ?? '#d9d3c7';
  const handle = options.handleColor ?? METAL;
  const parts: Shape[] = [box([width, height, depth], { chamfer: 0.004, color })];
  const doorWidth = width / doors;
  for (let i = 0; i < doors; i += 1) {
    const left = -width / 2 + i * doorWidth;
    // 门板略凸出柜体 1 厘米，门之间留 4 毫米缝。
    parts.push(
      box([doorWidth - 0.004, height - 0.02, 0.01], {
        at: [left + doorWidth / 2, 0.01, depth / 2 + 0.005],
        color,
      }),
    );
    const side = doors === 1 ? 1 : i % 2 === 0 ? 1 : -1;
    parts.push(
      box([0.012, Math.min(0.12, height * 0.2), 0.02], {
        at: [left + doorWidth / 2 + side * (doorWidth / 2 - 0.04), height * 0.62, depth / 2 + 0.02],
        fillet: 0.005,
        color: handle,
      }),
    );
  }
  return placed(parts, options);
}

/** 开放式书架：宽 1、深 0.3、高 1.8 米，5 层隔板，板厚 2 厘米。 */
export function shelf(
  options: Placement & {
    width?: number;
    depth?: number;
    height?: number;
    shelves?: number;
    thickness?: number;
    color?: ColorInput;
  } = {},
): GroupShape {
  const width = options.width ?? 1.0;
  const depth = options.depth ?? 0.3;
  const height = options.height ?? 1.8;
  const count = Math.max(2, Math.round(options.shelves ?? 5));
  const t = options.thickness ?? 0.02;
  const color = options.color ?? WOOD;
  const parts: Shape[] = [
    box([t, height, depth], { at: [-width / 2 + t / 2, 0, 0], color }),
    box([t, height, depth], { at: [width / 2 - t / 2, 0, 0], color }),
    box([width - 2 * t, height - t, 0.008], { at: [0, 0, -depth / 2 + 0.004], color }),
  ];
  for (let i = 0; i < count; i += 1) {
    const y = i === 0 ? 0.05 : ((height - t) * i) / (count - 1);
    parts.push(box([width - 2 * t, t, depth], { at: [0, Math.min(y, height - t), 0], color }));
  }
  return placed(parts, options);
}

// ---------------------------------------------------------------------------
// 墙和门窗洞
// ---------------------------------------------------------------------------

/** 墙上的洞口：从墙起点量到洞口近边的距离 `offset`，宽、高、离地高度 `sill`（米）。 */
export interface Opening {
  readonly offset: number;
  readonly width: number;
  readonly height: number;
  readonly sill: number;
  /** 窗洞里放一块玻璃。 */
  readonly glass?: boolean;
}

/** 门洞：默认宽 0.9、高 2.1 米，落地。 */
export function doorOpening(
  offset: number,
  options: { width?: number; height?: number } = {},
): Opening {
  return { offset, width: options.width ?? 0.9, height: options.height ?? 2.1, sill: 0 };
}

/** 窗洞：默认宽 1.2、高 1.2 米，窗台离地 0.9 米，带玻璃。 */
export function windowOpening(
  offset: number,
  options: { width?: number; height?: number; sill?: number; glass?: boolean } = {},
): Opening {
  return {
    offset,
    width: options.width ?? 1.2,
    height: options.height ?? 1.2,
    sill: options.sill ?? 0.9,
    glass: options.glass ?? true,
  };
}

export interface WallOptions {
  /** 起点和终点（米，`[x, z]`），墙沿这条线居中。 */
  readonly from: Vec2;
  readonly to: Vec2;
  readonly height?: number;
  readonly thickness?: number;
  /** 墙底的高度（默认 0）。 */
  readonly base?: number;
  readonly openings?: readonly Opening[];
  readonly color?: ColorInput;
  readonly glassColor?: ColorInput;
}

/**
 * 墙：从 `from` 到 `to`，默认高 2.8 米、厚 12 厘米；`openings` 挖出门窗洞（墙被拆成几块板，
 * 洞口上下各一块）。返回的形状已经摆好位置，`place` 时不用再给 at / yaw。
 */
export function wall(options: WallOptions): GroupShape {
  const [x0, z0] = options.from;
  const [x1, z1] = options.to;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const length = Math.sqrt(dx * dx + dz * dz);
  if (!(length > 0)) throw new Error('墙的起点和终点不能重合');
  const height = options.height ?? 2.8;
  const thickness = options.thickness ?? 0.12;
  const base = options.base ?? 0;
  const color = options.color ?? '#ece8e1';
  const openings = [...(options.openings ?? [])].sort((a, b) => a.offset - b.offset);
  const parts: Shape[] = [];
  const panel = (start: number, end: number, bottom: number, top: number) => {
    if (end - start <= 1e-6 || top - bottom <= 1e-6) return;
    parts.push(
      box([end - start, top - bottom, thickness], {
        at: [-length / 2 + (start + end) / 2, bottom, 0],
        color,
      }),
    );
  };
  let cursor = 0;
  for (const opening of openings) {
    const start = Math.max(opening.offset, cursor);
    const end = Math.min(opening.offset + opening.width, length);
    if (opening.offset < cursor - 1e-9 || end <= start) {
      throw new Error(`洞口（offset ${opening.offset}）和前一个重叠或超出了墙的长度`);
    }
    if (opening.sill + opening.height > height + 1e-9) throw new Error('洞口比墙还高');
    panel(cursor, start, 0, height);
    panel(start, end, 0, opening.sill);
    panel(start, end, opening.sill + opening.height, height);
    if (opening.glass === true) {
      parts.push(
        box([end - start, opening.height, Math.min(0.012, thickness / 4)], {
          at: [-length / 2 + (start + end) / 2, opening.sill, 0],
          color: options.glassColor ?? '#bcd7e6',
        }),
      );
    }
    cursor = end;
  }
  panel(cursor, length, 0, height);
  // yaw 让局部 +x 指向墙的方向：x' = cos θ，z' = −sin θ。
  const yaw = Math.round(((Math.atan2(-dz, dx) * 180) / Math.PI) * 1e9) / 1e9 + 0;
  return group(parts, { at: [(x0 + x1) / 2, base, (z0 + z1) / 2], ...(yaw !== 0 ? { yaw } : {}) });
}

/** 地台 / 地毯：宽 × 深的薄板，默认厚 2 厘米。 */
export function platform(
  options: Placement & {
    width?: number;
    depth?: number;
    thickness?: number;
    radius?: number;
    color?: ColorInput;
  } = {},
): GroupShape {
  const width = options.width ?? 2;
  const depth = options.depth ?? 2;
  return placed(
    [
      box([width, options.thickness ?? 0.02, depth], {
        ...(options.radius !== undefined ? { fillet: options.radius } : {}),
        color: options.color ?? '#9a8f80',
      }),
    ],
    options,
  );
}
