import * as THREE from 'three';

/** Display panoramas and their measured, scene-linear counterparts share the same orientation. */
export const skyRadiance = new WeakMap<THREE.Texture, THREE.DataTexture>();

export function decodeSkyRadiance(source: THREE.Texture, scale: number): THREE.DataTexture | null {
  const image = source.image;
  if (!(image instanceof HTMLImageElement) || !image.naturalWidth || !image.naturalHeight)
    return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(512, image.naturalWidth);
  canvas.height = Math.max(1, Math.round(canvas.width / 2));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const lookup = new Uint16Array(256);
  const color = new THREE.Color();
  for (let i = 0; i < lookup.length; i++) {
    color.setRGB(i / 255, 0, 0, THREE.SRGBColorSpace);
    lookup[i] = THREE.DataUtils.toHalfFloat(scale * color.r);
  }
  const pixels = new Uint16Array(data.length);
  const opaque = THREE.DataUtils.toHalfFloat(1);
  for (let i = 0; i < data.length; i += 4) {
    pixels[i] = lookup[data[i]!]!;
    pixels[i + 1] = lookup[data[i + 1]!]!;
    pixels[i + 2] = lookup[data[i + 2]!]!;
    pixels[i + 3] = opaque;
  }
  const texture = new THREE.DataTexture(
    pixels,
    canvas.width,
    canvas.height,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.flipY = source.flipY;
  texture.wrapS = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
