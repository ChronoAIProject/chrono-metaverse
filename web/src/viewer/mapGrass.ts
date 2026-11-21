import * as THREE from 'three';

/** 近处草叶使用瓦片自身的影像决定密度和颜色。每块一次实例绘制。 */
export function grassPatch(terrain: THREE.BufferGeometry, image: THREE.Texture, width: number) {
  const positions = terrain.getAttribute('position');
  const corner = (index: number) => new THREE.Vector3().fromBufferAttribute(positions, index);
  // 精细地块固定为 4 × 4 个格，首行从西北到东北。
  const origin = corner(0);
  const cells = Math.min(144, Math.ceil(width / 0.24));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -0.025, 0, 0, 0.025, 0, 0, 0.047, 0.12, 0.015, 0, 0, -0.024, 0, 0, 0.024, -0.035, 0.1,
        0.043, -0.044, 0, 0.02, -0.01, 0, 0.045, -0.068, 0.115, 0.072,
      ],
      3,
    ),
  );
  geometry.instanceCount = cells * cells;
  geometry.boundingSphere = terrain.boundingSphere!.clone();
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      imagery: { value: image },
      corner: { value: origin },
      east: { value: corner(4).sub(origin) },
      south: { value: corner(20).sub(origin) },
      cells: { value: cells },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform sampler2D imagery;
      uniform vec3 corner, east, south;
      uniform float cells;
      varying vec3 bladeColor;
      vec3 jitter(vec2 p) {
        vec3 seed = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
        seed += dot(seed,seed.yxz+33.33);
        return fract((seed.xxy+seed.yzz)*seed.zyx);
      }
      void main(){
        float id = float(gl_InstanceID);
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
  mesh.name = 'map-grass';
  mesh.userData.background = true;
  return mesh;
}
