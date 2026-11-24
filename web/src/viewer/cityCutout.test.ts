import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { cityCutout, matchCutoutShadow } from './cityCutout';

it('uses each draw group’s visible cutoff in its shadow pass', () => {
  const leaves = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaTest: 0.36 });
  const bark = new THREE.MeshStandardMaterial();
  cityCutout(leaves, 8);
  expect(leaves.map?.anisotropy).toBe(4);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [bark, leaves]);
  const before = vi.fn();
  mesh.onBeforeShadow = before;
  matchCutoutShadow(mesh);

  const depth = new THREE.MeshDepthMaterial({ alphaTest: 0.5 });
  const draw = (index: number) =>
    mesh.onBeforeShadow(
      {} as THREE.WebGLRenderer,
      new THREE.Scene(),
      new THREE.Camera(),
      new THREE.Camera(),
      mesh.geometry,
      depth,
      // WebGLShadowMap passes a BufferGeometry group here.
      { materialIndex: index } as unknown as THREE.Group,
    );
  draw(0);
  expect(depth.alphaTest).toBe(0.5);
  draw(1);
  expect(depth.alphaTest).toBe(0.36);
  expect(before).toHaveBeenCalledTimes(2);
});
