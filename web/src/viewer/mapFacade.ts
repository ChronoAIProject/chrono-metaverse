import * as THREE from 'three';
import { buildingFinishShader, buildingFinishUniforms } from './buildingFinishes';
import { facadeShadow } from './facadeShadow';
import { poolWater } from './poolWater';
import { skyRadiance } from './skyRadiance';

/** 米制视距的空气透视，在海湾尺度上逐渐降低反差。 */
const cityAir = /* glsl */ `
  vec3 cityAir(vec3 light, vec3 viewRay, vec3 horizon) {
    float meters = length(viewRay);
    if (meters <= 75.0) return light;
    if (cityHasSky) {
      vec2 direction = (viewRay * mat3(viewMatrix)).xz;
      if (dot(direction, direction) > 0.0001) {
        float longitude = atan(direction.y, direction.x) + citySkyYaw;
        vec2 uv = vec2(fract(0.5 + longitude / 6.2831853), 0.505);
        // Average about eight degrees of horizon to keep individual clouds out of the haze.
        float lod = max(0.0, log2(float(textureSize(citySky, 0).x) / 45.0));
        horizon = textureLod(citySky, uv, lod).rgb;
      }
    }
    float transmission = exp2(-max(0.0, meters - 75.0) / cityAirHalfDistance);
    return mix(light, horizon, min(0.42, 1.0 - transmission));
  }
`;

function citySkyUniforms(material: THREE.Material) {
  const panorama = { value: null as THREE.Texture | null };
  const hasPanorama = { value: false };
  const yaw = { value: 0 };
  const halfDistance = { value: 4800 };
  const beforeRender = material.onBeforeRender;
  material.onBeforeRender = function (...args) {
    beforeRender.call(this, ...args);
    const scene = args[1];
    const background = scene.background;
    const display =
      background instanceof THREE.Texture &&
      background.mapping === THREE.EquirectangularReflectionMapping
        ? background
        : null;
    // Reflections and air scattering are mixed before the material's tone mapping.
    panorama.value =
      display && material.toneMapped ? (skyRadiance.get(display) ?? display) : display;
    hasPanorama.value = !!display;
    halfDistance.value = display?.userData.airHalfDistance ?? 4800;
    yaw.value = scene.backgroundRotation.y;
  };
  return {
    citySky: panorama,
    cityHasSky: hasPanorama,
    citySkyYaw: yaw,
    cityAirHalfDistance: halfDistance,
  };
}

const skyDeclarations =
  'uniform sampler2D citySky;\nuniform bool cityHasSky;\nuniform float citySkyYaw, cityAirHalfDistance;\n';

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
export function cityModelAir(material: THREE.Material, roofScale?: number) {
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
  // A prefiltered glTF probe uses model-space directions and stores linear radiance in sRGB.
  const levels = material.userData.reflectionLevels;
  const heights =
    levels &&
    Number.isFinite(levels.first) &&
    Number.isFinite(levels.last) &&
    levels.last > levels.first &&
    Number.isInteger(levels.count) &&
    levels.count >= 2 &&
    levels.count <= 8 &&
    Number.isFinite(levels.scale) &&
    levels.scale > 0 &&
    levels.scale <= 64
      ? new THREE.Vector4(levels.first, levels.last, levels.count, levels.scale)
      : null;
  const localProbe =
    material instanceof THREE.MeshStandardMaterial &&
    material.emissiveMap &&
    !glass &&
    (heights || material.userData.prefilteredReflection === true);
  const worldToProbe = localProbe ? { value: new THREE.Matrix3() } : null;
  if (worldToProbe) {
    const rotation = new THREE.Matrix4();
    material.customProgramCacheKey = () =>
      heights ? 'city-height-reflections' : 'city-local-reflection';
    material.onBeforeRender = (_renderer, _scene, _camera, _geometry, object) => {
      worldToProbe.value.setFromMatrix4(rotation.extractRotation(object.matrixWorld)).transpose();
    };
  }
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
  const sky = citySkyUniforms(material);
  if (glass)
    material.customProgramCacheKey = () => (probes ? 'city-facade-probes' : 'city-model-glazing');
  material.onBeforeCompile = (shader) => {
    if (roofScale !== undefined) {
      shader.uniforms.roofAlbedoScale = { value: roofScale };
      // The survey facets have flat normals in the original model's Y-up frame.
      shader.vertexShader =
        'uniform float roofAlbedoScale;\nvarying float roofAlbedo;\n' +
        shader.vertexShader.replace(
          '#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\nroofAlbedo = mix(1.0, roofAlbedoScale, step(0.67, normal.y));',
        );
      shader.fragmentShader =
        'varying float roofAlbedo;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb *= roofAlbedo;',
        );
    }
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
    if (worldToProbe) {
      shader.uniforms.worldToProbe = worldToProbe;
      if (heights) {
        shader.uniforms.reflectionLevels = { value: heights };
        shader.vertexShader =
          'varying float probeHeight;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nprobeHeight = position.y;',
          );
        shader.fragmentShader =
          'varying float probeHeight;\nuniform vec4 reflectionLevels;\n' + shader.fragmentShader;
      }
      shader.fragmentShader =
        'uniform mat3 worldToProbe;\n' +
        shader.fragmentShader.replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
          vec3 probeRay = reflect(-geometryViewDir, geometryNormal);
          probeRay = normalize(mix(probeRay, geometryNormal, pow4(material.roughness)));
          vec3 localRay = worldToProbe * inverseTransformDirection(probeRay, viewMatrix);
          vec2 probeUV = equirectUv(localRay);
          ${
            heights
              ? `float count = reflectionLevels.z;
          float level = clamp((probeHeight - reflectionLevels.x) /
            (reflectionLevels.y - reflectionLevels.x), 0.0, 1.0) * (count - 1.0);
          float low = floor(level);
          float edge = 0.5 * count / float(textureSize(emissiveMap, 0).y);
          probeUV.y = clamp(probeUV.y, edge, 1.0 - edge) / count;
          vec2 dx = dFdx(probeUV), dy = dFdy(probeUV);
          dx.x -= round(dx.x);
          dy.x -= round(dy.x);
          vec3 lower = textureGrad(emissiveMap, probeUV + vec2(0.0,low/count), dx,dy).rgb;
          vec3 upper = textureGrad(emissiveMap, probeUV + vec2(0.0,min(low+1.0,count-1.0)/count), dx,dy).rgb;
          radiance += reflectionLevels.w * mix(lower, upper, fract(level));`
              : 'radiance += texture2D(emissiveMap, probeUV).rgb;'
          }`,
        );
    }
    Object.assign(shader.uniforms, sky);
    if (probes) Object.assign(shader.uniforms, probes);
    shader.vertexShader =
      'varying vec3 cityEye;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\ncityEye = mvPosition.xyz;',
      );
    shader.fragmentShader =
      skyDeclarations +
      'varying vec3 cityEye;\n' +
      cityAir +
      shader.fragmentShader
        .replace(
          '#include <emissivemap_fragment>',
          probes || worldToProbe ? '' : '#include <emissivemap_fragment>',
        )
        .replace(
          '#include <emissivemap_pars_fragment>',
          '#include <emissivemap_pars_fragment>\n' + (probes ? probeDeclarations : ''),
        )
        .replace(
          '#include <opaque_fragment>',
          (probes
            ? probeReflection
            : glass
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
            'outgoingLight = cityAir(outgoingLight, cityEye, vec3(0.46,0.55,0.62));\n#include <opaque_fragment>',
        );
    if (
      material instanceof THREE.MeshStandardMaterial &&
      !material.transparent &&
      !material.alphaTest
    )
      facadeShadow(shader);
  };
  if (roofScale !== undefined) {
    const baseKey = material.customProgramCacheKey();
    material.customProgramCacheKey = () => baseKey + '|roof-albedo';
  }
}

// Integral of a periodic strip. Taking the difference at the pixel edges
// keeps thin mullions and floor bands stable during camera motion.
const facadeFiltering = /* glsl */ `
  vec2 paneIntegral(vec2 x, vec2 coverage) {
    return floor(x) * coverage + min(fract(x), coverage);
  }
  float paneCoverage(vec2 grid, vec2 coverage) {
    vec2 pixel = max(fwidth(grid), vec2(0.001));
    vec2 center = fract(grid) - 0.5 + 0.5 * coverage;
    vec2 span = min(pixel, vec2(2.0));
    vec2 panes = (paneIntegral(center + 0.5 * span, coverage)
                - paneIntegral(center - 0.5 * span, coverage)) / span;
    panes = mix(panes, coverage, smoothstep(vec2(0.6), vec2(2.0), pixel));
    return clamp(panes.x * panes.y, 0.0, 1.0);
  }

  // Ordinary uncoated window glass. Sum the internal reflections at the
  // two faces of a pane for each polarization, then average for daylight.
  float paneReflectance(float cosine) {
    const float ior = 1.52;
    float transmitted = sqrt(1.0 - (1.0 - cosine * cosine) / (ior * ior));
    float rs = (cosine - ior * transmitted) / (cosine + ior * transmitted);
    float rp = (ior * cosine - transmitted) / (ior * cosine + transmitted);
    vec2 reflectance = vec2(rs * rs, rp * rp);
    vec2 pane = reflectance / (1.0 + reflectance);
    return pane.x + pane.y;
  }
`;

/** 同一瓦片的楼房共用材质，远处小于一个像素的窗框过渡到立面的平均色。 */
export function urbanFacade(
  material: THREE.MeshLambertMaterial,
  reflections?: {
    map: { value: THREE.Texture | null };
    ready: { value: boolean };
    scale: number;
    rows: number;
  },
) {
  if (reflections) {
    material.defines = { ...material.defines, LOCAL_FACADE_REFLECTIONS: 1 };
  }
  const sky = citySkyUniforms(material);
  const finishMap = buildingFinishUniforms(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sky, finishMap);
    if (reflections)
      Object.assign(shader.uniforms, {
        facadeReflectionMap: reflections.map,
        facadeReflectionReady: reflections.ready,
        facadeReflectionLayout: { value: new THREE.Vector2(reflections.scale, reflections.rows) },
      });
    const varying =
      '#ifdef LOCAL_FACADE_REFLECTIONS\nvarying vec2 probeRowLevel;\nvarying vec3 probeDirection;\n#endif\n' +
      'varying vec3 cityPosition;\nvarying vec3 cityNormal;\nvarying vec2 cityFacade;\nvarying vec4 cityPaint;\n';
    shader.vertexShader =
      '#ifdef LOCAL_FACADE_REFLECTIONS\nattribute vec2 facadeProbe;\n#endif\n' +
      '#include <colorspace_pars_fragment>\nattribute vec4 facadePaint;\n' +
      varying +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        #ifdef LOCAL_FACADE_REFLECTIONS
          probeRowLevel = facadeProbe;
          // Planar faces interpolate the unnormalized incident ray in the registered map frame.
          vec3 r = reflect(mvPosition.xyz, normalize(normalMatrix * normal));
          probeDirection = transpose(mat3(modelViewMatrix)) * r;
        #endif
        cityPosition = position;
        cityNormal = normal;
        cityFacade = uv;
        cityPaint = sRGBTransferEOTF(facadePaint);`,
      );
    shader.fragmentShader =
      skyDeclarations +
      cityAir +
      '#ifdef LOCAL_FACADE_REFLECTIONS\nuniform sampler2D facadeReflectionMap;\nuniform bool facadeReflectionReady;\nuniform vec2 facadeReflectionLayout;\n#endif\n' +
      buildingFinishShader +
      facadeFiltering +
      varying +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
        float variant = fract(cityFacade.y);
        float ribbon = step(1.0,cityFacade.y);
        float curtain = step(2.0,cityFacade.y);
        float wall = 1.0 - smoothstep(0.35,0.8,abs(cityNormal.y));
        vec2 tangent = normalize(vec2(cityNormal.z + 0.0001, -cityNormal.x));
        vec2 module = vec2(mix(2.6,4.6,variant) * mix(1.0,0.60,curtain),
                           mix(3.0,3.6,variant) + 0.48 * curtain);
        vec2 coverage = mix(vec2(0.50+0.18*variant,0.56),vec2(0.94,0.62),ribbon);
        coverage = mix(coverage,vec2(0.93,0.86),curtain);
        vec2 grid = vec2(dot(cityPosition.xz, tangent),cityFacade.x) / module;
        float panes = paneCoverage(grid,coverage);
        vec3 stone = mix(vec3(0.80,0.75,0.66),vec3(1.48,1.46,1.39),variant);
        vec3 glazing = mix(vec3(0.27,0.37,0.41),vec3(0.48,0.67,0.69),variant);
        vec3 paint = mix(vec3(dot(cityPaint.rgb, vec3(.2126,.7152,.0722))), cityPaint.rgb, .80);
        vec3 masonry = mix(diffuseColor.rgb*stone, .035+.70*paint, cityPaint.a*.88);
        vec3 glass = mix(diffuseColor.rgb*glazing, masonry*vec3(.32,.43,.49), cityPaint.a*.65);
        vec3 frame = mix(masonry,mix(glass,masonry,0.25),curtain);
        diffuseColor.rgb = mix(masonry*.88, mix(frame,glass,panes), wall);
        if (buildingFinishesReady && wall > 0.0) {
          vec4 finish = buildingFinish(vec3(cityPosition.x,cityFacade.x,cityPosition.z),tangent,variant,step(3.0,cityFacade.y));
          vec3 tint = mix(vec3(.92+variant*.14), .70+.55*paint,cityPaint.a*.55);
          diffuseColor.rgb = mix(diffuseColor.rgb,finish.rgb*tint,wall);
          panes = finish.a;
          glass = diffuseColor.rgb;
        } else if (buildingFinishesReady) {
          diffuseColor.rgb = buildingRoof(cityPosition.xz, variant, step(3.0,cityFacade.y));
        }
        `,
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
        vec3 worldN=inverseTransformDirection(normal,viewMatrix);
        vec3 worldEye=inverseTransformDirection(normalize(vViewPosition),viewMatrix);
        #if NUM_DIR_LIGHTS == 1 && NUM_POINT_LIGHTS == 0 && NUM_SPOT_LIGHTS == 0 && NUM_RECT_AREA_LIGHTS == 0
          // A room surface seen through a window receives direct sunlight only
          // where the eye and sun rays both pass through the same opening.
          vec3 sun = inverseTransformDirection(directionalLights[0].direction, viewMatrix);
          vec3 along = vec3(worldN.z, 0.0, -worldN.x);
          vec2 viewSlope = vec2(dot(along,worldEye), worldEye.y) / max(0.001,dot(worldN,worldEye));
          vec2 sunSlope = vec2(dot(along,sun), sun.y) / max(0.001,dot(worldN,sun));
          // Use one storey as the depth of the representative interior bay.
          vec2 shift = clamp((sunSlope - viewSlope) * module.y / module, -1.0, 1.0);
          vec2 overlap = max(vec2(0.0), coverage - abs(shift));
          float sunlitPanes = paneCoverage(grid + 0.5 * shift, overlap);
          float shaded = buildingFinishesReady ? panes*(1.0-clamp(overlap.x*overlap.y/max(.01,coverage.x*coverage.y),0.0,1.0))
                                               : max(0.0,panes-sunlitPanes);
          vec3 shadedGlass = glass * wall * shaded;
          outgoingLight -= reflectedLight.directDiffuse * shadedGlass / max(diffuseColor.rgb,vec3(0.0001));
        #endif
        vec3 ray=reflect(-worldEye,worldN);
        float co=cos(citySkyYaw), si=sin(citySkyYaw);
        ray.xz=mat2(co,si,-si,co)*ray.xz;
        ray.y=max(0.015,ray.y);
        vec3 skyLight=cityHasSky ? texture2D(citySky,equirectUv(normalize(ray)),2.0).rgb : vec3(0.34,0.46,0.55);
        #ifdef LOCAL_FACADE_REFLECTIONS
          if (cityHasSky && facadeReflectionReady && probeRowLevel.x > .5 && wall > 0.0) {
            // One gutter texel on either longitude edge wraps the panorama at the seam.
            vec2 size = vec2(textureSize(facadeReflectionMap,0));
            float stride = size.x / 3.0, rowHeight = size.y / facadeReflectionLayout.y;
            vec2 uv = equirectUv(normalize(probeDirection));
            vec2 pixel = vec2(1.0 + uv.x * (stride - 2.0),
              (probeRowLevel.x - 1.0) * rowHeight + clamp(uv.y * rowHeight, 0.5, rowHeight - 0.5));
            float level = clamp(probeRowLevel.y,0.0,2.0), low = floor(level);
            vec3 a = textureLod(facadeReflectionMap,(pixel + vec2(low * stride,0.0)) / size,0.0).rgb;
            vec3 b = textureLod(facadeReflectionMap,(pixel + vec2(min(low+1.0,2.0) * stride,0.0)) / size,0.0).rgb;
            skyLight = facadeReflectionLayout.x * mix(a,b,fract(level));
          }
        #endif
        float reflection = paneReflectance(clamp(abs(dot(worldEye,worldN)),0.0,1.0));
        outgoingLight=mix(outgoingLight,skyLight,wall*panes*reflection);
        outgoingLight=cityAir(outgoingLight,-vViewPosition,mix(vec3(0.46,0.55,0.62),skyLight,0.15));
        #include <opaque_fragment>`,
        );
    facadeShadow(shader);
  };
}
