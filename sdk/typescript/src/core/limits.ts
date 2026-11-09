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

/** 清单 `files[].purpose` 的取值。 */
export type BundleFilePurpose = 'scan' | 'webmodel' | 'model' | 'texture' | 'script';

/** 某用途的大小上限。 */
export function maxBytesOf(limits: UploadLimits, purpose: BundleFilePurpose): number {
  return limits[purpose].maxBytes;
}
