import * as THREE from 'three';

/**
 * 镜头取景：给一个包围盒，算出让它占满画面（留出边距）的镜头位置和观察点。
 *
 * - 斜上方俯视，仰角默认 45°；
 * - 方位角在东南方向（+x、+z 之间）的一组候选里挑，取能让包围盒显得最大的那个
 *   （长方形房间会自动让长边横在宽屏上，竖屏手机上则竖着放）；
 * - 距离按透视投影精确计算：包围盒 8 个角都落在画面四边各留 `margin` 的范围里
 *   （默认四边各 6%，合计留出约 12% 的边距，房间占满其余部分）；
 * - 近处的角投影得大、远处的小，所以再把观察点在画面平面里挪几次，让投影居中。
 *
 * 纯计算，不碰 WebGL，单元测试直接验证投影结果。
 */
export interface FrameOptions {
  /** 竖直视场角（度），即 PerspectiveCamera.fov。 */
  readonly fov: number;
  /** 画面宽高比。 */
  readonly aspect: number;
  /** 四边各留的边距（占画面宽 / 高的比例），默认 0.06（两边合计 12%）。 */
  readonly margin?: number;
  /** 仰角（度），默认 45。 */
  readonly elevation?: number;
  /** 候选方位角（度，从 +z 往 +x 量），默认 15°–75° 每 5° 一个。 */
  readonly azimuths?: readonly number[];
}

export interface CameraFrame {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  /** 镜头到观察点的距离。 */
  readonly distance: number;
  /** 选中的方位角（度）。 */
  readonly azimuth: number;
}

export const DEFAULT_MARGIN = 0.06;
export const DEFAULT_ELEVATION = 45;
const DEFAULT_AZIMUTHS = Array.from({ length: 13 }, (_, i) => 15 + i * 5);
/** 方位角打分相同时偏向这个角度（和原来的默认镜头方向接近）。 */
const PREFERRED_AZIMUTH = 35;

function corners(box: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
    }
  }
  return out;
}

/** 镜头的三个方向：back 从观察点指向镜头，right、up 是画面的右和上。 */
function basis(azimuth: number, elevation: number) {
  const a = THREE.MathUtils.degToRad(azimuth);
  const e = THREE.MathUtils.degToRad(elevation);
  const back = new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  return { back, right, up };
}

function fitAt(
  points: readonly THREE.Vector3[],
  center: THREE.Vector3,
  azimuth: number,
  elevation: number,
  tx: number,
  ty: number,
): CameraFrame {
  const { back, right, up } = basis(azimuth, elevation);
  const target = center.clone();
  let distance = 0;
  const rel = new THREE.Vector3();
  for (let pass = 0; pass < 6; pass += 1) {
    // 1. 当前观察点下，让每个角都落在可用范围里需要的最小距离。
    distance = 0;
    for (const p of points) {
      rel.subVectors(p, target);
      const x = rel.dot(right);
      const y = rel.dot(up);
      const z = rel.dot(back);
      distance = Math.max(distance, z + Math.abs(x) / tx, z + Math.abs(y) / ty);
    }
    distance = Math.max(distance, 1e-3);
    // 2. 投影范围的中心偏了多少（按可用范围归一化），把观察点挪过去。
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      rel.subVectors(p, target);
      const depth = Math.max(1e-3, distance - rel.dot(back));
      const x = rel.dot(right) / (depth * tx);
      const y = rel.dot(up) / (depth * ty);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const shiftX = (minX + maxX) / 2;
    const shiftY = (minY + maxY) / 2;
    if (Math.abs(shiftX) < 1e-4 && Math.abs(shiftY) < 1e-4) break;
    target.addScaledVector(right, shiftX * distance * tx);
    target.addScaledVector(up, shiftY * distance * ty);
  }
  // 挪完观察点后再算一次距离，保证所有角都在范围里。
  distance = 0;
  for (const p of points) {
    rel.subVectors(p, target);
    const x = rel.dot(right);
    const y = rel.dot(up);
    const z = rel.dot(back);
    distance = Math.max(distance, z + Math.abs(x) / tx, z + Math.abs(y) / ty);
  }
  distance = Math.max(distance, 1e-3);
  return {
    position: target.clone().addScaledVector(back, distance),
    target,
    distance,
    azimuth,
  };
}

/** 让包围盒占满画面（四边留 margin）的镜头。包围盒为空时返回 null。 */
export function frameBox(box: THREE.Box3, options: FrameOptions): CameraFrame | null {
  if (box.isEmpty()) return null;
  const margin = Math.min(0.4, Math.max(0, options.margin ?? DEFAULT_MARGIN));
  const usable = 1 - 2 * margin;
  const ty = Math.tan(THREE.MathUtils.degToRad(options.fov) / 2) * usable;
  const tx = ty * Math.max(0.05, options.aspect);
  const elevation = options.elevation ?? DEFAULT_ELEVATION;
  // 太薄的盒子（只有地面）给一点厚度，免得退化。
  const padded = box.clone();
  const size = padded.getSize(new THREE.Vector3());
  const minSide = Math.max(0.5, Math.max(size.x, size.z) * 0.02);
  if (size.y < minSide) padded.max.y = padded.min.y + minSide;
  if (size.x < minSide) padded.expandByVector(new THREE.Vector3((minSide - size.x) / 2, 0, 0));
  if (size.z < minSide) padded.expandByVector(new THREE.Vector3(0, 0, (minSide - size.z) / 2));
  const points = corners(padded);
  const center = padded.getCenter(new THREE.Vector3());
  let best: CameraFrame | null = null;
  for (const azimuth of options.azimuths ?? DEFAULT_AZIMUTHS) {
    const frame = fitAt(points, center, azimuth, elevation, tx, ty);
    if (
      best === null ||
      frame.distance < best.distance - 1e-6 ||
      (Math.abs(frame.distance - best.distance) <= 1e-6 &&
        Math.abs(azimuth - PREFERRED_AZIMUTH) < Math.abs(best.azimuth - PREFERRED_AZIMUTH))
    ) {
      best = frame;
    }
  }
  return best;
}

/**
 * 包围盒按若干个裁剪盒取交集后合并（取景只看实体区里的内容）。
 * 没有裁剪盒时原样返回。
 */
export function clipBox(box: THREE.Box3, clips: readonly THREE.Box3[]): THREE.Box3 {
  if (clips.length === 0 || box.isEmpty()) return box.clone();
  const out = new THREE.Box3();
  for (const clip of clips) {
    const part = box.clone().intersect(clip);
    if (!part.isEmpty()) out.union(part);
  }
  return out;
}

/** 扫描取景默认丢掉每个轴两端各 2% 的表面（零星的离群点）。 */
export const SCAN_PERCENTILE = 0.02;
/** 算分位包围盒时最多取这么多个三角形（按固定步长抽样）：几十万个三角形的扫描也只要几十毫秒。 */
export const SCAN_MAX_SAMPLES = 20_000;

/** 下标占的二进制位数：排序时坐标和下标打包成一个数（见 `sortedOrder`）。 */
const INDEX_BITS = 20;

/**
 * 按坐标从小到大排好的下标。坐标（相对最小值取整到 0.1 毫米，范围太大时放粗）和下标打包成
 * 一个整数，用 Float64Array 的原生排序，比带比较函数的排序快几倍；点太多时退回比较函数。
 */
function sortedOrder(coordinate: Float64Array): Uint32Array {
  const count = coordinate.length;
  const order = new Uint32Array(count);
  let min = Infinity;
  let max = -Infinity;
  for (const v of coordinate) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const slots = 2 ** INDEX_BITS;
  if (count > slots || !Number.isFinite(max - min)) {
    for (let i = 0; i < count; i += 1) order[i] = i;
    return order.sort((a, b) => coordinate[a]! - coordinate[b]!);
  }
  // 打包后的整数不超过 2^52（双精度能精确表示）。
  const step = Math.max(1e-4, (max - min) / 2 ** (52 - INDEX_BITS));
  const keys = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    keys[i] = Math.floor((coordinate[i]! - min) / step) * slots + i;
  }
  keys.sort();
  for (let i = 0; i < count; i += 1) order[i] = keys[i]! % slots;
  return order;
}

/**
 * 一组点（x, y, z 依次排列）的分位包围盒：每个轴分别按坐标排序，取累计权重到 `low` 和
 * `1 − low` 处的坐标。没有权重（或权重全为 0）时每个点一样重，就是普通的分位数。
 */
export function percentileBox(
  points: ArrayLike<number>,
  low = SCAN_PERCENTILE,
  weights?: ArrayLike<number>,
): THREE.Box3 {
  const count = Math.floor(points.length / 3);
  if (count === 0) return new THREE.Box3();
  const fraction = Math.min(0.49, Math.max(0, low));
  const weight = new Float64Array(count);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const w = weights?.[i];
    weight[i] = w !== undefined && Number.isFinite(w) && w > 0 ? w : 0;
    total += weight[i]!;
  }
  if (!(total > 0)) {
    weight.fill(1);
    total = count;
  }
  const coordinate = new Float64Array(count);
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();
  for (let k = 0; k < 3; k += 1) {
    for (let i = 0; i < count; i += 1) coordinate[i] = points[i * 3 + k]!;
    const order = sortedOrder(coordinate);
    // 从两头往里累计权重，超过 low × 总权重的第一个点就是这一侧的边界。
    let sum = 0;
    let lo = 0;
    while (lo < count - 1 && sum + weight[order[lo]!]! <= fraction * total) {
      sum += weight[order[lo]!]!;
      lo += 1;
    }
    sum = 0;
    let hi = count - 1;
    while (hi > lo && sum + weight[order[hi]!]! <= fraction * total) {
      sum += weight[order[hi]!]!;
      hi -= 1;
    }
    min.setComponent(k, coordinate[order[lo]!]!);
    max.setComponent(k, coordinate[order[hi]!]!);
  }
  return new THREE.Box3(min, max);
}

/**
 * 扫描模型（世界坐标）的取景包围盒：去掉零星的离群点（窗外、镜子里、飞点）以后的范围。
 *
 * 所有网格的三角形按固定步长抽样，三个顶点（世界坐标）各带三角形面积的三分之一作权重，
 * 每个轴丢掉两端各 `low` 的面积。按面积而不是按顶点个数：网格疏密不均时（家具细、
 * 墙和地面粗）顶点个数的分位会把墙切掉，按面积就是按表面均匀取点；
 * 扫描的网格本来就大致均匀，两种算法结果接近。
 * 调用前要先更新世界矩阵（`updateMatrixWorld`）。
 *
 * 不用 `Box3.expandByObject`：它把网格局部的包围盒转到世界坐标再取外包盒，
 * 扫描是斜着拍的（对齐变换带旋转），外包盒会比房间大一圈。
 */
export function scanFrameBox(
  scan: THREE.Object3D,
  low = SCAN_PERCENTILE,
  maxSamples = SCAN_MAX_SAMPLES,
): THREE.Box3 {
  const meshes: { mesh: THREE.Mesh; triangles: number }[] = [];
  let total = 0;
  scan.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true || mesh.geometry?.getAttribute('position') === undefined) return;
    const index = mesh.geometry.getIndex();
    const triangles = Math.floor(
      (index !== null ? index.count : mesh.geometry.getAttribute('position').count) / 3,
    );
    meshes.push({ mesh, triangles });
    total += triangles;
  });
  if (total === 0) return new THREE.Box3();
  const stride = Math.max(1, Math.ceil(total / Math.max(1, maxSamples)));
  const sampled = meshes.reduce((sum, { triangles }) => sum + Math.ceil(triangles / stride), 0);
  const points = new Float64Array(sampled * 9);
  const areas = new Float64Array(sampled * 3);
  let n = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const triangle = new THREE.Triangle(a, b, c);
  for (const { mesh, triangles } of meshes) {
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const vertex = (t: number) => (index !== null ? index.getX(t) : t);
    for (let t = 0; t < triangles; t += stride) {
      a.fromBufferAttribute(position, vertex(t * 3)).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, vertex(t * 3 + 1)).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, vertex(t * 3 + 2)).applyMatrix4(mesh.matrixWorld);
      const area = triangle.getArea() / 3;
      for (const v of [a, b, c]) {
        points[n * 3] = v.x;
        points[n * 3 + 1] = v.y;
        points[n * 3 + 2] = v.z;
        areas[n] = area;
        n += 1;
      }
    }
  }
  return percentileBox(points, low, areas);
}
