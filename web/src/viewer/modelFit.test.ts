import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { shapeToGlb } from '../fixtures/glb';
import type { Shape } from '../core/shapes/types';
import {
  applyModelFit,
  fitTolerance,
  modelBox,
  modelFit,
  modelFitWarning,
  type BoxLike,
} from './modelFit';

/** 一个盒子网格的模型：大小 size，最小角在 corner（模型坐标）。 */
function boxModel(size: [number, number, number], corner: [number, number, number]) {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(...size);
  geometry.translate(corner[0] + size[0] / 2, corner[1] + size[1] / 2, corner[2] + size[2] / 2);
  root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  return root;
}

/** 照查看器的做法摆放：实例挂在记录底面中心的那一组下面，返回世界坐标的实际包围盒。 */
function place(model: THREE.Object3D, bounds: BoxLike) {
  const holder = new THREE.Group();
  holder.position.set(
    (bounds.min[0]! + bounds.max[0]!) / 2,
    bounds.min[1]!,
    (bounds.min[2]! + bounds.max[2]!) / 2,
  );
  const instance = model.clone(true);
  const fit = modelFit(modelBox(model), bounds);
  applyModelFit(instance, fit);
  holder.add(instance);
  holder.updateMatrixWorld(true);
  return { fit, instance, box: new THREE.Box3().setFromObject(holder, true) };
}

function expectInside(box: THREE.Box3, bounds: BoxLike, slack = 1e-6) {
  for (const [k, axis] of (['x', 'y', 'z'] as const).entries()) {
    expect(box.min[axis]).toBeGreaterThanOrEqual(bounds.min[k]! - slack);
    expect(box.max[axis]).toBeLessThanOrEqual(bounds.max[k]! + slack);
  }
}

const BOUNDS: BoxLike = { min: [1, 0.5, 2], max: [2, 2, 2.5] };

describe('只有模型的物件：兜底摆放', () => {
  it('实际比 bounds 大很多的模型整体等比缩小，缩进 bounds，底面中心对齐', () => {
    // 4 × 6 × 2 米、中心在原点（原点也不在底面中心）；记录是 1 × 1.5 × 0.5 米
    const model = boxModel([4, 6, 2], [-2, -3, -1]);
    const { fit, instance, box } = place(model, BOUNDS);
    expect(fit?.reason).toBe('size');
    expect(fit?.scale).toBeCloseTo(0.25, 9);
    expect(instance.scale.toArray()).toEqual([0.25, 0.25, 0.25]);
    expectInside(box, BOUNDS);
    // 等比：比例不变，底面贴着记录的底面、水平居中
    expect(box.max.x - box.min.x).toBeCloseTo(1, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(1.5, 6);
    expect(box.max.z - box.min.z).toBeCloseTo(0.5, 6);
    expect(box.min.y).toBeCloseTo(0.5, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(1.5, 6);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(2.25, 6);
  });

  it('只超出一边时按那一边缩小，其余几边跟着等比变小', () => {
    const model = boxModel([3, 1, 0.4], [-1.5, 0, -0.2]);
    const { fit, box } = place(model, BOUNDS);
    expect(fit?.scale).toBeCloseTo(1 / 3, 9);
    expectInside(box, BOUNDS);
    expect(box.max.y - box.min.y).toBeCloseTo(1 / 3, 6);
  });

  it('符合的模型不动（误差以内的也不动）', () => {
    const exact = boxModel([1, 1.5, 0.5], [-0.5, 0, -0.25]);
    const exactPlaced = place(exact, BOUNDS);
    expect(exactPlaced.fit).toBeNull();
    expect(exactPlaced.instance.scale.toArray()).toEqual([1, 1, 1]);
    expect(exactPlaced.instance.position.toArray()).toEqual([0, 0, 0]);
    // 每边长出 1.9 厘米、原点偏 1.9 厘米：都在服务端的误差以内（边长 max(2 厘米, 1%)，原点 2 厘米）
    const loose = boxModel([1.019, 1.519, 0.519], [-0.4905, 0.019, -0.2405]);
    expect(place(loose, BOUNDS).fit).toBeNull();
    // 比记录小的模型不放大
    const small = boxModel([0.5, 0.5, 0.2], [-0.25, 0, -0.1]);
    expect(place(small, BOUNDS).fit).toBeNull();
  });

  it('误差按边长算：max(2 厘米, 边长的 1%)', () => {
    expect(fitTolerance(1)).toBe(0.02);
    expect(fitTolerance(5)).toBeCloseTo(0.05, 12);
    const big: BoxLike = { min: [0, 0, 0], max: [5, 1, 1] };
    // 5 米的边长出 4 厘米不算超出，长出 6 厘米算
    expect(modelFit({ min: [-2.52, 0, -0.5], max: [2.52, 1, 0.5] }, big)).toBeNull();
    expect(modelFit({ min: [-2.53, 0, -0.5], max: [2.53, 1, 0.5] }, big)?.reason).toBe('size');
    // 1 米的边长出 2.1 厘米算超出
    expect(modelFit({ min: [-0.5105, 0, -0.5], max: [0.5105, 1, 0.5] }, big)).toBeNull();
    expect(modelFit({ min: [-2.5, 0, -0.5105], max: [2.5, 1, 0.5105] }, big)?.reason).toBe('size');
  });

  it('大小对、但原点不在底面中心：只平移进 bounds，不缩放', () => {
    // 原点在模型的一个角上（整个模型偏出记录半个身位）
    const model = boxModel([1, 1.5, 0.5], [0, 0, 0]);
    const { fit, instance, box } = place(model, BOUNDS);
    expect(fit?.reason).toBe('position');
    expect(fit?.scale).toBe(1);
    expect(instance.scale.toArray()).toEqual([1, 1, 1]);
    expectInside(box, BOUNDS);
    // 浮起来 2.1 厘米的模型也放回底面
    const floating = boxModel([1, 1.5, 0.5], [-0.5, 0.021, -0.25]);
    const lifted = place(floating, BOUNDS);
    expect(lifted.fit?.reason).toBe('position');
    expect(lifted.box.min.y).toBeCloseTo(0.5, 6);
  });

  it('记录某一边是 0 时只按超出的边缩放（不会缩成 0）', () => {
    // 记录是一块平板（厚 0），模型厚 1 厘米（误差以内），但宽了一倍
    const flat: BoxLike = { min: [0, 0, 0], max: [1, 0, 1] };
    const fit = modelFit({ min: [-1, 0, -0.5], max: [1, 0.01, 0.5] }, flat);
    expect(fit?.scale).toBeCloseTo(0.5, 9);
  });

  it('没有顶点的模型、坏的 bounds 不处理', () => {
    expect(modelBox(new THREE.Group()).min.every((v) => !Number.isFinite(v))).toBe(true);
    expect(modelFit(modelBox(new THREE.Group()), BOUNDS)).toBeNull();
    expect(modelFit({ min: [0, 0, 0], max: [9, 9, 9] }, { min: [1, 1, 1], max: [0, 0, 0] })).toBe(
      null,
    );
  });

  it('警告写明物件、实际大小、记录大小和缩放比例', () => {
    const actual: BoxLike = { min: [-2, 0, -1], max: [2, 6, 1] };
    const fit = modelFit(actual, BOUNDS)!;
    expect(modelFitWarning('sofa-01', actual, BOUNDS, fit)).toBe(
      'sofa-01：模型实际大小 [4, 6, 2] 米超出记录的范围 [1, 1.5, 0.5] 米，已按 0.25 等比缩小放进范围',
    );
    const moved = modelFit({ min: [0, 0, 0], max: [1, 1.5, 0.5] }, BOUNDS)!;
    expect(modelFitWarning('sofa-01', actual, BOUNDS, moved)).toBe(
      'sofa-01：模型偏出记录的范围（原点不在底面中心），已平移进范围',
    );
  });

  it('真实的 glb：按顶点算包围盒，节点变换算在里面', async () => {
    // 花架模型 1.2 × 1.4 × 0.4 米，记录只给 0.6 × 0.7 × 0.2 米（一半大小）
    const shelf: Shape = {
      type: 'group',
      children: [
        { type: 'box', size: [1.2, 0.04, 0.4], transform: { position: [0, 1.36, 0] } },
        { type: 'box', size: [0.04, 1.4, 0.4], transform: { position: [-0.58, 0, 0] } },
        { type: 'box', size: [0.04, 1.4, 0.4], transform: { position: [0.58, 0, 0] } },
      ],
    };
    const bytes = shapeToGlb(shelf, {}, 'shelf');
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      '',
    );
    // 把整个模型的节点挪开一截：实际包围盒要按节点变换之后的顶点算
    gltf.scene.children[0]!.position.set(0.3, 0, 0);
    const actual = modelBox(gltf.scene);
    expect(actual.min[0]).toBeCloseTo(-0.3, 6);
    expect(actual.max[0]).toBeCloseTo(0.9, 6);
    const half: BoxLike = { min: [0, 0, 0], max: [0.6, 0.7, 0.2] };
    const { fit, box } = place(gltf.scene, half);
    expect(fit?.scale).toBeCloseTo(0.5, 6);
    expectInside(box, half);
    // 记录与模型一致时不动
    const same: BoxLike = { min: [0, 0, 0], max: [1.2, 1.4, 0.4] };
    const exact = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      '',
    );
    expect(place(exact.scene, same).fit).toBeNull();
  });
});
