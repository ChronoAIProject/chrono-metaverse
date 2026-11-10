import type { Anchor, CommitSummary, EntityBody, Region } from '../core/api/types';
import type { Material, Shape } from '../core/shapes/types';
import { CRATE_SIZE, MODELS, TEXTURES } from './assets';

/**
 * 第三个夹具空间"材质样板"：6 × 4 米的一间房，演示 SHAPES 2 的平铺、着色方式、法线和粗糙度贴图，
 * 以及物件模型的 `material.shading` 和兜底摆放。
 *
 * - 地面：方地砖按米平铺（`tile: [1, 1]`，一张图 4 × 4 块，每块 25 厘米见方），`albedo`，
 *   带法线贴图（砖缝凹下去）和粗糙度贴图；
 * - 北墙左半：砖墙按米平铺（每块砖约 25 × 7 厘米），`albedo` + 法线贴图；
 *   北墙右半：同一张砖墙贴图不给 `tile`（旧数据：按包围盒铺满一次），对比拉伸的样子；
 * - 西墙：颜色材质带法线贴图（拉毛墙面，`uv: "box"` + `tile`）；
 * - 东南角的砖柱：柱面投影按米平铺（周长正好三块贴图宽，没有接缝）；
 * - 三个木箱：同一个带贴图的物件模型，左边按默认的 `baked` 画（0.3 受光 + 0.72 自发光），中间
 *   `albedo`（完整受光），右边的记录比模型小一半（兜底摆放：等比缩进记录的范围，控制台记警告）；
 * - 金属台面：颜色材质只带标量粗糙度和金属度（网站没有环境贴图，金属度高了会发暗，这里取 0.4）。
 */

export const MATERIALS_ID = 'demo-materials';
export const MATERIALS_NAME = '材质样板';
export const MATERIALS_SHARE_TOKEN = 'fixture-materials-token-13579bdf2468ace0';

export const materialsRegions: Region[] = [
  { id: 'room', kind: 'physical', name: '样板间', boxes: [[-4, 0, -4, 124, 60, 84]] },
];

export const materialsAnchors: Anchor[] = [
  { anchorId: '_space', kind: 'space', label: '材质样板', visibility: 'public' },
];

export const materialsCommits: CommitSummary[] = [
  {
    seq: 1,
    at: '2026-11-02T08:00:00.000Z',
    message: '材质样板：平铺、法线、粗糙度',
    actor: { kind: 'person' },
  },
];

/** 砖墙按米平铺：贴图宽两块砖、高四行，所以每块砖 25 × 7 厘米。 */
const BRICK_TILE = [0.5, 0.28] as const;

const brickTiled: Material = {
  texture: TEXTURES.brickWall.hash,
  uv: 'box',
  tile: BRICK_TILE,
  shading: 'albedo',
  normalMap: TEXTURES.brickNormal.hash,
  normalScale: 1.2,
};

/** 砖柱的半径：周长 2π × 0.25 ≈ 1.571 米，贴图宽取三分之一，绕一圈正好三张，没有接缝。 */
const COLUMN_RADIUS = 0.25;

/** 木箱（物件模型）：底面中心在 (x, 0, z)，记录的边长 `size`。 */
function crate(
  entityId: string,
  label: string,
  x: number,
  z: number,
  size: number,
  material: EntityBody['material'],
  note: string,
): EntityBody {
  return {
    entityId,
    layer: 'rebuilt',
    kind: 'object',
    label,
    assetHash: MODELS.crate.hash,
    ...(material ? { material } : {}),
    bounds: { min: [x - size / 2, 0, z - size / 2], max: [x + size / 2, size, z + size / 2] },
    props: { 说明: note },
  };
}

function box(
  size: [number, number, number],
  position: [number, number, number],
  material: Material,
): Shape {
  return { type: 'box', size, transform: { position }, material };
}

export function materialsEntities(): EntityBody[] {
  return [
    {
      entityId: 'floor',
      layer: 'rebuilt',
      kind: 'structure',
      label: '地面（按米平铺的方地砖）',
      shape: box([6, 0.05, 4], [3, -0.05, 2], {
        texture: TEXTURES.checker.hash,
        uv: 'planar',
        tile: [1, 1],
        shading: 'albedo',
        normalMap: TEXTURES.checkerNormal.hash,
        roughnessMap: TEXTURES.checkerRoughness.hash,
      }),
      bounds: { min: [0, -0.05, 0], max: [6, 0, 4] },
      props: { 说明: 'tile [1, 1]：每块砖 25 厘米见方；albedo + 法线贴图 + 粗糙度贴图' },
    },
    {
      entityId: 'wall-tiled',
      layer: 'rebuilt',
      kind: 'structure',
      label: '砖墙（按米平铺）',
      shape: box([3, 2.4, 0.1], [1.5, 0, -0.05], brickTiled),
      bounds: { min: [0, 0, -0.1], max: [3, 2.4, 0] },
      props: { 说明: 'tile [0.5, 0.28]：砖的大小与墙的大小无关；albedo + 法线贴图' },
    },
    {
      entityId: 'wall-stretched',
      layer: 'rebuilt',
      kind: 'structure',
      label: '砖墙（旧数据：铺满一次）',
      shape: box([3, 2.4, 0.1], [4.5, 0, -0.05], {
        texture: TEXTURES.brickWall.hash,
        uv: 'box',
      }),
      bounds: { min: [3, 0, -0.1], max: [6, 2.4, 0] },
      props: { 说明: '不给 tile：贴图按包围盒铺满一次（扫描烘焙贴图的旧画法），砖被拉大' },
    },
    {
      entityId: 'wall-plaster',
      layer: 'rebuilt',
      kind: 'structure',
      label: '拉毛墙（颜色 + 法线贴图）',
      shape: box([0.1, 2.4, 4], [-0.05, 0, 2], {
        color: [236, 230, 218],
        uv: 'box',
        tile: [0.6, 0.6],
        normalMap: TEXTURES.plasterNormal.hash,
        roughness: 0.95,
      }),
      bounds: { min: [-0.1, 0, 0], max: [0, 2.4, 4] },
      props: { 说明: '颜色材质带法线贴图：必须给 uv，可以带 tile' },
    },
    {
      entityId: 'column',
      layer: 'rebuilt',
      kind: 'structure',
      label: '砖柱（柱面按米平铺）',
      shape: {
        type: 'cylinder',
        radius: COLUMN_RADIUS,
        height: 2.4,
        segments: 48,
        transform: { position: [5.3, 0, 3.3] },
        material: {
          ...brickTiled,
          uv: 'cylindrical',
          tile: [(2 * Math.PI * COLUMN_RADIUS) / 3, BRICK_TILE[1]],
        },
      },
      bounds: {
        min: [5.3 - COLUMN_RADIUS, 0, 3.3 - COLUMN_RADIUS],
        max: [5.3 + COLUMN_RADIUS, 2.4, 3.3 + COLUMN_RADIUS],
      },
    },
    crate(
      'crate-baked',
      '木箱（baked）',
      1.2,
      3.2,
      CRATE_SIZE,
      undefined,
      '不写 shading：模型里的贴图按扫描烘焙的看法（0.3 受光 + 0.72 自发光）',
    ),
    crate(
      'crate-albedo',
      '木箱（albedo）',
      2.2,
      3.2,
      CRATE_SIZE,
      { shading: 'albedo' },
      'shading albedo：模型里的材质原样完整受光（模型库的模型用它）',
    ),
    crate(
      'crate-oversized',
      '木箱（记录比模型小一半）',
      3.2,
      3.2,
      CRATE_SIZE / 2,
      { shading: 'albedo' },
      '模型实际比 bounds 大：网站兜底等比缩进 bounds，控制台记警告',
    ),
    {
      entityId: 'metal-top',
      layer: 'rebuilt',
      kind: 'object',
      label: '金属台面',
      shape: box([1, 0.9, 0.5], [4.4, 0, 1.2], {
        color: [150, 154, 162],
        roughness: 0.6,
        metalness: 0.4,
      }),
      bounds: { min: [3.9, 0, 0.95], max: [4.9, 0.9, 1.45] },
      props: { 说明: '颜色材质只带标量粗糙度、金属度（网站没有环境贴图，金属度越高越暗）' },
    },
  ];
}
