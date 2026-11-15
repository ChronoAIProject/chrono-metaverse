/** 时间轴的范围：第一次提交前一天到现在（或最后一次提交、当前时刻里最晚的）。 */
export function timelineRange(commitTimes: readonly number[], now: number, time: number) {
  const first = commitTimes.length > 0 ? Math.min(...commitTimes) : now - 7 * 86_400_000;
  const last = commitTimes.length > 0 ? Math.max(...commitTimes) : now;
  const to = Math.max(now, last, time);
  const from = Math.min(first - 86_400_000, to - 86_400_000);
  return { from, to };
}
