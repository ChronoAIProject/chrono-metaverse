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

it('keeps shadow texels aligned across camera tracking steps at each resolution', () => {
  const sun = new CitySun();
  const key = new THREE.DirectionalLight();
  key.position.set(0.554, 0.742, 0.378);
  sun.setLight(key);
  const renderer = { shadowMap: {} } as THREE.WebGLRenderer;
  const landmark = new THREE.Vector3(410, -55, 625);
  const pixelAt = (offset: number, distance: number) => {
    const focus = landmark.clone();
    focus.z += offset;
    const eye = focus.clone();
    eye.x -= distance;
    sun.update(renderer, eye, focus, false);
    key.updateMatrixWorld();
    key.shadow.updateMatrices(key);
    const uv = landmark.clone().applyMatrix4(key.shadow.matrix);
    return new THREE.Vector2(uv.x, uv.y).multiply(key.shadow.mapSize);
  };
  for (const distance of [30, 150, 480]) {
    const a = pixelAt(0, distance);
    const movement = pixelAt(27, distance).sub(a);
    expect(movement.length()).toBeGreaterThan(1);
    expect(movement.x).toBeCloseTo(Math.round(movement.x), 6);
    expect(movement.y).toBeCloseTo(Math.round(movement.y), 6);
  }
});
