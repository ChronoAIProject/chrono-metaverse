import type { Anchor, EntityBody, Region } from '../core/api/types';
import type { Shape } from '../core/shapes/types';
import { MODELS, TEXTURES } from './assets';

/**
 * 第二个夹具空间"街角花店"：4 × 4 米的小店，用来演示组合宇宙和跨空间的送花路线。
 *
 * - 结构：地砖地面、三面墙、南墙留门；
 * - 物体：收银台（圆角盒、木纹贴图）、六个花桶（同一个模板的实例，画成 InstancedMesh）、
 *   花架（只有处理后的模型 assetHash，没有形状）；
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
      props: { 说明: '处理后的物件模型（glb）' },
    },
  ];
  return entities;
}

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
