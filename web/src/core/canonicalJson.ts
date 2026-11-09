import { sha256HexOfText } from './hash';

/**
 * 规范化 JSON（docs/SHAPES.md 第 5 节）：
 *
 * - 对象的键按 Unicode 码点排序（不是 UTF-16 码元顺序，两者在补充平面字符上不同）；
 * - 不留空白；
 * - 数字用最短的往返表示，整数不带小数点（与 ECMAScript 的 Number#toString 一致，-0 写成 0）；
 * - 字符串用 JSON 标准转义（与 JSON.stringify 一致）。
 *
 * 不接受 NaN、Infinity、undefined、函数、symbol 和 bigint：这些值没有确定的 JSON 表示，
 * 静默丢掉会让两边算出不同的哈希。
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out, '$');
  return out.join('');
}

/** 规范化之后取 sha256 的小写十六进制，即内容哈希。 */
export function contentHash(value: unknown): string {
  return sha256HexOfText(canonicalJson(value));
}

export class CanonicalJsonError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'CanonicalJsonError';
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

function writeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new CanonicalJsonError(path, '数字必须是有限值');
  if (Object.is(value, -0)) return '0';
  return String(value);
}

function write(value: unknown, out: string[], path: string): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(writeNumber(value, path));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(path, `不支持的类型 ${typeof value}`);
  }
  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((item, index) => {
      if (index > 0) out.push(',');
      write(item, out, `${path}[${index}]`);
    });
    out.push(']');
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  out.push('{');
  keys.forEach((key, index) => {
    if (index > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    write(record[key], out, `${path}.${key}`);
  });
  out.push('}');
}
