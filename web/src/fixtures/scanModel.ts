import { Matrix4, Vector3 } from 'three';
import { buildShape } from '../core/shapes/build';
import { isTextureMaterial } from '../core/shapes/types';
import { projectUvs } from '../core/shapes/uv';
import { templatesOf } from '../core/scene';
import { writeGlb } from './glb';
import { entitiesAt } from './lobby';
import { encodePng, random } from './png';

export { writeGlb } from './glb';

/**
 * 夹具的"原始扫描"：没有真实的 Scaniverse 文件可用，就拿重建后的场景（含天花板）
 * 加上噪声、随机破洞，导出成和网页用模型同样形式的 glb：单个网格、内嵌底色贴图
 * （图集：每块一个色格，带烘焙光照一样的斑驳），坐标是扫描坐标——
 * 扫描是斜着拍的，`scan.transform`（列主序 4×4）把它转回空间坐标。
 * 只在夹具模式和测试里用，生成结果是确定的（固定随机种子）。
 */

/** 扫描坐标 → 空间坐标：绕 y 轴转 −61°（前厅实测的扫描朝向），再平移。 */
export const SCAN_TRANSFORM: readonly number[] = new Matrix4()
  .makeTranslation(0.6, 0, -0.4)
  .multiply(new Matrix4().makeRotationY((-61 * Math.PI) / 180))
  .toArray();

const ATLAS = 256;
const CELLS = 8;
const CELL = ATLAS / CELLS;

/** 图集贴图：第 i 格是第 i 块的颜色，带斑驳的明暗。 */
function atlasTexture(colors: readonly (readonly number[])[], seed: number): Uint8Array {
  const rand = random(seed);
  const noise = Array.from({ length: 97 }, () => rand());
  const rgb = new Uint8Array(ATLAS * ATLAS * 3);
  for (let y = 0; y < ATLAS; y += 1) {
    for (let x = 0; x < ATLAS; x += 1) {
      const cell = Math.floor(y / CELL) * CELLS + Math.floor(x / CELL);
      const base = colors[cell] ?? [128, 128, 128];
      const blotch =
        0.62 +
        0.14 * Math.sin(x * 0.31 + noise[(y * 3) % 97]! * 4) * Math.cos(y * 0.27) +
        0.12 * noise[(x * 7 + y * 13) % 97]!;
      const i = (y * ATLAS + x) * 3;
      for (let k = 0; k < 3; k += 1) {
        rgb[i + k] = Math.max(0, Math.min(255, Math.round((base[k] ?? 128) * blotch)));
      }
    }
  }
  return encodePng(ATLAS, ATLAS, rgb);
}

/** 生成夹具扫描模型（glb 字节）。 */
export function fixtureScanGlb(): Uint8Array {
  const entities = entitiesAt(2);
  const templates = templatesOf(entities);
  const rand = random(20261001);
  const toScan = new Matrix4().fromArray(SCAN_TRANSFORM as number[]).invert();
  const normalToScan = new Matrix4().extractRotation(toScan);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const colors: (readonly number[])[] = [];
  const v = new Vector3();
  for (const entity of entities) {
    if (entity.kind === 'template' || entity.shape === undefined) continue;
    for (const part of buildShape(entity.shape, { templates }).parts) {
      const base = isTextureMaterial(part.material)
        ? (part.material.tint ?? [196, 176, 150])
        : part.material.color;
      const cell = colors.length % (CELLS * CELLS);
      colors.push(base);
      const cu = (cell % CELLS) / CELLS;
      const cv = Math.floor(cell / CELLS) / CELLS;
      const mesh = projectUvs(part.mesh, 'box');
      const offset = positions.length / 3;
      for (let i = 0; i < mesh.positions.length / 3; i += 1) {
        const jitter = () => (rand() - 0.5) * 0.035;
        v.set(
          mesh.positions[i * 3]! + jitter(),
          mesh.positions[i * 3 + 1]! + jitter(),
          mesh.positions[i * 3 + 2]! + jitter(),
        ).applyMatrix4(toScan);
        positions.push(v.x, v.y, v.z);
        v.set(mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!)
          .applyMatrix4(normalToScan)
          .normalize();
        normals.push(v.x, v.y, v.z);
        // glTF 的贴图坐标原点在左上角：v 往下长。
        const u = cu + (0.08 + 0.84 * (mesh.uvs[i * 2] ?? 0)) / CELLS;
        const w = cv + (0.08 + 0.84 * (1 - (mesh.uvs[i * 2 + 1] ?? 0))) / CELLS;
        uvs.push(u, w);
      }
      for (let t = 0; t < mesh.indices.length; t += 3) {
        // 约 7% 的三角形丢掉，模拟扫描破洞。
        if (rand() < 0.07) continue;
        indices.push(
          mesh.indices[t]! + offset,
          mesh.indices[t + 1]! + offset,
          mesh.indices[t + 2]! + offset,
        );
      }
    }
  }
  // 和真实扫描一样带零星的离群点：门外、玻璃隔断外拍到的碎片，离房间几米远。
  // 原始视图取景时按表面的分位包围盒去掉它们（viewer/framing.ts 的 scanFrameBox）。
  // 碎片取图集第一格的颜色。
  const su = 0.5 / CELLS;
  const sv = 0.5 / CELLS;
  for (let i = 0; i < 24; i += 1) {
    const outside = i % 2 === 0;
    // 一半在门外的街上（z 7–11 米），一半在玻璃隔断外（x 8–12 米）。
    const cx = outside ? -1 + rand() * 9 : 8 + rand() * 4;
    const cz = outside ? 7 + rand() * 4 : rand() * 6;
    const cy = 0.2 + rand() * 2.2;
    const offset = positions.length / 3;
    for (const [dx, dy, dz] of [
      [0, 0, 0],
      [0.12, 0, 0.03],
      [0.02, 0.1, 0],
    ] as const) {
      v.set(cx + dx, cy + dy, cz + dz).applyMatrix4(toScan);
      positions.push(v.x, v.y, v.z);
      v.set(0, 0, 1).applyMatrix4(normalToScan).normalize();
      normals.push(v.x, v.y, v.z);
      uvs.push(su, sv);
    }
    indices.push(offset, offset + 1, offset + 2);
  }
  return writeGlb({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    image: { bytes: atlasTexture(colors, 99), mimeType: 'image/png' },
    name: 'scan',
  });
}
