import { MeshBuilder, dropDegenerate, flatShade, type MeshData } from './meshData';
import type { BoxShape } from './types';
import { projectUvs } from './uv';
import { positiveOr, segmentsOr, type V3 } from './vec';

/**
 * 盒子：原点在底面中心，向 +y 延伸。
 *
 * 带圆角时拆成三类面片生成，每块的法线都是解析解：
 * 6 个平面（内盒各面）、12 条四分之一圆柱（棱）、8 个八分之一球（角）。
 * 倒角用同样的拆法、分段数取 1，再改成平面着色，棱和角变成平的斜面。
 * 圆角半径和倒角都限制到不超过最短边的一半；两者同时给时以圆角为准。
 */
export function boxMesh(shape: BoxShape): MeshData {
  const [w, h, d] = (shape.size ?? [1, 1, 1]).map((v) => positiveOr(v, 0)) as unknown as V3;
  const limit = Math.min(w, h, d) / 2;
  const fillet = Math.min(positiveOr(shape.fillet, 0), limit);
  const chamfer = fillet > 0 ? 0 : Math.min(positiveOr(shape.chamfer, 0), limit);
  const radius = fillet > 0 ? fillet : chamfer;
  const segments = fillet > 0 ? segmentsOr(shape.segments, 4, 1, 32) : 1;

  const center: V3 = [0, h / 2, 0];
  const half: V3 = [w / 2, h / 2, d / 2];
  const inner: V3 = [half[0] - radius, half[1] - radius, half[2] - radius];
  const builder = new MeshBuilder();

  const point = (signs: V3, normal: V3, along?: { axis: number; value: number }): V3 => {
    const p: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k += 1) {
      const base = along?.axis === k ? along.value : signs[k]! * inner[k]!;
      p[k] = center[k]! + base + radius * normal[k]!;
    }
    return p;
  };

  // 6 个平面：法线轴 a，另两轴 b、c。
  for (let a = 0; a < 3; a += 1) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    if (inner[b]! <= 1e-12 || inner[c]! <= 1e-12) continue;
    for (const sign of [1, -1]) {
      const normal: V3 = [0, 0, 0];
      normal[a] = sign;
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([sb, sc]) => {
        const p: V3 = [...center];
        p[a] = center[a]! + sign * half[a]!;
        p[b] = center[b]! + sb! * inner[b]!;
        p[c] = center[c]! + sc! * inner[c]!;
        return builder.vertex(p, normal);
      });
      builder.orientedQuad(corners[0]!, corners[1]!, corners[2]!, corners[3]!);
    }
  }

  if (radius > 0) {
    // 12 条棱：圆弧在 a、b 两轴构成的平面里，沿 c 轴延伸。
    for (let c = 0; c < 3; c += 1) {
      const a = (c + 1) % 3;
      const b = (c + 2) % 3;
      if (inner[c]! <= 1e-12) continue;
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          const rows: number[][] = [];
          for (let k = 0; k <= segments; k += 1) {
            const phi = (k / segments) * (Math.PI / 2);
            const normal: V3 = [0, 0, 0];
            normal[a] = sa * Math.cos(phi);
            normal[b] = sb * Math.sin(phi);
            const signs: V3 = [0, 0, 0];
            signs[a] = sa;
            signs[b] = sb;
            rows.push(
              [-1, 1].map((sc) =>
                builder.vertex(point(signs, normal, { axis: c, value: sc * inner[c]! }), normal),
              ),
            );
          }
          for (let k = 0; k < segments; k += 1) {
            builder.orientedQuad(rows[k]![0]!, rows[k]![1]!, rows[k + 1]![1]!, rows[k + 1]![0]!);
          }
        }
      }
    }

    // 8 个角：八分之一球，θ 从 y 轴量起，φ 在 xz 平面里。
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const sz of [1, -1]) {
          const signs: V3 = [sx, sy, sz];
          const grid: number[][] = [];
          for (let i = 0; i <= segments; i += 1) {
            const theta = (i / segments) * (Math.PI / 2);
            const row: number[] = [];
            for (let j = 0; j <= segments; j += 1) {
              const phi = (j / segments) * (Math.PI / 2);
              const normal: V3 = [
                sx * Math.sin(theta) * Math.cos(phi),
                sy * Math.cos(theta),
                sz * Math.sin(theta) * Math.sin(phi),
              ];
              row.push(builder.vertex(point(signs, normal), normal));
            }
            grid.push(row);
          }
          for (let i = 0; i < segments; i += 1) {
            for (let j = 0; j < segments; j += 1) {
              builder.orientedQuad(
                grid[i]![j]!,
                grid[i]![j + 1]!,
                grid[i + 1]![j + 1]!,
                grid[i + 1]![j]!,
              );
            }
          }
        }
      }
    }
  }

  let mesh = dropDegenerate(builder.build());
  if (chamfer > 0) mesh = flatShade(mesh);
  return projectUvs(mesh, 'box');
}
