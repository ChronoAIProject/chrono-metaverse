import { describe, expect, it } from 'vitest';
import { AdaptivePixelRatio } from './adaptivePixelRatio';

function run(scale: AdaptivePixelRatio, time: number, interval: number, frames: number) {
  const changes: number[] = [];
  for (let i = 0; i < frames; i++) {
    time += interval;
    const ratio = scale.frame(time, true);
    if (ratio !== undefined) changes.push(ratio);
  }
  return { time, changes };
}

describe('optional supersampling', () => {
  it('requires a stable native cadence, drops under load and waits before retrying', () => {
    const scale = new AdaptivePixelRatio();
    scale.configure(true, 1, 1390, 747);
    let sample = run(scale, 0, 25, 100);
    expect(sample.changes).toEqual([]);
    sample = run(scale, sample.time, 1000 / 60, 180);
    expect(sample.changes).toEqual([1.5]);
    sample = run(scale, sample.time, 25, 60);
    expect(sample.changes).toEqual([1]);
    sample = run(scale, sample.time, 1000 / 60, 200);
    expect(sample.changes).toEqual([]);
    sample = run(scale, sample.time, 1000 / 60, 330);
    expect(sample.changes).toEqual([1.5]);
    expect(scale.frame(sample.time + 120, true)).toBe(1);
  });

  it('restores display density on resize, scene changes and tab suspension', () => {
    const scale = new AdaptivePixelRatio();
    scale.configure(true, 1, 1390, 747);
    let sample = run(scale, 0, 16, 100);
    expect(sample.changes).toEqual([1.5]);
    expect(scale.configure(true, 1, 2400, 1400)).toBe(1);
    expect(run(scale, sample.time, 16, 120).changes).toEqual([]);
    expect(scale.configure(true, 2, 690, 350)).toBe(2);
    expect(run(scale, sample.time, 16, 120).changes).toEqual([]);
    expect(scale.configure(true, 1, 690, 350)).toBe(1);
    sample = run(scale, 8000, 16, 100);
    expect(sample.changes).toEqual([1.5]);
    expect(scale.configure(true, 1, 690, 350)).toBeUndefined();
    expect(scale.frame(sample.time + 16, false)).toBe(1);
    expect(scale.configure(false, 1, 690, 350)).toBeUndefined();
    expect(run(scale, 20000, 16, 100).changes).toEqual([]);
  });

  it('protects the native cadence on high-refresh displays', () => {
    const scale = new AdaptivePixelRatio();
    scale.configure(true, 1, 1390, 747);
    const fast = run(scale, 0, 1000 / 120, 200);
    expect(fast.changes).toEqual([1.5]);
    expect(run(scale, fast.time, 1000 / 90, 120).changes).toEqual([1]);
  });
});
