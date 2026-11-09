/**
 * 编号格式（Rust `ids.rs` 的移植）。编号会出现在路径参数里（NyxID 操作范围按路径参数
 * 限制），所以只允许不需要转义的字符，并且不含 `:`（作用范围写成 `plot:<编号>`）。
 */

/** 空间、组合编号：3–64 个字符，小写字母、数字和 `-`，首尾不能是 `-`。 */
export function isSpaceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,62})[a-z0-9]$/.test(value);
}

/**
 * 物件、锚点、区域、地块、数据源、模板、草稿等编号：1–128 个字符，字母、数字、`-`、`_`、`.`；
 * 不能以 `.` 开头。以 `_` 开头的编号是保留的（目前只有 `_space`），由调用方单独判断。
 */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(value);
}

/** NyxID 主体编号（用户、组织）：只认规范编号，不认 slug。 */
export function isSubjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

/** 空间级保留锚点：营业状态这类针对整个空间的事件挂在它上面。 */
export const SPACE_ANCHOR_ID = '_space';
