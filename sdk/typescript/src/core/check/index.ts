import { open } from 'node:fs/promises';
import { aabbIsValid, type Aabb } from '../grid.js';
import {
  GLB_EXTENSIONS_USED,
  GLB_JSON_MODEL_BYTES,
  GLB_JSON_SCAN_BYTES,
  GLB_JSON_WEBMODEL_BYTES,
  type BundleFilePurpose,
  type GlbLimits,
  type UploadLimits,
} from '../limits.js';
import { transformAabb, type Transform } from '../shape.js';
import { checkGlb, checkGlbLight } from './glb.js';
import { checkTexture, sniffImage } from './image.js';
import { checkBundleOuter, checkDraco, checkObj, checkOps, checkScript, readAll } from './text.js';
import {
  reject,
  startsWith,
  type AssetCheck,
  type ByteSource,
  type GlbCheck,
  type ImageFormat,
} from './types.js';
import { checkZip } from './zip.js';

/**
 * 资源核对的命令行实现（docs/design/server-slim.md 4.4–4.6，docs/SHAPES.md 第 8 节）：按用途检查本地文件，
 * 算出与服务端相同的核对记录 `check`，再按用途的上限判断（{@link fits}）；另有"模型与记录一致"
 * （{@link modelFitsEntity}）。`metaverse bundle check` 用它在上传之前发现不合规的文件；服务端（Rust
 * `runner/verify/`）的检查是权威，两边跑同一批二进制样本（`tests/vectors/check/`）。
 *
 * 拒绝码（`CheckError.code`，与服务端相同，测试向量 README 第 9 节）：
 *
 * - 共同：`format_mismatch`（这个用途不收这种格式，或内容与声明的格式不符）、`over_limit`（检查通过，
 *   但超出这个用途的上限：大小、三角形、贴图边长、像素合计、坐标）；
 * - glb：见 `glb.ts`；图片：见 `image.ts`；zip：见 `zip.ts`；drc、obj、文本、操作文件、清单：见 `text.ts`。
 */

export * from './types.js';
export { checkGlb, checkGlbLight } from './glb.js';
export { checkTexture, imageSize, sniffImage } from './image.js';
export { checkZip, unsafeMemberName } from './zip.js';

/** 模型与物件 `bounds` 的边长允许相差的绝对值（米）。 */
export const MODEL_FIT_ABS = 0.02;
/** 模型与物件 `bounds` 的边长允许相差的比例（按物件 `bounds` 的边长）。 */
export const MODEL_FIT_REL = 0.01;
/** 模型原点离底面中心的允许偏差（米）。 */
export const MODEL_ORIGIN_TOLERANCE = 0.02;

/** 资源被引用时的角色（与 Rust `AssetRole` 相同）。 */
export type AssetRole = 'scan' | 'webModel' | 'model' | 'texture' | 'script' | 'bundle' | 'ops';

/** 上传用途（检查按用途选检查器和上限）：清单里文件的五种，加上操作文件和清单本身。 */
export type CheckPurpose = BundleFilePurpose | 'ops' | 'bundle';

/** 上传时声明的格式（与核对记录的 `format` 同名）。 */
export type AssetFormat = AssetCheck['format'];

/** 各用途按哪个角色检查上限（与 Rust `AssetRole::for_purpose` 相同）。 */
export const PURPOSE_ROLE: Readonly<Record<CheckPurpose, AssetRole>> = {
  scan: 'scan',
  webmodel: 'webModel',
  model: 'model',
  texture: 'texture',
  script: 'script',
  ops: 'ops',
  bundle: 'bundle',
};

/** 各用途接受的格式（docs/design/server-slim.md 4.4 的表）。 */
export const PURPOSE_FORMATS: Readonly<Record<CheckPurpose, readonly AssetFormat[]>> = {
  scan: ['glb', 'drc', 'obj', 'zip'],
  webmodel: ['glb'],
  model: ['glb'],
  texture: ['png', 'jpeg', 'webp'],
  ops: ['ndjson', 'gzip'],
  script: ['text'],
  bundle: ['json'],
};

/** 本地文件的字节来源（按需随机读取）。用完要 `close()`。 */
export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const want = Math.max(0, Math.min(length, size - offset));
      const buffer = new Uint8Array(want);
      let filled = 0;
      while (filled < want) {
        const { bytesRead } = await handle.read(buffer, filled, want - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    },
    close: () => handle.close(),
  };
}

/**
 * 没有声明格式时按内容认（命令行上传时就声明这个格式）：扫描按魔数认 glb、drc、zip，其余当 obj；
 * 贴图按魔数认（认不出时为 null，交给图片检查拒绝）；操作文件有 gzip 头就是 gzip。
 */
async function sniffFormat(purpose: CheckPurpose, source: ByteSource): Promise<AssetFormat | null> {
  const head = await source.read(0, 16);
  switch (purpose) {
    case 'scan':
      if (startsWith(head, 'glTF')) return 'glb';
      if (startsWith(head, 'DRACO')) return 'drc';
      if (startsWith(head, 'PK')) return 'zip';
      return 'obj';
    case 'webmodel':
    case 'model':
      return 'glb';
    case 'texture':
      return sniffImage(head);
    case 'ops':
      return startsWith(head, [0x1f, 0x8b]) ? 'gzip' : 'ndjson';
    case 'script':
      return 'text';
    case 'bundle':
      return 'json';
  }
}

/** 按用途和格式选检查器（与 Rust `Inspector::new` 的表相同）。 */
async function inspect(
  purpose: CheckPurpose,
  format: AssetFormat | null,
  source: ByteSource,
): Promise<AssetCheck> {
  switch (purpose) {
    case 'scan':
      if (format === 'glb') return checkGlbLight(source, GLB_JSON_SCAN_BYTES);
      if (format === 'drc') return checkDraco(source);
      if (format === 'zip') return checkZip(source);
      return checkObj(source);
    case 'webmodel':
      return checkGlb(source, GLB_JSON_WEBMODEL_BYTES);
    case 'model':
      return checkGlb(source, GLB_JSON_MODEL_BYTES);
    case 'texture':
      return checkTexture(await readAll(source), (format ?? undefined) as ImageFormat | undefined);
    case 'ops':
      return checkOps(source, format === 'gzip');
    case 'script':
      return checkScript(source);
    case 'bundle':
      return checkBundleOuter(source);
  }
}

/**
 * 按用途检查一个文件，返回核对记录（不合规时抛出 CheckError）。`format` 是上传时声明的格式，不给就按
 * 内容认。检查通过以后再按 `limits`（工作区的 `limits.json` 或默认值）里这个用途的上限判断，超出是
 * `over_limit`——与服务端上传核对的规则相同（docs/design/server-slim.md 4.4–4.6）。
 */
export async function checkAsset(
  purpose: CheckPurpose,
  source: ByteSource,
  limits: UploadLimits,
  format?: AssetFormat,
): Promise<AssetCheck> {
  const max = limits[purpose].maxBytes;
  if (source.size < 1 || source.size > max) {
    reject('over_limit', `${source.size} 字节，${purpose} 用途要 1 到 ${max} 字节`);
  }
  if (format !== undefined && !PURPOSE_FORMATS[purpose].includes(format)) {
    reject('format_mismatch', `${purpose} 用途不收 ${format} 格式`);
  }
  const check = await inspect(purpose, format ?? (await sniffFormat(purpose, source)), source);
  const misfit = fits(PURPOSE_ROLE[purpose], check, limits);
  if (misfit !== null) reject('over_limit', misfit);
  return check;
}

/** 本地没有文件时按扩展名猜上传格式（复用探测用）；猜不出时返回 null。 */
export function uploadFormatFromPath(
  purpose: BundleFilePurpose,
  path: string,
): AssetCheck['format'] | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (purpose) {
    case 'scan':
      return ext === 'zip' || ext === 'glb' || ext === 'drc' || ext === 'obj' ? ext : null;
    case 'webmodel':
    case 'model':
      return ext === 'glb' ? 'glb' : null;
    case 'texture':
      return ext === 'png' || ext === 'webp'
        ? ext
        : ext === 'jpg' || ext === 'jpeg'
          ? 'jpeg'
          : null;
    case 'script':
      return 'text';
  }
}

function glbFits(glb: GlbCheck, limits: GlbLimits, what: string): string | null {
  if (glb.triangles === null || glb.bounds === null) {
    return `这个 glb 只做过扫描用途的轻量检查（没有三角形数和包围盒），不能当${what}`;
  }
  if (glb.triangles > limits.maxTriangles) {
    return `${what}有 ${glb.triangles} 个三角形，超过上限 ${limits.maxTriangles}`;
  }
  if (glb.maxTextureSide > limits.maxTextureSide) {
    return `${what}的贴图边长 ${glb.maxTextureSide} 超过上限 ${limits.maxTextureSide}`;
  }
  if (glb.texturePixels > limits.maxTexturePixels) {
    return `${what}的贴图像素合计 ${glb.texturePixels} 超过上限 ${limits.maxTexturePixels}`;
  }
  if (
    !aabbIsValid(glb.bounds) ||
    [...glb.bounds.min, ...glb.bounds.max].some((v) => Math.abs(v) > limits.maxCoord)
  ) {
    return `${what}的坐标超出 ±${limits.maxCoord} 米`;
  }
  const extension = glb.extensions.find((name) => !GLB_EXTENSIONS_USED.includes(name));
  if (extension !== undefined) return `${what}用了不支持的扩展 ${extension}`;
  return null;
}

/**
 * 一个核对记录能不能当某个角色用（与 Rust `check::fits` 相同，docs/design/server-slim.md 4.6）。
 * 能用时返回 null，否则返回说明。上限按 `limits`（当前配置）判断。
 */
export function fits(role: AssetRole, check: AssetCheck, limits: UploadLimits): string | null {
  const format = check.format;
  switch (role) {
    case 'scan':
      if (format === 'glb' || format === 'drc' || format === 'obj') return null;
      if (check.format === 'zip' && check.mesh !== '') return null;
      return `${format} 不能当原始扫描（要 glb、drc、obj 或带网格的 zip）`;
    case 'webModel':
    case 'model':
      if (check.format !== 'glb') return `${format} 不能当模型（要 glb）`;
      return role === 'webModel'
        ? glbFits(check, limits.webmodel, '网页用模型')
        : glbFits(check, limits.model, '物件模型');
    case 'texture': {
      if (check.format !== 'png' && check.format !== 'jpeg' && check.format !== 'webp') {
        return `${format} 不能当贴图（要 png、jpeg 或 webp）`;
      }
      const { width, height } = check;
      if (Math.max(width, height) > limits.texture.maxSide) {
        return `贴图 ${width}×${height} 超过边长上限 ${limits.texture.maxSide}`;
      }
      if (width * height > limits.texture.maxPixels) {
        return `贴图 ${width}×${height} 超过像素上限 ${limits.texture.maxPixels}`;
      }
      return null;
    }
    case 'script':
      return format === 'text' ? null : `${format} 不能当文本`;
    case 'bundle':
      return format === 'json' ? null : `${format} 不能当重建包清单`;
    case 'ops':
      return format === 'ndjson' || format === 'gzip' ? null : `${format} 不能当操作文件`;
  }
}

/**
 * 模型按物件的 `transform`（只用 `yaw`、`pitch`、`roll`）绕原点转过之后的包围盒：模型包围盒的 8 个角点
 * 转过之后取外包（docs/SHAPES.md 第 3 节，与 Rust `check::rotated_model_bounds` 相同）。
 */
export function rotatedModelBounds(model: Aabb, transform?: Transform): Aabb {
  if (transform === undefined) return model;
  return transformAabb({ yaw: transform.yaw, pitch: transform.pitch, roll: transform.roll }, model);
}

/**
 * 只有模型、没有形状的物件：模型的实测包围盒与物件 `bounds` 一致（与 Rust `check::model_fits_entity` 相同，
 * docs/design/server-slim.md 2.5 第 5 条，docs/SHAPES.md 第 3 节）。原点在底面中心按模型自己的包围盒查
 * （`|min.y|`、x 和 z 的中点都不超过 2 厘米）；三边长按转过之后的包围盒（{@link rotatedModelBounds}）与
 * 物件 `bounds` 比，之差不超过 max(2 厘米, 物件边长的 1%)。一致时返回 null，否则返回说明。
 */
export function modelFitsEntity(model: Aabb, entity: Aabb, transform?: Transform): string | null {
  const centerX = (model.min[0] + model.max[0]) / 2;
  const centerZ = (model.min[2] + model.max[2]) / 2;
  if (
    Math.abs(model.min[1]) > MODEL_ORIGIN_TOLERANCE ||
    Math.abs(centerX) > MODEL_ORIGIN_TOLERANCE ||
    Math.abs(centerZ) > MODEL_ORIGIN_TOLERANCE
  ) {
    return '模型的原点要在底面中心（导出时把节点变换烘进顶点，原点放在底面中心）';
  }
  const rotated = rotatedModelBounds(model, transform);
  for (let axis = 0; axis < 3; axis += 1) {
    const modelSide = rotated.max[axis]! - rotated.min[axis]!;
    const entitySide = entity.max[axis]! - entity.min[axis]!;
    const tolerance = Math.max(MODEL_FIT_ABS, MODEL_FIT_REL * Math.abs(entitySide));
    if (Math.abs(modelSide - entitySide) > tolerance) {
      return (
        `模型的实测尺寸 ${modelSide.toFixed(3)} 米与物件 bounds 的 ${entitySide.toFixed(3)} 米` +
        `相差超过 ${tolerance.toFixed(3)} 米（第 ${['x', 'y', 'z'][axis]} 轴）`
      );
    }
  }
  return null;
}

/** 不带旋转的 {@link modelFitsEntity}（与 Rust `check::model_fits_bounds` 相同）。 */
export function modelFitsBounds(model: Aabb, entity: Aabb): string | null {
  return modelFitsEntity(model, entity);
}

/** 给人看的核对结果摘要（一行）。 */
export function describeCheck(check: AssetCheck): string {
  switch (check.format) {
    case 'glb':
      return check.triangles === null
        ? 'glb（轻量检查）'
        : `glb，${check.triangles} 个三角形，${check.images.length} 张贴图` +
            (check.images.length > 0 ? `（最大边长 ${check.maxTextureSide}）` : '');
    case 'png':
    case 'jpeg':
    case 'webp':
      return `${check.format} ${check.width}×${check.height}`;
    case 'zip':
      return `zip，网格成员 ${check.mesh}，共 ${check.members} 个成员`;
    default:
      return check.format;
  }
}
