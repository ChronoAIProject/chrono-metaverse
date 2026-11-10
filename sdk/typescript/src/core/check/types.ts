import type { Aabb } from '../grid.js';

/**
 * 资源核对记录（`metadata.check`，docs/SHAPES.md 第 8 节）的类型和共用的读取工具。
 *
 * 核对记录只取决于文件内容，谁算都一样：服务端上传核对时算一次存起来，命令行 `bundle check` 在本地按
 * 同样的规则算一次，提前发现不合规的文件。字段与 Rust `metaverse_core::check` 相同。
 */

/** `check` 的格式版本。 */
export const CHECK_VERSION = 1;

/**
 * 文件不合规。`code` 是拒绝码（小写加下划线，例如 `glb_bounds_mismatch`），`message` 是给人看的说明。
 * 拒绝码与接口服务的上传核对相同，列表见 `index.ts` 的说明和测试向量 README 第 9 节。
 */
export class CheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CheckError';
  }
}

export function reject(code: string, message: string): never {
  throw new CheckError(code, message);
}

/** glb 里的一张图片。 */
export interface GlbImage {
  readonly w: number;
  readonly h: number;
  /** `image/png` 或 `image/jpeg`。 */
  readonly mime: string;
}

/**
 * glb 的核对记录。扫描用途的 glb 只做轻量检查，`triangles`、`bounds` 为 `null`，不能当网页用模型或物件模型。
 */
export interface GlbCheck {
  readonly v: number;
  readonly format: 'glb';
  /** 场景里的三角形数（同一个网格被几个节点引用就算几次）。 */
  readonly triangles: number | null;
  readonly nodes: number;
  readonly meshes: number;
  readonly materials: number;
  readonly images: readonly GlbImage[];
  /** 单张图片的最大边长（没有图片时为 0）。 */
  readonly maxTextureSide: number;
  /** 全部图片像素合计。 */
  readonly texturePixels: number;
  /** `extensionsUsed`。 */
  readonly extensions: readonly string[];
  /** 实测的世界包围盒（米）。 */
  readonly bounds: Aabb | null;
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** 图片（png、jpeg、webp）的核对记录。 */
export interface ImageCheck {
  readonly v: number;
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

/** 扫描 zip 的核对记录。 */
export interface ZipCheck {
  readonly v: number;
  readonly format: 'zip';
  /** 唯一的网格成员（glb、drc、obj）的名称。 */
  readonly mesh: string;
  /** 成员数（含忽略的 `__MACOSX/`、`.DS_Store` 和目录项）。 */
  readonly members: number;
}

/** 只记格式的核对记录。 */
export interface PlainCheck {
  readonly v: number;
  readonly format: 'drc' | 'obj' | 'ndjson' | 'gzip' | 'text' | 'json';
}

export type AssetCheck = GlbCheck | ImageCheck | ZipCheck | PlainCheck;

/**
 * 可以随机读取的字节来源（本地文件或内存）。原始扫描最大 1 GiB，zip 和扫描用途的 glb 只读需要的几段，
 * 不整份读进内存。
 */
export interface ByteSource {
  readonly size: number;
  /** 读 `[offset, offset + length)`；超出文件时只返回文件里有的部分。 */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(Math.min(offset, bytes.length), offset + length)),
  };
}

/** 读满 `[offset, offset + length)`，读不满（文件太短）时按 `code` 拒绝。 */
export async function readExact(
  source: ByteSource,
  offset: number,
  length: number,
  code: string,
  what: string,
): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > source.size) {
    reject(code, `${what}超出文件范围`);
  }
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) reject(code, `${what}读不全`);
  return bytes;
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function startsWith(bytes: Uint8Array, prefix: readonly number[] | string): boolean {
  const values = typeof prefix === 'string' ? Array.from(prefix, (ch) => ch.charCodeAt(0)) : prefix;
  if (bytes.length < values.length) return false;
  return values.every((value, index) => bytes[index] === value);
}

/**
 * 严格的 UTF-8 解码；不是合法的 UTF-8 时返回 null。开头的 BOM 保留成字符（与 Rust 相同：JSON 解析
 * 遇到它会出错，NDJSON 的行也不算以 `{` 开头）。
 */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
