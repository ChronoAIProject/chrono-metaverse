import * as THREE from 'three';
import { expect, it } from 'vitest';
import { scatterGroundScan, supportsGroundScan } from './groundScan';

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
