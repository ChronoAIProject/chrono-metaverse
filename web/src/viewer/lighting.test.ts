import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FILL_LIGHT,
  HEMISPHERE_LIGHT,
  KEY_LIGHT,
  TEXTURE_DIFFUSE,
  TEXTURE_EMISSIVE,
  applyTexturedLook,
  createLights,
  diffuseResponse,
  texturedResponse,
} from './lighting';

/** 水平方向每 15° 一个法线。 */
const HORIZONTAL = Array.from({ length: 24 }, (_, i) => {
  const a = (i * 15 * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
});
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

describe('灯光（物理单位）', () => {
  it('半球光加两盏平行光，强度是系数 × π', () => {
    const lights = createLights();
    expect(lights).toHaveLength(3);
    const [hemisphere, key, fill] = lights as [
      THREE.HemisphereLight,
      THREE.DirectionalLight,
      THREE.DirectionalLight,
    ];
    expect(hemisphere).toBeInstanceOf(THREE.HemisphereLight);
    expect(key).toBeInstanceOf(THREE.DirectionalLight);
    expect(fill).toBeInstanceOf(THREE.DirectionalLight);
    expect(hemisphere.intensity).toBeCloseTo(HEMISPHERE_LIGHT.factor * Math.PI);
    expect(key.intensity).toBeCloseTo(KEY_LIGHT.factor * Math.PI);
    expect(fill.intensity).toBeCloseTo(FILL_LIGHT.factor * Math.PI);
    // 主光在东南上方（镜头默认所在的一侧），补光在西北上方。
    expect(key.position.x).toBeGreaterThan(0);
    expect(key.position.y).toBeGreaterThan(0);
    expect(key.position.z).toBeGreaterThan(0);
    expect(fill.position.x).toBeLessThan(0);
    expect(fill.position.z).toBeLessThan(0);
    expect(fill.intensity).toBeLessThan(key.intensity);
  });

  // 旧写法 HemisphereLight(…, 1.6) + DirectionalLight(1.6) 没乘 π：背光的侧面只有原色的三成左右，
  // 深色部件几乎是黑的。
  it('白色朝上的面接近原色，侧面和背光面不发黑，底面最暗', () => {
    const up = diffuseResponse(UP);
    expect(up).toBeGreaterThan(1);
    expect(up).toBeLessThan(1.3);
    const sides = HORIZONTAL.map((n) => diffuseResponse(n));
    // 背光面（主光照不到）也有原色的四成以上。
    expect(Math.min(...sides)).toBeGreaterThan(0.4);
    expect(Math.max(...sides)).toBeLessThan(up);
    // 朝向主光（东南）的面比背光面亮，保留明暗层次。
    expect(diffuseResponse(new THREE.Vector3(1, 0, 1))).toBeGreaterThan(
      diffuseResponse(new THREE.Vector3(-1, 0, 1)) + 0.2,
    );
    expect(diffuseResponse(DOWN)).toBeGreaterThan(0.2);
    expect(diffuseResponse(DOWN)).toBeLessThan(Math.min(...sides));
  });

  it('贴图材质的亮度接近原始扫描（不打光，等于 1），朝向不同也只差一点', () => {
    for (const n of [UP, ...HORIZONTAL]) {
      const response = texturedResponse(n);
      expect(response).toBeGreaterThan(0.8);
      expect(response).toBeLessThan(1.15);
    }
    expect(texturedResponse(UP)).toBeGreaterThan(texturedResponse(HORIZONTAL[18]!));
  });
});

describe('贴图材质的明暗', () => {
  it('颜色和自发光都用色调，颜色贴图和自发光贴图是同一张', () => {
    const material = new THREE.MeshStandardMaterial();
    const map = new THREE.Texture();
    const tint = new THREE.Color(0.8, 0.6, 0.4);
    applyTexturedLook(material, tint, map);
    expect(material.map).toBe(map);
    expect(material.emissiveMap).toBe(map);
    expect(material.color.r).toBeCloseTo(0.8 * TEXTURE_DIFFUSE);
    expect(material.color.b).toBeCloseTo(0.4 * TEXTURE_DIFFUSE);
    expect(material.emissive.g).toBeCloseTo(0.6 * TEXTURE_EMISSIVE);
    // 色调本身不被改动。
    expect(tint.r).toBeCloseTo(0.8);
  });

  it('贴图没到或下载失败时用纯色调，亮度和有贴图时一样', () => {
    const material = new THREE.MeshStandardMaterial();
    applyTexturedLook(material, new THREE.Color(1, 1, 1), new THREE.Texture());
    applyTexturedLook(material, new THREE.Color(1, 1, 1), null);
    expect(material.map).toBeNull();
    expect(material.emissiveMap).toBeNull();
    expect(material.color.r).toBeCloseTo(TEXTURE_DIFFUSE);
    expect(material.emissive.r).toBeCloseTo(TEXTURE_EMISSIVE);
  });
});
