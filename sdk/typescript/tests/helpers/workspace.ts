import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chunkHash, chunkKeyString, compressChunk, emptyChunk } from '../../src/core/chunk.js';
import type { CliContext } from '../../src/commands/common.js';
import type { WorkspaceConfig } from '../../src/workspace/config.js';
import { writeBase, type ChunkRef } from '../../src/workspace/files.js';

export const SDK_ROOT = resolve(import.meta.dirname, '../..');

export interface TestContext extends CliContext {
  readonly lines: string[];
  readonly errors: string[];
}

export function makeContext(cwd: string, env: Record<string, string | undefined> = {}): TestContext {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    cwd,
    env,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    sdkRoot: SDK_ROOT,
    sleep: async () => {},
    lines,
    errors,
  };
}

export function tempDir(prefix = 'metaverse-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 区域：实体区 hall [0,0,0]–[100,60,100]、虚拟区 garden [100,0,0]–[200,60,100]；地块 p1 [100,0,0]–[140,40,40]。 */
export const REGIONS = [
  { id: 'hall', kind: 'physical' as const, boxes: [[0, 0, 0, 100, 60, 100] as const] },
  { id: 'garden', kind: 'virtual' as const, boxes: [[100, 0, 0, 200, 60, 100] as const] },
];
export const PLOTS = [{ id: 'p1', regionId: 'garden', boxes: [[100, 0, 0, 140, 40, 40] as const] }];
export const PALETTE = [
  { id: 2, name: 'stone', kind: 'solid' as const, color: [128, 128, 128] as const, tags: [] },
  { id: 3, name: 'oak', kind: 'solid' as const, color: [160, 120, 70] as const, tags: [] },
];

/** 一个重建层区块：y = 0 整层是石头（实体区的地面）。 */
export function floorChunk(): { ref: ChunkRef; cells: Uint16Array } {
  const cells = emptyChunk();
  for (let x = 0; x < 32; x += 1) for (let z = 0; z < 32; z += 1) cells[x + 32 * z] = 2;
  return { ref: { layer: 'rebuilt', cx: 0, cy: 0, cz: 0, hash: chunkHash(cells) }, cells };
}

/** 建一个已经"拉取过"的工作区。 */
export function makeWorkspace(
  options: { config?: Partial<WorkspaceConfig>; script?: string; spaceId?: string } = {},
): string {
  const root = tempDir();
  const spaceId = options.spaceId ?? 'demo-space';
  const config: WorkspaceConfig = {
    spaceId,
    mode: 'direct',
    api: 'http://127.0.0.1:9',
    devTokenUrl: 'http://127.0.0.1:9/dev/token',
    buildScript: 'build/main.ts',
    ...options.config,
  };
  writeFileSync(join(root, 'metaverse.json'), JSON.stringify(config));
  const floor = floorChunk();
  mkdirSync(join(root, 'chunks'), { recursive: true });
  writeFileSync(join(root, 'chunks', `${floor.ref.hash}.bin`), compressChunk(floor.cells));
  writeBase(root, {
    space: {
      spaceId,
      name: '演示空间',
      seq: 3,
      at: '2026-11-01T00:00:00.000Z',
      regions: REGIONS,
      plots: PLOTS,
      scan: null,
    },
    palette: { blocks: PALETTE },
    anchors: [
      { anchorId: '_space', kind: 'space', visibility: 'public' },
      { anchorId: 'cam-1', kind: 'camera', position: [1, 2.5, 1], visibility: 'internal' },
      { anchorId: 't1', kind: 'table', box: [10, 0, 10, 26, 15, 20], label: '1 号桌', visibility: 'public' },
    ],
    entities: [
      {
        entityId: 'wall-1',
        layer: 'rebuilt',
        kind: 'structure',
        shape: { type: 'box', size: [4, 3, 0.1] },
        bounds: { min: [-2, 0, -0.05], max: [2, 3, 0.05] },
        props: {},
      },
    ],
    chunks: [floor.ref],
  });
  mkdirSync(join(root, 'build'), { recursive: true });
  if (options.script !== undefined) writeFileSync(join(root, 'build', 'main.ts'), options.script);
  return root;
}

export function chunkKey(ref: ChunkRef): string {
  return chunkKeyString(ref);
}
