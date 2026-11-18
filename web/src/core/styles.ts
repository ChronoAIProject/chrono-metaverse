import type {
  LightingPreset,
  SpaceInfo,
  SpaceStyleLook,
  SpaceStyleSpec,
  StyleLayer,
  UniverseMember,
} from './api/types';
import type { SceneDocument, ViewMode, RebuiltStyle } from './scene';

export type StyleId = string;
/** 与后端对象编号规则一致：允许大小写、数字、下划线、连字符和非首位的点。 */
export function isStyleId(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 128 && value[0] !== '.' && !/[^A-Za-z0-9_.-]/.test(value)
  );
}

export type { LightingPreset };
export type StyleLook = SpaceStyleLook & { readonly hologram?: 'detail' | 'facade' | 'landscape' };

export interface SpaceStyle {
  readonly id: StyleId;
  readonly name: string;
  readonly description: string;
  readonly swatch: string;
  readonly category?: 'builtin' | 'custom';
  readonly mode: ViewMode;
  readonly rebuiltStyle?: RebuiltStyle;
  readonly visibleLayers?: readonly StyleLayer[];
  readonly filterKinds?: readonly ('structure' | 'object')[];
  readonly lighting?: LightingPreset;
  readonly backgroundColor?: string;
  readonly look?: StyleLook;
  readonly extensions?: SpaceStyleSpec['extensions'];
}

const customStyle = (spec: SpaceStyleSpec): SpaceStyle => ({
  id: spec.id,
  name: spec.name,
  description: spec.description ?? '空间专属样式',
  swatch: spec.swatch ?? '#7c8cff',
  category: 'custom',
  mode: spec.mode ?? 'optimized',
  rebuiltStyle: spec.rebuiltStyle,
  visibleLayers: spec.visibleLayers,
  filterKinds: spec.filterKinds,
  lighting: spec.lighting,
  backgroundColor: spec.backgroundColor,
  look: spec.look,
  ...(spec.extensions && Object.keys(spec.extensions).length > 0
    ? { extensions: spec.extensions }
    : {}),
});

/** 产品内置的八套核心样式。 */
export const BUILTIN_SPACE_STYLES: readonly SpaceStyle[] = [
  {
    id: 'raw-scan',
    name: '原始扫描',
    description: '还原真实三维扫描网格与采集纹理',
    swatch: '#a9b6c8',
    category: 'builtin',
    mode: 'raw',
    lighting: 'studio',
  },
  {
    id: 'arch-realistic',
    name: '写实建筑',
    description: '展示实体建筑结构与家具模型材质',
    swatch: '#d39d6b',
    category: 'builtin',
    mode: 'optimized',
    rebuiltStyle: 'shapes',
    lighting: 'daylight',
  },
  {
    id: 'voxel-blocks',
    name: '体素方块',
    description: '以 5 厘米体素区块构建像素化空间体量',
    swatch: '#6cc7a5',
    category: 'builtin',
    mode: 'optimized',
    rebuiltStyle: 'blocks',
    lighting: 'daylight',
  },
  {
    id: 'extended-full',
    name: '虚实共生',
    description: '同时呈现物理重建区与虚拟扩展区内容',
    swatch: '#9b8cff',
    category: 'builtin',
    mode: 'extended',
    rebuiltStyle: 'shapes',
    lighting: 'daylight',
  },
  {
    id: 'maquette',
    name: '白模沙盘',
    description: '剥离贴图纹理，突出空间体量与比例',
    swatch: '#f2eee6',
    category: 'builtin',
    mode: 'optimized',
    rebuiltStyle: 'shapes',
    lighting: 'studio',
    backgroundColor: '#f3efe6',
    look: {
      stripTextures: true,
      structureColor: [242, 238, 230],
      objectColor: [220, 214, 202],
      roughness: 0.92,
      metalness: 0.02,
    },
  },
  {
    id: 'blueprint',
    name: '工程蓝图',
    description: '深蓝技术底色配青白结构线框，审视动线与布局边界',
    swatch: '#2d80c7',
    category: 'builtin',
    mode: 'optimized',
    rebuiltStyle: 'shapes',
    lighting: 'blueprint',
    backgroundColor: '#0c192c',
    look: {
      stripTextures: true,
      structureColor: [28, 64, 112],
      objectColor: [56, 132, 205],
      tint: [150, 215, 255],
      wireframe: true,
      unlit: true,
      opacity: 0.88,
    },
  },
  {
    id: 'night-neon',
    name: '夜景霓虹',
    description: '深色建筑基底配高对比冷暖霓虹光效',
    swatch: '#7858cf',
    category: 'builtin',
    mode: 'extended',
    rebuiltStyle: 'shapes',
    lighting: 'night',
    backgroundColor: '#090b14',
    look: {
      tint: [188, 170, 255],
      structureColor: [34, 38, 58],
      objectColor: [120, 88, 210],
      roughness: 0.35,
      metalness: 0.25,
    },
  },
  {
    id: 'holo-arena',
    name: '全息场',
    description: '暮色中的双层玻璃楼群、冰青层板与深色水岸',
    swatch: '#5eedec',
    category: 'builtin',
    mode: 'extended',
    rebuiltStyle: 'shapes',
    lighting: 'studio',
    look: { roughness: 0.31, metalness: 0.15 },
    extensions: { surface: 'hologram' },
  },
] as const;

/** 合并服务端自定义目录；自定义样式同名时覆盖内置样式，便于空间局部调参。 */
export function resolveSpaceStyles(
  scene?: SceneDocument | null,
  info?: SpaceInfo | null,
): readonly SpaceStyle[] {
  const custom = [...(info?.styles ?? []), ...(scene?.styles ?? [])];
  const merged = new Map(BUILTIN_SPACE_STYLES.map((style) => [style.id, style]));
  for (const spec of custom) merged.set(spec.id, customStyle(spec));
  return [...merged.values()];
}

/** 样式外观的稳定键，用于派生材质缓存隔离。 */
export function styleLookKey(look?: StyleLook): string {
  if (!look) return '';
  const keys = Object.keys(look).sort();
  return keys
    .map((key) => `${key}:${JSON.stringify((look as unknown as Record<string, unknown>)[key])}`)
    .join('|');
}

export interface UniverseTheme {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly styleId?: StyleId;
}

export const UNIVERSE_THEMES: readonly UniverseTheme[] = [
  { id: 'independent', name: '各自独立', description: '每个成员空间使用各自设定或覆盖的样式' },
  {
    id: 'gallery-day',
    name: '日光展馆',
    description: '统一写实建筑与温暖日光展陈',
    styleId: 'arch-realistic',
  },
  {
    id: 'night-district',
    name: '霓虹街区',
    description: '统一午夜街区氛围与夜景霓虹表达',
    styleId: 'night-neon',
  },
  {
    id: 'maquette-sandtable',
    name: '白模沙盘总览',
    description: '统一建筑白模，审视多空间体量关系',
    styleId: 'maquette',
  },
  {
    id: 'blueprint-atlas',
    name: '工程蓝图总览',
    description: '统一工程蓝图线框，审视跨空间连接与动线',
    styleId: 'blueprint',
  },
  {
    id: 'voxel-world',
    name: '体素方块世界',
    description: '统一体素方块风格',
    styleId: 'voxel-blocks',
  },
] as const;

export interface UniverseLayoutPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly offsets: readonly (readonly [number, number, number, UniverseMember['rotation']])[];
}

export const UNIVERSE_LAYOUT_PRESETS: readonly UniverseLayoutPreset[] = [
  {
    id: 'default',
    name: '默认街角',
    description: '街角相连的错落配置',
    offsets: [
      [0, 0, 0, 0],
      [24, 0, 10, 90],
    ],
  },
  {
    id: 'side-by-side',
    name: '并排展廊',
    description: '成员沿同一轴线并排',
    offsets: [
      [0, 0, 0, 0],
      [26, 0, 0, 0],
    ],
  },
  {
    id: 'courtyard',
    name: '合院对望',
    description: '成员围合成小型庭院',
    offsets: [
      [-16, 0, 0, 90],
      [16, 0, 0, 270],
    ],
  },
  {
    id: 'diagonal-plaza',
    name: '斜向广场',
    description: '沿斜向广场展开',
    offsets: [
      [-12, 0, -10, 90],
      [14, 0, 12, 270],
    ],
  },
] as const;

/** 为组合成员应用排布预设；偏移可按成员编号进行局部覆盖。 */
export function applyLayoutPreset(
  members: readonly UniverseMember[],
  presetId: string,
  memberOffsets: Readonly<
    Record<
      string,
      | readonly [number, number, number, number]
      | { readonly offset: readonly [number, number, number]; readonly rotation: number }
    >
  > = {},
): UniverseMember[] {
  const preset =
    UNIVERSE_LAYOUT_PRESETS.find((item) => item.id === presetId) ?? UNIVERSE_LAYOUT_PRESETS[0]!;
  return members.map((member, index) => {
    const override = memberOffsets[member.spaceId];
    const base = preset.offsets[0]!;
    const value = override ??
      preset.offsets[index] ?? [
        base[0] + Math.floor(index / 2) * 160,
        base[1],
        base[2] + (index % 2) * 160,
        base[3],
      ];
    if (typeof value === 'object' && !('length' in value))
      return {
        ...member,
        offset: value.offset,
        rotation: (((value.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270,
      };
    return {
      ...member,
      offset: [value[0], value[1], value[2]],
      rotation: (((value[3] % 360) + 360) % 360) as 0 | 90 | 180 | 270,
    };
  });
}
