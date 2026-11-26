import * as THREE from 'three';
import { scatterGroundScan, supportsGroundScan } from './groundScan';

/** Lattice corners are computed from integer coordinates shared by adjacent patches. */
export const surfaceNoise = /* glsl */ `
  float surfaceCorner(ivec2 p) {
    uint h = uint(p.x) * 1597334677u ^ uint(p.y) * 3812015801u;
    h = (h ^ (h >> 16u)) * 2246822519u;
    return float((h ^ (h >> 13u)) & 65535u) / 65535.0;
  }
  float surfaceField(vec2 p) {
    ivec2 cell = ivec2(floor(p));
    vec2 w = fract(p);
    w = w*w*(3.0-2.0*w);
    return mix(mix(surfaceCorner(cell),surfaceCorner(cell+ivec2(1,0)),w.x),
               mix(surfaceCorner(cell+ivec2(0,1)),surfaceCorner(cell+ivec2(1,1)),w.x),w.y);
  }
`;

/** Sample opaque weathering and leaf colour in scene metres, independently of the model's UV atlas. */
export function outdoorSurfaceVariation(material: THREE.Material, scatter = false) {
  if (
    !(
      material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial
    ) ||
    !material.map
  )
    return;
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  const foliage = material.alphaTest > 0;
  const strength = foliage ? 0.38 : material.transparent ? 0.08 : 0.24;
  let seed = 0;
  for (const ch of material.name) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0;
  const phase = new THREE.Vector2((seed & 255) * 0.69, ((seed >>> 8) & 255) * 0.83);
  const grain = scatter && supportsGroundScan(material);
  material.customProgramCacheKey = () => key + '|outdoor-surface' + (grain ? '|ground-grain' : '');
  material.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.finishPhase = { value: phase };
    shader.uniforms.finishStrength = { value: strength };
    shader.vertexShader =
      'varying vec3 finishMeters;\n' +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        vec4 finishVertex = vec4(transformed,1.0);
        #ifdef USE_INSTANCING
          finishVertex = instanceMatrix * finishVertex;
        #endif
        finishMeters = (modelMatrix * finishVertex).xyz;`,
      );
    shader.fragmentShader =
      surfaceNoise +
      'varying vec3 finishMeters; uniform vec2 finishPhase; uniform float finishStrength;\n' +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
        vec2 surfacePoint = finishMeters.xz + vec2(.47,.81)*finishMeters.y + finishPhase;
        // Bend the patch boundaries over tens of metres. The smaller grain has a different axis.
        vec2 coarse = mat2(.87,.49,-.49,.87) * surfacePoint * .038;
        float bend = surfaceField(coarse);
        vec2 warped = surfacePoint + vec2(9.0,-5.0) * (bend - .5);
        float moisture = surfaceField(warped * .093);
        float grain = surfaceField(mat2(.60,-.80,.80,.60) * surfacePoint * .33);
        float condition = .54*moisture + .25*grain + .21*bend;
        float variation = (condition - .5) * finishStrength;
        diffuseColor.rgb *= vec3(1.0) + variation*vec3(1.24,1.0,.63);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
        // Polish and weathering follow the same patches as the colour, with
        // less variation at the mirror and matte ends of the measured finish.
        roughnessFactor += 1.45 * (condition - .5) * roughnessFactor * (1.0 - roughnessFactor);`,
        );
    if (grain) shader.fragmentShader = scatterGroundScan(shader.fragmentShader);
  };
}
