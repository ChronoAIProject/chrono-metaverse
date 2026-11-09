import type { Layer, Palette, PaletteBlock } from './api/types';
import { BLOCK_AIR, BLOCK_EMPTY, CHUNK_CELLS, CHUNK_SIZE, GRID_UNIT, chunkIndex } from './chunk';

/**
 * 方块风格内容：把重建层和扩展层的区块叠成一层，再生成可见面的网格。
 *
 * 叠加规则（设计 4.2）：扩展层 ≥ 2 的格子覆盖下层；扩展层是 1（空气覆盖）时删除下层方块；
 * 扩展层是 0 时保留重建层的值。
 */

export interface LayerChunk {
  readonly layer: Layer;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly cells: Uint16Array;
}

/** 叠加后的区块，键是 "cx,cy,cz"。 */
export type VoxelWorld = Map<
  string,
  { readonly cx: number; readonly cy: number; readonly cz: number; readonly cells: Uint16Array }
>;

export const chunkKey = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;

/** 叠加两层；`keep` 返回 false 的格子（按全局格坐标）被剔除，用于按区域过滤。 */
export function composeVoxels(
  chunks: readonly LayerChunk[],
  keep?: (gx: number, gy: number, gz: number) => boolean,
): VoxelWorld {
  const world: VoxelWorld = new Map();
  const grouped = new Map<
    string,
    { rebuilt?: Uint16Array; ext?: Uint16Array; cx: number; cy: number; cz: number }
  >();
  for (const chunk of chunks) {
    const key = chunkKey(chunk.cx, chunk.cy, chunk.cz);
    const entry = grouped.get(key) ?? { cx: chunk.cx, cy: chunk.cy, cz: chunk.cz };
    entry[chunk.layer] = chunk.cells;
    grouped.set(key, entry);
  }
  for (const [key, { rebuilt, ext, cx, cy, cz }] of grouped) {
    const cells = new Uint16Array(CHUNK_CELLS);
    let any = false;
    for (let i = 0; i < CHUNK_CELLS; i += 1) {
      const top = ext?.[i] ?? BLOCK_EMPTY;
      let value = top >= 2 ? top : top === BLOCK_AIR ? BLOCK_EMPTY : (rebuilt?.[i] ?? BLOCK_EMPTY);
      if (value >= 2 && keep !== undefined) {
        const x = i % CHUNK_SIZE;
        const z = Math.floor(i / CHUNK_SIZE) % CHUNK_SIZE;
        const y = Math.floor(i / (CHUNK_SIZE * CHUNK_SIZE));
        if (!keep(cx * CHUNK_SIZE + x, cy * CHUNK_SIZE + y, cz * CHUNK_SIZE + z))
          value = BLOCK_EMPTY;
      }
      cells[i] = value;
      if (value >= 2) any = true;
    }
    if (any) world.set(key, { cx, cy, cz, cells });
  }
  return world;
}

/** 全局格坐标处的方块编号。 */
export function voxelAt(world: VoxelWorld, gx: number, gy: number, gz: number): number {
  const cx = Math.floor(gx / CHUNK_SIZE);
  const cy = Math.floor(gy / CHUNK_SIZE);
  const cz = Math.floor(gz / CHUNK_SIZE);
  const chunk = world.get(chunkKey(cx, cy, cz));
  if (chunk === undefined) return BLOCK_EMPTY;
  return (
    chunk.cells[chunkIndex(gx - cx * CHUNK_SIZE, gy - cy * CHUNK_SIZE, gz - cz * CHUNK_SIZE)] ??
    BLOCK_EMPTY
  );
}

export interface VoxelMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** sRGB 0–1。 */
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

export interface VoxelMeshes {
  readonly opaque: VoxelMesh;
  /** 玻璃类方块单独一块，用半透明材质画。 */
  readonly glass: VoxelMesh;
  readonly faceCount: number;
}

const FACES: readonly { normal: [number, number, number]; corners: [number, number, number][] }[] =
  [
    {
      normal: [1, 0, 0],
      corners: [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1],
      ],
    },
    {
      normal: [-1, 0, 0],
      corners: [
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
        [0, 0, 0],
      ],
    },
    {
      normal: [0, 1, 0],
      corners: [
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
        [0, 1, 0],
      ],
    },
    {
      normal: [0, -1, 0],
      corners: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
    },
    {
      normal: [0, 0, 1],
      corners: [
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
        [0, 0, 1],
      ],
    },
    {
      normal: [0, 0, -1],
      corners: [
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [1, 0, 0],
      ],
    },
  ];

/** 方块表里找不到的编号用这个颜色（品红，便于发现）。 */
const MISSING: [number, number, number] = [1, 0, 1];

function blockTable(palette: Palette): Map<number, PaletteBlock> {
  return new Map(palette.blocks.map((block) => [block.id, block]));
}

/**
 * 生成可见面：挨着不透明方块的面不画；玻璃挨着任何方块的面都不画。
 * 每个面的四个顶点按"从外面看逆时针"排列。
 */
export function voxelMeshes(world: VoxelWorld, palette: Palette): VoxelMeshes {
  const blocks = blockTable(palette);
  const isGlass = (id: number) => blocks.get(id)?.kind === 'glass';
  const out = {
    opaque: {
      positions: [] as number[],
      normals: [] as number[],
      colors: [] as number[],
      indices: [] as number[],
    },
    glass: {
      positions: [] as number[],
      normals: [] as number[],
      colors: [] as number[],
      indices: [] as number[],
    },
  };
  let faceCount = 0;
  for (const { cx, cy, cz, cells } of world.values()) {
    for (let i = 0; i < CHUNK_CELLS; i += 1) {
      const id = cells[i]!;
      if (id < 2) continue;
      const x = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
      const z = cz * CHUNK_SIZE + (Math.floor(i / CHUNK_SIZE) % CHUNK_SIZE);
      const y = cy * CHUNK_SIZE + Math.floor(i / (CHUNK_SIZE * CHUNK_SIZE));
      const glass = isGlass(id);
      const block = blocks.get(id);
      const color = block?.color
        ? (block.color.map((c) => c / 255) as [number, number, number])
        : MISSING;
      const target = glass ? out.glass : out.opaque;
      for (const face of FACES) {
        const neighbor = voxelAt(world, x + face.normal[0], y + face.normal[1], z + face.normal[2]);
        // 不透明方块只被不透明方块挡住；玻璃挨着任何方块都不画（贴着不透明面的玻璃面看不见）。
        if (neighbor >= 2 && (glass || !isGlass(neighbor))) continue;
        const base = target.positions.length / 3;
        for (const [dx, dy, dz] of face.corners) {
          target.positions.push((x + dx) * GRID_UNIT, (y + dy) * GRID_UNIT, (z + dz) * GRID_UNIT);
          target.normals.push(...face.normal);
          target.colors.push(...color);
        }
        target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        faceCount += 1;
      }
    }
  }
  const pack = (m: typeof out.opaque): VoxelMesh => ({
    positions: new Float32Array(m.positions),
    normals: new Float32Array(m.normals),
    colors: new Float32Array(m.colors),
    indices: new Uint32Array(m.indices),
  });
  return { opaque: pack(out.opaque), glass: pack(out.glass), faceCount };
}
