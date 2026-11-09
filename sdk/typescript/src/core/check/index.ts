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
import { checkGlb, checkGlbLight } from './glb.js';
import { checkTexture } from './image.js';
import {
  CHECK_VERSION,
  reject,
  startsWith,
  utf8,
  type AssetCheck,
  type ByteSource,
  type GlbCheck,
} from './types.js';
import { checkZip } from './zip.js';

/**
 * 资源核对的命令行实现（docs/design/server-slim.md 4.4–4.6，docs/SHAPES.md 第 8 节）：按用途检查本地文件，
 * 算出与服务端相同的核对记录 `check`，再按角色判断（{@link fits}）和"模型与记录一致"（{@link modelFitsBounds}）。
 * `metaverse bundle check` 用它在上传之前发现不合规的文件；服务端（Rust）的检查是权威。
 *
 * 拒绝码（`CheckError.code`）：
 *
 * - 共同：`too_large`（超过这个用途的大小上限）、`format`（扫描用途认不出格式）；
 * - glb：见 `glb.ts`；图片：`image_format`、`image_header`、`image_too_large`；zip：见 `zip.ts`；
 * - drc：`drc_header`（不是 `DRACO` 魔数、版本不认识、不是网格）；obj：`obj_header`（不是文本，或第一个
 *   关键字不认识）；文本：`text_encoding`（不是 UTF-8 或含 NUL）。
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

/** 清单 `files[].purpose` 对应的角色。 */
export const PURPOSE_ROLE: Readonly<Record<BundleFilePurpose, AssetRole>> = {
  scan: 'scan',
  webmodel: 'webModel',
  model: 'model',
  texture: 'texture',
  script: 'script',
};

const OBJ_KEYWORDS = new Set([
  'v',
  'vt',
  'vn',
  'vp',
  'f',
  'l',
  'p',
  'o',
  'g',
  's',
  'mtllib',
  'usemtl',
]);

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

async function checkDraco(source: ByteSource): Promise<AssetCheck> {
  const head = await source.read(0, 11);
  // DRACO、主版本、次版本、编码类型（0 点云，1 三角网格）。
  if (head.length < 11 || !startsWith(head, 'DRACO')) reject('drc_header', '不是 Draco 文件');
  if (head[5] !== 1 && head[5] !== 2) reject('drc_header', `Draco 主版本 ${head[5]} 不认识`);
  if (head[7] !== 1) reject('drc_header', 'Draco 文件不是三角网格（是点云）');
  return { v: CHECK_VERSION, format: 'drc' };
}

async function checkObj(source: ByteSource): Promise<AssetCheck> {
  const head = await source.read(0, 64 * 1024);
  if (head.includes(0)) reject('obj_header', 'OBJ 必须是文本');
  // 读到的一段可能截断在多字节字符中间：只看完整的行。
  const text = new TextDecoder('utf-8').decode(head);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!OBJ_KEYWORDS.has(trimmed.split(/\s+/)[0]!)) {
      reject('obj_header', `OBJ 的第一个关键字 ${trimmed.split(/\s+/)[0]} 不认识`);
    }
    return { v: CHECK_VERSION, format: 'obj' };
  }
  return reject('obj_header', 'OBJ 的开头 64 KiB 里没有内容');
}

/** 扫描用途：按魔数认 glb（轻量检查）、drc、zip，其余按 obj 文本检查。 */
async function checkScan(source: ByteSource): Promise<AssetCheck> {
  const head = await source.read(0, 8);
  if (startsWith(head, 'glTF')) return checkGlbLight(source, GLB_JSON_SCAN_BYTES);
  if (startsWith(head, 'DRACO')) return checkDraco(source);
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return checkZip(source);
  if (startsWith(head, [0x50, 0x4b])) reject('format', 'zip 文件的第一个成员不在文件开头');
  return checkObj(source);
}

async function readAll(source: ByteSource): Promise<Uint8Array> {
  const bytes = await source.read(0, source.size);
  if (bytes.length !== source.size) reject('format', '文件读不全');
  return bytes;
}

/**
 * 按用途检查一个文件，返回核对记录（不合规时抛出 CheckError）。上限取 `limits`（工作区的 `limits.json`
 * 或默认值），与服务端上传核对的规则相同（docs/design/server-slim.md 4.4）。
 */
export async function checkAsset(
  purpose: BundleFilePurpose,
  source: ByteSource,
  limits: UploadLimits,
): Promise<AssetCheck> {
  const max = limits[purpose].maxBytes;
  if (source.size < 1 || source.size > max) {
    reject('too_large', `${source.size} 字节，${purpose} 用途要 1 到 ${max} 字节`);
  }
  switch (purpose) {
    case 'scan':
      return checkScan(source);
    case 'webmodel':
      return checkGlb(source, limits.webmodel, GLB_JSON_WEBMODEL_BYTES);
    case 'model':
      return checkGlb(source, limits.model, GLB_JSON_MODEL_BYTES);
    case 'texture':
      return checkTexture(await readAll(source), limits.texture);
    case 'script': {
      const bytes = await readAll(source);
      if (bytes.includes(0) || utf8(bytes) === null) {
        reject('text_encoding', '建模记录必须是 UTF-8 文本，不含 NUL');
      }
      return { v: CHECK_VERSION, format: 'text' };
    }
  }
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
 * 只有模型、没有形状的物件：模型的实测包围盒与物件 `bounds` 一致（与 Rust `check::model_fits_bounds` 相同，
 * docs/design/server-slim.md 2.5 第 5 条）。三边长之差不超过 max(2 厘米, 物件边长的 1%)，模型原点在底面中心
 * （`|min.y|`、x 和 z 的中点都不超过 2 厘米）。一致时返回 null，否则返回说明。
 */
export function modelFitsBounds(model: Aabb, entity: Aabb): string | null {
  for (let axis = 0; axis < 3; axis += 1) {
    const modelSide = model.max[axis]! - model.min[axis]!;
    const entitySide = entity.max[axis]! - entity.min[axis]!;
    const tolerance = Math.max(MODEL_FIT_ABS, MODEL_FIT_REL * Math.abs(entitySide));
    if (Math.abs(modelSide - entitySide) > tolerance) {
      return (
        `模型的实测尺寸 ${modelSide.toFixed(3)} 米与物件 bounds 的 ${entitySide.toFixed(3)} 米` +
        `相差超过 ${tolerance.toFixed(3)} 米（第 ${['x', 'y', 'z'][axis]} 轴）`
      );
    }
  }
  const centerX = (model.min[0] + model.max[0]) / 2;
  const centerZ = (model.min[2] + model.max[2]) / 2;
  if (
    Math.abs(model.min[1]) > MODEL_ORIGIN_TOLERANCE ||
    Math.abs(centerX) > MODEL_ORIGIN_TOLERANCE ||
    Math.abs(centerZ) > MODEL_ORIGIN_TOLERANCE
  ) {
    return '模型的原点要在底面中心（导出时把节点变换烘进顶点，原点放在底面中心）';
  }
  return null;
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
