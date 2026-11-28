import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { skyRadiance, waterSkyRadiance } from './skyRadiance';
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

it('redraws a resized shoreline target once even within the capture interval', () => {
  const mirror = new MapReflection();
  const renderer = { getRenderTarget: () => null } as THREE.WebGLRenderer;
  const camera = new THREE.PerspectiveCamera();
  camera.position.y = 2;
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const draw = vi
    .spyOn(Reflect.get(mirror, 'mirror'), 'onBeforeRender')
    .mockImplementation(() => {});
  try {
    for (const [width, height, expected] of [
      [390, 800, 640],
      [1390, 747, 1280],
      [851, 393, 640],
    ] as const) {
      for (let i = 0; i < 2; i++) {
        mirror.fitShorelineViewport(width, height);
        expect(mirror.update(renderer, scene, camera, 0)).toBe(true);
        expect(mirror.texture.width).toBe(expected);
        expect(mirror.texture.height).toBe(expected * 0.75);
      }
    }
    expect(draw).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
    mirror.dispose();
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
  const water = new THREE.DataTexture();
  const draw = vi
    .spyOn(Reflect.get(reflection, 'mirror'), 'onBeforeRender')
    .mockImplementationOnce(() => {
      expect(scene.background).toBe(radiance);
      throw new Error('interrupted');
    })
    .mockImplementation(() => {
      expect(scene.background).toBe(water);
    });
  try {
    expect(() => reflection.update(renderer, scene, camera, 0)).toThrow('interrupted');
    expect(scene.background).toBe(visibleSky);
    waterSkyRadiance.set(visibleSky, water);
    expect(reflection.update(renderer, scene, camera, 0)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(scene.background).toBe(visibleSky);
  } finally {
    reflection.dispose();
    visibleSky.dispose();
    water.dispose();
    radiance.dispose();
  }
});
