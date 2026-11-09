import type { ChunkRef, Layer, Palette } from '../core/api/types';
import {
  CHUNK_SIZE,
  chunkHash,
  chunkIndex,
  compressChunk,
  emptyChunk,
  isEmptyChunk,
} from '../core/chunk';
import type { LayerChunk } from '../core/voxels';

/**
 * 夹具的方块内容（扩展层）：虚拟展区里的一座小展亭，以及实体区里的一块地毯。
 * 方块表从 2 开始编号（0、1 是保留编号）。
 */

export const palette: Palette = {
  blocks: [
    { id: 2, name: '石材', kind: 'solid', color: [158, 158, 152] },
    { id: 3, name: '木地板', kind: 'solid', color: [168, 128, 86] },
    { id: 4, name: '玻璃', kind: 'glass', color: [168, 210, 236] },
    { id: 5, name: '草地', kind: 'solid', color: [98, 160, 74] },
    { id: 6, name: '灯', kind: 'emissive', color: [255, 222, 140] },
    { id: 7, name: '红砖', kind: 'solid', color: [176, 88, 66] },
    { id: 8, name: '地毯', kind: 'solid', color: [120, 70, 110] },
  ],
};

type Fill = (gx: number, gy: number, gz: number) => number;

/** 在格子范围 [min, max) 内按 fill 填格子，按区块切开；全 0 的区块不要。 */
function chunksFrom(
  layer: Layer,
  min: [number, number, number],
  max: [number, number, number],
  fill: Fill,
): LayerChunk[] {
  const byKey = new Map<string, LayerChunk>();
  for (let gy = min[1]; gy < max[1]; gy += 1) {
    for (let gz = min[2]; gz < max[2]; gz += 1) {
      for (let gx = min[0]; gx < max[0]; gx += 1) {
        const value = fill(gx, gy, gz);
        if (value === 0) continue;
        const cx = Math.floor(gx / CHUNK_SIZE);
        const cy = Math.floor(gy / CHUNK_SIZE);
        const cz = Math.floor(gz / CHUNK_SIZE);
        const key = `${cx},${cy},${cz}`;
        let chunk = byKey.get(key);
        if (chunk === undefined) {
          chunk = { layer, cx, cy, cz, cells: emptyChunk() };
          byKey.set(key, chunk);
        }
        chunk.cells[chunkIndex(gx - cx * CHUNK_SIZE, gy - cy * CHUNK_SIZE, gz - cz * CHUNK_SIZE)] =
          value;
      }
    }
  }
  return [...byKey.values()].filter((chunk) => !isEmptyChunk(chunk.cells));
}

/** 虚拟展区：石材平台、草地、四根红砖柱和柱顶的灯、北侧一段玻璃墙。 */
const pavilion: Fill = (gx, gy, gz) => {
  const inPlatform = gx >= 126 && gx < 194 && gz >= 6 && gz < 94;
  if (gy <= 1 && inPlatform) {
    const edge = gx < 128 || gx >= 192 || gz < 8 || gz >= 92;
    return gy === 1 && !edge && (gx + gz) % 7 !== 0 && (gx < 140 || gx >= 180) ? 5 : 2;
  }
  const pillar = [128, 190].includes(gx) && [8, 90].includes(gz);
  if (pillar && gy >= 2 && gy < 50) return 7;
  if (pillar && gy === 50) return 6;
  if (gz === 10 && gx >= 140 && gx < 180 && gy >= 2 && gy < 30) return 4;
  return 0;
};

/** 实体区地毯：办公桌下面的一块，扩展层。 */
const rug: Fill = (gx, gy, gz) => {
  if (gy !== 0) return 0;
  const inside = gx >= 26 && gx < 70 && gz >= 18 && gz < 50;
  if (!inside) return 0;
  const border = gx < 28 || gx >= 68 || gz < 20 || gz >= 48;
  return border ? 3 : 8;
};

/** 某个版本的区块：seq 3 起才有扩展层的方块。 */
export function chunksAt(seq: number): LayerChunk[] {
  if (seq < 3) return [];
  return [
    ...chunksFrom('ext', [120, 0, 0], [200, 60, 100], pavilion),
    ...chunksFrom('ext', [0, 0, 0], [120, 2, 100], rug),
  ];
}

export interface StoredChunk {
  readonly ref: ChunkRef;
  readonly compressed: Uint8Array;
}

/** 区块清单和按哈希存储的压缩字节。 */
export function storeChunks(chunks: readonly LayerChunk[]): StoredChunk[] {
  return chunks.map((chunk) => ({
    ref: {
      layer: chunk.layer,
      cx: chunk.cx,
      cy: chunk.cy,
      cz: chunk.cz,
      hash: chunkHash(chunk.cells),
    },
    compressed: compressChunk(chunk.cells),
  }));
}
