import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { EntityBody } from '../core/api/types';
import { IDENTITY_PLACEMENT, selectView, type SceneContent } from '../core/scene';
import { EnvironmentView } from './environmentView';

const hash = 'b'.repeat(64);
const entity: EntityBody = {
  entityId: 'sky',
  kind: 'object',
  layer: 'ext',
  shape: { type: 'box', size: [0.1, 0.1, 0.1] },
  textures: [hash],
  props: { background: true, environment: { version: 1, sky: { texture: hash, yaw: 20 } } },
};
function content(entities: EntityBody[], rotation = 0): SceneContent {
  return {
    mode: 'extended',
    links: [],
    members: [
      {
        spaceId: 'test',
        placement: { ...IDENTITY_PLACEMENT, rotation },
        view: selectView(
          {
            spaceId: 'test',
            seq: 1,
            at: '',
            entities,
            anchors: [],
            regions: [],
            plots: [],
            palette: { blocks: [] },
            chunks: [],
          },
          'extended',
        ),
      },
    ],
  };
}

it('移除环境后迟到的天空不会覆盖新视图', async () => {
  let resolve!: (texture: THREE.Texture) => void;
  const scene = new THREE.Scene();
  const host = document.createElement('div');
  const view = new EnvironmentView(
    scene,
    host,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  view.setContent(content([entity]));
  view.setContent(content([]));
  resolve(new THREE.Texture());
  await Promise.resolve();
  expect(scene.background).toBeNull();
  expect(host.dataset.sky).toBeUndefined();
  view.dispose();
});

it('组合旋转作用于天空副本，释放环境不释放共享资源', async () => {
  const shared = new THREE.Texture();
  const disposeShared = vi.spyOn(shared, 'dispose');
  const scene = new THREE.Scene();
  const view = new EnvironmentView(scene, document.createElement('div'), async () => shared);
  view.setContent(content([entity], 90));
  await Promise.resolve();
  const sky = scene.background as THREE.Texture;
  const disposeSky = vi.spyOn(sky, 'dispose');
  expect(sky).not.toBe(shared);
  expect(scene.backgroundRotation.y).toBeCloseTo(THREE.MathUtils.degToRad(110));
  expect(shared.mapping).toBe(THREE.UVMapping);
  view.dispose();
  expect(disposeSky).toHaveBeenCalledOnce();
  expect(disposeShared).not.toHaveBeenCalled();
});
