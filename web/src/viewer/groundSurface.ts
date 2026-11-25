import * as THREE from 'three';
import type { GroundLayer } from '../core/externalSource';
import turfColor from '../assets/geography/turf-color.webp';
import turfSurface from '../assets/geography/turf-surface.webp';
import paversColor from '../assets/geography/pavers-color.webp';
import paversSurface from '../assets/geography/pavers-surface.webp';

/** 两张贴图还原一套实物材质，线性表面图的 R、G 为切线法线，B 为粗糙度。 */
export function groundSurfaceMaterial(kind: GroundLayer['material']) {
  const turf = kind === 'turf';
  const loader = new THREE.TextureLoader();
  let loaded = 0;
  const ready = () => {
    if (++loaded === 2) material.visible = true;
  };
  const map = loader.load(turf ? turfColor : paversColor, ready);
  const surface = loader.load(turf ? turfSurface : paversSurface, ready);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [map, surface]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
  }
  const material = new THREE.MeshStandardMaterial({
    color: turf ? 0xc9dbbe : 0xdde6ee,
    map,
    normalMap: surface,
    // 混入底层正射图的低频树影和磨损；网格仍写入深度，近处草叶可正常遮挡。
    transparent: true,
    opacity: turf ? 0.76 : 0.85,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  material.visible = false;
  material.forceSinglePass = true;
  material.name = 'ground:' + kind;
  material.normalScale.setScalar(turf ? 0.72 : 0.82);
  material.customProgramCacheKey = () => 'ground:' + kind;
  material.onBeforeCompile = (shader) => {
    if (!turf) {
      // 面与压顶石各自展开 UV，米制位置让一片湿痕能连续绕过石缘。
      shader.vertexShader =
        'varying vec2 pavingMeters;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n pavingMeters=position.xz;',
        );
      shader.fragmentShader = 'varying vec2 pavingMeters;\n' + shader.fragmentShader;
    }
    // 几何 UV 以米为单位。石材定向铺设，草皮交错采样两个方向，消除周期纹。
    const sample = turf
      ? /* glsl */ `
      vec2 uvA=vMapUv/1.4;
      mat2 turn=mat2(0.6,-0.8,0.8,0.6);
      vec2 uvB=turn*uvA*0.91+0.37;
      float blend=smoothstep(-0.6,0.6,sin(vMapUv.x*0.39+sin(vMapUv.y*0.23))+0.52*cos(vMapUv.y*0.63));
      vec3 albedo=mix(texture2D(map,uvA).rgb,texture2D(map,uvB).rgb,blend);
      vec3 propsA=texture2D(normalMap,uvA).rgb, propsB=texture2D(normalMap,uvB).rgb;
      vec2 slope=mix(propsA.rg*2.0-1.0,(propsB.rg*2.0-1.0)*turn,blend);
      float rough=mix(propsA.b,propsB.b,blend);
      float lawn=0.5+0.5*sin(vMapUv.x*0.18+vMapUv.y*0.14+0.7*sin(vMapUv.y*0.075));
      float wear=0.52*coverNoise(vMapUv*0.044)+0.32*coverNoise(vMapUv*0.14)+0.16*coverNoise(vMapUv*0.46);
      vec3 turfTone=mix(vec3(0.79,0.87,0.83),vec3(1.32,1.10,0.90),smoothstep(0.25,0.73,wear));
      diffuseColor.rgb*=albedo*turfTone*mix(0.87,1.06,lawn);`
      : /* glsl */ `
      vec2 uvA=vMapUv/2.0;
      vec3 albedo=texture2D(map,uvA).rgb;
      vec4 props=texture2D(normalMap,uvA);
      float retention=clamp((props.a*255.0-128.0)/124.0,0.0,1.0);
      float moisture=coverNoise(pavingMeters*0.13)*0.72+coverNoise(pavingMeters*0.38)*0.28;
      float damp=smoothstep(0.40,0.82,retention*0.60+moisture*0.68);
      float film=damp*smoothstep(0.28,0.84,retention);
      vec2 slope=(props.rg*2.0-1.0)*(1.0-0.65*film);
      // 斜视时一个像素覆盖更多细纹，扩大湿石高光以减少闪点。
      float footprint=1024.0*max(length(dFdx(uvA)),length(dFdy(uvA)));
      float wetRoughness=mix(0.34,0.54,smoothstep(1.0,14.0,footprint));
      float rough=mix(max(props.b,0.48),wetRoughness,film);
      diffuseColor.rgb*=albedo*mix(vec3(1.04),vec3(0.43,0.47,0.50),damp);`;
    shader.fragmentShader =
      `float coverCorner(ivec2 cell) {
      return fract(sin(dot(vec2(cell), vec2(39.3, 71.7))) * 4375.37);
    }
    float coverNoise(vec2 p) {
      // Neighbours evaluate their shared corner at exactly the same lattice coordinate.
      ivec2 cell = ivec2(floor(p));
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float low = mix(coverCorner(cell), coverCorner(cell + ivec2(1, 0)), f.x);
      float high = mix(coverCorner(cell + ivec2(0, 1)), coverCorner(cell + ivec2(1, 1)), f.x);
      return mix(low, high, f.y);
    }\n` +
      shader.fragmentShader
        .replace('#include <map_fragment>', sample)
        .replace(
          '#include <roughnessmap_fragment>',
          turf ? 'float roughnessFactor=mix(0.84,0.99,rough);' : 'float roughnessFactor=rough;',
        )
        .replace(
          '#include <lights_fragment_end>',
          turf
            ? '#include <lights_fragment_end>\nreflectedLight.directSpecular *= 0.10;'
            : '#include <lights_fragment_end>',
        )
        .replace(
          '#include <normal_fragment_maps>',
          `
        vec3 surfaceNormal=vec3(slope*normalScale,sqrt(max(0.0001,1.0-dot(slope,slope))));
        normal=normalize(tbn*surfaceNormal);`,
        );
  };
  material.addEventListener('dispose', () => {
    map.dispose();
    surface.dispose();
  });
  return material;
}
