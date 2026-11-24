import { BufferGeometry, Float32BufferAttribute } from 'three';
import { expect, it } from 'vitest';
import { repairModelNormals } from './modelNormals';

it('recovers missing directions without overwriting authored or shared normals', () => {
  const mesh = new BufferGeometry();
  mesh.setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 9, 9, 9], 3),
  );
  mesh.setIndex([0, 1, 2]);
  const normals = new Float32BufferAttribute([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], 3);
  mesh.setAttribute('normal', normals);
  repairModelNormals(mesh);
  const repaired = mesh.getAttribute('normal');
  expect(Array.from(repaired.array)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0]);
  expect(normals.getZ(1)).toBe(0);
  repairModelNormals(mesh);
  expect(mesh.getAttribute('normal')).toBe(repaired);
});
