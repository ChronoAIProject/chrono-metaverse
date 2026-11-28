import { offshoreRadiance, offshoreSamplers, type OffshoreWater } from './offshoreWater';
import { surfaceNoise } from './surfaceVariation';
import * as THREE from 'three';
import type { MapReflection } from './mapReflection';
import { skyRadiance } from './skyRadiance';
import { KEY_LIGHT } from './lighting';
import gravityField from '../assets/geography/reservoir-gravity.webp';
import rippleField from '../assets/geography/reservoir-ripples.webp';
import reservoirReflectance from '../assets/geography/reservoir-reflectance.png';

/** 同一片水域共用米制波纹坐标；像素覆盖超过波长时逐渐滤掉细纹。 */
export function mapWaterMaterial(
  hologram: boolean,
  reflection?: MapReflection,
  sample?: {
    center: THREE.Vector3;
    reflectance: THREE.Color;
    rmsGravitySlope?: number;
    rmsRippleSlope?: number;
  },
  downwindHeading?: number,
  offshore?: OffshoreWater['uniforms'],
) {
  // The wave field's +Y axis in the water plane points along world (-0.60, 0.80).
  const rotation = downwindHeading === undefined ? 0 : -Math.atan2(0.6, 0.8) - downwindHeading;
  const origin = new THREE.Vector2();
  const first = new THREE.Vector2(-11.4, 27.1).rotateAround(origin, rotation);
  const second = new THREE.Vector2(9.4, 20.2).rotateAround(origin, rotation);
  const measuredRipples = sample?.rmsRippleSlope;
  const downwind = new THREE.Vector2(0, 1).rotateAround(origin, rotation);
  const viewport = new THREE.Vector4();
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    forceSinglePass: true,
    lights: !!reflection,
    defines: {
      ...(offshore ? { OFFSHORE_WATER: 1 } : {}),
      ...(reflection ? { WATER_SHORE_SHADOW: 1 } : {}),
      ...(sample ? { WATER_SAMPLE: 1 } : {}),
      ...(measuredRipples !== undefined ? { WATER_SPECTRUM: 1 } : {}),
    },
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...offshore,
      ...(reflection ? THREE.UniformsUtils.clone(THREE.UniformsLib.lights) : {}),
      ...(sample
        ? {
            waterSampleArea: { value: sample.center },
            waterReflectance: { value: sample.reflectance },
            // The two gravity-wave gradients have total RMS sqrt(2 * 26/175 * (0.015² + 0.030²)).
            waterGravityGain: { value: (sample.rmsGravitySlope ?? 0.01828) / 0.01828 },
            horizontalDiffuse: { value: new THREE.Color(1, 1, 1) },
          }
        : {}),
      ...(measuredRipples !== undefined
        ? {
            gravityField: { value: null as THREE.Texture | null },
            rippleField: { value: null as THREE.Texture | null },
            spectrumReady: { value: false },
            slopeReflectance: { value: null as THREE.Texture | null },
            reflectanceReady: { value: false },
            rippleRms: { value: measuredRipples },
            rippleDownwind: { value: downwind },
            waterPixelStep: { value: new THREE.Vector2() },
          }
        : {}),
      directFraction: { value: 0 },
      reflectionMap: { value: reflection?.texture ?? null },
      reflectionDepth: { value: reflection?.depth ?? null },
      reflectionMatrix: { value: reflection?.matrix ?? new THREE.Matrix4() },
      reflectionEye: { value: reflection?.capturedPosition ?? new THREE.Vector3() },
      hasReflection: { value: false },
      sunlight: { value: new THREE.Vector3(...KEY_LIGHT.direction).normalize() },
      sunColor: { value: new THREE.Color(0xfff7e3) },
      time: { value: 0 },
      fadeRange: { value: new THREE.Vector2(3500, 11000) },
      shortWaveNumbers: { value: new THREE.Vector4(first.x, first.y, second.x, second.y) },
      skyMap: { value: null },
      hasSky: { value: false },
      skyWeight: { value: 0.72 },
      skyYaw: { value: 0 },
      deep: { value: new THREE.Color(hologram ? '#174351' : '#325553') },
      horizon: { value: new THREE.Color(hologram ? '#a999b4' : '#acc6ce') },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      #ifdef WATER_SHORE_SHADOW
        #include <shadowmap_pars_vertex>
      #endif
      #ifdef WATER_SAMPLE
        attribute float sampledWater;
        varying vec3 samplePosition;
      #endif
      varying vec3 surfacePosition;
      #ifdef OFFSHORE_WATER
        attribute vec2 offshoreUv;
        varying vec2 seaUv;
      #endif
      void main() {
        #ifdef OFFSHORE_WATER
          seaUv = offshoreUv;
        #endif
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        surfacePosition = worldPosition.xyz;
        #ifdef WATER_SAMPLE
          samplePosition = vec3(position.xz, sampledWater);
        #endif
        #ifdef WATER_SHORE_SHADOW
          vec3 transformedNormal = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
          #include <shadowmap_vertex>
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #ifdef OFFSHORE_WATER
        varying vec2 seaUv;
        ${offshoreSamplers}
        ${offshoreRadiance}
      #endif
      #include <logdepthbuf_pars_fragment>
      #ifdef WATER_SHORE_SHADOW
        #include <packing>
        #include <shadowmap_pars_fragment>
        uniform bool receiveShadow;
      #endif
      uniform float directFraction;
      uniform float time;
      uniform vec4 shortWaveNumbers;
      #ifdef WATER_SPECTRUM
        uniform sampler2D gravityField, rippleField;
        uniform bool spectrumReady;
        uniform sampler2D slopeReflectance;
        uniform bool reflectanceReady;
        uniform float rippleRms;
        uniform vec2 rippleDownwind;

        // The linear mip chain averages slopes and their second moments together.
        vec2 meanSlope(vec4 sampleValue) {
          return (sampleValue.rg - 0.5) * (255.0 / 36.0);
        }
        vec2 slopeVariance(vec4 sampleValue, vec2 mean) {
          vec2 moment = (sampleValue.ba * 255.0 - vec2(1, 32)) / vec2(28, 23);
          return max(moment - mean*mean, vec2(0));
        }
      #endif
      uniform sampler2D reflectionMap;
      uniform sampler2D reflectionDepth;
      uniform mat4 reflectionMatrix;
      uniform vec3 reflectionEye;
      uniform bool hasReflection;
      uniform vec3 sunlight;
      uniform vec3 sunColor;
      uniform sampler2D skyMap;
      uniform bool hasSky;
      uniform float skyWeight;
      uniform float skyYaw;
      #ifdef WATER_SAMPLE
        varying vec3 samplePosition;
        uniform vec3 waterSampleArea, waterReflectance, horizontalDiffuse;
        uniform float waterGravityGain;
      #endif
      uniform vec3 deep;
      uniform vec3 horizon;
      varying vec3 surfacePosition;
      ${surfaceNoise}
      float hash(vec2 cell) {
        vec3 seed = fract(vec3(cell.xyx) * vec3(0.1031,0.1030,0.0973));
        seed += dot(seed, seed.yzx + 33.33);
        return fract((seed.x + seed.y) * seed.z);
      }
      // 平滑噪声的解析梯度让波峰自然断开，同一组法线用于天空反射和掠射角。
      vec2 slope(vec2 p, out float resolved) {
        vec2 cell = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
        float a = hash(cell), b = hash(cell+vec2(1,0));
        float c = hash(cell+vec2(0,1)), d = hash(cell+vec2(1,1));
        vec2 gradient = vec2(mix(b-a,d-c,u.y), mix(c-a,d-b,u.x));
        float footprint = max(fwidth(p.x),fwidth(p.y));
        resolved = 1.0-smoothstep(0.3,1.1,footprint);
        return gradient * 6.0*f*(1.0-f) * resolved;
      }
      // Pack the symmetric 2D covariance as (xx, xy, yy).
      vec3 secondMoment(vec2 v) { return vec3(v.x*v.x, v.x*v.y, v.y*v.y); }

      // The pixel average of a cosine retains sinc(half the phase span) along each screen axis.
      vec4 wavePixelFilter(vec4 phase) {
        vec4 halfX = max(0.5 * abs(dFdx(phase)), vec4(0.0001));
        vec4 halfY = max(0.5 * abs(dFdy(phase)), vec4(0.0001));
        vec4 widest = max(halfX, halfY);
        vec4 cutoff = 1.0 - smoothstep(vec4(0.5 * PI), vec4(PI), widest);
        return (sin(halfX) / halfX) * (sin(halfY) / halfY) * cutoff;
      }

      vec2 reflectionGradient(vec2 slopeDelta, vec3 normal, vec3 eye, float reach, vec2 uv, float w) {
        vec3 dn = vec3(slopeDelta.x, 0.0, slopeDelta.y);
        dn = (dn - normal * dot(normal, dn)) * normal.y;
        vec3 rayDelta = 2.0 * (dot(eye, dn) * normal + dot(eye, normal) * dn);
        vec4 clipDelta = reflectionMatrix * vec4(reach * rayDelta, 0.0);
        return (clipDelta.xy - uv * clipDelta.w) / max(w, 0.001);
      }
      #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
        float mirrorDepth(vec4 clip) {
          vec2 uv = clamp(clip.xy / max(clip.w, 0.001), 0.0, 1.0);
          float encoded = texture2D(reflectionDepth, uv).r;
          return exp2(encoded * (2.0 / logDepthBufFC)) - 1.0;
        }
      #endif
      // 非偏振光从空气进入淡水时，两个偏振方向反射率的平均值。
      float waterFresnel(float cosine) {
        const float ior = 1.333;
        float transmitted = sqrt(1.0 - (1.0 - cosine*cosine)/(ior*ior));
        float perpendicular = (cosine - ior*transmitted)/(cosine + ior*transmitted);
        float parallel = (ior*cosine - transmitted)/(ior*cosine + transmitted);
        return 0.5 * (perpendicular*perpendicular + parallel*parallel);
      }
      uniform vec2 fadeRange;
      #ifdef WATER_SPECTRUM
        uniform vec2 waterPixelStep;
      #endif
      vec4 sampleWater(vec3 point) {
        vec2 p = point.xz;
        vec3 toEye = cameraPosition - point;
        float range = length(toEye);
        vec3 eye = toEye / max(range, 0.001);
        mat2 wind = mat2(0.80,-0.60,0.60,0.80);
        vec2 meters = wind*p;
        float swellFilter, chopFilter, fineFilter;
        vec2 swell = slope(meters*vec2(0.065,0.14) - time*vec2(0.018,0.09),swellFilter);
        vec2 chop = slope(meters*vec2(0.47,0.94) - time*vec2(0.05,0.45),chopFilter);
        mat2 crosswind = mat2(0.86,0.51,-0.51,0.86);
        vec2 fine = slope((crosswind*meters)*vec2(3.2,6.8) - time*vec2(0.3,2.1),fineFilter);
        // 两个短波频段各有一对不同方向的波列，叠加处形成有限长度的波峰。
        // 米制波数 k 对应重力波角频率 sqrt(g * length(k))。
        const vec2 k0 = vec2(3.6, 13.2), k1 = vec2(-2.45, 9.9);
        vec2 k2 = shortWaveNumbers.xy, k3 = shortWaveNumbers.zw;
        vec4 phase = vec4(dot(meters,k0), dot(meters,k1), dot(meters,k2), dot(meters,k3))
                   - time*vec4(11.59,10.00,16.98,14.78)
                   + 2.8*swell.yxyx + 2.3*chop.xyyx;
        vec4 resolved = wavePixelFilter(phase);
        vec4 waves = cos(phase) * resolved;
        vec2 slope0 = 0.0336*normalize(k0), slope1 = 0.0252*normalize(k1);
        vec2 slope2 = 0.0248*normalize(k2), slope3 = 0.0186*normalize(k3);
        vec2 rippleSlope = waves.x*slope0 + waves.y*slope1 + waves.z*slope2 + waves.w*slope3;
        float gust = clamp(0.81 + 0.31*swell.x, 0.48, 1.12);
        float gravityGain = 1.0;
        #ifdef WATER_SAMPLE
          float sampleRange = distance(samplePosition.xy, waterSampleArea.xy);
          float weight = samplePosition.z * (1.0 - smoothstep(0.8 * waterSampleArea.z, waterSampleArea.z, sampleRange));
          gravityGain = mix(1.0, waterGravityGain, weight);
        #endif
        vec2 gravitySlope = gravityGain * (0.015*swell + 0.030*chop);
        vec2 normalXZ = (gravitySlope + gust*(rippleSlope + 0.034*(fine*crosswind))) * wind;
        #ifdef WATER_SPECTRUM
          float spectrumWeight = spectrumReady ? samplePosition.z : 0.0;
          vec3 spectralVariance = vec3(0);
          if (spectrumReady) {
            mat2 direction = mat2(rippleDownwind.y, rippleDownwind.x, -rippleDownwind.x, rippleDownwind.y);
            // Long, smooth phase offsets break the repeat of the wave scans while retaining wind direction.
            vec2 drift=vec2(surfaceField(meters*.013),surfaceField(meters*.019+37.0))-.5;
            vec4 longWaves = texture2D(gravityField, (meters + 7.2*drift - vec2(0.13,1.28) * time) / 32.0);
            vec4 shortWaves = texture2D(rippleField, (direction * meters + 2.6*drift.yx - vec2(0.09,0.70) * time) / 8.0);
            vec2 longMean = meanSlope(longWaves), shortMean = meanSlope(shortWaves);
            // Keep wind-aligned variation continuous. The slope variance squares this amplitude
            // before the grazing-angle reflectance lookup, magnifying contrast across the bay.
            vec2 windMeters = direction * meters;
            vec2 fetchPatch = windMeters / vec2(24.0, 82.0) + 0.72*drift;
            float exposure = surfaceField(fetchPatch);
            float longRms = gravityGain * 0.01828;
            float shortRms = gust * rippleRms * mix(.60, .92, exposure);
            vec2 reservoirSlope = longRms * longMean + shortRms * (shortMean * direction);
            normalXZ = mix(normalXZ, reservoirSlope * wind, spectrumWeight);
            vec2 longVariance = slopeVariance(longWaves, longMean) * longRms * longRms;
            vec2 shortVariance = slopeVariance(shortWaves, shortMean) * shortRms * shortRms;
            spectralVariance = vec3(longVariance.x, 0.0, longVariance.y)
                             + shortVariance.x * secondMoment(vec2(1,0) * direction)
                             + shortVariance.y * secondMoment(vec2(0,1) * direction);
          }
          // The LUT stores a signed 16-bit angular displacement in G/B.
          // Keep its decoded direction separate from the Fresnel response in R.
          vec4 slopeLookup = vec4(1.0, 0.5, 0.0, 1.0);
        #endif
        vec3 normal = normalize(vec3(normalXZ.x, 1.0, normalXZ.y));
        vec3 reflected = reflect(-eye, normal);
        // At grazing angles the slope on the flat map mesh can aim below the water.
        // Fold that ray above the horizon and use its half-vector for Fresnel and filtering.
        if (eye.y > 0.0 && reflected.y < 0.0) {
          // (eye + foldedRay) / 2, avoiding cancellation between nearly opposite rays.
          vec3 halfDir = dot(eye, normal) * normal;
          halfDir.y -= reflected.y;
          normal = normalize(halfDir);
          reflected.y = -reflected.y;
        }
        #ifdef WATER_SPECTRUM
          if (spectrumWeight > 0.0 && reflectanceReady) {
            vec2 azimuth = wind * eye.xz / max(length(eye.xz), 1e-5);
            float variance = dot(spectralVariance, secondMoment(azimuth) * vec3(1, 2, 1));
            float sigma = sqrt(max(variance, 0.0));
            vec2 size = vec2(textureSize(slopeReflectance, 0));
            vec2 entry = vec2(sqrt(clamp(dot(eye, normal), 0.0, 1.0)),
                              pow(min(sigma / 6.0, 1.0), 1.0 / 3.0));
            vec2 lookupUv = (entry * (size - 1.0) + 0.5) / size;
            slopeLookup = texture2D(slopeReflectance, lookupUv);
            float encodedDirection =
              (dot(slopeLookup.gb, vec2(65280.0, 255.0)) - 32768.0) / 32767.0;
            float shift = encodedDirection * PI * spectrumWeight;
            float cosine = clamp(dot(eye, normal), 0.0, 1.0);
            vec3 tangent = normal - reflected * cosine;
            reflected = normalize(
              cos(shift) * reflected
              + sin(shift) * tangent / max(length(tangent), 1.0e-6)
            );
          }
        #endif
        vec3 sky = horizon;
        if (hasSky) {
          float c = cos(skyYaw), s = sin(skyYaw);
          vec3 skyRay = vec3(reflected.x, max(0.025,reflected.y), reflected.z);
          skyRay.xz = mat2(c,s,-s,c)*skyRay.xz;
          sky = mix(horizon, texture2D(skyMap, equirectUv(normalize(skyRay))).rgb, skyWeight);
        }
        if (hasReflection) {
          // 在世界坐标中偏转反射光线，再投到镜像相机。近处可看清波纹切开的楼影，
          // 接近对岸时逐渐收紧偏移，让建筑在水线处接上自己的倒影。
          vec3 flatRay = vec3(-eye.x, eye.y, -eye.z);
          #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
            vec4 flatClip = reflectionMatrix * vec4(point, 1.0);
            vec3 eyeShift = cameraPosition - reflectionEye;
            eyeShift.y = -eyeShift.y;
            // Project the wave ray into the last mirror capture, including camera motion.
            vec3 bend = range * (reflected - flatRay) - eyeShift;
            vec4 clipDelta = reflectionMatrix * vec4(bend, 0.0);
            float flatDepth = mirrorDepth(flatClip);
            float fraction = clamp((flatDepth - flatClip.w) / max(0.001, flatDepth + clipDelta.w), 0.0, 1.0);
            // A tilted wave can see a pier in front of the shore seen by the flat ray.
            // The nearer of the two depths keeps the shore from bleeding through its reflection.
            float tiltedDepth = mirrorDepth(flatClip + fraction * clipDelta);
            // A foreground texel in front of the water cannot be a hit along this reflected ray.
            float depth = tiltedDepth >= flatClip.w ? min(flatDepth, tiltedDepth) : flatDepth;
            fraction = clamp((depth - flatClip.w) / max(0.001, depth + clipDelta.w), 0.0, 1.0);
            float projectedReach = range * fraction;
            vec3 samplePoint = point + bend * fraction;
          #else
            float projectedReach = range * 110.0 / (110.0 + range);
            vec3 samplePoint = point + (reflected-flatRay)*projectedReach;
          #endif
          vec4 clip = reflectionMatrix * vec4(samplePoint, 1.0);
          vec2 uv = clip.xy / max(0.001,clip.w);
          vec2 edge = smoothstep(vec2(0.0),vec2(0.028),min(uv,1.0-uv));
          // Unresolved wave slopes still spread reflected light. Each cosine
          // contributes half its squared amplitude to the slope variance.
          vec4 lost = 0.5 * gust*gust * (1.0-resolved*resolved);
          vec3 variance = lost.x*secondMoment(slope0) + lost.y*secondMoment(slope1)
                        + lost.z*secondMoment(slope2) + lost.w*secondMoment(slope3);
          // A smoothstep-interpolated uniform noise field has slope variance 26/175 per axis.
          float gravityVariance = 0.015*0.015*(1.0-swellFilter*swellFilter)
                                + 0.030*0.030*(1.0-chopFilter*chopFilter);
          float noise = (26.0/175.0) * (gravityGain*gravityGain*gravityVariance
                      + 0.034*0.034*gust*gust*(1.0-fineFilter*fineFilter));
          variance.xz += noise;
          #ifdef WATER_SPECTRUM
            variance = mix(variance, spectralVariance, spectrumWeight);
          #endif
          float sx = sqrt(max(variance.x,0.0));
          float shear = variance.y/max(sx,1e-8);
          float sz = sqrt(max(0.0,variance.z-shear*shear));
          vec2 spreadX = reflectionGradient(vec2(sx,shear)*wind,normal,eye,projectedReach,uv,clip.w);
          vec2 spreadY = reflectionGradient(vec2(0.0,sz)*wind,normal,eye,projectedReach,uv,clip.w);
          vec2 footprintUv = uv;
          #ifdef WATER_SPECTRUM
            // The sampled moments already include normal variation within the pixel.
            vec4 plane = reflectionMatrix * vec4(point, 1.0);
            footprintUv = mix(uv, plane.xy / max(plane.w, 0.001), spectrumWeight);
          #endif
          vec3 footprint = secondMoment(dFdx(footprintUv)) + secondMoment(dFdy(footprintUv))
                         + 12.0*(secondMoment(spreadX)+secondMoment(spreadY));
          // Factor the combined footprint into the two gradients consumed by the anisotropic sampler.
          float width = sqrt(max(footprint.x,1e-16));
          float crossTerm = footprint.y/width;
          vec2 gradX = vec2(width,crossTerm);
          vec2 gradY = vec2(0.0,sqrt(max(0.0,footprint.z-crossTerm*crossTerm)));
          sky = mix(sky, textureGrad(reflectionMap,clamp(uv,0.001,0.999),gradX,gradY).rgb,
                    edge.x*edge.y*step(0.001,clip.w));
        }
        float cosine = clamp(dot(eye,normal),0.0,1.0);
        float fresnel = waterFresnel(cosine);
        #ifdef WATER_SPECTRUM
          if (spectrumWeight > 0.0 && reflectanceReady) {
            fresnel = mix(fresnel, slopeLookup.r, spectrumWeight);
          }
        #endif
        vec3 halfVector = normalize(eye + sunlight);
        float nh = max(0.0,dot(normal,halfVector));
        // 风浪斜率近似高斯分布。只在满足镜面反射的浪面上形成太阳闪光。
        float nl = max(dot(normal,sunlight),0.0);
        float nh2 = max(nh*nh, 0.0001);
        const float slopeVariance = 0.008;
        float distribution = exp(-(1.0-nh2)/(slopeVariance*nh2)) / (slopeVariance*nh2*nh2);
        // 低矮的波面在掠射方向彼此遮蔽。光源颜色已包含 1/π。
        float visibleSlopes = min(1.0, 2.0*nh*min(nl,cosine) / max(0.0001,dot(eye,halfVector)));
        float shine = distribution * visibleSlopes / max(0.0001,4.0*cosine)
                    * waterFresnel(clamp(dot(eye,halfVector),0.0,1.0));
        vec3 bodyColor = deep;
        #ifdef WATER_SAMPLE
          vec3 measured = waterReflectance * horizontalDiffuse / (0.84 + 0.12 * max(sunlight.y,0.0));
          bodyColor = mix(bodyColor, measured, weight);
        #endif
        vec3 water = bodyColor*(0.84 + 0.12*swell.y + 0.12*max(dot(normal,sunlight),0.0));
        float visibility = 1.0;
        #if defined(WATER_SHORE_SHADOW) && defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
          if (receiveShadow) {
            DirectionalLightShadow sun = directionalLightShadows[0];
            visibility = getShadow(directionalShadowMap[0], sun.shadowMapSize, sun.shadowIntensity,
                                   sun.shadowBias, sun.shadowRadius, vDirectionalShadowCoord[0]);
          }
        #endif
        // 遮挡只衰减直射照亮的水体与太阳高光，镜像相机已记录岸楼自身的明暗。
        water *= mix(1.0 - directFraction, 1.0, visibility);
        vec3 color = mix(water,sky,fresnel) + sunColor * shine * visibility;
        float distanceFade = 1.0 - smoothstep(fadeRange.x, fadeRange.y, range);
        return vec4(color, 0.96 * distanceFade);
      }
      void main() {
        #include <logdepthbuf_fragment>
        #ifdef WATER_SPECTRUM
          // Intersect a quarter-pixel camera offset with the horizontal water plane.
          // Computing it from the projection keeps the wave textures' implicit derivatives valid.
          vec3 ray = surfacePosition - cameraPosition;
          vec3 shift = (vec3(waterPixelStep, 0.0) * mat3(viewMatrix)) / gl_FragCoord.w;
          float height = max(abs(ray.y), max(2.0 * abs(shift.y), 1e-5));
          vec2 offset = shift.xz - ray.xz * (sign(ray.y) * shift.y / height);
          vec3 delta = vec3(offset.x, 0.0, offset.y);
          gl_FragColor = 0.5 * (sampleWater(surfacePosition - delta) + sampleWater(surfacePosition + delta));
        #else
          gl_FragColor = sampleWater(surfacePosition);
        #endif
        #ifdef OFFSHORE_WATER
          vec3 offshoreRay = surfacePosition - cameraPosition;
          float offshoreDistance = length(offshoreRay);
          // By the time the mapped sea starts to replace imagery at 1.8 km,
          // unresolved waves on both representations should reflect the same sky.
          if (offshoreDistance > 900.0 && hasSky && oceanReady > 0.0 &&
              all(greaterThanEqual(seaUv,vec2(0))) && all(lessThanEqual(seaUv,vec2(1)))) {
            float seaCoverage = texture2D(oceanMask,seaUv).r * smoothstep(900.0,1800.0,offshoreDistance);
            if (seaCoverage > 0.0 && hasReflection) {
              // Keep the captured silhouettes of ships or land against the open sky.
              vec4 clip = reflectionMatrix * vec4(surfacePosition,1.0);
              vec2 uv = clip.xy / max(clip.w,0.001);
              if (clip.w > 0.0 && all(greaterThanEqual(uv,vec2(0))) && all(lessThanEqual(uv,vec2(1))) &&
                  texture2D(reflectionDepth,uv).r < 1.0) seaCoverage = 0.0;
            }
            if (seaCoverage > 0.0) {
              offshoreRay /= offshoreDistance;
              float cs = cos(skyYaw), sn = sin(skyYaw);
              offshoreRay.xz = mat2(cs,sn,-sn,cs) * offshoreRay.xz;
              gl_FragColor.rgb = mix(gl_FragColor.rgb,openSeaRadiance(offshoreRay,deep),seaCoverage);
            }
          }
        #endif
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  if (measuredRipples !== undefined) {
    const loader = new THREE.TextureLoader();
    let count = 0;
    const loaded = () => {
      material.uniforms.spectrumReady!.value = ++count === 2;
    };
    const textures = [gravityField, rippleField].map((url) => {
      const texture = loader.load(url, loaded);
      texture.flipY = false;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 8;
      return texture;
    });
    material.uniforms.gravityField!.value = textures[0];
    material.uniforms.rippleField!.value = textures[1];
    const table = loader.load(reservoirReflectance, () => {
      material.uniforms.reflectanceReady!.value = true;
    });
    table.flipY = false;
    table.generateMipmaps = false;
    table.minFilter = THREE.LinearFilter;
    material.uniforms.slopeReflectance!.value = table;
    material.addEventListener('dispose', () => {
      textures.forEach((texture) => texture.dispose());
      table.dispose();
    });
  }
  if (offshore) Object.assign(material.defaultAttributeValues, { offshoreUv: [-1, -1] });
  if (sample) Object.assign(material.defaultAttributeValues, { sampledWater: [0] });
  material.onBeforeRender = (renderer, scene, camera) => {
    if (measuredRipples !== undefined) {
      const step = material.uniforms.waterPixelStep!.value;
      if (camera instanceof THREE.PerspectiveCamera) {
        renderer.getCurrentViewport(viewport);
        const p = camera.projectionMatrix.elements;
        step.set(0.5 / (p[0]! * viewport.z), 0.5 / (p[5]! * viewport.w));
      } else {
        step.set(0, 0);
      }
    }
    const key = scene.children.find((o) => o.name === 'light:key');
    if (sample) {
      const light = key?.userData.horizontalDiffuse;
      const diffuse = material.uniforms.horizontalDiffuse!.value;
      if (light instanceof THREE.Color) diffuse.copy(light);
      else diffuse.setRGB(1, 1, 1);
    }
    if (key instanceof THREE.DirectionalLight) {
      material.uniforms.sunlight!.value.copy(key.position).sub(key.target.position).normalize();
      material.uniforms.sunColor!.value.copy(key.color).multiplyScalar(key.intensity / Math.PI);
    }
    material.uniforms.directFraction!.value =
      key instanceof THREE.DirectionalLight && key.castShadow
        ? (key.userData.directFraction ?? 0)
        : 0;
    const sky = scene.background;
    const hasSky =
      sky instanceof THREE.Texture && sky.mapping === THREE.EquirectangularReflectionMapping;
    const radiance = hasSky ? skyRadiance.get(sky) : undefined;
    material.uniforms.skyMap!.value = radiance ?? (hasSky ? sky : null);
    material.uniforms.skyWeight!.value = radiance ? 1 : 0.72;
    material.uniforms.hasSky!.value = hasSky;
    material.uniforms.skyYaw!.value = scene.backgroundRotation.y;
  };
  return material;
}
