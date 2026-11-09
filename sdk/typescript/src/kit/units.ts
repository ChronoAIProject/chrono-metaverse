import {
  aabbGridCover,
  boxToMetres,
  GRID_UNIT,
  gridBox,
  roundHalfAway,
  type Aabb,
  type GridBox,
  type Vec3,
} from '../core/grid.js';

/**
 * 米和格互换。网格单位 GRID_UNIT = 0.05 米（5 厘米）。
 *
 * - 形状的尺寸、位置都用**米**（连续值，不吸附到网格）；
 * - 方块操作（填充、空心盒、替换、复制）、区域和地块、锚点盒子用**格**。
 */

export { GRID_UNIT };

/** 厘米 → 米。 */
export function cm(value: number): number {
  return value / 100;
}

/** 米 → 最近的格坐标。 */
export function toGrid(metres: number): number {
  return roundHalfAway(metres / GRID_UNIT);
}

/** 格 → 米。 */
export function toMetres(cells: number): number {
  return cells * GRID_UNIT;
}

/** 三个米坐标 → 最近的格坐标。 */
export function cellAt(point: Vec3): Vec3 {
  return [toGrid(point[0]), toGrid(point[1]), toGrid(point[2])];
}

/**
 * 两个角点（米）→ 覆盖它们之间空间的格子盒子（min 向下取整，max 向上取整）。
 * 例：`cellsBetween([0, 0, 0], [1.2, 0.05, 0.6])` = `[0, 0, 0, 24, 1, 12]`。
 */
export function cellsBetween(a: Vec3, b: Vec3): GridBox {
  return aabbGridCover({
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  });
}

/** 由最小角和尺寸（都是格）组成盒子：`cells([0, 0, 0], [4, 1, 4])` = `[0, 0, 0, 4, 1, 4]`。 */
export function cells(min: Vec3, size: Vec3): GridBox {
  return gridBox([min[0], min[1], min[2], min[0] + size[0], min[1] + size[1], min[2] + size[2]]);
}

/** 格子盒子在米坐标下的范围。 */
export function boxMetres(box: GridBox): Aabb {
  return boxToMetres(box);
}

/** 把米值四舍五入到微米，去掉浮点噪声（例如 0.30000000000000004 → 0.3）。 */
export function tidy(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}
