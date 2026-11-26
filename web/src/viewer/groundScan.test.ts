import * as THREE from 'three';
import { expect, it } from 'vitest';
import { pavingAtlas, scatterGroundScan, supportsGroundScan } from './groundScan';

it('requires repeating PBR maps in the same UV space', () => {
  const texture = new THREE.Texture();
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  const material = new THREE.MeshStandardMaterial({ map: texture, normalMap: texture.clone() });
  expect(supportsGroundScan(material)).toBe(true);
  material.normalMap!.channel = 1;
  expect(supportsGroundScan(material)).toBe(false);
  material.normalMap!.channel = 0;
  material.normalMap!.offset.x = 0.25;
  expect(supportsGroundScan(material)).toBe(false);
  material.normalMap = null;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  expect(supportsGroundScan(material)).toBe(false);
});

it('uses the same patch for all five standard map slots', () => {
  const fragment = scatterGroundScan(THREE.ShaderLib.standard.fragmentShader);
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
    expect(fragment).toContain('groundSample(' + slot + ',');
  }
  expect(fragment.match(/GroundPatch surfacePatch=/g)).toHaveLength(1);
});

it('accepts complete staggered courses and keeps all PBR maps aligned to one selected stone', () => {
  expect(pavingAtlas({ granite: [4, 6] }, 'granite')).toEqual({
    columns: 4,
    rows: 6,
    stagger: 0.5,
    originU: 0,
  });
  for (const grid of [
    [4, 5],
    [0, 6],
    [4, 3.5],
    [4, 6, 8],
    ['4', 6],
  ]) {
    expect(pavingAtlas({ granite: grid }, 'granite')).toBeUndefined();
  }
  expect(pavingAtlas({}, 'toString')).toBeUndefined();
  const shader = scatterGroundScan(THREE.ShaderLib.standard.fragmentShader, true);
  expect(shader.match(/stoneOffset = pavingOffset/g)).toHaveLength(1);
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
    expect(shader).toContain('textureGrad(' + slot + ',');
  }
});

it('registers straight joints and retains the baked lightmap on its own coordinates', () => {
  const spec = { grid: [5, 5], bond: 'stack', originU: 0.0955 };
  expect(pavingAtlas({ stone: spec }, 'stone')).toEqual({
    columns: 5,
    rows: 5,
    stagger: 0,
    originU: 0.0955,
  });
  expect(pavingAtlas({ stone: { ...spec, originU: NaN } }, 'stone')).toBeUndefined();
  const map = new THREE.Texture();
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const aoMap = new THREE.Texture();
  aoMap.channel = 1;
  const material = new THREE.MeshStandardMaterial({ map, aoMap });
  expect(supportsGroundScan(material)).toBe(false);
  expect(supportsGroundScan(material, true)).toBe(true);
  const shader = scatterGroundScan(THREE.ShaderLib.standard.fragmentShader, true, true);
  expect(shader).toContain('#include <aomap_fragment>');
  expect(shader).toContain('textureGrad(map,');
});
