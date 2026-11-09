/**
 * 各用途的上传上限（docs/SHAPES.md 第 8 节；Rust `limits.rs` 的移植）。
 *
 * 服务端经 `GET /api/v1/spaces/{space_id}` 的 `uploadLimits` 给出当前生效的值，命令行写进工作区的
 * `limits.json`；没有时用这里的默认值（与服务端默认相同，向量 `bundle/bundle_limits_default.json` 核对）。
 */

const MIB = 1024 * 1024;

/** 只有大小上限的用途（扫描、操作文件、建模记录、重建包清单）。 */
export interface SizeLimit {
  readonly maxBytes: number;
}

/** glb 的上限（网页用模型、物件模型）。 */
export interface GlbLimits {
  readonly maxBytes: number;
  readonly maxTriangles: number;
  readonly maxTextureSide: number;
  readonly maxTexturePixels: number;
  /** 坐标绝对值上限（米，按实测的世界包围盒查）。 */
  readonly maxCoord: number;
}

/** 贴图的上限。 */
export interface ImageLimits {
  readonly maxBytes: number;
  readonly maxSide: number;
  readonly maxPixels: number;
}

/** 各用途的上限（`uploadLimits`、`limits.json`）。 */
export interface UploadLimits {
  readonly v: number;
  readonly scan: SizeLimit;
  readonly webmodel: GlbLimits;
  readonly model: GlbLimits;
  readonly texture: ImageLimits;
  readonly ops: SizeLimit;
  readonly script: SizeLimit;
  readonly bundle: SizeLimit;
}

/** 默认上限。 */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  v: 1,
  scan: { maxBytes: 1024 * MIB },
  webmodel: {
    maxBytes: 64 * MIB,
    maxTriangles: 500_000,
    maxTextureSide: 4096,
    maxTexturePixels: 2 * 4096 * 4096,
    maxCoord: 100_000,
  },
  model: {
    maxBytes: 50 * MIB,
    maxTriangles: 100_000,
    maxTextureSide: 2048,
    maxTexturePixels: 4 * 2048 * 2048,
    maxCoord: 1000,
  },
  texture: { maxBytes: 50 * MIB, maxSide: 4096, maxPixels: 4096 * 4096 },
  ops: { maxBytes: 64 * MIB },
  script: { maxBytes: 4 * MIB },
  bundle: { maxBytes: 16 * MIB },
};

/** 操作文件、重建包清单里每行 / 每条记录的上限：64 KiB。 */
export const MAX_RECORD_BYTES = 64 * 1024;

/** 操作文件解压后的上限：256 MiB（核心库常量，不开放配置）。 */
export const MAX_OPS_INFLATED_BYTES = 256 * MIB;

/** 清单 `files[].purpose` 的取值。 */
export type BundleFilePurpose = 'scan' | 'webmodel' | 'model' | 'texture' | 'script';

/** 某用途的大小上限。 */
export function maxBytesOf(limits: UploadLimits, purpose: BundleFilePurpose): number {
  return limits[purpose].maxBytes;
}

/** glb JSON 块的上限：扫描 8 MiB、网页用模型 4 MiB、物件模型 2 MiB（固定常量，不开放配置）。 */
export const GLB_JSON_SCAN_BYTES = 8 * MIB;
export const GLB_JSON_WEBMODEL_BYTES = 4 * MIB;
export const GLB_JSON_MODEL_BYTES = 2 * MIB;

/** glb JSON 里各数组的长度上限。 */
export const GLB_MAX_NODES = 10_000;
export const GLB_MAX_MESHES = 1000;
export const GLB_MAX_PRIMITIVES_PER_MESH = 256;
export const GLB_MAX_ACCESSORS = 20_000;
export const GLB_MAX_BUFFER_VIEWS = 20_000;
export const GLB_MAX_MATERIALS = 256;
export const GLB_MAX_TEXTURES = 256;
export const GLB_MAX_IMAGES = 64;
export const GLB_MAX_SCENES = 16;

/** zip（扫描）中央目录的上限：≤ 1 MiB、≤ 64 个成员，不收 zip64。 */
export const ZIP_MAX_CENTRAL_DIRECTORY_BYTES = MIB;
export const ZIP_MAX_MEMBERS = 64;

/** glb 允许的扩展（`extensionsUsed`、各对象上的 `extensions` 键）。 */
export const GLB_EXTENSIONS_USED: readonly string[] = [
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
];
/** glb 允许的 `extensionsRequired`。 */
export const GLB_EXTENSIONS_REQUIRED: readonly string[] = [
  'KHR_texture_transform',
  'KHR_mesh_quantization',
];

export class LimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitsError';
  }
}

const LIMIT_SHAPE: Readonly<Record<keyof Omit<UploadLimits, 'v'>, readonly string[]>> = {
  scan: ['maxBytes'],
  webmodel: ['maxBytes', 'maxTriangles', 'maxTextureSide', 'maxTexturePixels', 'maxCoord'],
  model: ['maxBytes', 'maxTriangles', 'maxTextureSide', 'maxTexturePixels', 'maxCoord'],
  texture: ['maxBytes', 'maxSide', 'maxPixels'],
  ops: ['maxBytes'],
  script: ['maxBytes'],
  bundle: ['maxBytes'],
};

/**
 * 读 `uploadLimits` / `limits.json`：形状与 Rust `UploadLimits` 相同（不认识的字段一律拒绝），
 * 版本必须是 1，每个上限都是非负数（`maxCoord` 可以是小数，其余是整数）。不合格时抛出 LimitsError。
 */
export function parseUploadLimits(value: unknown): UploadLimits {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(value)) throw new LimitsError('上限必须是 JSON 对象');
  const keys = ['v', ...Object.keys(LIMIT_SHAPE)];
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new LimitsError(`上限里不认识的字段 ${unknown.join('、')}`);
  if (value.v !== 1) throw new LimitsError('上限的版本 v 只认 1');
  for (const [purpose, fields] of Object.entries(LIMIT_SHAPE)) {
    const item = value[purpose];
    if (!isObject(item)) throw new LimitsError(`上限缺少 ${purpose}`);
    for (const key of Object.keys(item)) {
      if (!fields.includes(key)) throw new LimitsError(`${purpose} 里不认识的字段 ${key}`);
    }
    for (const field of fields) {
      const number = item[field];
      const ok =
        typeof number === 'number' &&
        Number.isFinite(number) &&
        number >= 0 &&
        (field === 'maxCoord' || Number.isInteger(number));
      if (!ok) throw new LimitsError(`${purpose}.${field} 必须是非负数`);
    }
  }
  return value as unknown as UploadLimits;
}
