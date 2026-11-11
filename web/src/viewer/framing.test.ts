import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  scanCeilingHeight,
  DEFAULT_MARGIN,
  clipBox,
  backgroundFarPlane,
  frameBox,
  percentileBox,
  scanFrameBox,
  type CameraFrame,
} from './framing';

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

  it('办公室镜头保持原来的投影尺寸，同时远裁面覆盖所有窗外建筑', () => {
    const frame = frameBox(room, { fov: FOV, aspect: 1.6 })!;
    const background = new THREE.Box3(
      new THREE.Vector3(-1500, -60, -800),
      new THREE.Vector3(1500, 260, 2000),
    );
    const far = backgroundFarPlane(frame.position, 500, [background]);
    const camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.02, far);
    camera.position.copy(frame.position);
    camera.lookAt(frame.target);
    camera.updateMatrixWorld();
    for (const x of [background.min.x, background.max.x]) {
      for (const y of [background.min.y, background.max.y]) {
        for (const z of [background.min.z, background.max.z])
          expect(camera.position.distanceTo(new THREE.Vector3(x, y, z))).toBeLessThan(far);
      }
    }
    expect(frame.distance).toBeLessThan(20);
    expect(backgroundFarPlane(frame.position, 500, [])).toBe(500);
  });
});

/** 确定的伪随机数（线性同余），测试结果可重复。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 一个四边形（两个三角形）的顶点，按非索引三角形排列。 */
function quad(a: number[], b: number[], c: number[], d: number[]): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

/**
 * 模拟扫描：6 × 5 米、2.8 米高的房间（地面和四面墙是几个大三角形）、房间中间一堆很密的小三角形
 * （家具，顶点多但面积小），再加上房间外面零星的离群点（窗外、飞点）。
 */
function fakeScan(outliers: boolean): THREE.BufferGeometry {
  const positions: number[] = [
    ...quad([0, 0, 0], [6, 0, 0], [6, 0, 5], [0, 0, 5]),
    ...quad([0, 0, 0], [6, 0, 0], [6, 2.8, 0], [0, 2.8, 0]),
    ...quad([0, 0, 5], [6, 0, 5], [6, 2.8, 5], [0, 2.8, 5]),
    ...quad([0, 0, 0], [0, 0, 5], [0, 2.8, 5], [0, 2.8, 0]),
    ...quad([6, 0, 0], [6, 0, 5], [6, 2.8, 5], [6, 2.8, 0]),
  ];
  const rand = random(7);
  for (let i = 0; i < 4000; i += 1) {
    const x = 2 + rand() * 2;
    const y = rand() * 0.9;
    const z = 1.5 + rand() * 2;
    positions.push(x, y, z, x + 0.02, y, z, x, y + 0.02, z);
  }
  if (outliers) {
    for (let i = 0; i < 30; i += 1) {
      const x = -6 + rand() * 20;
      const z = 9 + rand() * 6;
      positions.push(x, 1, z, x + 0.03, 1, z, x, 1.03, z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

describe('扫描的取景范围（去掉离群点）', () => {
  it('分位包围盒：每个轴丢掉两端各 2%，远处零星的点不影响', () => {
    const rand = random(1);
    const points: number[] = [];
    for (let i = 0; i < 1000; i += 1) points.push(rand() * 6, rand() * 3, rand() * 5);
    for (let i = 0; i < 10; i += 1) points.push(40 + i, -20, 80);
    const box = percentileBox(points);
    expect(box.min.x).toBeGreaterThan(-0.01);
    expect(box.max.x).toBeLessThan(6);
    expect(box.max.x).toBeGreaterThan(5.6);
    expect(box.min.y).toBeGreaterThan(0);
    expect(box.max.z).toBeLessThan(5);
    // 不丢点时就是全部点的包围盒。
    const all = percentileBox(points, 0);
    expect(all.max.x).toBe(49);
    expect(all.min.y).toBe(-20);
    // 离群点离得极远（坐标范围很大）时照样排得对。
    const far = percentileBox([...points, 1e7, -1e7, 3e6]);
    expect(far.min.x).toBeGreaterThan(-0.01);
    expect(far.max.x).toBeLessThan(6);
    expect(far.max.z).toBeLessThan(5);
  });

  it('按权重取分位：少数大权重的点（墙）不会被大量小权重的点（家具）挤掉', () => {
    const points = [0, 0, 0, 10, 3, 8];
    const weights = [100, 100];
    for (let i = 0; i < 500; i += 1) {
      points.push(5, 1, 4);
      weights.push(0.01);
    }
    const weighted = percentileBox(points, 0.02, weights);
    expect(weighted.min.toArray()).toEqual([0, 0, 0]);
    expect(weighted.max.toArray()).toEqual([10, 3, 8]);
    // 不按权重时两头的点被当成离群点丢掉。
    const plain = percentileBox(points, 0.02);
    expect(plain.min.toArray()).toEqual([5, 1, 4]);
    // 权重全为 0 时退回每个点一样重。
    expect(percentileBox(points, 0.02, new Array(points.length / 3).fill(0)).equals(plain)).toBe(
      true,
    );
    expect(percentileBox([]).isEmpty()).toBe(true);
  });

  it('按表面取分位：墙和地面都在范围里，房间外的离群点不在', () => {
    const scan = new THREE.Mesh(fakeScan(true));
    const box = scanFrameBox(scan);
    expect(box.min.x).toBeLessThan(0.3);
    expect(box.max.x).toBeGreaterThan(5.7);
    expect(box.max.y).toBeGreaterThan(2.5);
    expect(box.min.z).toBeLessThan(0.3);
    expect(box.max.z).toBeGreaterThan(4.7);
    // 离群点在 z = 9–15、x = −6–14，不进取景范围。
    expect(box.max.z).toBeLessThan(5.01);
    expect(box.min.x).toBeGreaterThan(-0.01);
    expect(box.max.x).toBeLessThan(6.01);
  });

  it('扫描是斜着摆放的：按世界坐标的顶点算，比外包盒（expandByObject）紧', () => {
    const group = new THREE.Group();
    const scan = new THREE.Mesh(fakeScan(false));
    scan.matrixAutoUpdate = false;
    // 和真实扫描一样：扫描坐标转 61° 再平移才是空间坐标。这里反过来，扫描在世界里是斜的，
    // 所以先把几何体摆成"扫描坐标"，再用对齐变换转回来。
    const align = new THREE.Matrix4()
      .makeTranslation(0.6, 0, -0.4)
      .multiply(new THREE.Matrix4().makeRotationY((-61 * Math.PI) / 180));
    scan.geometry.applyMatrix4(align.clone().invert());
    scan.matrix.copy(align);
    group.add(scan);
    group.updateMatrixWorld(true);
    const box = scanFrameBox(group);
    const loose = new THREE.Box3().expandByObject(group);
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeLessThan(6.01);
    expect(size.z).toBeLessThan(5.01);
    expect(size.x).toBeGreaterThan(5.4);
    const looseSize = loose.getSize(new THREE.Vector3());
    expect(looseSize.x * looseSize.z).toBeGreaterThan(size.x * size.z * 1.5);
  });

  it('带索引的网格、抽样上限和没有网格的情况', () => {
    const geometry = fakeScan(true);
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', geometry.getAttribute('position'));
    const count = geometry.getAttribute('position').count;
    indexed.setIndex(Array.from({ length: count }, (_, i) => i));
    const full = scanFrameBox(new THREE.Mesh(indexed));
    expect(full.equals(scanFrameBox(new THREE.Mesh(geometry)))).toBe(true);
    // 抽样到 2000 个三角形：结果仍然是房间。
    const sampled = scanFrameBox(new THREE.Mesh(geometry), 0.02, 2000);
    expect(sampled.max.z).toBeLessThan(5.01);
    expect(sampled.max.x).toBeGreaterThan(5.5);
    expect(scanFrameBox(new THREE.Group()).isEmpty()).toBe(true);
  });
});

describe('扫描天花板的高度', () => {
  /** 一块水平的面：法线朝下（天花板）或朝上（地面），面积 w × d。 */
  const slab = (y: number, w: number, d: number, down: boolean) => {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(down ? Math.PI / 2 : -Math.PI / 2);
    g.translate(0, y, 0);
    return new THREE.Mesh(g);
  };

  it('取朝下的面按面积的低分位：主天花板 2.75 米、一小块吊顶 2.6 米时切到吊顶下面', () => {
    const scan = new THREE.Group();
    scan.add(slab(0, 10, 10, false)); // 地面朝上，不算
    scan.add(slab(2.75, 10, 9.5, true)); // 主天花板 95 平方米
    scan.add(slab(2.6, 10, 0.6, true)); // 吊顶 6 平方米（6%）
    scan.add(slab(1.2, 2, 1, true)); // 桌底朝下，低于 1.8 米不算
    scan.updateMatrixWorld(true);
    expect(scanCeilingHeight(scan)).toBeCloseTo(2.6, 5);
  });

  it('按世界坐标算（扫描带对齐变换）；没扫到天花板时是 null', () => {
    const scan = new THREE.Group();
    scan.add(slab(2.0, 10, 10, true));
    scan.position.y = 0.8;
    scan.updateMatrixWorld(true);
    expect(scanCeilingHeight(scan)).toBeCloseTo(2.8, 5);

    const floorOnly = new THREE.Group();
    floorOnly.add(slab(0, 10, 10, false));
    floorOnly.add(slab(2.7, 1, 1, true)); // 只有 1 平方米朝下，不够
    floorOnly.updateMatrixWorld(true);
    expect(scanCeilingHeight(floorOnly)).toBeNull();
  });
});
