import { sha256Hex } from './hash.js';

/**
 * 规范化 JSON 与内容哈希（docs/SHAPES.md 第 5 节，Rust `canonical.rs` 的移植）：
 *
 * - 对象的键按 Unicode 码点排序（不是 JavaScript 默认的 UTF-16 码元顺序）；
 * - 不留空白；
 * - 数字用最短的往返表示（与 `Number.prototype.toString` 一致，`-0` 写成 `0`）；
 * - 整数必须在 ±(2^53 − 1) 以内，超出就拒绝；
 * - 字符串按 JSON 标准转义（与 `JSON.stringify` 一致）。
 *
 * 内容哈希 = 规范化字符串的 UTF-8 字节做 sha256，小写十六进制。
 */

export class CanonicalError extends Error {
  constructor(
    readonly path: string,
    readonly code: 'unsafe_integer' | 'non_finite' | 'unsupported',
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'CanonicalError';
  }
}

/** 按码点比较两个字符串。 */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  const restA = a.length - i;
  const restB = b.length - j;
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

function unsafeInteger(path: string): CanonicalError {
  return new CanonicalError(path, 'unsafe_integer', '整数超出 ±(2^53 − 1) 的安全范围');
}

/**
 * 写数字。`checkUnsafe` 时把超出安全范围的整数值当作错误：JavaScript 把它写进 JSON 时
 * 是一串不带小数点的数字，Rust 端会按整数解析并拒绝。
 */
function writeNumber(value: number, path: string, checkUnsafe: boolean): string {
  if (!Number.isFinite(value)) throw new CanonicalError(path, 'non_finite', '数字必须是有限值');
  if (checkUnsafe && Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw unsafeInteger(path);
  }
  if (Object.is(value, -0)) return '0';
  return String(value);
}

function write(value: unknown, out: string[], path: string, checkUnsafe = true): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(writeNumber(value, path, checkUnsafe));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalError(path, 'unsupported', `不支持的类型 ${typeof value}`);
  }
  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, index) => {
      if (index > 0) out.push(',');
      write(item, out, `${path}[${index}]`, checkUnsafe);
    });
    out.push(']');
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodePoints);
  out.push('{');
  keys.forEach((key, index) => {
    if (index > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    write(record[key], out, `${path}.${key}`, checkUnsafe);
  });
  out.push('}');
}

type ReviverContext = { readonly source?: string };

/** 把 JSON 值写成规范化字符串。对象里值为 `undefined` 的键视为不存在。 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out, '$');
  return out.join('');
}

/** 规范化之后取 sha256 的小写十六进制，即内容哈希。 */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * 解析 JSON 文本并规范化。和 Rust 一样按字面写法区分整数和浮点数：不带小数点和
 * 指数的整数超出安全范围就拒绝；`1e16` 这样的浮点写法照常输出。
 */
export function canonicalizeText(text: string): string {
  // node 22 的 JSON.parse 会给 reviver 第三个参数 { source }（数字的原始写法）。
  const reviver = (_key: string, parsed: unknown, context?: ReviverContext): unknown => {
    const source = context?.source;
    if (
      typeof parsed === 'number' &&
      source !== undefined &&
      /^-?\d+$/.test(source) &&
      !Number.isSafeInteger(Number(source))
    ) {
      throw unsafeInteger('$');
    }
    return parsed;
  };
  const value: unknown = JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
  const out: string[] = [];
  write(value, out, '$', false);
  return out.join('');
}
