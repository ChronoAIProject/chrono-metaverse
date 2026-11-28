import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { IDENTITY_PLACEMENT } from '../core/scene';
import { VectorContentItem } from './vectorContentView';
import * as geometry from './vectorGeometry';
import { sourceResponse } from './externalResource';

vi.mock('./externalResource', () => ({
  sourceResponse: vi.fn((_source: unknown, _access: unknown, request: { url: string }) =>
    request.url.endsWith('/index.json')
      ? Promise.resolve(
          Response.json({
            tilejson: '3.0.0',
            maxzoom: 14,
            tiles: ['https://tiles.example.org/{z}/{x}/{y}.pbf'],
          }),
        )
      : new Promise<Response>(() => undefined),
  ),
}));

it('转动或缩放镜头后，在当前帧选择新视野的楼群', async () => {
  const select = vi.spyOn(geometry, 'visibleVectorTiles');
  const host = document.createElement('div');
  const item = new VectorContentItem(
    {
      format: 'mvt',
      version: 1,
      sources: [
        {
          url: 'https://tiles.example.org/index.json',
          page: 'https://tiles.example.org/',
          attribution: '地图',
        },
      ],
      reference: { heading: 0, longitude: 103.85, latitude: 1.28, origin: [0, 0, 0] },
      extrusion: {
        layer: 'building',
        heightProperty: 'height',
        defaultHeight: 8,
        maxHeight: 500,
        maxDistance: 20000,
        color: '#dddddd',
      },
    },
    { entityId: 'district', layer: 'ext', kind: 'structure' },
    IDENTITY_PLACEMENT,
    host,
  );
  try {
    await vi.waitFor(() => expect(host.querySelector('[data-zoom="14"]')).toBeTruthy());
    const time = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const camera = new THREE.PerspectiveCamera(50, 1.86, 0.02, 25000);
    camera.position.y = 300;
    camera.lookAt(0, 0, -900);
    item.update(camera);
    expect(select).toHaveBeenCalledTimes(1);
    const initialTiles = select.mock.results[0]?.value;
    const pending = vi
      .mocked(sourceResponse)
      .mock.calls.filter((call) => call[2].url.endsWith('.pbf'));
    expect(pending).toHaveLength(4);

    time.mockReturnValue(1040);
    const calls = select.mock.calls.length;
    camera.rotateY(THREE.MathUtils.degToRad(0.2));
    item.update(camera);
    expect(select).toHaveBeenCalledTimes(calls);
    camera.lookAt(900, 0, 0);
    item.update(camera);
    expect(select).toHaveBeenCalledTimes(calls + 1);
    expect(select.mock.results.at(-1)?.value).not.toEqual(initialTiles);

    camera.fov = 25;
    camera.updateProjectionMatrix();
    item.update(camera);
    expect(select).toHaveBeenCalledTimes(calls + 2);
    expect(pending.every((call) => !call[3].aborted)).toBe(true);

    time.mockReturnValue(1260);
    item.update(camera);
    expect(pending.some((call) => call[3].aborted)).toBe(true);
  } finally {
    item.dispose();
    vi.restoreAllMocks();
  }
});
