import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkIndex, emptyChunk } from '../core/chunk';
import type { Shape } from '../core/shapes/types';
import { handleMeshRequest, transferables, type MeshRequest, type MeshResponse } from './meshJobs';
import { createMeshService, inlineMeshService, workerMeshService } from './meshService';

const chair: Shape = {
  type: 'group',
  children: [
    { type: 'box', size: [0.4, 0.05, 0.4], fillet: 0.02 },
    {
      type: 'sweep',
      path: [
        [0, 0, 0],
        [0, 0.4, 0],
      ],
      section: { circle: 0.01 },
    },
  ],
};

function chunkWith(value: number) {
  const cells = emptyChunk();
  cells[chunkIndex(0, 0, 0)] = value;
  return { layer: 'ext' as const, cx: 0, cy: 0, cz: 0, cells };
}

const palette = { blocks: [{ id: 2, name: '石', kind: 'solid', color: [200, 0, 0] as const }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('网格任务', () => {
  it('形状任务：按材质分块，模板实例展开，三角形计数', () => {
    const response = handleMeshRequest({
      id: 1,
      kind: 'shapes',
      jobs: [
        { key: 'a', shape: { type: 'instance', template: 'chair' }, templates: { chair } },
        { key: 'b', shape: { type: 'instance', template: 'missing' }, templates: {} },
      ],
    });
    expect(response.kind).toBe('shapes');
    if (response.kind !== 'shapes') return;
    const [a, b] = response.results;
    expect(a!.triangles).toBeGreaterThan(300);
    expect(a!.parts).toHaveLength(1);
    expect(b!.parts).toHaveLength(0);
    expect(b!.warnings[0]).toContain('找不到模板');
    // 结果的缓冲区都作为可转移对象交回。
    expect(transferables(response).length).toBe(4);
  });

  it('方块任务：叠加、按区域过滤、生成可见面', () => {
    const request: MeshRequest = {
      id: 2,
      kind: 'voxels',
      source: { chunks: [chunkWith(2)], keepBoxes: null, palette },
    };
    const response = handleMeshRequest(request) as Extract<MeshResponse, { kind: 'voxels' }>;
    expect(response.meshes.faceCount).toBe(6);
    expect(transferables(response).length).toBe(5);
    const filtered = handleMeshRequest({
      ...request,
      source: { ...request.source, keepBoxes: [[5, 0, 0, 10, 10, 10]] },
    }) as Extract<MeshResponse, { kind: 'voxels' }>;
    expect(filtered.meshes.faceCount).toBe(0);
  });

  it('异常数据不让任务崩掉', () => {
    const response = handleMeshRequest({
      id: 3,
      kind: 'voxels',
      source: {
        chunks: [{ ...chunkWith(2), cells: new Uint16Array(3) }],
        keepBoxes: null,
        palette,
      },
    });
    expect(response.kind).toBe('voxels');
    const broken = handleMeshRequest({
      id: 4,
      kind: 'shapes',
      jobs: [{ key: 'x', shape: { type: 'box' } as unknown as Shape, templates: {} }],
    });
    expect(broken.kind).toBe('shapes');
  });
});

describe('网格服务', () => {
  it('没有 Worker 时在主线程分批执行，报告进度', async () => {
    const service = createMeshService();
    expect(service.threaded).toBe(false);
    const progress: number[] = [];
    const jobs = Array.from({ length: 30 }, (_, i) => ({
      key: `k${i}`,
      shape: { type: 'box', size: [1, 1, 1 + i] } as Shape,
      templates: {},
    }));
    const results = await service.shapes(jobs, (done) => progress.push(done));
    expect(results.map((r) => r.key)).toEqual(jobs.map((j) => j.key));
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(30);
    expect((await service.voxels({ chunks: [], keepBoxes: null, palette })).faceCount).toBe(0);
    expect(
      (await service.voxels({ chunks: [chunkWith(2)], keepBoxes: null, palette })).faceCount,
    ).toBe(6);
    service.dispose();
  });

  it('后台线程：消息往返、轮流分配、出错时等待中的任务失败', async () => {
    const posted: MeshRequest[] = [];
    const instances: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent<MeshResponse>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminated = false;
      fail = false;
      constructor() {
        instances.push(this);
      }
      postMessage(request: MeshRequest) {
        posted.push(request);
        setTimeout(() => {
          if (this.fail) {
            this.onerror?.({ message: '坏了', preventDefault() {} } as ErrorEvent);
            return;
          }
          this.onmessage?.({ data: handleMeshRequest(request) } as MessageEvent<MeshResponse>);
        }, 0);
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const service = workerMeshService(2);
    expect(service.threaded).toBe(true);
    const jobs = Array.from({ length: 50 }, (_, i) => ({
      key: `k${i}`,
      shape: { type: 'cone', radius: 1, height: 1 + i } as Shape,
      templates: {},
    }));
    const results = await service.shapes(jobs);
    expect(results).toHaveLength(50);
    expect(posted.length).toBe(3);
    expect(instances).toHaveLength(2);
    instances[0]!.fail = true;
    instances[1]!.fail = true;
    await expect(
      service.voxels({ chunks: [chunkWith(2)], keepBoxes: null, palette }),
    ).rejects.toThrow('后台线程出错');
    service.dispose();
    expect(instances.every((w) => w.terminated)).toBe(true);
  });

  it('inline 服务也能直接用', async () => {
    const service = inlineMeshService();
    const [result] = await service.shapes([{ key: 'c', shape: chair, templates: {} }]);
    expect(result!.triangles).toBeGreaterThan(0);
  });
});
