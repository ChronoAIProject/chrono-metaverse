import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { Shape } from '../core/shapes/types';
import { shapeToGlb } from '../fixtures/glb';
import {
  fitModelInto,
  measureModel,
  modelFit,
  modelFitWarning,
  sizeTolerance,
  type BoxLike,
} from './modelFit';

/** 夹具的 glb 写出器 → GLTFLoader 解析，和网站加载物件模型走同一条路。 */
function parse(bytes: Uint8Array): Promise<THREE.Object3D> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject);
  });
}

/** 一个"柜子"：原点在底面中心的盒子，`scale` 倍大，底面中心挪到 `shift`。 */
function cabinet(scale: number, shift: [number, number, number] = [0, 0, 0]): Shape {
  return {
    type: 'group',
    transform: { position: shift, scale: [scale, scale, scale] },
    children: [
      { type: 'box', size: [1.2, 1.4, 0.4], material: { color: [190, 160, 120] } },
      {
        type: 'cylinder',
        radius: 0.05,
        height: 0.3,
        transform: { position: [0.4, 1.4, 0] },
        material: { color: [80, 80, 80] },
      },
    ],
  };
}

/** 记录的 bounds：柜子按原尺寸放在 (2, 0, 3)。 */
const BOUNDS = { min: [1.4, 0, 2.8], max: [2.6, 1.7, 3.2] } as const;

/** 按网站的摆法挂上：容器在 bounds 底面中心，模型（可能套一层兜底的组）挂在容器下，返回世界包围盒。 */
function placed(model: THREE.Object3D): { box: THREE.Box3; moved: boolean } {
  const holder = new THREE.Group();
  holder.position.set(
    (BOUNDS.min[0] + BOUNDS.max[0]) / 2,
    BOUNDS.min[1],
    (BOUNDS.min[2] + BOUNDS.max[2]) / 2,
  );
  const instance = model.clone(true);
  const fit = modelFit(measureModel(model)!, BOUNDS);
  const object = fitModelInto(instance, fit);
  holder.add(object);
  holder.updateMatrixWorld(true);
  return { box: new THREE.Box3().setFromObject(holder, true), moved: object !== instance };
}

function expectBox(box: THREE.Box3 | BoxLike, min: readonly number[], max: readonly number[]) {
  const arrays =
    box instanceof THREE.Box3 ? { min: box.min.toArray(), max: box.max.toArray() } : box;
  arrays.min.forEach((v, k) => expect(v).toBeCloseTo(min[k]!, 5));
  arrays.max.forEach((v, k) => expect(v).toBeCloseTo(max[k]!, 5));
}

describe('只有模型的物件：按实际包围盒兜底摆放', () => {
  it('实际比 bounds 大很多的模型等比缩进 bounds，底面中心对齐', async () => {
    // 三倍大，原点还偏了：整体缩到三分之一，再平移到 bounds 的底面中心
    const model = await parse(shapeToGlb(cabinet(3, [0.9, 0.3, -0.6])));
    const actual = measureModel(model)!;
    expectBox(actual, [-0.9, 0.3, -1.2], [2.7, 5.4, 0]);
    const fit = modelFit(actual, BOUNDS)!;
    expect(fit.scale).toBeCloseTo(1 / 3, 6);
    const { box, moved } = placed(model);
    expect(moved).toBe(true);
    expectBox(box, BOUNDS.min, BOUNDS.max);
    expect(modelFitWarning('cabinet-01', fit)).toBe(
      'cabinet-01：模型实际尺寸 3.60 × 5.10 × 1.20 米超出记录的 bounds 1.20 × 1.70 × 0.40 米，' +
        '已等比缩小到 33.3% 放进 bounds',
    );
  });

  it('只有一条边超出：按超出最多的那条边的比例缩，别的边跟着等比缩', () => {
    const fit = modelFit({ min: [-1, 0, -0.2], max: [1, 1.7, 0.2] }, BOUNDS)!;
    expect(fit.scale).toBeCloseTo(0.6, 9);
    expect(fit.offset.map(Math.abs)).toEqual([0, 0, 0]);
  });

  it('符合的模型不动：原样返回实例，画得和以前一样', async () => {
    const model = await parse(shapeToGlb(cabinet(1)));
    expect(modelFit(measureModel(model)!, BOUNDS)).toBeNull();
    const { box, moved } = placed(model);
    expect(moved).toBe(false);
    expectBox(box, BOUNDS.min, BOUNDS.max);
  });

  it('容差是 max(2 厘米, 记录边长的 1%)，比记录小的模型也不放大', () => {
    expect(sizeTolerance(0.5)).toBe(0.02);
    expect(sizeTolerance(10)).toBeCloseTo(0.1, 12);
    const record = { min: [0, 0, 0], max: [1, 1, 10] };
    // 1 米的边长出 1.5 厘米、10 米的边长出 8 厘米：都在容差里
    expect(modelFit({ min: [0, 0, 0], max: [1.015, 1, 10.08] }, record)).toBeNull();
    // 1 米的边长出 3 厘米：超出
    expect(modelFit({ min: [0, 0, 0], max: [1.03, 1, 10] }, record)?.scale).toBeCloseTo(
      1 / 1.03,
      9,
    );
    // 10 米的边长出 12 厘米：超出
    expect(modelFit({ min: [0, 0, 0], max: [1, 1, 10.12] }, record)?.scale).toBeCloseTo(
      10 / 10.12,
      9,
    );
    // 小一半的模型照原样画
    expect(modelFit({ min: [0, 0, 0], max: [0.5, 0.5, 5] }, record)).toBeNull();
  });

  it('退化的记录和坏数据不动', () => {
    // 记录的厚度是 0：这条边不参与求比例；别的边都放得下就不动
    expect(modelFit({ min: [0, 0, 0], max: [1, 1, 0.1] }, { min: [0, 0, 0], max: [1, 1, 0] })).toBe(
      null,
    );
    expect(modelFit({ min: [0, 0, 0], max: [NaN, 1, 1] }, BOUNDS)).toBeNull();
    expect(modelFit({ min: [0, 0, 0], max: [5, 5, 5] }, { min: [1, 0, 0], max: [0, 1, 1] })).toBe(
      null,
    );
  });

  it('实际包围盒按顶点算：含节点变换，转过的模型不按外包盒放大', () => {
    const root = new THREE.Group();
    const node = new THREE.Group();
    node.position.set(0, 0.5, 0);
    node.rotation.y = Math.PI / 4;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    node.add(mesh);
    root.add(node);
    const box = measureModel(root)!;
    const half = Math.SQRT1_2;
    expectBox(box, [-half, 0, -half], [half, 1, half]);
    // 根节点自己的变换也算进去（模型挂上去以后的坐标）
    root.scale.setScalar(2);
    expectBox(measureModel(root)!, [-2 * half, 0, -2 * half], [2 * half, 2, 2 * half]);
    expect(measureModel(new THREE.Group())).toBeNull();
  });
});
