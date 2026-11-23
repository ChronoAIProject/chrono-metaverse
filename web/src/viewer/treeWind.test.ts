import { BufferGeometry, Float32BufferAttribute, Mesh, Vector3 } from 'three';
import { expect, it } from 'vitest';
import { prepareTreeWind, updateTreeWind } from './treeWind';

it('keeps the roots fixed and moves coincident bark and foliage vertices together across the loop', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 1, 0, 2, 7.5, 1], 3));
  const bark = new Mesh(geometry);
  const leaves = bark.clone();
  prepareTreeWind(bark);
  const radius = geometry.boundingSphere!.radius;
  prepareTreeWind(leaves);
  expect(geometry.boundingSphere!.radius).toBe(radius);

  const tip = new Vector3(2, 7.5, 1);
  for (const t of [1, 5, 12, 24]) {
    updateTreeWind([bark, leaves], t);
    expect(bark.getVertexPosition(0, new Vector3()).toArray()).toEqual([0, 1, 0]);
    const moved = bark.getVertexPosition(1, new Vector3());
    expect(moved.distanceTo(tip)).toBeGreaterThan(0);
    expect(geometry.boundingSphere!.containsPoint(moved)).toBe(true);
    expect(leaves.getVertexPosition(1, new Vector3())).toEqual(moved);
  }
  const end = bark.getVertexPosition(1, new Vector3());
  updateTreeWind([bark], 0);
  expect(bark.getVertexPosition(1, new Vector3())).toEqual(end);
});
