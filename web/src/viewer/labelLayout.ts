/** 按优先级和屏幕上的实际边界排列场景标签。 */
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
  /** 普通物件同名时，精简模式只取一个。 */
  readonly group?: string;
  /** 悬停、点按或键盘聚焦中。 */
  readonly forced: boolean;
}

export interface LabelLayoutOptions {
  readonly moreLabels: boolean;
  /** 当前画面允许的标签总数。 */
  readonly maxLabels: number;
  /** 屏幕上小于这个像素数的锚点不放标签（有事件的除外）。 */
  readonly minScreenSize: number;
  /** 标签之间至少隔开的像素。 */
  readonly padding: number;
}

/** 屏幕上小于这个大小（像素）的锚点默认不放标签。 */
export const MIN_SCREEN_SIZE = 28;
export const LABEL_PADDING = 8;

/** 精简模式按画面面积显示 2 至 5 个，更多模式将上限翻倍。 */
export function maxLabelsFor(width: number, height: number, moreLabels = false): number {
  const limit = Math.min(5, Math.max(2, Math.round((width * height) / 190_000)));
  return moreLabels ? limit * 2 : limit;
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
  const eligible = candidates.filter(
    (c) =>
      options.moreLabels ||
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
  const groups = new Set<string>();
  for (const candidate of eligible) {
    if (shown.size >= options.maxLabels) break;
    const group = options.moreLabels ? undefined : candidate.group;
    if (group && groups.has(group)) continue;
    const rect = rectOf(candidate, options.padding / 2);
    if (placed.some((other) => overlaps(rect, other))) continue;
    placed.push(rect);
    shown.add(candidate.key);
    if (group) groups.add(group);
  }
  return shown;
}
