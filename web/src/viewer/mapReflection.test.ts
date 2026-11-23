import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { MapReflection } from './mapReflection';

it('步行共用水面倒影，切换机位、转身和大幅缩放时在同一帧重画一次', () => {
  const mirror = new MapReflection();
  const draw = vi
    .spyOn(Reflect.get(mirror, 'mirror'), 'onBeforeRender')
    .mockImplementation(() => {});
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const camera = new THREE.PerspectiveCamera(50, 1.5, 0.025, 2000);
  const renderer = { getRenderTarget: () => null } as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const update = (level = 0) => {
    camera.updateMatrixWorld();
    return mirror.update(renderer, scene, camera, level);
  };
  try {
    camera.position.y = 2;
    expect(update()).toBe(true);
    clock.mockReturnValue(1016);
    camera.position.x = 0.1;
    expect(update()).toBe(true);
    expect(update(1)).toBe(false);
    expect(draw).toHaveBeenCalledTimes(1);
    camera.position.x = 380;
    expect(update()).toBe(true);
    expect(update()).toBe(true);
    expect(draw).toHaveBeenCalledTimes(2);
    camera.rotation.y = Math.PI / 2;
    expect(update()).toBe(true);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    expect(update()).toBe(true);
    expect(draw).toHaveBeenCalledTimes(4);
    clock.mockReturnValue(1200);
    expect(update()).toBe(true);
    expect(draw).toHaveBeenCalledTimes(5);
    camera.far *= 2;
    camera.updateProjectionMatrix();
    expect(update()).toBe(true);
    expect(update()).toBe(true);
    expect(draw).toHaveBeenCalledTimes(6);
  } finally {
    clock.mockRestore();
    mirror.dispose();
  }
});
