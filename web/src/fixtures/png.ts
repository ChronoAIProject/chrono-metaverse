import { zlibSync } from 'fflate';

/**
 * 夹具用的小贴图：程序生成像素，编码成 PNG（RGB，8 位，无隔行）。
 * 只在夹具模式和测试里用，结果是确定的。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGB 像素（行优先，从上到下）→ PNG 字节。 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0; // 过滤方式：无
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // 位深
  header[9] = 2; // RGB
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 确定性伪随机数（mulberry32）。 */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pixel = (x: number, y: number) => readonly [number, number, number];

function render(size: number, pixel: Pixel): Uint8Array {
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y);
      const i = (y * size + x) * 3;
      rgb[i] = Math.max(0, Math.min(255, Math.round(r)));
      rgb[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgb[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  return encodePng(size, size, rgb);
}

/** 木纹：沿 v 方向的年轮条纹加噪声。 */
export function woodTexture(): Uint8Array {
  const rand = random(11);
  const noise = Array.from({ length: 64 }, () => rand());
  return render(64, (x, y) => {
    const ring = Math.sin((x + noise[y % 64]! * 6 + Math.sin(y / 9) * 3) * 0.55) * 0.5 + 0.5;
    const grain = noise[(x * 7 + y) % 64]! * 0.12;
    const t = 0.72 + ring * 0.22 + grain;
    return [150 * t, 102 * t, 64 * t];
  });
}

/** 布纹：经纬交织的方格。 */
export function fabricTexture(): Uint8Array {
  return render(32, (x, y) => {
    const warp = x % 4 < 2 !== y % 4 < 2;
    const t = warp ? 1 : 0.86;
    const stripe = y % 16 === 0 ? 0.8 : 1;
    return [220 * t * stripe, 222 * t * stripe, 226 * t * stripe];
  });
}

/** 地砖：浅色石材，深色勾缝（一张图四块砖）。 */
export function tileTexture(): Uint8Array {
  const rand = random(23);
  const noise = Array.from({ length: 128 * 128 }, () => rand());
  return render(128, (x, y) => {
    const grout = x % 64 < 2 || y % 64 < 2;
    if (grout) return [120, 112, 100];
    const tile = (Math.floor(x / 64) + Math.floor(y / 64)) % 2;
    const t = (tile ? 0.97 : 0.9) + noise[y * 128 + x]! * 0.06;
    return [218 * t, 204 * t, 178 * t];
  });
}

/** 地砖贴图上一个点离最近的勾缝有多远（像素；勾缝在每 64 像素的前 2 像素）。 */
function groutDistance(x: number, y: number): number {
  const along = (p: number) => {
    const q = p % 64;
    return q < 2 ? 0 : Math.min(q - 1, 64 - q);
  };
  return Math.min(along(x), along(y));
}

/** 砖面边缘的倒角宽度（像素）：从勾缝往里这么宽的一圈是斜面，再往里是平的。 */
const BEVEL = 6;

/** 地砖的高度场：勾缝 0，倒角斜坡升到 1，砖面平的。 */
function tileHeight(x: number, y: number): number {
  return Math.min(1, groutDistance(x, y) / BEVEL);
}

/**
 * 地砖的法线贴图（与 `tileTexture` 对齐）：切线空间、OpenGL 约定（红 = +u，绿 = +v = 图片上方），
 * `RGB = (n + 1) / 2`，线性数据（docs/SHAPES.md 第 2 节"法线贴图"）。勾缝凹下去，砖的四边是倒角。
 */
export function tileNormalTexture(): Uint8Array {
  const strength = BEVEL * 0.9;
  return render(128, (x, y) => {
    // 图片的行往下数，v 往上：对 v 的导数是对行号导数的相反数
    const dx = (tileHeight((x + 1) % 128, y) - tileHeight((x + 127) % 128, y)) / 2;
    const dv = -(tileHeight(x, (y + 1) % 128) - tileHeight(x, (y + 127) % 128)) / 2;
    const n = [-dx * strength, -dv * strength, 1];
    const length = Math.hypot(n[0]!, n[1]!, n[2]!);
    return [0, 1, 2].map((k) => ((n[k]! / length + 1) / 2) * 255) as [number, number, number];
  });
}

/** 地砖的粗糙度贴图（与 `tileTexture` 对齐，灰度，白 = 粗糙）：勾缝粗糙，砖面半光（不低于 0.5）。 */
export function tileRoughnessTexture(): Uint8Array {
  const rand = random(29);
  return render(128, (x, y) => {
    const t = groutDistance(x, y) < 2 ? 1 : 0.58 + rand() * 0.06;
    return [255 * t, 255 * t, 255 * t];
  });
}

/** 灯罩：竖条纹（圆柱投影时绕一圈）。 */
export function stripeTexture(): Uint8Array {
  return render(64, (x) => {
    const on = Math.floor(x / 8) % 2 === 0;
    return on ? [246, 236, 210] : [214, 160, 92];
  });
}

/** 红砖（方块侧面）：错缝砌法。 */
export function brickTexture(): Uint8Array {
  const rand = random(31);
  const noise = Array.from({ length: 32 * 32 }, () => rand());
  return render(32, (x, y) => {
    const row = Math.floor(y / 8);
    const shift = row % 2 === 0 ? 0 : 8;
    const mortar = y % 8 === 0 || (x + shift) % 16 === 0;
    if (mortar) return [196, 190, 178];
    const t = 0.85 + noise[y * 32 + x]! * 0.25;
    return [168 * t, 74 * t, 52 * t];
  });
}

/** 草地（方块顶面）。 */
export function grassTexture(): Uint8Array {
  const rand = random(41);
  return render(32, () => {
    const t = 0.75 + rand() * 0.4;
    return [86 * t, 150 * t, 64 * t];
  });
}

/** 大理石纹（草稿预览里新上传的贴图）。 */
export function marbleTexture(): Uint8Array {
  const rand = random(53);
  const noise = Array.from({ length: 64 }, () => rand());
  return render(64, (x, y) => {
    const vein = Math.abs(Math.sin((x + y) * 0.18 + noise[(x + y * 3) % 64]! * 2.5));
    const t = vein < 0.12 ? 0.62 : 0.94 + noise[(x * 5 + y) % 64]! * 0.05;
    return [236 * t, 232 * t, 226 * t];
  });
}
