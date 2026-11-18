import { expect, it } from 'vitest';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FirstPersonView } from './cameraPerspective';
import { attachCameraNavigation } from './cameraNavigation';

it('第一视角原地转头和变焦，前进沿新的朝向，第三视角恢复进入前的位置', () => {
  const canvas = document.createElement('canvas');
  const camera = new PerspectiveCamera(50, 1, 0.4, 100);
  camera.position.set(12, 8, 12);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(3, 5, 3);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();
  const navigation = attachCameraNavigation(canvas, controls, () => {});
  const orbit = camera.position.clone();
  const target = controls.target.clone();
  try {
    const first = new FirstPersonView(
      camera,
      controls,
      new Box3(new Vector3(0, 4, 0), new Vector3(6, 7, 6)),
    );
    const eye = camera.position.clone();
    expect(eye.y).toBeCloseTo(5.6);
    const direction = () => camera.getWorldDirection(new Vector3());
    const before = direction();
    navigation.step('turnRight', true);
    first.sync();
    expect(camera.position.distanceTo(eye)).toBeLessThan(1e-8);
    expect(before.angleTo(direction())).toBeCloseTo(Math.PI / 12);
    navigation.step('zoomIn', true);
    first.sync();
    expect(camera.zoom).toBeGreaterThan(1);
    expect(camera.position.distanceTo(eye)).toBeLessThan(1e-8);
    navigation.step('forward', true);
    first.sync();
    const delta = camera.position.clone().sub(eye);
    expect(delta.length()).toBeGreaterThan(0.1);
    expect(delta.normalize().dot(direction())).toBeCloseTo(1);
    first.exit();
    expect(camera.position.distanceTo(orbit)).toBeLessThan(1e-8);
    expect(controls.target).toEqual(target);
    expect(camera.zoom).toBe(1);
    expect(camera.near).toBe(0.4);
    expect(controls.enableDamping).toBe(true);
    expect(controls.object).toBe(camera);
  } finally {
    navigation.dispose();
    controls.dispose();
  }
});
