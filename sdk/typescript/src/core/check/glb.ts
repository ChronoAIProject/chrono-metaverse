import type { Aabb, Vec3 } from '../grid.js';
import {
  GLB_EXTENSIONS_REQUIRED,
  GLB_EXTENSIONS_USED,
  GLB_MAX_ACCESSORS,
  GLB_MAX_BUFFER_VIEWS,
  GLB_MAX_IMAGES,
  GLB_MAX_MATERIALS,
  GLB_MAX_MESHES,
  GLB_MAX_NODES,
  GLB_MAX_PRIMITIVES_PER_MESH,
  GLB_MAX_SCENES,
  GLB_MAX_TEXTURES,
  type GlbLimits,
} from '../limits.js';
import { imageSize } from './image.js';
import {
  CHECK_VERSION,
  readExact,
  reject,
  startsWith,
  utf8,
  view,
  type ByteSource,
  type GlbCheck,
  type GlbImage,
} from './types.js';

/**
 * glb 检查（docs/design/server-slim.md 4.5，docs/SHAPES.md 第 8 节"glb 完整检查"）。
 *
 * - **完整检查**（网页用模型、物件模型，{@link checkGlb}）：头、JSON 的结构和白名单、三角形数、按
 *   `POSITION` 的顶点数据实测包围盒（与声明的 `min`/`max` 核对）、世界包围盒的坐标上限、图片头；
 * - **轻量检查**（扫描用途，{@link checkGlbLight}）：头、JSON 块的结构、没有外部引用，不算三角形和包围盒。
 *
 * 拒绝码：`glb_header`（魔数、版本、总长度、块的排列）、`glb_json_too_large`、`glb_json`（JSON 不合法、
 * 字段类型或下标不对、数组太长）、`glb_external_uri`（缓冲区或图片带 `uri`，含 `data:`）、`glb_buffer`
 * （缓冲区、缓冲区视图、访问器的范围，稀疏访问器）、`glb_extension`（白名单以外的扩展）、`glb_unsupported`
 * （骨骼、动画、变形目标、相机、非三角形图元）、`glb_position`（`POSITION` 的类型、分量、`min`/`max`）、
 * `glb_scene`、`glb_node_graph`（成环、两个父节点）、`glb_triangles`（三角形数不是整数、场景里没有三角形）、
 * `glb_too_many_triangles`、`glb_bounds_mismatch`（声明的 `min`/`max` 与数据不符）、`glb_coord_range`、
 * `glb_image`（图片的格式、`mimeType`、头）、`glb_texture_too_large`。
 */

const GLB_MAGIC = 'glTF';
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

type Json = Record<string, unknown>;

/** 各分量类型的字节数。 */
const COMPONENT_SIZE: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COUNT: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const FLOAT = 5126;
const QUANTIZED = [5120, 5121, 5122, 5123];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < length;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 可选的对象数组：不给是空数组；给了必须是对象数组、不超过上限。 */
function objects(json: Json, key: string, max: number): Json[] {
  const value = json[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isObject)) reject('glb_json', `${key} 必须是对象数组`);
  if (value.length > max) reject('glb_json', `${key} 最多 ${max} 个，这里有 ${value.length} 个`);
  return value as Json[];
}

function strings(json: Json, key: string): string[] {
  const value = json[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    reject('glb_json', `${key} 必须是字符串数组`);
  }
  return value as string[];
}

interface Layout {
  readonly json: Json;
  /** BIN 块在文件里的起点和长度（没有 BIN 块时长度为 0）。 */
  readonly binOffset: number;
  readonly binLength: number;
}

/** 读头和块：魔数 `glTF`、版本 2、总长度等于文件大小；第一个块是 JSON，第二个（可选）是 BIN，没有别的块。 */
async function readLayout(source: ByteSource, maxJsonBytes: number): Promise<Layout> {
  if (source.size < 20) reject('glb_header', 'glb 太短');
  const head = await readExact(source, 0, 20, 'glb_header', 'glb 头');
  const data = view(head);
  if (!startsWith(head, GLB_MAGIC)) reject('glb_header', '魔数不是 glTF');
  if (data.getUint32(4, true) !== 2) reject('glb_header', 'glb 版本不是 2');
  const total = data.getUint32(8, true);
  if (total !== source.size) {
    reject('glb_header', `glb 头里的总长度 ${total} 与文件大小 ${source.size} 不一致`);
  }
  const jsonLength = data.getUint32(12, true);
  if (data.getUint32(16, true) !== CHUNK_JSON) reject('glb_header', '第一个块不是 JSON');
  if (jsonLength > maxJsonBytes) {
    reject('glb_json_too_large', `JSON 块 ${jsonLength} 字节，超过上限 ${maxJsonBytes}`);
  }
  if (20 + jsonLength > source.size) reject('glb_header', 'JSON 块超出文件');
  let binOffset = 20 + jsonLength;
  let binLength = 0;
  if (binOffset < source.size) {
    const chunk = view(await readExact(source, binOffset, 8, 'glb_header', '第二个块的块头'));
    binLength = chunk.getUint32(0, true);
    if (chunk.getUint32(4, true) !== CHUNK_BIN) reject('glb_header', '第二个块不是 BIN');
    binOffset += 8;
    if (binOffset + binLength !== source.size) {
      reject('glb_header', 'BIN 块的长度与文件不符（BIN 之后不能有别的块）');
    }
  }
  const text = utf8(await readExact(source, 20, jsonLength, 'glb_header', 'JSON 块'));
  let json: unknown;
  try {
    json = JSON.parse(text ?? '');
  } catch {
    reject('glb_json', 'JSON 块不是合法的 UTF-8 JSON');
  }
  if (!isObject(json)) reject('glb_json', 'JSON 块必须是对象');
  const asset = json.asset;
  if (!isObject(asset) || asset.version !== '2.0') reject('glb_json', 'asset.version 必须是 "2.0"');
  return { json, binOffset, binLength };
}

/** 缓冲区至多 1 个、不能有 `uri`；图片不能有 `uri`。 */
function checkExternal(json: Json, binLength: number): Json[] {
  const buffers = objects(json, 'buffers', 1_000_000);
  if (buffers.some((buffer) => buffer.uri !== undefined)) {
    reject('glb_external_uri', '缓冲区带 uri（外部文件或 data:），只能用 glb 的 BIN 块');
  }
  if (buffers.length > 1) reject('glb_buffer', '缓冲区至多 1 个');
  const buffer = buffers[0];
  if (buffer !== undefined && (!isCount(buffer.byteLength) || buffer.byteLength > binLength)) {
    reject('glb_buffer', '缓冲区的 byteLength 不合法或超过 BIN 块');
  }
  const images = objects(json, 'images', GLB_MAX_IMAGES);
  if (images.some((image) => image.uri !== undefined)) {
    reject('glb_external_uri', '图片带 uri（外部文件或 data:），只能用 bufferView + mimeType');
  }
  return images;
}

/** 扩展白名单：`extensionsUsed`、`extensionsRequired`，以及任何对象上的 `extensions` 键（不看 `extras`）。 */
function checkExtensions(json: Json): string[] {
  const used = strings(json, 'extensionsUsed');
  const required = strings(json, 'extensionsRequired');
  for (const name of used) {
    if (!GLB_EXTENSIONS_USED.includes(name)) reject('glb_extension', `不支持的扩展 ${name}`);
  }
  for (const name of required) {
    if (!GLB_EXTENSIONS_REQUIRED.includes(name)) {
      reject('glb_extension', `extensionsRequired 里不能有 ${name}`);
    }
  }
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'extras') continue;
      if (key === 'extensions') {
        if (!isObject(item)) reject('glb_json', 'extensions 必须是对象');
        for (const name of Object.keys(item)) {
          if (!GLB_EXTENSIONS_USED.includes(name)) reject('glb_extension', `不支持的扩展 ${name}`);
        }
      }
      walk(item);
    }
  };
  walk(json);
  return used;
}

interface Accessor {
  /** 数据在 BIN 块里的位置（缓冲区视图偏移 + 访问器偏移、步长）；没有 bufferView 时为 null。 */
  readonly data: { readonly offset: number; readonly stride: number } | null;
  readonly count: number;
  readonly componentType: number;
  readonly components: number;
  readonly normalized: boolean;
  readonly min?: readonly number[];
  readonly max?: readonly number[];
}

function parseAccessors(json: Json, binLength: number): Accessor[] {
  const views = objects(json, 'bufferViews', GLB_MAX_BUFFER_VIEWS).map((item, index) => {
    const offset = item.byteOffset ?? 0;
    const length = item.byteLength;
    if (item.buffer !== 0 || !isCount(offset) || !isCount(length) || offset + length > binLength) {
      reject('glb_buffer', `缓冲区视图 ${index} 的范围不在 BIN 块里`);
    }
    const stride = item.byteStride;
    if (stride !== undefined && !(isCount(stride) && stride >= 4 && stride <= 252)) {
      reject('glb_buffer', `缓冲区视图 ${index} 的 byteStride 不合法`);
    }
    return { offset, length, stride: stride as number | undefined };
  });
  return objects(json, 'accessors', GLB_MAX_ACCESSORS).map((item, index) => {
    if (item.sparse !== undefined) reject('glb_buffer', `访问器 ${index} 是稀疏访问器`);
    const componentType = item.componentType as number;
    const size = COMPONENT_SIZE[componentType];
    const components = TYPE_COUNT[item.type as string];
    if (size === undefined || components === undefined) {
      reject('glb_json', `访问器 ${index} 的 componentType 或 type 不合法`);
    }
    if (!isCount(item.count) || item.count < 1)
      reject('glb_json', `访问器 ${index} 的 count 不合法`);
    const minMax = (key: 'min' | 'max'): readonly number[] | undefined => {
      const value = item[key];
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'number')) {
        reject('glb_json', `访问器 ${index} 的 ${key} 必须是数字数组`);
      }
      return value as number[];
    };
    const common = {
      count: item.count,
      componentType,
      components,
      normalized: item.normalized === true,
      ...(item.min !== undefined ? { min: minMax('min') } : {}),
      ...(item.max !== undefined ? { max: minMax('max') } : {}),
    };
    if (item.bufferView === undefined) return { ...common, data: null };
    if (!isIndex(item.bufferView, views.length)) {
      reject('glb_json', `访问器 ${index} 的 bufferView 下标不对`);
    }
    const bufferView = views[item.bufferView]!;
    const own = item.byteOffset ?? 0;
    if (!isCount(own)) reject('glb_json', `访问器 ${index} 的 byteOffset 不合法`);
    const element = size * components;
    const stride = bufferView.stride ?? element;
    if (own + stride * (item.count - 1) + element > bufferView.length) {
      reject('glb_buffer', `访问器 ${index} 的数据超出它的缓冲区视图`);
    }
    return { ...common, data: { offset: bufferView.offset + own, stride } };
  });
}

interface Primitive {
  readonly position: number;
  readonly indices?: number;
}

function parseMeshes(json: Json, accessorCount: number): Primitive[][] {
  return objects(json, 'meshes', GLB_MAX_MESHES).map((mesh, meshIndex) => {
    const primitives = mesh.primitives;
    if (!Array.isArray(primitives) || primitives.length === 0 || !primitives.every(isObject)) {
      reject('glb_json', `网格 ${meshIndex} 的 primitives 必须是非空的对象数组`);
    }
    if (primitives.length > GLB_MAX_PRIMITIVES_PER_MESH) {
      reject('glb_json', `网格 ${meshIndex} 的图元最多 ${GLB_MAX_PRIMITIVES_PER_MESH} 个`);
    }
    return (primitives as Json[]).map((primitive) => {
      if (primitive.mode !== undefined && primitive.mode !== 4) {
        reject(
          'glb_unsupported',
          `网格 ${meshIndex} 有非三角形的图元（mode ${String(primitive.mode)}）`,
        );
      }
      if (primitive.targets !== undefined) {
        reject('glb_unsupported', `网格 ${meshIndex} 有变形目标（targets）`);
      }
      const attributes = primitive.attributes;
      if (!isObject(attributes) || !isIndex(attributes.POSITION, accessorCount)) {
        reject('glb_position', `网格 ${meshIndex} 的图元没有合法的 POSITION`);
      }
      for (const value of Object.values(attributes)) {
        if (!isIndex(value, accessorCount)) reject('glb_json', `网格 ${meshIndex} 的属性下标不对`);
      }
      if (primitive.indices !== undefined && !isIndex(primitive.indices, accessorCount)) {
        reject('glb_json', `网格 ${meshIndex} 的 indices 下标不对`);
      }
      return {
        position: attributes.POSITION as number,
        ...(primitive.indices !== undefined ? { indices: primitive.indices as number } : {}),
      };
    });
  });
}

type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 列主序 4×4 矩阵相乘 a·b。 */
function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function numbers(value: unknown, length: number): number[] | null {
  return Array.isArray(value) &&
    value.length === length &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? (value as number[])
    : null;
}

/** 节点的局部变换：`matrix`，或 平移 · 旋转（四元数）· 缩放。 */
function localMatrix(node: Json, index: number): Mat4 {
  if (node.matrix !== undefined) {
    const matrix = numbers(node.matrix, 16);
    if (matrix === null) reject('glb_json', `节点 ${index} 的 matrix 必须是 16 个有限数`);
    return matrix;
  }
  const t = node.translation === undefined ? [0, 0, 0] : numbers(node.translation, 3);
  const r = node.rotation === undefined ? [0, 0, 0, 1] : numbers(node.rotation, 4);
  const s = node.scale === undefined ? [1, 1, 1] : numbers(node.scale, 3);
  if (t === null || r === null || s === null) {
    reject('glb_json', `节点 ${index} 的 translation、rotation、scale 不合法`);
  }
  const [x, y, z, w] = r as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    t[0]!,
    t[1]!,
    t[2]!,
    1,
  ];
}

function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

interface Instance {
  readonly mesh: number;
  readonly world: Mat4;
}

/**
 * 从场景（`scene`，没写就是 0）的根节点往下走：节点不能成环、不能有两个父节点（也不能被走到两次）。
 * 返回每个引用网格的节点和它的世界变换。
 */
function walkScene(json: Json, meshCount: number): { instances: Instance[]; nodes: number } {
  const nodes = objects(json, 'nodes', GLB_MAX_NODES);
  if (objects(json, 'skins', 1_000_000).length > 0) reject('glb_unsupported', '不收骨骼（skins）');
  if (objects(json, 'animations', 1_000_000).length > 0) {
    reject('glb_unsupported', '不收动画（animations）');
  }
  if (objects(json, 'cameras', 1_000_000).length > 0)
    reject('glb_unsupported', '不收相机（cameras）');
  const parents = new Array<number>(nodes.length).fill(0);
  nodes.forEach((node, index) => {
    if (node.skin !== undefined) reject('glb_unsupported', `节点 ${index} 带骨骼`);
    if (node.camera !== undefined) reject('glb_unsupported', `节点 ${index} 带相机`);
    if (node.mesh !== undefined && !isIndex(node.mesh, meshCount)) {
      reject('glb_json', `节点 ${index} 的 mesh 下标不对`);
    }
    if (node.weights !== undefined) reject('glb_unsupported', `节点 ${index} 带变形权重`);
    const children = node.children ?? [];
    if (!Array.isArray(children) || !children.every((c) => isIndex(c, nodes.length))) {
      reject('glb_json', `节点 ${index} 的 children 下标不对`);
    }
    for (const child of children as number[]) {
      parents[child] = parents[child]! + 1;
      if (parents[child]! > 1) reject('glb_node_graph', `节点 ${child} 有两个父节点`);
    }
  });
  // 只有一个父节点时，成环等于顺着父节点往上走回到自己。
  const parentOf = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((node, index) => {
    for (const child of (node.children ?? []) as number[]) parentOf[child] = index;
  });
  for (let start = 0; start < nodes.length; start += 1) {
    let current = parentOf[start]!;
    for (let steps = 0; current !== -1; steps += 1) {
      if (current === start || steps > nodes.length) reject('glb_node_graph', `节点 ${start} 成环`);
      current = parentOf[current]!;
    }
  }
  const scenes = objects(json, 'scenes', GLB_MAX_SCENES);
  const sceneIndex = json.scene ?? 0;
  if (!isIndex(sceneIndex, scenes.length)) reject('glb_scene', 'glb 没有要显示的场景（scene）');
  const roots = scenes[sceneIndex]!.nodes ?? [];
  if (!Array.isArray(roots) || !roots.every((r) => isIndex(r, nodes.length))) {
    reject('glb_json', '场景的 nodes 下标不对');
  }
  const instances: Instance[] = [];
  const visited = new Set<number>();
  const visit = (index: number, parent: Mat4): void => {
    if (visited.has(index)) reject('glb_node_graph', `节点 ${index} 在场景里出现了两次`);
    visited.add(index);
    const node = nodes[index]!;
    const world = multiply(parent, localMatrix(node, index));
    if (node.mesh !== undefined) instances.push({ mesh: node.mesh as number, world });
    for (const child of (node.children ?? []) as number[]) visit(child, world);
  };
  for (const root of roots as number[]) visit(root, IDENTITY);
  return { instances, nodes: nodes.length };
}

/** 读一个分量（`normalized` 时按规范还原成 −1..1 / 0..1）。 */
function readComponent(
  data: DataView,
  offset: number,
  componentType: number,
  normalized: boolean,
): number {
  switch (componentType) {
    case 5126:
      return data.getFloat32(offset, true);
    case 5120: {
      const value = data.getInt8(offset);
      return normalized ? Math.max(value / 127, -1) : value;
    }
    case 5121: {
      const value = data.getUint8(offset);
      return normalized ? value / 255 : value;
    }
    case 5122: {
      const value = data.getInt16(offset, true);
      return normalized ? Math.max(value / 32767, -1) : value;
    }
    default: {
      const value = data.getUint16(offset, true);
      return normalized ? value / 65535 : value;
    }
  }
}

/** 声明的 `min`/`max` 与实测值相差不超过 max(1e-4 × |值|, 1e-6)。 */
function close(declared: number, measured: number): boolean {
  return Math.abs(declared - measured) <= Math.max(1e-4 * Math.abs(declared), 1e-6);
}

/**
 * `POSITION` 访问器的实测范围：按"偏移、步长、个数、分量类型"逐个元素读出，与声明的 `min`/`max`
 * （按分量的原始值，`normalized` 不影响）核对，返回还原后的范围（用来算世界包围盒）。
 */
function measurePositions(bin: DataView, accessor: Accessor, index: number): Aabb {
  const size = COMPONENT_SIZE[accessor.componentType]!;
  const { offset, stride } = accessor.data!;
  const rawMin = [Infinity, Infinity, Infinity];
  const rawMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < accessor.count; i += 1) {
    const base = offset + i * stride;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = readComponent(bin, base + axis * size, accessor.componentType, false);
      if (!Number.isFinite(value)) reject('glb_position', `访问器 ${index} 的坐标不是有限数`);
      rawMin[axis] = Math.min(rawMin[axis]!, value);
      rawMax[axis] = Math.max(rawMax[axis]!, value);
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (
      !close(accessor.min![axis]!, rawMin[axis]!) ||
      !close(accessor.max![axis]!, rawMax[axis]!)
    ) {
      reject(
        'glb_bounds_mismatch',
        `访问器 ${index} 声明的 min/max 与顶点数据不符（第 ${axis} 轴：声明 ${accessor.min![axis]}..${accessor.max![axis]}，实测 ${rawMin[axis]}..${rawMax[axis]}）`,
      );
    }
  }
  const dequantize = (value: number): number => {
    if (!accessor.normalized) return value;
    const buffer = new DataView(new ArrayBuffer(4));
    switch (accessor.componentType) {
      case 5120:
        buffer.setInt8(0, value);
        break;
      case 5121:
        buffer.setUint8(0, value);
        break;
      case 5122:
        buffer.setInt16(0, value, true);
        break;
      case 5123:
        buffer.setUint16(0, value, true);
        break;
      default:
        return value;
    }
    return readComponent(buffer, 0, accessor.componentType, true);
  };
  return {
    min: rawMin.map(dequantize) as unknown as Vec3,
    max: rawMax.map(dequantize) as unknown as Vec3,
  };
}

function corners(box: Aabb): Vec3[] {
  const result: Vec3[] = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) result.push([x, y, z]);
    }
  }
  return result;
}

/** `POSITION` 访问器的类型：VEC3，浮点数，或声明了 `KHR_mesh_quantization` 时的字节、短整数；有有限的 min/max。 */
function checkPosition(accessor: Accessor, index: number, quantization: boolean): Accessor {
  if (accessor.data === null) {
    reject('glb_position', `POSITION 访问器 ${index} 没有数据（bufferView）`);
  }
  if (accessor.components !== 3) reject('glb_position', `POSITION 访问器 ${index} 不是 VEC3`);
  if (accessor.componentType !== FLOAT) {
    if (!QUANTIZED.includes(accessor.componentType)) {
      reject('glb_position', `POSITION 访问器 ${index} 的分量类型不对`);
    }
    if (!quantization) {
      reject(
        'glb_position',
        `POSITION 访问器 ${index} 是量化坐标，但没有声明 KHR_mesh_quantization`,
      );
    }
  }
  const finite3 = (v: readonly number[] | undefined) =>
    v !== undefined && v.length === 3 && v.every(Number.isFinite);
  if (!finite3(accessor.min) || !finite3(accessor.max)) {
    reject('glb_position', `POSITION 访问器 ${index} 必须有 3 个有限数的 min 和 max`);
  }
  return accessor;
}

/**
 * 完整检查（网页用模型、物件模型）。`maxJsonBytes`：网页用模型 4 MiB、物件模型 2 MiB。三角形数、贴图边长、
 * 像素合计、坐标按 `limits` 查，超过就拒绝（与服务端上传核对相同）。整份读进内存（≤ 64 MiB）。
 */
export async function checkGlb(
  source: ByteSource,
  limits: GlbLimits,
  maxJsonBytes: number,
): Promise<GlbCheck> {
  const layout = await readLayout(source, maxJsonBytes);
  const { json, binLength } = layout;
  const imageItems = checkExternal(json, binLength);
  const extensions = checkExtensions(json);
  const accessors = parseAccessors(json, binLength);
  const meshes = parseMeshes(json, accessors.length);
  const materials = objects(json, 'materials', GLB_MAX_MATERIALS).length;
  objects(json, 'textures', GLB_MAX_TEXTURES);
  const { instances, nodes } = walkScene(json, meshes.length);
  const bin = await readExact(source, layout.binOffset, binLength, 'glb_header', 'BIN 块');
  const binView = view(bin);

  // 三角形数。
  let triangles = 0;
  for (const instance of instances) {
    for (const primitive of meshes[instance.mesh]!) {
      const count = accessors[primitive.indices ?? primitive.position]!.count;
      if (count % 3 !== 0) {
        reject('glb_triangles', `顶点（索引）数 ${count} 不是 3 的倍数`);
      }
      triangles += count / 3;
    }
  }
  if (triangles === 0) reject('glb_triangles', '场景里没有三角形');
  if (triangles > limits.maxTriangles) {
    reject('glb_too_many_triangles', `${triangles} 个三角形，超过上限 ${limits.maxTriangles}`);
  }

  // 实测包围盒。
  const quantization = extensions.includes('KHR_mesh_quantization');
  const measured = new Map<number, Aabb>();
  let bounds: Aabb | null = null;
  for (const instance of instances) {
    for (const primitive of meshes[instance.mesh]!) {
      let local = measured.get(primitive.position);
      if (local === undefined) {
        const accessor = checkPosition(
          accessors[primitive.position]!,
          primitive.position,
          quantization,
        );
        local = measurePositions(binView, accessor, primitive.position);
        measured.set(primitive.position, local);
      }
      for (const corner of corners(local)) {
        const p = transformPoint(instance.world, corner);
        bounds =
          bounds === null
            ? { min: p, max: p }
            : {
                min: [
                  Math.min(bounds.min[0], p[0]),
                  Math.min(bounds.min[1], p[1]),
                  Math.min(bounds.min[2], p[2]),
                ],
                max: [
                  Math.max(bounds.max[0], p[0]),
                  Math.max(bounds.max[1], p[1]),
                  Math.max(bounds.max[2], p[2]),
                ],
              };
      }
    }
  }
  const world = bounds!;
  if (
    [...world.min, ...world.max].some((v) => !Number.isFinite(v) || Math.abs(v) > limits.maxCoord)
  ) {
    reject('glb_coord_range', `世界包围盒超出 ±${limits.maxCoord} 米`);
  }

  // 图片头。
  const images: GlbImage[] = imageItems.map((image, index) => {
    const mime = image.mimeType;
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      reject('glb_image', `图片 ${index} 的 mimeType 只能是 image/png 或 image/jpeg`);
    }
    const viewIndex = image.bufferView;
    const views = (json.bufferViews ?? []) as Json[];
    if (!isIndex(viewIndex, views.length))
      reject('glb_image', `图片 ${index} 没有合法的 bufferView`);
    const item = views[viewIndex]!;
    const start = (item.byteOffset as number | undefined) ?? 0;
    const bytes = bin.subarray(start, start + (item.byteLength as number));
    let size: { format: string; width: number; height: number };
    try {
      size = imageSize(bytes, ['png', 'jpeg']);
    } catch (error) {
      reject('glb_image', `图片 ${index}：${(error as Error).message}`);
    }
    if (`image/${size.format}` !== mime) {
      reject('glb_image', `图片 ${index} 的文件头是 ${size.format}，与 mimeType ${mime} 不符`);
    }
    return { w: size.width, h: size.height, mime };
  });
  const maxTextureSide = images.reduce((max, image) => Math.max(max, image.w, image.h), 0);
  const texturePixels = images.reduce((sum, image) => sum + image.w * image.h, 0);
  if (maxTextureSide > limits.maxTextureSide) {
    reject('glb_texture_too_large', `贴图边长 ${maxTextureSide} 超过上限 ${limits.maxTextureSide}`);
  }
  if (texturePixels > limits.maxTexturePixels) {
    reject(
      'glb_texture_too_large',
      `贴图像素合计 ${texturePixels} 超过上限 ${limits.maxTexturePixels}`,
    );
  }
  return {
    v: CHECK_VERSION,
    format: 'glb',
    triangles,
    nodes,
    meshes: meshes.length,
    materials,
    images,
    maxTextureSide,
    texturePixels,
    extensions,
    bounds: world,
  };
}

/**
 * 轻量检查（扫描用途）：头、JSON 块（≤ 8 MiB）的结构（数组长度上限）、没有外部引用。不读 BIN 块，
 * 不算三角形和包围盒（为 `null`），不读图片（`images` 为空）。
 */
export async function checkGlbLight(source: ByteSource, maxJsonBytes: number): Promise<GlbCheck> {
  const { json, binLength } = await readLayout(source, maxJsonBytes);
  checkExternal(json, binLength);
  const extensions = strings(json, 'extensionsUsed');
  const nodes = objects(json, 'nodes', GLB_MAX_NODES).length;
  const meshes = objects(json, 'meshes', GLB_MAX_MESHES).length;
  const materials = objects(json, 'materials', GLB_MAX_MATERIALS).length;
  objects(json, 'accessors', GLB_MAX_ACCESSORS);
  objects(json, 'bufferViews', GLB_MAX_BUFFER_VIEWS);
  objects(json, 'textures', GLB_MAX_TEXTURES);
  objects(json, 'scenes', GLB_MAX_SCENES);
  return {
    v: CHECK_VERSION,
    format: 'glb',
    triangles: null,
    nodes,
    meshes,
    materials,
    images: [],
    maxTextureSide: 0,
    texturePixels: 0,
    extensions,
    bounds: null,
  };
}
