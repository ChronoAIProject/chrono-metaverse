import * as THREE from 'three';
import { filterModelTexture } from './materials';

/** 多重采样的像素用原图遮罩控制覆盖率，已绘制的天空保持不透明。 */
export function cityCutout(material: THREE.Material, anisotropy: number, foliage = false) {
  if (
    !(
      material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial
    ) ||
    material.transparent ||
    material.alphaTest <= 0 ||
    !material.map
  )
    return;
  filterModelTexture(material.map, anisotropy);
  material.alphaToCoverage = true;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.ZeroFactor;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;

  // Mip filtering averages narrow leaf silhouettes below the authored cutoff.
  // The short dimension of the UV footprint keeps resolved, oblique leaves sharp.
  const minifiedLeaves =
    foliage && !material.alphaMap
      ? `vec2 texel = vMapUv * vec2(textureSize(map, 0));
       vec2 dx = dFdx(texel), dy = dFdy(texel);
       float area = abs(dx.x * dy.y - dx.y * dy.x);
       float span = area * inversesqrt(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
       diffuseColor.a *= 1.0 + 0.10 * smoothstep(1.0, 4.0, span);`
      : '';

  const multisampled = { value: true };
  const beforeRender = material.onBeforeRender;
  material.onBeforeRender = function (...args) {
    beforeRender.call(this, ...args);
    const target = args[0].getRenderTarget();
    multisampled.value = !target || target.samples > 1;
  };
  const compile = material.onBeforeCompile;
  const programKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () =>
    programKey + (minifiedLeaves ? '|city-foliage-cutout' : '|city-cutout');
  material.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.cutoutMultisampled = multisampled;
    shader.fragmentShader =
      'uniform bool cutoutMultisampled;\n' +
      shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        `if (cutoutMultisampled) {
           ${minifiedLeaves}
           float width = max(fwidth(diffuseColor.a), 0.0001);
           diffuseColor.a = smoothstep(alphaTest - 0.5 * width, alphaTest + 0.5 * width, diffuseColor.a);
           if (diffuseColor.a == 0.0) discard;
         } else {
           if (diffuseColor.a < alphaTest) discard;
           diffuseColor.a = 1.0;
         }`,
      );
  };
}

/** Use the visible leaf mask when three.js draws the single-sample shadow map. */
export function matchCutoutShadow(mesh: THREE.Mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!materials.some((m) => m.alphaToCoverage && m.alphaTest > 0)) return;
  const beforeShadow = mesh.onBeforeShadow;
  mesh.onBeforeShadow = function (...args) {
    beforeShadow.call(this, ...args);
    const [, , , , , depthMaterial, group] = args;
    // WebGLShadowMap supplies the geometry group for multi-material meshes.
    const index = group && 'materialIndex' in group ? group.materialIndex : undefined;
    const source = Array.isArray(mesh.material)
      ? typeof index === 'number' && mesh.material[index]
      : mesh.material;
    if (source && source.alphaToCoverage && source.alphaTest > 0)
      depthMaterial.alphaTest = source.alphaTest;
  };
}
