const coarseSun =
  'defined(USE_SHADOWMAP) && defined(SHADOWMAP_TYPE_PCF) && NUM_DIR_LIGHT_SHADOWS == 1 && NUM_SPOT_LIGHT_SHADOWS == 0';

/** Compare each neighbouring shadow depth at its own point on the receiver plane. */
export function facadeShadow(shader: { vertexShader: string; fragmentShader: string }) {
  const varying = `#if ${coarseSun}\nvarying float coarseSunShadow;\n#endif\n`;
  shader.vertexShader =
    varying +
    shader.vertexShader.replace(
      '#include <shadowmap_vertex>',
      /* glsl */ `#include <shadowmap_vertex>
    #if ${coarseSun}
      mat4 sunMatrix = directionalShadowMatrix[0];
      vec3 uAxis = vec3(sunMatrix[0].x, sunMatrix[1].x, sunMatrix[2].x);
      // The orthographic matrix maps metres to UV. Use plane filtering
      // once a texel spans at least half a metre across a building.
      float texelsPerMeter = length(uAxis) * directionalLightShadows[0].shadowMapSize.x;
      coarseSunShadow = step(texelsPerMeter, 2.0);
      if (coarseSunShadow > 0.5) {
        vec3 offset = shadowWorldNormal * (0.3 * directionalLightShadows[0].shadowNormalBias);
        vDirectionalShadowCoord[0] = sunMatrix * (worldPosition + vec4(offset, 0.0));
      }
    #endif`,
    );
  shader.fragmentShader =
    varying +
    shader.fragmentShader.replace(
      '#include <shadowmap_pars_fragment>',
      /* glsl */ `#include <shadowmap_pars_fragment>
    #if ${coarseSun}
      float facadeDepthTap(sampler2DShadow map, vec2 texel, vec2 offset, vec2 size,
                           float depth, vec2 slope) {
        return texture(map, vec3((texel + offset + 0.5) / size, depth + dot(slope, offset)));
      }
      float facadeSunShadow(sampler2DShadow map, vec2 size, float intensity, float bias,
                            float radius, vec4 coord) {
        if (coarseSunShadow < 0.5) return getShadow(map, size, intensity, bias, radius, coord);
        vec3 p = coord.xyz / coord.w;
        vec2 texel = p.xy * size - 0.5;
        vec3 dx = dFdx(vec3(texel, p.z)), dy = dFdy(vec3(texel, p.z));
        float determinant = dx.x * dy.y - dx.y * dy.x;
        vec2 slope = abs(determinant) > 1e-9
          ? vec2(dx.z * dy.y - dx.y * dy.z, dx.x * dy.z - dx.z * dy.x) / determinant
          : vec2(0.0);
        // At a silhouette the projection can be singular. Bound extrapolation
        // to a small fraction of the directional light's depth interval.
        slope = clamp(slope, vec2(-0.003), vec2(0.003));
        if (any(lessThan(p,vec3(0.0))) || any(greaterThan(p,vec3(1.0)))) return 1.0;
        vec2 f = fract(texel);
        float z = p.z + bias;
        float a = facadeDepthTap(map, texel, -f, size, z, slope);
        float b = facadeDepthTap(map, texel, vec2(1.0, 0.0) - f, size, z, slope);
        float c = facadeDepthTap(map, texel, vec2(0.0, 1.0) - f, size, z, slope);
        float d = facadeDepthTap(map, texel, 1.0 - f, size, z, slope);
        return mix(1.0, mix(mix(a,b,f.x), mix(c,d,f.x), f.y), intensity);
      }
      #define getShadow facadeSunShadow
    #endif`,
    );
}
