import { surfaceNoise } from './surfaceVariation';
import * as THREE from 'three';
import atlasUrl from '../assets/geography/facades.webp';

const columns = 4;
const rows = 7;
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
  ${surfaceNoise}
  uniform highp sampler2DArray buildingFinishes;
  uniform bool buildingFinishesReady;
  // Retain the physical floor pitch even where multiple floors share a belt or pier.
  const vec2 finishSpan[28] = vec2[28](
    vec2(18.0,21.6), vec2(17.4,21.0), vec2(22.4,27.2), vec2(20.0,26.4), vec2(27.0,34.0),
    vec2(15.0,3.55), vec2(14.4,3.55), vec2(6.4,5.0), vec2(3.4), vec2(5.5), vec2(16.2,3.55),
    vec2(14.4,3.55), vec2(18.0,28.4), vec2(24.0,24.85), vec2(25.2,31.95), vec2(21.6,28.4),
    vec2(18.4,21.3), vec2(21.0,28.4), vec2(14.4,28.4), vec2(18.0,21.3),
    vec2(24.0,20.4), vec2(28.8,28.4), vec2(24.0,29.6), vec2(21.6,28.4),
    vec2(25.6,28.4), vec2(24.0,28.4), vec2(21.6,21.3), vec2(30.0,28.4));
  // Punched-window, ribbon and curtain-wall buildings each draw from their own palette.
  const int wallLayers[48] = int[48](
     0, 12, 14, 16,  1, 13, 20, 23, 19, 21,  4, 18, 24, 25, 26, 27,
     2, 17, 12, 15,  1, 14, 21, 18, 20, 22,  0, 23, 27, 24, 25, 26,
     3,  4, 15, 13, 17,  2, 22, 19, 23, 18, 16, 21, 26, 27, 24, 25);
  // Bays and storeys in the authored wall sheets. Scan and roof layers have no room mask.
  const vec2 roomGrid[16] = vec2[16](
    vec2(4,8), vec2(8,7), vec2(6,9), vec2(6,8), vec2(4,6), vec2(5,8), vec2(0), vec2(0),
    vec2(6,6), vec2(8,8), vec2(8,8), vec2(6,8), vec2(8,8), vec2(10,8), vec2(8,6), vec2(12,8));

  uint suiteHash(ivec2 suite, uint seed) {
    uint h = uint(suite.x) * 1597334677u ^ uint(suite.y) * 3812015801u ^ seed;
    h = (h ^ (h >> 16u)) * 2246822519u;
    return h ^ (h >> 13u);
  }

  vec3 roomDaylight(vec3 colour, float glazing, vec2 rooms, float seed) {
    ivec2 cell = ivec2(floor(rooms));
    uint key = uint(seed * 1024.0);
    uint row = suiteHash(ivec2(0, cell.y), key);
    // Adjoining panes share a tenant. Each floor starts at a different bay and uses its own suite width.
    float span = 2.0 + float(row % 4u);
    int suite = int(floor((float(cell.x) + float((row >> 3u) % 5u)) / span));
    uint state = suiteHash(ivec2(suite, cell.y), key);
    float light = .73 + .45 * float(state & 255u) / 255.0;
    float drop = ((state >> 8u) & 255u) < 108u ? .2 + .77 * float((state >> 16u) & 255u) / 255.0 : 0.0;
    vec2 pixel = max(fwidth(rooms),vec2(.001));
    float blind = drop > 0.0 ? smoothstep(1.0-drop-.5*pixel.y,1.0-drop+.5*pixel.y,fract(rooms.y)) : 0.0;
    vec3 fabric = mix(vec3(.24,.27,.26),vec3(.40,.37,.29),float((state >> 24u) & 255u)/255.0);
    vec3 interior = mix(colour * light, .57 * colour + .43 * fabric, blind);
    // Filter toward the mean covered glass once a pixel spans a suite or an entire storey.
    float resolved = 1.0 - smoothstep(.35,1.5,max(pixel.x/span,pixel.y));
    vec3 meanRoom = .88 * colour + .026 * vec3(1.0,1.0,.92);
    return mix(colour,mix(meanRoom,interior,resolved),glazing);
  }

  vec4 buildingFinish(vec3 pos, vec2 tangent, float style) {
    float seed = fract(style);
    int index;
    if (style >= 3.0) {
      int frontage = int(seed * 4.0);
      index = frontage < 2 ? 5 + frontage : 8 + frontage;
    } else {
      // Keep material selection stable for stacked sections with the same footprint seed.
      int slot = int(seed * 1024.0) % 16;
      index = wallLayers[int(floor(style)) * 16 + slot];
    }
    vec2 metres = vec2(dot(pos.xz,tangent),pos.y);
    vec2 uv = metres / finishSpan[index] + vec2(fract(17.0*seed),0.0);
    vec4 sampleColor = texture(buildingFinishes,vec3(uv,float(index)));
    sampleColor.a = clamp((sampleColor.a * 255.0 - 128.0) / 127.0, 0.0, 1.0);
    if (index >= 12 && index != 18 && index != 19) {
      sampleColor.rgb = roomDaylight(sampleColor.rgb,sampleColor.a,uv*roomGrid[index-12],seed);
    }
    return sampleColor;
  }
  vec3 buildingRoof(vec2 metres, float seed, float lowRise) {
    float index = seed < .36 ? 7.0 : 9.0;
    if (lowRise > .5 && seed > .62) index = 8.0;
    vec2 repeatSize = index == 7.0 ? vec2(6.4,5.0) : (index == 8.0 ? vec2(3.4,3.4) : vec2(5.5));
    vec2 phase = vec2(fract(seed*13.0),fract(seed*39.0));
    // Give each roof one laying direction, shared by all sheet and slate courses.
    mat2 turn = fract(seed*23.) < .5 ? mat2(0.,1.,-1.,0.) : mat2(1.);
    vec2 uv = turn*metres/repeatSize+phase;
    float patches = surfaceField(metres*.10+phase*27.0);
    vec3 roof = texture(buildingFinishes,vec3(uv,index)).rgb;
    if (index == 9.0) {
      vec3 concrete = texture(buildingFinishes,vec3(uv+vec2(.43,.62),index)).rgb;
      roof = mix(roof,concrete,smoothstep(.27,.72,patches));
    }
    float wear = .68*patches+.32*surfaceField(metres*.34+phase);
    return roof*(vec3(1.)+(wear-.5)*vec3(.66,.55,.43));
  }
`;
