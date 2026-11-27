import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { skyRadiance } from './skyRadiance';
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
    expect(mirror.capturedPosition.toArray()).toEqual([0, 2, 0]);
    expect(update(1)).toBe(false);
    expect(draw).toHaveBeenCalledTimes(1);
    camera.position.x = 380;
    expect(update()).toBe(true);
    expect(mirror.capturedPosition.toArray()).toEqual([380, 2, 0]);
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

it('keeps texel density and captures the shoreline outside an off-centre player view', () => {
  const reflection = new MapReflection();
  const renderer = { getRenderTarget: () => null } as THREE.WebGLRenderer;
  const camera = new THREE.PerspectiveCamera(52, 1.7, 0.05, 4000);
  camera.position.y = 3;
  camera.setViewOffset(1200, 800, 150, 100, 900, 600);
  camera.updateMatrixWorld();
  const projection = camera.projectionMatrix.clone();
  const { width, height } = reflection.texture;
  const draw = vi
    .spyOn(Reflect.get(reflection, 'mirror'), 'onBeforeRender')
    .mockImplementation((...args) => {
      const capture = args[2] as THREE.PerspectiveCamera;
      const point = new THREE.Vector3(3, 1, -5);
      const player = point.clone().applyMatrix4(projection);
      const mirror = point.clone().applyMatrix4(capture.projectionMatrix);
      expect(mirror.x * width).toBeCloseTo(player.x * 512);
      expect(mirror.y * height).toBeCloseTo(player.y * 384);
      expect(mirror.z).toBeCloseTo(player.z);
    });
  try {
    expect(width).toBeGreaterThan(512);
    expect(reflection.update(renderer, new THREE.Scene(), camera, 0)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(camera.projectionMatrix).toEqual(projection);
  } finally {
    reflection.dispose();
  }
});

it('restores the camera background and retries a failed radiance capture', () => {
  const reflection = new MapReflection();
  const renderer = { getRenderTarget: () => null } as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const visibleSky = new THREE.Texture();
  const radiance = new THREE.DataTexture();
  scene.background = visibleSky;
  skyRadiance.set(visibleSky, radiance);
  const camera = new THREE.PerspectiveCamera();
  camera.position.y = 2;
  camera.updateMatrixWorld();
  const draw = vi
    .spyOn(Reflect.get(reflection, 'mirror'), 'onBeforeRender')
    .mockImplementationOnce(() => {
      expect(scene.background).toBe(radiance);
      throw new Error('interrupted');
    })
    .mockImplementation(() => {
      expect(scene.background).toBe(radiance);
    });
  try {
    expect(() => reflection.update(renderer, scene, camera, 0)).toThrow('interrupted');
    expect(scene.background).toBe(visibleSky);
    expect(reflection.update(renderer, scene, camera, 0)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(scene.background).toBe(visibleSky);
  } finally {
    reflection.dispose();
    visibleSky.dispose();
    radiance.dispose();
  }
});
