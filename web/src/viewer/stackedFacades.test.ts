import { expect, it } from 'vitest';
import { continueStackedFacades, type FacadeSection } from './stackedFacades';

const square = [
  [20, 20],
  [40, 20],
  [40, 40],
  [20, 40],
  [20, 20],
];
function part(vertex: number, bottom: number, top: number, points = square): FacadeSection {
  return {
    outline: points.map(([x, y]) => ({ x: x!, y: y! })),
    extent: 100,
    firstVertex: vertex,
    endVertex: vertex + 1,
    bottom,
    top,
  };
}

it('退台上下分段沿用主楼窗格，相邻楼、裙楼另一座塔及有独立标色的部分保留自己的外墙', () => {
  const setback = [
    [20, 20],
    [40, 20],
    [40, 40],
    [30, 36],
    [20, 20],
  ];
  const neighbour = square.map(([x, y]) => [x! + 20, y!]);
  for (const reverse of [false, true]) {
    const parts = [
      part(0, 0, 40),
      part(1, 42, 96),
      part(2, 99, 150, setback),
      part(3, 42, 120, neighbour),
      { ...part(4, 42, 95), tint: 0x998877 },
    ];
    const facade = [0, 0.1, 42, 1.2, 99, 2.3, 42, 1.4, 42, 1.5];
    continueStackedFacades(reverse ? parts.reverse() : parts, facade);
    expect(facade).toEqual([0, 2.3, 42, 2.3, 99, 2.3, 42, 1.4, 42, 1.5]);
  }
});

it('裁到瓦片边界的分段保持原有的跨片选材', () => {
  const clipped = square.map(([x, y]) => [x! - 20, y!]);
  const facade = [0, 0.1, 40, 2.3];
  continueStackedFacades([part(0, 0, 40, clipped), part(1, 40, 160, clipped)], facade);
  expect(facade).toEqual([0, 0.1, 40, 2.3]);
});
