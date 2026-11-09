import type { VoxelMeshes, VoxelSource } from '../core/voxels';
import {
  handleMeshRequest,
  type MeshRequest,
  type MeshResponse,
  type ShapeJob,
  type ShapeJobResult,
} from './meshJobs';

/**
 * 主线程这边的网格服务：把任务交给后台线程（Web Worker），按批返回结果和进度。
 *
 * - 有 Worker 时起两个后台线程轮流接活，主线程只做 BufferGeometry 的组装，不卡界面；
 * - 没有 Worker（单元测试的 jsdom、极旧的浏览器）时在主线程分批执行，每批之间让出一次事件循环。
 */
export interface MeshService {
  /** 生成一批形状；`onProgress` 报告已完成的任务数。 */
  shapes(
    jobs: readonly ShapeJob[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ShapeJobResult[]>;
  voxels(source: VoxelSource): Promise<VoxelMeshes>;
  /** 用的是不是后台线程（统计和测试用）。 */
  readonly threaded: boolean;
  dispose(): void;
}

/** 每批的形状任务数：太大进度不平滑，太小消息往返太多。 */
const BATCH = 24;

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Run = (request: MeshRequest) => Promise<MeshResponse>;

function service(run: Run, threaded: boolean, dispose: () => void): MeshService {
  let nextId = 1;
  return {
    threaded,
    async shapes(jobs, onProgress) {
      const total = jobs.length;
      let done = 0;
      onProgress?.(0, total);
      const results = await Promise.all(
        batches(jobs, BATCH).map(async (batch) => {
          const response = await run({ id: nextId++, kind: 'shapes', jobs: batch });
          if (response.kind === 'error') throw new Error(response.message);
          if (response.kind !== 'shapes') throw new Error('网格服务返回了错误的结果类型');
          done += batch.length;
          onProgress?.(done, total);
          return response.results;
        }),
      );
      return results.flat();
    },
    async voxels(source) {
      if (source.chunks.length === 0) return { parts: [], faceCount: 0 };
      const response = await run({ id: nextId++, kind: 'voxels', source });
      if (response.kind === 'error') throw new Error(response.message);
      if (response.kind !== 'voxels') throw new Error('网格服务返回了错误的结果类型');
      return response.meshes;
    },
    dispose,
  };
}

/** 主线程执行（没有 Worker 时）。 */
export function inlineMeshService(): MeshService {
  return service(
    (request) =>
      new Promise((resolve) => {
        // 让出一次事件循环，保持和后台线程一样的异步语义。
        setTimeout(() => resolve(handleMeshRequest(request)), 0);
      }),
    false,
    () => undefined,
  );
}

/** 后台线程池。 */
export function workerMeshService(size = 2): MeshService {
  const workers = Array.from(
    { length: size },
    () => new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' }),
  );
  const pending = new Map<
    number,
    { resolve: (r: MeshResponse) => void; reject: (e: Error) => void }
  >();
  for (const worker of workers) {
    worker.onmessage = (event: MessageEvent<MeshResponse>) => {
      const entry = pending.get(event.data.id);
      if (entry === undefined) return;
      pending.delete(event.data.id);
      entry.resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      // 后台线程整个出错（脚本加载失败等）：所有等待中的任务都失败，交给调用方处理。
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.reject(new Error(`后台线程出错：${event.message}`));
      }
    };
  }
  let turn = 0;
  return service(
    (request) =>
      new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        const worker = workers[turn % workers.length]!;
        turn += 1;
        worker.postMessage(request);
      }),
    true,
    () => {
      for (const worker of workers) worker.terminate();
      for (const entry of pending.values()) entry.reject(new Error('网格服务已关闭'));
      pending.clear();
    },
  );
}

/** 能用 Worker 就用后台线程，否则在主线程执行。 */
export function createMeshService(): MeshService {
  if (typeof Worker === 'undefined') return inlineMeshService();
  try {
    return workerMeshService();
  } catch {
    return inlineMeshService();
  }
}
