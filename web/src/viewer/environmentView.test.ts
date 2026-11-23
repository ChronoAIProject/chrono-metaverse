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

it('室外金属共享缩小的天空并随样式切换和资源释放', async () => {
  const scene = new THREE.Scene();
  const photo = new Image();
  Object.defineProperty(photo, 'naturalWidth', { value: 4096 });
  const drawImage = vi.fn();
  using canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  canvas.mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const view = new EnvironmentView(
    scene,
    document.createElement('div'),
    async () => new THREE.Texture(photo),
  );
  const early = new THREE.MeshStandardMaterial();
  const late = new THREE.MeshStandardMaterial();
  view.addOutdoorMetal(early);
  view.setContent(content([entity], 15), undefined, undefined, true);
  await Promise.resolve();
  view.addOutdoorMetal(late);
  const sky = early.envMap!;
  expect(sky).toBe(late.envMap);
  expect(sky).not.toBe(scene.background);
  expect(drawImage).toHaveBeenCalledExactlyOnceWith(photo, 0, 0, 512, 256);
  expect(early.envMapRotation.y).toBeCloseTo(THREE.MathUtils.degToRad(35));
  view.setContent(content([entity], 15), '#112233');
  expect(early.envMap).toBeNull();
  view.setContent(content([entity], 15), undefined, undefined, true);
  expect(early.envMap).toBe(sky);
  const disposed = vi.fn();
  sky.addEventListener('dispose', disposed);
  view.dispose();
  expect(disposed).toHaveBeenCalledOnce();
  expect(late.envMap).toBeNull();
});

it('线性天空载入后替换室外金属的显示全景并共享预滤波输入', async () => {
  const photo = new Image();
  Object.defineProperties(photo, {
    naturalWidth: { value: 4 },
    naturalHeight: { value: 2 },
  });
  using canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  canvas.mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(32).fill(128) }),
  } as unknown as CanvasRenderingContext2D);
  const radianceHash = 'c'.repeat(64);
  let finish!: (texture: THREE.Texture) => void;
  const radiance = new Promise<THREE.Texture>((resolve) => {
    finish = resolve;
  });
  const scene = new THREE.Scene();
  const view = new EnvironmentView(scene, document.createElement('div'), async (key) =>
    key === radianceHash ? radiance : new THREE.Texture(photo),
  );
  const configured = {
    ...entity,
    textures: [hash, radianceHash],
    props: {
      background: true,
      environment: {
        version: 1,
        sky: {
          texture: hash,
          yaw: 20,
          radiance: { texture: radianceHash, scale: 32 },
        },
      },
    },
  };
  const early = new THREE.MeshStandardMaterial();
  view.addOutdoorMetal(early);
  view.setContent(content([configured]), undefined, undefined, true);
  await Promise.resolve();
  const fallback = early.envMap!;
  const disposed = vi.fn();
  fallback.addEventListener('dispose', disposed);
  finish(new THREE.Texture(photo));
  await vi.waitFor(() => expect(early.envMap).toBeInstanceOf(THREE.DataTexture));
  expect(disposed).toHaveBeenCalledOnce();
  const late = new THREE.MeshStandardMaterial();
  view.addOutdoorMetal(late);
  expect(late.envMap).toBe(early.envMap);
  expect(late.envMapIntensity).toBe(1);
  expect(scene.background).not.toBe(late.envMap);
  view.dispose();
  expect(late.envMap).toBeNull();
});

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

it('地图与天空在样式色往返时复用环境资源，移除图层后完整清理', async () => {
  const scene = new THREE.Scene();
  const host = document.createElement('div');
  const view = new EnvironmentView(scene, host, async () => new THREE.Texture());
  const withMap: EntityBody = {
    ...entity,
    props: {
      background: true,
      environment: {
        version: 1,
        sky: { texture: hash, yaw: 20 },
        map: {
          latitude: 35,
          longitude: -120,
          origin: [0, 0, 0],
          sources: [
            {
              urlTemplate: 'https://maps.example.org/{z}/{x}/{y}.jpg',
              attribution: '示例地图',
              page: 'https://maps.example.org/',
              minZoom: 0,
              maxZoom: 18,
            },
          ],
        },
      },
    },
  };
  view.setContent(content([withMap]));
  await Promise.resolve();
  const sky = scene.background;
  const map = scene.getObjectByName('geographic-map');
  expect(view.hasMap).toBe(true);
  view.setContent(content([withMap]), '#090b14');
  expect((scene.background as THREE.Color).getHexString()).toBe('090b14');
  expect(host.dataset.sky).toBe('ready');
  expect(scene.getObjectByName('geographic-map')).toBe(map);
  view.setContent(content([withMap]));
  expect(scene.background).toBe(sky);
  expect(scene.getObjectByName('geographic-map')).toBe(map);
  view.setContent(content([]), '#0c192c');
  expect((scene.background as THREE.Color).getHexString()).toBe('0c192c');
  expect(view.hasMap).toBe(false);
  expect(host.dataset.sky).toBeUndefined();
  view.dispose();
});
