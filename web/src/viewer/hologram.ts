import * as THREE from 'three';
import type { EntityBody } from '../core/api/types';
import type { StyleLook } from '../core/styles';

export function surfaceLook(look: StyleLook | undefined, entity: EntityBody, background: boolean) {
  if (!look?.hologram || !background || !entity.bounds) return look;
  const { min, max } = entity.bounds;
  const height = max[1] - min[1];
  const footprint = Math.max(max[0] - min[0], max[2] - min[2]);
  if (entity.material?.unlit || entity.props?.link) return look;
  if (
    (height >= 10 && height >= footprint * 0.12 && entity.material?.shading !== 'albedo') ||
    (height >= 2.5 &&
      footprint >= 20 &&
      !!entity.props?.backgroundView &&
      entity.kind === 'object') ||
    (height >= 10 && height >= footprint * 0.6)
  )
    return { ...look, hologram: 'facade' as const };
  if (
    entity.kind === 'object' &&
    entity.assetHash &&
    footprint > 0 &&
    !entity.props?.backgroundView
  )
    return { ...look, hologram: 'landscape' as const };
  return look;
}

type Surface = NonNullable<StyleLook['hologram']> | 'terrain';

// 在面内坐标和偏移后的内层各绘制一次。镜头斜看时，两层玻璃产生视差。
const facade = /* glsl */ `
  vec3 p = holoPosition;
  vec3 n = normalize(cross(dFdx(p), dFdy(p)));
  vec3 eye = normalize(cameraPosition - p);
  n *= dot(n, eye) < 0.0 ? -1.0 : 1.0;
  float cosEye = clamp(dot(eye, n), 0.0, 1.0);
  float wall = 1.0 - smoothstep(0.38, 0.90, abs(n.y));
  vec2 tangent = normalize(vec2(n.z + 0.0001, -n.x));
  vec2 axis = vec2(dot(p.xz, tangent), p.y);
  vec2 ray = vec2(dot(-eye.xz,tangent), -eye.y) / max(0.34, cosEye);
  vec2 inner = axis + 2.8 * ray;
  vec2 pane = axis / vec2(7.5, 4.2);
  vec2 width = max(fwidth(pane), vec2(0.002));
  vec2 edge = abs(fract(pane + 0.5) - 0.5);
  vec2 joint = (1.0 - smoothstep(vec2(0.0), width+vec2(0.009,0.013),edge))
    * (1.0 - smoothstep(vec2(0.10),vec2(0.56),width));
  float interior = inner.y / 4.2;
  float iw = clamp(fwidth(interior),0.003,0.65);
  float shelf = (1.0-smoothstep(0.01,0.055+iw,abs(fract(interior+0.5)-0.5)))
    * (1.0-smoothstep(0.12,0.60,iw));
  float wing = inner.x / 23.0;
  float spine = (1.0-smoothstep(0.012,0.039+fwidth(wing),abs(fract(wing+0.5)-0.5)))
    * (1.0-smoothstep(0.10,0.45,fwidth(wing)));
  vec3 r = reflect(-eye,n);
  float facing = smoothstep(-0.92,0.92,dot(n,normalize(vec3(-0.62,0.17,0.74))));
  float fresnel = pow(1.0-cosEye, 2.7);
  float horizon = exp(-5.8*abs(r.y+0.07));
  float sun = pow(0.5+0.5*dot(normalize(r.xz+0.0001),normalize(vec2(0.82,-0.57))),3.5);
  vec3 rim = mix(vec3(0.26,0.77,0.95),vec3(0.78,0.55,0.86),sun);
  vec3 glass = mix(vec3(0.009,0.028,0.055),vec3(0.021,0.066,0.090),facing);
  glass += horizon * mix(vec3(0.033,0.085,0.115),vec3(0.25,0.145,0.18),sun);
  glass += fresnel * rim * 0.34;
  // 稀疏的亮边将玻璃分成体块，普通层板保留暗面。
  float tier = pane.y / 7.0;
  float tierEdge = (1.0 - smoothstep(0.004,0.012+fwidth(tier),abs(fract(tier+0.5)-0.5)))
    * (1.0 - smoothstep(0.12,0.45,fwidth(tier)));
  glass += wall * (vec3(0.043,0.078,0.095)*shelf + vec3(0.025,0.046,0.065)*spine +
    rim * (0.072*joint.x+0.032*joint.y+0.46*tierEdge));
  // 合并贴图仅提取有明显专色的标记。窗户、墙面与灰白的摄影光影均由玻璃接管。
  #ifdef USE_MAP
    vec3 ink = texture2D(map, vMapUv).rgb;
    float peak = max(ink.r,max(ink.g,ink.b));
    float chroma = peak-min(ink.r,min(ink.g,ink.b));
    float logo = smoothstep(0.18,0.42,chroma)*smoothstep(0.68,0.90,chroma/max(peak,0.001));
    glass = mix(glass,ink,logo);
  #endif
  float solidity = mix(0.65,0.97,smoothstep(55.0,320.0,length(cameraPosition-p)));
  diffuseColor.a *= mix(solidity,1.0,clamp(fresnel + tierEdge,0.0,1.0));
  outgoingLight = glass;
`;

const terrain = /* glsl */ `
  // 只从低频影像取陆水分区和大尺度明暗，街区背景不展示航拍纹理。
  vec3 region = diffuseColor.rgb;
  #ifdef USE_MAP
    region = texture2D(map,vMapUv,3.5).rgb;
  #endif
  float value = dot(region,vec3(0.23,0.64,0.13));
  float water = smoothstep(0.018,0.071,region.b-region.r) * smoothstep(0.012,0.08,region.g-region.r);
  vec3 ground = mix(vec3(0.023,0.037,0.060),vec3(0.038,0.052,0.077),smoothstep(0.16,0.48,value));
  vec3 sea = vec3(0.024,0.077,0.103);
  float air = smoothstep(750.0,12000.0,length(cameraPosition-holoPosition));
  outgoingLight = mix(mix(ground,sea,water),vec3(0.32,0.27,0.34),air*0.90);
`;

// 低矮街景和树冠只交代体积。保留源材质的透明遮罩与接触阴影。
const landscape = /* glsl */ `
  vec3 n = normalize(cross(dFdx(holoPosition),dFdy(holoPosition)));
  float light = clamp(dot(n,normalize(vec3(-0.35,0.80,0.49)))*0.5+0.5,0.0,1.0);
  outgoingLight = mix(vec3(0.016,0.031,0.047),vec3(0.048,0.077,0.084),light);
`;

const detail = /* glsl */ `
  float luma = dot(outgoingLight,vec3(0.24,0.60,0.16));
  outgoingLight = mix(outgoingLight, vec3(luma*0.75,luma*1.02,luma*1.15),0.22);
  outgoingLight += vec3(0.010,0.020,0.034)*diffuseColor.rgb;
`;

export function hologramMaterial(material: THREE.Material, surface: Surface) {
  if (surface === 'facade') {
    if (/(?:^|[\s_.-])(logo|signage|wordmark|emblem)(?:$|[\s_.-])/i.test(material.name)) return;
    material.transparent = true;
  }
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
    const color =
      surface === 'facade'
        ? facade
        : surface === 'terrain'
          ? terrain
          : surface === 'landscape'
            ? landscape
            : detail;
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
