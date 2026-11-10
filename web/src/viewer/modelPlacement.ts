import * as THREE from 'three';

/**
 * 只有模型的物件怎么摆（docs/SHAPES.md 第 3 节"引用外部模型的物件"）。
 *
 * 物件可以带 `transform: {yaw?, pitch?, roll?}`：模型绕自己的原点转这些角度（顺序同 SHAPES 1：
 * `Ry(yaw) · Rx(pitch) · Rz(roll)`），同一个模型摆几个朝向时只要导出一份 glb。转过之后，模型包围盒 8 个
 * 角点的外包盒的底面中心对齐物件 `bounds` 的底面中心（调用方把容器放在 `bounds` 的底面中心）。只有偏航、
 * 模型原点在底面中心时，这就是"原点放在 `bounds` 的底面中心、绕竖直轴转"。与服务端
 * `check::rotated_model_bounds` 的算法相同。
 */

export interface ModelRotation {
  readonly yaw?: number;
  readonly pitch?: number;
  readonly roll?: number;
}

/** 有旋转时返回欧拉角（three.js 的 `YXZ` 顺序就是 `Ry · Rx · Rz`）；没有旋转时返回 null。 */
export function modelEuler(transform: ModelRotation | undefined): THREE.Euler | null {
  const yaw = transform?.yaw ?? 0;
  const pitch = transform?.pitch ?? 0;
  const roll = transform?.roll ?? 0;
  if (yaw === 0 && pitch === 0 && roll === 0) return null;
  const rad = THREE.MathUtils.degToRad;
  return new THREE.Euler(rad(pitch), rad(yaw), rad(roll), 'YXZ');
}

/** 模型包围盒转过之后的外包盒（8 个角点）。 */
export function rotatedBox(box: THREE.Box3, euler: THREE.Euler | null): THREE.Box3 {
  if (euler === null) return box.clone();
  const matrix = new THREE.Matrix4().makeRotationFromEuler(euler);
  const out = new THREE.Box3();
  for (let i = 0; i < 8; i += 1) {
    out.expandByPoint(
      new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).applyMatrix4(matrix),
    );
  }
  return out;
}

/** 能当包围盒用的最小形状（与 modelFit.ts 的 `BoxLike` 相同）。 */
export interface BoxInput {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

function toBox3(box: BoxInput): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(box.min[0] ?? 0, box.min[1] ?? 0, box.min[2] ?? 0),
    new THREE.Vector3(box.max[0] ?? 0, box.max[1] ?? 0, box.max[2] ?? 0),
  );
}

/**
 * 模型按 `placeRotatedModel` 摆好以后，它的包围盒在容器（`bounds` 底面中心）坐标里的样子：
 * 没有旋转时就是模型自己的包围盒（模型不动）；有旋转时是转过之后的外包盒，底面中心在原点。
 * 网站的兜底（modelFit.ts）拿它和记录的 `bounds` 比。
 */
export function placedModelBox(box: BoxInput, transform: ModelRotation | undefined): BoxInput {
  const euler = modelEuler(transform);
  if (euler === null) return box;
  const turned = rotatedBox(toBox3(box), euler);
  const cx = (turned.min.x + turned.max.x) / 2;
  const cz = (turned.min.z + turned.max.z) / 2;
  const bottom = turned.min.y;
  return {
    min: [turned.min.x - cx, 0, turned.min.z - cz],
    max: [turned.max.x - cx, turned.max.y - bottom, turned.max.z - cz],
  };
}

/**
 * 把加载好的模型按物件的 `transform` 转好，并平移到"转过之后的外包盒底面中心在容器原点"。
 * 没有旋转时不动模型（原点就在底面中心）。`own` 是已经量好的模型包围盒（逐顶点，sceneView 每个模型
 * 只量一次）；不给时按 three.js 的包围盒现量。
 */
export function placeRotatedModel(
  object: THREE.Object3D,
  transform: ModelRotation | undefined,
  own?: BoxInput,
): void {
  const euler = modelEuler(transform);
  if (euler === null) return;
  let box: THREE.Box3;
  if (own === undefined) {
    object.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(object);
  } else {
    box = toBox3(own);
  }
  if (box.isEmpty()) return;
  const turned = rotatedBox(box, euler);
  object.rotation.copy(euler);
  object.position.set(
    -(turned.min.x + turned.max.x) / 2,
    -turned.min.y,
    -(turned.min.z + turned.max.z) / 2,
  );
  object.updateMatrix();
}
