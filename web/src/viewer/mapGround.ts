import * as THREE from 'three';
import detailUrl from '../assets/geography/surface-detail.webp';

/** 三种地表扫描共用一张线性数据贴图，平均亮度为中性灰。 */
export function groundDetailTexture(anisotropy: number) {
  const texture = new THREE.TextureLoader().load(detailUrl);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.min(4, anisotropy);
  return texture;
}

/** 米制坐标跨瓦片连续，父影像替换为精细影像时材质颗粒仍在原位。 */
export function urbanGroundMaterial(detail: THREE.Texture) {
  const material = new THREE.MeshLambertMaterial({ color: 0x557e8e, toneMapped: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.groundDetail = { value: detail };
    shader.vertexShader =
      'varying vec2 groundMeters;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n groundMeters = (modelMatrix * vec4(transformed, 1.0)).xz;',
      );
    shader.fragmentShader =
      'uniform sampler2D groundDetail;\nvarying vec2 groundMeters;\n' +
      shader.fragmentShader
        .replace(
          '#include <shadowmap_pars_fragment>',
          '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>',
        )
        .replace(
          '#include <opaque_fragment>',
          // 保留航拍影像的日光，只混入场景几何投到地面的阴影。
          'outgoingLight = diffuseColor.rgb * mix(vec3(0.55,0.61,0.68), vec3(1.0), getShadowMask());\n#include <opaque_fragment>',
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
        vec3 micro = texture2D(groundDetail, uv).rgb - 0.5;
        // 放大的第二频段只取无方向的草土起伏，保留铺装接缝的单一朝向。
        float turf = texture2D(groundDetail, mat2(0.8,-0.6,0.6,0.8)*uv*0.18).r - 0.5;
        float visible = 1.0-smoothstep(0.25, 2.0, max(fwidth(uv.x),fwidth(uv.y)));
        diffuseColor.rgb = photo * (1.0 + visible * clamp(2.6 * dot(weights, micro) + grass * 1.2*turf,-0.65,0.85));
        #endif`,
        );
  };
  return material;
}
