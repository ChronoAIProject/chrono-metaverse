import { surfaceNoise } from './surfaceVariation';
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
      // Two continuous areas of grass use independent scan phases. Warp the boundaries
      // at two metre scales so neither the edge nor the sample repeats in parallel bands.
      vec2 offsets=vec2(surfaceField(vMapUv*.067),surfaceField(vMapUv*.083+19.4));
      vec2 uvA=vMapUv/1.4+offsets*1.4;
      mat2 turn=mat2(0.6,-0.8,0.8,0.6);
      vec2 uvB=turn*(vMapUv/1.4)*0.91+vec2(0.37,0.71)-offsets.yx;
      float blend=smoothstep(.29,.71,surfaceField(vMapUv*.21+offsets));
      vec3 albedo=mix(texture2D(map,uvA).rgb,texture2D(map,uvB).rgb,blend);
      vec3 propsA=texture2D(normalMap,uvA).rgb, propsB=texture2D(normalMap,uvB).rgb;
      vec2 slope=mix(propsA.rg*2.0-1.0,(propsB.rg*2.0-1.0)*turn,blend);
      float rough=mix(propsA.b,propsB.b,blend);
      float lawn=surfaceField(vMapUv*.048+offsets*.82);
      float wear=0.52*surfaceField(vMapUv*0.044)+0.32*surfaceField(vMapUv*0.14)+0.16*surfaceField(vMapUv*0.46);
      vec3 turfTone=mix(vec3(0.79,0.87,0.83),vec3(1.32,1.10,0.90),smoothstep(0.25,0.73,wear));
      diffuseColor.rgb*=albedo*turfTone*mix(.77,1.17,lawn);`
      : /* glsl */ `
      vec2 uvA=vMapUv/2.0;
      // The five stones across the scan meet on joints at 0.1 + n/5.
      ivec2 slab=ivec2(floor(uvA*5.0-vec2(.5)));
      float batch=surfaceCorner(slab);
      vec2 offset=floor(vec2(batch,surfaceCorner(slab+ivec2(73,11)))*4.99)/5.0;
      vec2 dx=dFdx(uvA), dy=dFdy(uvA);
      vec3 albedo=textureGrad(map,uvA+offset,dx,dy).rgb * mix(.88,1.13,batch);
      vec4 props=textureGrad(normalMap,uvA+offset,dx,dy);
      float retention=clamp((props.a*255.0-128.0)/124.0,0.0,1.0);
      float moisture=surfaceField(pavingMeters*0.13)*0.72+surfaceField(pavingMeters*0.38)*0.28;
      float damp=smoothstep(0.40,0.82,retention*0.60+moisture*0.68);
      float film=damp*smoothstep(0.28,0.84,retention);
      vec2 slope=(props.rg*2.0-1.0)*(1.0-0.65*film);
      // 斜视时一个像素覆盖更多细纹，扩大湿石高光以减少闪点。
      float footprint=1024.0*max(length(dFdx(uvA)),length(dFdy(uvA)));
      float wetRoughness=mix(0.34,0.54,smoothstep(1.0,14.0,footprint));
      float rough=mix(max(props.b,0.48),wetRoughness,film);
      diffuseColor.rgb*=albedo*mix(vec3(1.04),vec3(0.43,0.47,0.50),damp);`;
    shader.fragmentShader =
      surfaceNoise +
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
