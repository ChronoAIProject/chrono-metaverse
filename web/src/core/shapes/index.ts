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
export { expandOutline } from './outline';
export { projectUvs } from './uv';
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
export { toBufferGeometry, shapeToGeometry, type ShapeGeometry } from './three';
