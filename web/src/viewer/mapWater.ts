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
        vec3 eye = normalize(cameraPosition - surfacePosition);
        mat2 wind = mat2(0.80,-0.60,0.60,0.80);
        vec2 swell = slope(p*vec2(0.043,0.12) + time*vec2(0.021,0.09));
        vec2 waves = slope((wind*p)*vec2(0.23,0.64) - time*vec2(0.04,0.32) + 0.42*swell);
        // 两个风向的短波随像素足迹平滑衰减，防止远处闪点。
        vec2 phase = vec2(dot(p,vec2(1.24,2.55)),dot(p,vec2(-3.53,1.46)))
                   + waves * 1.4 - time*vec2(1.9,2.4);
        vec2 ripple = cos(phase)*(1.0-smoothstep(vec2(0.5),vec2(3.14),fwidth(phase)));
        vec2 normalXZ = 0.037*swell + 0.065*(waves*wind) +
                        0.022*(ripple.x*vec2(0.44,0.90) + ripple.y*vec2(-0.92,0.38));
        vec3 normal = normalize(vec3(normalXZ.x, 1.0, normalXZ.y));
        vec3 reflected = reflect(-eye, normal);
        vec3 sky = horizon;
        if (hasSky) {
          float c = cos(skyYaw), s = sin(skyYaw);
          reflected.xz = mat2(c,s,-s,c)*reflected.xz;
          reflected.y = max(0.025,reflected.y);
          sky = mix(horizon, texture2D(skyMap, equirectUv(normalize(reflected))).rgb, 0.72);
        }
        if (hasReflection) {
          vec4 clip = reflectionMatrix * vec4(surfacePosition, 1.0);
          vec2 uv = clip.xy / max(0.001,clip.w) + normal.xz * 0.055;
          vec2 edge = smoothstep(vec2(0.0),vec2(0.028),min(uv,1.0-uv));
          sky = mix(sky, textureLod(reflectionMap,clamp(uv,0.001,0.999),1.0+1.6*abs(normalXZ.y)).rgb, edge.x*edge.y*step(0.001,clip.w));
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
        float distanceFade = 1.0 - smoothstep(3500.0, 11000.0, distance(cameraPosition, surfacePosition));
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
