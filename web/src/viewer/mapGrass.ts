import { surfaceNoise } from './surfaceVariation';
import * as THREE from 'three';
import type { GrassFootprints } from './grassFootprints';
import type { Tile } from './geography';
import { tileGrassCells } from './grassCells';

/** 近处草叶使用瓦片自身的影像决定密度和颜色。每块一次实例绘制。 */
export function grassPatch(
  terrain: THREE.BufferGeometry,
  image: THREE.Texture<ImageBitmap>,
  width: number,
  tile: Tile,
  paving?: GrassFootprints,
  lawns?: GrassFootprints,
  mownLawnSurfaceOffset = 0,
) {
  const cells = Math.min(144, Math.ceil(width / 0.24));
  const candidates = tileGrassCells(image.image, cells);
  const selected = paving ? paving.filter(tile, cells, candidates) : candidates;
  const mask = lawns?.coverage(tile, cells);
  const patch = (ids: Uint16Array | null, mown: boolean) => {
    const mesh = bladeMesh(terrain, image, cells, ids, mown);
    if (mown) mesh.position.y = mownLawnSurfaceOffset;
    return mesh;
  };
  if (!mask) return [patch(selected, false)];
  const available = selected ?? Uint16Array.from({ length: cells * cells }, (_, id) => id);
  const short = available.filter((id) => mask[id * 4 + 3] !== 0);
  if (!short.length) return [patch(selected, false)];
  if (short.length === available.length) return [patch(selected, true)];
  const tall = available.filter((id) => mask[id * 4 + 3] === 0);
  return [patch(tall, false), patch(short, true)];
}

function bladeMesh(
  terrain: THREE.BufferGeometry,
  image: THREE.Texture<ImageBitmap>,
  cells: number,
  selected: Uint16Array | null,
  mown: boolean,
) {
  const positions = terrain.getAttribute('position');
  const corner = (index: number) => new THREE.Vector3().fromBufferAttribute(positions, index);
  // 精细地块固定为 4 × 4 个格，首行从西北到东北。
  const origin = corner(0);
  const geometry = new THREE.InstancedBufferGeometry();
  // 根部较宽，叶尖收窄并弯折；由实例朝向打散相邻草簇。
  const blades = mown ? mownBlades() : tallBlades();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(blades, 3));
  const sparse = selected && selected.length < cells * cells;
  if (sparse) geometry.setAttribute('grassCell', new THREE.InstancedBufferAttribute(selected, 1));
  geometry.instanceCount = selected?.length ?? cells * cells;
  geometry.boundingSphere = terrain.boundingSphere!.clone();
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    defines: { ...(sparse ? { SPARSE_GRASS: 1 } : {}), ...(mown ? { MOWN_GRASS: 1 } : {}) },
    uniforms: {
      time: { value: 0 },
      imagery: { value: image },
      corner: { value: origin },
      east: { value: corner(4).sub(origin) },
      south: { value: corner(20).sub(origin) },
      cells: { value: cells },
    },
    vertexShader: /* glsl */ `
      ${surfaceNoise}
      #include <common>
      #include <logdepthbuf_pars_vertex>
      #ifdef SPARSE_GRASS
      attribute float grassCell;
      #endif
      uniform sampler2D imagery;
      uniform vec3 corner, east, south;
      uniform float cells,time;
      varying vec3 bladeColor;
      vec3 jitter(vec2 p) {
        vec3 seed = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
        seed += dot(seed,seed.yxz+33.33);
        return fract((seed.xxy+seed.yzz)*seed.zyx);
      }
      void main(){
        #ifdef SPARSE_GRASS
        float id = grassCell;
        #else
        float id = float(gl_InstanceID);
        #endif
        vec2 cell = vec2(mod(id,cells),floor(id/cells));
        vec3 random = jitter(cell+floor(corner.xz));
        vec2 uv = (cell+random.xy)/cells;
        vec3 root = corner+east*uv.x+south*uv.y;
        vec3 photo = textureLod(imagery,vec2(uv.x,1.0-uv.y),0.0).rgb;
        float lum = max(0.035,dot(photo,vec3(0.2126,0.7152,0.0722)));
        float turf = smoothstep(0.18,0.47,(photo.g-photo.b)/lum)
                   * smoothstep(-0.13,0.05,(photo.g-photo.r)/lum);
        vec4 base = modelViewMatrix*vec4(root,1.0);
        float scale = (1.0-smoothstep(12.0,27.0,length(base.xyz)))*turf*(0.65+random.z);
        // Thinner patches interrupt the tile lattice without moving roots off the imagery.
        float cover = surfaceField(root.xz*.39);
        scale *= smoothstep(.17,.56,cover+.28*random.x)*mix(.80,1.16,cover);
        float angle = random.y*6.283185;
        vec3 blade = position * scale;
        blade.xz=mat2(cos(angle),sin(angle),-sin(angle),cos(angle))*blade.xz;
        #ifdef MOWN_GRASS
        float height=clamp(position.y/0.083,0.0,1.0);
        vec2 wind=vec2(0.008,0.0045);
        float tipLight=clamp(position.y*14.0,0.0,1.0);
        #else
        float height=clamp(position.y/0.17,0.0,1.0);
        vec2 wind=vec2(0.016,0.009);
        float tipLight=clamp(position.y*8.0,0.0,1.0);
        #endif
        blade.xz+=wind*scale*height*height*sin(time*1.7+root.x*0.38+root.z*0.24);
        gl_Position = projectionMatrix*(base + modelViewMatrix*vec4(blade,0.0));
        bladeColor = photo * mix(0.60,1.26,tipLight) * (0.88+random.x*0.24)*mix(vec3(1.08,.99,.82),vec3(.93,1.03,1.02),cover);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec3 bladeColor;
      void main(){
        #include <logdepthbuf_fragment>
        gl_FragColor=vec4(bladeColor,1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.onBeforeRender = () => {
    material.uniforms.time!.value = performance.now() * 0.001;
  };
  mesh.name = mown ? 'map-mown-grass' : 'map-grass';
  mesh.userData.background = true;
  return mesh;
}

function tallBlades() {
  const blades: number[] = [];
  for (const [angle, height, lean] of [
    [0, 0.14, 0.045],
    [2.2, 0.17, 0.052],
    [4.3, 0.105, 0.058],
  ] as const) {
    const tip = (width: number, y: number, bend: number) => [
      Math.cos(angle) * width + Math.sin(angle) * bend,
      y,
      -Math.sin(angle) * width + Math.cos(angle) * bend,
    ];
    const left = tip(-0.017, 0, 0),
      right = tip(0.017, 0, 0);
    const midLeft = tip(-0.008, height * 0.6, lean * 0.35),
      midRight = tip(0.008, height * 0.6, lean * 0.35);
    blades.push(
      ...left,
      ...right,
      ...midLeft,
      ...midLeft,
      ...right,
      ...midRight,
      ...midLeft,
      ...midRight,
      ...tip(0, height, lean),
    );
  }
  return blades;
}

function mownBlades() {
  const blades: number[] = [];
  // Separate the leaf bases within each tuft. At walking height the tapered
  // blades cover only a few pixels, including their wind displacement.
  for (const [angle, height, halfWidth, lean, offset] of [
    [0.18, 0.059, 0.009, 0.025, 0.011],
    [1.56, 0.083, 0.007, 0.024, 0.02],
    [2.76, 0.046, 0.008, 0.019, 0.015],
    [4.08, 0.073, 0.007, 0.032, 0.008],
    [5.36, 0.052, 0.008, 0.023, 0.019],
  ] as const) {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    blades.push(
      c * offset - s * halfWidth,
      0,
      s * offset + c * halfWidth,
      c * offset + s * halfWidth,
      0,
      s * offset - c * halfWidth,
      c * (offset + lean),
      height,
      s * (offset + lean),
    );
  }
  return blades;
}
