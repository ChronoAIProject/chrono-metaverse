import { buildShape } from '../core/shapes/build';
import { isTextureMaterial } from '../core/shapes/types';
import { templatesOf } from '../core/scene';
import { entitiesAt } from './lobby';

/**
 * 夹具的"原始扫描"：没有真实的 Scaniverse 文件可用，就拿重建后的场景（含天花板）
 * 加上噪声、随机破洞和颜色抖动，导出成一个 glb，供"原始"视图使用。
 * 只在夹具模式和测试里用，生成结果是确定的（固定随机种子）。
 */

/** 简单的确定性伪随机数（mulberry32）。 */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GlbMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

function pad4(length: number): number {
  return (length + 3) & ~3;
}

/** 写一个最小的 glTF 2.0 二进制文件：一个网格、顶点颜色、无贴图。 */
export function writeGlb(mesh: GlbMesh): Uint8Array {
  const count = mesh.positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 1) {
    const k = i % 3;
    min[k] = Math.min(min[k]!, mesh.positions[i]!);
    max[k] = Math.max(max[k]!, mesh.positions[i]!);
  }
  const views = [mesh.positions, mesh.normals, mesh.colors, mesh.indices];
  const offsets: number[] = [];
  let binLength = 0;
  for (const view of views) {
    offsets.push(binLength);
    binLength = pad4(binLength + view.byteLength);
  }
  const gltf = {
    asset: { version: '2.0', generator: 'chrono-metaverse fixtures' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'scan' }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    buffers: [{ byteLength: binLength }],
    bufferViews: views.map((view, i) => ({
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: view.byteLength,
      target: i === 3 ? 34963 : 34962,
    })),
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 3, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
    ],
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = pad4(json.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLength);
  const binStart = 20 + jsonLength;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // "BIN\0"
  views.forEach((v, i) => {
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), binStart + 8 + offsets[i]!);
  });
  return out;
}

/** 生成夹具扫描模型（glb 字节）。 */
export function fixtureScanGlb(): Uint8Array {
  const entities = entitiesAt(2);
  const templates = templatesOf(entities);
  const rand = random(20261001);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const entity of entities) {
    if (entity.kind === 'template' || entity.shape === undefined) continue;
    for (const part of buildShape(entity.shape, { templates }).parts) {
      const base = isTextureMaterial(part.material) ? [180, 180, 180] : part.material.color;
      // 扫描贴图带烘焙光照，颜色偏暗、不均匀。
      const tone = 0.62 + rand() * 0.16;
      const offset = positions.length / 3;
      const { mesh } = part;
      for (let i = 0; i < mesh.positions.length / 3; i += 1) {
        const jitter = () => (rand() - 0.5) * 0.04;
        positions.push(
          mesh.positions[i * 3]! + jitter(),
          mesh.positions[i * 3 + 1]! + jitter(),
          mesh.positions[i * 3 + 2]! + jitter(),
        );
        normals.push(mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!);
        const shade = tone * (0.8 + rand() * 0.25);
        // glTF 的 COLOR_0 是线性空间；这里粗略地按 2.2 次方换算。
        colors.push(...base.map((c) => Math.pow((c / 255) * shade, 2.2)));
      }
      for (let t = 0; t < mesh.indices.length; t += 3) {
        // 约 8% 的三角形丢掉，模拟扫描破洞。
        if (rand() < 0.08) continue;
        indices.push(
          mesh.indices[t]! + offset,
          mesh.indices[t + 1]! + offset,
          mesh.indices[t + 2]! + offset,
        );
      }
    }
  }
  return writeGlb({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  });
}
