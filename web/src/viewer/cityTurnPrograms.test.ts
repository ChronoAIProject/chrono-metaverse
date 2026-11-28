import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { CityTurnPrograms } from './cityTurnPrograms';

afterEach(() => vi.unstubAllGlobals());

it('prepares the offscreen mesh for both outputs during idle frames and cancels pending work', () => {
  const idle = new Map<number, IdleRequestCallback>();
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    idle.set(++handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelIdleCallback', (key: number) => idle.delete(key));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  function runIdle() {
    const [key, callback] = [...idle.entries()][0]!;
    idle.delete(key);
    callback({ didTimeout: false, timeRemaining: () => 12 });
  }
  function runFrame() {
    const [key, callback] = [...frames.entries()][0]!;
    frames.delete(key);
    callback(1000);
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.01, 1000);
  const mirrorEye = camera.clone();
  mirrorEye.layers.set(1);
  const mirror = new THREE.WebGLRenderTarget(1, 1);
  let target: THREE.WebGLRenderTarget | null = null;
  const draws: [THREE.Material, THREE.Camera, THREE.WebGLRenderTarget | null][] = [];
  const renderer = {
    extensions: { has: () => true },
    getContext: () => ({ isContextLost: () => false }),
    getRenderTarget: () => target,
    setRenderTarget: (value: THREE.WebGLRenderTarget | null) => {
      target = value;
    },
    renderLists: { get: () => ({ opaque: [], transparent: [], transmissive: [] }) },
    compile: (mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>, eye: THREE.Camera) => {
      draws.push([mesh.material, eye, target]);
    },
  } as unknown as THREE.WebGLRenderer;
  const material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), material);
  mesh.position.set(100, 380, -35);
  mesh.layers.enable(1);
  scene.add(mesh);
  scene.updateMatrixWorld();
  const warmup = new CityTurnPrograms();
  const observe = () => warmup.observe(renderer, scene, camera, mirrorEye, mirror, 0);

  observe();
  expect(idle.size).toBe(0);
  camera.position.y = 380;
  camera.updateMatrixWorld();
  observe();
  runIdle();
  runFrame();
  runIdle();
  runFrame();
  runIdle();
  expect(draws).toHaveLength(2);
  expect(draws.some(([m, c, t]) => m === material && c === camera && t === null)).toBe(true);
  expect(draws.some(([m, c, t]) => m === material && c === mirrorEye && t === mirror)).toBe(true);
  expect(target).toBeNull();
  expect(mesh.parent).toBe(scene);
  observe();
  expect(idle.size).toBe(0);
  camera.position.x += 120;
  observe();
  expect(idle.size).toBe(1);
  warmup.dispose();
  expect(idle.size + frames.size).toBe(0);
  mesh.geometry.dispose();
  material.dispose();
  mirror.dispose();
});
