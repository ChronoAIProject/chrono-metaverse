import { describe, expect, it } from 'vitest';
import { SHARE_TOKEN, SPACE_ID } from '../fixtures';
import { fixtureFetch } from '../fixtures/server';
import { createPublicClient } from './api/client';
import type { Palette } from './api/types';
import { BLOCK_AIR, chunkIndex, emptyChunk } from './chunk';
import {
  anchorPosition,
  boxContains,
  entityRegionKind,
  hasStyleChoice,
  isDrawable,
  loadScene,
  placePoint,
  rebuiltContent,
  sceneHeightRange,
  ceilingCutHeight,
  effectiveCutHeight,
  defaultCutHeight,
  CEILING_CUT_MARGIN,
  FALLBACK_CUT_HEIGHT,
  selectView,
  templatesOf,
  viewHasGeometry,
  type SceneDocument,
} from './scene';
import {
  composeVoxels,
  voxelAt,
  voxelMeshes,
  voxelPartsOfKind,
  voxelSourceMeshes,
  type LayerChunk,
} from './voxels';

const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });

async function sceneAt(seq: number) {
  return loadScene(client, await client.snapshot(SPACE_ID, { seq }), '演示前厅');
}

describe('三种视图', () => {
  it('原始视图只有扫描，没有物件和方块', async () => {
    const view = selectView(await sceneAt(3), 'raw');
    expect(view.showScan).toBe(true);
    expect(view.entities).toEqual([]);
    expect(view.voxels.chunks).toEqual([]);
    expect(view.anchors.length).toBeGreaterThan(0);
  });

  it('优化视图只取实体区：没有虚拟展台，方块只剩地毯', async () => {
    const view = selectView(await sceneAt(3), 'optimized');
    const ids = view.entities.map((e) => e.entityId);
    expect(ids).toContain('desk-01');
    expect(ids).toContain('chair-02');
    expect(ids).not.toContain('kiosk-01');
    expect(ids).not.toContain('chair-a');
    expect(view.virtualRegions).toEqual([]);
    const meshes = voxelSourceMeshes(view.voxels);
    expect(meshes.faceCount).toBeGreaterThan(0);
    for (const part of meshes.parts) {
      for (let i = 0; i < part.positions.length; i += 3)
        expect(part.positions[i]!).toBeLessThanOrEqual(6);
    }
  });

  it('优化 + 扩展视图包含虚拟区的物件、方块和虚拟区标识', async () => {
    const view = selectView(await sceneAt(3), 'extended');
    expect(view.entities.map((e) => e.entityId)).toContain('kiosk-01');
    expect(view.virtualRegions.map((r) => r.id)).toEqual(['virtual']);
    expect(view.voxels.chunks.some(({ cx }) => cx >= 4)).toBe(true);
    expect(view.voxels.keepBoxes).toBeNull();
    expect(view.templates['chair-a']).toBeDefined();
  });

  it('重建之前（seq 1）的优化视图是空的', async () => {
    const view = selectView(await sceneAt(1), 'optimized');
    expect(view.entities).toEqual([]);
    expect(view.voxels.chunks).toEqual([]);
  });

  it('剖切范围取物件和区域的最高点', async () => {
    expect(sceneHeightRange(await sceneAt(2)).max).toBeCloseTo(3, 5);
  });

  it('默认剖切高度：结构墙顶部的中位数再低一点，只切掉天花板', async () => {
    // 夹具的墙高 2.8 米
    expect(ceilingCutHeight(await sceneAt(2))).toBeCloseTo(2.8 - CEILING_CUT_MARGIN, 5);
    const wall = (id: string, top: number) => ({
      entityId: id,
      layer: 'rebuilt' as const,
      kind: 'structure' as const,
      bounds: {
        min: [0, 0, 0] as [number, number, number],
        max: [1, top, 0.1] as [number, number, number],
      },
    });
    const floor = {
      entityId: 'floor',
      layer: 'rebuilt' as const,
      kind: 'structure' as const,
      bounds: {
        min: [0, -0.05, 0] as [number, number, number],
        max: [5, 0, 5] as [number, number, number],
      },
    };
    const base = await sceneAt(2);
    const doc = (entities: SceneDocument['entities']) => ({ ...base, entities });
    // 地面、矮隔断不算；偶数面墙取中间两面的平均
    expect(
      ceilingCutHeight(
        doc([floor, wall('a', 2.7), wall('b', 2.9), wall('c', 2.8), wall('d', 3.0)]),
      ),
    ).toBeCloseTo(2.85 - CEILING_CUT_MARGIN, 5);
    expect(ceilingCutHeight(doc([floor, wall('low', 1.2)]))).toBeNull();
    expect(ceilingCutHeight(doc([]))).toBeNull();
  });

  it('默认剖切按视图：原始视图按扫描天花板再低 5 厘米，其他视图按墙顶', () => {
    expect(defaultCutHeight('raw', 2.75, 2.65)).toBeCloseTo(2.6, 5);
    expect(defaultCutHeight('raw', 2.75, null)).toBe(2.75);
    expect(defaultCutHeight('optimized', 2.75, 2.65)).toBe(2.75);
    expect(defaultCutHeight('extended', null, 2.65)).toBeNull();
  });

  it('剖切高度：拖过滑块用用户的，否则用天花板高度，算不出来用后备高度', () => {
    expect(effectiveCutHeight(1.6, 2.75)).toBe(1.6);
    expect(effectiveCutHeight(null, 2.75)).toBe(2.75);
    expect(effectiveCutHeight(null, null)).toBe(FALLBACK_CUT_HEIGHT);
  });

  it('物件按区域分类', () => {
    const regions = [
      { id: 'p', kind: 'physical' as const, boxes: [[0, 0, 0, 10, 10, 10] as const] },
      { id: 'v', kind: 'virtual' as const, boxes: [[10, 0, 0, 20, 10, 10] as const] },
    ];
    expect(boxContains([0, 0, 0, 10, 10, 10], [0.49, 0, 0])).toBe(true);
    expect(boxContains([0, 0, 0, 10, 10, 10], [0.5, 0, 0])).toBe(false);
    const ext = { entityId: 'e', layer: 'ext' as const, kind: 'object' as const };
    expect(
      entityRegionKind({ ...ext, bounds: { min: [0.6, 0, 0], max: [0.7, 0.1, 0.1] } }, regions),
    ).toBe('virtual');
    expect(
      entityRegionKind(
        { ...ext, regionId: 'p', bounds: { min: [0.6, 0, 0], max: [0.7, 0.1, 0.1] } },
        regions,
      ),
    ).toBe('physical');
    expect(entityRegionKind({ ...ext, layer: 'rebuilt' }, regions)).toBe('physical');
    expect(entityRegionKind(ext, regions)).toBe('physical');
  });

  it('模板表只收 kind = template 的物件', async () => {
    expect(Object.keys(templatesOf((await sceneAt(2)).entities))).toEqual(['chair-a']);
  });
});

describe('重建层画法：形状 / 方块', () => {
  const layers = (view: ReturnType<typeof selectView>) => ({
    entities: [...new Set(view.entities.map((e) => e.layer))].sort(),
    chunks: [...new Set(view.voxels.chunks.map((c) => c.layer))].sort(),
  });

  it('重建层既有物件又有区块时才需要选（夹具 seq 2 起体素化过）', async () => {
    expect(rebuiltContent(await sceneAt(1))).toEqual({ shapes: false, blocks: false });
    expect(hasStyleChoice(await sceneAt(1))).toBe(false);
    expect(rebuiltContent(await sceneAt(2))).toEqual({ shapes: true, blocks: true });
    expect(hasStyleChoice(await sceneAt(4))).toBe(true);
  });

  it('形状（默认）：不画重建层区块，扩展层区块照画', async () => {
    const scene = await sceneAt(4);
    for (const mode of ['optimized', 'extended'] as const) {
      const view = selectView(scene, mode);
      expect(view.style).toBe('shapes');
      expect(layers(view)).toEqual({
        entities: mode === 'extended' ? ['ext', 'rebuilt'] : ['rebuilt'],
        chunks: ['ext'],
      });
    }
  });

  it('方块：不画重建层物件，扩展层物件照画；高亮仍然用重建层物件的包围盒', async () => {
    const scene = await sceneAt(4);
    const optimized = selectView(scene, 'optimized', 'blocks');
    expect(optimized.style).toBe('blocks');
    expect(optimized.entities).toEqual([]);
    expect(layers(optimized).chunks).toEqual(['ext', 'rebuilt']);
    expect(optimized.anchored.map((e) => e.anchorId)).toContain('table-01');
    const extended = selectView(scene, 'extended', 'blocks');
    expect(extended.entities.map((e) => e.entityId)).toEqual(['kiosk-01']);
    expect(viewHasGeometry(optimized)).toBe(true);
  });

  it('重建层只有一种内容时照常画，不管选的是哪种；原始视图没有画法', async () => {
    const scene = await sceneAt(4);
    const onlyBlocks: SceneDocument = {
      ...scene,
      entities: scene.entities.filter((e) => e.layer !== 'rebuilt'),
    };
    const view = selectView(onlyBlocks, 'optimized', 'shapes');
    expect(view.style).toBeNull();
    expect(layers(view).chunks).toEqual(['ext', 'rebuilt']);
    const onlyShapes: SceneDocument = {
      ...scene,
      chunks: scene.chunks.filter((c) => c.layer !== 'rebuilt'),
    };
    expect(selectView(onlyShapes, 'optimized', 'blocks').entities.length).toBeGreaterThan(10);
    expect(selectView(scene, 'raw', 'blocks').style).toBeNull();
  });

  it('取景范围：优化视图是实体区，扩展视图加上虚拟区，没有实体区时为空', async () => {
    const scene = await sceneAt(4);
    expect(selectView(scene, 'optimized').frameBoxes).toEqual([[0, 0, 0, 120, 60, 100]]);
    expect(selectView(scene, 'raw').frameBoxes).toEqual([[0, 0, 0, 120, 60, 100]]);
    expect(selectView(scene, 'extended').frameBoxes).toEqual([
      [0, 0, 0, 120, 60, 100],
      [120, 0, 0, 200, 60, 100],
    ]);
    const noRegions: SceneDocument = { ...scene, regions: [] };
    expect(selectView(noRegions, 'optimized').frameBoxes).toEqual([]);
    expect(selectView(noRegions, 'extended').frameBoxes).toEqual([]);
  });
});

describe('方块叠加与网格', () => {
  const palette: Palette = {
    blocks: [
      { id: 2, name: '石', kind: 'solid', color: [255, 0, 0] },
      { id: 3, name: '玻璃', kind: 'glass', color: [0, 0, 255] },
    ],
  };

  function chunk(layer: 'rebuilt' | 'ext', cells: [number, number, number, number][]): LayerChunk {
    const data = emptyChunk();
    for (const [x, y, z, v] of cells) data[chunkIndex(x, y, z)] = v;
    return { layer, cx: 0, cy: 0, cz: 0, cells: data };
  }

  it('扩展层覆盖重建层，空气覆盖删除下层方块', () => {
    const world = composeVoxels([
      chunk('rebuilt', [
        [0, 0, 0, 2],
        [1, 0, 0, 2],
        [2, 0, 0, 2],
      ]),
      chunk('ext', [
        [1, 0, 0, BLOCK_AIR],
        [2, 0, 0, 3],
        [3, 0, 0, 2],
      ]),
    ]);
    expect([0, 1, 2, 3].map((x) => voxelAt(world, x, 0, 0))).toEqual([2, 0, 3, 2]);
    expect(voxelAt(world, -1, 0, 0)).toBe(0);
  });

  it('按区域过滤格子', () => {
    const world = composeVoxels(
      [
        chunk('ext', [
          [0, 0, 0, 2],
          [5, 0, 0, 2],
        ]),
      ],
      (gx) => gx < 3,
    );
    expect(voxelAt(world, 0, 0, 0)).toBe(2);
    expect(voxelAt(world, 5, 0, 0)).toBe(0);
    expect(composeVoxels([chunk('ext', [[5, 0, 0, 2]])], (gx) => gx < 3).size).toBe(0);
  });

  it('相邻的不透明方块之间不画面，玻璃单独成块', () => {
    const single = voxelMeshes(composeVoxels([chunk('ext', [[0, 0, 0, 2]])]), palette);
    expect(single.faceCount).toBe(6);
    const pair = voxelMeshes(
      composeVoxels([
        chunk('ext', [
          [0, 0, 0, 2],
          [1, 0, 0, 2],
        ]),
      ]),
      palette,
    );
    expect(pair.faceCount).toBe(10);
    const mixed = voxelMeshes(
      composeVoxels([
        chunk('ext', [
          [0, 0, 0, 2],
          [1, 0, 0, 3],
        ]),
      ]),
      palette,
    );
    const [solid] = voxelPartsOfKind(mixed, 'solid');
    const [glass] = voxelPartsOfKind(mixed, 'glass');
    expect(solid!.indices.length / 6).toBe(6);
    expect(glass!.indices.length / 6).toBe(5);
    expect(Array.from(glass!.colors.slice(0, 3))).toEqual([0, 0, 1]);
  });

  it('带贴图的方块按顶面、侧面、底面分开，颜色作色调；发光方块单独一块', () => {
    const textured: Palette = {
      blocks: [
        {
          id: 2,
          name: '草',
          kind: 'solid',
          texture: { top: 'a'.repeat(64), side: 'b'.repeat(64) },
        },
        { id: 3, name: '灯', kind: 'emissive', color: [255, 220, 120] },
        {
          id: 4,
          name: '砖',
          kind: 'solid',
          color: [200, 100, 80],
          texture: { side: 'c'.repeat(64) },
        },
      ],
    };
    const meshes = voxelMeshes(
      composeVoxels([
        chunk('ext', [
          [0, 0, 0, 2],
          [5, 0, 0, 3],
          [9, 0, 0, 4],
        ]),
      ]),
      textured,
    );
    const keys = meshes.parts.map((p) => p.key);
    expect(keys).toEqual([
      'emissive:',
      `solid:${'a'.repeat(64)}`,
      `solid:${'b'.repeat(64)}`,
      `solid:${'c'.repeat(64)}`,
    ]);
    const top = meshes.parts.find((p) => p.texture === 'a'.repeat(64))!;
    // 顶面一个面（草的底面没有底面贴图，用侧面的）。
    expect(top.indices.length / 6).toBe(1);
    expect(meshes.parts.find((p) => p.texture === 'b'.repeat(64))!.indices.length / 6).toBe(5);
    // 只有侧面贴图的砖：六个面都用它，颜色是色调。
    const brick = meshes.parts.find((p) => p.texture === 'c'.repeat(64))!;
    expect(brick.indices.length / 6).toBe(6);
    expect(brick.colors[0]).toBeCloseTo(200 / 255, 5);
    expect(Array.from(top.uvs)).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
    expect(Array.from(top.colors.slice(0, 3))).toEqual([1, 1, 1]);
  });

  it('面的绕向朝外，位置按 5 厘米格子', () => {
    const [opaque] = voxelPartsOfKind(
      voxelMeshes(composeVoxels([chunk('ext', [[0, 0, 0, 2]])]), palette),
      'solid',
    );
    if (opaque === undefined) throw new Error('没有不透明网格');
    for (let t = 0; t < opaque.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => {
        const i = opaque.indices[t + k]!;
        return [
          opaque.positions[i * 3]!,
          opaque.positions[i * 3 + 1]!,
          opaque.positions[i * 3 + 2]!,
        ];
      }) as [number[], number[], number[]];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ];
      const i = opaque.indices[t]!;
      const expected = [
        opaque.normals[i * 3]!,
        opaque.normals[i * 3 + 1]!,
        opaque.normals[i * 3 + 2]!,
      ];
      expect(n[0]! * expected[0]! + n[1]! * expected[1]! + n[2]! * expected[2]!).toBeGreaterThan(0);
    }
    expect(Math.max(...opaque.positions)).toBeCloseTo(0.05, 6);
  });
});

describe('组合里的摆放', () => {
  it('先绕成员原点按 y 轴旋转，再平移 offset（格）', () => {
    const place = (rotation: number, point: number[]) =>
      placePoint({ offset: [20, 2, -40], rotation }, point).map((v) => Math.round(v * 1e9) / 1e9);
    // 与形状的 yaw 方向一致：x' = x cos + z sin，z' = −x sin + z cos。
    expect(place(0, [1, 0, 0])).toEqual([2, 0.1, -2]);
    expect(place(90, [1, 0, 0])).toEqual([1, 0.1, -3]);
    expect(place(180, [1, 0, 2])).toEqual([0, 0.1, -4]);
    expect(place(270, [0, 1, 1])).toEqual([0, 1.1, -2]);
  });

  it('锚点位置：点锚点取点，盒子锚点取顶面中心，空间级锚点没有位置', () => {
    expect(anchorPosition({ anchorId: 'a', kind: 'table', position: [1, 2, 3] })).toEqual([
      1, 2, 3,
    ]);
    expect(anchorPosition({ anchorId: 'b', kind: 'zone', box: [0, 0, 0, 20, 10, 40] })).toEqual([
      0.5, 0.5, 1,
    ]);
    expect(anchorPosition({ anchorId: '_space', kind: 'space' })).toBeNull();
  });

  it('只有处理后模型的物件也能画；模板不画', () => {
    expect(isDrawable({ entityId: 'm', layer: 'rebuilt', kind: 'object', assetHash: 'a' })).toBe(
      true,
    );
    expect(isDrawable({ entityId: 't', layer: 'rebuilt', kind: 'template', assetHash: 'a' })).toBe(
      false,
    );
    expect(isDrawable({ entityId: 'n', layer: 'rebuilt', kind: 'object' })).toBe(false);
  });

  it('优化视图先把整块落在实体区外的区块剔掉', async () => {
    const scene = await sceneAt(3);
    const optimized = selectView(scene, 'optimized');
    const extended = selectView(scene, 'extended');
    expect(optimized.voxels.chunks.length).toBeLessThan(extended.voxels.chunks.length);
    expect(viewHasGeometry(optimized)).toBe(true);
    expect(viewHasGeometry(selectView(await sceneAt(1), 'optimized'))).toBe(false);
  });
});
