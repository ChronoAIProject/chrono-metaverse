import * as THREE from 'three';
import type { EntityBody } from '../core/api/types';
import type { StyleLook } from '../core/styles';

export function surfaceLook(look: StyleLook | undefined, entity: EntityBody, background: boolean) {
  if (!look?.hologram || !background || !entity.bounds) return look;
  const { min, max } = entity.bounds;
  const height = max[1] - min[1];
  const footprint = Math.max(max[0] - min[0], max[2] - min[2]);
  return (height >= 10 && height >= footprint * 0.12) ||
    (height >= 2.5 &&
      footprint >= 20 &&
      !!entity.props?.backgroundView &&
      !!entity.assetHash &&
      entity.kind === 'object')
    ? { ...look, hologram: 'facade' as const }
    : look;
}

type Surface = 'facade' | 'terrain' | 'detail';

// 在世界坐标中绘制玻璃分格。导数控制远景线宽和消隐，移动镜头时纹路固定在立面上。
const facade = /* glsl */ `
  vec3 p = holoPosition;
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  vec3 eye = normalize(cameraPosition - p);
  n *= dot(n, eye) < 0.0 ? -1.0 : 1.0;
  float upright = 1.0 - smoothstep(0.48, 0.93, abs(n.y));
  vec2 tangent = normalize(vec2(n.z + 0.00001, -n.x));
  vec2 glass = vec2(dot(p.xz, tangent) / 2.4, p.y / 3.6);
  vec2 cell = floor(glass);
  vec2 face = fract(glass);
  vec2 fw = clamp(fwidth(glass), vec2(0.003), vec2(1.0));
  vec2 border = min(face, 1.0 - face);
  vec2 bars = (1.0 - smoothstep(vec2(0.0), fw * 0.85 + vec2(0.012, 0.022), border))
    * (1.0 - smoothstep(vec2(0.18), vec2(0.64), fw));
  float seed = fract(sin(dot(floor(cell / vec2(3.0, 1.0)), vec2(23.17, 51.13))) * 4375.1);
  float windowLamp = smoothstep(0.88,0.98,seed) * smoothstep(0.06,0.23,border.x)
    * (1.0-smoothstep(0.035,0.13+fw.y,abs(face.y-0.69))) * (1.0-smoothstep(0.12,0.60,max(fw.x,fw.y)));
  float fresnel = pow(1.0 - abs(dot(eye, n)), 3.2);
  float orientation = smoothstep(-0.84,0.85,dot(n,normalize(vec3(-0.55,0.28,0.78))));
  vec3 reflection = reflect(-eye,n);
  float skyLine = exp(-4.5*abs(reflection.y+0.04));
  float sunset = pow(0.5+0.5*dot(normalize(reflection.xz+0.0001),normalize(vec2(0.82,-0.57))),3.0);
  vec3 glassColor = mix(vec3(0.006,0.010,0.030),vec3(0.012,0.045,0.072),orientation);
  glassColor += skyLine * mix(vec3(0.014,0.035,0.073),vec3(0.17,0.071,0.125),sunset);
  vec3 emission = mix(vec3(0.054,0.32,0.45),vec3(0.32,0.15,0.41),1.0-orientation);
  float lineDistance = abs(fract(glass.y/11.0 + 0.02) - 0.5)*11.0;
  float band = (1.0-smoothstep(0.018,0.055+fw.y*0.50,lineDistance)) * (1.0-smoothstep(0.3,1.0,fw.y));
  glassColor += upright * (emission*(0.12*bars.x + 0.14*bars.y + 1.55*band)
    + windowLamp*mix(vec3(0.16,0.27,0.32),vec3(0.68,0.33,0.14),step(0.955,seed)));
  glassColor += fresnel * mix(vec3(0.05,0.16,0.25),vec3(0.29,0.12,0.24),sunset);
  #ifdef USE_MAP
    vec3 mark = texture2D(map, vMapUv).rgb;
    float value = max(mark.r,max(mark.g,mark.b));
    float saturation = (value - min(mark.r,min(mark.g,mark.b))) / max(value,0.001);
    float contrast = smoothstep(0.045,0.55,value);
    // 烘焙的招牌与窗格共用一张图；保留高亮、高彩度细节及少量亮字。
    float signage = contrast * max(smoothstep(0.38,0.77,saturation),0.69*smoothstep(0.19,0.70,value));
    glassColor = mix(glassColor, mark * 1.1, signage);
  #endif
  outgoingLight = glassColor;
`;

const terrain = /* glsl */ `
  vec3 aerial = diffuseColor.rgb;
  float value = dot(aerial, vec3(0.24,0.58,0.18));
  float water = smoothstep(0.005,0.095,aerial.b-aerial.r);
  vec3 land = mix(vec3(0.008,0.019,0.036),vec3(0.085,0.098,0.132),sqrt(value));
  vec3 sea = mix(vec3(0.013,0.041,0.069),vec3(0.026,0.093,0.14),value);
  outgoingLight = mix(land,sea,water) + vec3(0.26,0.25,0.24)*smoothstep(0.48,0.9,value);
  float air = smoothstep(650.0,13000.0,length(cameraPosition-holoPosition));
  outgoingLight = mix(outgoingLight,vec3(0.34,0.27,0.36),air*0.92);
`;

const detail = /* glsl */ `
  float luma = dot(outgoingLight,vec3(0.24,0.60,0.16));
  outgoingLight = mix(outgoingLight, vec3(luma*0.75,luma*1.02,luma*1.15),0.22);
  outgoingLight += vec3(0.010,0.020,0.034)*diffuseColor.rgb;
`;

export function hologramMaterial(material: THREE.Material, surface: Surface) {
  material.customProgramCacheKey = () => 'hologram-' + surface;
  material.onBeforeCompile = (shader) => {
    if (surface !== 'detail') {
      shader.vertexShader =
        'varying vec3 holoPosition;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 holoLocal = vec4(transformed,1.0);
          #ifdef USE_INSTANCING
            holoLocal = instanceMatrix * holoLocal;
          #endif
          holoPosition = (modelMatrix * holoLocal).xyz;`,
        );
      shader.fragmentShader = 'varying vec3 holoPosition;\n' + shader.fragmentShader;
    }
    const color = surface === 'facade' ? facade : surface === 'terrain' ? terrain : detail;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      color + '\n#include <opaque_fragment>',
    );
  };
}

// 经纬全景以天顶、地平线和暮光方向采样，球面远景与视点移动无关。
export function twilightSky() {
  const width = 768,
    height = 256;
  const pixels = new Uint8Array(width * height * 4);
  const zenith = new THREE.Color('#0c2143'),
    horizon = new THREE.Color('#9c91b3');
  const west = new THREE.Color('#f2b198'),
    sea = new THREE.Color('#355367');
  const color = new THREE.Color();
  for (let y = 0; y < height; y++) {
    const altitude = Math.sin(((y + 0.5) / height - 0.5) * Math.PI);
    const glow = Math.exp(-Math.abs(altitude) * 4.4);
    for (let x = 0; x < width; x++) {
      const longitude = (2 * Math.PI * x) / width;
      const warm = (0.5 + 0.5 * Math.cos(longitude - 1.7)) ** 4;
      color
        .copy(altitude >= 0 ? zenith : sea)
        .lerp(horizon, glow * 0.76)
        .lerp(west, warm * glow * 0.77)
        .convertLinearToSRGB();
      // 远处细云与霞光随球面方位连续变化，两端经线无接缝。
      const a = Math.sin(altitude * 52 + 2 * Math.sin(longitude * 2));
      const b = Math.sin(altitude * 135 + 3 * Math.sin(longitude * 4 + altitude * 11));
      const veil = Math.max(0, a * 0.57 + b * 0.26 + 0.12) * glow * (altitude > 0 ? 0.07 : 0);
      color.offsetHSL(0, 0, veil);
      const i = (y * width + x) * 4;
      pixels[i] = Math.round(color.r * 255);
      pixels[i + 1] = Math.round(color.g * 255);
      pixels[i + 2] = Math.round(color.b * 255);
      pixels[i + 3] = 255;
    }
  }
  const sky = new THREE.DataTexture(pixels, width, height);
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.colorSpace = THREE.SRGBColorSpace;
  sky.magFilter = sky.minFilter = THREE.LinearFilter;
  sky.needsUpdate = true;
  return sky;
}
