import { surfaceNoise } from './surfaceVariation';
import * as THREE from 'three';
import detailUrl from '../assets/geography/surface-detail.webp';

export interface GroundAir {
  groundSky: THREE.IUniform<THREE.Texture | null>;
  groundSkyYaw: THREE.IUniform<number>;
  groundAirStrength: THREE.IUniform<number>;
  groundAirHalfDistance: THREE.IUniform<number>;
}

/** 远处的影像按视线长度衰减，散射光取当前方位的实景天际线。 */
export function groundAir(material: THREE.Material, uniforms: GroundAir) {
  const compile = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.customProgramCacheKey = () => key + '/ground-air';
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      'varying vec3 groundView;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\ngroundView = mvPosition.xyz;',
      );
    shader.fragmentShader =
      'varying vec3 groundView;\nuniform sampler2D groundSky;\nuniform float groundSkyYaw, groundAirStrength, groundAirHalfDistance;\n' +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        /* glsl */ `
          float path = max(0.0, length(groundView) - 250.0);
          if (path > 0.0 && groundAirStrength > 0.0) {
            vec3 ray = inverseTransformDirection(normalize(groundView), viewMatrix);
            float c = cos(groundSkyYaw), s = sin(groundSkyYaw);
            ray.xz = mat2(c,s,-s,c) * ray.xz;
            vec3 horizon = texture2D(groundSky, equirectUv(normalize(vec3(ray.x, 0.012, ray.z)))).rgb;
            float scatter = (1.0 - exp2(-path / groundAirHalfDistance)) * groundAirStrength;
            outgoingLight = mix(outgoingLight, horizon, scatter);
          }
          #include <opaque_fragment>`,
      );
  };
}

/** 三种地表扫描共用一张线性数据贴图，平均亮度为中性灰。 */
export function groundDetailTexture(anisotropy: number) {
  const texture = new THREE.TextureLoader().load(detailUrl);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.min(4, anisotropy);
  return texture;
}

/** 米制坐标跨瓦片连续，父影像替换为精细影像时材质颗粒仍在原位。 */
export function urbanGroundMaterial(detail: THREE.Texture, shadow: THREE.Color) {
  const material = new THREE.MeshLambertMaterial({ color: 0x557e8e, toneMapped: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.groundShadow = { value: shadow };
    shader.uniforms.groundDetail = { value: detail };
    shader.vertexShader =
      'varying vec2 groundMeters;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n groundMeters = (modelMatrix * vec4(transformed, 1.0)).xz;',
      );
    shader.fragmentShader =
      surfaceNoise +
      'uniform vec3 groundShadow;\nuniform sampler2D groundDetail;\nvarying vec2 groundMeters;\n' +
      shader.fragmentShader
        .replace(
          '#include <shadowmap_pars_fragment>',
          '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>',
        )
        .replace(
          '#include <opaque_fragment>',
          // 保留航拍影像的日光，只混入场景几何投到地面的阴影。
          'outgoingLight = diffuseColor.rgb * mix(groundShadow, vec3(1.0), getShadowMask());\n#include <opaque_fragment>',
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
        #ifdef USE_MAP
        vec3 photo = diffuseColor.rgb;
        float luminance = dot(photo, vec3(0.2126, 0.7152, 0.0722));
        float grass = smoothstep(0.05, 0.32, (photo.g-photo.b)/max(0.025, luminance))
                    * smoothstep(-0.20, 0.05, (photo.g-photo.r)/max(0.025, luminance));
        float paving = smoothstep(0.10, 0.29, luminance);
        vec3 weights = vec3(grass, (1.0-grass)*paving, (1.0-grass)*(1.0-paving));
        vec2 uv = groundMeters / 2.2;
        vec2 phase = vec2(surfaceField(groundMeters*.09),surfaceField(groundMeters*.07+17.9));
        vec3 micro = texture2D(groundDetail, uv+phase*.48).rgb - 0.5;
        // 放大的第二频段只取无方向的草土起伏，保留铺装接缝的单一朝向。
        float turf = texture2D(groundDetail, mat2(0.8,-0.6,0.6,0.8)*uv*0.18-phase.yx*.25).r - 0.5;
        float visible = 1.0-smoothstep(0.25, 2.0, max(fwidth(uv.x),fwidth(uv.y)));
        diffuseColor.rgb = photo * (1.0 + visible * clamp(2.6 * dot(weights, micro) + grass * 1.2*turf,-0.65,0.85));
        #endif`,
        );
  };
  return material;
}
