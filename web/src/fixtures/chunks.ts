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
import { TEXTURES } from './assets';

/**
 * 夹具的方块内容：
 *
 * - 扩展层：虚拟展区里的一座小展亭，以及实体区里的一块地毯；
 * - 重建层：实体区的体素化结果（和 AI 重建出的形状物件是同一个房间）。真实扫描既做形状重建、
 *   又做体素化时就是这样，重建层同时有物件和区块，网站给出"形状 / 方块"切换。地砖按扫描颜色
 *   逐格取色，方块画法下地面是一片马赛克。
 *
 * 方块表从 2 开始编号（0、1 是保留编号）；草地顶面和红砖用贴图，柱顶的灯是发光方块；
 * 9 号以后是体素化时按扫描颜色生成的方块。
 */

export const palette: Palette = {
  blocks: [
    { id: 2, name: '石材', kind: 'solid', color: [158, 158, 152] },
    { id: 3, name: '木地板', kind: 'solid', color: [168, 128, 86] },
    { id: 4, name: '玻璃', kind: 'glass', color: [168, 210, 236] },
    { id: 5, name: '草地', kind: 'solid', texture: { top: TEXTURES.grass.hash } },
    { id: 6, name: '灯', kind: 'emissive', color: [255, 222, 140] },
    { id: 7, name: '红砖', kind: 'solid', texture: { side: TEXTURES.brick.hash } },
    { id: 8, name: '地毯', kind: 'solid', color: [120, 70, 110] },
    { id: 9, name: '地砖（扫描）', kind: 'solid', color: [204, 198, 186] },
    { id: 10, name: '地砖（扫描，暗）', kind: 'solid', color: [172, 166, 156] },
    { id: 11, name: '墙面（扫描）', kind: 'solid', color: [226, 222, 214] },
    { id: 12, name: '木纹（扫描）', kind: 'solid', color: [146, 104, 70] },
    { id: 13, name: '布面（扫描）', kind: 'solid', color: [92, 116, 142] },
    { id: 14, name: '前台（扫描）', kind: 'solid', color: [234, 230, 222] },
    { id: 15, name: '绿植（扫描）', kind: 'solid', color: [74, 126, 78] },
    { id: 16, name: '金属（扫描）', kind: 'solid', color: [66, 68, 74] },
  ],
};

export type Fill = (gx: number, gy: number, gz: number) => number;

/** 在格子范围 [min, max) 内按 fill 填格子，按区块切开；全 0 的区块不要。 */
export function chunksFrom(
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

const inside = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/**
 * 重建层的体素化结果（格子单位 5 厘米，和 lobby.ts 的形状物件是同一个房间）：
 * 地砖（逐格取色，看起来是马赛克）、三面墙（南墙留门洞）、东侧玻璃隔断、办公桌、三把椅子、
 * 前台、沙发、边几、绿植、落地灯、两个柜子。没有天花板（体素化时去掉了）。
 */
const rebuiltRoom: Fill = (gx, gy, gz) => {
  if (gy === 0) {
    // 扫描颜色有噪声：大部分是浅色地砖，零星夹着暗一点的格子。
    const noise = (Math.imul(gx, 73_856_093) ^ Math.imul(gz, 19_349_663)) >>> 0;
    return noise % 5 === 0 || gx % 12 === 0 || gz % 12 === 0 ? 10 : 9;
  }
  if (gy > 55) return 0;
  if (gz === 0 || gx === 0) return 11;
  if (gz === 99) return inside(gx, 72, 91) && gy < 42 ? 0 : 11;
  if (gx === 119) return 4;
  // 办公桌：桌面和两侧板。
  if (gy === 14 && inside(gx, 32, 63) && inside(gz, 24, 39)) return 12;
  if (gy < 14 && (gx === 33 || gx === 62) && inside(gz, 25, 38)) return 12;
  // 椅子：座面（seq 4 挪过的那把按挪后的位置）。
  if (gy === 9 && inside(gx, 35, 43) && inside(gz, 40, 48)) return 13;
  if (gy === 9 && inside(gx, 53, 61) && inside(gz, 46, 54)) return 13;
  if (gy === 9 && inside(gx, 44, 52) && inside(gz, 16, 24)) return 13;
  // 前台：台身和木纹台面。
  if (inside(gx, 28, 59) && inside(gz, 72, 84)) return gy < 20 ? 14 : gy === 20 ? 12 : 0;
  // 沙发：座垫和东侧的靠背。
  if (inside(gx, 82, 101) && inside(gz, 22, 65)) {
    if (gy <= 8) return 13;
    if (gy <= 16 && gx >= 95) return 13;
    return 0;
  }
  // 边几。
  if (inside(gx, 93, 103) && inside(gz, 69, 79) && gy === 10) return 11;
  if (gx === 98 && gz === 74 && gy < 10) return 11;
  // 绿植：花盆和上面的一丛。
  if (inside(gx, 5, 14) && inside(gz, 83, 92)) {
    if (gy <= 8) return 11;
    const r = Math.hypot(gx - 9.5, gz - 87.5);
    return gy <= 29 && r <= 5.5 * (1 - (gy - 9) / 22) + 0.8 ? 15 : 0;
  }
  // 落地灯：灯杆和灯罩。
  if (gx === 110 && gz === 10 && gy < 28) return 16;
  if (inside(gx, 106, 114) && inside(gz, 6, 14) && inside(gy, 28, 33)) return 11;
  // 柜子。
  if (inside(gx, 6, 25) && inside(gz, 1, 9) && gy <= 35) return 12;
  if (inside(gx, 1, 9) && inside(gz, 24, 47) && gy <= 23) return 12;
  return 0;
};

/** 某个版本的区块：seq 2（AI 重建）起有重建层的体素化结果，seq 3 起有扩展层的方块。 */
export function chunksAt(seq: number): LayerChunk[] {
  if (seq < 2) return [];
  const rebuilt = chunksFrom('rebuilt', [0, 0, 0], [120, 57, 100], rebuiltRoom);
  if (seq < 3) return rebuilt;
  return [
    ...rebuilt,
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
