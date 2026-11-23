import * as THREE from 'three';
import { tileGrassCells } from './grassCells';

/** 近处草叶使用瓦片自身的影像决定密度和颜色。每块一次实例绘制。 */
export function grassPatch(
  terrain: THREE.BufferGeometry,
  image: THREE.Texture<ImageBitmap>,
  width: number,
) {
  const positions = terrain.getAttribute('position');
  const corner = (index: number) => new THREE.Vector3().fromBufferAttribute(positions, index);
  // 精细地块固定为 4 × 4 个格，首行从西北到东北。
  const origin = corner(0);
  const cells = Math.min(144, Math.ceil(width / 0.24));
  const geometry = new THREE.InstancedBufferGeometry();
  // 根部较宽，叶尖收窄并弯折；由实例朝向打散相邻草簇。
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
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(blades, 3));
  const selected = tileGrassCells(image.image, cells);
  const sparse = selected && selected.length < cells * cells;
  if (sparse) geometry.setAttribute('grassCell', new THREE.InstancedBufferAttribute(selected, 1));
  geometry.instanceCount = selected?.length ?? cells * cells;
  geometry.boundingSphere = terrain.boundingSphere!.clone();
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    defines: sparse ? { SPARSE_GRASS: 1 } : {},
    uniforms: {
      time: { value: 0 },
      imagery: { value: image },
      corner: { value: origin },
      east: { value: corner(4).sub(origin) },
      south: { value: corner(20).sub(origin) },
      cells: { value: cells },
    },
    vertexShader: /* glsl */ `
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
        float angle = random.y*6.283185;
        vec3 blade = position * scale;
        blade.xz=mat2(cos(angle),sin(angle),-sin(angle),cos(angle))*blade.xz;
        float height=clamp(position.y/0.17,0.0,1.0);
        blade.xz+=vec2(0.016,0.009)*scale*height*height*sin(time*1.7+root.x*0.38+root.z*0.24);
        gl_Position = projectionMatrix*(base + modelViewMatrix*vec4(blade,0.0));
        bladeColor = photo * mix(0.60,1.26,clamp(position.y*8.0,0.0,1.0)) * (0.88+random.x*0.24);
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
  mesh.name = 'map-grass';
  mesh.userData.background = true;
  return mesh;
}
