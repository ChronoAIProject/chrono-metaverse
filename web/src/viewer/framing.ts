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
