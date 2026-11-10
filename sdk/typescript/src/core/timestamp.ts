/**
 * RFC 3339 时间（Rust `timestamp.rs` 的 `parse_rfc3339`，按 `time` 库的规则）：
 *
 * - `YYYY-MM-DD`，`T`、`t` 或空格，`hh:mm:ss`，可选的小数秒（至少一位），时区 `Z`、`z` 或 `±hh:mm`；
 * - 日期必须存在（闰年的 2 月 29 日）；时区偏移 ≤ 23:59；
 * - 秒只能到 59，只有 23:59:60（闰秒）按 23:59:59.999 算；
 * - 换算成 UTC 毫秒后在 0000–9999 年之间；整个字符串不超过 64 个字符。
 */

const PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** 0000-01-01T00:00:00.000Z */
const MIN_MILLIS = -62_167_219_200_000;
/** 9999-12-31T23:59:59.999Z */
const MAX_MILLIS = 253_402_300_799_999;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 解析成 UTC 毫秒（不足一毫秒的部分舍去）；不合法时返回 null。 */
export function parseRfc3339(value: string): number | null {
  if (value.length > 64) return null;
  const match = PATTERN.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  let second = Number(match[6]);
  let millis = match[7] === undefined ? 0 : Number(match[7].slice(0, 3).padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59) return null;
  if (second === 60) {
    if (hour !== 23 || minute !== 59) return null;
    second = 59;
    millis = 999;
  } else if (second > 59) {
    return null;
  }
  let offsetMinutes = 0;
  if (match[8] === undefined) {
    const offsetHours = Number(match[10]);
    const offsetMins = Number(match[11]);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (match[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const utc = date.getTime() - offsetMinutes * 60_000;
  return utc >= MIN_MILLIS && utc <= MAX_MILLIS ? utc : null;
}

/** 是否是合法的 RFC 3339 时间。 */
export function isRfc3339(value: unknown): value is string {
  return typeof value === 'string' && parseRfc3339(value) !== null;
}
