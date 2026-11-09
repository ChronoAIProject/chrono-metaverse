import type { Anchor, EntityBody, Plot, Region } from '../core/api/types';
import type { Shape } from '../core/shapes/types';
import { TEXTURES } from './assets';

/**
 * 夹具空间"演示前厅"：按 docs/SHAPES.md 写成的一个小房间，覆盖全部形状类型。
 *
 * - 结构：地砖地面（贴图，planar）、三面墙（南墙留门洞）、东侧玻璃隔断、天花板；
 * - 物体：木纹办公桌（box + fillet，贴图 box 投影）、旋转体边几（lathe）、
 *   扫掠椅腿的椅子模板和 3 个实例（sweep + group + instance，其中一把换了颜色）、
 *   布面沙发（extrude + arcs + fillets，贴图按网格自身坐标 + 色调）、放样花盆（loft）、
 *   条纹灯罩的落地灯（cylinder，贴图圆柱投影）、带弧形正面的前台（extrude）；
 * - 和真实扫描一样，每个重建出的物体都有一个锚点：桌上、前台上和地上的几件杂物（小圆角盒）、
 *   两个柜子、边几、绿植、落地灯也都带锚点（类型按处理服务的规则，不认识的前缀归 zone），
 *   用来演示锚点标签的取舍（默认只显示有意义的几个，悬停时显示，见 web/README.md）；
 * - 扩展层：虚拟区里的展台（物件）和方块平台（区块，见 chunks.ts）。
 * - 锚点：桌、座位、休息区、入口、前台、虚拟展区，以及空间级锚点 `_space`（营业状态）。
 *
 * 实体区 x 0–6 米、z 0–5 米；虚拟区在东边 x 6–10 米。格子单位 5 厘米。
 */

export const SPACE_ID = 'demo-lobby';
export const SPACE_NAME = '演示前厅';
export const SHARE_TOKEN = 'fixture-share-token-0123456789abcdef';

export const regions: Region[] = [
  { id: 'physical', kind: 'physical', label: '实体区', boxes: [[0, 0, 0, 120, 60, 100]] },
  { id: 'virtual', kind: 'virtual', label: '虚拟展区', boxes: [[120, 0, 0, 200, 60, 100]] },
];

export const plots: Plot[] = [
  { id: 'p1', regionId: 'virtual', label: '一号地块', boxes: [[124, 0, 8, 196, 60, 92]] },
];

const WALNUT_TINT = [255, 236, 214] as const;
const METAL = [58, 60, 66] as const;
const FABRIC = [86, 112, 140] as const;

const legPath = (x: number, z: number): Shape => ({
  type: 'sweep',
  path: [
    [x, 0, z],
    [x, 0.44, z],
  ],
  section: { circle: 0.012 },
  material: { color: METAL },
});

/** 椅子模板：座面（圆角盒）、靠背（放样，略带弧度）、四条扫掠椅腿，后腿向上弯成靠背框。 */
export const chairTemplate: Shape = {
  type: 'group',
  material: { color: [196, 98, 64] },
  children: [
    { type: 'box', size: [0.46, 0.05, 0.44], fillet: 0.02, transform: { position: [0, 0.44, 0] } },
    {
      type: 'loft',
      sections: [
        {
          y: 0,
          outline: {
            points: [
              [-0.21, -0.012],
              [0.21, -0.012],
              [0.21, 0.012],
              [-0.21, 0.012],
            ],
            arcs: [
              { from: 0, bulge: -0.08 },
              { from: 2, bulge: 0.08 },
            ],
          },
        },
        {
          y: 0.3,
          outline: {
            points: [
              [-0.2, -0.012],
              [0.2, -0.012],
              [0.2, 0.012],
              [-0.2, 0.012],
            ],
            arcs: [
              { from: 0, bulge: -0.1 },
              { from: 2, bulge: 0.1 },
            ],
            fillets: [],
          },
        },
      ],
      transform: { position: [0, 0.52, -0.2], pitch: -8 },
    },
    legPath(-0.19, 0.18),
    legPath(0.19, 0.18),
    ...[-0.19, 0.19].map((x): Shape => ({
      type: 'sweep',
      path: [
        [x, 0, -0.18],
        [x, 0.44, -0.2],
        [x, 0.84, -0.27],
      ],
      smooth: 0.08,
      section: { circle: 0.012 },
      material: { color: METAL },
    })),
  ],
};

/** 办公桌：桌面和侧板都是圆角盒。 */
const desk: Shape = {
  type: 'group',
  material: { texture: TEXTURES.wood.hash, uv: 'box', tint: WALNUT_TINT },
  transform: { position: [2.4, 0, 1.6] },
  children: [
    { type: 'box', size: [1.6, 0.04, 0.8], fillet: 0.015, transform: { position: [0, 0.71, 0] } },
    {
      type: 'box',
      size: [0.04, 0.71, 0.72],
      fillet: 0.008,
      transform: { position: [-0.74, 0, 0] },
    },
    { type: 'box', size: [0.04, 0.71, 0.72], fillet: 0.008, transform: { position: [0.74, 0, 0] } },
    {
      type: 'box',
      size: [1.44, 0.4, 0.02],
      chamfer: 0.004,
      transform: { position: [0, 0.3, -0.3] },
      material: { color: [102, 72, 50] },
    },
  ],
};

/** 边几：旋转体，底座、细柱、桌面。 */
const sideTable: Shape = {
  type: 'lathe',
  profile: [
    [0, 0],
    [0.2, 0],
    [0.2, 0.02],
    [0.06, 0.05],
    [0.035, 0.12],
    [0.03, 0.48],
    [0.27, 0.5],
    [0.27, 0.54],
    [0, 0.54],
  ],
  segments: 48,
  transform: { position: [4.9, 0, 3.7] },
  material: { color: [214, 204, 188] },
};

/** 沙发：座垫正面是外凸的圆弧，靠背是一条弧形带，扶手是圆角盒。 */
const sofa: Shape = {
  type: 'group',
  material: { texture: TEXTURES.fabric.hash, uv: 'mesh', tint: FABRIC },
  transform: { position: [4.6, 0, 2.2], yaw: -90 },
  children: [
    {
      type: 'extrude',
      outline: {
        points: [
          [-0.95, -0.42],
          [0.95, -0.42],
          [0.95, 0.42],
          [-0.95, 0.42],
        ],
        arcs: [{ from: 2, bulge: 0.08 }],
        fillets: [
          { at: 0, radius: 0.06 },
          { at: 1, radius: 0.06 },
        ],
      },
      height: 0.42,
      fillet: 0.04,
    },
    {
      type: 'extrude',
      outline: {
        points: [
          [-0.95, -0.42],
          [0.95, -0.42],
          [0.95, -0.24],
          [-0.95, -0.24],
        ],
        arcs: [
          { from: 0, bulge: -0.06 },
          { from: 2, bulge: 0.06 },
        ],
      },
      height: 0.45,
      fillet: 0.05,
      transform: { position: [0, 0.38, 0] },
    },
    ...[-1, 1].map((side): Shape => ({
      type: 'box',
      size: [0.16, 0.62, 0.84],
      fillet: 0.05,
      transform: { position: [side * 1.03, 0, 0] },
    })),
    ...[-0.8, 0.8].flatMap((x) =>
      [-0.32, 0.32].map((z): Shape => ({
        type: 'cylinder',
        radius: 0.025,
        radiusTop: 0.02,
        height: 0.06,
        transform: { position: [x, -0.06, z] },
        material: { color: METAL },
      })),
    ),
  ],
};

/** 花盆：方形底、圆形口的放样，上面是一棵圆锥形的植物。 */
const planter: Shape = {
  type: 'group',
  transform: { position: [0.5, 0, 4.4] },
  children: [
    {
      type: 'loft',
      material: { color: [226, 222, 214] },
      sections: [
        {
          y: 0,
          outline: {
            points: [
              [-0.16, -0.16],
              [0.16, -0.16],
              [0.16, 0.16],
              [-0.16, 0.16],
            ],
            fillets: [0, 1, 2, 3].map((at) => ({ at, radius: 0.03 })),
          },
        },
        {
          y: 0.25,
          outline: {
            points: [
              [-0.2, -0.2],
              [0.2, -0.2],
              [0.2, 0.2],
              [-0.2, 0.2],
            ],
            fillets: [0, 1, 2, 3].map((at) => ({ at, radius: 0.1 })),
          },
        },
        {
          y: 0.4,
          outline: {
            points: [
              [-0.22, 0],
              [0, -0.22],
              [0.22, 0],
              [0, 0.22],
            ],
            arcs: [0, 1, 2, 3].map((from) => ({ from, bulge: 0.4142 })),
          },
        },
      ],
    },
    {
      type: 'cone',
      radius: 0.28,
      height: 1.1,
      segments: 20,
      transform: { position: [0, 0.38, 0] },
      material: { color: [70, 128, 74] },
    },
  ],
};

/** 落地灯：圆柱灯杆（带圆角的底座）+ 圆台灯罩。 */
const lamp: Shape = {
  type: 'group',
  transform: { position: [5.5, 0, 0.5] },
  children: [
    { type: 'cylinder', radius: 0.16, height: 0.03, fillet: 0.01, material: { color: METAL } },
    { type: 'cylinder', radius: 0.012, height: 1.5, segments: 12, material: { color: METAL } },
    {
      type: 'cylinder',
      radius: 0.22,
      radiusTop: 0.14,
      height: 0.28,
      transform: { position: [0, 1.42, 0] },
      material: { texture: TEXTURES.stripe.hash, uv: 'cylindrical' },
    },
  ],
};

/** 前台：正面外凸的圆弧挤出，木纹台面。 */
const counter: Shape = {
  type: 'group',
  transform: { position: [2.2, 0, 3.9] },
  children: [
    {
      type: 'extrude',
      outline: {
        points: [
          [-0.8, -0.25],
          [0.8, -0.25],
          [0.8, 0.25],
          [-0.8, 0.25],
        ],
        arcs: [{ from: 2, bulge: 0.12 }],
        fillets: [
          { at: 0, radius: 0.05 },
          { at: 1, radius: 0.05 },
        ],
      },
      height: 1.0,
      chamfer: 0.01,
      material: { color: [236, 232, 224] },
    },
    {
      type: 'box',
      size: [1.7, 0.04, 0.62],
      fillet: 0.015,
      transform: { position: [0, 1.0, 0.03] },
      material: { texture: TEXTURES.wood.hash, uv: 'planar' },
    },
  ],
};

const wall = (size: [number, number, number], position: [number, number, number]): Shape => ({
  type: 'box',
  size,
  transform: { position },
  material: { color: [232, 228, 220] },
});

/** 杂物：小圆角盒（书、电脑、杯子、纸箱……），锚点和真实扫描一样是 `clutter-NN`、标签"杂物"。 */
const CLUTTER: readonly {
  readonly id: string;
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly color: readonly [number, number, number];
}[] = [
  { id: 'clutter-01', min: [1.8, 0.75, 1.35], max: [2.05, 0.83, 1.6], color: [180, 70, 60] },
  { id: 'clutter-02', min: [2.5, 0.75, 1.4], max: [2.85, 0.77, 1.65], color: [60, 62, 68] },
  { id: 'clutter-03', min: [3.0, 0.75, 1.75], max: [3.08, 0.85, 1.83], color: [240, 240, 236] },
  { id: 'clutter-04', min: [1.6, 1.04, 3.75], max: [1.75, 1.2, 3.9], color: [96, 140, 190] },
  { id: 'clutter-05', min: [2.6, 1.04, 3.8], max: [2.8, 1.1, 3.95], color: [214, 180, 90] },
  { id: 'clutter-06', min: [5.4, 0, 4.4], max: [5.75, 0.3, 4.8], color: [176, 138, 96] },
  { id: 'clutter-07', min: [0.3, 0, 2.8], max: [0.6, 0.4, 3.1], color: [176, 138, 96] },
  { id: 'clutter-08', min: [3.75, 0, 2.9], max: [4.0, 0.35, 3.15], color: [70, 90, 120] },
];

/** 柜子：贴墙的高柜和矮柜（木纹贴图）。 */
const CABINETS: readonly {
  readonly id: string;
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}[] = [
  { id: 'cabinet-01', min: [0.3, 0, 0.05], max: [1.3, 1.8, 0.5] },
  { id: 'cabinet-02', min: [0.05, 0, 1.2], max: [0.5, 1.2, 2.4] },
];

function boxEntity(
  id: string,
  label: string,
  min: readonly number[],
  max: readonly number[],
  material: Shape['material'],
): EntityBody {
  const size: [number, number, number] = [0, 1, 2].map((k) => max[k]! - min[k]!) as [
    number,
    number,
    number,
  ];
  return {
    entityId: id,
    layer: 'rebuilt',
    kind: 'object',
    label,
    anchorId: id,
    shape: {
      type: 'box',
      size,
      fillet: Math.min(0.012, Math.min(...size) * 0.2),
      transform: { position: [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2] },
      material,
    },
    bounds: { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] },
  };
}

/** 米制包围盒覆盖的格子（和处理服务、接口服务的 grid_cover 相同）。 */
function gridCover(min: readonly number[], max: readonly number[]): Anchor['box'] {
  const lo = min.map((v) => Math.floor(Math.round((v / 0.05) * 1e6) / 1e6));
  const hi = max.map((v, k) => Math.max(lo[k]! + 1, Math.ceil(Math.round((v / 0.05) * 1e6) / 1e6)));
  return [lo[0]!, lo[1]!, lo[2]!, hi[0]!, hi[1]!, hi[2]!];
}

/** 实体（结构 + 物体）。bounds 是手算的包围盒，供区域判断和剖切范围用。 */
function rebuiltEntities(chairZ: number): EntityBody[] {
  return [
    {
      entityId: 'floor',
      layer: 'rebuilt',
      kind: 'structure',
      label: '地面',
      shape: {
        type: 'box',
        size: [6, 0.05, 5],
        transform: { position: [3, -0.05, 2.5] },
        material: { texture: TEXTURES.tile.hash, uv: 'planar' },
      },
      bounds: { min: [0, -0.05, 0], max: [6, 0, 5] },
    },
    {
      entityId: 'wall-north',
      layer: 'rebuilt',
      kind: 'structure',
      label: '北墙',
      shape: wall([6.2, 2.8, 0.1], [3, 0, -0.05]),
      bounds: { min: [-0.1, 0, -0.1], max: [6.1, 2.8, 0] },
    },
    {
      entityId: 'wall-west',
      layer: 'rebuilt',
      kind: 'structure',
      label: '西墙',
      shape: wall([0.1, 2.8, 5], [-0.05, 0, 2.5]),
      bounds: { min: [-0.1, 0, 0], max: [0, 2.8, 5] },
    },
    {
      entityId: 'wall-south',
      layer: 'rebuilt',
      kind: 'structure',
      label: '南墙',
      shape: {
        type: 'group',
        children: [
          wall([3.6, 2.8, 0.1], [1.7, 0, 5.05]),
          wall([1.4, 2.8, 0.1], [5.4, 0, 5.05]),
          wall([1.2, 0.7, 0.1], [4.1, 2.1, 5.05]),
        ],
      },
      bounds: { min: [-0.1, 0, 5], max: [6.1, 2.8, 5.1] },
    },
    {
      entityId: 'glass-east',
      layer: 'rebuilt',
      kind: 'structure',
      label: '玻璃隔断',
      shape: {
        type: 'box',
        size: [0.02, 2.8, 5],
        transform: { position: [6, 0, 2.5] },
        material: { color: [176, 206, 222] },
      },
      bounds: { min: [5.99, 0, 0], max: [6.01, 2.8, 5] },
      props: { glass: true },
    },
    {
      entityId: 'ceiling',
      layer: 'rebuilt',
      kind: 'structure',
      label: '天花板',
      shape: {
        type: 'box',
        size: [6, 0.06, 5],
        transform: { position: [3, 2.8, 2.5] },
        material: { color: [244, 244, 240] },
      },
      bounds: { min: [0, 2.8, 0], max: [6, 2.86, 5] },
    },
    {
      entityId: 'desk-01',
      layer: 'rebuilt',
      kind: 'object',
      label: '办公桌',
      anchorId: 'table-01',
      shape: desk,
      bounds: { min: [1.6, 0, 1.2], max: [3.2, 0.75, 2] },
      fit: { meanCm: 1.4, p90Cm: 3.1, coverage3cm: 0.86 },
      props: { 材质: '胡桃木', 来源: '夹具' },
    },
    {
      entityId: 'chair-a',
      layer: 'rebuilt',
      kind: 'template',
      label: '会议椅',
      shape: chairTemplate,
    },
    ...[
      { id: 'chair-01', x: 1.95, yaw: 180, z: 1.6 + 0.62 },
      { id: 'chair-02', x: 2.85, yaw: 180, z: chairZ },
      { id: 'chair-03', x: 2.4, yaw: 0, z: 1.6 - 0.62, color: [74, 132, 112] as const },
    ].map(({ id, x, yaw, z, color }): EntityBody => ({
      entityId: id,
      layer: 'rebuilt',
      kind: 'object',
      label: '会议椅',
      anchorId: `seat-${id.slice(-2)}`,
      shape: {
        type: 'instance',
        template: 'chair-a',
        transform: { position: [x, 0, z], yaw },
        ...(color ? { material: { color } } : {}),
      },
      bounds: { min: [x - 0.25, 0, z - 0.3], max: [x + 0.25, 0.86, z + 0.3] },
    })),
    {
      entityId: 'side-table-01',
      layer: 'rebuilt',
      kind: 'object',
      label: '边几',
      anchorId: 'zone-side',
      shape: sideTable,
      bounds: { min: [4.63, 0, 3.43], max: [5.17, 0.54, 3.97] },
    },
    {
      entityId: 'sofa-01',
      layer: 'rebuilt',
      kind: 'object',
      label: '沙发',
      anchorId: 'zone-lounge',
      shape: sofa,
      bounds: { min: [4.1, -0.06, 1.1], max: [5.1, 0.83, 3.3] },
    },
    {
      entityId: 'planter-01',
      layer: 'rebuilt',
      kind: 'object',
      label: '绿植',
      anchorId: 'plant-01',
      shape: planter,
      bounds: { min: [0.22, 0, 4.12], max: [0.78, 1.48, 4.68] },
    },
    {
      entityId: 'lamp-01',
      layer: 'rebuilt',
      kind: 'object',
      label: '落地灯',
      anchorId: 'lamp-01',
      shape: lamp,
      bounds: { min: [5.28, 0, 0.28], max: [5.72, 1.7, 0.72] },
    },
    {
      entityId: 'counter-01',
      layer: 'rebuilt',
      kind: 'object',
      label: '前台',
      anchorId: 'counter-01',
      shape: counter,
      bounds: { min: [1.4, 0, 3.6], max: [3.0, 1.04, 4.25] },
      props: { label: '前台（收花处）', 材质: '人造石 + 木纹台面' },
    },
    ...CABINETS.map(({ id, min, max }) =>
      boxEntity(id, '柜子', min, max, {
        texture: TEXTURES.wood.hash,
        uv: 'box',
        tint: [214, 196, 176],
      }),
    ),
    ...CLUTTER.map(({ id, min, max, color }) => boxEntity(id, '杂物', min, max, { color })),
  ];
}

/** 扩展层物件：虚拟展区里的展台。 */
const extEntities: EntityBody[] = [
  {
    entityId: 'kiosk-01',
    layer: 'ext',
    kind: 'object',
    label: '虚拟展台',
    regionId: 'virtual',
    anchorId: 'zone-virtual',
    shape: {
      type: 'group',
      transform: { position: [8, 0.1, 2.5] },
      children: [
        {
          type: 'cylinder',
          radius: 0.6,
          height: 0.9,
          fillet: 0.05,
          segments: 48,
          material: { color: [236, 214, 120] },
        },
        {
          type: 'cone',
          radius: 0.9,
          height: 0.5,
          segments: 48,
          transform: { position: [0, 2.0, 0] },
          material: { color: [200, 84, 70] },
        },
        ...[0, 120, 240].map((yaw): Shape => ({
          type: 'sweep',
          path: [
            [0.55, 0.9, 0],
            [0.7, 1.5, 0],
            [0.75, 2.05, 0],
          ],
          smooth: 0.3,
          section: { rect: [0.05, 0.03] },
          transform: { yaw },
          material: { color: [90, 90, 96] },
        })),
      ],
    },
    bounds: { min: [7.1, 0.1, 1.6], max: [8.9, 2.6, 3.4] },
    props: { 说明: '虚拟区的扩展物件' },
  },
];

export const anchors: Anchor[] = [
  {
    anchorId: 'table-01',
    kind: 'table',
    label: '1 号桌',
    position: [2.4, 0.75, 1.6],
    visibility: 'public',
  },
  {
    anchorId: 'seat-01',
    kind: 'seat',
    label: '座位 1',
    position: [1.95, 0.5, 2.22],
    visibility: 'public',
  },
  {
    anchorId: 'seat-02',
    kind: 'seat',
    label: '座位 2',
    position: [2.85, 0.5, 2.22],
    visibility: 'public',
  },
  {
    anchorId: 'seat-03',
    kind: 'seat',
    label: '座位 3',
    position: [2.4, 0.5, 0.98],
    visibility: 'public',
  },
  {
    anchorId: 'zone-lounge',
    kind: 'zone',
    label: '休息区',
    position: [4.6, 0.9, 2.2],
    visibility: 'public',
  },
  {
    anchorId: 'door-01',
    kind: 'door',
    label: '入口',
    position: [4.1, 1.05, 5.05],
    visibility: 'public',
  },
  {
    anchorId: 'zone-virtual',
    kind: 'zone',
    label: '虚拟展区',
    position: [8, 2.8, 2.5],
    visibility: 'public',
  },
  {
    anchorId: 'counter-01',
    kind: 'counter',
    label: '前台',
    position: [2.2, 1.05, 3.9],
    visibility: 'public',
  },
  // 和真实扫描一样，每个重建出的物体都有锚点（盒子锚点 = 物体包围盒覆盖的格子）。
  {
    anchorId: 'zone-side',
    kind: 'zone',
    label: '边几',
    box: gridCover([4.63, 0, 3.43], [5.17, 0.54, 3.97]),
    visibility: 'public',
  },
  {
    anchorId: 'plant-01',
    kind: 'zone',
    label: '绿植',
    box: gridCover([0.22, 0, 4.12], [0.78, 1.48, 4.68]),
    visibility: 'public',
  },
  {
    anchorId: 'lamp-01',
    kind: 'zone',
    label: '落地灯',
    box: gridCover([5.28, 0, 0.28], [5.72, 1.7, 0.72]),
    visibility: 'public',
  },
  ...CABINETS.map(({ id, min, max }): Anchor => ({
    anchorId: id,
    kind: 'zone',
    label: '柜子',
    box: gridCover(min, max),
    visibility: 'public',
  })),
  ...CLUTTER.map(({ id, min, max }): Anchor => ({
    anchorId: id,
    kind: 'zone',
    label: '杂物',
    box: gridCover(min, max),
    visibility: 'public',
  })),
  { anchorId: '_space', kind: 'space', label: '演示前厅', visibility: 'public' },
  {
    anchorId: 'camera-01',
    kind: 'camera',
    label: '内部摄像头',
    position: [0.2, 2.6, 0.2],
    visibility: 'internal',
  },
];

/** 各版本的物件：seq 1 只有扫描；seq 2 重建；seq 3 加扩展层；seq 4 挪了一把椅子。 */
export function entitiesAt(seq: number): EntityBody[] {
  if (seq < 2) return [];
  const chairZ = seq >= 4 ? 1.6 + 0.9 : 1.6 + 0.62;
  return [...rebuiltEntities(chairZ), ...(seq >= 3 ? extEntities : [])];
}
