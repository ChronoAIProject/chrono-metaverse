import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import type { TurfColorSurvey } from '../core/environment';
import { GeoReference } from './geography';
import { applyTurfSurvey, surfaceRasterTransform } from './turfSurvey';

const reference = new GeoReference({
  latitude: 35,
  longitude: 139,
  heading: 83,
  origin: [230, -60, -47],
});
const survey: TurfColorSurvey = {
  texture: 'a'.repeat(64),
  corners: [
    [139, 35],
    [139.026, 35.003],
    [138.998, 35.015],
  ],
};

it('registers rotated metre UVs to the three outer image edges', () => {
  const transform = surfaceRasterTransform(reference, survey.corners)!;
  for (const [i, uv] of [
    [0, 0],
    [1, 0],
    [0, 1],
  ].entries()) {
    const point = reference.point(...survey.corners[i]!);
    const result = new THREE.Vector2(point.x, -point.z).applyMatrix3(transform);
    expect(result.x).toBeCloseTo(uv[0]!, 8);
    expect(result.y).toBeCloseTo(uv[1]!, 8);
  }
  expect(
    surfaceRasterTransform(reference, [survey.corners[0], survey.corners[0], survey.corners[2]]),
  ).toBeUndefined();
});

it('releases the private data texture and ignores loads completed after disposal', async () => {
  const source = new THREE.Texture();
  const texture = new THREE.Texture();
  const clone = vi.spyOn(source, 'clone').mockReturnValue(texture);
  const dispose = vi.spyOn(texture, 'dispose');
  const cached = vi.spyOn(source, 'dispose');
  const load = async () => source;
  const material = new THREE.MeshStandardMaterial();
  applyTurfSurvey(material, reference, survey, load);
  await Promise.resolve();
  expect(material.customProgramCacheKey()).toContain('|turf-survey');
  expect(texture.colorSpace).toBe(THREE.NoColorSpace);
  material.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  const expired = new THREE.MeshStandardMaterial();
  applyTurfSurvey(expired, reference, survey, load);
  expired.dispose();
  await Promise.resolve();
  expect(clone).toHaveBeenCalledOnce();
  expect(cached).not.toHaveBeenCalled();
});
