import * as THREE from 'three';

/** 同一瓦片的楼房共用材质，远处小于一个像素的窗框过渡到立面的平均色。 */
export function urbanFacade(material: THREE.MeshLambertMaterial) {
  material.onBeforeCompile = (shader) => {
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
      'varying vec3 cityPosition;\nvarying vec3 cityNormal;\nvarying vec2 cityFacade;\n' +
      shader.fragmentShader.replace(
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
      );
  };
}
