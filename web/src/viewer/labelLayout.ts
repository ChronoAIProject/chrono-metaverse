/**
 * 锚点标签的取舍（纯计算，单元测试直接验证）。
 *
 * 真实扫描里每个重建出的物体都有一个锚点，几十个标签全画出来会把场景盖住。默认只显示"有意义"的：
 *
 * - 有事件状态或事件显示的锚点（最优先）；
 * - `table`、`counter`，其次 `door`，再其次 `zone`；
 * - `seat`、`camera` 和不认识的类型默认不显示，鼠标悬停（手机上点按）物件或锚点时才显示。
 *
 * 然后在屏幕空间里做简单的避让：按优先级从高到低放，和已经放下的标签重叠的就不放；
 * 屏幕上很小（离得远、物体本身小）的锚点不放标签；总数有上限。
 * 悬停 / 点按的那个总是显示。"显示全部标签"打开时不做取舍（剖切和画面外的仍然隐藏）。
 */

/** 默认显示的锚点类型和优先级；不在表里的（seat、camera、未分类）是 0，默认不显示。 */
const KIND_PRIORITY: Readonly<Record<string, number>> = {
  table: 3,
  counter: 3,
  door: 2,
  zone: 1,
};

/** 有事件状态 / 事件显示的锚点：高于所有类型。 */
export const EVENT_PRIORITY = 10;

/** 锚点标签的优先级；0 表示默认不显示。 */
export function anchorLabelPriority(kind: string, hasEvent: boolean): number {
  if (hasEvent) return EVENT_PRIORITY;
  return KIND_PRIORITY[kind] ?? 0;
}

export interface LabelCandidate {
  readonly key: string;
  /** 标签中心在画面里的位置（像素，左上角为原点）。 */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly priority: number;
  /** 锚点（或挂在上面的物件）在屏幕上的大小（像素）。 */
  readonly screenSize: number;
  /** 悬停或点按中：总是显示。 */
  readonly forced: boolean;
}

export interface LabelLayoutOptions {
  readonly showAll: boolean;
  /** 最多显示几个（悬停 / 点按的那个不算在限制里）。 */
  readonly maxLabels: number;
  /** 屏幕上小于这个像素数的锚点不放标签（有事件的除外）。 */
  readonly minScreenSize: number;
  /** 标签之间至少隔开的像素。 */
  readonly padding: number;
}

/** 屏幕上小于这个大小（像素）的锚点默认不放标签。 */
export const MIN_SCREEN_SIZE = 28;
export const LABEL_PADDING = 4;

/** 按画面大小定标签数上限：宽屏 10 个，手机 4 个。 */
export function maxLabelsFor(width: number, height: number): number {
  return Math.min(10, Math.max(4, Math.round((width * height) / 110_000)));
}

/**
 * 估计标签的像素大小（不读 DOM，避免每帧触发重新排版）。
 * 和 Viewer.css 里 .viewer__anchor 的字号、内边距对应：中文字约 12 像素宽，其他字符约 7 像素。
 */
export function estimateLabelSize(text: string): { width: number; height: number } {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code > 0x2e80 ? 12 : 7;
  }
  return { width: width + 18, height: 24 };
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function rectOf(candidate: LabelCandidate, padding: number): Rect {
  return {
    left: candidate.x - candidate.width / 2 - padding,
    right: candidate.x + candidate.width / 2 + padding,
    top: candidate.y - candidate.height / 2 - padding,
    bottom: candidate.y + candidate.height / 2 + padding,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 决定哪些标签显示。候选只包括没被剖切掉、在画面里的锚点。 */
export function layoutLabels(
  candidates: readonly LabelCandidate[],
  options: LabelLayoutOptions,
): Set<string> {
  if (options.showAll) return new Set(candidates.map((c) => c.key));
  const eligible = candidates.filter(
    (c) =>
      c.forced ||
      (c.priority > 0 && (c.priority >= EVENT_PRIORITY || c.screenSize >= options.minScreenSize)),
  );
  // 悬停的最先放；然后按优先级，同级的大的（近的）先放；再按编号，结果稳定不闪。
  eligible.sort(
    (a, b) =>
      Number(b.forced) - Number(a.forced) ||
      b.priority - a.priority ||
      b.screenSize - a.screenSize ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const shown = new Set<string>();
  const placed: Rect[] = [];
  let count = 0;
  for (const candidate of eligible) {
    const rect = rectOf(candidate, options.padding / 2);
    if (!candidate.forced) {
      if (count >= options.maxLabels) continue;
      if (placed.some((other) => overlaps(rect, other))) continue;
      count += 1;
    }
    placed.push(rect);
    shown.add(candidate.key);
  }
  return shown;
}
