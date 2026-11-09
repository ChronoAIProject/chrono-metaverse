import { createHash } from 'node:crypto';

/** 所有哈希都用小写十六进制。 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `sha256(bytes)` 的小写十六进制。 */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 是否是 64 位小写十六进制（区块哈希、内容哈希、资源哈希都用这个格式）。 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
