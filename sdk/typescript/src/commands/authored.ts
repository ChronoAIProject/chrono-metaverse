import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { canonicalJson } from '../core/canonical.js';
import type { AuthoredOptions, MetaverseApi } from '../transport/api.js';
import { upload, waitForJob, type WaitOptions } from '../transport/upload.js';
import { CliError, formatBytes, type CliContext } from './common.js';

/**
 * AI 物件集（设计 6.3）：本地的 AI 逐件完成物件（先去模型库找看起来差不多的现成模型，找不到再手写参数形状），
 * 整套交给导入或重建任务写进重建层。格式见 worker/README.md "AI 物件集"：
 *
 * ```json
 * { "version": 1, "templates": [...], "entities": [...], "notes": "...", "structure": "keep" }
 * ```
 *
 * 小文件内联放在请求体里（`authored`）；规范化后超过 {@link INLINE_AUTHORED_BYTES} 时先经 authored 用途
 * 分片上传，等处理服务校验通过，再用资源哈希（`authoredAsset`）。命令行只做本地的浅层检查，规则和
 * 上限以接口服务、处理服务为准。
 */

/** 物件集规范化后的大小上限（与接口服务 `metaverse_core::authored::MAX_AUTHORED_BYTES` 相同）。 */
export const MAX_AUTHORED_BYTES = 4 * 1024 * 1024;
/** 超过这个大小（规范化后）就走上传，不内联。 */
export const INLINE_AUTHORED_BYTES = 1024 * 1024;

/** 读物件集文件并做本地的浅层检查。返回解析后的对象和规范化后的字节数。 */
export function readAuthored(
  ctx: CliContext,
  file: string,
): { path: string; doc: Record<string, unknown>; bytes: number } {
  const path = resolve(ctx.cwd, file);
  let text: string;
  try {
    if (statSync(path).size > MAX_AUTHORED_BYTES * 4) {
      throw new CliError(`物件集文件 ${path} 太大（规范化后不能超过 4MB）`);
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`读不了物件集文件 ${path}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CliError(`物件集文件 ${path} 不是合法的 JSON`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new CliError(
      '物件集必须是 JSON 对象 {version, templates?, entities, notes?, structure?}',
    );
  }
  const record = doc as Record<string, unknown>;
  if (record.version !== 1) throw new CliError('物件集的 version 必须是 1');
  if (!Array.isArray(record.entities) || record.entities.length === 0) {
    throw new CliError('物件集的 entities 必须是非空数组');
  }
  const bytes = Buffer.byteLength(canonicalJson(record), 'utf8');
  if (bytes > MAX_AUTHORED_BYTES) {
    throw new CliError(`物件集规范化后有 ${formatBytes(bytes)}，超过上限 4MB`);
  }
  return { path, doc: record, bytes };
}

/**
 * 物件集 → 请求体里的 `authored` 或 `authoredAsset`。大文件经 authored 用途上传（只经实体区路径），
 * 等校验任务完成；校验失败（格式不对）时抛出 UploadError。
 */
export async function authoredRequest(
  ctx: CliContext,
  api: MetaverseApi,
  file: string,
  options: { json: boolean; wait: WaitOptions },
): Promise<{ request: AuthoredOptions; info: Record<string, unknown> }> {
  const { path, doc, bytes } = readAuthored(ctx, file);
  const entities = (doc.entities as unknown[]).length;
  if (bytes <= INLINE_AUTHORED_BYTES) {
    if (!options.json) ctx.out(`物件集 ${basename(path)}：${entities} 个物件，随请求内联提交`);
    return { request: { authored: doc }, info: { inline: true, bytes, entities } };
  }
  if (!options.json) {
    ctx.out(`物件集 ${basename(path)}：${entities} 个物件（${formatBytes(bytes)}），先上传……`);
  }
  const result = await upload(api, {
    purpose: 'authored',
    source: { bytes: Buffer.from(canonicalJson(doc), 'utf8') },
    format: 'json',
  });
  // 校验失败（格式不对）时 waitForJob 抛出，带处理服务给的原因
  if (!result.reused && result.jobId !== null) await waitForJob(api, result.jobId, options.wait);
  return {
    request: { authoredAsset: result.assetHash },
    info: { inline: false, bytes, entities, assetHash: result.assetHash, reused: result.reused },
  };
}

/** 任务结果里的物件集统计（`result.authored`）→ 几行摘要：偏差最大的几件、下载、烘焙。 */
export function describeAuthored(result: unknown, top = 5): string[] {
  if (typeof result !== 'object' || result === null) return [];
  const authored = (result as { authored?: Record<string, unknown> }).authored;
  if (authored === undefined || authored === null) return [];
  const lines: string[] = [];
  const fit = Array.isArray(authored.fit) ? (authored.fit as Record<string, unknown>[]) : [];
  const measured = fit
    .filter((f) => typeof f.meanCm === 'number')
    .sort((a, b) => (b.meanCm as number) - (a.meanCm as number));
  lines.push(
    `物件集：${String(authored.entities ?? '?')} 个物件、${String(authored.templates ?? 0)} 个模板，结构 ${String(authored.structure ?? 'keep')}`,
  );
  if (measured.length > 0) {
    lines.push(
      `偏差最大的 ${Math.min(top, measured.length)} 件（扫描 → 物件，平均 / 90% / 3 厘米内）：`,
    );
    for (const f of measured.slice(0, top)) {
      const coverage =
        typeof f.coverage3cm === 'number' ? `${Math.round(f.coverage3cm * 100)}%` : '?';
      lines.push(
        `  ${String(f.entityId)}：${String(f.meanCm)} / ${String(f.p90Cm)} 厘米，${coverage}`,
      );
    }
  }
  const unmeasured = fit.length - measured.length;
  if (unmeasured > 0) lines.push(`  另有 ${unmeasured} 件附近没有扫描，没算偏差`);
  const downloads = authored.downloads as Record<string, unknown> | undefined;
  if (downloads && Number(downloads.models) > 0) {
    lines.push(
      `外部模型：下载 ${String(downloads.models)} 个（${String(downloads.files)} 个文件，${formatBytes(Number(downloads.bytes ?? 0))}）`,
    );
  }
  const bake = authored.bake as Record<string, unknown> | undefined;
  if (bake && Number(bake.parts) > 0) {
    lines.push(
      `烘焙：${String(bake.textured)} 处生成贴图${Number(bake.fallback) > 0 ? `，${String(bake.fallback)} 处附近没有扫描、用了后备纯色` : ''}`,
    );
  }
  return lines;
}
