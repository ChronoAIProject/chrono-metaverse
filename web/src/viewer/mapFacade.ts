import * as THREE from 'three';

/** 米制视距的空气透视，在海湾尺度上逐渐降低反差。 */
const cityAir = /* glsl */ `
  vec3 cityAir(vec3 light, float meters, vec3 horizon) {
    float transmission = exp2(-max(0.0, meters - 75.0) / 4800.0);
    return mix(light, horizon, min(0.42, 1.0 - transmission));
  }
`;

/** 实景模型既有标准受光材质，也有烘焙为无光照贴图的楼面。 */
export function cityModelAir(material: THREE.Material) {
  if (!(
    material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial
  ))
    return;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'varying vec3 cityEye;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\ncityEye = mvPosition.xyz;',
      );
    shader.fragmentShader =
      'varying vec3 cityEye;\n' +
      cityAir +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        'outgoingLight = cityAir(outgoingLight, length(cityEye), vec3(0.46,0.55,0.62));\n#include <opaque_fragment>',
      );
  };
}

/** 同一瓦片的楼房共用材质，远处小于一个像素的窗框过渡到立面的平均色。 */
export function urbanFacade(material: THREE.MeshLambertMaterial) {
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
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { citySky: panorama, cityHasSky: hasPanorama, citySkyYaw: yaw });
    shader.vertexShader =
      'varying vec3 cityPosition;\nvarying vec3 cityNormal;\nvarying vec2 cityFacade;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        cityPosition = position;
        cityNormal = normal;
        cityFacade = uv;`,
      );
    shader.fragmentShader =
      cityAir +
      'uniform sampler2D citySky;\nuniform bool cityHasSky;\nuniform float citySkyYaw;\nvarying vec3 cityPosition;\nvarying vec3 cityNormal;\nvarying vec2 cityFacade;\n' +
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
        vec3 finish = mix(stone,glazing,panels.x*panels.y);
        diffuseColor.rgb *= mix(stone*0.88,finish,wall);
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
