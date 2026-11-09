import type { Anchor, EntityBody, Region } from '../core/api/types';
import type { Shape } from '../core/shapes/types';
import { shapeBounds } from '../core/shapes/build';
import { MODELS, TEXTURES, bouquetShape } from './assets';

/**
 * 第二个夹具空间"街角花店"：4 × 4 米的小店，用来演示组合宇宙和跨空间的送花路线。
 *
 * - 结构：地砖地面、三面墙、南墙留门；
 * - 物体：收银台（圆角盒、木纹贴图）、六个花桶（同一个模板的实例，画成 InstancedMesh）、
 *   花架和花束（只有处理后的模型 assetHash，没有形状；带 props.source 署名，花束整体调色）、
 *   收银台上斜放的玻璃挡板（plate + opacity）、斜面展台（hull 楔形 + plate 木板）、
 *   营业中灯箱（unlit）；
 * - 锚点：收银台（送花起点）、门（组合里和前厅的门相连）、空间级锚点 `_space`。
 */

export const FLORIST_ID = 'demo-florist';
export const FLORIST_NAME = '街角花店';
export const FLORIST_SHARE_TOKEN = 'fixture-florist-token-fedcba9876543210';

export const floristRegions: Region[] = [
  { id: 'shop', kind: 'physical', name: '店内', boxes: [[0, 0, 0, 80, 60, 80]] },
];

const WALL: Shape['material'] = { color: [238, 226, 214] };

/** 花桶模板：锌桶（圆台）+ 一簇花（圆锥 + 小球一样的旋转体）。 */
export const bucketTemplate: Shape = {
  type: 'group',
  children: [
    {
      type: 'cylinder',
      radius: 0.14,
      radiusTop: 0.17,
      height: 0.36,
      segments: 24,
      fillet: 0.01,
      material: { color: [150, 156, 162] },
    },
    {
      type: 'cone',
      radius: 0.2,
      height: 0.42,
      segments: 16,
      transform: { position: [0, 0.34, 0] },
      material: { color: [72, 132, 80] },
    },
    {
      type: 'lathe',
      profile: [
        [0, 0],
        [0.12, 0.04],
        [0.16, 0.12],
        [0.1, 0.2],
        [0, 0.22],
      ],
      segments: 20,
      transform: { position: [0, 0.6, 0] },
      material: { color: [226, 88, 120] },
    },
  ],
};

function wall(size: [number, number, number], position: [number, number, number]): Shape {
  return { type: 'box', size, transform: { position }, material: WALL };
}

/** 外部模型的署名（夹具里的示例，地址指向 example.com）。 */
const SHELF_SOURCE = {
  library: 'polyhaven',
  id: 'fixture_flower_shelf',
  page: 'https://example.com/models/flower-shelf',
  author: '夹具作者甲',
  license: 'CC0-1.0',
  title: '木质花架（示例）',
} as const;

const BOUQUET_SOURCE = {
  library: 'objaverse',
  id: 'fixture-bouquet-0001',
  page: 'https://example.com/models/bouquet',
  author: '夹具作者乙',
  license: 'CC-BY-4.0',
  title: '玻璃瓶花束（示例）',
} as const;

/** 花束模型的半宽（x、z）和高度：模型原点在底面中心，按它的网格算。 */
const BOUQUET_BOX = shapeBounds(bouquetShape)!;
const BOUQUET_HALF_X = Math.max(-BOUQUET_BOX.min[0], BOUQUET_BOX.max[0]);
const BOUQUET_HALF_Z = Math.max(-BOUQUET_BOX.min[2], BOUQUET_BOX.max[2]);
const BOUQUET_HEIGHT = BOUQUET_BOX.max[1];

/** 收银台上斜放的玻璃挡板：法向朝 +z（顾客一侧），板往里长 1 厘米。 */
const COUNTER_GUARD: Shape = {
  type: 'plate',
  points: [
    [1.6, 0.95, 1.47],
    [2.4, 0.95, 1.47],
    [2.4, 1.45, 1.43],
    [1.6, 1.45, 1.43],
  ],
  thickness: 0.01,
  material: { color: [200, 232, 240], opacity: 0.3 },
};

/** 斜面展台（东北角）：楔形底座是 6 个点的凸包，斜面上贴一块 2 厘米厚的木板（法向朝西上方）。 */
const SLOPE_OFFSET = 0.02 / Math.SQRT2;
const DISPLAY_STAND: Shape = {
  type: 'group',
  children: [
    {
      type: 'hull',
      points: [
        [3.2, 0, 0.1],
        [3.9, 0, 0.1],
        [3.9, 0, 0.8],
        [3.2, 0, 0.8],
        [3.9, 0.7, 0.1],
        [3.9, 0.7, 0.8],
      ],
      material: { color: [118, 98, 84] },
    },
    {
      type: 'plate',
      points: [
        [3.25 - SLOPE_OFFSET, 0.05 + SLOPE_OFFSET, 0.15],
        [3.25 - SLOPE_OFFSET, 0.05 + SLOPE_OFFSET, 0.75],
        [3.85 - SLOPE_OFFSET, 0.65 + SLOPE_OFFSET, 0.75],
        [3.85 - SLOPE_OFFSET, 0.65 + SLOPE_OFFSET, 0.15],
      ],
      thickness: 0.02,
      material: { texture: TEXTURES.wood.hash, uv: 'mesh' },
    },
  ],
};

export const floristAnchors: Anchor[] = [
  {
    anchorId: 'counter',
    kind: 'counter',
    label: '收银台',
    position: [2.2, 1.0, 1.2],
    visibility: 'public',
  },
  {
    anchorId: 'door',
    kind: 'door',
    label: '花店门口',
    position: [2, 1.05, 4.05],
    visibility: 'public',
  },
  { anchorId: '_space', kind: 'space', label: '街角花店', visibility: 'public' },
];

export function floristEntities(seq: number): EntityBody[] {
  const entities: EntityBody[] = [
    {
      entityId: 'floor',
      layer: 'rebuilt',
      kind: 'structure',
      label: '地面',
      shape: {
        type: 'box',
        size: [4, 0.05, 4],
        transform: { position: [2, -0.05, 2] },
        material: { texture: TEXTURES.tile.hash, uv: 'planar', tint: [236, 220, 230] },
      },
      bounds: { min: [0, -0.05, 0], max: [4, 0, 4] },
    },
    {
      entityId: 'walls',
      layer: 'rebuilt',
      kind: 'structure',
      label: '墙',
      shape: {
        type: 'group',
        children: [
          wall([4.2, 2.6, 0.1], [2, 0, -0.05]),
          wall([0.1, 2.6, 4], [-0.05, 0, 2]),
          wall([0.1, 2.6, 4], [4.05, 0, 2]),
          wall([1.5, 2.6, 0.1], [0.75, 0, 4.05]),
          wall([1.5, 2.6, 0.1], [3.25, 0, 4.05]),
          wall([1.0, 0.5, 0.1], [2, 2.1, 4.05]),
        ],
      },
      bounds: { min: [-0.1, 0, -0.1], max: [4.1, 2.6, 4.1] },
    },
    {
      entityId: 'counter',
      layer: 'rebuilt',
      kind: 'object',
      label: '收银台',
      anchorId: 'counter',
      shape: {
        type: 'box',
        size: [1.4, 0.95, 0.5],
        fillet: 0.03,
        transform: { position: [2.2, 0, 1.2] },
        material: { texture: TEXTURES.wood.hash, uv: 'box' },
      },
      bounds: { min: [1.5, 0, 0.95], max: [2.9, 0.95, 1.45] },
      props: { 说明: '送花从这里出发' },
    },
    {
      entityId: 'bucket',
      layer: 'rebuilt',
      kind: 'template',
      label: '花桶',
      shape: bucketTemplate,
    },
    ...[0.6, 1.2, 1.8, 2.4, 3.0, 3.6].slice(0, seq >= 2 ? 6 : 3).map((z, i): EntityBody => ({
      entityId: `bucket-${i + 1}`,
      layer: 'rebuilt',
      kind: 'object',
      label: '花桶',
      shape: {
        type: 'instance',
        template: 'bucket',
        transform: { position: [0.35, 0, z], yaw: i * 40 },
        // 第二个花桶的花换了颜色：实例的颜色覆盖模板。
        ...(i === 1 ? { material: { color: [250, 200, 70] } } : {}),
      },
      bounds: { min: [0.15, 0, z - 0.2], max: [0.55, 0.85, z + 0.2] },
    })),
    {
      entityId: 'shelf',
      layer: 'rebuilt',
      kind: 'object',
      label: '花架',
      assetHash: MODELS.shelf.hash,
      bounds: { min: [2.6, 0, 2.6], max: [3.8, 1.45, 3.0] },
      props: { 说明: '处理后的物件模型（glb）', source: SHELF_SOURCE },
    },
    {
      // 从模型库找到的现成模型：只有 assetHash，整体调成粉色，CC-BY 署名。
      entityId: 'bouquet-model',
      layer: 'rebuilt',
      kind: 'object',
      label: '花束',
      assetHash: MODELS.bouquet.hash,
      material: { tint: [255, 170, 196] },
      bounds: {
        min: [2.6 - BOUQUET_HALF_X, 0.95, 1.2 - BOUQUET_HALF_Z],
        max: [2.6 + BOUQUET_HALF_X, 0.95 + BOUQUET_HEIGHT, 1.2 + BOUQUET_HALF_Z],
      },
      props: { source: BOUQUET_SOURCE },
    },
    {
      entityId: 'counter-guard',
      layer: 'rebuilt',
      kind: 'object',
      label: '收银台挡板',
      shape: COUNTER_GUARD,
      bounds: { min: [1.6, 0.95, 1.42], max: [2.4, 1.45, 1.48] },
      props: { 说明: '斜放的透明玻璃板（plate + opacity）' },
    },
    {
      entityId: 'display-stand',
      layer: 'rebuilt',
      kind: 'object',
      label: '斜面展台',
      shape: DISPLAY_STAND,
      bounds: { min: [3.2, 0, 0.1], max: [3.9, 0.7, 0.8] },
      props: { 说明: '楔形底座（hull）+ 斜面木板（plate）' },
    },
    {
      entityId: 'open-sign',
      layer: 'rebuilt',
      kind: 'object',
      label: '营业中灯箱',
      shape: {
        type: 'box',
        size: [0.7, 0.24, 0.04],
        fillet: 0.01,
        transform: { position: [2, 1.85, 0.02] },
        material: { color: [255, 128, 84], unlit: true },
      },
      bounds: { min: [1.65, 1.85, 0], max: [2.35, 2.09, 0.04] },
    },
  ];
  return entities;
}
