import * as THREE from 'three';

/**
 * 只有模型的物件的兜底摆放（docs/design/server-slim.md 第 9 节）。
 *
 * 物件只有 `assetHash` 没有 `shape` 时，模型按记录 `bounds` 的底面中心摆放（模型原点在底面中心）。
 * 接口服务引用模型时已经按顶点数据实测包围盒、要求与 `bounds` 一致（SHAPES 第 3 节"模型与记录一致"），
 * 这里只是兜底：模型加载后按顶点算实际包围盒，某条边比记录的边长出 max(2 厘米, 记录边长的 1%) 以上时，
 * 整体等比缩小到放得进 `bounds`，再平移让实际包围盒的底面中心落在 `bounds` 的底面中心。
 * 尺寸符合的模型一点不动（原点有小偏差也不挪，和以前画得完全一样）。
 */

export interface BoxLike {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

export interface ModelFit {
  /** 等比缩放（大于 0、小于 1）。 */
  readonly scale: number;
  /** 缩放之后的平移（相对 `bounds` 的底面中心）。 */
  readonly offset: readonly [number, number, number];
  /** 模型实际的三边长（米）。 */
  readonly actual: readonly [number, number, number];
  /** 记录 `bounds` 的三边长（米）。 */
  readonly expected: readonly [number, number, number];
}

/** 允许的尺寸误差：max(2 厘米, 记录边长的 1%)，与接口服务"模型与记录一致"的容差相同。 */
export function sizeTolerance(edge: number): number {
  return Math.max(0.02, 0.01 * edge);
}

function edges(box: BoxLike): [number, number, number] {
  return [0, 1, 2].map((k) => (box.max[k] ?? 0) - (box.min[k] ?? 0)) as [number, number, number];
}

/**
 * 模型实际包围盒（模型摆在 `bounds` 底面中心之前的坐标）和记录的 `bounds` → 兜底的缩放和平移；
 * 不用动时返回 null。只看尺寸：任何一条边超出容差才缩；记录里长度为 0 的边（退化的记录）
 * 不参与求缩放比例。
 */
export function modelFit(actual: BoxLike, bounds: BoxLike): ModelFit | null {
  const a = edges(actual);
  const b = edges(bounds);
  if ([...a, ...b].some((x) => !Number.isFinite(x) || x < 0)) return null;
  const oversized = [0, 1, 2].some((k) => a[k]! - b[k]! > sizeTolerance(b[k]!));
  if (!oversized) return null;
  let scale = Infinity;
  for (let k = 0; k < 3; k += 1) {
    if (a[k]! > 0 && b[k]! > 0) scale = Math.min(scale, b[k]! / a[k]!);
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale >= 1) return null;
  const cx = ((actual.min[0] ?? 0) + (actual.max[0] ?? 0)) / 2;
  const cz = ((actual.min[2] ?? 0) + (actual.max[2] ?? 0)) / 2;
  const bottom = actual.min[1] ?? 0;
  return {
    scale,
    offset: [-scale * cx, -scale * bottom, -scale * cz],
    actual: a,
    expected: b,
  };
}

/**
 * 模型的实际包围盒：逐个顶点（精确，含节点变换和模型根节点自己的变换），坐标是模型挂上去以后
 * 它父节点的坐标。没有几何时返回 null。
 */
export function measureModel(model: THREE.Object3D): BoxLike | null {
  model.updateWorldMatrix(true, true);
  const toParent = model.parent ? model.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry?.getAttribute('position');
    if (position === undefined) return;
    matrix.multiplyMatrices(toParent, mesh.matrixWorld);
    for (let i = 0; i < position.count; i += 1) {
      mesh.getVertexPosition(i, point);
      box.expandByPoint(point.applyMatrix4(matrix));
    }
  });
  return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
}

/**
 * 兜底摆放：不用动时原样返回实例；要动时套一层按 `fit` 缩放和平移的组再返回。
 * 返回的对象挂在 `bounds` 底面中心的容器下。
 */
export function fitModelInto(instance: THREE.Object3D, fit: ModelFit | null): THREE.Object3D {
  if (fit === null) return instance;
  const wrapper = new THREE.Group();
  wrapper.name = 'model-fit';
  wrapper.scale.setScalar(fit.scale);
  wrapper.position.set(...fit.offset);
  wrapper.add(instance);
  return wrapper;
}

/** 控制台和场景警告里的说明。 */
export function modelFitWarning(entityId: string, fit: ModelFit): string {
  const size = (v: readonly number[]) => v.map((x) => x.toFixed(2)).join(' × ');
  return (
    `${entityId}：模型实际尺寸 ${size(fit.actual)} 米超出记录的 bounds ${size(fit.expected)} 米，` +
    `已等比缩小到 ${(fit.scale * 100).toFixed(1)}% 放进 bounds`
  );
}
