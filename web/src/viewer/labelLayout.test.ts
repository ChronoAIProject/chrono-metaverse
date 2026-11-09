import { describe, expect, it } from 'vitest';
import {
  EVENT_PRIORITY,
  anchorLabelPriority,
  estimateLabelSize,
  layoutLabels,
  maxLabelsFor,
  type LabelCandidate,
  type LabelLayoutOptions,
} from './labelLayout';

const OPTIONS: LabelLayoutOptions = {
  showAll: false,
  maxLabels: 10,
  minScreenSize: 28,
  padding: 4,
};

function label(key: string, x: number, y: number, extra: Partial<LabelCandidate> = {}) {
  return {
    key,
    x,
    y,
    width: 60,
    height: 24,
    priority: 1,
    screenSize: 100,
    forced: false,
    ...extra,
  } satisfies LabelCandidate;
}

const shown = (candidates: LabelCandidate[], options: Partial<LabelLayoutOptions> = {}) =>
  [...layoutLabels(candidates, { ...OPTIONS, ...options })].sort();

describe('锚点标签的优先级', () => {
  it('桌子和前台最高，其次门，再其次区域；座位、摄像头、未分类默认不显示', () => {
    expect(anchorLabelPriority('table', false)).toBe(3);
    expect(anchorLabelPriority('counter', false)).toBe(3);
    expect(anchorLabelPriority('door', false)).toBe(2);
    expect(anchorLabelPriority('zone', false)).toBe(1);
    for (const kind of ['seat', 'camera', 'space', 'shelf', '']) {
      expect(anchorLabelPriority(kind, false)).toBe(0);
    }
  });

  it('有事件的锚点（包括座位）高于所有类型', () => {
    expect(anchorLabelPriority('seat', true)).toBe(EVENT_PRIORITY);
    expect(anchorLabelPriority('zone', true)).toBeGreaterThan(anchorLabelPriority('table', false));
  });
});

describe('锚点标签的取舍', () => {
  it('默认不显示优先级为 0 的；悬停 / 点按的总是显示；"显示全部"不做取舍', () => {
    const candidates = [
      label('table', 100, 100, { priority: 3 }),
      label('seat', 300, 100, { priority: 0 }),
      label('hover-seat', 500, 100, { priority: 0, forced: true }),
    ];
    expect(shown(candidates)).toEqual(['hover-seat', 'table']);
    expect(shown(candidates, { showAll: true })).toEqual(['hover-seat', 'seat', 'table']);
  });

  it('屏幕上太小的锚点不放标签，有事件的除外', () => {
    const candidates = [
      label('far-zone', 100, 100, { screenSize: 12 }),
      label('far-event', 300, 100, { screenSize: 12, priority: EVENT_PRIORITY }),
      label('near-zone', 500, 100, { screenSize: 40 }),
    ];
    expect(shown(candidates)).toEqual(['far-event', 'near-zone']);
  });

  it('重叠时保留优先级高的：有事件的 > 桌子 / 前台 > 门 > 区域', () => {
    const candidates = [
      label('zone', 100, 100, { priority: 1, screenSize: 500 }),
      label('door', 110, 105, { priority: 2 }),
      label('table', 120, 110, { priority: 3 }),
      label('event', 130, 115, { priority: EVENT_PRIORITY, screenSize: 30 }),
    ];
    expect(shown(candidates)).toEqual(['event']);
    expect(shown(candidates.slice(0, 3))).toEqual(['table']);
    expect(shown(candidates.slice(0, 2))).toEqual(['door']);
  });

  it('同一优先级里屏幕上大的（近的）先放；完全相同时按编号，结果稳定', () => {
    expect(shown([label('small', 100, 100, { screenSize: 40 }), label('big', 120, 100)])).toEqual([
      'big',
    ]);
    expect(shown([label('b', 100, 100), label('a', 120, 100)])).toEqual(['a']);
  });

  it('隔开足够远的标签都显示；边距算在重叠里', () => {
    // 宽 60：中心相距 64 刚好隔开 4 像素（padding），相距 62 就算重叠。
    expect(shown([label('a', 100, 100), label('b', 164, 100)])).toEqual(['a', 'b']);
    expect(shown([label('a', 100, 100), label('b', 162, 100)])).toEqual(['a']);
  });

  it('总数有上限；悬停的不占名额，压住的其他标签让开', () => {
    const grid = Array.from({ length: 30 }, (_, i) =>
      label(`z${String(i).padStart(2, '0')}`, 100 + (i % 6) * 200, 100 + Math.floor(i / 6) * 100),
    );
    expect(shown(grid)).toHaveLength(10);
    const hovered = label('hover', 100, 100, { priority: 0, forced: true });
    const result = shown([...grid, hovered]);
    expect(result).toHaveLength(11);
    expect(result).toContain('hover');
    // 和悬停标签重叠的 z00 让开了。
    expect(result).not.toContain('z00');
  });

  it('按画面大小定上限：宽屏 10 个，手机 4 个', () => {
    expect(maxLabelsFor(1440, 775)).toBe(10);
    expect(maxLabelsFor(390, 560)).toBe(4);
    expect(maxLabelsFor(900, 600)).toBe(5);
  });

  it('标签大小按字数估计：中文字比英文字母宽', () => {
    const chinese = estimateLabelSize('前台');
    const latin = estimateLabelSize('AB');
    expect(chinese.width).toBeGreaterThan(latin.width);
    expect(estimateLabelSize('1 号桌 · 有人 3 位').width).toBeGreaterThan(chinese.width);
    expect(chinese.height).toBe(24);
  });
});
