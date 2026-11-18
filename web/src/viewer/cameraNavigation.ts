import { Vector3 } from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const directions = {
  forward: [0, 0, -1],
  back: [0, 0, 1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  down: [0, -1, 0],
  up: [0, 1, 0],
} as const;
type Direction = keyof typeof directions;
export type CameraStep = Direction | 'turnLeft' | 'turnRight' | 'zoomIn' | 'zoomOut';

const keys = new Map<string, Direction>([
  ['KeyW', 'forward'],
  ['ArrowUp', 'forward'],
  ['KeyS', 'back'],
  ['ArrowDown', 'back'],
  ['KeyA', 'left'],
  ['ArrowLeft', 'left'],
  ['KeyD', 'right'],
  ['ArrowRight', 'right'],
  ['KeyQ', 'down'],
  ['KeyE', 'up'],
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

  const translate = (x: number, y: number, z: number, seconds: number) => {
    const speed = Math.max(1, controls.getDistance() * 0.6);
    offset
      .set(Math.sign(x), Math.sign(y), Math.sign(z))
      .normalize()
      .applyAxisAngle(controls.object.up, controls.getAzimuthalAngle())
      .multiplyScalar(speed * seconds);
    controls.object.position.add(offset);
    controls.target.add(offset);
  };

  const move = (now: number) => {
    if (pressed.size === 0) return;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const key of pressed) {
      const direction = directions[keys.get(key)!];
      x += direction[0];
      y += direction[1];
      z += direction[2];
    }
    const seconds = Math.min((now - lastMove) / 1000, 0.1);
    lastMove = now;
    translate(x, y, z, seconds);
  };

  canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }), options);
  canvas.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (!keys.has(event.code)) return;
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

  const step = (action: CameraStep, firstPerson: boolean) => {
    onStart();
    switch (action) {
      case 'zoomIn':
        controls.dollyIn(0.85);
        break;
      case 'zoomOut':
        controls.dollyOut(0.85);
        break;
      case 'turnLeft':
      case 'turnRight': {
        const left = firstPerson ? -1 : 1;
        controls.rotateLeft(((action === 'turnLeft' ? left : -left) * Math.PI) / 12);
        break;
      }
      default: {
        const [x, y, z] = directions[action];
        translate(x, y, z, 0.15);
        controls.update();
      }
    }
  };

  return { step, update: () => move(performance.now()), dispose: () => listeners.abort() };
}
