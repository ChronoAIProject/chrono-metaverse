import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { modelEuler, placeRotatedModel, rotatedBox } from './modelPlacement';

/** 一个原点在底面中心的"椅子"：宽 0.6、高 0.9、深 0.4，另有一个偏在一角的小件（让外形不对称）。 */
function chair(): THREE.Object3D {
  const root = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.4));
  seat.position.set(0, 0.45, 0);
  root.add(seat);
  return root;
}

function worldBox(object: THREE.Object3D): THREE.Box3 {
  const holder = new THREE.Group();
  holder.add(object);
  holder.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(holder);
}

describe('只有模型的物件：按 transform 旋转', () => {
  it('没有旋转时不动模型', () => {
    expect(modelEuler(undefined)).toBeNull();
    expect(modelEuler({ yaw: 0, pitch: 0, roll: 0 })).toBeNull();
    const model = chair();
    placeRotatedModel(model, {});
    expect(model.position.toArray()).toEqual([0, 0, 0]);
    expect(model.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('偏航 90°：宽和深对调，底面中心仍在原点', () => {
    const model = chair();
    placeRotatedModel(model, { yaw: 90 });
    const box = worldBox(model);
    expect(box.max.x - box.min.x).toBeCloseTo(0.4, 6);
    expect(box.max.z - box.min.z).toBeCloseTo(0.6, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 6);
  });

  it('转过之后的外包盒与服务端相同（8 个角点），底面中心对齐原点', () => {
    const own = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.2), new THREE.Vector3(0.3, 0.9, 0.2));
    const turned = rotatedBox(own, modelEuler({ yaw: 30 }));
    const half = (a: number, b: number) => 0.3 * a + 0.2 * b;
    expect(turned.max.x).toBeCloseTo(half(Math.cos(Math.PI / 6), 0.5), 12);
    expect(turned.max.z).toBeCloseTo(half(0.5, Math.cos(Math.PI / 6)), 12);
    // 翻滚 90°：模型躺下，外包盒的底面仍放在原点
    const model = chair();
    placeRotatedModel(model, { roll: 90 });
    const box = worldBox(model);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(0.6, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
  });

  it('旋转顺序同 SHAPES 1：Ry(yaw) · Rx(pitch) · Rz(roll)', () => {
    const euler = modelEuler({ yaw: 90, pitch: 90 })!;
    // 先俯仰 90°（+y → +z），再偏航 90°（+z → +x）
    const v = new THREE.Vector3(0, 1, 0).applyEuler(euler);
    expect(v.x).toBeCloseTo(1, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });
});
