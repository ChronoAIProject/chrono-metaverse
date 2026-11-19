import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Point = [number, number, number];
const tau = Math.PI * 2;
const white = '#b4cbd7',
  hull = '#425368',
  graphite = '#192437';
export const ice = '#62f9fa',
  rose = '#ff578c',
  gold = '#ffbc68';

/** 把静止部件按材质烘成少量绘制批次；活动物件复用整组几何。 */
class Model {
  private parts = new Map<string, T.BufferGeometry[]>();
  put(geometry: T.BufferGeometry, color: string, position: Point, rotation: Point = [0, 0, 0]) {
    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    if (part !== geometry) geometry.dispose();
    part.deleteAttribute('uv');
    part
      .rotateX(rotation[0])
      .rotateY(rotation[1])
      .rotateZ(rotation[2])
      .translate(...position);
    const group = this.parts.get(color) ?? [];
    group.push(part);
    this.parts.set(color, group);
  }
  box(size: Point, at: Point, color: string, roll = 0) {
    this.put(new T.BoxGeometry(...size), color, at, [0, 0, roll]);
  }
  lathe(profile: [number, number][], at: Point, color: string, sides = 16, roll = 0) {
    this.put(
      new T.LatheGeometry(
        profile.map(([r, y]) => new T.Vector2(r, y)),
        sides,
      ),
      color,
      at,
      [0, 0, roll],
    );
  }
  ring(radius: number, tube: number, at: Point, color: string, tilt = 0) {
    this.put(new T.TorusGeometry(radius, tube, 6, 64), color, at, [tilt, 0, 0]);
  }
  finish() {
    const group = new T.Group();
    for (const [color, parts] of this.parts) {
      const glowing = [ice, rose, gold].includes(color);
      const material = glowing
        ? new T.MeshBasicMaterial({ color, toneMapped: false })
        : new T.MeshStandardMaterial({
            color,
            metalness: 0.38,
            roughness: 0.55,
            flatShading: true,
          });
      group.add(new T.Mesh(mergeGeometries(parts)!, material));
      parts.forEach((p) => p.dispose());
    }
    return group;
  }
}

/** 穿梭艇的弦截面从机尾到机鼻逐渐收尖，两侧发动机及连续舷窗在远处仍有轮廓。 */
export function airship() {
  const m = new Model();
  const body = new T.LatheGeometry(
    [
      [-15, 0],
      [-14, 2.7],
      [-10, 3.7],
      [3, 3.5],
      [10, 2.1],
      [17, 0.3],
      [17.4, 0],
    ].map(([x, r]) => new T.Vector2(r, x)),
    10,
  );
  body.scale(1, 1, 1.65);
  m.put(body, white, [0, 0, 0], [0, 0, -Math.PI / 2]);
  m.box([15, 1.3, 5.8], [-1, 3, 0], graphite);
  m.box([8, 1.1, 4], [-3, 4, 0], hull);
  for (const side of [-1, 1]) {
    m.box([13, 0.85, 5.8], [-5, -0.5, 6.3 * side], hull, 0.06);
    m.lathe(
      [
        [0, -7],
        [1.65, -7],
        [2, -5],
        [1.5, 4],
        [0, 6],
      ],
      [-5, -0.5, 8.2 * side],
      graphite,
      10,
      -Math.PI / 2,
    );
    m.lathe(
      [
        [0, -1],
        [1.4, -1],
        [1.25, 0],
        [0, 0],
      ],
      [-11.6, -0.5, 8.2 * side],
      ice,
      12,
      -Math.PI / 2,
    );
    m.box([10, 0.26, 0.35], [-5, -0.2, 9.7 * side], ice);
    for (let i = 0; i < 12; i++) m.box([0.63, 0.53, 0.35], [-9 + i, 1.4, side * 5.24], gold);
    m.box([4, 3, 0.68], [-10, 2.6, side * 3.8], graphite, -0.55);
  }
  // 船桥两层观景窗与背鳍从远处也能识别出船首、舰桥和引擎。
  for (const side of [-1, 1]) {
    for (let i = 0; i < 16; i++) m.box([0.54, 0.35, 0.22], [-7 + i * 0.77, 3.35, side * 2.91], ice);
    m.box([14, 0.18, 0.25], [-0.6, 2.62, side * 3.82], rose);
    for (let i = 0; i < 7; i++) m.box([0.35, 1.2, 1.1], [-9 + i * 1.07, -0.22, side * 9.5], hull);
  }
  m.box([3.6, 2.6, 2], [-5.8, 5.2, 0], hull, -0.24);
  m.box([0.25, 1.9, 0.25], [-6.4, 6.8, 0], white);
  m.box([0.26, 0.38, 0.26], [-6.4, 7.8, 0], rose);
  m.box([15, 0.38, 2], [0, -3.2, 0], rose);
  return m.finish();
}

export function drone() {
  const m = new Model();
  m.box([3.4, 1.25, 2.2], [0, 0, 0], white);
  m.box([1.4, 1.1, 1.4], [0, -1, 0], graphite);
  m.box([0.8, 0.48, 0.2], [0, -1, 0.74], ice);
  for (const x of [-2.6, 2.6])
    for (const z of [-1.95, 1.95]) {
      m.box([2.8, 0.24, 0.32], [x / 2, 0, z * 0.7], hull);
      m.ring(1.52, 0.2, [x, 0, z], white, Math.PI / 2);
      m.ring(1.47, 0.08, [x, 0.19, z], ice, Math.PI / 2);
      m.box([2.7, 0.12, 0.32], [x, 0, z], graphite);
    }
  return m.finish();
}

export function station() {
  const m = new Model();
  for (const r of [15.2, 18]) m.ring(r, 0.68, [0, 0, 0], white, 1.02);
  m.ring(17.9, 0.23, [0, 0.45, 0], ice, 1.02);
  for (let i = 0; i < 16; i++) {
    const a = (tau * i) / 16,
      x = 16.7 * Math.cos(a),
      y = 16.7 * Math.sin(a) * Math.cos(1.02),
      z = 16.7 * Math.sin(a) * Math.sin(1.02);
    for (let k = 0; k < 3; k++) {
      m.box([0.7, 0.36, 0.4], [x - 0.85 + k * 0.85, y + 0.5, z + 1.35], ice);
    }
    m.box([2.8, 1.5, 2.6], [x, y, z], i % 4 === 0 ? gold : hull);
    if (i % 2 === 0) {
      const end = new T.Vector3(x, y, z),
        g = new T.CylinderGeometry(0.38, 0.38, end.length(), 6);
      g.applyQuaternion(
        new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), end.clone().normalize()),
      );
      m.put(g, white, [x / 2, y / 2, z / 2]);
    }
  }
  m.lathe(
    [
      [0, -10],
      [2, -10],
      [3, -8],
      [3, -3],
      [4, -2],
      [4, 1],
      [2.3, 2],
      [2.3, 9],
      [0, 10],
    ],
    [0, 0, 0],
    white,
  );
  m.ring(3.1, 0.3, [0, -5, 0], rose, Math.PI / 2);
  for (const side of [-1, 1]) {
    m.lathe(
      [
        [0, -4],
        [1.1, -4],
        [1.45, -3],
        [1.45, 4],
        [0, 5],
      ],
      [side * 4, 2, 0],
      white,
    );
    m.box([0.34, 7, 0.34], [side * 4, 9, 0], hull);
    m.ring(2.2, 0.2, [side * 4, 11.7, 0], gold, 0.48);
    m.box([1, 1.2, 1], [side * 4, 9.4, 0], ice);
  }
  m.box([53, 0.8, 0.8], [0, 0, 0], white);
  for (const side of [-1, 1])
    for (let i = 0; i < 3; i++) {
      const x = side * (19 + i * 3.8);
      m.box([3.5, 9, 0.4], [x, 1, -0.5], gold);
      for (let j = 0; j < 8; j++) m.box([3.15, 0.83, 0.18], [x, -2.8 + j * 1.07, -0.15], '#33426e');
    }
  return m.finish();
}

export function rocket() {
  const m = new Model();
  m.lathe(
    [
      [0, -7],
      [1.4, -7],
      [1.65, -5],
      [1.65, 4],
      [1.4, 6],
      [0.62, 8],
      [0, 9],
    ],
    [0, 0, 0],
    white,
  );
  for (let i = 0; i < 7; i++)
    m.box([0.42, 0.56, 0.3], [((i % 3) - 1) * 0.55, 3.9 - Math.floor(i / 3) * 0.8, 1.48], graphite);
  for (const x of [-1, 1]) m.box([0.18, 7, 0.24], [x * 0.74, -0.9, 1.36], gold);
  m.lathe(
    [
      [1.66, -1],
      [1.66, 0.1],
    ],
    [0, 0, 0],
    graphite,
  );
  for (const x of [-1.8, 1.8]) {
    m.lathe(
      [
        [0, -7.5],
        [0.74, -7.4],
        [0.74, 0.2],
        [0, 2],
      ],
      [x, 0, 0],
      hull,
    );
    m.lathe(
      [
        [0, -9.8],
        [0.6, -7.3],
        [0, -7.3],
      ],
      [x, 0, 0],
      gold,
    );
  }
  m.lathe(
    [
      [0, -17],
      [0.6, -12],
      [1.1, -7],
      [0, -7],
    ],
    [0, 0, 0],
    ice,
  );
  m.lathe(
    [
      [0, -12],
      [0.9, -7],
      [0, -7],
    ],
    [0, 0, 0.5],
    gold,
  );
  return m.finish();
}

/** 巨幕外壳的尺寸以 16:9 画面为基准，城市与轨道共享同一套转播设备造型。 */
export function screenFrame() {
  const m = new Model();
  // 向后伸出的悬浮基座、桁架和远端信标交代巨幕厚度。
  m.box([13, 0.36, 3.8], [0, -5.8, -1.35], hull);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++)
      m.box([0.34, 1.65, 0.6], [side * (5.8 + i * 0.65), -5.68, -0.68], graphite, side * 0.42);
    m.box([0.15, 1.25, 0.15], [side * 8.1, 5.75, -0.5], hull);
    m.box([0.2, 0.25, 0.2], [side * 8.1, 6.46, -0.5], rose);
  }
  m.box([17.2, 10.4, 0.85], [0, 0, -0.52], graphite);
  for (const x of [-8.58, 8.58]) {
    m.box([0.36, 10.9, 1.4], [x, 0, -0.45], white);
    m.box([0.12, 7, 0.16], [x, 0, 0.3], ice);
    for (const y of [-4.7, -4.3, 4.3, 4.7]) m.box([0.58, 0.18, 1.5], [x, y, -0.45], gold);
  }
  m.box([16.5, 0.12, 1.15], [0, 4.7, -0.62], ice);
  m.box([5.5, 0.23, 1.15], [4.7, -5.26, -0.52], rose);
  for (const x of [-6.5, 6.5]) {
    m.lathe(
      [
        [0, -1.2],
        [0.35, -1.1],
        [0.68, -0.4],
        [0.75, 0.5],
        [0, 0.5],
      ],
      [x, -5.45, -0.55],
      hull,
    );
    m.ring(0.52, 0.1, [x, -6, -0.55], ice, Math.PI / 2);
  }
  return m.finish();
}

export function flightLane(points: T.Vector3[], color: string, radius: number) {
  const curve = new T.CatmullRomCurve3(points);
  return new T.Mesh(
    new T.TubeGeometry(curve, 90, radius, 4, false),
    new T.MeshBasicMaterial({ color, toneMapped: false }),
  );
}
