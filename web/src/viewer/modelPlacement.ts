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

/**
 * 把加载好的模型按物件的 `transform` 转好，并平移到"转过之后的外包盒底面中心在容器原点"。
 * 没有旋转时不动模型（原点就在底面中心）。
 */
export function placeRotatedModel(
  object: THREE.Object3D,
  transform: ModelRotation | undefined,
): void {
  const euler = modelEuler(transform);
  if (euler === null) return;
  object.updateMatrixWorld(true);
  const own = new THREE.Box3().setFromObject(object);
  if (own.isEmpty()) return;
  const turned = rotatedBox(own, euler);
  object.rotation.copy(euler);
  object.position.set(
    -(turned.min.x + turned.max.x) / 2,
    -turned.min.y,
    -(turned.min.z + turned.max.z) / 2,
  );
  object.updateMatrix();
}
