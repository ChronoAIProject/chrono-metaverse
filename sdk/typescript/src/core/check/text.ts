import { crc32, inflateRawSync } from 'node:zlib';
import { BUNDLE_FORMAT, BUNDLE_VERSION } from '../bundle.js';
import { MAX_OPS_INFLATED_BYTES, MAX_RECORD_BYTES } from '../limits.js';
import {
  CHECK_VERSION,
  reject,
  startsWith,
  utf8,
  type ByteSource,
  type PlainCheck,
} from './types.js';

/**
 * 文本类和小格式的检查（docs/design/server-slim.md 4.4），规则和拒绝码与接口服务的上传核对（Rust
 * `runner/verify/text.rs`、`ndjson.rs`）相同：
 *
 * - `drc`（扫描）：`DRACO` 魔数、主版本 1 或 2、编码类型是三角网格（`drc_header`）；
 * - `obj`（扫描）：整份不含 NUL，开头 1 MiB 里第一个非空、非注释行以常见关键字开头（`obj_header`）；
 * - `script`：UTF-8，不含 NUL（`text_encoding`）；
 * - `ops`：NDJSON，可 gzip（只认一个成员）；每行 ≤ 64 KiB、UTF-8、去掉空白后以 `{` 开头，解压后
 *   ≤ 256 MiB（`ndjson_line`、`ndjson_too_large`、`gzip`；声明的格式与 gzip 头不符是 `format_mismatch`）；
 * - `bundle`（重建包清单）：外层 `format`、`version` 对得上，`files` 是数组（`json_structure`；完整校验
 *   在 `core/bundle.ts`）。
 */

/** 一次读多少字节（扫描的 obj 可能有 1 GiB，按块读）。 */
const BLOCK = 4 * 1024 * 1024;
/** OBJ 的第一个关键字最多在前面多少字节里找。 */
const OBJ_KEYWORD_WINDOW = 1024 * 1024;
const OBJ_KEYWORDS = new Set([
  'v',
  'vt',
  'vn',
  'vp',
  'f',
  'l',
  'p',
  'o',
  'g',
  's',
  'mtllib',
  'usemtl',
]);

/** Rust `char::is_whitespace` 的字符（与 JavaScript 的 `\s` 不同：不含 U+FEFF）。 */
const WHITESPACE =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const TRIM = new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, 'gu');
const SPLIT = new RegExp(`[${WHITESPACE}]+`, 'u');

function rustTrim(text: string): string {
  return text.replace(TRIM, '');
}

export async function readAll(source: ByteSource): Promise<Uint8Array> {
  const bytes = await source.read(0, source.size);
  if (bytes.length !== source.size) reject('format_mismatch', '文件读不全');
  return bytes;
}

export async function checkDraco(source: ByteSource): Promise<PlainCheck> {
  const head = await source.read(0, 11);
  if (head.length < 11 || !startsWith(head, 'DRACO')) {
    reject('drc_header', '不是 Draco 文件（缺少 DRACO 魔数）');
  }
  const [major, minor] = [head[5]!, head[6]!];
  if (major !== 1 && major !== 2) reject('drc_header', `不支持的 Draco 版本 ${major}.${minor}`);
  if (head[7] !== 1) reject('drc_header', 'Draco 文件不是三角网格（可能是点云）');
  return { v: CHECK_VERSION, format: 'drc' };
}

export async function checkObj(source: ByteSource): Promise<PlainCheck> {
  let line: number[] = [];
  let scanned = 0;
  let found = false;
  const checkLine = (): boolean => {
    const text = rustTrim(new TextDecoder('utf-8').decode(Uint8Array.from(line)));
    if (text === '' || text.startsWith('#')) return false;
    if (OBJ_KEYWORDS.has(text.split(SPLIT)[0]!)) return true;
    return reject('obj_header', 'OBJ 文件的第一行数据不是几何关键字');
  };
  for (let offset = 0; offset < source.size; offset += BLOCK) {
    const block = await source.read(offset, BLOCK);
    if (block.includes(0)) reject('obj_header', 'OBJ 文件里有 NUL 字符');
    if (found) continue;
    for (const byte of block) {
      scanned += 1;
      if (scanned > OBJ_KEYWORD_WINDOW) reject('obj_header', 'OBJ 文件开头 1 MiB 里没有几何数据');
      if (byte === 0x0a || byte === 0x0d) {
        if (checkLine()) {
          found = true;
          break;
        }
        line = [];
      } else if (line.length < 256) {
        line.push(byte);
      }
    }
  }
  if (!found && !checkLine()) reject('obj_header', 'OBJ 文件里没有几何数据');
  return { v: CHECK_VERSION, format: 'obj' };
}

export async function checkScript(source: ByteSource): Promise<PlainCheck> {
  const bytes = await readAll(source);
  if (bytes.includes(0)) reject('text_encoding', '文本里有 NUL 字符');
  if (utf8(bytes) === null) reject('text_encoding', '不是合法的 UTF-8');
  return { v: CHECK_VERSION, format: 'text' };
}

/** 只认一个 gzip 成员：解出数据，核对校验值和长度，成员后面不能再有数据。 */
function gunzipOne(bytes: Uint8Array): Uint8Array {
  const broken = (message: string): never => reject('gzip', message);
  if (bytes.length < 18 || bytes[2] !== 8) broken('gzip 头不对或数据不完整');
  const flags = bytes[3]!;
  let at = 10;
  if (flags & 0x04) {
    if (at + 2 > bytes.length) broken('gzip 头不完整');
    at += 2 + (bytes[at]! | (bytes[at + 1]! << 8));
  }
  for (const flag of [0x08, 0x10]) {
    if (flags & flag) {
      const end = bytes.indexOf(0, at);
      if (end === -1) broken('gzip 头不完整');
      at = end + 1;
    }
  }
  if (flags & 0x02) at += 2;
  if (at > bytes.length) broken('gzip 头不完整');
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateRawSync(bytes.subarray(at), {
      info: true,
      maxOutputLength: MAX_OPS_INFLATED_BYTES,
    }) as unknown as typeof result;
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      return reject('ndjson_too_large', `操作文件解压后超过 ${MAX_OPS_INFLATED_BYTES} 字节`);
    }
    return broken('gzip 数据无法解压');
  }
  const end = at + result.engine.bytesWritten;
  if (end + 8 > bytes.length) broken('gzip 数据不完整');
  if (end + 8 < bytes.length) broken('gzip 数据结束之后还有多余的字节（只接受一个 gzip 成员）');
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + end, 8);
  const output = result.buffer;
  if (
    trailer.getUint32(0, true) !== crc32(output) ||
    trailer.getUint32(4, true) !== output.length % 2 ** 32
  ) {
    broken('gzip 的校验值或长度不对');
  }
  return output;
}

/** NDJSON 的每一行：≤ 64 KiB、UTF-8、去掉空白后以 `{` 开头；空行跳过。 */
function checkLines(text: Uint8Array): void {
  if (text.length > MAX_OPS_INFLATED_BYTES) {
    reject('ndjson_too_large', `操作文件解压后超过 ${MAX_OPS_INFLATED_BYTES} 字节`);
  }
  let start = 0;
  for (let number = 1; start <= text.length; number += 1) {
    let end = text.indexOf(0x0a, start);
    const last = end === -1;
    if (last) end = text.length;
    if (end - start > MAX_RECORD_BYTES) {
      reject('ndjson_line', `第 ${number} 行超过 ${MAX_RECORD_BYTES} 字节`);
    }
    const line = utf8(text.subarray(start, end));
    if (line === null) reject('ndjson_line', `第 ${number} 行不是合法的 UTF-8`);
    const trimmed = rustTrim(line);
    if (trimmed !== '' && !trimmed.startsWith('{')) {
      reject('ndjson_line', `第 ${number} 行不是 JSON 对象`);
    }
    if (last) break;
    start = end + 1;
  }
}

/** 操作文件。`gzip`：声明的格式是不是 gzip（不给就按魔数认）。 */
export async function checkOps(source: ByteSource, gzip?: boolean): Promise<PlainCheck> {
  const bytes = await readAll(source);
  const compressed = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (gzip !== undefined && gzip !== compressed) {
    reject(
      'format_mismatch',
      gzip ? '声明的是 gzip，文件却没有 gzip 头' : '声明的是 ndjson，文件却是 gzip 压缩的',
    );
  }
  checkLines(compressed ? gunzipOne(bytes) : bytes);
  return { v: CHECK_VERSION, format: compressed ? 'gzip' : 'ndjson' };
}

/** 重建包清单的外层（完整校验在 `core/bundle.ts`）。 */
export async function checkBundleOuter(source: ByteSource): Promise<PlainCheck> {
  const text = utf8(await readAll(source));
  let value: unknown;
  try {
    value = JSON.parse(text ?? '');
  } catch {
    reject('json_structure', '清单不是合法的 JSON 对象');
  }
  const outer = value as Record<string, unknown> | null;
  if (
    typeof outer !== 'object' ||
    outer === null ||
    Array.isArray(outer) ||
    typeof outer.format !== 'string' ||
    typeof outer.version !== 'number' ||
    !Number.isInteger(outer.version) ||
    outer.version < 0 ||
    !Array.isArray(outer.files)
  ) {
    return reject(
      'json_structure',
      '清单的外层要有 format（字符串）、version（整数）和 files（数组）',
    );
  }
  if (outer.format !== BUNDLE_FORMAT || outer.version !== BUNDLE_VERSION) {
    reject('json_structure', `清单的 format、version 必须是 ${BUNDLE_FORMAT} 和 ${BUNDLE_VERSION}`);
  }
  return { v: CHECK_VERSION, format: 'json' };
}
