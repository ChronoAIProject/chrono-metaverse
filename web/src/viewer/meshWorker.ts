import { handleMeshRequest, transferables, type MeshRequest, type MeshResponse } from './meshJobs';

/**
 * 网格生成的后台线程：形状词表 → 三角网格、区块 → 可见面网格。
 * 结果的缓冲区作为可转移对象交回主线程，不复制。
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<MeshRequest>) => void) | null;
  postMessage(message: MeshResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const response = handleMeshRequest(event.data);
  scope.postMessage(response, transferables(response));
};
