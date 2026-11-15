import { describe, expect, it } from 'vitest';
import {
  applyLayoutPreset,
  BUILTIN_SPACE_STYLES,
  resolveSpaceStyles,
  styleLookKey,
  UNIVERSE_THEMES,
} from './styles';
import type { SpaceInfo, SpaceStyleSpec, StyleExtensions, UniverseMember } from './api/types';
import type { SceneDocument } from './scene';

const emptyScene: SceneDocument = {
  spaceId: 'style-room',
  seq: 0,
  at: '2026-11-15T00:00:00Z',
  regions: [],
  plots: [],
  anchors: [],
  entities: [],
  palette: { blocks: [] },
  chunks: [],
};

describe('空间样式目录', () => {
  it('包含七套内置样式并保持稳定外观键', () => {
    expect(BUILTIN_SPACE_STYLES).toHaveLength(7);
    expect(BUILTIN_SPACE_STYLES.map((item) => item.id)).toEqual([
      'raw-scan',
      'arch-realistic',
      'voxel-blocks',
      'extended-full',
      'maquette',
      'blueprint',
      'night-neon',
    ]);
    expect(styleLookKey({ metalness: 0.2, roughness: 0.8 })).toBe('metalness:0.2|roughness:0.8');
    expect(styleLookKey({ roughness: 0.8, metalness: 0.2 })).toBe('metalness:0.2|roughness:0.8');
  });

  it('合并空间自定义样式并支持组合排布预设', () => {
    const styles = resolveSpaceStyles({
      styles: [{ id: 'custom-room', name: '自定义空间', mode: 'extended' }],
    } as never);
    expect(styles.some((item) => item.id === 'custom-room' && item.category === 'custom')).toBe(
      true,
    );
    expect(UNIVERSE_THEMES.map((theme) => theme.id)).toContain('night-district');
    const members: UniverseMember[] = [
      { spaceId: 'one', offset: [0, 0, 0], rotation: 0 },
      { spaceId: 'two', offset: [0, 0, 0], rotation: 0 },
    ];
    expect(applyLayoutPreset(members, 'side-by-side')[1]?.offset).toEqual([26, 0, 0]);
  });
});

it('快照中的样式配方优先于当前最新版本的信息', () => {
  const scene = {
    styles: [{ id: 'custom-room', name: '历史样式', mode: 'raw', look: { tint: [1, 2, 3] } }],
  } as never;
  const info = {
    styles: [
      { id: 'custom-room', name: '最新版本', mode: 'extended' },
      { id: 'head-only', name: '仅最新版本' },
    ],
  } as never;
  expect(resolveSpaceStyles(scene, info).find((style) => style.id === 'custom-room')).toMatchObject(
    { name: '历史样式', mode: 'raw', look: { tint: [1, 2, 3] } },
  );
  expect(resolveSpaceStyles(scene, info).some((style) => style.id === 'head-only')).toBe(true);
});

it('各成员排布不重叠且仅使用支持的旋转角度', () => {
  const members: UniverseMember[] = Array.from({ length: 8 }, (_, i) => ({
    spaceId: `room-${i}`,
    offset: [0, 0, 0],
    rotation: 0,
  }));
  for (const preset of ['default', 'side-by-side', 'courtyard', 'diagonal-plaza']) {
    const placed = applyLayoutPreset(members, preset);
    expect(new Set(placed.map((member) => member.offset.join(','))).size).toBe(members.length);
    expect(placed.every((member) => [0, 90, 180, 270].includes(member.rotation))).toBe(true);
  }
});

it('自定义样式公开契约保留可见图层与物件类别', () => {
  const style = resolveSpaceStyles({
    styles: [
      { id: 'extension-only', name: '扩展展区', visibleLayers: ['ext'], filterKinds: ['object'] },
    ],
  } as never).find((candidate) => candidate.id === 'extension-only');
  expect(style).toMatchObject({ visibleLayers: ['ext'], filterKinds: ['object'] });
});

it('扩展元数据随样式整体覆盖合并且快照优先，不混入最新目录的旧扩展键', () => {
  const extensions: StyleExtensions = {
    badge: '历史策展',
    exhibition: { edition: 2, options: [true, null, 0.125, { title: '共创展' }] },
  };
  const spec: SpaceStyleSpec = { id: 'maquette', name: '策展白模', extensions };
  const info: SpaceInfo = {
    id: 'style-room',
    name: '策展空间',
    regions: [],
    anchors: [],
    styles: [
      { ...spec, extensions: { badge: '最新策展', removed: true } },
      { id: 'info-only', name: '当前专属', extensions: { badge: '最新主题' } },
    ],
  };
  const scene: SceneDocument = { ...emptyScene, styles: [spec] };
  const styles = resolveSpaceStyles(scene, info);
  const selected = styles.find((style) => style.id === 'maquette')!;
  expect(selected.category).toBe('custom');
  expect(selected.extensions).toEqual(extensions);
  expect(selected.extensions).toBe(extensions);
  expect(selected.extensions).not.toHaveProperty('removed');
  expect(styles.find((style) => style.id === 'info-only')?.extensions).toEqual({
    badge: '最新主题',
  });
  expect(styles).toHaveLength(8);
  expect(
    resolveSpaceStyles({ ...emptyScene, styles: [{ id: spec.id, name: '无扩展覆盖' }] }, info).find(
      (style) => style.id === spec.id,
    ),
  ).not.toHaveProperty('extensions');
});

it('旧目录与空扩展沿用既有样式且不产生额外扩展字段', () => {
  expect(resolveSpaceStyles()).toEqual(BUILTIN_SPACE_STYLES);
  for (const extensions of [undefined, {}]) {
    const style = resolveSpaceStyles({
      ...emptyScene,
      styles: [{ id: 'legacy', name: '旧样式', extensions }],
    }).find((candidate) => candidate.id === 'legacy')!;
    expect(style).not.toHaveProperty('extensions');
    expect(JSON.parse(JSON.stringify(style))).not.toHaveProperty('extensions');
    expect(style).toMatchObject({ mode: 'optimized', name: '旧样式' });
  }
});
