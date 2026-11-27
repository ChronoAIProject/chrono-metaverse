import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { grassPatch } from './mapGrass';
import { GrassFootprints } from './grassFootprints';

it('keeps surveyed lawn and taller grass on their original cells after paving is excluded', () => {
  const terrain = new THREE.PlaneGeometry(1, 1, 4, 4);
  terrain.computeBoundingSphere();
  // Large source tiles use the dense-grid fallback without a canvas readback.
  const image = new THREE.Texture({ width: 1024, height: 1024 } as ImageBitmap);
  const paving = new GrassFootprints([]);
  vi.spyOn(paving, 'filter').mockReturnValue(Uint16Array.from([0, 2, 3]));
  const lawns = new GrassFootprints([]);
  const pixels = new Uint8ClampedArray(16);
  pixels[7] = pixels[11] = 255;
  vi.spyOn(lawns, 'coverage').mockReturnValue(pixels);
  const patches = grassPatch(terrain, image, 0.48, { x: 0, y: 0, z: 0 }, paving, lawns);
  expect(patches.map((mesh) => [mesh.name, ...mesh.geometry.attributes.grassCell!.array])).toEqual([
    ['map-grass', 0, 3],
    ['map-mown-grass', 2],
  ]);
  expect(patches.map((mesh) => mesh.geometry.attributes.position!.count)).toEqual([27, 15]);
});
