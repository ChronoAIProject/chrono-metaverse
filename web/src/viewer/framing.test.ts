import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARGIN, clipBox, frameBox, type CameraFrame } from './framing';

const FOV = 50;

/** 按取景结果摆一个透视镜头，返回包围盒 8 个角的投影范围（NDC）。 */
function projected(box: THREE.Box3, frame: CameraFrame, aspect: number) {
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.01, 1000);
  camera.position.copy(frame.position);
  camera.lookAt(frame.target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(camera);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

const room = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 2.2, 5));

describe('镜头取景', () => {
  it.each([
    ['宽屏', 1.86],
    ['竖屏手机', 0.6],
  ])('%s：房间的 8 个角都在画面里，四边留边距，并且贴着可用范围', (_name, aspect) => {
    const frame = frameBox(room, { fov: FOV, aspect })!;
    const r = projected(room, frame, aspect);
    const limit = 1 - 2 * DEFAULT_MARGIN;
    for (const v of [r.minX, r.minY]) expect(v).toBeGreaterThanOrEqual(-limit - 1e-3);
    for (const v of [r.maxX, r.maxY]) expect(v).toBeLessThanOrEqual(limit + 1e-3);
    // 至少一个方向占满了可用范围（不是随便离得远远的）。
    const span = Math.max((r.maxX - r.minX) / 2, (r.maxY - r.minY) / 2);
    expect(span).toBeGreaterThan(limit - 0.02);
    // 投影居中。
    expect(Math.abs(r.minX + r.maxX)).toBeLessThan(0.03);
    expect(Math.abs(r.minY + r.maxY)).toBeLessThan(0.03);
  });

  it('斜上方 45° 俯视，镜头在东南方向', () => {
    const frame = frameBox(room, { fov: FOV, aspect: 1.6 })!;
    const offset = frame.position.clone().sub(frame.target);
    const elevation = THREE.MathUtils.radToDeg(
      Math.atan2(offset.y, Math.hypot(offset.x, offset.z)),
    );
    expect(elevation).toBeCloseTo(45, 5);
    expect(offset.x).toBeGreaterThan(0);
    expect(offset.z).toBeGreaterThan(0);
    expect(frame.distance).toBeCloseTo(offset.length(), 6);
  });

  it('长方形房间：长边横在宽屏上', () => {
    const longX = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 2.5, 4));
    const longZ = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(4, 2.5, 12));
    // 方位角从 +z 往 +x 量：小的是从南边看（x 方向横着），大的是从东边看（z 方向横着）。
    expect(frameBox(longX, { fov: FOV, aspect: 2 })!.azimuth).toBeLessThanOrEqual(30);
    expect(frameBox(longZ, { fov: FOV, aspect: 2 })!.azimuth).toBeGreaterThanOrEqual(60);
  });

  it('房间越大镜头越远；边距越大镜头越远；空盒子不取景', () => {
    const big = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(12, 2.2, 10));
    const near = frameBox(room, { fov: FOV, aspect: 1.6 })!;
    expect(frameBox(big, { fov: FOV, aspect: 1.6 })!.distance).toBeGreaterThan(near.distance);
    expect(frameBox(room, { fov: FOV, aspect: 1.6, margin: 0.15 })!.distance).toBeGreaterThan(
      near.distance,
    );
    expect(frameBox(new THREE.Box3(), { fov: FOV, aspect: 1.6 })).toBeNull();
  });

  it('只有地面（高度为 0）的内容也能取景', () => {
    const floor = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 0, 5));
    const frame = frameBox(floor, { fov: FOV, aspect: 1.6 })!;
    expect(Number.isFinite(frame.distance)).toBe(true);
    expect(frame.position.y).toBeGreaterThan(0);
  });
});

describe('取景范围', () => {
  const content = new THREE.Box3(new THREE.Vector3(-1, -0.1, -2), new THREE.Vector3(30, 3, 5));

  it('内容的包围盒和实体区求交：远处的杂点不影响取景', () => {
    const region = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(6, 3, 5));
    const clipped = clipBox(content, [region]);
    expect(clipped.min.toArray()).toEqual([0, 0, 0]);
    expect(clipped.max.toArray()).toEqual([6, 3, 5]);
  });

  it('多个范围分别求交后合并；不相交的范围不算；没有范围时原样返回', () => {
    const a = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 3, 2));
    const b = new THREE.Box3(new THREE.Vector3(8, 0, 0), new THREE.Vector3(10, 3, 2));
    const far = new THREE.Box3(new THREE.Vector3(100, 0, 0), new THREE.Vector3(110, 3, 2));
    const clipped = clipBox(content, [a, b, far]);
    expect(clipped.min.x).toBe(0);
    expect(clipped.max.x).toBe(10);
    expect(clipBox(content, []).equals(content)).toBe(true);
    expect(clipBox(content, [far]).isEmpty()).toBe(true);
  });
});
