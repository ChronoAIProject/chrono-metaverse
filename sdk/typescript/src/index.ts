/**
 * @chrono-metaverse/sdk：建造脚本工具包 + metaverse 命令行的程序接口。
 *
 * 建造脚本里常用的都在工具包里（见 ./kit/index.ts）；这里另外导出脚本的类型
 * （`BuildBase`、`Kit`）、本地应用操作的核心实现和接口客户端，方便写自己的工具。
 */

export * from './kit/index.js';
export type {
  BuildBase,
  BuildOutput,
  BuildScript,
  BuildTarget,
  Kit,
  OpLike,
} from './workspace/build.js';
export { runBuild, flattenOps } from './workspace/build.js';
export {
  WorkingState,
  parseOp,
  parseOps,
  OpError,
  MAX_OPS_PER_BATCH,
  type Op,
  type BlockRef,
  type BlockDef,
  type PaletteBlock,
} from './core/ops.js';
export {
  entityRecordHash,
  anchorRecordHash,
  validateEntityBody,
  validateAnchorBody,
  type EntityBody,
  type AnchorBody,
  type AnchorKind,
  type EntityKind,
  type DataVisibility,
} from './core/record.js';
export {
  AllowedArea,
  type PathScope,
  type Region,
  type Plot,
  type Footprint,
} from './core/scope.js';
export {
  checkBundle,
  checkBundleText,
  BundleError,
  type CheckedBundle,
  type BundleCheckOptions,
} from './core/bundle.js';
export { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from './core/limits.js';
export { canonicalJson, contentHash } from './core/canonical.js';
export { chunkHash, compressChunk, decompressChunk, type Layer } from './core/chunk.js';
export type {
  Transform,
  Material,
  Outline,
  BoxShape,
  CylinderShape,
  ConeShape,
  ExtrudeShape,
  LatheShape,
  SweepShape,
  LoftShape,
  GroupShape,
  InstanceShape,
} from './core/shape.js';
export { ApiClient, ApiError, type TransportConfig } from './transport/client.js';
export { MetaverseApi, type UploadFormat, type UploadPurpose } from './transport/api.js';
export { resolveNyxToken } from './transport/token.js';
export { upload, waitForJob, type UploadOptions } from './transport/upload.js';
