import * as THREE from 'three';

/**
 * 只有模型的物件的兜底摆放（docs/design/server-slim.md 第 9 节）。
 *
 * 物件只有 `assetHash`、没有 `shape` 时，查看器把模型放在记录 `bounds` 的底面中心（模型坐标的原点在底面中心）。
 * 服务端上传核对时已经按顶点数据实测包围盒，引用时要求模型与记录一致（SHAPES 3"模型与记录一致"），
 * 这里只是兜底：模型加载后按顶点算实际包围盒，
 *
 * - 某一边比记录长出 max(2 厘米, 记录边长的 1%) 以上：整体等比缩小到放得进记录（只看超出的那几边），
 *   再把缩小后的底面中心对到记录的底面中心；
 * - 大小没超出，但原点不在底面中心（`|min.y|`、x 和 z 的中点有一个超过 2 厘米）：平移，让底面中心对齐；
 * - 都没有：不动。比记录小的模型不放大（本来就在记录里面）。
 *
 * 判断的误差与接口服务的 `model_bounds_mismatch`（核心库 `check::model_fits_bounds`）相同，
 * 所以服务端认可的模型在这里一律不动。
 */

export interface BoxLike {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

export interface ModelFit {
  /** 等比缩放（0 到 1 之间）。 */
  readonly scale: number;
  /** 缩放之后再平移（模型坐标，米），让底面中心落在原点。 */
  readonly offset: readonly [number, number, number];
  /** `size`：大小超出记录；`position`：大小没超出、原点不在底面中心。 */
  readonly reason: 'size' | 'position';
}

/** 缩放的下限：记录某一边是 0、模型那一边却很厚时不让缩放变成 0（矩阵不可逆）。 */
const MIN_SCALE = 1e-3;
/** 原点偏离底面中心的误差（米），与接口服务相同。 */
export const ORIGIN_TOLERANCE = 0.02;

/** 一条边允许的误差（米）：max(2 厘米, 边长的 1%)。 */
export function fitTolerance(edge: number): number {
  return Math.max(0.02, 0.01 * Math.abs(edge));
}

function finite(box: BoxLike): boolean {
  return [0, 1, 2].every(
    (k) => Number.isFinite(box.min[k]) && Number.isFinite(box.max[k]) && box.max[k]! >= box.min[k]!,
  );
}

/**
 * 模型的实际包围盒（模型坐标）放进记录的 `bounds`（成员坐标）要怎么调；不用调时返回 null。
 * 模型坐标的原点放在记录的底面中心，所以记录在模型坐标里是 `[-w/2, 0, -d/2]` 到 `[w/2, h, d/2]`。
 */
export function modelFit(actual: BoxLike, bounds: BoxLike): ModelFit | null {
  if (!finite(actual) || !finite(bounds)) return null;
  const size = [0, 1, 2].map((k) => actual.max[k]! - actual.min[k]!);
  const edges = [0, 1, 2].map((k) => bounds.max[k]! - bounds.min[k]!);
  const tolerance = edges.map(fitTolerance);
  const over = [0, 1, 2].filter((k) => size[k]! - edges[k]! > tolerance[k]!);
  const align = (scale: number, reason: ModelFit['reason']): ModelFit => ({
    scale,
    offset: [
      (-(actual.min[0]! + actual.max[0]!) / 2) * scale,
      -actual.min[1]! * scale,
      (-(actual.min[2]! + actual.max[2]!) / 2) * scale,
    ],
    reason,
  });
  if (over.length > 0) {
    const scale = Math.max(MIN_SCALE, Math.min(...over.map((k) => edges[k]! / size[k]!)));
    return align(scale, 'size');
  }
  const offCenter =
    Math.abs(actual.min[1]!) > ORIGIN_TOLERANCE ||
    Math.abs((actual.min[0]! + actual.max[0]!) / 2) > ORIGIN_TOLERANCE ||
    Math.abs((actual.min[2]! + actual.max[2]!) / 2) > ORIGIN_TOLERANCE;
  return offCenter ? align(1, 'position') : null;
}

/** 模型（没有父节点的根）按顶点算的实际包围盒（精确模式），模型坐标；没有顶点时各分量不是有限数。 */
export function modelBox(model: THREE.Object3D): BoxLike {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  return { min: box.min.toArray(), max: box.max.toArray() };
}

/** 把调整用到模型实例的根上（实例挂在记录底面中心的那一组下面）。 */
export function applyModelFit(instance: THREE.Object3D, fit: ModelFit | null): void {
  if (fit === null) return;
  instance.scale.setScalar(fit.scale);
  instance.position.set(...fit.offset);
  instance.updateMatrix();
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** 警告文字（控制台和查看器的统计里用）。 */
export function modelFitWarning(entityId: string, actual: BoxLike, bounds: BoxLike, fit: ModelFit) {
  const size = [0, 1, 2].map((k) => round(actual.max[k]! - actual.min[k]!));
  const edges = [0, 1, 2].map((k) => round(bounds.max[k]! - bounds.min[k]!));
  return fit.reason === 'size'
    ? `${entityId}：模型实际大小 [${size.join(', ')}] 米超出记录的范围 [${edges.join(', ')}] 米，` +
        `已按 ${round(fit.scale)} 等比缩小放进范围`
    : `${entityId}：模型偏出记录的范围（原点不在底面中心），已平移进范围`;
}
