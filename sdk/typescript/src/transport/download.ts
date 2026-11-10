import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import type { AssetRange } from './api.js';
import { ApiError } from './client.js';

/**
 * 分段下载（docs/design/server-slim.md 8.5 `pull --scan`）：每段一个 `Range` 请求（默认 64 MiB），边下边
 * 追加到 `<目标>.part` 文件；中途断了，再运行一次从 `.part` 的长度接着下（断点续传）。经 NyxID 代理的
 * 单个请求约 100 秒就断，所以大文件（原始扫描最大 1 GiB）不能一次下完。全部下完核对 sha256，对了才改名
 * 成目标文件，不对就删掉 `.part` 报错。
 */

export const DEFAULT_SEGMENT_BYTES = 64 * 1024 * 1024;

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  /** 取一段：`[start, end)`。 */
  readonly fetchRange: (start: number, end: number) => Promise<AssetRange>;
  /** 下载中的文件（断点续传靠它的长度）。名字里最好带哈希，换了内容就不会接错。 */
  readonly partFile: string;
  readonly sha256: string;
  readonly segmentBytes?: number;
  /** 每段失败后的重试次数（读响应体时断开也算），默认 3。 */
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface DownloadResult {
  /** 下载完、核对过的文件（就是 `partFile` 去掉 `.part` 前的内容，调用方再改名）。 */
  readonly total: number;
  /** 从多少字节处接着下的（0 表示从头）。 */
  readonly resumedFrom: number;
  readonly segments: number;
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 下载到 `partFile`，核对 sha256。返回后 `partFile` 是完整、核对过的文件。 */
export async function downloadToPart(options: DownloadOptions): Promise<DownloadResult> {
  const segment = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let offset = existsSync(options.partFile) ? statSync(options.partFile).size : 0;
  const resumedFrom = offset;
  let total: number | null = null;
  let segments = 0;
  for (;;) {
    let range: AssetRange | null = null;
    for (let attempt = 1; range === null; attempt += 1) {
      try {
        range = await options.fetchRange(offset, offset + segment);
      } catch (error) {
        // 4xx（除 408、429）不会自己好，直接报错；网络错误、5xx、响应体读到一半断开都重试。
        const status = error instanceof ApiError ? error.status : 0;
        const retryable = status === 0 || status >= 500 || status === 408 || status === 429;
        if (status === 416 && offset > 0) {
          // 已经下完了（或 .part 比文件还长）：从头核对。
          range = { bytes: new Uint8Array(), start: offset, total: offset };
          break;
        }
        if (!retryable || attempt >= attempts) throw error;
        await sleep(1000 * attempt);
      }
    }
    if (range.start === 0 && offset > 0 && range.bytes.length > 0) {
      // 服务端没按 Range 回（给了整份）：丢掉已有的部分，从头写。
      truncateSync(options.partFile, 0);
      offset = 0;
    } else if (range.start !== offset) {
      throw new DownloadError(`分段下载的起点 ${range.start} 与请求的 ${offset} 不符`);
    }
    total = range.total;
    if (range.bytes.length > 0) {
      await appendFile(options.partFile, range.bytes);
      offset += range.bytes.length;
      segments += 1;
    }
    options.onProgress?.(offset, total);
    if (offset >= total || range.bytes.length === 0) break;
  }
  if (total === null || offset !== total) {
    unlinkSync(options.partFile);
    throw new DownloadError(
      `下载的长度 ${offset} 与文件的 ${total} 字节不符，已删掉下载到一半的文件，请重新运行`,
    );
  }
  const actual = await sha256OfFile(options.partFile);
  if (actual !== options.sha256) {
    unlinkSync(options.partFile);
    throw new DownloadError(
      `下载的内容 sha256 是 ${actual}，应为 ${options.sha256}；已删掉，请重新运行`,
    );
  }
  return { total, resumedFrom, segments };
}

/** 把核对过的 `.part` 改名成目标文件。 */
export function finishDownload(partFile: string, target: string): void {
  renameSync(partFile, target);
}
