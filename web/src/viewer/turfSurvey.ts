import * as THREE from 'three';
import type { TurfColorSurvey } from '../core/environment';
import type { GeoReference } from './geography';

/** Polygon UVs are member metres (x, -z), including geographic heading and origin. */
export function turfSurveyTransform(reference: GeoReference, corners: TurfColorSurvey['corners']) {
  const [origin, east, north] = corners.map(([lon, lat]) => reference.point(lon, lat));
  if (!origin || !east || !north) return;
  east.sub(origin);
  north.sub(origin);
  const basis = new THREE.Matrix3().set(
    east.x,
    north.x,
    origin.x,
    -east.z,
    -north.z,
    -origin.z,
    0,
    0,
    1,
  );
  if (Math.abs(basis.determinant()) < 1e-6) return;
  return basis.invert();
}

export function applyTurfSurvey(
  material: THREE.MeshStandardMaterial,
  reference: GeoReference,
  survey: TurfColorSurvey,
  load: (hash: string) => Promise<THREE.Texture>,
) {
  const transform = turfSurveyTransform(reference, survey.corners);
  if (!transform) return;
  let texture: THREE.Texture | undefined;
  let disposed = false;
  material.addEventListener('dispose', () => {
    disposed = true;
    texture?.dispose();
  });
  void load(survey.texture)
    .then((source) => {
      if (disposed) return;
      texture = source.clone();
      texture.colorSpace = THREE.NoColorSpace;
      texture.flipY = true;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      const compile = material.onBeforeCompile.bind(material);
      const key = material.customProgramCacheKey();
      material.customProgramCacheKey = () => key + '|turf-survey';
      material.onBeforeCompile = (shader, renderer) => {
        compile(shader, renderer);
        shader.uniforms.turfSurvey = { value: texture };
        shader.uniforms.turfTransform = { value: transform };
        shader.vertexShader =
          'uniform mat3 turfTransform;\nvarying vec2 turfSurveyUv;\n' +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nturfSurveyUv = (turfTransform * vec3(uv, 1.0)).xy;',
          );
        shader.fragmentShader =
          'uniform sampler2D turfSurvey;\nvarying vec2 turfSurveyUv;\n' +
          shader.fragmentShader.replace(
            '#include <alphatest_fragment>',
            `
          vec3 turfGain = texture2D(turfSurvey, turfSurveyUv).rgb * (255.0 / 128.0);
          if (all(greaterThanEqual(turfSurveyUv,vec2(0.0))) && all(lessThanEqual(turfSurveyUv,vec2(1.0))))
            diffuseColor.rgb *= turfGain;
          #include <alphatest_fragment>`,
          );
      };
      material.needsUpdate = true;
    })
    .catch(() => {
      /* The existing turf scan remains available when the geographic asset cannot load. */
    });
}
