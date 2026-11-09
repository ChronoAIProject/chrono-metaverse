/**
 * 建造工具包：建造脚本的第二个参数就是这个模块（也可以 `import … from '@chrono-metaverse/sdk'`）。
 *
 * - 单位：`cm`、`toGrid`、`toMetres`、`cellsBetween`、`cells`；
 * - 形状：`box`、`cylinder`、`cone`、`extrude`、`lathe`、`sweep`、`loft`、`plate`、`hull`、`group`、`instance`，
 *   轮廓 `rect`、`circle`、`stadium`、`lShape`、`outline`、`bulgeFor`；
 * - 操作：`fill`、`hollowBox`、`replace`、`copyRegion`、`addBlock`、`place`、`placeEntity`、
 *   `removeEntity`、`createAnchor`、`moveAnchor`、`updateAnchor`、`removeAnchor`，
 *   记录 `entity`、`template`、`anchor`；
 * - 家具和结构：`table`、`chair`、`stool`、`counter`、`cornerCounter`、`cabinet`、`shelf`、
 *   `wall`（`doorOpening`、`windowOpening`）、`platform`。
 */

export * from './units.js';
export * from './shapes.js';
export * from './ops.js';
export * from './furniture.js';
export { BLOCK_AIR, BLOCK_EMPTY, FIRST_PALETTE_BLOCK } from '../core/chunk.js';
export {
  boxToMetres,
  coveredBy,
  gridBox,
  metresBoxToGrid,
  type Aabb,
  type GridBox,
  type Vec3,
} from '../core/grid.js';
export { shapeBounds, validateShape, type Shape, type Vec2, type Rgb } from '../core/shape.js';
