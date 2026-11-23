import * as THREE from 'three';
import { expect, it } from 'vitest';
import { CitySun } from './citySun';

it('keeps the theatre and its cast shadow inside the map from the lawn overlook', () => {
  const sun = new CitySun();
  const key = new THREE.DirectionalLight();
  key.position.set(0.554393, 0.741672, 0.377586);
  sun.setLight(key);
  const renderer = { shadowMap: {} } as THREE.WebGLRenderer;
  const eye = new THREE.Vector3(363.63, -8.301, 645.217);
  const focus = new THREE.Vector3(565.034, -53.324, 721.381);
  sun.update(renderer, eye, focus, false);
  key.updateMatrixWorld();
  key.shadow.updateMatrices(key);
  for (const ground of [focus, new THREE.Vector3(522.1, -59.9, 723.1)]) {
    const projected = ground.clone().applyMatrix4(key.shadow.matrix);
    expect(Math.min(projected.x, projected.y)).toBeGreaterThan(0.01);
    expect(Math.max(projected.x, projected.y)).toBeLessThan(0.99);
  }
  expect(key.shadow.mapSize.toArray()).toEqual([2048, 2048]);
});
