import { deflateSync, inflateSync } from 'node:zlib';
import { sha256Hex } from './hash.js';

/**
 * 区块编码（设计 4.2、SHAPES 4；Rust `chunk.rs` 的移植）。
 *
 * - 区块是 32×32×32 个 uint16，下标 `index = x + 32·(z + 32·y)`；
 * - 规范字节：按下标顺序写小端 uint16，共 65,536 字节；
 * - 区块哈希：`sha256(0x01 ‖ 规范字节)` 的小写十六进制；
 * - 存储：zlib 压缩，哈希按未压缩的规范字节算。
 */

export const CHUNK_SIZE = 32;
export const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_BYTES = CHUNK_CELLS * 2;
export const CHUNK_FORMAT_VERSION = 0x01;

/** 0：空，或者扩展层里"不覆盖"。 */
export const BLOCK_EMPTY = 0;
/** 1：空气覆盖，只在扩展层有效，用来删掉下层的方块。 */
export const BLOCK_AIR = 1;
/** 方块表的编号从 2 开始。 */
export const FIRST_PALETTE_BLOCK = 2;

export type Layer = 'rebuilt' | 'ext';

export interface ChunkKey {
  readonly layer: Layer;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

export class ChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkError';
  }
}

/** 区块内坐标 → 下标。坐标超出 0..32 时返回 null。 */
export function cellIndex(x: number, y: number, z: number): number | null {
  if (x < 0 || y < 0 || z < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE || z >= CHUNK_SIZE) {
    return null;
  }
  return x + CHUNK_SIZE * (z + CHUNK_SIZE * y);
}

export function emptyChunk(): Uint16Array {
  return new Uint16Array(CHUNK_CELLS);
}

/** 全 0 的区块不进清单。 */
export function isEmptyChunk(cells: Uint16Array): boolean {
  for (let i = 0; i < cells.length; i += 1) if (cells[i] !== BLOCK_EMPTY) return false;
  return true;
}

export function nonZeroCount(cells: Uint16Array): number {
  let count = 0;
  for (let i = 0; i < cells.length; i += 1) if (cells[i] !== BLOCK_EMPTY) count += 1;
  return count;
}

/** 格子值 → 规范字节（显式小端）。 */
export function encodeChunk(cells: Uint16Array): Uint8Array {
  if (cells.length !== CHUNK_CELLS) {
    throw new ChunkError(`区块必须有 ${CHUNK_CELLS} 个格子，实际 ${cells.length}`);
  }
  const bytes = new Uint8Array(CHUNK_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < CHUNK_CELLS; i += 1) view.setUint16(i * 2, cells[i]!, true);
  return bytes;
}

/** 规范字节 → 格子值。 */
export function decodeChunk(bytes: Uint8Array): Uint16Array {
  if (bytes.length !== CHUNK_BYTES) throw new ChunkError('规范字节必须正好 65536 字节');
  const cells = new Uint16Array(CHUNK_CELLS);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < CHUNK_CELLS; i += 1) cells[i] = view.getUint16(i * 2, true);
  return cells;
}

/** 区块哈希：`sha256(0x01 ‖ 规范字节)`。参数可以是格子值或规范字节。 */
export function chunkHash(chunk: Uint16Array | Uint8Array): string {
  const bytes = chunk instanceof Uint16Array ? encodeChunk(chunk) : chunk;
  if (bytes.length !== CHUNK_BYTES) throw new ChunkError('规范字节必须正好 65536 字节');
  const prefixed = new Uint8Array(CHUNK_BYTES + 1);
  prefixed[0] = CHUNK_FORMAT_VERSION;
  prefixed.set(bytes, 1);
  return sha256Hex(prefixed);
}

/** 存储格式：规范字节的 zlib 压缩。 */
export function compressChunk(cells: Uint16Array): Uint8Array {
  return new Uint8Array(deflateSync(encodeChunk(cells)));
}

/**
 * 解压存储格式并解码；给了 `expectedHash` 时核对哈希。解压结果最多 65,537 字节，
 * 压缩炸弹会被拒绝。
 */
export function decompressChunk(compressed: Uint8Array, expectedHash?: string): Uint16Array {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(inflateSync(compressed, { maxOutputLength: CHUNK_BYTES + 1 }));
  } catch {
    throw new ChunkError('压缩数据无法解压');
  }
  if (bytes.length !== CHUNK_BYTES) throw new ChunkError('压缩数据无法解压');
  if (expectedHash !== undefined && chunkHash(bytes) !== expectedHash) {
    throw new ChunkError(`区块哈希不一致：期望 ${expectedHash}`);
  }
  return decodeChunk(bytes);
}

/** 格坐标 → [区块坐标, 区块内坐标]。负坐标按向下取整处理。 */
export function locateCell(cell: readonly number[]): [[number, number, number], [number, number, number]] {
  const chunk: [number, number, number] = [0, 0, 0];
  const local: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const v = cell[axis]!;
    const c = Math.floor(v / CHUNK_SIZE);
    chunk[axis] = c;
    local[axis] = v - c * CHUNK_SIZE;
  }
  return [chunk, local];
}

/** 区块键的字符串形式（Map 用）：`layer:cx:cy:cz`。 */
export function chunkKeyString(key: ChunkKey): string {
  return `${key.layer}:${key.cx}:${key.cy}:${key.cz}`;
}

export function parseChunkKey(text: string): ChunkKey {
  const [layer, cx, cy, cz] = text.split(':');
  return { layer: layer as Layer, cx: Number(cx), cy: Number(cy), cz: Number(cz) };
}

const LAYER_ORDER: Record<Layer, number> = { rebuilt: 0, ext: 1 };

/** 与 Rust `ChunkKey` 的 `Ord` 相同：先图层（rebuilt < ext），再 cx、cy、cz。 */
export function compareChunkKeys(a: ChunkKey, b: ChunkKey): number {
  return (
    LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] || a.cx - b.cx || a.cy - b.cy || a.cz - b.cz
  );
}
