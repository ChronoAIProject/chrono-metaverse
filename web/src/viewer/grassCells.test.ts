import { describe, expect, it } from 'vitest';
import { grassCells } from './grassCells';

describe('grass cells from flipped map tiles', () => {
  it('removes cells over a blue tile while retaining the original IDs over grass', () => {
    const image = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < image.length; i += 4) image.set([50, 70, 140, 255], i);
    expect([...grassCells(image, 16, 16, 4)]).toEqual([]);
    for (let i = 0; i < image.length; i += 4) image.set([35, 100, 40, 255], i);
    expect([...grassCells(image, 16, 16, 4)]).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('keeps both cells at a bilinear boundary in the correct flipped image row', () => {
    const image = new Uint8ClampedArray(16 * 16 * 4).fill(120);
    image.set([20, 200, 30, 255], (2 * 16 + 4) * 4);
    expect([...grassCells(image, 16, 16, 4)]).toEqual([12, 13]);
  });
});
