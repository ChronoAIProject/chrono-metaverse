import { Group } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { expect, it, vi } from 'vitest';
import { EquipmentModels } from './hardware';

it('共享设备资源遇到临时 503 后重新加载一次并补齐全部实例', async () => {
  vi.useFakeTimers();
  const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync');
  const failure = Object.assign(new Error('temporary outage'), {
    response: new Response(null, { status: 503 }),
  });
  load.mockRejectedValueOnce(failure).mockResolvedValue({ scene: new Group() } as GLTF);
  const models = new EquipmentModels(() => undefined);
  try {
    const first = new Group();
    const second = new Group();
    models.attach('cameraDrone', first);
    models.attach('cameraDrone', second);
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(2);
    expect(first.children).toHaveLength(1);
    expect(second.children).toHaveLength(1);
    expect(first.children[0]).not.toBe(second.children[0]);
  } finally {
    models.dispose();
    load.mockRestore();
    vi.useRealTimers();
  }
});
