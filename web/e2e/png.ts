import { inflateSync } from 'node:zlib';

/**
 * 端到端测试用的最小 PNG 解码（8 位 RGB / RGBA，不隔行）：读 Playwright 的截图，
 * 统计画面的亮度和颜色数，判断三维场景真的画出了东西（不是全黑、不是一片纯色）。
 */
export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Uint8Array;
}

export function decodePng(buffer: Buffer): DecodedPng {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('只支持 8 位、不隔行的 PNG');
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (channels === 0) throw new Error(`不支持的颜色类型 ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      let value = line[x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** 中央一半区域里：亮像素（亮度 > 60）的比例和不同颜色（每通道取高 4 位）的数量。 */
export function imageStats(png: DecodedPng): { brightRatio: number; colors: number } {
  const { width, height, channels, pixels } = png;
  let bright = 0;
  let total = 0;
  const colors = new Set<number>();
  for (let y = Math.floor(height / 4); y < Math.floor((height * 3) / 4); y += 2) {
    for (let x = Math.floor(width / 4); x < Math.floor((width * 3) / 4); x += 2) {
      const i = (y * width + x) * channels;
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      if (0.2126 * r + 0.7152 * g + 0.0722 * b > 60) bright += 1;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      total += 1;
    }
  }
  return { brightRatio: bright / Math.max(1, total), colors: colors.size };
}

/**
 * 整幅画面里亮像素（亮度 > threshold）的比例。深色主题下背景（亮度约 10）和地面网格线
 * （约 35）都比阈值暗，房间（地面、墙、家具）比阈值亮，所以这个比例近似"房间占画面多少"。
 */
export function brightCoverage(png: DecodedPng, threshold = 45): number {
  const { width, height, channels, pixels } = png;
  let bright = 0;
  let total = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * channels;
      const luma = 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
      if (luma > threshold) bright += 1;
      total += 1;
    }
  }
  return bright / Math.max(1, total);
}

/** 以 (x, y)（像素）为中心、边长 2·radius + 1 的方块里的平均颜色 [r, g, b]（0–255）。 */
export function patchColor(
  png: DecodedPng,
  x: number,
  y: number,
  radius = 3,
): [number, number, number] {
  const { width, height, channels, pixels } = png;
  const sum = [0, 0, 0];
  let count = 0;
  for (let py = Math.round(y) - radius; py <= Math.round(y) + radius; py += 1) {
    for (let px = Math.round(x) - radius; px <= Math.round(x) + radius; px += 1) {
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const i = (py * width + px) * channels;
      for (let k = 0; k < 3; k += 1) sum[k]! += pixels[i + k]!;
      count += 1;
    }
  }
  return sum.map((v) => (count === 0 ? 0 : v / count)) as [number, number, number];
}

/** 以 (x, y)（像素）为中心、边长 2·radius + 1 的方块里的平均亮度（0–255）；超出画面的部分不算。 */
export function patchLuma(png: DecodedPng, x: number, y: number, radius = 3): number {
  const { width, height, channels, pixels } = png;
  let sum = 0;
  let count = 0;
  for (let py = Math.round(y) - radius; py <= Math.round(y) + radius; py += 1) {
    for (let px = Math.round(x) - radius; px <= Math.round(x) + radius; px += 1) {
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const i = (py * width + px) * channels;
      sum += 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}
