import * as THREE from 'three';
import type { MapReflection } from './mapReflection';
import { skyRadiance } from './skyRadiance';
import { KEY_LIGHT } from './lighting';

/** 同一片水域共用米制波纹坐标；像素覆盖超过波长时逐渐滤掉细纹。 */
export function mapWaterMaterial(hologram: boolean, reflection?: MapReflection) {
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    forceSinglePass: true,
    lights: !!reflection,
    defines: reflection ? { WATER_SHORE_SHADOW: 1 } : {},
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...(reflection ? THREE.UniformsUtils.clone(THREE.UniformsLib.lights) : {}),
      directFraction: { value: 0 },
      reflectionMap: { value: reflection?.texture ?? null },
      reflectionDepth: { value: reflection?.depth ?? null },
      reflectionMatrix: { value: reflection?.matrix ?? new THREE.Matrix4() },
      hasReflection: { value: false },
      sunlight: { value: new THREE.Vector3(...KEY_LIGHT.direction).normalize() },
      sunColor: { value: new THREE.Color(0xfff7e3) },
      time: { value: 0 },
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
      varying vec3 surfacePosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        surfacePosition = worldPosition.xyz;
        #ifdef WATER_SHORE_SHADOW
          vec3 transformedNormal = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
          #include <shadowmap_vertex>
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      #ifdef WATER_SHORE_SHADOW
        #include <packing>
        #include <shadowmap_pars_fragment>
        uniform bool receiveShadow;
      #endif
      uniform float directFraction;
      uniform float time;
      uniform sampler2D reflectionMap;
      uniform sampler2D reflectionDepth;
      uniform mat4 reflectionMatrix;
      uniform bool hasReflection;
      uniform vec3 sunlight;
      uniform vec3 sunColor;
      uniform sampler2D skyMap;
      uniform bool hasSky;
      uniform float skyWeight;
      uniform float skyYaw;
      uniform vec3 deep;
      uniform vec3 horizon;
      varying vec3 surfacePosition;
      float hash(vec2 cell) {
        vec3 seed = fract(vec3(cell.xyx) * vec3(0.1031,0.1030,0.0973));
        seed += dot(seed, seed.yzx + 33.33);
        return fract((seed.x + seed.y) * seed.z);
      }
      // 平滑噪声的解析梯度让波峰自然断开，同一组法线用于天空反射和掠射角。
      vec2 slope(vec2 p) {
        vec2 cell = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
        float a = hash(cell), b = hash(cell+vec2(1,0));
        float c = hash(cell+vec2(0,1)), d = hash(cell+vec2(1,1));
        vec2 gradient = vec2(mix(b-a,d-c,u.y), mix(c-a,d-b,u.x));
        float footprint = max(fwidth(p.x),fwidth(p.y));
        return gradient * 6.0*f*(1.0-f) * (1.0-smoothstep(0.3,1.1,footprint));
      }
      // 非偏振光从空气进入淡水时，两个偏振方向反射率的平均值。
      float waterFresnel(float cosine) {
        const float ior = 1.333;
        float transmitted = sqrt(1.0 - (1.0 - cosine*cosine)/(ior*ior));
        float perpendicular = (cosine - ior*transmitted)/(cosine + ior*transmitted);
        float parallel = (ior*cosine - transmitted)/(ior*cosine + transmitted);
        return 0.5 * (perpendicular*perpendicular + parallel*parallel);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = surfacePosition.xz;
        vec3 toEye = cameraPosition - surfacePosition;
        float range = length(toEye);
        vec3 eye = toEye / max(range, 0.001);
        mat2 wind = mat2(0.80,-0.60,0.60,0.80);
        vec2 meters = wind*p;
        vec2 swell = slope(meters*vec2(0.065,0.14) - time*vec2(0.018,0.09));
        vec2 chop = slope(meters*vec2(0.47,0.94) - time*vec2(0.05,0.45));
        mat2 crosswind = mat2(0.86,0.51,-0.51,0.86);
        vec2 fine = slope((crosswind*meters)*vec2(3.2,6.8) - time*vec2(0.3,2.1));
        // 两个短波频段各有一对不同方向的波列，叠加处形成有限长度的波峰。
        // 米制波数 k 对应重力波角频率 sqrt(g * length(k))。
        const vec2 k0 = vec2(3.6, 13.2), k1 = vec2(-2.45, 9.9);
        const vec2 k2 = vec2(-11.4, 27.1), k3 = vec2(9.4, 20.2);
        vec4 phase = vec4(dot(meters,k0), dot(meters,k1), dot(meters,k2), dot(meters,k3))
                   - time*vec4(11.59,10.00,16.98,14.78)
                   + 2.8*swell.yxyx + 2.3*chop.xyyx;
        vec4 resolved = 1.0-smoothstep(vec4(0.5),vec4(3.14),fwidth(phase));
        vec4 waves = cos(phase) * resolved;
        vec2 rippleSlope = 0.0336*waves.x*normalize(k0) + 0.0252*waves.y*normalize(k1)
                         + 0.0248*waves.z*normalize(k2) + 0.0186*waves.w*normalize(k3);
        float gust = clamp(0.81 + 0.31*swell.x, 0.48, 1.12);
        vec2 normalXZ = (0.015*swell + 0.030*chop + gust*(rippleSlope + 0.034*(fine*crosswind))) * wind;
        vec3 normal = normalize(vec3(normalXZ.x, 1.0, normalXZ.y));
        vec3 reflected = reflect(-eye, normal);
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
            vec4 flatClip = reflectionMatrix * vec4(surfacePosition, 1.0);
            vec2 flatUv = clamp(flatClip.xy / max(.001,flatClip.w), 0.0, 1.0);
            // glTF 楼体和岸墙已随倒影写入对数深度。两段视深的比值给出
            // 水面到被反射物体的相对距离，贴岸处的波纹偏转随之收紧。
            float encoded = texture2D(reflectionDepth,flatUv).r;
            float hitDepth = exp2(encoded * (2.0 / logDepthBufFC)) - 1.0;
            float projectedReach = range * clamp(1.0 - flatClip.w / max(.001,hitDepth), 0.0, 1.0);
          #else
            float projectedReach = range * 110.0 / (110.0 + range);
          #endif
          vec3 samplePoint = surfacePosition + (reflected-flatRay)*projectedReach;
          vec4 clip = reflectionMatrix * vec4(samplePoint, 1.0);
          vec2 uv = clip.xy / max(0.001,clip.w);
          vec2 edge = smoothstep(vec2(0.0),vec2(0.028),min(uv,1.0-uv));
          // 消失在一个像素内的短波只轻微扩大楼影的采样足迹，保留岸线倒影。
          float unresolved = dot(1.0-resolved*resolved, vec4(0.416,0.234,0.224,0.126));
          float footprintScale = 1.0 + 0.48*gust*unresolved;
          sky = mix(sky, textureGrad(reflectionMap,clamp(uv,0.001,0.999),
                    dFdx(uv)*footprintScale,dFdy(uv)*footprintScale).rgb,
                    edge.x*edge.y*step(0.001,clip.w));
        }
        float cosine = clamp(dot(eye,normal),0.0,1.0);
        float fresnel = waterFresnel(cosine);
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
        vec3 water = deep*(0.84 + 0.12*swell.y + 0.12*max(dot(normal,sunlight),0.0));
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
        float distanceFade = 1.0 - smoothstep(3500.0, 11000.0, range);
        gl_FragColor = vec4(color, 0.96 * distanceFade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  material.onBeforeRender = (_renderer, scene) => {
    const key = scene.children.find((o) => o.name === 'light:key');
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
