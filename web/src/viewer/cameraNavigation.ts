import { Vector3 } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const directions = new Map<string, readonly [number, number, number]>([
  ['KeyW', [0, 0, -1]],
  ['ArrowUp', [0, 0, -1]],
  ['KeyS', [0, 0, 1]],
  ['ArrowDown', [0, 0, 1]],
  ['KeyA', [-1, 0, 0]],
  ['ArrowLeft', [-1, 0, 0]],
  ['KeyD', [1, 0, 0]],
  ['ArrowRight', [1, 0, 0]],
  ['KeyQ', [0, -1, 0]],
  ['KeyE', [0, 1, 0]],
]);

/** 键盘沿当前方位移动相机和观察点，鼠标及触屏继续使用 OrbitControls。 */
export function attachCameraNavigation(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
  onStart: () => void,
) {
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const pressed = new Set<string>();
  const offset = new Vector3();
  let lastMove = 0;

  const move = (now: number) => {
    if (pressed.size === 0) return;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const key of pressed) {
      const direction = directions.get(key)!;
      x += direction[0];
      y += direction[1];
      z += direction[2];
    }
    const seconds = Math.min((now - lastMove) / 1000, 0.1);
    lastMove = now;
    const speed = Math.max(1, controls.getDistance() * 0.6);
    offset
      .set(Math.sign(x), Math.sign(y), Math.sign(z))
      .normalize()
      .applyAxisAngle(controls.object.up, controls.getAzimuthalAngle())
      .multiplyScalar(speed * seconds);
    controls.object.position.add(offset);
    controls.target.add(offset);
  };

  canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }), options);
  canvas.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (!directions.has(event.code)) return;
      event.preventDefault();
      if (pressed.has(event.code)) return;
      const now = performance.now();
      move(now);
      lastMove = now;
      pressed.add(event.code);
      onStart();
    },
    options,
  );
  canvas.addEventListener(
    'keyup',
    (event) => {
      if (pressed.has(event.code)) {
        move(performance.now());
        pressed.delete(event.code);
      }
    },
    options,
  );
  const stop = () => pressed.clear();
  canvas.addEventListener('blur', stop, options);
  window.addEventListener('blur', stop, options);
  document.addEventListener('visibilitychange', stop, options);

  // 桌面 Safari 的触控板捏合通过 gesture 事件上报，触屏双指由 OrbitControls 处理。
  if (navigator.maxTouchPoints === 0) {
    let previousScale = 1;
    canvas.addEventListener(
      'gesturestart',
      () => {
        previousScale = 1;
        onStart();
      },
      options,
    );
    canvas.addEventListener(
      'gesturechange',
      (event) => {
        const { scale } = event as Event & { scale: number };
        if (Number.isFinite(scale) && scale > 0) {
          controls.dollyIn(previousScale / scale);
          previousScale = scale;
        }
      },
      options,
    );
  }

  return { update: () => move(performance.now()), dispose: () => listeners.abort() };
}
