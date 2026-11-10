import {
  CHECK_VERSION,
  reject,
  startsWith,
  view,
  type ImageCheck,
  type ImageFormat,
} from './types.js';

/**
 * 图片头（docs/design/server-slim.md 4.4、4.5 第 5 步，docs/SHAPES.md 第 8 节）：不解码图片，只读宽高。
 * 规则与接口服务的上传核对（Rust `runner/verify/image.rs`）相同：
 *
 * - PNG：签名后第一个块必须是 13 字节的 `IHDR`，读宽高；
 * - JPEG：从 `SOI` 起按段长度逐段跳过（EXIF、ICC、XMP 段多长都行），直到 `SOF0`–`SOF2` 拿宽高；先遇到
 *   图像数据（`SOS`）、图片结束（`EOI`）或走完这张图还没找到就拒绝；无损、分层、算术编码拒绝；
 * - WebP（只有贴图用途收）：`RIFF....WEBP` 之后读 `VP8 `、`VP8L`、`VP8X` 的头。
 *
 * 拒绝码：`image_header`（不是这三种图片、头不完整、宽或高是 0）、`image_mime_mismatch`（魔数与声明的
 * 格式或 glb 里的 `mimeType` 不符）、`jpeg_no_sof`、`jpeg_unsupported`。边长、像素的上限不在这里查
 * （检查通过以后按用途的上限判断，超出是 `over_limit`）。
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
  if (bytes.length < 24) reject('image_header', '图片头不完整，读不出宽高');
  if (!startsWith(bytes.subarray(8), [0, 0, 0, 13]) || !startsWith(bytes.subarray(12), 'IHDR')) {
    reject('image_header', 'PNG 的第一个块不是 IHDR');
  }
  const data = view(bytes);
  return [data.getUint32(16), data.getUint32(20)];
}

/** 无损（SOF3）、分层（SOF5–7）、算术编码（SOF9–11、SOF13–15）。 */
function unsupportedSof(marker: number): boolean {
  return (
    marker === 0xc3 ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function jpegSize(bytes: Uint8Array): [number, number] {
  const noSof = (): never =>
    reject('jpeg_no_sof', 'JPEG 里找不到宽高（SOF0–SOF2 段），或者文件不完整');
  let i = 2;
  for (;;) {
    if (i >= bytes.length) return noSof();
    if (bytes[i] !== 0xff) reject('image_header', 'JPEG 的段之间不是标记');
    i += 1;
    // 连续的 0xFF 是填充。
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) return noSof();
    const marker = bytes[i]!;
    i += 1;
    // 没有长度的标记：TEM、RSTn。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8) reject('image_header', 'JPEG 里出现了第二个 SOI');
    if (marker === 0xd9 || marker === 0xda) {
      reject('jpeg_no_sof', 'JPEG 在宽高（SOF 段）之前就开始了图像数据或结束了');
    }
    if (unsupportedSof(marker)) {
      reject('jpeg_unsupported', 'JPEG 用了浏览器普遍不支持的编码（无损、分层或算术编码）');
    }
    if (i + 2 > bytes.length) return noSof();
    const length = (bytes[i]! << 8) | bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) {
      // 长度 2 + 精度 1 + 高 2 + 宽 2。
      if (i + 7 > bytes.length) return noSof();
      if (length < 8) reject('image_header', 'JPEG 的 SOF 段长度不对');
      const data = view(bytes);
      return [data.getUint16(i + 5), data.getUint16(i + 3)];
    }
    if (length < 2) reject('image_header', 'JPEG 段长度不对');
    i += length;
  }
}

function webpSize(bytes: Uint8Array): [number, number] {
  if (bytes.length < 30) reject('image_header', '图片头不完整，读不出宽高');
  const data = view(bytes);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  switch (chunk) {
    case 'VP8X':
      return [1 + (data.getUint32(24, true) & 0xffffff), 1 + (data.getUint32(26, true) >>> 8)];
    case 'VP8L': {
      if (bytes[20] !== 0x2f) reject('image_header', 'WebP 无损格式的签名不对');
      const bits = data.getUint32(21, true);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    case 'VP8 ':
      if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)) {
        reject('image_header', 'WebP 有损格式的起始码不对');
      }
      return [data.getUint16(26, true) & 0x3fff, data.getUint16(28, true) & 0x3fff];
    default:
      return reject('image_header', 'WebP 里没有 VP8、VP8L 或 VP8X 块');
  }
}

/**
 * 读图片的格式和宽高。`expected` 是声明的格式（贴图上传声明的格式、glb 里的 `mimeType`），与魔数
 * 不符时拒绝；不给就按魔数认。
 */
export function imageSize(
  bytes: Uint8Array,
  expected?: ImageFormat,
): { format: ImageFormat; width: number; height: number } {
  const format = sniffImage(bytes);
  if (format === null) reject('image_header', '不是 PNG、JPEG 或 WebP 图片');
  if (expected !== undefined && expected !== format) {
    reject('image_mime_mismatch', `图片的实际格式是 ${format}，与声明的 ${expected} 不符`);
  }
  const [width, height] =
    format === 'png' ? pngSize(bytes) : format === 'jpeg' ? jpegSize(bytes) : webpSize(bytes);
  if (width === 0 || height === 0) reject('image_header', '图片的宽或高是 0');
  return { format, width, height };
}

/** 贴图用途的检查：魔数与声明的格式一致（不给就按魔数认），读到宽高。 */
export function checkTexture(bytes: Uint8Array, expected?: ImageFormat): ImageCheck {
  const { format, width, height } = imageSize(bytes, expected);
  return { v: CHECK_VERSION, format, width, height };
}
