import { describe, expect, it } from 'vitest';
import { SHARE_TOKEN, SPACE_ID } from '../fixtures';
import { fixtureFetch } from '../fixtures/server';
import { createPublicClient } from './api/client';
import type { Palette } from './api/types';
import { BLOCK_AIR, chunkIndex, emptyChunk } from './chunk';
import {
  boxContains,
  entityRegionKind,
  loadScene,
  sceneHeightRange,
  selectView,
  templatesOf,
} from './scene';
import { composeVoxels, voxelAt, voxelMeshes, type LayerChunk } from './voxels';

const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });

async function sceneAt(seq: number) {
  return loadScene(client, await client.snapshot(SPACE_ID, { seq }), '演示前厅');
}

describe('三种视图', () => {
  it('原始视图只有扫描，没有物件和方块', async () => {
    const view = selectView(await sceneAt(3), 'raw');
    expect(view.showScan).toBe(true);
    expect(view.entities).toEqual([]);
    expect(view.voxels.size).toBe(0);
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
    for (const { cx } of view.voxels.values()) expect(cx).toBeLessThan(4);
  });

  it('优化 + 扩展视图包含虚拟区的物件、方块和虚拟区标识', async () => {
    const view = selectView(await sceneAt(3), 'extended');
    expect(view.entities.map((e) => e.entityId)).toContain('kiosk-01');
    expect(view.virtualRegions.map((r) => r.id)).toEqual(['virtual']);
    expect([...view.voxels.values()].some(({ cx }) => cx >= 4)).toBe(true);
    expect(view.templates['chair-a']).toBeDefined();
  });

  it('重建之前（seq 1）的优化视图是空的', async () => {
    const view = selectView(await sceneAt(1), 'optimized');
    expect(view.entities).toEqual([]);
    expect(view.voxels.size).toBe(0);
  });

  it('剖切范围取物件和区域的最高点', async () => {
    expect(sceneHeightRange(await sceneAt(2)).max).toBeCloseTo(3, 5);
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
    expect(mixed.opaque.indices.length / 6).toBe(6);
    expect(mixed.glass.indices.length / 6).toBe(5);
    expect(Array.from(mixed.glass.colors.slice(0, 3))).toEqual([0, 0, 1]);
  });

  it('面的绕向朝外，位置按 5 厘米格子', () => {
    const { opaque } = voxelMeshes(composeVoxels([chunk('ext', [[0, 0, 0, 2]])]), palette);
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
