import { sha256Hex } from '../core/hash';
import type { Shape } from '../core/shapes/types';
import { shapeToGlb, texturedShapeToGlb } from './glb';
import {
  brickNormalTexture,
  brickTexture,
  brickWallTexture,
  checkerNormalTexture,
  checkerRoughnessTexture,
  checkerTexture,
  crateTexture,
  fabricTexture,
  grassTexture,
  marbleTexture,
  plasterNormalTexture,
  stripeTexture,
  tileTexture,
  woodTexture,
} from './png';

/**
 * 夹具的资源（按内容哈希登记）：贴图（PNG）、处理后的物件模型（glb）。
 * 扫描模型在 scanModel.ts 里生成，也登记在这里。
 */
export interface FixtureAsset {
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly type: string;
}

function asset(bytes: Uint8Array, type: string): FixtureAsset {
  return { hash: sha256Hex(bytes), bytes, type };
}

/** 形状和方块用的贴图。 */
export const TEXTURES = {
  wood: asset(woodTexture(), 'image/png'),
  fabric: asset(fabricTexture(), 'image/png'),
  tile: asset(tileTexture(), 'image/png'),
  stripe: asset(stripeTexture(), 'image/png'),
  brick: asset(brickTexture(), 'image/png'),
  grass: asset(grassTexture(), 'image/png'),
  // 材质样板（materials.ts）：按米平铺的地砖、砖墙，各带法线贴图；地砖另有粗糙度贴图。
  checker: asset(checkerTexture(), 'image/png'),
  checkerNormal: asset(checkerNormalTexture(), 'image/png'),
  checkerRoughness: asset(checkerRoughnessTexture(), 'image/png'),
  brickWall: asset(brickWallTexture(), 'image/png'),
  brickNormal: asset(brickNormalTexture(), 'image/png'),
  plasterNormal: asset(plasterNormalTexture(), 'image/png'),
} as const;

/** 花束：送花到达后放在前台上（spawnEntity 的模型）。原点在底面中心。 */
export const bouquetShape: Shape = {
  type: 'group',
  children: [
    {
      type: 'lathe',
      profile: [
        [0, 0],
        [0.06, 0],
        [0.08, 0.06],
        [0.05, 0.18],
        [0.07, 0.24],
        [0, 0.24],
      ],
      segments: 24,
      material: { color: [96, 150, 190] },
    },
    ...[
      [0, 0.34, 0, [232, 72, 110]],
      [0.07, 0.31, 0.03, [250, 196, 64]],
      [-0.06, 0.32, 0.04, [244, 132, 168]],
      [0.02, 0.3, -0.07, [255, 240, 240]],
      [-0.04, 0.29, -0.05, [232, 72, 110]],
    ].map(([x, y, z, color]): Shape => ({
      type: 'lathe',
      profile: [
        [0, 0],
        [0.035, 0.01],
        [0.05, 0.04],
        [0.035, 0.07],
        [0, 0.075],
      ],
      segments: 12,
      transform: { position: [x as number, y as number, z as number] },
      material: { color: color as [number, number, number] },
    })),
    ...[
      [0, 0],
      [0.06, 0.03],
      [-0.05, 0.04],
    ].map(([x, z]): Shape => ({
      type: 'sweep',
      path: [
        [0, 0.2, 0],
        [x! * 0.6, 0.27, z! * 0.6],
        [x!, 0.32, z!],
      ],
      section: { circle: 0.006 },
      segments: 6,
      material: { color: [70, 128, 74] },
    })),
  ],
};

/** 花店的花架：处理后的物件模型（只有 assetHash，没有 shape）。 */
const shelfShape: Shape = {
  type: 'group',
  children: [
    ...[0, 0.45, 0.9, 1.35].map((y): Shape => ({
      type: 'box',
      size: [1.2, 0.04, 0.4],
      fillet: 0.01,
      transform: { position: [0, y, 0] },
      material: { color: [190, 160, 120] },
    })),
    ...[-0.58, 0.58].map((x): Shape => ({
      type: 'box',
      size: [0.04, 1.4, 0.4],
      transform: { position: [x, 0, 0] },
      material: { color: [120, 92, 64] },
    })),
    ...[-0.35, 0, 0.35].flatMap((x, i) =>
      [0.05, 0.5, 0.95].map((y, j): Shape => ({
        type: 'cylinder',
        radius: 0.07,
        radiusTop: 0.09,
        height: 0.2,
        segments: 16,
        transform: { position: [x, y, 0] },
        material: { color: (i + j) % 2 === 0 ? [214, 120, 150] : [236, 200, 90] },
      })),
    ),
  ],
};

/** 木箱：0.6 米见方，原点在底面中心，六个面各铺一次贴图。 */
export const CRATE_SIZE = 0.6;
const crateShape: Shape = {
  type: 'box',
  size: [CRATE_SIZE, CRATE_SIZE, CRATE_SIZE],
  material: { texture: 'crate', uv: 'mesh' },
};

export const MODELS = {
  bouquet: asset(shapeToGlb(bouquetShape, {}, 'bouquet'), 'model/gltf-binary'),
  shelf: asset(shapeToGlb(shelfShape, {}, 'shelf'), 'model/gltf-binary'),
  // 带内嵌颜色贴图、受光照的模型：同一个模型按 material.shading 两种看法画（材质样板）。
  crate: asset(texturedShapeToGlb(crateShape, crateTexture(), 'crate'), 'model/gltf-binary'),
} as const;

/** 草稿里新上传的贴图（大理石纹）：还没发布，只能经预览接口读取。 */
export const DRAFT_TEXTURE = asset(marbleTexture(), 'image/png');
