import * as THREE from 'three';
import type { MapReflection } from './mapReflection';
import { KEY_LIGHT } from './lighting';

/** 同一片水域共用米制波纹坐标；像素覆盖超过波长时逐渐滤掉细纹。 */
export function mapWaterMaterial(hologram: boolean, reflection?: MapReflection) {
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    forceSinglePass: true,
    transparent: true,
    depthWrite: false,
    uniforms: {
      reflectionMap: { value: reflection?.texture ?? null },
      reflectionMatrix: { value: reflection?.matrix ?? new THREE.Matrix4() },
      hasReflection: { value: false },
      sunlight: { value: new THREE.Vector3(...KEY_LIGHT.direction).normalize() },
      sunColor: { value: new THREE.Color(0xfff7e3) },
      time: { value: 0 },
      skyMap: { value: null },
      hasSky: { value: false },
      skyYaw: { value: 0 },
      deep: { value: new THREE.Color(hologram ? '#174351' : '#325553') },
      horizon: { value: new THREE.Color(hologram ? '#a999b4' : '#acc6ce') },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 surfacePosition;
      void main() {
        surfacePosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float time;
      uniform sampler2D reflectionMap;
      uniform mat4 reflectionMatrix;
      uniform bool hasReflection;
      uniform vec3 sunlight;
      uniform vec3 sunColor;
      uniform sampler2D skyMap;
      uniform bool hasSky;
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
        // 长波调制短波的相位和强度，让同一片水上有阵风吹皱和相对平静的区域。
        // 约 46 和 21 厘米的两组短波，频率按深水重力波的色散关系取值。
        vec2 phase = vec2(dot(meters,vec2(3.6,13.2)),dot(meters,vec2(-11.4,27.1)))
                   - time*vec2(11.6,17.0);
        vec2 resolved = 1.0-smoothstep(vec2(0.5),vec2(3.14),fwidth(phase));
        vec2 ripple = cos(phase + 2.8*swell.yx + 2.3*chop) * resolved;
        float gust = clamp(0.81 + 0.31*swell.x, 0.48, 1.12);
        vec2 normalXZ = (0.015*swell + 0.030*chop + gust *
          (0.042*ripple.x*vec2(0.263,0.965) + 0.031*ripple.y*vec2(-0.388,0.922)
           + 0.034*(fine*crosswind))) * wind;
        vec3 normal = normalize(vec3(normalXZ.x, 1.0, normalXZ.y));
        vec3 reflected = reflect(-eye, normal);
        vec3 sky = horizon;
        if (hasSky) {
          float c = cos(skyYaw), s = sin(skyYaw);
          vec3 skyRay = vec3(reflected.x, max(0.025,reflected.y), reflected.z);
          skyRay.xz = mat2(c,s,-s,c)*skyRay.xz;
          sky = mix(horizon, texture2D(skyMap, equirectUv(normalize(skyRay))).rgb, 0.72);
        }
        if (hasReflection) {
          // 在世界坐标中偏转反射光线，再投到镜像相机。近处可看清波纹切开的楼影，
          // 接近对岸时逐渐收紧偏移，让建筑在水线处接上自己的倒影。
          vec3 flatRay = vec3(-eye.x, eye.y, -eye.z);
          const float reflectionReach = 110.0; // 米，近似湾岸建筑的有效反射距离
          float projectedReach = range * reflectionReach / (reflectionReach + range);
          vec3 samplePoint = surfacePosition + (reflected-flatRay)*projectedReach;
          vec4 clip = reflectionMatrix * vec4(samplePoint, 1.0);
          vec2 uv = clip.xy / max(0.001,clip.w);
          vec2 edge = smoothstep(vec2(0.0),vec2(0.028),min(uv,1.0-uv));
          // 消失在一个像素内的短波只轻微扩大楼影的采样足迹，保留岸线倒影。
          float unresolved = dot(1.0-resolved*resolved, vec2(0.65,0.35));
          float footprintScale = 1.0 + 0.48*gust*unresolved;
          sky = mix(sky, textureGrad(reflectionMap,clamp(uv,0.001,0.999),
                    dFdx(uv)*footprintScale,dFdy(uv)*footprintScale).rgb,
                    edge.x*edge.y*step(0.001,clip.w));
        }
        float cosine = clamp(dot(eye,normal),0.0,1.0);
        float fresnel = 0.025 + 0.93*pow(1.0-cosine,5.0);
        vec3 halfVector = normalize(eye + sunlight);
        float nh = max(0.0,dot(normal,halfVector));
        float alpha2=0.008;
        float d=1.0-nh*nh*(1.0-alpha2);
        float shine = alpha2/(3.14159*d*d) * 0.035 * max(dot(normal,sunlight),0.0);
        vec3 water = deep*(0.84 + 0.12*swell.y + 0.12*max(dot(normal,sunlight),0.0));
        vec3 color = mix(water,sky,fresnel) + sunColor * shine * 0.38;
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
    const sky = scene.background;
    const hasSky =
      sky instanceof THREE.Texture && sky.mapping === THREE.EquirectangularReflectionMapping;
    material.uniforms.skyMap!.value = hasSky ? sky : null;
    material.uniforms.hasSky!.value = hasSky;
    material.uniforms.skyYaw!.value = scene.backgroundRotation.y;
  };
  return material;
}
