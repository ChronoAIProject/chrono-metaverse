/**
 * 测试用的小文件生成器：glb、PNG / JPEG / WebP 头、扫描 zip，以及按 docs/design/server-slim.md 6.5 列出的
 * 各种不合规样本（外部 uri、扩展、相机、成环、骨骼、min/max 不符、量化坐标、旋转节点、坐标越界、JPEG 的长段、
 * zip 的路径、加密、zip64、本地头不符……）。只造检查要读的部分，不是能显示的真图片。
 */

type Json = Record<string, unknown>;

function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const length = Math.ceil(bytes.length / 4) * 4;
  const out = new Uint8Array(length).fill(fill);
  out.set(bytes);
  return out;
}

/** 按 glb 2.0 拼文件：12 字节头 + JSON 块（空格补齐）+ 可选的 BIN 块（0 补齐）。 */
export function glbBytes(json: unknown, bin: Uint8Array | null = null): Uint8Array {
  const text = pad4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const body = bin === null ? null : pad4(bin, 0);
  const total = 12 + 8 + text.length + (body === null ? 0 : 8 + body.length);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('glTF'), 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  if (body !== null) {
    const at = 20 + text.length;
    view.setUint32(at, body.length, true);
    view.setUint32(at + 4, 0x004e4942, true);
    out.set(body, at + 8);
  }
  return out;
}

/** 一个长宽高 `size`、底面中心在原点的盒子：8 个顶点、12 个三角形。 */
export function boxPositions(size: readonly [number, number, number] = [1, 1, 1]): number[] {
  const [x, y, z] = [size[0] / 2, size[1], size[2] / 2];
  const out: number[] = [];
  for (const px of [-x, x]) for (const py of [0, y]) for (const pz of [-z, z]) out.push(px, py, pz);
  return out;
}

export const BOX_INDICES = [
  0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7,
  1, 7, 3,
];

export interface MeshSpec {
  /** 顶点坐标（每 3 个一组）。 */
  readonly positions?: readonly number[];
  readonly indices?: readonly number[] | null;
  /** `POSITION` 的分量类型（默认浮点数 5126；5120–5123 是量化坐标）。 */
  readonly componentType?: number;
  readonly normalized?: boolean;
  /** 改写声明的 min / max（默认按数据算）。 */
  readonly min?: readonly number[];
  readonly max?: readonly number[];
  /** 内嵌图片。 */
  readonly images?: readonly { readonly bytes: Uint8Array; readonly mime: string }[];
  /** 节点（默认 `[{mesh: 0}]`）和场景的根节点（默认 `[0]`）。 */
  readonly nodes?: readonly Json[];
  readonly roots?: readonly number[];
  readonly extensionsUsed?: readonly string[];
  /** 最后再改 JSON（加相机、骨骼、外部地址……）。 */
  readonly mutate?: (json: Json) => void;
}

const SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5126: 4 };

function writeComponent(view: DataView, at: number, type: number, value: number): void {
  if (type === 5126) view.setFloat32(at, value, true);
  else if (type === 5120) view.setInt8(at, value);
  else if (type === 5121) view.setUint8(at, value);
  else if (type === 5122) view.setInt16(at, value, true);
  else view.setUint16(at, value, true);
}

/** 一个网格的 glb（默认是 1 米的盒子）。 */
export function meshGlb(spec: MeshSpec = {}): Uint8Array {
  const positions = spec.positions ?? boxPositions();
  const indices = spec.indices === undefined ? BOX_INDICES : spec.indices;
  const type = spec.componentType ?? 5126;
  const count = positions.length / 3;
  const element = 3 * SIZE[type]!;
  const stride = Math.ceil(element / 4) * 4;
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const views: Json[] = [];
  const add = (bytes: Uint8Array, extra: Json = {}): number => {
    const padded = pad4(bytes, 0);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...extra });
    chunks.push(padded);
    offset += padded.length;
    return views.length - 1;
  };
  const vertexBytes = new Uint8Array(stride * count);
  const vertexView = new DataView(vertexBytes.buffer);
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      writeComponent(vertexView, i * stride + axis * SIZE[type]!, type, positions[i * 3 + axis]!);
    }
  }
  const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
  const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
  const accessors: Json[] = [
    {
      bufferView: add(vertexBytes, stride !== element ? { byteStride: stride } : {}),
      componentType: type,
      count,
      type: 'VEC3',
      min: spec.min ?? min,
      max: spec.max ?? max,
      ...(spec.normalized ? { normalized: true } : {}),
    },
  ];
  const primitive: Json = { attributes: { POSITION: 0 } };
  if (indices !== null) {
    const indexBytes = new Uint8Array(indices.length * 2);
    const indexView = new DataView(indexBytes.buffer);
    indices.forEach((value, i) => indexView.setUint16(i * 2, value, true));
    accessors.push({
      bufferView: add(indexBytes),
      componentType: 5123,
      count: indices.length,
      type: 'SCALAR',
    });
    primitive.indices = 1;
  }
  const images = (spec.images ?? []).map((image) => ({
    bufferView: add(image.bytes),
    mimeType: image.mime,
  }));
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    bin.set(chunk, at);
    at += chunk.length;
  }
  const json: Json = {
    asset: { version: '2.0', generator: 'samples' },
    scene: 0,
    scenes: [{ nodes: spec.roots ?? [0] }],
    nodes: spec.nodes ?? [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    ...(images.length > 0
      ? {
          images,
          textures: images.map((_, source) => ({ source })),
          materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        }
      : { materials: [{}] }),
    ...(spec.extensionsUsed !== undefined ? { extensionsUsed: spec.extensionsUsed } : {}),
  };
  spec.mutate?.(json);
  return glbBytes(json, bin);
}

/** 只有头的 PNG（签名 + IHDR + IEND）。 */
export function pngBytes(width: number, height: number): Uint8Array {
  const out = new Uint8Array(8 + 25 + 12);
  const view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13);
  out.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  out.set([8, 2, 0, 0, 0], 24);
  view.setUint32(33, 0);
  out.set(new TextEncoder().encode('IEND'), 37);
  return out;
}

/**
 * 只有段结构的 JPEG：SOI、APP0、可选的若干 APP1（每段 `appBytes` 字节，模拟很长的 EXIF）、SOF0（`sof` 为 false
 * 时不写）、SOS、几个字节的数据、EOI。
 */
export function jpegBytes(
  width: number,
  height: number,
  options: { readonly appSegments?: number; readonly sof?: boolean } = {},
): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  const segment = (marker: number, body: number[]) =>
    parts.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
  segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  for (let i = 0; i < (options.appSegments ?? 0); i += 1) {
    segment(0xe1, new Array<number>(65_000).fill(0x45));
  }
  if (options.sof !== false) {
    segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  }
  segment(0xda, [1, 1, 0, 0, 0x3f, 0]);
  parts.push(0x12, 0x34, 0xff, 0xd9);
  return Uint8Array.from(parts);
}

/** VP8X 头的 WebP。 */
export function webpBytes(width: number, height: number): Uint8Array {
  const out = new Uint8Array(30);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 22, true);
  out.set(new TextEncoder().encode('WEBPVP8X'), 8);
  view.setUint32(16, 10, true);
  view.setUint32(24, (width - 1) & 0xffffff, true);
  view.setUint32(26, ((height - 1) << 8) | ((width - 1) >>> 16), true);
  return out;
}

export interface ZipMember {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  /** 本地头里改用别的名称（造"本地头与中央目录不符"）。 */
  readonly localName?: string;
  /** 本地头里改用别的标志（造"数据描述符只在本地头"）。 */
  readonly localFlags?: number;
  /** 中央目录里的 extra 字段（造 zip64 扩展信息）。 */
  readonly centralExtra?: Uint8Array;
}

/** 按成员顺序存储（不压缩）打成 zip。`zip64Locator` 时在中央目录结尾前加 zip64 定位记录。 */
export function zipBytes(
  members: readonly ZipMember[],
  options: { readonly zip64Locator?: boolean } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (out: number[], v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (out: number[], v: number) =>
    out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  for (const member of members) {
    const data = member.data ?? encoder.encode(`data of ${member.name}`);
    const name = encoder.encode(member.name);
    const localName = encoder.encode(member.localName ?? member.name);
    const offset = local.length;
    u32(local, 0x04034b50);
    u16(local, 20);
    u16(local, member.localFlags ?? member.flags ?? 0);
    u16(local, member.method ?? 0);
    u32(local, 0);
    u32(local, 0);
    u32(local, data.length);
    u32(local, data.length);
    u16(local, localName.length);
    u16(local, 0);
    local.push(...localName, ...data);
    const extra = member.centralExtra ?? new Uint8Array();
    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, member.flags ?? 0);
    u16(central, member.method ?? 0);
    u32(central, 0);
    u32(central, 0);
    u32(central, data.length);
    u32(central, data.length);
    u16(central, name.length);
    u16(central, extra.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name, ...extra);
  }
  const end: number[] = [];
  if (options.zip64Locator) {
    u32(end, 0x07064b50);
    u32(end, 0);
    u32(end, 0);
    u32(end, 0);
    u32(end, 0);
  }
  u32(end, 0x06054b50);
  u16(end, 0);
  u16(end, 0);
  u16(end, members.length);
  u16(end, members.length);
  u32(end, central.length);
  u32(end, local.length);
  u16(end, 0);
  return Uint8Array.from([...local, ...central, ...end]);
}
