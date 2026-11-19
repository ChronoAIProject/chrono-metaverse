import { expect, it } from 'vitest';
import * as THREE from 'three';
import { hologramMaterial, surfaceLook } from './hologram';
import type { EntityBody } from '../core/api/types';

it('显式角色优先于建筑尺寸、背景属性和旧招牌名', () => {
  const look = { hologram: 'detail' } as const;
  const entity: EntityBody = {
    entityId: 'a',
    layer: 'ext',
    kind: 'object',
    props: { surfaceRole: 'facade' },
  };
  expect(surfaceLook(look, entity, false)?.hologram).toBe('facade');
  expect(
    surfaceLook(look, { ...entity, props: { surfaceRole: 'preserve' } }, true)?.hologram,
  ).toBeUndefined();
  expect(surfaceLook(look, { ...entity, props: {} }, false)).toBe(look);
  const material = new THREE.MeshBasicMaterial();
  material.name = 'logo';
  material.userData.surfaceRole = 'landscape';
  hologramMaterial(material, 'facade');
  expect(material.customProgramCacheKey()).toBe('hologram-landscape');
  material.dispose();
});
