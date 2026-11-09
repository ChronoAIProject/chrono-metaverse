export * from './types';
export {
  MeshBuilder,
  meshBounds,
  mergeMeshes,
  triangleCount,
  vertexCount,
  type Bounds,
  type MeshData,
} from './meshData';
export { boxMesh } from './box';
export { cylinderMesh, coneMesh, latheMesh } from './lathe';
export { extrudeMesh } from './extrude';
export { sweepMesh, smoothPath } from './sweep';
export { loftMesh } from './loft';
export {
  earClip,
  hullDegeneracy,
  hullMesh,
  hullProblem,
  plateFrame,
  plateMesh,
  plateProblem,
  plateProjectionAxes,
  segmentsIntersect,
} from './solid';
export { expandOutline } from './outline';
export { projectUvs } from './uv';
export {
  shadingLook,
  isAssetHash,
  DEFAULT_METALNESS,
  DEFAULT_ROUGHNESS,
  TRANSPARENT_ROUGHNESS,
  type ShadingLook,
} from './look';
export { transformMatrix, applyMatrix } from './transform';
export {
  buildShape,
  shapeBounds,
  shapeMesh,
  materialKey,
  primitiveMesh,
  DEFAULT_COLOR,
  type BuildOptions,
  type BuildResult,
} from './build';
export { toBufferGeometry, shapeToGeometry, partsToGeometry, type ShapeGeometry } from './three';
