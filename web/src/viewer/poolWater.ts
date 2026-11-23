import * as THREE from 'three';

/** 在泳池的米制 UV 上移动两组小波，已滤掉的细纹不再扰动远处的倒影。 */
export function poolWater(
  material: THREE.MeshStandardMaterial,
  sky: {
    citySky: THREE.IUniform<THREE.Texture | null>;
    cityHasSky: THREE.IUniform<boolean>;
    citySkyYaw: THREE.IUniform<number>;
  },
) {
  const time = { value: 0 };
  const update = material.onBeforeRender.bind(material);
  material.onBeforeRender = (...args) => {
    update(...args);
    time.value = performance.now() / 1000;
  };
  material.customProgramCacheKey = () => 'city-pool-water';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sky, { poolTime: time });
    shader.fragmentShader =
      declarations +
      shader.fragmentShader
        .replace('#include <map_fragment>', floorLight)
        .replace('#include <normal_fragment_maps>', surfaceNormal)
        .replace('#include <opaque_fragment>', reflection + '\n#include <opaque_fragment>');
  };
}

const declarations = /* glsl */ `
  uniform sampler2D citySky;
  uniform bool cityHasSky;
  uniform float citySkyYaw;
  uniform float poolTime;
`;

const floorLight = /* glsl */ `
  vec2 p = 2.0 * vMapUv;
  mat2 turn = mat2(0.82, 0.572, -0.572, 0.82);
  vec2 a = p * vec2(4.15, 6.30) + vec2(1.65, -1.24) * poolTime;
  vec2 b = (turn * p) * vec2(7.01, 4.37) + vec2(-1.42, 2.00) * poolTime;
  vec2 slow = sin(0.68 * p.yx + vec2(0.34, -0.28) * poolTime);
  a += 1.28 * slow; b += 0.75 * slow.yx;
  vec2 fa = 1.0 - smoothstep(vec2(0.4), vec2(3.14), fwidth(a));
  vec2 fb = 1.0 - smoothstep(vec2(0.4), vec2(3.14), fwidth(b));
  vec2 slope = 0.032 * cos(a) * fa + (0.026 * cos(b) * fb) * turn;
  // Fold the short waves into refracted bands on the pool floor.
  vec2 refracted = p + 0.34 * sin(a) * fa;
  vec2 crestPhase = 7.7 * (turn * refracted) + 0.64 * sin(b) * fb + vec2(0.94,-0.88) * poolTime;
  vec2 resolved = 1.0 - smoothstep(vec2(0.25), vec2(2.5), fwidth(crestPhase));
  vec2 crest = pow(0.5 + 0.5 * cos(crestPhase), vec2(9.0)) * resolved;
  vec3 eye = normalize(vViewPosition);
  float down = clamp(inverseTransformDirection(eye, viewMatrix).y, 0.0, 1.0);
  vec3 bottom = texture2D(map, vMapUv + 0.045 * slope).rgb;
  bottom *= 0.93 + 0.18 * max(crest.x, crest.y) + 0.25 * crest.x * crest.y;
  // A longer oblique path through water attenuates the tiled bottom.
  float visibility = exp(-0.21 / max(0.16, down));
  diffuseColor.rgb *= mix(vec3(0.035,0.145,0.153), bottom, visibility);
`;

const surfaceNormal = /* glsl */ `
  vec3 rippleA = texture2D(normalMap, vNormalMapUv * 0.70 + vec2(.022,-.017)*poolTime).xyz * 2.0 - 1.0;
  vec3 rippleB = texture2D(normalMap, turn*vNormalMapUv * 0.89 - vec2(.019,.032)*poolTime).xyz * 2.0 - 1.0;
  vec2 ripple = 0.24 * (rippleA.xy + rippleB.xy * turn);
  normal = normalize(tbn * normalize(vec3(slope + ripple, 1.0)));
`;

const reflection = /* glsl */ `
  if (cityHasSky) {
    vec3 ray = inverseTransformDirection(reflect(-eye, normal), viewMatrix);
    float c = cos(citySkyYaw), s = sin(citySkyYaw);
    ray.xz = mat2(c,s,-s,c)*ray.xz;
    ray.y = max(0.008,ray.y);
    vec3 sky = texture2D(citySky, equirectUv(normalize(ray))).rgb;
    float fresnel = .021 + .94 * pow(1.0-clamp(dot(eye,normal),0.0,1.0),5.0);
    // Sky is sampled explicitly, so count the environment reflection only once.
    vec3 underwater = totalDiffuse + totalEmissiveRadiance;
    outgoingLight = mix(underwater, sky, fresnel) + reflectedLight.directSpecular * .48;
  }
`;
