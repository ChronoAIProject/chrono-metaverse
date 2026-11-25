import * as THREE from 'three';
import atlasUrl from '../assets/geography/facades.webp';

const layers = 10;

/** Wall and roof finishes. The alpha channel distinguishes glazing from cladding. */
function loadFinishes() {
  const map = { value: null as THREE.DataArrayTexture | null };
  const ready = { value: false };
  const bank = { map, ready, references: 0 };
  new THREE.ImageLoader().load(atlasUrl, (image: HTMLImageElement) => {
    if (!bank.references || image.height !== image.width * layers) return;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const atlas = new THREE.DataArrayTexture(
      new Uint8Array(pixels.buffer),
      image.width,
      image.width,
      layers,
    );
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
  vec4 buildingFinish(vec3 pos, vec2 tangent, float seed, float lowRise) {
    float index = min(4.0, floor(seed * 5.0));
    if (lowRise > .5) index = seed < .50 ? 5.0 : 6.0;
    vec2 size = vec2(18.0, 21.6);
    if (index == 1.0) size = vec2(17.4, 21.0);
    if (index == 2.0) size = vec2(22.4, 27.2);
    if (index == 3.0) size = vec2(20.0, 26.4);
    if (index == 4.0) size = vec2(27.0, 34.0);
    if (index == 5.0) size = vec2(13.8, 3.55);
    if (index == 6.0) size = vec2(12.6, 3.55);
    vec2 metres = vec2(dot(pos.xz,tangent),pos.y);
    vec4 sampleColor = texture(buildingFinishes,vec3(metres / size + vec2(fract(17.0*seed),0.0),index));
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
