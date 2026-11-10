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

/**
 * 高度场 → 切线空间法线贴图（SHAPES 2：OpenGL 约定，红 = +u，绿 = +v 即图片上方，`RGB = (n + 1) / 2`）。
 * 按周期取邻居，所以平铺时接缝处的法线也连续。`strength` 是高度差换成斜率的倍数。
 */
function normalFromHeight(
  size: number,
  height: (x: number, y: number) => number,
  strength: number,
): Uint8Array {
  const h = (x: number, y: number) =>
    height(((x % size) + size) % size, ((y % size) + size) % size);
  return render(size, (x, y) => {
    const du = (h(x + 1, y) - h(x - 1, y)) / 2;
    // 图片的行从上往下，v 向上：沿 v 的变化是"上一行减下一行"。
    const dv = (h(x, y - 1) - h(x, y + 1)) / 2;
    const nx = -strength * du;
    const ny = -strength * dv;
    const length = Math.hypot(nx, ny, 1);
    return [(nx / length + 1) * 127.5, (ny / length + 1) * 127.5, (1 / length + 1) * 127.5];
  });
}

/** 地砖贴图的格子边长（像素）：128 像素一张图 4 × 4 块。 */
const CHECKER_CELL = 32;

/** 到最近一条砖缝的距离（像素）。 */
function checkerGrout(x: number, y: number): number {
  const fx = x % CHECKER_CELL;
  const fy = y % CHECKER_CELL;
  return Math.min(fx, CHECKER_CELL - 1 - fx, fy, CHECKER_CELL - 1 - fy);
}

function checkerLight(x: number, y: number): boolean {
  return (Math.floor(x / CHECKER_CELL) + Math.floor(y / CHECKER_CELL)) % 2 === 0;
}

/**
 * 深浅相间的方地砖（材质样板的地面）：一张图 4 × 4 块，每块是正方形。按米平铺时砖应该是正方形，
 * 拉伸了一眼就看得出来。
 */
export function checkerTexture(): Uint8Array {
  const rand = random(61);
  const noise = Array.from({ length: 128 * 128 }, () => rand());
  return render(128, (x, y) => {
    if (checkerGrout(x, y) < 1) return [96, 90, 84];
    const t = 0.95 + noise[y * 128 + x]! * 0.05;
    return checkerLight(x, y) ? [226 * t, 216 * t, 198 * t] : [150 * t, 128 * t, 106 * t];
  });
}

/** 地砖的法线贴图：砖面平，砖缝凹下去，边缘 3 像素倒角。 */
export function checkerNormalTexture(): Uint8Array {
  return normalFromHeight(128, (x, y) => Math.min(1, checkerGrout(x, y) / 3), 2);
}

/** 地砖的粗糙度贴图（G 通道，白 = 粗糙）：浅色砖较光，深色砖次之，砖缝最粗糙。 */
export function checkerRoughnessTexture(): Uint8Array {
  return render(128, (x, y) => {
    const value = checkerGrout(x, y) < 1 ? 255 : checkerLight(x, y) ? 150 : 200;
    return [value, value, value];
  });
}

/** 到最近一道灰缝的距离（像素）：一张图 4 行砖，每行两块，隔行错开半块。 */
function brickMortar(x: number, y: number): number {
  const shift = Math.floor(y / 32) % 2 === 0 ? 0 : 32;
  const fx = (x + shift) % 64;
  const fy = y % 32;
  return Math.min(fx, 63 - fx, fy, 31 - fy);
}

/** 清水砖墙（材质样板的墙）：每块砖宽是高的两倍。 */
export function brickWallTexture(): Uint8Array {
  const rand = random(71);
  const noise = Array.from({ length: 128 * 128 }, () => rand());
  const shade = Array.from({ length: 8 }, () => 0.82 + rand() * 0.2);
  return render(128, (x, y) => {
    if (brickMortar(x, y) < 2) return [206, 200, 188];
    const row = Math.floor(y / 32);
    const brick = Math.floor((x + (row % 2 === 0 ? 0 : 32)) / 64) % 2;
    const t = shade[row * 2 + brick]! * (0.92 + noise[y * 128 + x]! * 0.08);
    return [176 * t, 92 * t, 66 * t];
  });
}

/** 砖墙的法线贴图：灰缝凹下去。 */
export function brickNormalTexture(): Uint8Array {
  return normalFromHeight(128, (x, y) => Math.min(1, brickMortar(x, y) / 3), 2.5);
}

/** 拉毛墙面的法线贴图：几组周期正好是图片边长整数分之一的起伏，平铺时没有接缝。 */
export function plasterNormalTexture(): Uint8Array {
  const a = (2 * Math.PI) / 64;
  return normalFromHeight(
    64,
    (x, y) =>
      0.5 * Math.sin(a * 3 * x) * Math.cos(a * 2 * y) +
      0.3 * Math.sin(a * 5 * (x + y)) +
      0.2 * Math.cos(a * 7 * x - a * 4 * y),
    3,
  );
}

/** 木箱（物件模型里内嵌的贴图）：横向木板，四周深色的框。 */
export function crateTexture(): Uint8Array {
  const rand = random(83);
  const noise = Array.from({ length: 64 }, () => rand());
  return render(64, (x, y) => {
    const edge = Math.min(x, 63 - x, y, 63 - y);
    if (edge < 5) return [104, 70, 44];
    const plank = Math.floor(y / 11);
    const grain = Math.sin((x + noise[(y * 3 + plank) % 64]! * 8) * 0.4) * 0.06;
    const t = (y % 11 === 0 ? 0.7 : 0.94) + grain + noise[plank % 64]! * 0.08;
    return [196 * t, 150 * t, 98 * t];
  });
}
