import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { canonicalJson, compareCodePoints, contentHash } from './canonicalJson';
import {
  CHUNK_BYTES,
  ChunkError,
  chunkCoords,
  chunkHash,
  chunkIndex,
  compressChunk,
  decodeChunk,
  decompressChunk,
  emptyChunk,
  encodeChunk,
  isEmptyChunk,
} from './chunk';

/*
 * 内联测试向量：期望值用 Python（hashlib、zlib、json）独立算出，
 * 与 docs/SHAPES.md 第 4、5 节的规则逐条对应。正式的跨语言向量放在
 * api/crates/metaverse-core/tests/vectors/，接口服务那边建好后改为读取那批文件。
 */
const CHUNK_VECTOR = {
  cells: [
    { x: 0, y: 0, z: 0, value: 2 },
    { x: 1, y: 2, z: 3, value: 7 },
    { x: 31, y: 31, z: 31, value: 0x1234 },
  ],
  hash: 'ea53612cfad1b51bd66bfc4a41d173cb097b83b94df25bbe1d82846d9b88412a',
  emptyHash: '5524d41599c2176cac9e6e123066487e5795f8ba1bec83f8a80d103c61199b23',
  // Python: zlib.compress(规范字节, 6)
  zlibHex:
    '789cedce310d00300800b085673f5af0af0d1990d02a683c00000080edfe740000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e080ca068bb30050',
};

const CANONICAL_VECTOR = {
  value: {
    b: 1,
    a: [1.5, 2, 'x\n"\u0001'],
    é: true,
    '😀': null,
    '\uffff': 0,
    z: { y: -3.25, x: 0.1, w: 100 },
  },
  text: '{"a":[1.5,2,"x\\n\\"\\u0001"],"b":1,"z":{"w":100,"x":0.1,"y":-3.25},"é":true,"\uffff":0,"😀":null}',
  hash: 'a11fb0b89c460603177d53f07b882d3c1ea6812bfcd23713db18fe4e42d874a3',
};

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function vectorChunk(): Uint16Array {
  const cells = emptyChunk();
  for (const { x, y, z, value } of CHUNK_VECTOR.cells) cells[chunkIndex(x, y, z)] = value;
  return cells;
}

describe('区块编码', () => {
  it('下标顺序是 x + 32·(z + 32·y)', () => {
    expect(chunkIndex(1, 0, 0)).toBe(1);
    expect(chunkIndex(0, 0, 1)).toBe(32);
    expect(chunkIndex(0, 1, 0)).toBe(1024);
    expect(chunkIndex(1, 2, 3)).toBe(2145);
    expect(chunkCoords(2145)).toEqual([1, 2, 3]);
  });

  it('规范字节是小端 uint16', () => {
    const bytes = encodeChunk(vectorChunk());
    expect(bytes.length).toBe(CHUNK_BYTES);
    expect([bytes[4290], bytes[4291]]).toEqual([0x07, 0x00]);
    expect([bytes[CHUNK_BYTES - 2], bytes[CHUNK_BYTES - 1]]).toEqual([0x34, 0x12]);
    expect(decodeChunk(bytes)).toEqual(vectorChunk());
  });

  it('区块哈希 = sha256(0x01 ‖ 规范字节)', () => {
    expect(chunkHash(vectorChunk())).toBe(CHUNK_VECTOR.hash);
    expect(chunkHash(encodeChunk(vectorChunk()))).toBe(CHUNK_VECTOR.hash);
    expect(chunkHash(emptyChunk())).toBe(CHUNK_VECTOR.emptyHash);
    expect(isEmptyChunk(emptyChunk())).toBe(true);
    expect(isEmptyChunk(vectorChunk())).toBe(false);
  });

  it('解开 Python 压缩的区块，并核对哈希', () => {
    const cells = decompressChunk(hexToBytes(CHUNK_VECTOR.zlibHex), CHUNK_VECTOR.hash);
    expect(cells[chunkIndex(1, 2, 3)]).toBe(7);
    expect(cells[chunkIndex(31, 31, 31)]).toBe(0x1234);
  });

  it('自己压缩的能解回原值', () => {
    const cells = vectorChunk();
    expect(decompressChunk(compressChunk(cells), CHUNK_VECTOR.hash)).toEqual(cells);
  });

  it('哈希不一致、大小不对、数据损坏都拒绝', () => {
    const good = compressChunk(vectorChunk());
    expect(() => decompressChunk(good, CHUNK_VECTOR.emptyHash)).toThrow(ChunkError);
    expect(() => decompressChunk(zlibSync(new Uint8Array(100)))).toThrow(/不足/);
    expect(() => decompressChunk(zlibSync(new Uint8Array(CHUNK_BYTES * 4)))).toThrow(/超过/);
    expect(() => decompressChunk(new Uint8Array([1, 2, 3, 4]))).toThrow(ChunkError);
    expect(() => encodeChunk(new Uint16Array(10))).toThrow(ChunkError);
    expect(() => decodeChunk(new Uint8Array(10))).toThrow(ChunkError);
  });
});

describe('规范化 JSON 与内容哈希', () => {
  it('与 Python 独立算出的结果一致（键按码点排序）', () => {
    expect(canonicalJson(CANONICAL_VECTOR.value)).toBe(CANONICAL_VECTOR.text);
    expect(contentHash(CANONICAL_VECTOR.value)).toBe(CANONICAL_VECTOR.hash);
  });

  it('码点顺序与 UTF-16 码元顺序不同：U+FFFF 排在 😀 前面', () => {
    expect(compareCodePoints('\uffff', '😀')).toBeLessThan(0);
    expect(['😀', '\uffff'].sort()).toEqual(['😀', '\uffff']);
    expect(compareCodePoints('a', 'ab')).toBeLessThan(0);
    expect(compareCodePoints('b', 'b')).toBe(0);
  });

  it('数字用最短往返表示，整数不带小数点，-0 写成 0', () => {
    expect(canonicalJson([1, 1.0, 0.1 + 0.2, -0, 1e21, 5e-324])).toBe(
      '[1,1,0.30000000000000004,0,1e+21,5e-324]',
    );
  });

  it('不留空白，嵌套对象也排序', () => {
    expect(canonicalJson({ b: { d: 1, c: [true, null] }, a: '' })).toBe(
      '{"a":"","b":{"c":[true,null],"d":1}}',
    );
  });

  it('拒绝没有确定表示的值', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/有限/);
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson([() => 1])).toThrow();
    expect(() => canonicalJson(1n)).toThrow(/bigint/);
  });
});
