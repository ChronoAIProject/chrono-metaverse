import { buildShape } from '../core/shapes/build';
import { isTextureMaterial, type Shape, type TemplateTable } from '../core/shapes/types';

/**
 * 夹具用的 glb 写出器（glTF 2.0 二进制）：单个网格、单个图元，
 * 可带顶点颜色、贴图坐标和内嵌的底色贴图（PNG 或 JPEG）。不压缩。
 */
export interface GlbMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** 线性空间的 RGB（glTF 的 COLOR_0 约定）。 */
  readonly colors?: Float32Array;
  readonly uvs?: Float32Array;
  /** 内嵌的底色贴图。 */
  readonly image?: { readonly bytes: Uint8Array; readonly mimeType: 'image/png' | 'image/jpeg' };
  readonly name?: string;
}

function pad4(length: number): number {
  return (length + 3) & ~3;
}

export function writeGlb(mesh: GlbMesh): Uint8Array {
  const count = mesh.positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 1) {
    const k = i % 3;
    min[k] = Math.min(min[k]!, mesh.positions[i]!);
    max[k] = Math.max(max[k]!, mesh.positions[i]!);
  }
  const views: { data: ArrayBufferView; target?: number }[] = [
    { data: mesh.positions, target: 34962 },
    { data: mesh.normals, target: 34962 },
    { data: mesh.indices, target: 34963 },
  ];
  const attributes: Record<string, number> = { POSITION: 0, NORMAL: 1 };
  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
    { bufferView: 2, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
  ];
  if (mesh.colors) {
    attributes.COLOR_0 = accessors.length;
    accessors.push({ bufferView: views.length, componentType: 5126, count, type: 'VEC3' });
    views.push({ data: mesh.colors, target: 34962 });
  }
  if (mesh.uvs) {
    attributes.TEXCOORD_0 = accessors.length;
    accessors.push({ bufferView: views.length, componentType: 5126, count, type: 'VEC2' });
    views.push({ data: mesh.uvs, target: 34962 });
  }
  let imageView: number | undefined;
  if (mesh.image) {
    imageView = views.length;
    views.push({ data: mesh.image.bytes });
  }
  const offsets: number[] = [];
  let binLength = 0;
  for (const view of views) {
    offsets.push(binLength);
    binLength = pad4(binLength + view.data.byteLength);
  }
  const material: Record<string, unknown> = {
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
      ...(mesh.image ? { baseColorTexture: { index: 0 } } : {}),
    },
  };
  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'chrono-metaverse fixtures' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: mesh.name ?? 'mesh' }],
    meshes: [{ primitives: [{ attributes, indices: 2, material: 0 }] }],
    materials: [material],
    buffers: [{ byteLength: binLength }],
    bufferViews: views.map((view, i) => ({
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: view.data.byteLength,
      ...(view.target !== undefined ? { target: view.target } : {}),
    })),
    accessors,
  };
  if (mesh.image && imageView !== undefined) {
    gltf.images = [{ bufferView: imageView, mimeType: mesh.image.mimeType }];
    gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    gltf.textures = [{ source: 0, sampler: 0 }];
  }
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
    out.set(
      new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength),
      binStart + 8 + offsets[i]!,
    );
  });
  return out;
}

/**
 * 带贴图的形状 → glb：形状的每个部件都按 `material` 的贴图坐标算好，底色贴图内嵌（模型库式的固有色贴图）。
 * glTF 的贴图坐标原点在图片左上角，写 `(u, 1 − v)`（docs/SHAPES.md 第 2 节"glb 导出"）。
 */
export function texturedShapeToGlb(
  shape: Shape,
  image: { readonly bytes: Uint8Array; readonly mimeType: 'image/png' | 'image/jpeg' },
  name?: string,
): Uint8Array {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const part of buildShape(shape, {}).parts) {
    const offset = positions.length / 3;
    positions.push(...part.mesh.positions);
    normals.push(...part.mesh.normals);
    for (let i = 0; i < part.mesh.uvs.length; i += 2) {
      uvs.push(part.mesh.uvs[i]!, 1 - part.mesh.uvs[i + 1]!);
    }
    for (const index of part.mesh.indices) indices.push(index + offset);
  }
  return writeGlb({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    image,
    name,
  });
}

/** 形状 → 带顶点颜色的 glb（处理后的物件模型：原点在底面中心）。 */
export function shapeToGlb(shape: Shape, templates: TemplateTable = {}, name?: string): Uint8Array {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const part of buildShape(shape, { templates }).parts) {
    const base = isTextureMaterial(part.material) ? [200, 200, 200] : part.material.color;
    const linear = base.map((c) => Math.pow(c / 255, 2.2));
    const offset = positions.length / 3;
    positions.push(...part.mesh.positions);
    normals.push(...part.mesh.normals);
    for (let i = 0; i < part.mesh.positions.length / 3; i += 1) colors.push(...linear);
    for (const index of part.mesh.indices) indices.push(index + offset);
  }
  return writeGlb({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    name,
  });
}
