import * as THREE from 'three';
import { poolWater } from './poolWater';

/** 米制视距的空气透视，在海湾尺度上逐渐降低反差。 */
const cityAir = /* glsl */ `
  vec3 cityAir(vec3 light, float meters, vec3 horizon) {
    float transmission = exp2(-max(0.0, meters - 75.0) / 4800.0);
    return mix(light, horizon, min(0.42, 1.0 - transmission));
  }
`;

function citySkyUniforms(material: THREE.Material) {
  const panorama = { value: null as THREE.Texture | null };
  const hasPanorama = { value: false };
  const yaw = { value: 0 };
  material.onBeforeRender = (_renderer, scene) => {
    const background = scene.background;
    panorama.value =
      background instanceof THREE.Texture &&
      background.mapping === THREE.EquirectangularReflectionMapping
        ? background
        : null;
    hasPanorama.value = !!panorama.value;
    yaw.value = scene.backgroundRotation.y;
  };
  return { citySky: panorama, cityHasSky: hasPanorama, citySkyYaw: yaw };
}

const skyDeclarations =
  'uniform sampler2D citySky;\nuniform bool cityHasSky;\nuniform float citySkyYaw;\n';

// 日间窗面将多个位置拍摄的半球图保存在零自发光的贴图里，普通 glTF 查看器仍按透明玻璃呈现。
function facadeProbeUniforms(material: THREE.MeshStandardMaterial) {
  const p = material.userData.facadeProbes;
  if (!p || !material.emissiveMap || !material.transparent) return null;
  const dimensions = [p.span, p.height, p.spacing, p.depth, p.count];
  if (
    !dimensions.every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isInteger(p.count) ||
    !Number.isFinite(p.eyeHeight) ||
    !Number.isFinite(p.first)
  )
    return null;
  return {
    probeWall: { value: new THREE.Vector4(p.span, p.height, p.eyeHeight, p.depth) },
    probeRow: { value: new THREE.Vector3(p.first, p.spacing, p.count) },
  };
}

const probeDeclarations = /* glsl */ `
  uniform vec4 probeWall;
  uniform vec3 probeRow;

  vec3 facadeRadiance(float index, vec3 ray, vec2 point) {
    float center = probeRow.x + index * probeRow.y;
    vec3 offset = vec3(0.0, point.y - probeWall.z, point.x - center);
    vec3 sampleRay = normalize(ray * probeWall.w + offset * max(ray.x, 0.0));
    vec2 uv = vec2(0.5 + atan(sampleRay.z, max(sampleRay.x, 0.0001)) / 3.141593,
                   0.5 - asin(clamp(sampleRay.y, -1.0, 1.0)) / 3.141593);
    // 给图集各列的边缘留出双线性过滤宽度。
    uv.x = (index + clamp(uv.x, 0.002, 0.998)) / probeRow.z;
    return texture2D(emissiveMap, uv).rgb;
  }
`;

const probeReflection = /* glsl */ `
  vec3 eye = normalize(vViewPosition);
  vec3 worldNormal = inverseTransformDirection(normal, viewMatrix);
  vec3 worldRay = inverseTransformDirection(reflect(-eye, normal), viewMatrix);
  vec3 tangent = normalize(cross(vec3(0.0, 1.0, 0.0), worldNormal));
  vec3 ray = vec3(dot(worldRay, worldNormal), worldRay.y, dot(worldRay, tangent));
  vec2 point = vec2(vEmissiveMapUv.x, 1.0 - vEmissiveMapUv.y) * probeWall.xy;
  float positionInRow = clamp((point.x - probeRow.x) / probeRow.y, 0.0, probeRow.z - 1.0);
  float left = floor(positionInRow);
  vec3 exterior = mix(facadeRadiance(left, ray, point),
                      facadeRadiance(min(left + 1.0, probeRow.z - 1.0), ray, point),
                      smoothstep(0.0, 1.0, fract(positionInRow)));
  float reflection = 0.105 + 0.85 * pow(1.0 - abs(dot(normal, eye)), 5.0);
  float transmissionTint = diffuseColor.a * (1.0 - reflection);
  diffuseColor.a = transmissionTint + reflection;
  outgoingLight = (outgoingLight * transmissionTint + exterior * reflection) / diffuseColor.a;
`;

/** 实景模型既有标准受光材质，也有烘焙为无光照贴图的楼面。 */
export function cityModelAir(material: THREE.Material) {
  if (!(
    material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial
  ))
    return;
  if (
    material instanceof THREE.MeshStandardMaterial &&
    material.userData.waterSurface === 'pool' &&
    material.map &&
    material.normalMap &&
    material.normalMapType === THREE.TangentSpaceNormalMap
  ) {
    poolWater(material, citySkyUniforms(material));
    return;
  }
  const glass =
    material instanceof THREE.MeshStandardMaterial && material.userData.reflectSky === true;
  const probes = glass ? facadeProbeUniforms(material) : null;
  const sky = glass && !probes ? citySkyUniforms(material) : null;
  const surface = material.userData.waterSurface;
  const drops = surface === 'fountainDrops';
  const fountain = material.map && (surface === 'fountainJet' || surface === 'fountainFoam');
  const flowOffset = { value: 0 };
  if (fountain || drops) {
    const speed = drops ? 6.25 : surface === 'fountainJet' ? 3.05 : 0.28;
    material.customProgramCacheKey = () => (drops ? 'city-fountain-drops' : 'city-fountain-flow');
    material.onBeforeRender = () => {
      flowOffset.value = ((performance.now() / 1000) * speed) % 1;
    };
  }
  if (glass)
    material.customProgramCacheKey = () => (probes ? 'city-facade-probes' : 'city-model-glazing');
  material.onBeforeCompile = (shader) => {
    if (drops || fountain) {
      shader.uniforms.flowOffset = flowOffset;
      shader.vertexShader =
        'uniform float flowOffset;\n' +
        (drops
          ? 'attribute vec4 _drop_drift;\n' +
            shader.vertexShader.replace(
              '#include <begin_vertex>',
              '#include <begin_vertex>\ntransformed += _drop_drift.xyz * ((fract(flowOffset + _drop_drift.w) - 0.5) * 0.16);',
            )
          : shader.vertexShader.replace(
              '#include <uv_vertex>',
              '#include <uv_vertex>\nvMapUv.y += flowOffset;',
            ));
    }
    if (sky) Object.assign(shader.uniforms, sky);
    if (probes) Object.assign(shader.uniforms, probes);
    shader.vertexShader =
      'varying vec3 cityEye;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\ncityEye = mvPosition.xyz;',
      );
    shader.fragmentShader =
      (sky ? skyDeclarations : '') +
      'varying vec3 cityEye;\n' +
      cityAir +
      shader.fragmentShader
        .replace('#include <emissivemap_fragment>', probes ? '' : '#include <emissivemap_fragment>')
        .replace(
          '#include <emissivemap_pars_fragment>',
          '#include <emissivemap_pars_fragment>\n' + (probes ? probeDeclarations : ''),
        )
        .replace(
          '#include <opaque_fragment>',
          (probes
            ? probeReflection
            : sky
              ? `if (cityHasSky) {
          vec3 eye = normalize(vViewPosition);
          vec3 reflected = inverseTransformDirection(reflect(-eye, normal), viewMatrix);
          float c = cos(citySkyYaw), s = sin(citySkyYaw);
          reflected.xz = mat2(c,s,-s,c) * reflected.xz;
          reflected.y = max(0.014, reflected.y);
          vec3 skyColor = texture2D(citySky, equirectUv(normalize(reflected)), 2.0).rgb;
          float fresnel = 0.09 + 0.76 * pow(1.0 - abs(dot(normal,eye)), 5.0);
          outgoingLight = mix(outgoingLight, skyColor, fresnel);
        }\n`
              : '') +
            'outgoingLight = cityAir(outgoingLight, length(cityEye), vec3(0.46,0.55,0.62));\n#include <opaque_fragment>',
        );
  };
}

/** 同一瓦片的楼房共用材质，远处小于一个像素的窗框过渡到立面的平均色。 */
export function urbanFacade(material: THREE.MeshLambertMaterial) {
  const sky = citySkyUniforms(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sky);
    const varying =
      'varying vec3 cityPosition;\nvarying vec3 cityNormal;\nvarying vec2 cityFacade;\nvarying vec4 cityPaint;\n';
    shader.vertexShader =
      '#include <colorspace_pars_fragment>\nattribute vec4 facadePaint;\n' +
      varying +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        cityPosition = position;
        cityNormal = normal;
        cityFacade = uv;
        cityPaint = sRGBTransferEOTF(facadePaint);`,
      );
    shader.fragmentShader =
      cityAir +
      skyDeclarations +
      varying +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
        float variant = cityFacade.y;
        float wall = 1.0 - smoothstep(0.35,0.8,abs(cityNormal.y));
        vec2 tangent = normalize(vec2(cityNormal.z + 0.0001, -cityNormal.x));
        vec2 grid = vec2(dot(cityPosition.xz, tangent)/mix(2.3,4.2,variant),cityFacade.x/3.55);
        vec2 cell = abs(fract(grid)-0.5);
        vec2 fw = max(fwidth(grid),vec2(0.001));
        vec2 panels = 1.0-smoothstep(vec2(0.37,0.32)-0.5*fw, vec2(0.41,0.38)+0.5*fw, cell);
        panels = mix(panels,vec2(0.78,0.70),smoothstep(vec2(0.22),vec2(0.85),fw));
        vec3 stone = mix(vec3(0.73,0.72,0.68),vec3(1.42,1.40,1.30),variant);
        vec3 glazing = mix(vec3(0.29,0.48,0.57),vec3(0.51,0.69,0.74),variant);
        vec3 paint = mix(vec3(dot(cityPaint.rgb, vec3(.2126,.7152,.0722))), cityPaint.rgb, .80);
        vec3 masonry = mix(diffuseColor.rgb*stone, .035+.70*paint, cityPaint.a*.88);
        vec3 panes = mix(diffuseColor.rgb*glazing, masonry*vec3(.32,.43,.49), cityPaint.a*.65);
        diffuseColor.rgb = mix(masonry*.88, mix(masonry,panes,panels.x*panels.y), wall);
        `,
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
        vec3 worldN=inverseTransformDirection(normal,viewMatrix);
        vec3 worldEye=inverseTransformDirection(normalize(vViewPosition),viewMatrix);
        vec3 ray=reflect(-worldEye,worldN);
        float co=cos(citySkyYaw), si=sin(citySkyYaw);
        ray.xz=mat2(co,si,-si,co)*ray.xz;
        ray.y=max(0.015,ray.y);
        vec3 skyLight=cityHasSky ? texture2D(citySky,equirectUv(normalize(ray)),2.0).rgb : vec3(0.34,0.46,0.55);
        float grazing=pow(1.0-abs(dot(worldEye,worldN)),3.0);
        outgoingLight=mix(outgoingLight,skyLight,wall*panels.x*panels.y*(0.16+0.36*grazing));
        outgoingLight=cityAir(outgoingLight,length(vViewPosition),mix(vec3(0.46,0.55,0.62),skyLight,0.15));
        #include <opaque_fragment>`,
        );
  };
}
