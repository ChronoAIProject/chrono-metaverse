import type { ImageLimits } from '../limits.js';
import {
  CHECK_VERSION,
  reject,
  startsWith,
  view,
  type ImageCheck,
  type ImageFormat,
} from './types.js';

/**
 * 图片头（docs/design/server-slim.md 4.5 第 5 步，docs/SHAPES.md 第 8 节）：不解码图片，只读宽高。
 *
 * - PNG：签名后第一个块必须是 `IHDR`，读宽高；
 * - JPEG：从 `SOI` 起按段长度逐段跳过（EXIF、ICC、XMP 段多长都行），直到 `SOF0`–`SOF2` 拿宽高；
 *   碰到 `SOS`（图像数据开始）或走完这张图还没找到就拒绝；
 * - WebP（只有贴图用途收）：读 `VP8`、`VP8L`、`VP8X` 头。
 *
 * 拒绝码：`image_format`（魔数不是 png、jpeg、webp，或与声明的格式不符）、`image_header`（读不到宽高）、
 * `image_too_large`（超过边长或像素上限）。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 按魔数认格式；不是这三种时返回 null。 */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (bytes.length >= 12 && startsWith(bytes, 'RIFF') && startsWith(bytes.subarray(8), 'WEBP')) {
    return 'webp';
  }
  return null;
}

function pngSize(bytes: Uint8Array): [number, number] {
  if (bytes.length < 24 || !startsWith(bytes.subarray(12), 'IHDR')) {
    reject('image_header', 'PNG 的第一个块不是 IHDR，读不到宽高');
  }
  const data = view(bytes);
  return [data.getUint32(16), data.getUint32(20)];
}

function jpegSize(bytes: Uint8Array): [number, number] {
  const data = view(bytes);
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) reject('image_header', `JPEG 在第 ${i} 字节处不是段标记`);
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      // 填充字节。
      i += 1;
      continue;
    }
    // 没有长度的标记：SOI、TEM、RSTn。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = data.getUint16(i + 2);
    if (length < 2) reject('image_header', `JPEG 段长度不合法（第 ${i} 字节）`);
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (i + 9 > bytes.length) break;
      return [data.getUint16(i + 7), data.getUint16(i + 5)];
    }
    i += 2 + length;
  }
  return reject('image_header', 'JPEG 里找不到 SOF0–SOF2 段，读不到宽高');
}

function webpSize(bytes: Uint8Array): [number, number] {
  if (bytes.length < 30) reject('image_header', 'WebP 太短，读不到宽高');
  const data = view(bytes);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  switch (chunk) {
    case 'VP8X':
      return [1 + (data.getUint32(24, true) & 0xffffff), 1 + (data.getUint32(26, true) >>> 8)];
    case 'VP8L': {
      if (bytes[20] !== 0x2f) reject('image_header', 'WebP（VP8L）的签名不对');
      const bits = data.getUint32(21, true);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    case 'VP8 ':
      if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) {
        reject('image_header', 'WebP（VP8）的起始码不对');
      }
      return [data.getUint16(26, true) & 0x3fff, data.getUint16(28, true) & 0x3fff];
    default:
      return reject('image_header', `WebP 的第一个块 ${JSON.stringify(chunk)} 不认识`);
  }
}

/** 读图片的格式和宽高（宽高为 0 也算读不到）。 */
export function imageSize(
  bytes: Uint8Array,
  allowed: readonly ImageFormat[] = ['png', 'jpeg', 'webp'],
): { format: ImageFormat; width: number; height: number } {
  const format = sniffImage(bytes);
  if (format === null || !allowed.includes(format)) {
    reject('image_format', `文件头不是 ${allowed.join('、')} 图片`);
  }
  const [width, height] =
    format === 'png' ? pngSize(bytes) : format === 'jpeg' ? jpegSize(bytes) : webpSize(bytes);
  if (width === 0 || height === 0) reject('image_header', `图片宽高不合法（${width}×${height}）`);
  return { format, width, height };
}

/**
 * 贴图用途的检查：魔数与格式一致（`expected` 是声明的格式，不给就按魔数认），读到宽高，边长、像素在上限内。
 */
export function checkTexture(
  bytes: Uint8Array,
  limits: ImageLimits,
  expected?: ImageFormat,
): ImageCheck {
  const { format, width, height } = imageSize(bytes);
  if (expected !== undefined && expected !== format) {
    reject('image_format', `文件头是 ${format}，与声明的格式 ${expected} 不符`);
  }
  if (Math.max(width, height) > limits.maxSide) {
    reject('image_too_large', `贴图 ${width}×${height} 超过边长上限 ${limits.maxSide}`);
  }
  if (width * height > limits.maxPixels) {
    reject('image_too_large', `贴图 ${width}×${height} 超过像素上限 ${limits.maxPixels}`);
  }
  return { v: CHECK_VERSION, format, width, height };
}
