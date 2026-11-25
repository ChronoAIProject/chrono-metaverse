import * as THREE from 'three';
import atlasUrl from '../assets/geography/facades.webp';

const columns = 3;
const rows = 6;
const layers = columns * rows;

/** Wall and roof finishes. The alpha channel distinguishes glazing from cladding. */
function loadFinishes() {
  const map = { value: null as THREE.DataArrayTexture | null };
  const ready = { value: false };
  const bank = { map, ready, references: 0 };
  new THREE.ImageLoader().load(atlasUrl, (image: HTMLImageElement) => {
    const side = image.width / columns;
    if (!bank.references || !Number.isInteger(side) || image.height !== side * rows) return;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const layerPixels = new Uint8Array(pixels.length);
    const rowBytes = side * 4;
    for (let layer = 0; layer < layers; layer++) {
      const firstPixel =
        Math.floor(layer / columns) * side * image.width + (layer % columns) * side;
      for (let y = 0; y < side; y++) {
        const source = (firstPixel + y * image.width) * 4;
        layerPixels.set(pixels.subarray(source, source + rowBytes), (layer * side + y) * rowBytes);
      }
    }
    const atlas = new THREE.DataArrayTexture(layerPixels, side, side, layers);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.wrapS = atlas.wrapT = THREE.RepeatWrapping;
    atlas.magFilter = THREE.LinearFilter;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.generateMipmaps = true;
    atlas.anisotropy = 4;
    atlas.name = 'Building facade finishes';
    atlas.needsUpdate = true;
    map.value = atlas;
    ready.value = true;
  });
  return bank;
}

let shared: ReturnType<typeof loadFinishes> | undefined;

export function buildingFinishUniforms(material: THREE.Material) {
  const bank = (shared ??= loadFinishes());
  bank.references++;
  const release = () => {
    material.removeEventListener('dispose', release);
    if (--bank.references === 0) {
      bank.map.value?.dispose();
      shared = undefined;
    }
  };
  material.addEventListener('dispose', release);
  return { buildingFinishes: bank.map, buildingFinishesReady: bank.ready };
}

export const buildingFinishShader = /* glsl */ `
  uniform highp sampler2DArray buildingFinishes;
  uniform bool buildingFinishesReady;
  // Retain the physical floor pitch even where multiple floors share a belt or pier.
  const vec2 finishSpan[18] = vec2[18](
    vec2(18.0,21.6), vec2(17.4,21.0), vec2(22.4,27.2), vec2(20.0,26.4), vec2(27.0,34.0),
    vec2(15.0,3.55), vec2(14.4,3.55), vec2(6.4,5.0), vec2(3.4), vec2(5.5), vec2(16.2,3.55),
    vec2(14.4,3.55), vec2(18.0,28.4), vec2(24.0,24.85), vec2(25.2,31.95), vec2(21.6,28.4),
    vec2(18.4,21.3), vec2(21.0,28.4));
  // Punched-window, ribbon and curtain-wall buildings each draw from their own palette.
  const int wallLayers[18] = int[18](
    0, 12, 14, 16, 1, 13,    2, 17, 12, 15, 1, 14,    3, 4, 15, 13, 17, 2);
  vec4 buildingFinish(vec3 pos, vec2 tangent, float style) {
    float seed = fract(style);
    int index;
    if (style >= 3.0) {
      int frontage = int(seed * 4.0);
      index = frontage < 2 ? 5 + frontage : 8 + frontage;
    } else {
      index = wallLayers[int(floor(style)) * 6 + int(seed * 6.0)];
    }
    vec2 metres = vec2(dot(pos.xz,tangent),pos.y);
    vec4 sampleColor = texture(buildingFinishes,vec3(metres / finishSpan[index] + vec2(fract(17.0*seed),0.0),float(index)));
    sampleColor.a = clamp((sampleColor.a * 255.0 - 128.0) / 127.0, 0.0, 1.0);
    return sampleColor;
  }
  vec3 buildingRoof(vec2 metres, float seed, float lowRise) {
    float index = seed < .36 ? 7.0 : 9.0;
    if (lowRise > .5 && seed > .62) index = 8.0;
    vec2 repeatSize = index == 7.0 ? vec2(6.4,5.0) : (index == 8.0 ? vec2(3.4,3.4) : vec2(5.5));
    return texture(buildingFinishes,vec3(metres / repeatSize,index)).rgb;
  }
`;
