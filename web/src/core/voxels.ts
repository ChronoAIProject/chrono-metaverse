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

/** 方块网格按材质分块：不透明、玻璃（半透明）、发光，以及按贴图分开的块。 */
export type VoxelPartKind = 'solid' | 'glass' | 'emissive';

export interface VoxelPart {
  /** 分块键：`<类别>:<贴图哈希或空>`。 */
  readonly key: string;
  readonly kind: VoxelPartKind;
  /** 贴图资源哈希；没有时用顶点颜色。 */
  readonly texture?: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** sRGB 0–1。有贴图时是色调（方块颜色，没有就是白色）。 */
  readonly colors: Float32Array;
  /** 每个面 0–1。 */
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

export interface VoxelMeshes {
  readonly parts: readonly VoxelPart[];
  readonly faceCount: number;
}

type Face = {
  readonly normal: [number, number, number];
  readonly corners: [number, number, number][];
  /** 贴图取方块表里的哪一张。 */
  readonly side: 'top' | 'side' | 'bottom';
};

const FACES: readonly Face[] = [
  {
    normal: [1, 0, 0],
    side: 'side',
    corners: [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ],
  },
  {
    normal: [-1, 0, 0],
    side: 'side',
    corners: [
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 0],
    ],
  },
  {
    normal: [0, 1, 0],
    side: 'top',
    corners: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
  },
  {
    normal: [0, -1, 0],
    side: 'bottom',
    corners: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: [0, 0, 1],
    side: 'side',
    corners: [
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
      [0, 0, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    side: 'side',
    corners: [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
    ],
  },
];

/** 面内的贴图坐标：侧面 v 朝上，顶面和底面按 x、z。 */
function faceUv(face: Face, corner: readonly number[]): [number, number] {
  const [dx, dy, dz] = corner as [number, number, number];
  if (face.side !== 'side') return [dx, dz];
  return face.normal[0] !== 0 ? [dz, dy] : [dx, dy];
}

/** 方块表里找不到的编号用这个颜色（品红，便于发现）。 */
const MISSING: [number, number, number] = [1, 0, 1];
const WHITE: [number, number, number] = [1, 1, 1];

function blockTable(palette: Palette): Map<number, PaletteBlock> {
  return new Map(palette.blocks.map((block) => [block.id, block]));
}

function blockKind(block: PaletteBlock | undefined): VoxelPartKind {
  if (block?.kind === 'glass') return 'glass';
  if (block?.kind === 'emissive') return 'emissive';
  return 'solid';
}

/** 某个面用的贴图：缺哪一张就用侧面的，侧面也没有时用顶面的。 */
function blockTexture(block: PaletteBlock | undefined, side: Face['side']): string | undefined {
  const t = block?.texture;
  if (t === undefined) return undefined;
  return t[side] ?? t.side ?? t.top ?? t.bottom;
}

class PartBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];
  constructor(
    readonly kind: VoxelPartKind,
    readonly texture: string | undefined,
  ) {}
  build(key: string): VoxelPart {
    return {
      key,
      kind: this.kind,
      ...(this.texture !== undefined ? { texture: this.texture } : {}),
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      colors: new Float32Array(this.colors),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
    };
  }
}

/**
 * 生成可见面：挨着不透明方块的面不画；玻璃挨着任何方块的面都不画。
 * 每个面的四个顶点按"从外面看逆时针"排列。按（类别，贴图）分块，玻璃单独半透明，
 * 发光方块单独一块，带贴图的方块按贴图分块。
 */
export function voxelMeshes(world: VoxelWorld, palette: Palette): VoxelMeshes {
  const blocks = blockTable(palette);
  const glassIds = new Set(palette.blocks.filter((b) => b.kind === 'glass').map((b) => b.id));
  const parts = new Map<string, PartBuilder>();
  let faceCount = 0;
  for (const { cx, cy, cz, cells } of world.values()) {
    for (let i = 0; i < CHUNK_CELLS; i += 1) {
      const id = cells[i]!;
      if (id < 2) continue;
      const lx = i % CHUNK_SIZE;
      const lz = Math.floor(i / CHUNK_SIZE) % CHUNK_SIZE;
      const ly = Math.floor(i / (CHUNK_SIZE * CHUNK_SIZE));
      const x = cx * CHUNK_SIZE + lx;
      const y = cy * CHUNK_SIZE + ly;
      const z = cz * CHUNK_SIZE + lz;
      const block = blocks.get(id);
      const glass = glassIds.has(id);
      const kind = blockKind(block);
      const tint = block?.color
        ? (block.color.map((c) => c / 255) as [number, number, number])
        : null;
      for (const face of FACES) {
        const nx = lx + face.normal[0];
        const ny = ly + face.normal[1];
        const nz = lz + face.normal[2];
        // 区块内的邻居直接读，越界才查别的区块。
        const neighbor =
          nx >= 0 && ny >= 0 && nz >= 0 && nx < CHUNK_SIZE && ny < CHUNK_SIZE && nz < CHUNK_SIZE
            ? cells[chunkIndex(nx, ny, nz)]!
            : voxelAt(world, x + face.normal[0], y + face.normal[1], z + face.normal[2]);
        // 不透明方块只被不透明方块挡住；玻璃挨着任何方块都不画（贴着不透明面的玻璃面看不见）。
        if (neighbor >= 2 && (glass || !glassIds.has(neighbor))) continue;
        const texture = blockTexture(block, face.side);
        const color = texture !== undefined ? (tint ?? WHITE) : (tint ?? MISSING);
        const key = `${kind}:${texture ?? ''}`;
        let target = parts.get(key);
        if (target === undefined) {
          target = new PartBuilder(kind, texture);
          parts.set(key, target);
        }
        const base = target.positions.length / 3;
        for (const corner of face.corners) {
          target.positions.push(
            (x + corner[0]) * GRID_UNIT,
            (y + corner[1]) * GRID_UNIT,
            (z + corner[2]) * GRID_UNIT,
          );
          target.normals.push(...face.normal);
          target.colors.push(...color);
          target.uvs.push(...faceUv(face, corner));
        }
        target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        faceCount += 1;
      }
    }
  }
  return {
    parts: [...parts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, builder]) => builder.build(key)),
    faceCount,
  };
}

/** 方块风格内容的来源：两层区块和（优化视图的）实体区格子盒；在后台线程里叠加和生成网格。 */
export interface VoxelSource {
  readonly chunks: readonly LayerChunk[];
  /** 只保留落在这些格子盒里的方块；null 表示不过滤。 */
  readonly keepBoxes: readonly (readonly [number, number, number, number, number, number])[] | null;
  readonly palette: Palette;
}

/** 叠加 + 过滤 + 可见面网格，一步完成（后台线程调用）。 */
export function voxelSourceMeshes(source: VoxelSource): VoxelMeshes {
  const boxes = source.keepBoxes;
  const keep =
    boxes === null
      ? undefined
      : (gx: number, gy: number, gz: number) =>
          boxes.some(
            (b) => gx >= b[0] && gy >= b[1] && gz >= b[2] && gx < b[3] && gy < b[4] && gz < b[5],
          );
  return voxelMeshes(composeVoxels(source.chunks, keep), source.palette);
}

/** 某一类的块合在一起（测试用）。 */
export function voxelPartsOfKind(meshes: VoxelMeshes, kind: VoxelPartKind): VoxelPart[] {
  return meshes.parts.filter((part) => part.kind === kind);
}
