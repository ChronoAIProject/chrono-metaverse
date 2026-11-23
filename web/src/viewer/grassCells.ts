/** Keep the original jittered cell IDs wherever the tile could produce visible grass. */
const linear = Float32Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});

export function grassCells(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  cells: number,
) {
  const stride = width + 1;
  const possible = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      const r = linear[pixels[i]!]!,
        g = linear[pixels[i + 1]!]!,
        b = linear[pixels[i + 2]!]!;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // The shader's first smoothstep vanishes below this threshold. The
      // affine expression stays negative under bilinear interpolation if all
      // contributing texels fail it. Allow slack for GPU sRGB precision.
      if (g - b >= 0.18 * luminance - 0.001) count++;
      const next = (y + 1) * stride + x + 1;
      possible[next] = possible[next - stride]! + count;
    }
  }
  const selected = new Uint16Array(cells * cells);
  let count = 0;
  for (let row = 0; row < cells; row++) {
    // The uploaded ImageBitmap is already flipped. Read its stored rows in
    // the same order as textureLod(imagery, vec2(uv.x, 1.0 - uv.y), 0.0).
    const bottom = Math.max(0, Math.floor((1 - (row + 1) / cells) * height) - 1) * stride;
    const top = Math.min(height, Math.ceil((1 - row / cells) * height) + 1) * stride;
    for (let col = 0; col < cells; col++) {
      const left = Math.max(0, Math.floor((col / cells) * width) - 1);
      const right = Math.min(width, Math.ceil(((col + 1) / cells) * width) + 1);
      const hits =
        possible[top + right]! -
        possible[top + left]! -
        possible[bottom + right]! +
        possible[bottom + left]!;
      if (hits > 0) selected[count++] = row * cells + col;
    }
  }
  return selected.slice(0, count);
}

let context: CanvasRenderingContext2D | null = null;
const cached = new WeakMap<ImageBitmap, { cells: number; selected: Uint16Array }>();

export function tileGrassCells(bitmap: ImageBitmap, cells: number) {
  // Limit synchronous readback work on the first frame near a large custom tile.
  if (bitmap.width * bitmap.height > 512 * 512) return null;
  const existing = cached.get(bitmap);
  if (existing?.cells === cells) return existing.selected;
  try {
    context ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    const { width, height } = bitmap;
    if (context.canvas.width !== width) context.canvas.width = width;
    if (context.canvas.height !== height) context.canvas.height = height;
    context.globalCompositeOperation = 'copy';
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    const selected = grassCells(pixels, width, height, cells);
    cached.set(bitmap, { cells, selected });
    return selected;
  } catch {
    // Browsers with restricted canvas readback can still draw the full grid.
    context = null;
    return null;
  }
}
