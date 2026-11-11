import { describe, expect, it } from 'vitest';
import type { EntityBody } from '../core/api/types';
import { backgroundLandmark, backgroundView } from './background';

function entity(props: EntityBody['props']): EntityBody {
  return { entityId: 'sample-context', layer: 'ext', kind: 'object', props };
}

describe('通用场景背景配置', () => {
  it('从任意场景读取坐标、距离、标签与返回范围', () => {
    const marker = {
      label: '山顶观景台',
      position: [125, 75, -36],
      minDistance: 250,
      focusBounds: { min: [120, 70, -40], max: [130, 78, -30] },
    };
    const item = entity({
      background: true,
      backgroundView: { focus: [125, 74, -35], minDistance: 200, maxDistance: 900 },
      landmark: marker,
    });
    expect(backgroundView(item)).toEqual({ focus: [125, 74, -35], min: 200, max: 900 });
    expect(backgroundLandmark(item)).toEqual({
      label: marker.label,
      position: marker.position,
      minDistance: marker.minDistance,
      bounds: marker.focusBounds,
    });
  });

  it('配置只作用于背景，不改变普通物件的显示', () => {
    const item = entity({ backgroundView: { focus: [0, 0, 0], minDistance: 20 } });
    expect(backgroundView(item)).toBeNull();
    expect(backgroundLandmark(item)).toBeNull();
  });

  it('忽略非有限坐标、倒置距离和空范围，避免无效元数据影响查看器', () => {
    expect(
      backgroundView(entity({ background: true, backgroundView: { focus: [NaN, 0, 0] } })),
    ).toBeNull();
    expect(
      backgroundView(
        entity({
          background: true,
          backgroundView: { focus: [0, 0, 0], minDistance: 50, maxDistance: 30 },
        }),
      ),
    ).toBeNull();
    expect(
      backgroundLandmark(
        entity({
          background: true,
          landmark: {
            label: '入口',
            position: [0, 0, 0],
            focusBounds: { min: [0, 0, 0], max: [0, 1, 1] },
          },
        }),
      ),
    ).toBeNull();
  });
});
