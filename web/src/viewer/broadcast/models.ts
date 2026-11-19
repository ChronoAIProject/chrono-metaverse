import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { projectionMaterial } from './projection';

type Point = [number, number, number];

const white = '#b4cbd7',
  hull = '#425368',
  graphite = '#192437';
const ice = '#62f9fa',
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
      const material = projectionMaterial(0.85, [ice, rose, gold].includes(color) ? 0.72 : 0.23);
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
