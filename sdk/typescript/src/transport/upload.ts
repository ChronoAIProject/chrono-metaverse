import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import {
  idOf,
  type JobView,
  type MetaverseApi,
  type UploadFormat,
  type UploadPurpose,
} from './api.js';
import { ApiError } from './client.js';

/**
 * 分片上传（设计 6.1）：声明总大小、整体 SHA-256、分片大小和格式 → 逐片 PUT → 完成，
 * 返回 upload_verify 任务。内容已存在时服务端直接给出资源哈希，不再传数据。
 *
 * 分片大小必须是 256KiB 的整数倍、最大 32MiB；除最后一片外各片大小相同。经 NyxID
 * 代理时单个请求最大 100MB，默认 8MiB 一片。同一片重传是幂等的，失败的片自动重试。
 */

export const PART_UNIT = 256 * 1024;
export const MAX_PART_SIZE = 32 * 1024 * 1024;
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export function checkPartSize(partSize: number): void {
  if (
    !Number.isInteger(partSize) ||
    partSize <= 0 ||
    partSize % PART_UNIT !== 0 ||
    partSize > MAX_PART_SIZE
  ) {
    throw new UploadError('分片大小必须是 256KiB 的整数倍，且不超过 32MiB');
  }
}

/** 上传的数据：内存里的字节或磁盘文件。 */
export type UploadSource = { readonly bytes: Uint8Array } | { readonly path: string };

export interface UploadOptions {
  readonly purpose: UploadPurpose;
  readonly source: UploadSource;
  readonly plot?: string | null;
  readonly partSize?: number;
  /** 文件格式（必填）：服务端按用途核对，并按它核对第 0 片的文件头。 */
  readonly format: UploadFormat;
  readonly onProgress?: (sentBytes: number, totalBytes: number) => void;
}

export interface UploadResult {
  /** 资源哈希（= 整体 SHA-256）。 */
  readonly assetHash: string;
  readonly uploadId: string | null;
  /** upload_verify 任务；内容已存在时为 null。 */
  readonly jobId: string | null;
  readonly reused: boolean;
  readonly size: number;
  readonly parts: number;
}

async function describe(source: UploadSource): Promise<{ size: number; sha256: string }> {
  if ('bytes' in source) {
    return {
      size: source.bytes.length,
      sha256: createHash('sha256').update(source.bytes).digest('hex'),
    };
  }
  const info = await stat(source.path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source.path)) hash.update(chunk as Buffer);
  return { size: info.size, sha256: hash.digest('hex') };
}

async function readPart(source: UploadSource, offset: number, length: number): Promise<Uint8Array> {
  if ('bytes' in source) return source.bytes.subarray(offset, offset + length);
  const handle = await open(source.path, 'r');
  try {
    const buffer = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) throw new UploadError('文件在上传过程中变短了');
      filled += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function upload(api: MetaverseApi, options: UploadOptions): Promise<UploadResult> {
  const partSize = options.partSize ?? DEFAULT_PART_SIZE;
  checkPartSize(partSize);
  const { size, sha256 } = await describe(options.source);
  if (size === 0) throw new UploadError('不能上传空文件');
  const parts = Math.ceil(size / partSize);
  const session = await api.createUpload(
    options.purpose,
    { size, sha256, partSize, format: options.format },
    options.plot,
  );
  const uploadId = idOf(session, 'uploadId') ?? null;
  if (
    session.reused === true ||
    (session.status === 'done' && session.assetHash !== undefined) ||
    uploadId === null
  ) {
    if (session.assetHash !== undefined && session.assetHash !== sha256) {
      throw new UploadError(`服务端给出的资源哈希 ${session.assetHash} 与本地 ${sha256} 不一致`);
    }
    options.onProgress?.(size, size);
    return {
      assetHash: sha256,
      uploadId,
      jobId: session.jobId ?? null,
      reused: true,
      size,
      parts: 0,
    };
  }
  let sent = 0;
  for (let n = 0; n < parts; n += 1) {
    const offset = n * partSize;
    const length = Math.min(partSize, size - offset);
    const bytes = await readPart(options.source, offset, length);
    await api.putPart(options.purpose, uploadId, n, bytes, options.plot);
    sent += length;
    options.onProgress?.(sent, size);
  }
  const done = await api.completeUpload(options.purpose, uploadId, options.plot);
  return {
    assetHash: sha256,
    uploadId,
    jobId: idOf(done, 'jobId') ?? null,
    reused: false,
    size,
    parts,
  };
}

export interface WaitOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly onUpdate?: (job: JobView) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 轮询任务直到完成或失败。失败时抛出 UploadError（带 lastError）。 */
export async function waitForJob(
  api: MetaverseApi,
  jobId: string,
  options: WaitOptions = {},
): Promise<JobView> {
  const interval = options.intervalMs ?? 2000;
  const timeout = options.timeoutMs ?? 60 * 60 * 1000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  let last = '';
  for (;;) {
    let job: JobView;
    try {
      job = await api.getJob(jobId);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 500) {
        await sleep(interval);
        continue;
      }
      throw error;
    }
    const signature = JSON.stringify([job.status, job.attempt, job.progress, job.lastError]);
    if (signature !== last) {
      options.onUpdate?.(job);
      last = signature;
    }
    if (job.status === 'done') return job;
    if (job.status === 'failed') {
      throw new UploadError(`任务 ${jobId}（${job.kind}）失败：${job.lastError ?? '没有说明'}`);
    }
    if (Date.now() - started > timeout) throw new UploadError(`等待任务 ${jobId} 超时`);
    await sleep(interval);
  }
}

/** 任务状态的一行说明。 */
export function describeJob(job: JobView): string {
  const status =
    { queued: '排队中', running: '处理中', done: '已完成', failed: '失败' }[job.status] ??
    job.status;
  const attempt =
    job.attempt !== undefined && job.maxAttempts !== undefined
      ? `，第 ${job.attempt}/${job.maxAttempts} 次`
      : '';
  const progress =
    job.progress === undefined || job.progress === null
      ? ''
      : `，进度 ${JSON.stringify(job.progress)}`;
  const error = job.lastError ? `，上次错误：${job.lastError}` : '';
  return `任务 ${job.id ?? job.jobId ?? ''}（${job.kind}）${status}${attempt}${progress}${error}`;
}
