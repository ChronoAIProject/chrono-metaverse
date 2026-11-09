import { unzlibSync, zlibSync } from 'fflate';
import { sha256Hex } from './hash';

/**
 * 区块编码（docs/SHAPES.md 第 4 节、设计 4.2）。
 *
 * 区块是 32×32×32 个 uint16，下标 `index = x + 32·(z + 32·y)`，小端字节序，共 65,536 字节，
 * 这是"规范字节"。区块哈希 = sha256(0x01 ‖ 规范字节) 的小写十六进制；存储用 zlib 压缩，
 * 哈希按未压缩的规范字节算。
 */

export const CHUNK_SIZE = 32;
export const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_BYTES = CHUNK_CELLS * 2;
export const CHUNK_FORMAT_VERSION = 0x01;

/** 网格单位（米）：只用于定位、区域和地块边界、方块。形状尺寸是连续值。 */
export const GRID_UNIT = 0.05;

/** 保留编号：0 表示空或不覆盖。 */
export const BLOCK_EMPTY = 0;
/** 保留编号：1 表示空气覆盖，只在扩展层有效，用来删除下层的方块。 */
export const BLOCK_AIR = 1;
/** 方块表编号从 2 开始。 */
export const FIRST_PALETTE_ID = 2;

export class ChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkError';
  }
}

/** 区块内坐标到规范下标。 */
export function chunkIndex(x: number, y: number, z: number): number {
  return x + CHUNK_SIZE * (z + CHUNK_SIZE * y);
}

/** 规范下标到区块内坐标 [x, y, z]。 */
export function chunkCoords(index: number): [number, number, number] {
  const x = index % CHUNK_SIZE;
  const z = Math.floor(index / CHUNK_SIZE) % CHUNK_SIZE;
  const y = Math.floor(index / (CHUNK_SIZE * CHUNK_SIZE));
  return [x, y, z];
}

/** 新建一个全 0 的区块。 */
export function emptyChunk(): Uint16Array {
  return new Uint16Array(CHUNK_CELLS);
}

export function isEmptyChunk(cells: Uint16Array): boolean {
  return cells.every((value) => value === BLOCK_EMPTY);
}

/** 格子值到规范字节（显式小端，不依赖运行平台的字节序）。 */
export function encodeChunk(cells: Uint16Array): Uint8Array {
  if (cells.length !== CHUNK_CELLS) {
    throw new ChunkError(`区块必须有 ${CHUNK_CELLS} 个格子，实际 ${cells.length}`);
  }
  const bytes = new Uint8Array(CHUNK_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < CHUNK_CELLS; i += 1) view.setUint16(i * 2, cells[i] ?? 0, true);
  return bytes;
}

/** 规范字节到格子值。 */
export function decodeChunk(bytes: Uint8Array): Uint16Array {
  if (bytes.length !== CHUNK_BYTES) {
    throw new ChunkError(`规范字节必须是 ${CHUNK_BYTES} 字节，实际 ${bytes.length}`);
  }
  const cells = new Uint16Array(CHUNK_CELLS);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < CHUNK_CELLS; i += 1) cells[i] = view.getUint16(i * 2, true);
  return cells;
}

/** 区块哈希：sha256(0x01 ‖ 规范字节)。参数可以是格子值或规范字节。 */
export function chunkHash(chunk: Uint16Array | Uint8Array): string {
  const bytes = chunk instanceof Uint16Array ? encodeChunk(chunk) : chunk;
  if (bytes.length !== CHUNK_BYTES) {
    throw new ChunkError(`规范字节必须是 ${CHUNK_BYTES} 字节，实际 ${bytes.length}`);
  }
  const prefixed = new Uint8Array(CHUNK_BYTES + 1);
  prefixed[0] = CHUNK_FORMAT_VERSION;
  prefixed.set(bytes, 1);
  return sha256Hex(prefixed);
}

/** 存储格式：规范字节的 zlib 压缩。 */
export function compressChunk(cells: Uint16Array): Uint8Array {
  return zlibSync(encodeChunk(cells), { level: 6 });
}

/**
 * 解压存储格式并解码。给了 `expectedHash` 时核对内容哈希，不一致就报错。
 *
 * 解压缓冲区只比规范大小多 1 字节：解出来超过 65,536 字节的数据（包括压缩炸弹）
 * 会被截断在 65,537 字节并被拒绝，不会占用更多内存。
 */
export function decompressChunk(compressed: Uint8Array, expectedHash?: string): Uint16Array {
  let bytes: Uint8Array;
  try {
    bytes = unzlibSync(compressed, { out: new Uint8Array(CHUNK_BYTES + 1) });
  } catch (cause) {
    throw new ChunkError(`区块解压失败：${(cause as Error).message}`);
  }
  if (bytes.length !== CHUNK_BYTES) {
    throw new ChunkError(
      `区块解压后大小不对：${bytes.length > CHUNK_BYTES ? '超过' : '不足'} ${CHUNK_BYTES} 字节`,
    );
  }
  if (expectedHash !== undefined) {
    const actual = chunkHash(bytes);
    if (actual !== expectedHash.toLowerCase()) {
      throw new ChunkError(`区块哈希不一致：期望 ${expectedHash}，实际 ${actual}`);
    }
  }
  return decodeChunk(bytes);
}
