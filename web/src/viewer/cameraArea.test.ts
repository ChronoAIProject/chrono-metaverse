import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { IDENTITY_PLACEMENT, placePoint } from '../core/scene';
import { CameraArea } from './cameraArea';

const area = { center: [12, -4] as [number, number], floor: -3, radius: 20, height: 16 };

describe('authored camera area', () => {
  it('keeps an in-bounds pose exact and contains a distant orbit and its pivot', () => {
    const volume = new CameraArea(area, IDENTITY_PLACEMENT);
    const eye = new Vector3(11, 8, 3);
    const pivot = new Vector3(6, 0, -3);
    expect(volume.constrain(eye, pivot)).toBe(false);
    expect(eye.toArray()).toEqual([11, 8, 3]);
    eye.set(1000, 400, -1000);
    pivot.set(800, 250, -800);
    expect(volume.constrain(eye, pivot)).toBe(true);
    for (const p of [eye, pivot]) {
      expect(Math.hypot(p.x - 12, p.z + 4)).toBeLessThanOrEqual(20.000001);
      expect(p.y).toBeLessThanOrEqual(13);
    }
    expect(eye.distanceTo(pivot)).toBeGreaterThan(0);
  });

  it('contains the walking eye in a rotated member while preserving the look direction', () => {
    const placement = { offset: [20, 4, -8] as [number, number, number], rotation: 90 };
    const volume = new CameraArea(area, placement);
    const center = new Vector3(...placePoint(placement, [12, -3, -4]));
    const eye = center.clone().add(new Vector3(80, -50, 0));
    const look = eye.clone().add(new Vector3(1, 2, 3));
    volume.constrain(look, eye, true);
    expect(eye.distanceTo(center)).toBeCloseTo(20);
    expect(eye.y).toBe(center.y);
    expect(look.sub(eye).distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-10);
  });
});
