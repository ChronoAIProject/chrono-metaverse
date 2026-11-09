import { describe, expect, it } from 'vitest';
import { boxMesh } from './box';
import { extrudeMesh } from './extrude';
import { coneMesh, cylinderMesh, latheMesh } from './lathe';
import { loftMesh } from './loft';
import { normalAt, vertexAt, vertexCount, type MeshData } from './meshData';
import { expandOutline } from './outline';
import { smoothPath, sweepMesh } from './sweep';
import {
  distanceToPolyline,
  expectBounds,
  expectOutwardFrom,
  expectWellFormed,
  maxDistanceFrom,
} from './testUtils';
import type { Outline } from './types';
import { len3, type V3 } from './vec';

const square: Outline = {
  points: [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ],
};

function verticesWhere(mesh: MeshData, test: (p: V3) => boolean): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < vertexCount(mesh); i += 1) {
    const p = vertexAt(mesh, i);
    if (test(p)) out.push(p);
  }
  return out;
}

describe('box', () => {
  it('包围盒等于尺寸，原点在底面中心', () => {
    const mesh = boxMesh({ type: 'box', size: [1.2, 0.75, 0.6] });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.6, 0, -0.3], [0.6, 0.75, 0.3]);
    expect(vertexCount(mesh)).toBe(24);
    expectOutwardFrom(mesh, [0, 0.375, 0]);
  });

  it('圆角让棱变圆：顶点变多，角上的顶点离中心更近', () => {
    const size: V3 = [1.2, 0.75, 0.6];
    const center: V3 = [0, 0.375, 0];
    const sharp = boxMesh({ type: 'box', size });
    const round = boxMesh({ type: 'box', size, fillet: 0.05 });
    expectWellFormed(round);
    expectBounds(round, [-0.6, 0, -0.3], [0.6, 0.75, 0.3]);
    expectOutwardFrom(round, center);
    expect(vertexCount(round)).toBeGreaterThan(vertexCount(sharp));

    const sharpCorner = maxDistanceFrom(sharp, center);
    const roundCorner = maxDistanceFrom(round, center);
    expect(sharpCorner).toBeCloseTo(Math.hypot(0.6, 0.375, 0.3), 5);
    expect(roundCorner).toBeLessThan(sharpCorner - 0.01);
    // 最远点不超过"内盒角 + 半径"，采样点离它也很近。
    const ideal = Math.hypot(0.55, 0.325, 0.25) + 0.05;
    expect(roundCorner).toBeLessThanOrEqual(ideal + 1e-6);
    expect(roundCorner).toBeGreaterThan(ideal - 1e-3);
    // 原来的尖角处没有顶点。
    expect(
      verticesWhere(round, (p) => Math.abs(p[0]) > 0.599 && Math.abs(p[1] - 0.375) > 0.374),
    ).toEqual([]);
  });

  it('圆角分段越多顶点越多，曲面法线连续', () => {
    const coarse = boxMesh({ type: 'box', size: [1, 1, 1], fillet: 0.1, segments: 2 });
    const fine = boxMesh({ type: 'box', size: [1, 1, 1], fillet: 0.1, segments: 8 });
    expect(vertexCount(fine)).toBeGreaterThan(vertexCount(coarse));
    expectWellFormed(fine);
  });

  it('圆角和倒角都限制到最短边的一半', () => {
    const mesh = boxMesh({ type: 'box', size: [1, 0.2, 1], fillet: 5 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.5, 0, -0.5], [0.5, 0.2, 0.5]);
    const chamfered = boxMesh({ type: 'box', size: [1, 0.2, 1], chamfer: 5 });
    expectWellFormed(chamfered);
    expectBounds(chamfered, [-0.5, 0, -0.5], [0.5, 0.2, 0.5]);
  });

  it('倒角是平的斜面，角上是法线 (±1,±1,±1)/√3 的三角形', () => {
    const mesh = boxMesh({ type: 'box', size: [1, 1, 1], chamfer: 0.1 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.5, 0, -0.5], [0.5, 1, 0.5]);
    const inv = 1 / Math.sqrt(3);
    let cornerNormals = 0;
    let edgeNormals = 0;
    for (let i = 0; i < vertexCount(mesh); i += 1) {
      const n = normalAt(mesh, i).map(Math.abs);
      if (n.every((c) => Math.abs(c - inv) < 1e-4)) cornerNormals += 1;
      if (n.filter((c) => Math.abs(c - Math.SQRT1_2) < 1e-4).length === 2) edgeNormals += 1;
    }
    expect(cornerNormals).toBe(8 * 3);
    expect(edgeNormals).toBe(12 * 6);
  });

  it('同时给圆角和倒角时以圆角为准', () => {
    const both = boxMesh({ type: 'box', size: [1, 1, 1], fillet: 0.1, chamfer: 0.2 });
    const fillet = boxMesh({ type: 'box', size: [1, 1, 1], fillet: 0.1 });
    expect(Array.from(both.positions)).toEqual(Array.from(fillet.positions));
  });
});

describe('cylinder 与 cone', () => {
  it('圆柱包围盒等于半径和高度', () => {
    const mesh = cylinderMesh({ type: 'cylinder', radius: 0.3, height: 0.7 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.3, 0, -0.3], [0.3, 0.7, 0.3]);
    expectOutwardFrom(mesh, [0, 0.35, 0]);
  });

  it('圆台取上下半径的较大者', () => {
    const mesh = cylinderMesh({ type: 'cylinder', radius: 0.2, radiusTop: 0.4, height: 1 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.4, 0, -0.4], [0.4, 1, 0.4]);
  });

  it('边缘圆角：顶点变多，底面缩进一个圆角半径', () => {
    const sharp = cylinderMesh({ type: 'cylinder', radius: 0.3, height: 0.7 });
    const round = cylinderMesh({ type: 'cylinder', radius: 0.3, height: 0.7, fillet: 0.05 });
    expectWellFormed(round);
    expectBounds(round, [-0.3, 0, -0.3], [0.3, 0.7, 0.3]);
    expectOutwardFrom(round, [0, 0.35, 0]);
    expect(vertexCount(round)).toBeGreaterThan(vertexCount(sharp));
    const bottom = verticesWhere(round, (p) => Math.abs(p[1]) < 1e-6);
    const maxRadius = Math.max(...bottom.map((p) => Math.hypot(p[0], p[2])));
    expect(maxRadius).toBeCloseTo(0.25, 5);
    // 底边到尖角圆的最近距离变大：尖角处没有顶点。
    const corner = Math.min(
      ...verticesWhere(round, () => true).map((p) =>
        Math.hypot(Math.hypot(p[0], p[2]) - 0.3, p[1]),
      ),
    );
    expect(corner).toBeGreaterThan(0.01);
  });

  it('圆锥：包围盒、法线单位长度、侧面法线斜向上', () => {
    const mesh = coneMesh({ type: 'cone', radius: 0.5, height: 1, segments: 24 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.5, 0, -0.5], [0.5, 1, 0.5]);
    const side = normalAt(mesh, 0);
    expect(len3(side)).toBeCloseTo(1, 5);
  });

  it('分段数被限制在合理范围', () => {
    const mesh = cylinderMesh({ type: 'cylinder', radius: 1, height: 1, segments: 1e9 });
    expect(vertexCount(mesh)).toBeLessThan(3000);
  });
});

describe('lathe', () => {
  const profile: [number, number][] = [
    [0, 0],
    [0.25, 0],
    [0.25, 0.04],
    [0.05, 0.08],
    [0.04, 0.6],
    [0.4, 0.62],
    [0.4, 0.66],
    [0, 0.66],
  ];

  it('包围盒等于最大半径和轮廓高度', () => {
    const mesh = latheMesh({ type: 'lathe', profile, segments: 32 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.4, 0, -0.4], [0.4, 0.66, 0.4]);
  });

  it('轮廓反向给出时法线仍然朝外', () => {
    for (const points of [profile, [...profile].reverse()]) {
      const mesh = latheMesh({ type: 'lathe', profile: points });
      expectWellFormed(mesh);
      // 底面朝下，顶面朝上，柱身朝外。
      for (let i = 0; i < vertexCount(mesh); i += 1) {
        const p = vertexAt(mesh, i);
        const n = normalAt(mesh, i);
        if (Math.abs(p[1]) < 1e-9 && Math.hypot(p[0], p[2]) < 0.2) expect(n[1]).toBeCloseTo(-1, 5);
        if (Math.abs(p[1] - 0.66) < 1e-9 && Math.hypot(p[0], p[2]) < 0.3)
          expect(n[1]).toBeCloseTo(1, 5);
        if (p[1] > 0.2 && p[1] < 0.5) expect(n[0] * p[0] + n[2] * p[2]).toBeGreaterThan(0);
      }
    }
  });

  it('部分角度会在切面封口', () => {
    const half = latheMesh({ type: 'lathe', profile, angle: 180, segments: 32 });
    expectWellFormed(half);
    const bounds = verticesWhere(half, () => true);
    // 绕 y 轴 0°–180°：x = r·sinθ ≥ 0。
    expect(Math.min(...bounds.map((p) => p[0]))).toBeGreaterThan(-1e-6);
    expect(Math.max(...bounds.map((p) => p[0]))).toBeCloseTo(0.4, 5);
  });
});

describe('extrude', () => {
  it('矩形挤出的包围盒', () => {
    const mesh = extrudeMesh({ type: 'extrude', outline: square, height: 0.4 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.5, 0, -0.5], [0.5, 0.4, 0.5]);
    expectOutwardFrom(mesh, [0, 0.2, 0]);
  });

  it('顺时针给出的轮廓法线仍然朝外', () => {
    const reversed = { points: [...square.points].reverse() };
    const mesh = extrudeMesh({ type: 'extrude', outline: reversed, height: 0.4 });
    expectWellFormed(mesh);
    expectOutwardFrom(mesh, [0, 0.2, 0]);
  });

  it('圆弧 bulge = 1 是向外的半圆，-1 是向内的半圆', () => {
    const outward = extrudeMesh({
      type: 'extrude',
      outline: { ...square, arcs: [{ from: 1, bulge: 1 }] },
      height: 0.2,
    });
    expectWellFormed(outward);
    expectBounds(outward, [-0.5, 0, -0.5], [1, 0.2, 0.5]);
    expectOutwardFrom(outward, [0, 0.1, 0]);

    const inward = extrudeMesh({
      type: 'extrude',
      outline: { ...square, arcs: [{ from: 1, bulge: -1 }] },
      height: 0.2,
    });
    expectWellFormed(inward);
    expectBounds(inward, [-0.5, 0, -0.5], [0.5, 0.2, 0.5]);
    // 凹进去的半圆顶点在 (0, 0)。
    expect(
      verticesWhere(inward, (p) => Math.abs(p[0]) < 1e-6 && Math.abs(p[2]) < 1e-6).length,
    ).toBeGreaterThan(0);
  });

  it('小 bulge 的弓高等于 bulge × 半弦长', () => {
    const mesh = extrudeMesh({
      type: 'extrude',
      outline: { ...square, arcs: [{ from: 0, bulge: 0.2 }] },
      height: 0.1,
    });
    // 第 0 边从 (-0.5,-0.5) 到 (0.5,-0.5)，向外是 -z，弓高 0.2 × 0.5 = 0.1。
    expectBounds(mesh, [-0.5, 0, -0.6], [0.5, 0.1, 0.5]);
  });

  it('轮廓圆角：拐角处没有顶点，顶点变多', () => {
    const sharp = extrudeMesh({ type: 'extrude', outline: square, height: 0.3 });
    const round = extrudeMesh({
      type: 'extrude',
      outline: { ...square, fillets: [0, 1, 2, 3].map((at) => ({ at, radius: 0.1 })) },
      height: 0.3,
    });
    expectWellFormed(round);
    expectBounds(round, [-0.5, 0, -0.5], [0.5, 0.3, 0.5]);
    expect(vertexCount(round)).toBeGreaterThan(vertexCount(sharp));
    const corner = Math.max(...verticesWhere(round, () => true).map((p) => Math.hypot(p[0], p[2])));
    expect(corner).toBeLessThan(Math.SQRT2 * 0.5 - 0.01);
    expect(corner).toBeCloseTo(Math.SQRT2 * 0.4 + 0.1, 4);
  });

  it('顶底边缘圆角：顶面缩进，法线从水平过渡到竖直', () => {
    const mesh = extrudeMesh({ type: 'extrude', outline: square, height: 0.3, fillet: 0.05 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.5, 0, -0.5], [0.5, 0.3, 0.5]);
    expectOutwardFrom(mesh, [0, 0.15, 0]);
    const top = verticesWhere(mesh, (p) => Math.abs(p[1] - 0.3) < 1e-6);
    expect(Math.max(...top.map((p) => Math.abs(p[0])))).toBeCloseTo(0.45, 5);
  });

  it('顶底倒角：斜面法线 45°', () => {
    const mesh = extrudeMesh({ type: 'extrude', outline: square, height: 0.3, chamfer: 0.05 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.5, 0, -0.5], [0.5, 0.3, 0.5]);
    let diagonal = 0;
    for (let i = 0; i < vertexCount(mesh); i += 1) {
      if (Math.abs(Math.abs(normalAt(mesh, i)[1]) - Math.SQRT1_2) < 1e-5) diagonal += 1;
    }
    expect(diagonal).toBe(4 * 2 * 4);
  });

  it('开放轮廓生成双面的墙带', () => {
    const mesh = extrudeMesh({
      type: 'extrude',
      outline: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        closed: false,
      },
      height: 2,
    });
    expectWellFormed(mesh);
    expectBounds(mesh, [0, 0, 0], [1, 2, 1]);
  });
});

describe('outline', () => {
  it('圆弧采样点都在同一个圆上', () => {
    const polyline = expandOutline({ ...square, arcs: [{ from: 1, bulge: 1 }] });
    const arc = polyline.points.filter((p) => p[0] > 0.5 + 1e-9);
    expect(arc.length).toBeGreaterThan(8);
    for (const p of arc) expect(Math.hypot(p[0] - 0.5, p[1])).toBeCloseTo(0.5, 9);
  });

  it('直角是硬点，圆弧内部是软点', () => {
    const polyline = expandOutline({ ...square, arcs: [{ from: 1, bulge: 1 }] });
    const hardPoints = polyline.points.filter((_, i) => polyline.hard[i]);
    expect(hardPoints).toContainEqual([-0.5, -0.5]);
    expect(hardPoints).toContainEqual([-0.5, 0.5]);
    expect(hardPoints.some((p) => p[0] > 0.5 + 1e-6)).toBe(false);
  });
});

describe('sweep', () => {
  const path: V3[] = [
    [0, 0, 0],
    [0, 0.4, 0],
    [0.3, 0.45, 0],
    [0.3, 0.45, 0.4],
  ];

  it('圆截面：每个顶点到（圆滑后的）路径的距离都约等于半径', () => {
    const smooth = 0.05;
    const radius = 0.015;
    const mesh = sweepMesh({
      type: 'sweep',
      path,
      section: { circle: radius },
      smooth,
      caps: false,
    });
    expectWellFormed(mesh);
    const centerline = smoothPath(path, smooth);
    for (let i = 0; i < vertexCount(mesh); i += 1) {
      const d = distanceToPolyline(vertexAt(mesh, i), centerline);
      expect(d).toBeGreaterThan(radius * 0.95);
      expect(d).toBeLessThan(radius * 1.05);
    }
  });

  it('沿路径走：包围盒等于路径包围盒外扩一个半径', () => {
    const radius = 0.02;
    const mesh = sweepMesh({ type: 'sweep', path, section: { circle: radius }, smooth: 0.05 });
    expectWellFormed(mesh);
    expectBounds(mesh, [-radius, -0, -radius], [0.3 + radius, 0.45 + radius, 0.4], 2e-3);
  });

  it('圆滑半径让拐角离原来的尖角更远', () => {
    const sharp = smoothPath(path, 0);
    const round = smoothPath(path, 0.1);
    expect(round.length).toBeGreaterThan(sharp.length);
    const corner = path[1]!;
    const nearest = Math.min(
      ...round.map((p) => len3([p[0] - corner[0], p[1] - corner[1], p[2] - corner[2]])),
    );
    expect(nearest).toBeGreaterThan(0.01);
  });

  it('矩形截面：直角拐弯处斜接，顶点都在路径周围半对角线以内', () => {
    const rect: [number, number] = [0.04, 0.02];
    const mesh = sweepMesh({
      type: 'sweep',
      path: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ],
      section: { rect },
    });
    expectWellFormed(mesh);
    // 水平路径时矩形的高沿竖直方向。
    expectBounds(mesh, [-0, -0.01, -0.02], [1.02, 0.01, 1], 1e-4);
  });

  it('竖直路径（椅腿）也能生成，带封口', () => {
    const mesh = sweepMesh({
      type: 'sweep',
      path: [
        [0, 0, 0],
        [0, 0.45, 0],
      ],
      section: { circle: 0.012 },
    });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.012, 0, -0.012], [0.012, 0.45, 0.012], 1e-4);
    expectOutwardFrom(mesh, [0, 0.2, 0]);
  });
});

describe('loft', () => {
  const rect = (w: number, d: number): Outline => ({
    points: [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ],
  });

  it('截面数 = 侧面的高度层数，每层点数相同', () => {
    const mesh = loftMesh({
      type: 'loft',
      sections: [
        { y: 0, outline: rect(1, 0.6) },
        { y: 0.4, outline: rect(0.8, 0.5) },
        {
          y: 0.9,
          outline: { ...rect(0.6, 0.4), fillets: [0, 1, 2, 3].map((at) => ({ at, radius: 0.1 })) },
        },
      ],
    });
    expectWellFormed(mesh);
    expectBounds(mesh, [-0.5, 0, -0.3], [0.5, 0.9, 0.3]);
    expectOutwardFrom(mesh, [0, 0.45, 0]);
    const sides: V3[] = [];
    for (let i = 0; i < vertexCount(mesh); i += 1) {
      if (Math.abs(normalAt(mesh, i)[1]) < 0.99) sides.push(vertexAt(mesh, i));
    }
    const levels = new Map<string, number>();
    for (const p of sides) levels.set(p[1].toFixed(5), (levels.get(p[1].toFixed(5)) ?? 0) + 1);
    expect([...levels.keys()].sort()).toEqual(['0.00000', '0.40000', '0.90000']);
    const counts = [...levels.values()];
    expect(new Set(counts).size).toBe(1);
  });

  it('矩形截面的角点被精确保留', () => {
    const mesh = loftMesh({
      type: 'loft',
      sections: [
        { y: 0, outline: rect(1, 1) },
        { y: 1, outline: rect(0.5, 0.5) },
      ],
    });
    expectWellFormed(mesh);
    expect(
      verticesWhere(
        mesh,
        (p) => Math.abs(p[0] - 0.5) < 1e-6 && Math.abs(p[2] - 0.5) < 1e-6 && p[1] === 0,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      verticesWhere(
        mesh,
        (p) =>
          Math.abs(p[0] - 0.25) < 1e-6 && Math.abs(p[2] + 0.25) < 1e-6 && Math.abs(p[1] - 1) < 1e-6,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('不足两个截面不生成；超过 8 个只取前 8 个', () => {
    expect(
      loftMesh({ type: 'loft', sections: [{ y: 0, outline: rect(1, 1) }] }).indices.length,
    ).toBe(0);
    const many = loftMesh({
      type: 'loft',
      sections: Array.from({ length: 12 }, (_, i) => ({ y: i * 0.1, outline: rect(1, 1) })),
    });
    expectBounds(many, [-0.5, 0, -0.5], [0.5, 0.7, 0.5]);
  });
});
