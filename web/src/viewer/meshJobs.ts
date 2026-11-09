import { buildShape } from '../core/shapes/build';
import { triangleCount, type MeshData } from '../core/shapes/meshData';
import type { Material, Shape, TemplateTable } from '../core/shapes/types';
import { voxelSourceMeshes, type VoxelMeshes, type VoxelSource } from '../core/voxels';

/**
 * 网格生成任务（设计 7.2"网格在浏览器的后台线程里生成"）。这里是纯函数，
 * 后台线程（meshWorker.ts）和没有 Worker 的环境（单元测试）都直接调用。
 */

/** 一个形状任务：局部坐标的形状（不含最外层的 transform）和它用到的模板。 */
export interface ShapeJob {
  readonly key: string;
  readonly shape: Shape;
  readonly templates: TemplateTable;
}

export interface ShapeJobResult {
  readonly key: string;
  readonly parts: readonly { readonly mesh: MeshData; readonly material: Material }[];
  readonly warnings: readonly string[];
  readonly triangles: number;
}

export type MeshRequest =
  | { readonly id: number; readonly kind: 'shapes'; readonly jobs: readonly ShapeJob[] }
  | { readonly id: number; readonly kind: 'voxels'; readonly source: VoxelSource };

export type MeshResponse =
  | { readonly id: number; readonly kind: 'shapes'; readonly results: readonly ShapeJobResult[] }
  | { readonly id: number; readonly kind: 'voxels'; readonly meshes: VoxelMeshes }
  | { readonly id: number; readonly kind: 'error'; readonly message: string };

export function runShapeJob(job: ShapeJob): ShapeJobResult {
  try {
    const built = buildShape(job.shape, { templates: job.templates });
    return {
      key: job.key,
      parts: built.parts,
      warnings: built.warnings,
      triangles: built.parts.reduce((sum, part) => sum + triangleCount(part.mesh), 0),
    };
  } catch (error) {
    return {
      key: job.key,
      parts: [],
      warnings: [`网格生成失败：${error instanceof Error ? error.message : String(error)}`],
      triangles: 0,
    };
  }
}

export function runVoxelJob(source: VoxelSource): VoxelMeshes {
  return voxelSourceMeshes(source);
}

/** 结果里所有类型化数组的缓冲区，作为可转移对象交回主线程（不复制）。 */
export function transferables(response: MeshResponse): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (array: ArrayBufferView) => {
    if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
  };
  if (response.kind === 'shapes') {
    for (const result of response.results) {
      for (const { mesh } of result.parts) {
        add(mesh.positions);
        add(mesh.normals);
        add(mesh.uvs);
        add(mesh.indices);
      }
    }
  } else if (response.kind === 'voxels') {
    for (const part of response.meshes.parts) {
      add(part.positions);
      add(part.normals);
      add(part.colors);
      add(part.uvs);
      add(part.indices);
    }
  }
  return [...buffers];
}

export function handleMeshRequest(request: MeshRequest): MeshResponse {
  try {
    if (request.kind === 'shapes') {
      return { id: request.id, kind: 'shapes', results: request.jobs.map(runShapeJob) };
    }
    return { id: request.id, kind: 'voxels', meshes: runVoxelJob(request.source) };
  } catch (error) {
    return {
      id: request.id,
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
