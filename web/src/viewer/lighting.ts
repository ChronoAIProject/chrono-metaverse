import * as THREE from 'three';
import { skyProbe } from './skyProbe';
import { CITY_REFLECTION_LAYER } from './mapReflection';
import type { LightingPreset } from '../core/api/types';
import type { SkyDaylight } from '../core/environment';

/**
 * 查看器的灯光和贴图材质的明暗。
 *
 * three.js r155 以后灯光用物理单位：漫反射按 Lambert 模型 = 反照率 / π × 辐照度，
 * 所以想让白色朝上的面接近原色，灯光强度要按 π 的倍数给（旧写法的 1.6 只相当于现在的 0.5 左右，
 * 画面整体偏暗，纯色部件的背光面发黑）。这里的强度都写成 `系数 × π`，系数就是
 * "白色漫反射面能拿到多少亮度"（1 = 原色），见 `diffuseResponse`。
 *
 * - 半球光：天空白、地面暖灰，给所有朝向一个底亮度，背光面不发黑；
 * - 主光：从东南上方（镜头默认所在的一侧）照下来，朝上的面和朝向镜头的面最亮；
 * - 补光：从西北上方，偏冷、较弱，照亮主光照不到的侧面。
 *
 * 带贴图的部件（地面、墙面、家具表面）的贴图大多取自扫描，本身就带着拍摄时的光照，
 * 原始视图里扫描是不打光直接显示的。所以贴图材质只让一部分受光照影响：
 * 颜色 = 色调 × `TEXTURE_DIFFUSE`（受光），自发光 = 色调 × `TEXTURE_EMISSIVE`（同一张贴图，不受光），
 * 合起来亮度接近原始扫描，同时保留一点明暗层次。
 */

/** 半球光：天空色、地面色（sRGB）和强度系数。 */
export const HEMISPHERE_LIGHT = { sky: 0xffffff, ground: 0xb3ada2, factor: 0.62 } as const;

/** 平行光：颜色（sRGB）、强度系数、从场景指向灯的方向（不必归一化）。 */
export interface DirectionalSpec {
  readonly color: number;
  readonly factor: number;
  readonly direction: readonly [number, number, number];
}

/** 主光：东南上方。 */
export const KEY_LIGHT: DirectionalSpec = {
  color: 0xfff7ec,
  factor: 0.55,
  direction: [0.45, 0.8, 0.4],
};

/** 补光：西北上方，偏冷、较弱。 */
export const FILL_LIGHT: DirectionalSpec = {
  color: 0xe6edff,
  factor: 0.28,
  direction: [-0.55, 0.5, -0.6],
};

const PRESET_LIGHTS: Record<
  LightingPreset,
  {
    hemisphere: { sky: number; ground: number; factor: number };
    key: DirectionalSpec;
    fill: DirectionalSpec;
  }
> = {
  daylight: { hemisphere: HEMISPHERE_LIGHT, key: KEY_LIGHT, fill: FILL_LIGHT },
  warm: {
    hemisphere: { sky: 0xffead0, ground: 0x8c7160, factor: 0.7 },
    key: { color: 0xffc27c, factor: 0.72, direction: [0.45, 0.8, 0.4] },
    fill: { color: 0xffe5c0, factor: 0.22, direction: [-0.55, 0.5, -0.6] },
  },
  night: {
    hemisphere: { sky: 0x20284f, ground: 0x080b18, factor: 0.28 },
    key: { color: 0x718cff, factor: 0.42, direction: [0.45, 0.8, 0.4] },
    fill: { color: 0xff6bd6, factor: 0.38, direction: [-0.55, 0.5, -0.6] },
  },
  studio: {
    hemisphere: { sky: 0xf7f7f7, ground: 0xbfc3cc, factor: 0.78 },
    key: { color: 0xffffff, factor: 0.48, direction: [0.45, 0.8, 0.4] },
    fill: { color: 0xdbe5ff, factor: 0.38, direction: [-0.55, 0.5, -0.6] },
  },
  blueprint: {
    hemisphere: { sky: 0x234d83, ground: 0x071326, factor: 0.45 },
    key: { color: 0x86cfff, factor: 0.55, direction: [0.45, 0.8, 0.4] },
    fill: { color: 0x4c7aff, factor: 0.34, direction: [-0.55, 0.5, -0.6] },
  },
};

/** 贴图材质受光照影响的部分。 */
export const TEXTURE_DIFFUSE = 0.3;
/** 贴图材质不受光照、直接显示的部分（自发光，贴图同一张）。 */
export const TEXTURE_EMISSIVE = 0.72;

function directionOf(spec: DirectionalSpec): THREE.Vector3 {
  return new THREE.Vector3(...spec.direction).normalize();
}

/** 场景用的三盏灯（物理单位的强度）。平行光放在离原点 20 米处，照向原点。 */
export function createLights(
  preset: LightingPreset = 'daylight',
  daylight?: SkyDaylight,
  skyYaw = 0,
): THREE.Light[] {
  const specs = PRESET_LIGHTS[preset] ?? PRESET_LIGHTS.daylight;
  const hemisphere = new THREE.HemisphereLight(
    specs.hemisphere.sky,
    specs.hemisphere.ground,
    specs.hemisphere.factor * Math.PI,
  );
  hemisphere.name = 'light:hemisphere';
  const lights: THREE.Light[] = [hemisphere];
  if (preset === 'daylight' && daylight) {
    // 方位随全景旋转。从水平白面入射照度按比例分配太阳与天光。
    const azimuth = THREE.MathUtils.degToRad(daylight.azimuth - skyYaw);
    const elevation = THREE.MathUtils.degToRad(daylight.elevation);
    const horizontal = Math.cos(elevation);
    const irradiance = Math.PI * diffuseResponse(new THREE.Vector3(0, 1, 0));
    hemisphere.color.fromArray(daylight.skyColor);
    hemisphere.intensity =
      (irradiance * (1 - daylight.directFraction)) / luminance(hemisphere.color);
    const sun = new THREE.DirectionalLight();
    sun.name = 'light:key';
    sun.color.fromArray(daylight.sunColor);
    sun.position
      .set(horizontal * Math.cos(azimuth), Math.sin(elevation), horizontal * Math.sin(azimuth))
      .multiplyScalar(20);
    sun.intensity =
      (irradiance * daylight.directFraction) / (Math.sin(elevation) * luminance(sun.color));
    // 航拍地表已有日照。阴影只保留水平面各色通道收到的天光。
    const skyLight = hemisphere.color.clone().multiplyScalar(hemisphere.intensity);
    const sunlight = sun.color.clone().multiplyScalar(sun.intensity * Math.sin(elevation));
    const transmission = (sky: number, direct: number) =>
      sky + direct > 0 ? sky / (sky + direct) : 1;
    sun.userData.groundShadow = new THREE.Color(
      transmission(skyLight.r, sunlight.r),
      transmission(skyLight.g, sunlight.g),
      transmission(skyLight.b, sunlight.b),
    );
    if (daylight.diffuseProbe) {
      const sky = skyProbe(daylight.diffuseProbe, skyYaw, hemisphere.intensity);
      sky.name = 'light:sky-probe';
      lights[0] = sky;
    }
    lights.push(sun);
  } else {
    for (const [name, spec] of [
      ['light:key', specs.key],
      ['light:fill', specs.fill],
    ] as const) {
      const light = new THREE.DirectionalLight(spec.color, spec.factor * Math.PI);
      light.position.copy(directionOf(spec).multiplyScalar(20));
      light.name = name;
      lights.push(light);
    }
  }
  // 水平面直射照度占比决定水体在岸影中损失的日照。场景光组切换时计算一次。
  const directIrradiance = (sun: THREE.DirectionalLight) =>
    sun.intensity * luminance(sun.color) * Math.max(0, sun.position.y / sun.position.length());
  const directional = lights.filter((light) => light instanceof THREE.DirectionalLight);
  const total = directional.reduce(
    (sum, sun) => sum + directIrradiance(sun),
    hemisphere.intensity * luminance(hemisphere.color),
  );
  for (const sun of directional)
    sun.userData.directFraction = directIrradiance(sun) / Math.max(1e-6, total);
  for (const light of lights) light.layers.enable(CITY_REFLECTION_LAYER);
  return lights;
}

/** 线性颜色的亮度（Rec. 709 权重）。 */
function luminance(color: THREE.Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/**
 * 白色漫反射面（反照率 1）在这套灯光下的亮度，色调映射之前，1 表示原色。
 * 按 three.js 的着色公式算：半球光按法线朝上的程度在地面色和天空色之间插值，
 * 平行光乘以 max(0, n·l)，再乘 Lambert 的 1/π（所以强度系数正好是这个亮度）。
 */
export function diffuseResponse(normal: THREE.Vector3): number {
  const n = normal.clone().normalize();
  const sky = new THREE.Color(HEMISPHERE_LIGHT.sky);
  const ground = new THREE.Color(HEMISPHERE_LIGHT.ground);
  const hemisphere = luminance(ground.lerp(sky, 0.5 * n.y + 0.5)) * HEMISPHERE_LIGHT.factor;
  let direct = 0;
  for (const spec of [KEY_LIGHT, FILL_LIGHT]) {
    direct +=
      Math.max(0, n.dot(directionOf(spec))) * luminance(new THREE.Color(spec.color)) * spec.factor;
  }
  return hemisphere + direct;
}

/** 贴图材质在这套灯光下的亮度（贴图原色为 1）：受光部分 × 漫反射亮度 + 自发光部分。 */
export function texturedResponse(normal: THREE.Vector3): number {
  return TEXTURE_DIFFUSE * diffuseResponse(normal) + TEXTURE_EMISSIVE;
}

/**
 * 贴图材质的明暗：颜色和自发光都用色调，自发光贴图和颜色贴图是同一张。
 * `map` 为 null 时（贴图还没到或下载失败）用纯色调，亮度和有贴图时一致。
 */
export function applyTexturedLook(
  material: THREE.MeshStandardMaterial,
  tint: THREE.Color,
  map: THREE.Texture | null,
): void {
  material.map = map;
  material.emissiveMap = map;
  material.color.copy(tint).multiplyScalar(TEXTURE_DIFFUSE);
  material.emissive.copy(tint).multiplyScalar(TEXTURE_EMISSIVE);
  material.needsUpdate = true;
}
