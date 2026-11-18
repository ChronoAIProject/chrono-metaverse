import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { emptyChunk } from '../core/chunk';
import { createPublicClient } from '../core/api/client';
import { fixtureFetch } from '../fixtures/server';
import { SHARE_TOKEN, SPACE_ID } from '../fixtures';
import {
  IDENTITY_PLACEMENT,
  loadScene,
  placePoint,
  selectView,
  selectViewForStyle,
  type SceneContent,
} from '../core/scene';
import { BUILTIN_SPACE_STYLES, type StyleLook } from '../core/styles';
import { voxelSourceMeshes, type VoxelMeshes, type VoxelSource } from '../core/voxels';
import { inlineMeshService, type MeshService } from './meshService';
import { handleMeshRequest, type ShapeJob, type ShapeJobResult } from './meshJobs';
import { SceneView } from './sceneView';
import { srgb } from './materials';

// 仅替换需要显卡的渲染器，内容构建、几何、材质与资源释放均执行真实代码。
vi.mock('three', async (original) => ({
  ...(await original<typeof import('three')>()),
  WebGLRenderer: class {
    readonly domElement = document.createElement('canvas');
    readonly capabilities = { getMaxAnisotropy: () => 1 };
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    setAnimationLoop() {}
    render() {}
    dispose() {}
  },
}));

const views: SceneView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.restoreAllMocks();
});

function source(): VoxelSource {
  const cells = emptyChunk();
  cells[0] = 2;
  return {
    chunks: [{ layer: 'rebuilt', cx: 0, cy: 0, cz: 0, cells }],
    keepBoxes: null,
    palette: { blocks: [{ id: 2, name: '石材', kind: 'solid', color: [200, 100, 50] }] },
  };
}

function content(voxels: VoxelSource, look: StyleLook = {}): SceneContent {
  const view = selectView(
    {
      spaceId: 'test',
      seq: 1,
      at: '',
      entities: [],
      anchors: [],
      regions: [],
      plots: [],
      chunks: [],
      palette: voxels.palette,
    },
    'optimized',
  );
  return {
    mode: 'optimized',
    links: [],
    members: [
      {
        spaceId: 'test',
        placement: IDENTITY_PLACEMENT,
        view: { ...view, voxels, styleLook: look },
      },
    ],
  };
}

function setup() {
  const service = inlineMeshService();
  const generate = vi.spyOn(service, 'voxels');
  const view = new SceneView(document.createElement('div'), { meshService: service });
  views.push(view);
  const meshes = () => {
    const found: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
    (Reflect.get(view, 'content') as THREE.Group).traverse((object) => {
      if (object.name.startsWith('voxels:'))
        found.push(object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>);
    });
    return found;
  };
  return { view, service, generate, meshes };
}

function shapeContent(
  look: StyleLook = {},
  ids: readonly ('boxA' | 'boxB')[] = ['boxA'],
): SceneContent {
  const base = content({ ...source(), chunks: [] }, look);
  const member = base.members[0]!;
  return {
    ...base,
    members: [
      {
        ...member,
        view: {
          ...member.view,
          entities: ids.map((entityId) => ({
            entityId,
            kind: 'object',
            layer: 'rebuilt',
            shape: {
              type: 'box',
              size: entityId === 'boxA' ? [2, 2, 4] : [4, 2, 4],
              transform: { position: [1, 0, 2] },
            },
          })),
        },
      },
    ],
  };
}

function shapeMeshes(view: SceneView) {
  const found: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>[] = [];
  (Reflect.get(view, 'content') as THREE.Group).traverse((object) => {
    if (object instanceof THREE.Mesh && object.userData.entities)
      found.push(object as (typeof found)[number]);
  });
  return found;
}

const shapeCache = (view: SceneView) =>
  Reflect.get(view, 'geometryCache') as Map<string, { geometry: THREE.BufferGeometry }>;
const shapePending = (view: SceneView) =>
  Reflect.get(view, 'shapePending') as Map<string, Promise<void>>;

function shapeResults(jobs: readonly ShapeJob[]): ShapeJobResult[] {
  const response = handleMeshRequest({ id: 1, kind: 'shapes', jobs });
  if (response.kind !== 'shapes') throw new Error('形状任务返回类型错误');
  return [...response.results];
}

function delayShapes(service: MeshService) {
  const batches: {
    jobs: readonly ShapeJob[];
    resolve: (results?: ShapeJobResult[]) => void;
    reject: (error: Error) => void;
    progress: () => void;
  }[] = [];
  const generate = vi.spyOn(service, 'shapes').mockImplementation(
    (jobs, onProgress) =>
      new Promise((resolve, reject) => {
        const progress = () => onProgress?.(jobs.length, jobs.length);
        batches.push({
          jobs,
          resolve: (results = shapeResults(jobs)) => {
            progress();
            resolve(results);
          },
          reject,
          progress,
        });
      }),
  );
  return { generate, batches };
}

// 锚定 `GoalArtifact.normalized_goal[0]` 与 `success_criteria[0,1,4]`；既有消费方：
// `SceneView.setContent`、`SceneView.dispose` 及 `SpacePage`、`UniversePage` 的样式画廊切换链路。
it('`VE-P14-01`：只切换样式或在途并发切换形状外观时仅提交一次形状任务，共享几何并在销毁时唯一释放', async () => {
  const s = setup();
  const { generate, batches } = delayShapes(s.service);
  const maquette = shapeContent({ roughness: 0.92, stripTextures: true });
  const blueprint = shapeContent({ wireframe: true, roughness: 0.4 });
  const first = s.view.setContent(maquette);
  const second = s.view.setContent(blueprint);
  expect(generate).toHaveBeenCalledOnce();
  expect(batches[0]!.jobs).toHaveLength(1);
  expect(shapePending(s.view).size).toBe(1);
  batches[0]!.resolve();
  await Promise.all([first, second]);
  expect(generate).toHaveBeenCalledOnce();
  expect(shapePending(s.view).size).toBe(0);
  const [mesh] = shapeMeshes(s.view);
  expect(mesh!.material[0]!.wireframe).toBe(true);
  const geometry = mesh!.geometry;
  expect(geometry.index!.count).toBeGreaterThan(0);
  expect(geometry).toBe(shapeCache(s.view).get(batches[0]!.jobs[0]!.key)!.geometry);
  const release = vi.spyOn(geometry, 'dispose');
  await s.view.setContent(maquette);
  expect(generate).toHaveBeenCalledOnce();
  expect(shapeMeshes(s.view)[0]!.geometry).toBe(geometry);
  expect(shapeMeshes(s.view)[0]!.material[0]).toMatchObject({ wireframe: false, roughness: 0.92 });
  expect(release).not.toHaveBeenCalled();
  s.view.dispose();
  views.splice(views.indexOf(s.view), 1);
  expect(release).toHaveBeenCalledOnce();
});

// 锚定 `GoalArtifact.normalized_goal[0]` 与 `success_criteria[0,1,4]`；既有消费方：
// `SceneView.setContent` 的 `shapePending` 复用与 `geometryCache` 防覆盖守卫、`SceneView.dispose`。
it.each(['旧先新后', '新先旧后'] as const)(
  '`VE-P14-02`：部分重叠形状批次与乱序完成（%s）均保持缓存与在用几何唯一所有权',
  async (order) => {
    const s = setup();
    const { generate, batches } = delayShapes(s.service);
    const first = s.view.setContent(shapeContent({ roughness: 0.92 }));
    const second = s.view.setContent(
      shapeContent({ wireframe: true, roughness: 0.4 }, ['boxA', 'boxB']),
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(batches.map((batch) => batch.jobs.length)).toEqual([1, 1]);
    expect(batches[0]!.jobs[0]!.key).not.toBe(batches[1]!.jobs[0]!.key);
    expect(shapePending(s.view).size).toBe(2);
    if (order === '旧先新后') {
      batches[0]!.resolve();
      await first;
      batches[1]!.resolve();
    } else {
      batches[1]!.resolve();
      await shapePending(s.view).get(batches[1]!.jobs[0]!.key);
      expect(shapeMeshes(s.view)).toHaveLength(0);
      batches[0]!.resolve();
    }
    await Promise.all([first, second]);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(shapePending(s.view).size).toBe(0);
    const meshes = shapeMeshes(s.view);
    expect(meshes.map((mesh) => mesh.name).sort()).toEqual(['boxA', 'boxB']);
    const releases = meshes.map((mesh, index) => {
      expect(mesh.material[0]).toMatchObject({ wireframe: true, roughness: 0.4 });
      expect(mesh.geometry.index!.count).toBeGreaterThan(0);
      expect(mesh.geometry).toBe(shapeCache(s.view).get(batches[index]!.jobs[0]!.key)!.geometry);
      return vi.spyOn(mesh.geometry, 'dispose');
    });
    s.view.dispose();
    views.splice(views.indexOf(s.view), 1);
    for (const release of releases) expect(release).toHaveBeenCalledOnce();

    // 自定义 `MeshService` 的迟到批次夹带在用同键结果时，也不能新建缓冲或替换其缓存所有权。
    const late = setup();
    const delayed = delayShapes(late.service);
    const stale = late.view.setContent(shapeContent({}, ['boxB']));
    const current = late.view.setContent(shapeContent({ wireframe: true }));
    delayed.batches[1]!.resolve();
    await current;
    const active = shapeMeshes(late.view)[0]!.geometry;
    const release = vi.spyOn(active, 'dispose');
    const created = vi.spyOn(THREE.BufferGeometry.prototype, 'computeBoundingSphere');
    delayed.batches[0]!.resolve(
      shapeResults([...delayed.batches[0]!.jobs, ...delayed.batches[1]!.jobs]),
    );
    await stale;
    expect(created).toHaveBeenCalledOnce();
    expect(shapeMeshes(late.view)[0]!.geometry).toBe(active);
    expect(shapeCache(late.view).get(delayed.batches[1]!.jobs[0]!.key)!.geometry).toBe(active);
    expect(release).not.toHaveBeenCalled();
    late.view.dispose();
    views.splice(views.indexOf(late.view), 1);
    expect(release).toHaveBeenCalledOnce();
  },
);

// 锚定 `GoalArtifact.normalized_goal[0]` 与 `success_criteria[1,4]`；既有消费方：
// `SceneView.setContent`、`SceneView.dispose` 及主线程形状缓冲组装函数 `partsToGeometry`。
it('`VE-P14-03`：形状任务失败后清理在途状态允许重试，视图销毁后迟到形状结果不再创建几何缓冲', async () => {
  const s = setup();
  const { generate, batches } = delayShapes(s.service);
  const first = s.view.setContent(shapeContent());
  const second = s.view.setContent(shapeContent({ wireframe: true }));
  expect(generate).toHaveBeenCalledOnce();
  const rejected = Promise.all([
    expect(first).rejects.toThrow('形状生成失败'),
    expect(second).rejects.toThrow('形状生成失败'),
  ]);
  batches[0]!.reject(new Error('形状生成失败'));
  await rejected;
  expect(shapePending(s.view).size).toBe(0);
  expect(shapeCache(s.view).size).toBe(0);
  const retry = s.view.setContent(shapeContent());
  expect(generate).toHaveBeenCalledTimes(2);
  batches[1]!.resolve();
  await retry;
  expect(shapePending(s.view).size).toBe(0);
  expect(shapeMeshes(s.view)).toHaveLength(1);
  expect(shapeMeshes(s.view)[0]!.geometry.index!.count).toBeGreaterThan(0);

  generate.mockImplementationOnce(() => {
    throw new Error('形状同步生成失败');
  });
  await expect(s.view.setContent(shapeContent({}, ['boxB']))).rejects.toThrow('形状同步生成失败');
  expect(shapePending(s.view).size).toBe(0);
  const syncRetry = s.view.setContent(shapeContent({}, ['boxB']));
  batches[2]!.resolve();
  await syncRetry;
  expect(shapeMeshes(s.view)[0]!.name).toBe('boxB');

  const late = setup();
  const delayed = delayShapes(late.service);
  const pending = late.view.setContent(shapeContent());
  expect(shapePending(late.view).size).toBe(1);
  late.view.dispose();
  views.splice(views.indexOf(late.view), 1);
  expect(shapePending(late.view).size).toBe(0);
  const created = vi.spyOn(THREE.BufferGeometry.prototype, 'computeBoundingSphere');
  delayed.batches[0]!.resolve();
  await pending;
  expect(created).not.toHaveBeenCalled();
  expect(shapeCache(late.view).size).toBe(0);
  expect(shapeMeshes(late.view)).toHaveLength(0);
});

it('`VE-P12-03`：三类连接双向聚焦变换后的公开锚点，成员取景与全景包围盒准确', async () => {
  const s = setup();
  const base = content({ ...source(), chunks: [] }).members[0]!.view;
  const members: SceneContent['members'] = [
    {
      spaceId: 'first',
      name: '前厅',
      placement: { offset: [20, 0, 40], rotation: 90 },
      view: {
        ...base,
        entities: [
          {
            entityId: 'room',
            kind: 'object',
            layer: 'rebuilt',
            bounds: { min: [0, 0, 0], max: [2, 2, 4] },
            shape: { type: 'box', size: [2, 2, 4], transform: { position: [1, 0, 2] } },
          },
        ],
        anchors: [
          {
            anchorId: 'entry',
            kind: 'door',
            label: '前厅入口',
            position: [1, 1, 2],
            visibility: 'public',
          },
        ],
      },
    },
    {
      spaceId: 'second',
      name: '花店',
      placement: { offset: [200, 20, 300], rotation: 180 },
      view: {
        ...base,
        entities: [
          {
            entityId: 'room',
            kind: 'object',
            layer: 'rebuilt',
            bounds: { min: [0, 0, 0], max: [2, 2, 4] },
            shape: { type: 'box', size: [2, 2, 4], transform: { position: [1, 0, 2] } },
          },
        ],
        anchors: [
          {
            anchorId: 'entry',
            kind: 'door',
            label: '花店入口',
            position: [1.5, 1, 3],
            visibility: 'public',
          },
        ],
      },
    },
  ];
  const from = { spaceId: 'first', anchorId: 'entry' };
  const to = { spaceId: 'second', anchorId: 'entry' };
  await s.view.setContent({
    mode: 'optimized',
    members,
    links: (['door', 'portal', 'street'] as const).map((kind) => ({ kind, from, to })),
  });
  const host = hostOf(s.view);
  const scene = sceneOf(s.view);
  const camera = Reflect.get(s.view, 'camera') as THREE.PerspectiveCamera;
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const labels = Reflect.get(s.view, 'labels') as {
    render(scene: THREE.Scene, camera: THREE.Camera): void;
  };
  labels.render(scene, camera);
  expect(host.querySelectorAll('.viewer__link')).toHaveLength(6);
  const firstLabel = host.querySelector<HTMLElement>('.viewer__anchor[data-space-id="first"]')!;
  const secondLabel = host.querySelector<HTMLElement>('.viewer__anchor[data-space-id="second"]')!;
  const world = (index: number) =>
    placePoint(members[index]!.placement, members[index]!.view.anchors[0]!.position!)
      .map((value) => value.toFixed(2))
      .join(',');
  expect(world(0)).toBe('3.00,1.00,1.00');
  expect(world(1)).toBe('8.50,2.00,12.00');
  // 连点两个世界标签时，第二次飞行必须从中途的眼位起步。
  let now = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const tick = () => {
    now += 80;
    Reflect.get(s.view, 'frame').call(s.view);
  };
  const start = camera.position.clone();
  secondLabel.click();
  expect(camera.position.equals(start)).toBe(true);
  tick();
  const midway = camera.position.clone();
  expect(midway.distanceTo(start)).toBeGreaterThan(0);
  firstLabel.click();
  expect(camera.position.equals(midway)).toBe(true);
  for (let n = 0; n < 24; n++) tick();
  expect(Reflect.get(s.view, 'controls').target.toArray().map(Math.round)).toEqual([3, 1, 1]);
  s.view.setPerspective('first');
  const eye = camera.position.clone();
  const orientation = camera.quaternion.clone();
  secondLabel.click();
  expect(camera.position.equals(eye)).toBe(true);
  expect(camera.quaternion.equals(orientation)).toBe(true);
  tick();
  expect(camera.position.distanceTo(eye)).toBeGreaterThan(0);
  for (const kind of ['door', 'portal', 'street']) {
    const buttons = host.querySelectorAll<HTMLButtonElement>(`.viewer__link[data-kind="${kind}"]`);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toContain('花店');
    expect(buttons[1]!.textContent).toContain('前厅');
    buttons[0]!.click();
    expect(secondLabel.dataset.focused).toBe('true');
    expect(firstLabel.dataset.focused).toBeUndefined();
    expect(host.dataset.flyTarget).toBe(world(1));
    buttons[1]!.click();
    expect(firstLabel.dataset.focused).toBe('true');
    expect(secondLabel.dataset.focused).toBeUndefined();
    expect(host.dataset.flyTarget).toBe(world(0));
  }
  s.view.focusMember('second');
  expect(host.dataset.frame).toBe('8.00,1.00,11.00,10.00,3.00,15.00');
  s.view.focusMember(null);
  expect(host.dataset.frame).toBe('1.00,0.00,0.00,10.00,3.00,15.00');
  s.view.focusAnchor(null);
  expect(host.querySelector('.viewer__anchor[data-focused="true"]')).toBeNull();
});

// 覆盖 `GoalArtifact.normalized_goal[1,2]` 与 `success_criteria[2,3,4]`。
it('`VE-P13-03`：真实场景视图在成员取景后执行跨成员实体聚焦，切换模式与样式重建保持新目标姿态', async () => {
  const s = setup();
  const base = content({ ...source(), chunks: [] }).members[0]!.view;
  const initialContent: SceneContent = {
    mode: 'optimized',
    links: [],
    members: (
      [
        { spaceId: 'first', placement: { offset: [20, 0, 40], rotation: 90 } },
        { spaceId: 'second', placement: { offset: [200, 20, 300], rotation: 180 } },
      ] as const
    ).map((member) => ({
      ...member,
      view: {
        ...base,
        entities: [
          {
            entityId: 'room',
            kind: 'object',
            layer: 'rebuilt',
            bounds: { min: [0, 0, 0], max: [2, 2, 4] },
            shape: { type: 'box', size: [2, 2, 4], transform: { position: [1, 0, 2] } },
          },
        ],
      },
    })),
  };
  await s.view.setContent(initialContent);
  const host = hostOf(s.view);
  s.view.focusMember('first');
  expect(host.dataset.frame).toBe('1.00,0.00,0.00,5.00,2.00,2.00');
  const frame = host.dataset.frame;
  expect(
    s.view.applyCamera({ kind: 'focus', spaceId: 'second', entityId: 'room' }, initialContent),
  ).toBe(true);
  const target = placePoint(initialContent.members[1]!.placement, [1, 1, 2]);
  const flyTarget = target.map((value) => value.toFixed(2)).join(',');
  expect(flyTarget).toBe('9.00,2.00,13.00');
  expect(host.dataset.flyTarget).toBe(flyTarget);
  expect(Reflect.get(s.view, 'autoFramed')).toBe(false);
  expect((Reflect.get(s.view, 'flight') as { targetTo: THREE.Vector3 }).targetTo.toArray()).toEqual(
    target,
  );
  const nextContent: SceneContent = {
    ...initialContent,
    mode: 'extended',
    members: initialContent.members.map((member) => ({
      ...member,
      view: { ...member.view, styleLook: { wireframe: true, roughness: 0.9 } },
    })),
  };
  await s.view.setContent(nextContent);
  s.view.focusAnchor(null);
  expect(host.dataset.flyTarget).toBe(flyTarget);
  expect((Reflect.get(s.view, 'flight') as { targetTo: THREE.Vector3 }).targetTo.toArray()).toEqual(
    target,
  );
  expect(host.dataset.frame).toBe(frame);
  expect(Reflect.get(s.view, 'autoFramed')).toBe(false);
});

it('只切换样式时仅生成一次体素网格，复用几何并隔离材质', async () => {
  const s = setup();
  const voxels = source();
  await s.view.setContent(content(voxels, { roughness: 0.2 }));
  const first = s.meshes()[0]!;
  const release = vi.spyOn(first.geometry, 'dispose');
  await s.view.setContent(content(source(), { roughness: 0.8 }));
  const second = s.meshes()[0]!;
  expect(s.generate).toHaveBeenCalledOnce();
  expect(second.geometry).toBe(first.geometry);
  expect(second.geometry.getAttribute('position')).toBe(first.geometry.getAttribute('position'));
  expect(second.material).not.toBe(first.material);
  expect(first.material.roughness).toBe(0.2);
  expect(second.material.roughness).toBe(0.8);
  expect(release).not.toHaveBeenCalled();
  await s.view.setContent(content(voxels, { roughness: 0.2 }));
  expect(s.meshes()[0]!.material).toBe(first.material);
  s.view.dispose();
  views.splice(views.indexOf(s.view), 1);
  expect(release).toHaveBeenCalledOnce();
});

it('组合成员共享相同内容的生成任务和几何，各自保留外观', async () => {
  const s = setup();
  const first = content(source(), { roughness: 0.2 });
  const second = content(source(), { roughness: 0.8 });
  await s.view.setContent({
    ...first,
    members: [first.members[0]!, { ...second.members[0]!, spaceId: 'other' }],
  });
  const [a, b] = s.meshes();
  expect(s.generate).toHaveBeenCalledOnce();
  expect(a!.geometry).toBe(b!.geometry);
  expect(a!.material).not.toBe(b!.material);
  expect(a!.material.roughness).toBe(0.2);
  expect(b!.material.roughness).toBe(0.8);
});

it.each(['数据', '调色板', '坐标', '图层', '过滤区域'] as const)(
  '体素`%s`变化后更新几何，旧缓冲保留至缓存释放',
  async (change) => {
    const s = setup();
    const voxels = source();
    await s.view.setContent(content(voxels));
    const first = s.meshes()[0]!.geometry;
    const release = vi.spyOn(first, 'dispose');
    let next = voxels;
    if (change === '数据') voxels.chunks[0]!.cells[1] = 2;
    if (change === '调色板')
      next = {
        ...voxels,
        palette: {
          blocks: [{ ...voxels.palette.blocks[0]!, color: [0, 255, 0] }],
        },
      };
    if (change === '坐标') next = { ...voxels, chunks: [{ ...voxels.chunks[0]!, cx: 1 }] };
    if (change === '图层') next = { ...voxels, chunks: [{ ...voxels.chunks[0]!, layer: 'ext' }] };
    if (change === '过滤区域') next = { ...voxels, keepBoxes: [[0, 0, 0, 1, 1, 1]] };
    await s.view.setContent(content(next));
    expect(s.generate).toHaveBeenCalledTimes(2);
    const second = s.meshes()[0]!.geometry;
    expect(second).not.toBe(first);
    if (change === '数据') expect(s.view.getStats().voxelFaces).toBe(10);
    if (change === '调色板') expect(second.getAttribute('color').getY(0)).toBe(1);
    expect(release).not.toHaveBeenCalled();
  },
);

it('缓存驱逐只释放闲置缓冲，当前成员的缓冲仍可复用', async () => {
  const s = setup();
  const voxels = source();
  await s.view.setContent(content(voxels));
  const first = s.meshes()[0]!.geometry;
  const release = vi.spyOn(first, 'dispose');
  for (let cx = 1; cx <= 40; cx++) {
    await s.view.setContent(content({ ...voxels, chunks: [{ ...voxels.chunks[0]!, cx }] }));
  }
  expect(release).toHaveBeenCalledOnce();
  const current = s.meshes()[0]!.geometry;
  const releaseCurrent = vi.spyOn(current, 'dispose');
  await s.view.setContent(content({ ...voxels, chunks: [{ ...voxels.chunks[0]!, cx: 40 }] }));
  expect(s.meshes()[0]!.geometry).toBe(current);
  expect(releaseCurrent).not.toHaveBeenCalled();
  await s.view.setContent(content(voxels));
  expect(s.meshes()[0]!.geometry).not.toBe(first);
  expect(s.generate).toHaveBeenCalledTimes(42);
});

it('并发样式切换共用未完成任务，最新样式生效', async () => {
  const s = setup();
  const first = s.view.setContent(content(source(), { roughness: 0.2 }));
  const second = s.view.setContent(content(source(), { roughness: 0.8 }));
  await Promise.all([first, second]);
  expect(s.generate).toHaveBeenCalledOnce();
  expect(s.meshes()[0]!.material.roughness).toBe(0.8);
});

it('销毁后迟到的体素结果不会再创建缓冲', async () => {
  const s = setup();
  let resolve!: (result: VoxelMeshes) => void;
  s.generate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = s.view.setContent(content(source()));
  s.view.dispose();
  views.splice(views.indexOf(s.view), 1);
  const geometry = vi.spyOn(THREE.BufferGeometry.prototype, 'computeBoundingBox');
  resolve(voxelSourceMeshes(source()));
  await pending;
  expect(geometry).not.toHaveBeenCalled();
  expect(s.meshes()).toHaveLength(0);
});

it('体素任务失败后清除失败缓存，允许重新生成', async () => {
  const s = setup();
  s.generate.mockRejectedValueOnce(new Error('生成失败'));
  await expect(s.view.setContent(content(source()))).rejects.toThrow('生成失败');
  await s.view.setContent(content(source()));
  expect(s.generate).toHaveBeenCalledTimes(2);
  expect(s.meshes()).toHaveLength(1);
});

it.each(['完成', '失败'] as const)(
  '演示前厅异步贴图`%s`前后切换命名样式，剥离状态和外观持续成立',
  async (outcome) => {
    const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
    const scene = await loadScene(client, await client.snapshot(SPACE_ID, { seq: 4 }));
    const pending: { resolve: (texture: THREE.Texture) => void; reject: (error: Error) => void }[] =
      [];
    const load = vi.fn(
      () =>
        new Promise<THREE.Texture>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const view = new SceneView(document.createElement('div'), {
      meshService: inlineMeshService(),
      loadTexture: load,
    });
    views.push(view);
    const render = async (id: string) => {
      const style = BUILTIN_SPACE_STYLES.find((item) => item.id === id)!;
      await view.setContent({
        mode: 'extended',
        links: [],
        members: [
          {
            spaceId: SPACE_ID,
            placement: IDENTITY_PLACEMENT,
            view: selectViewForStyle(scene, style, 'extended'),
          },
        ],
      });
      const materials: (THREE.MeshStandardMaterial | THREE.MeshBasicMaterial)[] = [];
      (Reflect.get(view, 'content') as THREE.Group).traverse((object) => {
        if (object.name.startsWith('voxels:'))
          materials.push((object as THREE.Mesh).material as THREE.MeshStandardMaterial);
      });
      expect(materials.length).toBeGreaterThan(0);
      return { style, materials };
    };
    await render('extended-full');
    expect(load).toHaveBeenCalled();
    const stripped = await render('maquette');
    const verify = ({ style, materials }: typeof stripped) => {
      for (const material of materials) {
        expect(material.map).toBeNull();
        const expected = srgb(style.look!.objectColor!);
        if (style.look!.tint) expected.multiply(srgb(style.look!.tint));
        expect(material.color.toArray()).toEqual(expected.toArray());
        if (style.id === 'maquette') {
          if (material instanceof THREE.MeshStandardMaterial)
            expect(material).toMatchObject({ roughness: 0.92, metalness: 0.02 });
        } else
          expect(material).toMatchObject({ wireframe: true, opacity: 0.88, toneMapped: false });
      }
    };
    verify(stripped);
    for (const resource of pending.splice(0)) {
      if (outcome === '完成') resource.resolve(new THREE.Texture());
      else resource.reject(new Error('贴图加载失败'));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    verify(stripped);
    verify(await render('blueprint'));
    verify(await render('maquette'));
    for (const id of ['arch-realistic', 'voxel-blocks', 'extended-full']) {
      const { materials } = await render(id);
      if (outcome === '完成')
        expect(materials.some((material) => material.map !== null)).toBe(true);
    }
  },
);

const emptyVoxels = (): VoxelSource => ({ chunks: [], keepBoxes: null, palette: { blocks: [] } });
const sceneOf = (view: SceneView) => Reflect.get(view, 'scene') as THREE.Scene;
const hostOf = (view: SceneView) => Reflect.get(view, 'host') as HTMLElement;
const backgroundOf = (view: SceneView) =>
  (sceneOf(view).background as THREE.Color | null)?.getHexString();
function styledContent(id: string, skyHash?: string): SceneContent {
  const base = content(emptyVoxels());
  const style = BUILTIN_SPACE_STYLES.find((item) => item.id === id)!;
  const member = base.members[0]!;
  return {
    ...base,
    members: [
      {
        ...member,
        view: {
          ...member.view,
          lighting: style.lighting,
          backgroundColor: style.backgroundColor,
          entities: skyHash
            ? [
                {
                  entityId: 'sky',
                  layer: 'ext',
                  kind: 'object',
                  shape: { type: 'box', size: [1, 1, 1] },
                  textures: [skyHash],
                  props: {
                    background: true,
                    environment: { version: 1, sky: { texture: skyHash, yaw: 20 } },
                  },
                },
              ]
            : [],
        },
      },
    ],
  };
}

it.each(['maquette', 'blueprint', 'night-neon'])(
  '首次构建及往返切换 `%s` 始终保留样式背景色',
  async (id) => {
    const s = setup();
    const expected = BUILTIN_SPACE_STYLES.find((style) => style.id === id)!.backgroundColor!.slice(
      1,
    );
    await s.view.setContent(styledContent(id));
    expect(backgroundOf(s.view)).toBe(expected);
    await s.view.setContent(styledContent('extended-full'));
    expect(sceneOf(s.view).background).toBeNull();
    await s.view.setContent(styledContent(id));
    expect(backgroundOf(s.view)).toBe(expected);
  },
);

it('天空异步到达时样式色优先，画法、时间线和样式往返保留天空状态', async () => {
  let resolve!: (texture: THREE.Texture) => void;
  const load = vi.fn(
    () =>
      new Promise<THREE.Texture>((done) => {
        resolve = done;
      }),
  );
  const view = new SceneView(document.createElement('div'), {
    meshService: inlineMeshService(),
    loadTexture: load,
  });
  views.push(view);
  const hash = 'b'.repeat(64);
  await view.setContent(styledContent('extended-full', hash));
  expect(hostOf(view).dataset.sky).toBe('loading');
  expect(backgroundOf(view)).toBe('bad4e5');
  await view.setContent(styledContent('night-neon', hash));
  expect(backgroundOf(view)).toBe('090b14');
  resolve(new THREE.Texture());
  await Promise.resolve();
  expect(backgroundOf(view)).toBe('090b14');
  expect(hostOf(view).dataset.sky).toBe('ready');
  await view.setContent(styledContent('extended-full', hash));
  const sky = sceneOf(view).background;
  expect(sky).toBeInstanceOf(THREE.Texture);
  for (const style of ['blocks', 'shapes'] as const) {
    const next = styledContent('extended-full', hash);
    await view.setContent({
      ...next,
      members: [{ ...next.members[0]!, view: { ...next.members[0]!.view, style } }],
    });
    expect(sceneOf(view).background).toBe(sky);
    expect(hostOf(view).dataset.sky).toBe('ready');
  }
  await view.setContent(styledContent('night-neon', hash));
  expect(backgroundOf(view)).toBe('090b14');
  await view.setContent(styledContent('extended-full', hash));
  expect(sceneOf(view).background).toBe(sky);
  expect(load).toHaveBeenCalledOnce();
});

it('新代次等待网格期间旧天空回调不写背景，过期构建也不修改灯光', async () => {
  const service = inlineMeshService();
  let resolveSky!: (texture: THREE.Texture) => void;
  const load = vi.fn(
    () =>
      new Promise<THREE.Texture>((done) => {
        resolveSky = done;
      }),
  );
  const view = new SceneView(document.createElement('div'), {
    meshService: service,
    loadTexture: load,
  });
  views.push(view);
  const initial = styledContent('extended-full', 'b'.repeat(64));
  await view.setContent(initial);
  let resolveMesh!: (meshes: VoxelMeshes) => void;
  vi.spyOn(service, 'voxels').mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolveMesh = done;
      }),
  );
  const pending = styledContent('night-neon');
  const stale = view.setContent({
    ...pending,
    members: [{ ...pending.members[0]!, view: { ...pending.members[0]!.view, voxels: source() } }],
  });
  expect(backgroundOf(view)).toBe('bad4e5');
  resolveSky(new THREE.Texture());
  await Promise.resolve();
  expect(backgroundOf(view)).toBe('bad4e5');
  expect(hostOf(view).dataset.sky).toBe('loading');
  await view.setContent(styledContent('blueprint'));
  const lights = Reflect.get(view, 'lights') as THREE.Light[];
  expect(backgroundOf(view)).toBe('0c192c');
  resolveMesh(voxelSourceMeshes(source()));
  await stale;
  expect(backgroundOf(view)).toBe('0c192c');
  expect(Reflect.get(view, 'lights')).toBe(lights);
  expect(hostOf(view).dataset.sky).toBeUndefined();
});

it('旧天空资源迟到不覆盖新天空或新样式，释放时只清理副本', async () => {
  const pending: ((texture: THREE.Texture) => void)[] = [];
  const view = new SceneView(document.createElement('div'), {
    meshService: inlineMeshService(),
    loadTexture: () => new Promise((done) => pending.push(done)),
  });
  views.push(view);
  await view.setContent(styledContent('extended-full', 'a'.repeat(64)));
  await view.setContent(styledContent('night-neon', 'b'.repeat(64)));
  const old = new THREE.Texture();
  const clone = vi.spyOn(old, 'clone');
  pending[0]!(old);
  await Promise.resolve();
  expect(clone).not.toHaveBeenCalled();
  expect(backgroundOf(view)).toBe('090b14');
  expect(hostOf(view).dataset.sky).toBe('loading');
  pending[1]!(new THREE.Texture());
  await Promise.resolve();
  await view.setContent(styledContent('extended-full', 'b'.repeat(64)));
  expect(sceneOf(view).background).toBeInstanceOf(THREE.Texture);
  expect(hostOf(view).dataset.sky).toBe('ready');
});

it('组合优先保留可见环境，并从同一成员选择灯光和样式背景', async () => {
  const s = setup();
  const first = styledContent('extended-full').members[0]!;
  const second = { ...styledContent('night-neon', 'b'.repeat(64)).members[0]!, spaceId: 'second' };
  await s.view.setContent({ mode: 'extended', links: [], members: [first, second] });
  expect(backgroundOf(s.view)).toBe('090b14');
  expect(hostOf(s.view).dataset.environment).toBe('true');
  expect((Reflect.get(s.view, 'lights') as THREE.HemisphereLight[])[0]!.color.getHex()).toBe(
    0x20284f,
  );
  const withoutEnvironment = { ...second, view: { ...second.view, entities: [] } };
  await s.view.setContent({ mode: 'extended', links: [], members: [first, withoutEnvironment] });
  expect(sceneOf(s.view).background).toBeNull();
  expect(hostOf(s.view).dataset.environment).toBeUndefined();
  expect((Reflect.get(s.view, 'lights') as THREE.HemisphereLight[])[0]!.color.getHex()).toBe(
    0xffffff,
  );
});

it('组合成员异构图层可同场展示，切回原图层复用体素缓冲', async () => {
  const s = setup();
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const scene = await loadScene(client, await client.snapshot(SPACE_ID, { seq: 4 }));
  const base = {
    id: 'layers',
    name: '图层样式',
    description: '组合混搭',
    swatch: '#fff',
    mode: 'extended' as const,
    rebuiltStyle: 'blocks' as const,
  };
  const first = {
    spaceId: 'rebuilt',
    placement: IDENTITY_PLACEMENT,
    view: selectViewForStyle(scene, { ...base, visibleLayers: ['rebuilt'] }),
  };
  const second = {
    spaceId: 'ext',
    placement: { offset: [300, 0, 0] as const, rotation: 0 },
    view: selectViewForStyle(scene, { ...base, visibleLayers: ['ext'] }),
  };
  const both: SceneContent = { mode: 'extended', links: [], members: [first, second] };
  await s.view.setContent(both);
  const geometries = s.meshes().map((mesh) => mesh.geometry);
  expect(s.generate).toHaveBeenCalledTimes(2);
  expect(second.view.entities.length).toBeGreaterThan(0);
  expect(second.view.entities.every((entity) => entity.layer === 'ext')).toBe(true);
  await s.view.setContent({ ...both, members: [first] });
  await s.view.setContent(both);
  expect(s.generate).toHaveBeenCalledTimes(2);
  expect(s.meshes().map((mesh) => mesh.geometry)).toEqual(geometries);
});
