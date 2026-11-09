import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * SHA-256 的小写十六进制。
 *
 * 用同步实现（@noble/hashes）而不是 WebCrypto：网格生成和区块解码都在同步路径上，
 * 而且同一份代码要在 node（vitest、开发用夹具插件）和浏览器里跑出相同结果。
 */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** 字符串按 UTF-8 编码后取 SHA-256。 */
export function sha256HexOfText(text: string): string {
  return sha256Hex(utf8ToBytes(text));
}

export { utf8ToBytes };
