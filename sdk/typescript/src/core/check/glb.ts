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
} from '../limits.js';
import { imageSize } from './image.js';
import {
  CHECK_VERSION,
  CheckError,
  readExact,
  reject,
  startsWith,
  utf8,
  view,
  type ByteSource,
  type GlbCheck,
  type GlbImage,
  type ImageFormat,
} from './types.js';

/**
 * glb 检查（docs/design/server-slim.md 4.5，docs/SHAPES.md 第 8 节）。规则、检查的先后和拒绝码与接口服务的
 * 上传核对（Rust `runner/verify/glb.rs`）相同：
 *
 * 1. **头**：魔数 `glTF`、版本 2、头里的总长度等于文件大小；第一个块是 JSON（不超过这个用途的上限），
 *    第二个块（可选）是 `BIN`，没有别的块；
 * 2. **JSON**：字段的类型、数组长度的上限；缓冲区至多一个、缓冲区和图片都不能引用外部文件；
 *    完整检查时扩展用白名单（`extensionsUsed`、`extensionsRequired`、任何对象上的 `extensions` 键），
 *    不收骨骼、动画、相机；
 * 3. **三角形数**：从场景的根节点往下走，节点不能成环、不能有两个父节点；
 * 4. **实测包围盒**：逐个读出 `POSITION` 访问器的元素，与声明的 `min`、`max`（原始值）相差超过
 *    max(1e-4 × |值|, 1e-6) 就拒绝；世界包围盒是各访问器盒子（还原后）的 8 个角点经节点世界变换的外包；
 * 5. **图片头**：魔数必须与 `mimeType`（png、jpeg）一致，读出宽高。
 *
 * 扫描用途只做轻量检查（{@link checkGlbLight}）：头、JSON 的结构、没有外部引用、缓冲区视图和图片的
 * 引用；不算三角形和包围盒（为 null），不限扩展（扫描可能用 Draco），不读图片（`images` 为空）。
 *
 * 三角形数、贴图边长和像素、坐标的上限不在这里查：检查通过以后按用途的上限判断（`fits`，超出是
 * `over_limit`）。
 *
 * 拒绝码：`glb_header`、`glb_json`（JSON 块超过上限、不合规、数组太长、`asset.version` 不是 2.0）、
 * `glb_external_ref`、`glb_extension`、`glb_unsupported`（骨骼、动画、相机、变形目标、稀疏访问器、三角形
 * 以外的图元）、`glb_node_graph`、`glb_triangles`、`glb_accessor`（访问器、缓冲区视图的范围和类型）、
 * `glb_image`（图片的 `mimeType`、缓冲区视图）、`glb_empty`（没有场景、场景里没有网格或顶点）、
 * `glb_bounds_mismatch`、`glb_coords`（世界坐标不是有限数）；图片本身的问题保留图片的码（`image_header`、
 * `image_mime_mismatch`、`jpeg_no_sof`、`jpeg_unsupported`）。
 */

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
/** 缓冲区数组的长度上限（多于 1 个本来就拒绝，这里只防超长数组）。 */
const MAX_BUFFERS = 16;
/** `extensionsUsed`、`extensionsRequired` 的长度上限。 */
const MAX_EXTENSION_NAMES = 64;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// 带类型的读取（字段类型不对一律 glb_json）
// ---------------------------------------------------------------------------

function bad(message: string): never {
  return reject('glb_json', `glb 的 JSON 不合规：${message}`);
}

/** 可选的数组：不给是空数组；给了必须是数组、不超过上限。 */
function array(json: Json, key: string, max: number): unknown[] {
  const value = json[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) bad(`${key} 必须是数组`);
  if (value.length > max) bad(`${key} 超过 ${max} 项`);
  return value;
}

function objects(json: Json, key: string, max: number): Json[] {
  const items = array(json, key, max);
  if (!items.every(isObject)) bad(`${key} 的每一项必须是对象`);
  return items as Json[];
}

function strings(json: Json, key: string, max: number): string[] {
  const items = array(json, key, max);
  if (!items.every((item) => typeof item === 'string')) bad(`${key} 必须是字符串数组`);
  return items as string[];
}

function indices(json: Json, key: string, max: number): number[] {
  const items = array(json, key, max);
  if (!items.every(isCount)) bad(`${key} 必须是非负整数数组`);
  return items as number[];
}

function optionalCount(json: Json, key: string): number | undefined {
  const value = json[key];
  if (value === undefined) return undefined;
  if (!isCount(value)) bad(`${key} 必须是非负整数`);
  return value;
}

function count(json: Json, key: string, what: string): number {
  const value = json[key];
  if (!isCount(value)) bad(`${what}的 ${key} 必须是非负整数`);
  return value;
}

/** 可选的定长数字数组（`matrix`、`translation`……）。 */
function fixed(json: Json, key: string, length: number): number[] | undefined {
  const value = json[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((v) => typeof v === 'number')
  ) {
    bad(`${key} 必须是 ${length} 个数字`);
  }
  return value as number[];
}

// ---------------------------------------------------------------------------
// JSON 的结构
// ---------------------------------------------------------------------------

interface BufferView {
  readonly buffer: number;
  readonly offset: number;
  readonly length: number;
  readonly stride: number | undefined;
}

interface Accessor {
  readonly bufferView: number | undefined;
  readonly offset: number;
  readonly componentType: number;
  readonly normalized: boolean;
  readonly count: number;
  readonly type: string;
  readonly min: number[] | undefined;
  readonly max: number[] | undefined;
  readonly sparse: boolean;
}

interface Primitive {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices: number | undefined;
  readonly mode: number | undefined;
  readonly targets: boolean;
}

interface Node {
  readonly children: number[];
  readonly mesh: number | undefined;
  readonly matrix: number[] | undefined;
  readonly translation: number[] | undefined;
  readonly rotation: number[] | undefined;
  readonly scale: number[] | undefined;
  readonly skin: boolean;
  readonly camera: boolean;
}

interface Image {
  readonly uri: boolean;
  readonly bufferView: number | undefined;
  readonly mimeType: string | undefined;
}

interface Gltf {
  readonly scene: number | undefined;
  readonly scenes: number[][];
  readonly nodes: Node[];
  readonly meshes: Primitive[][];
  readonly accessors: Accessor[];
  readonly bufferViews: BufferView[];
  readonly buffers: { readonly byteLength: number; readonly uri: boolean }[];
  readonly images: Image[];
  readonly materials: number;
  readonly skins: number;
  readonly animations: number;
  readonly cameras: number;
  readonly extensionsUsed: string[];
  readonly extensionsRequired: string[];
}

function parseGltf(json: Json): Gltf {
  const asset = json.asset;
  if (!isObject(asset) || typeof asset.version !== 'string') bad('缺少 asset.version');
  const scene = optionalCount(json, 'scene');
  const scenes = objects(json, 'scenes', GLB_MAX_SCENES).map((item) =>
    indices(item, 'nodes', GLB_MAX_NODES),
  );
  const nodes = objects(json, 'nodes', GLB_MAX_NODES).map((item) => ({
    children: indices(item, 'children', GLB_MAX_NODES),
    mesh: optionalCount(item, 'mesh'),
    matrix: fixed(item, 'matrix', 16),
    translation: fixed(item, 'translation', 3),
    rotation: fixed(item, 'rotation', 4),
    scale: fixed(item, 'scale', 3),
    skin: item.skin !== undefined,
    camera: item.camera !== undefined,
  }));
  const meshes = objects(json, 'meshes', GLB_MAX_MESHES).map((mesh) =>
    objects(mesh, 'primitives', GLB_MAX_PRIMITIVES_PER_MESH).map((primitive) => {
      const attributes = primitive.attributes ?? {};
      if (!isObject(attributes) || !Object.values(attributes).every(isCount)) {
        bad('图元的 attributes 必须是 { 名称: 访问器下标 }');
      }
      const mode = primitive.mode;
      if (mode !== undefined && !isCount(mode)) bad('图元的 mode 必须是非负整数');
      return {
        attributes: attributes as Record<string, number>,
        indices: optionalCount(primitive, 'indices'),
        mode: mode as number | undefined,
        targets: primitive.targets !== undefined,
      };
    }),
  );
  const accessors = objects(json, 'accessors', GLB_MAX_ACCESSORS).map((item) => {
    const bounds = (key: 'min' | 'max'): number[] | undefined => {
      const value = item[key];
      if (value === undefined) return undefined;
      if (
        !Array.isArray(value) ||
        value.length > 16 ||
        !value.every((v) => typeof v === 'number')
      ) {
        bad(`访问器的 ${key} 必须是最多 16 个数字`);
      }
      return value as number[];
    };
    if (typeof item.type !== 'string') bad('访问器的 type 必须是字符串');
    if (item.normalized !== undefined && typeof item.normalized !== 'boolean') {
      bad('访问器的 normalized 必须是 true 或 false');
    }
    return {
      bufferView: optionalCount(item, 'bufferView'),
      offset: optionalCount(item, 'byteOffset') ?? 0,
      componentType: count(item, 'componentType', '访问器'),
      normalized: item.normalized === true,
      count: count(item, 'count', '访问器'),
      type: item.type,
      min: bounds('min'),
      max: bounds('max'),
      sparse: item.sparse !== undefined,
    };
  });
  const bufferViews = objects(json, 'bufferViews', GLB_MAX_BUFFER_VIEWS).map((item) => ({
    buffer: count(item, 'buffer', '缓冲区视图'),
    offset: optionalCount(item, 'byteOffset') ?? 0,
    length: count(item, 'byteLength', '缓冲区视图'),
    stride: optionalCount(item, 'byteStride'),
  }));
  const buffers = objects(json, 'buffers', MAX_BUFFERS).map((item) => ({
    byteLength: count(item, 'byteLength', '缓冲区'),
    uri: item.uri !== undefined,
  }));
  const images = objects(json, 'images', GLB_MAX_IMAGES).map((item) => {
    if (item.mimeType !== undefined && typeof item.mimeType !== 'string') {
      bad('图片的 mimeType 必须是字符串');
    }
    return {
      uri: item.uri !== undefined,
      bufferView: optionalCount(item, 'bufferView'),
      mimeType: item.mimeType as string | undefined,
    };
  });
  const materials = array(json, 'materials', GLB_MAX_MATERIALS).length;
  array(json, 'textures', GLB_MAX_TEXTURES);
  return {
    scene,
    scenes,
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers,
    images,
    materials,
    skins: array(json, 'skins', Number.MAX_SAFE_INTEGER).length,
    animations: array(json, 'animations', Number.MAX_SAFE_INTEGER).length,
    cameras: array(json, 'cameras', Number.MAX_SAFE_INTEGER).length,
    extensionsUsed: strings(json, 'extensionsUsed', MAX_EXTENSION_NAMES),
    extensionsRequired: strings(json, 'extensionsRequired', MAX_EXTENSION_NAMES),
  };
}

/** 走一遍整个 JSON，收集所有对象上 `extensions` 对象的键（`extensions` 不是对象时 glb_json）。 */
function extensionKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) extensionKeys(item, found);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'extensions') {
      if (!isObject(item)) bad('extensions 必须是对象');
      for (const [name, inner] of Object.entries(item)) {
        if (found.size < 256) found.add(name);
        extensionKeys(inner, found);
      }
    } else {
      extensionKeys(item, found);
    }
  }
}

// ---------------------------------------------------------------------------
// 头和块
// ---------------------------------------------------------------------------

interface Layout {
  readonly json: Json;
  /** JSON 块结束的位置。 */
  readonly jsonEnd: number;
}

/** 头：魔数、版本、总长度、JSON 块头；再读 JSON 块（≤ `maxJsonBytes`）并解析。 */
async function readHeaderAndJson(source: ByteSource, maxJsonBytes: number): Promise<Layout> {
  if (source.size < 20) reject('glb_header', 'glb 不完整');
  const head = await readExact(source, 0, 20, 'glb_header', 'glb 头');
  const data = view(head);
  if (!startsWith(head, 'glTF')) reject('glb_header', '不是 glb 文件（缺少 glTF 魔数）');
  const version = data.getUint32(4, true);
  if (version !== 2) reject('glb_header', `只接受 glb 版本 2，这个是 ${version}`);
  const total = data.getUint32(8, true);
  if (total !== source.size) {
    reject('glb_header', `glb 头里的总长度 ${total} 与文件大小 ${source.size} 不一致`);
  }
  const jsonLength = data.getUint32(12, true);
  if (data.getUint32(16, true) !== CHUNK_JSON) reject('glb_header', 'glb 的第一个块不是 JSON');
  if (jsonLength > maxJsonBytes) {
    reject('glb_json', `glb 的 JSON 块 ${jsonLength} 字节，超过这个用途的上限 ${maxJsonBytes}`);
  }
  if (20 + jsonLength > source.size) reject('glb_header', 'glb 的 JSON 块超出了文件');
  const text = utf8(await readExact(source, 20, jsonLength, 'glb_header', 'glb 的 JSON 块'));
  let json: unknown;
  try {
    json = JSON.parse(text ?? '');
  } catch {
    bad('不是合法的 UTF-8 JSON');
  }
  if (!isObject(json)) bad('顶层必须是对象');
  return { json, jsonEnd: 20 + jsonLength };
}

/** JSON 之后：可选的 BIN 块头（只能有 JSON 和 BIN 两个块）。返回 BIN 块的起点和长度（没有时长度为 null）。 */
async function readBinHeader(
  source: ByteSource,
  jsonEnd: number,
): Promise<{ start: number; length: number | null }> {
  if (jsonEnd === source.size) return { start: jsonEnd, length: null };
  if (jsonEnd + 8 > source.size) reject('glb_header', 'glb 的 BIN 块头不完整');
  const header = await readExact(source, jsonEnd, 8, 'glb_header', 'glb 的 BIN 块头');
  const data = view(header);
  const length = data.getUint32(0, true);
  if (data.getUint32(4, true) !== CHUNK_BIN) reject('glb_header', 'glb 的第二个块不是 BIN');
  if (jsonEnd + 8 + length !== source.size) {
    reject('glb_header', 'glb 的块长度与文件大小不一致（只能有 JSON 和 BIN 两个块）');
  }
  return { start: jsonEnd + 8, length };
}

// ---------------------------------------------------------------------------
// 共同的结构检查
// ---------------------------------------------------------------------------

/** 没有外部引用：缓冲区就是 BIN 块，图片都在缓冲区里。 */
function checkExternal(gltf: Gltf): void {
  if (gltf.buffers.length > 1) reject('glb_external_ref', 'glb 只能有一个缓冲区（BIN 块）');
  if (gltf.buffers.some((buffer) => buffer.uri)) {
    reject('glb_external_ref', 'glb 的缓冲区不能引用外部文件');
  }
  if (gltf.images.some((image) => image.uri || image.bufferView === undefined)) {
    reject('glb_external_ref', 'glb 的图片只能放在缓冲区里（不能用 uri，外部地址和 data: 都不行）');
  }
}

/** 缓冲区视图的范围（相对缓冲区）；图片引用的缓冲区视图和 `mimeType`。返回图片的格式。 */
function checkViewsAndImages(gltf: Gltf): ImageFormat[] {
  const bufferLength = gltf.buffers[0]?.byteLength;
  for (const item of gltf.bufferViews) {
    if (bufferLength === undefined || item.buffer !== 0) {
      reject('glb_accessor', '缓冲区视图引用了不存在的缓冲区');
    }
    if (item.offset + item.length > bufferLength) {
      reject('glb_accessor', '缓冲区视图超出了缓冲区');
    }
    if (item.stride !== undefined && !(item.stride >= 4 && item.stride <= 252)) {
      reject('glb_accessor', '缓冲区视图的步长不对');
    }
  }
  return gltf.images.map((image) => {
    if (gltf.bufferViews[image.bufferView!] === undefined) {
      reject('glb_image', '图片引用了不存在的缓冲区视图');
    }
    if (image.mimeType === 'image/png') return 'png';
    if (image.mimeType === 'image/jpeg') return 'jpeg';
    return reject('glb_image', 'glb 里的图片 mimeType 只能是 image/png 或 image/jpeg');
  });
}

// ---------------------------------------------------------------------------
// 场景图和变换
// ---------------------------------------------------------------------------

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

/** 节点矩阵最后一行与 (0, 0, 0, 1) 允许的差。 */
const MATRIX_ROW_TOLERANCE = 1e-6;
/** 节点矩阵左上 3×3 的两列之间夹角余弦允许的绝对值。 */
const MATRIX_SHEAR_TOLERANCE = 1e-4;

/**
 * glTF 规范要求节点的 `matrix` 能分解成平移、旋转、缩放；网站（three.js 的 GLTFLoader）也是先分解再组合，
 * 最后一行完全不看、切变被抹掉。所以只收最后一行是 (0, 0, 0, 1)、左上 3×3 三列两两正交的矩阵，
 * 否则实测的包围盒会和网站画出来的不一样（与接口服务相同）。
 */
function decomposable(m: Mat4): boolean {
  if (
    Math.abs(m[3]!) > MATRIX_ROW_TOLERANCE ||
    Math.abs(m[7]!) > MATRIX_ROW_TOLERANCE ||
    Math.abs(m[11]!) > MATRIX_ROW_TOLERANCE ||
    Math.abs(m[15]! - 1) > MATRIX_ROW_TOLERANCE
  ) {
    return false;
  }
  const column = (c: number): Vec3 => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (
    [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const
  ).every(([i, j]) => {
    const a = column(i);
    const b = column(j);
    return Math.abs(dot(a, b)) <= MATRIX_SHEAR_TOLERANCE * Math.sqrt(dot(a, a) * dot(b, b));
  });
}

/** 节点的局部变换：`matrix`，或 平移 · 旋转（四元数）· 缩放。 */
function localMatrix(node: Node): Mat4 {
  if (node.matrix !== undefined) {
    if (!node.matrix.every(Number.isFinite)) reject('glb_json', '节点矩阵里有不是有限数的值');
    if (!decomposable(node.matrix)) {
      reject('glb_json', '节点矩阵不能分解成平移、旋转、缩放（最后一行要是 0 0 0 1，不能有切变）');
    }
    return node.matrix;
  }
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  if (![...t, ...r, ...s].every(Number.isFinite)) {
    reject('glb_json', '节点变换里有不是有限数的值');
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

/** 按仿射变换算：与网站一样不看最后一行（节点矩阵的最后一行已查过是 0 0 0 1）。 */
function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

/** 每个节点至多一个父节点，不能成环（不在场景里的节点也查）。返回每个节点的父节点（没有为 -1）。 */
function parents(nodes: readonly Node[]): number[] {
  const parent = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((node, index) => {
    for (const child of node.children) {
      if (child >= nodes.length) reject('glb_node_graph', '节点引用了不存在的子节点');
      if (parent[child] !== -1) reject('glb_node_graph', 'glb 的节点有两个父节点');
      if (child === index) reject('glb_node_graph', 'glb 的节点成环');
      parent[child] = index;
    }
  });
  // 沿父节点往上走：0 = 没看过，1 = 正在走的这条路上，2 = 已确认能走到根。
  const state = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start += 1) {
    const path: number[] = [];
    let current = start;
    while (current !== -1) {
      if (state[current] === 2) break;
      if (state[current] === 1) reject('glb_node_graph', 'glb 的节点成环');
      state[current] = 1;
      path.push(current);
      current = parent[current]!;
    }
    for (const index of path) state[index] = 2;
  }
  return parent;
}

const COMPONENT_SIZE: Readonly<Record<number, number>> = {
  5126: 4,
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
};

/** 一个图元：只收三角形、`POSITION` 的规则、三角形数。 */
function primitiveTriangles(gltf: Gltf, primitive: Primitive): number {
  if (primitive.mode !== undefined && primitive.mode !== 4) {
    reject('glb_unsupported', 'glb 的图元只能是三角形（mode 4）');
  }
  if (primitive.targets) reject('glb_unsupported', 'glb 不能带变形目标');
  const position = primitive.attributes.POSITION;
  if (position === undefined) reject('glb_accessor', '图元没有 POSITION');
  const accessor = gltf.accessors[position];
  if (accessor === undefined) reject('glb_accessor', 'POSITION 引用了不存在的访问器');
  let counted = accessor.count;
  if (primitive.indices !== undefined) {
    const items = gltf.accessors[primitive.indices];
    if (items === undefined) reject('glb_accessor', 'indices 引用了不存在的访问器');
    if (items.type !== 'SCALAR' || ![5121, 5123, 5125].includes(items.componentType)) {
      reject('glb_accessor', 'indices 必须是无符号整数的标量');
    }
    if (items.sparse) reject('glb_unsupported', 'glb 不能用稀疏访问器');
    counted = items.count;
  }
  if (counted % 3 !== 0) {
    reject('glb_triangles', `图元的顶点数或索引数 ${counted} 不是 3 的倍数`);
  }
  return counted / 3;
}

/** `POSITION` 访问器在缓冲区里的数据。 */
interface PositionData {
  readonly index: number;
  readonly start: number;
  readonly stride: number;
  readonly accessor: Accessor;
}

function positionData(gltf: Gltf, index: number): PositionData {
  const accessor = gltf.accessors[index]!;
  if (accessor.type !== 'VEC3') reject('glb_accessor', 'POSITION 必须是 VEC3');
  if (accessor.sparse) reject('glb_unsupported', 'glb 不能用稀疏访问器');
  const size = COMPONENT_SIZE[accessor.componentType];
  if (size === undefined) reject('glb_accessor', 'POSITION 的分量类型不对');
  const quantized = accessor.componentType !== 5126;
  if (quantized && !gltf.extensionsUsed.includes('KHR_mesh_quantization')) {
    reject('glb_accessor', 'POSITION 不是浮点数时要声明 KHR_mesh_quantization');
  }
  if (!quantized && accessor.normalized) {
    reject('glb_accessor', '浮点数的 POSITION 不能 normalized');
  }
  const finite3 = (value: number[] | undefined) =>
    value !== undefined && value.length === 3 && value.every(Number.isFinite);
  if (!finite3(accessor.min) || !finite3(accessor.max)) {
    reject('glb_accessor', 'POSITION 必须有 3 个有限数的 min 和 max');
  }
  const bufferView =
    accessor.bufferView === undefined ? undefined : gltf.bufferViews[accessor.bufferView];
  if (bufferView === undefined) reject('glb_accessor', 'POSITION 没有缓冲区视图');
  const element = 3 * size;
  const stride = bufferView.stride ?? element;
  if (stride < element) reject('glb_accessor', '缓冲区视图的步长比元素还小');
  if (
    accessor.count > 0 &&
    accessor.offset + (accessor.count - 1) * stride + element > bufferView.length
  ) {
    reject('glb_accessor', '访问器的数据超出了缓冲区视图');
  }
  return { index, start: bufferView.offset + accessor.offset, stride, accessor };
}

/** 读一个分量的原始值（不归一化）。 */
function readRaw(data: DataView, offset: number, componentType: number): number {
  switch (componentType) {
    case 5126:
      return data.getFloat32(offset, true);
    case 5120:
      return data.getInt8(offset);
    case 5121:
      return data.getUint8(offset);
    case 5122:
      return data.getInt16(offset, true);
    default:
      return data.getUint16(offset, true);
  }
}

/** 按 glTF 规范把归一化的整数还原成浮点数。 */
function normalize(componentType: number, raw: number): number {
  switch (componentType) {
    case 5120:
      return Math.max(raw / 127, -1);
    case 5121:
      return raw / 255;
    case 5122:
      return Math.max(raw / 32767, -1);
    case 5123:
      return raw / 65535;
    default:
      return raw;
  }
}

/** 逐个元素读出原始值的范围（没有元素时为 null）。 */
function measureRaw(bin: DataView, data: PositionData): Aabb | null {
  const { accessor, start, stride, index } = data;
  if (accessor.count === 0) return null;
  const size = COMPONENT_SIZE[accessor.componentType]!;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < accessor.count; i += 1) {
    const base = start + i * stride;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = readRaw(bin, base + axis * size, accessor.componentType);
      if (!Number.isFinite(value)) {
        reject('glb_accessor', `访问器 ${index} 里有不是有限数的坐标`);
      }
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

/** 声明的 `min`、`max`（原始值）与实测相差不超过 max(1e-4 × |值|, 1e-6)；返回还原后的盒子。 */
function checkDeclared(data: PositionData, raw: Aabb): Aabb {
  const { accessor, index } = data;
  for (let axis = 0; axis < 3; axis += 1) {
    for (const [measured, declared] of [
      [raw.min[axis]!, accessor.min![axis]!],
      [raw.max[axis]!, accessor.max![axis]!],
    ] as const) {
      if (Math.abs(measured - declared) > Math.max(1e-4 * Math.abs(declared), 1e-6)) {
        reject(
          'glb_bounds_mismatch',
          `访问器 ${index} 声明的 min/max 与数据不符（第 ${['x', 'y', 'z'][axis]} 轴：声明 ${declared}，实际 ${measured}）`,
        );
      }
    }
  }
  const restore = (value: number) =>
    accessor.normalized ? normalize(accessor.componentType, value) : value;
  return {
    min: raw.min.map(restore) as unknown as Vec3,
    max: raw.max.map(restore) as unknown as Vec3,
  };
}

function corners(box: Aabb): Vec3[] {
  const result: Vec3[] = [];
  for (let corner = 0; corner < 8; corner += 1) {
    result.push([
      corner & 1 ? box.max[0] : box.min[0],
      corner & 2 ? box.max[1] : box.min[1],
      corner & 4 ? box.max[2] : box.min[2],
    ]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 两种深度
// ---------------------------------------------------------------------------

function record(gltf: Gltf, extras: Pick<GlbCheck, 'triangles' | 'images' | 'bounds'>): GlbCheck {
  const maxTextureSide = extras.images.reduce((max, image) => Math.max(max, image.w, image.h), 0);
  const texturePixels = extras.images.reduce((sum, image) => sum + image.w * image.h, 0);
  return {
    v: CHECK_VERSION,
    format: 'glb',
    triangles: extras.triangles,
    nodes: gltf.nodes.length,
    meshes: gltf.meshes.length,
    materials: gltf.materials,
    images: extras.images,
    maxTextureSide,
    texturePixels,
    extensions: gltf.extensionsUsed,
    bounds: extras.bounds,
  };
}

/** 头、JSON、外部引用、缓冲区视图和图片的引用（两种深度共用）。 */
async function parse(
  source: ByteSource,
  maxJsonBytes: number,
  full: boolean,
): Promise<{ gltf: Gltf; jsonEnd: number; imageFormats: ImageFormat[] }> {
  const { json, jsonEnd } = await readHeaderAndJson(source, maxJsonBytes);
  const gltf = parseGltf(json);
  const keys = new Set<string>();
  extensionKeys(json, keys);
  if ((json.asset as Json).version !== '2.0') bad('asset.version 必须是 2.0');
  checkExternal(gltf);
  if (full) {
    for (const name of [...gltf.extensionsUsed, ...keys]) {
      if (!GLB_EXTENSIONS_USED.includes(name)) {
        reject('glb_extension', `glb 用了不支持的扩展 ${name}`);
      }
    }
    for (const name of gltf.extensionsRequired) {
      if (!GLB_EXTENSIONS_REQUIRED.includes(name)) {
        reject('glb_extension', `glb 要求了不支持的扩展 ${name}`);
      }
    }
    if (gltf.skins > 0 || gltf.nodes.some((node) => node.skin)) {
      reject('glb_unsupported', 'glb 不能带骨骼');
    }
    if (gltf.animations > 0) reject('glb_unsupported', 'glb 不能带动画');
    if (gltf.cameras > 0 || gltf.nodes.some((node) => node.camera)) {
      reject('glb_unsupported', 'glb 不能带相机');
    }
  }
  const imageFormats = checkViewsAndImages(gltf);
  return { gltf, jsonEnd, imageFormats };
}

/** BIN 块：缓冲区不能比它长，要读的数据都在它里面。 */
function checkBin(gltf: Gltf, binLength: number | null, needed: number): void {
  if (binLength === null) {
    if (needed > 0) reject('glb_accessor', 'glb 没有 BIN 块，却引用了缓冲区里的数据');
    return;
  }
  const bufferLength = gltf.buffers[0]?.byteLength;
  if (bufferLength !== undefined && bufferLength > binLength) {
    reject('glb_accessor', 'glb 的缓冲区比 BIN 块长');
  }
  if (needed > binLength) reject('glb_accessor', 'glb 的数据超出了 BIN 块');
}

/**
 * 完整检查（网页用模型、物件模型）。`maxJsonBytes`：网页用模型 4 MiB、物件模型 2 MiB。整份读进内存
 * （≤ 64 MiB）。
 */
export async function checkGlb(source: ByteSource, maxJsonBytes: number): Promise<GlbCheck> {
  const { gltf, jsonEnd, imageFormats } = await parse(source, maxJsonBytes, true);

  // 场景图：从根节点往下走，算世界变换和三角形数。
  const parent = parents(gltf.nodes);
  const roots = gltf.scenes[gltf.scene ?? 0];
  if (roots === undefined) reject('glb_empty', 'glb 里没有场景（scene）');
  for (const root of roots) {
    if (root >= gltf.nodes.length || parent[root] !== -1) {
      reject('glb_node_graph', '场景的根节点不存在或有父节点');
    }
  }
  const visited = new Uint8Array(gltf.nodes.length);
  const instances: { mesh: number; world: Mat4 }[] = [];
  const meshPositions = new Map<number, number[]>();
  let triangles = 0;
  const stack: [number, Mat4][] = roots
    .slice()
    .reverse()
    .map((root) => [root, IDENTITY]);
  while (stack.length > 0) {
    const [index, parentWorld] = stack.pop()!;
    if (visited[index]) reject('glb_node_graph', 'glb 的场景重复引用了同一个节点');
    visited[index] = 1;
    const node = gltf.nodes[index]!;
    const world = multiply(parentWorld, localMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh];
      if (mesh === undefined) reject('glb_json', '节点引用了不存在的网格');
      const accessors: number[] = [];
      for (const primitive of mesh) {
        triangles += primitiveTriangles(gltf, primitive);
        accessors.push(primitive.attributes.POSITION!);
      }
      if (!meshPositions.has(node.mesh)) meshPositions.set(node.mesh, accessors);
      instances.push({ mesh: node.mesh, world });
    }
    for (const child of node.children.slice().reverse()) stack.push([child, world]);
  }
  const used = [...new Set([...meshPositions.values()].flat())].sort((a, b) => a - b);
  if (used.length === 0) reject('glb_empty', 'glb 的场景里没有网格');
  const positions = used.map((index) => positionData(gltf, index));

  // BIN 块。
  const bin = await readBinHeader(source, jsonEnd);
  const images = gltf.images.map((image) => gltf.bufferViews[image.bufferView!]!);
  const needed = Math.max(
    0,
    ...positions.map(({ accessor, start, stride }) =>
      accessor.count === 0
        ? 0
        : start + (accessor.count - 1) * stride + 3 * COMPONENT_SIZE[accessor.componentType]!,
    ),
    ...images.map((item) => item.offset + item.length),
  );
  checkBin(gltf, bin.length, needed);
  const binBytes =
    bin.length === null
      ? new Uint8Array()
      : await readExact(source, bin.start, bin.length, 'glb_header', 'glb 的 BIN 块');
  const binView = view(binBytes);

  // 顶点数据、图片头、声明的 min/max、世界包围盒。
  const raws = positions.map((data) => measureRaw(binView, data));
  const glbImages: GlbImage[] = images.map((item, index) => {
    const bytes = binBytes.subarray(item.offset, item.offset + item.length);
    try {
      const { width, height } = imageSize(bytes, imageFormats[index]);
      return { w: width, h: height, mime: `image/${imageFormats[index]!}` };
    } catch (error) {
      if (error instanceof CheckError) reject(error.code, `glb 里的图片：${error.message}`);
      throw error;
    }
  });
  const measured = new Map<number, Aabb>();
  positions.forEach((data, i) => {
    const raw = raws[i]!;
    if (raw !== null) measured.set(data.index, checkDeclared(data, raw));
  });
  let bounds: { min: number[]; max: number[] } | null = null;
  for (const instance of instances) {
    for (const index of meshPositions.get(instance.mesh) ?? []) {
      const local = measured.get(index);
      if (local === undefined) continue;
      for (const corner of corners(local)) {
        const p = transformPoint(instance.world, corner);
        if (!p.every(Number.isFinite)) reject('glb_coords', 'glb 的世界坐标不是有限数');
        if (bounds === null) {
          bounds = { min: [...p], max: [...p] };
        } else {
          for (let axis = 0; axis < 3; axis += 1) {
            bounds.min[axis] = Math.min(bounds.min[axis]!, p[axis]!);
            bounds.max[axis] = Math.max(bounds.max[axis]!, p[axis]!);
          }
        }
      }
    }
  }
  if (bounds === null) reject('glb_empty', 'glb 的网格没有顶点');
  return record(gltf, {
    triangles,
    images: glbImages,
    bounds: bounds as unknown as Aabb,
  });
}

/**
 * 轻量检查（扫描用途）：头、JSON 块（≤ 8 MiB）的结构、没有外部引用、缓冲区视图和图片的引用、BIN 块头。
 * 不读 BIN 块的数据，不算三角形和包围盒（为 null），不读图片（`images` 为空）。
 */
export async function checkGlbLight(source: ByteSource, maxJsonBytes: number): Promise<GlbCheck> {
  const { gltf, jsonEnd } = await parse(source, maxJsonBytes, false);
  const bin = await readBinHeader(source, jsonEnd);
  checkBin(gltf, bin.length, 0);
  return record(gltf, { triangles: null, images: [], bounds: null });
}
