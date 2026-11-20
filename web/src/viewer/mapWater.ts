import * as THREE from 'three';

/** 同一片水域共用米制波纹坐标；像素覆盖超过波长时逐渐滤掉细纹。 */
export function mapWaterMaterial(hologram: boolean) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    forceSinglePass: true,
    transparent: true,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      deep: { value: new THREE.Color(hologram ? '#174351' : '#236260') },
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
      uniform vec3 deep;
      uniform vec3 horizon;
      varying vec3 surfacePosition;
      float ripple(float phase) {
        return sin(phase) * (1.0 - smoothstep(0.6, 3.0, fwidth(phase)));
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = surfacePosition.xz;
        vec3 eye = normalize(cameraPosition - surfacePosition);
        float swell = ripple(dot(p, vec2(0.29, 0.43)) + 0.85*time + sin(p.y*0.062));
        float crossWave = ripple(dot(p, vec2(-0.64, 0.36)) - 1.05*time + 1.6*swell);
        float chop = ripple(dot(p, vec2(1.45, 1.84)) + 1.9*time + 1.3*crossWave);
        vec3 normal = normalize(vec3(0.047*swell - 0.031*crossWave, 1.0, 0.058*crossWave + 0.035*chop));
        float grazing = pow(1.0 - clamp(dot(eye, normal), 0.0, 1.0), 3.0);
        vec3 reflected = reflect(-eye, normal);
        float glint = pow(max(0.0, dot(reflected, normalize(vec3(-0.48,0.35,0.81)))), 72.0);
        vec3 color = mix(deep, horizon, 0.12 + 0.72*grazing);
        color += vec3(0.56,0.55,0.48)*glint;
        // 保留部分航拍影像中的船影、浅滩和码头细节。
        float distanceFade = 1.0 - smoothstep(3500.0, 11000.0, distance(cameraPosition, surfacePosition));
        gl_FragColor = vec4(color, 0.83 * distanceFade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
