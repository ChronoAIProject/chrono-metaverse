import * as THREE from 'three';

// The three corners of a triangular patch each select a translated copy of the scan.
// Sharpen the blend to retain grains and blades. Neighbouring triangles share edge weights.
const sampling = /* glsl */ `
  struct GroundPatch {
    vec3 weights;
    vec2 first;
    vec2 second;
    vec2 third;
  };
  vec2 groundPhase(ivec2 corner) {
    return vec2(surfaceCorner(corner + ivec2(3,41)), surfaceCorner(corner + ivec2(53,17)));
  }
  GroundPatch groundPatch(vec2 uv) {
    vec2 lattice = mat2(1.,0.,-.57735027,1.15470054) * uv * .55;
    ivec2 base = ivec2(floor(lattice));
    vec2 f = fract(lattice);
    bool upper = f.x + f.y > 1.;
    if (upper) f = 1. - f;
    vec3 w = vec3(1. - f.x - f.y, f);
    w = w*w*w;
    ivec2 corner = base + (upper ? ivec2(1) : ivec2(0));
    int stepToEdge = upper ? -1 : 1;
    return GroundPatch(w / (w.x+w.y+w.z), groundPhase(corner),
      groundPhase(corner+ivec2(stepToEdge,0)), groundPhase(corner+ivec2(0,stepToEdge)));
  }
  vec4 groundSample(sampler2D scan, vec2 uv, GroundPatch region) {
    vec2 dx=dFdx(uv), dy=dFdy(uv);
    return region.weights.x * textureGrad(scan,uv+region.first,dx,dy)
         + region.weights.y * textureGrad(scan,uv+region.second,dx,dy)
         + region.weights.z * textureGrad(scan,uv+region.third,dx,dy);
  }
`;

export type PavingAtlas = readonly [number, number];

/** A repeating running bond needs an even number of rows for the stagger to meet at the seam. */
export function pavingAtlas(value: unknown, material: string): PavingAtlas | undefined {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, material)) return;
  const size = (value as Record<string, unknown>)[material];
  if (!Array.isArray(size) || size.length !== 2) return;
  const [columns, rows] = size;
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 128 ||
    !Number.isInteger(rows) ||
    rows < 2 ||
    rows > 128 ||
    rows % 2 !== 0
  )
    return;
  return [columns, rows];
}

const pavingSampling = /* glsl */ `
  uniform vec2 pavingUnits;
  vec2 pavingOffset(vec2 uv) {
    vec2 stone = uv * pavingUnits;
    stone.x += .5 * mod(floor(stone.y), 2.);
    ivec2 cell = ivec2(floor(stone));
    vec2 pick = vec2(surfaceCorner(cell + ivec2(64,2)), surfaceCorner(cell + ivec2(35,-17)));
    vec2 donor = min(floor(pick * pavingUnits), pavingUnits - 1.);
    donor.x -= .5 * mod(donor.y, 2.);
    return (donor + fract(stone)) / pavingUnits - uv;
  }
`;

const chunks = [
  'map_fragment',
  'normal_fragment_maps',
  'metalnessmap_fragment',
  'roughnessmap_fragment',
  'aomap_fragment',
] as const;

/** Asset authors opt in continuous, opaque scans whose material channels share a UV transform. */
export function supportsGroundScan(material: THREE.Material) {
  if (
    !(material instanceof THREE.MeshStandardMaterial) ||
    !material.map ||
    material.transparent ||
    material.alphaTest > 0
  )
    return false;
  const map = material.map;
  if (map.matrixAutoUpdate) map.updateMatrix();
  return [
    map,
    material.normalMap,
    material.roughnessMap,
    material.metalnessMap,
    material.aoMap,
  ].every((texture) => {
    if (!texture) return true;
    if (texture.matrixAutoUpdate) texture.updateMatrix();
    return (
      texture.wrapS === THREE.RepeatWrapping &&
      texture.wrapT === THREE.RepeatWrapping &&
      texture.channel === map.channel &&
      texture.matrix.equals(map.matrix)
    );
  });
}

/** Reuse one set of offsets across the PBR maps and keep the unshifted pixel footprint for mip selection. */
export function scatterGroundScan(fragment: string, paving = false) {
  const code = paving ? pavingSampling : sampling;
  const sample = paving
    ? 'textureGrad($1, $2 + stoneOffset, dFdx($2), dFdy($2))'
    : 'groundSample($1, $2, surfacePatch)';
  const setup = paving
    ? 'vec2 stoneOffset = pavingOffset(vMapUv);'
    : 'GroundPatch surfacePatch=groundPatch(vMapUv);';
  let shader = fragment.replace('void main() {', code + '\nvoid main() {');
  for (const name of chunks) {
    const body = THREE.ShaderChunk[name].replace(
      /texture2D\(\s*(map|normalMap|roughnessMap|metalnessMap|aoMap)\s*,\s*(v\w+Uv)\s*\)/g,
      sample,
    );
    const prefix = name === 'map_fragment' ? setup + '\n' : '';
    shader = shader.replace('#include <' + name + '>', prefix + body);
  }
  return shader;
}
