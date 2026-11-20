import * as THREE from 'three';

/** 同一片水域共用米制波纹坐标；像素覆盖超过波长时逐渐滤掉细纹。 */
export function mapWaterMaterial(hologram: boolean) {
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    forceSinglePass: true,
    transparent: true,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      skyMap: { value: null },
      hasSky: { value: false },
      skyYaw: { value: 0 },
      deep: { value: new THREE.Color(hologram ? '#174351' : '#285855') },
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
        vec2 swell = slope(p*vec2(0.028,0.085) + time*vec2(0.015,0.08));
        vec2 waves = slope((wind*p)*vec2(0.14,0.48) - time*vec2(0.025,0.21) + 0.3*swell);
        vec2 normalXZ = 0.027*swell + 0.047*(waves*wind);
        vec3 normal = normalize(vec3(normalXZ.x, 1.0, normalXZ.y));
        vec3 reflected = reflect(-eye, normal);
        vec3 sky = horizon;
        if (hasSky) {
          float c = cos(skyYaw), s = sin(skyYaw);
          reflected.xz = mat2(c,s,-s,c)*reflected.xz;
          reflected.y = max(0.025,reflected.y);
          sky = mix(horizon, texture2D(skyMap, equirectUv(normalize(reflected))).rgb, 0.72);
        }
        float fresnel = 0.055 + 0.51*pow(1.0-clamp(dot(eye,normal),0.0,1.0),3.5);
        vec3 color = mix(deep * (1.0 + 0.06*swell.y), sky, fresnel);
        // 保留部分航拍影像中的船影、浅滩和码头细节。
        float distanceFade = 1.0 - smoothstep(3500.0, 11000.0, distance(cameraPosition, surfacePosition));
        gl_FragColor = vec4(color, 0.83 * distanceFade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  material.onBeforeRender = (_renderer, scene) => {
    const sky = scene.background;
    const hasSky =
      sky instanceof THREE.Texture && sky.mapping === THREE.EquirectangularReflectionMapping;
    material.uniforms.skyMap!.value = hasSky ? sky : null;
    material.uniforms.hasSky!.value = hasSky;
    material.uniforms.skyYaw!.value = scene.backgroundRotation.y;
  };
  return material;
}
