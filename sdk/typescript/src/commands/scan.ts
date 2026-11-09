import { existsSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { isSha256Hex } from '../core/hash.js';
import { idOf, type UploadFormat } from '../transport/api.js';
import { describeJob, upload, waitForJob } from '../transport/upload.js';
import {
  CliError,
  flag,
  formatBytes,
  makeApi,
  num,
  openWorkspace,
  parse,
  printJson,
  str,
  type CliContext,
} from './common.js';

export const SCAN_HELP = `metaverse scan <文件> [选项]

分片上传扫描（glb / drc / obj / zip），完成后发起导入任务（scan_import：对齐 → 网页用模型 →
AI 重建 → 写提交，可选体素化），等待并显示任务进度。扫描只能经实体区路径上传。
带贴图的 OBJ 扫描请把模型和贴图打包成 zip 再上传（例如 Scaniverse 导出的 zip），否则贴图转移拿不到原贴图；
glb 内嵌贴图，直接上传即可。

选项：
  --observed-at <时间>    扫描拍摄时间（RFC 3339），只用于显示
  --transform <16 个数>   扫描坐标 → 空间坐标的 4×4 列主序矩阵（逗号分隔）；不给就自动对齐。
                          给了就用对齐接口（scans/{哈希}/alignment）按这个变换导入
  --no-rebuild            不做 AI 重建
  --voxelize              同时体素化（方块风格）
  --part-size <MiB>       分片大小（默认 8，必须是 0.25 的整数倍，最大 32）
  --asset <哈希>          不上传，直接用已上传的扫描资源发起导入（加 --transform 就是重新对齐）
  --no-wait               发起任务后立刻返回`;

/** 扩展名 → 上传格式（接口服务 scan 用途默认接受 glb、drc、obj、zip）。 */
export const SCAN_FORMATS: Readonly<Record<string, UploadFormat>> = {
  '.glb': 'glb',
  '.drc': 'drc',
  '.obj': 'obj',
  '.zip': 'zip',
};

/** 按扩展名判断扫描文件的格式；不认识时返回 null。 */
export function scanFormat(path: string): UploadFormat | null {
  return SCAN_FORMATS[extname(path).toLowerCase()] ?? null;
}

export function parseTransform(text: string): number[] {
  const values = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (values.length !== 16 || !values.every(Number.isFinite)) {
    throw new CliError('--transform 必须是 16 个数（4×4 列主序矩阵，逗号分隔）');
  }
  return values;
}

export async function runScan(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'observed-at': { type: 'string' },
    transform: { type: 'string' },
    'no-rebuild': { type: 'boolean' },
    voxelize: { type: 'boolean' },
    'part-size': { type: 'string' },
    asset: { type: 'string' },
    'no-wait': { type: 'boolean' },
  });
  if (flag(values, 'help')) {
    ctx.out(SCAN_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const api = makeApi(ctx, ws, values);
  const json = flag(values, 'json');
  const wait = !flag(values, 'no-wait');
  const waitOptions = {
    onUpdate: (job: Parameters<typeof describeJob>[0]) => {
      if (!json) ctx.out(describeJob(job));
    },
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  };
  // 参数先检查完再上传（扫描可能有上 GB，传完才发现参数不对就白传了）。
  const transformText = str(values, 'transform');
  const transform = transformText !== undefined ? parseTransform(transformText) : undefined;
  const observedAt = str(values, 'observed-at');
  if (observedAt !== undefined && Number.isNaN(Date.parse(observedAt))) {
    throw new CliError('--observed-at 必须是 RFC 3339 时间，例如 2026-11-01T10:00:00Z');
  }
  let assetHash = str(values, 'asset');
  let uploadInfo: Record<string, unknown> = {};
  if (assetHash !== undefined) {
    if (!isSha256Hex(assetHash)) throw new CliError('--asset 必须是 64 位小写十六进制的资源哈希');
  } else {
    const file = positionals[0];
    if (file === undefined) throw new CliError('用法：metaverse scan <文件>');
    const path = resolve(ctx.cwd, file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new CliError(`找不到文件 ${path}`);
    const format = scanFormat(path);
    if (format === null) {
      throw new CliError(
        '扫描只接受 glb、drc、obj、zip 文件（OBJ 带贴图时把模型和贴图打包成 zip）',
      );
    }
    const partMiB = num(values, 'part-size');
    const size = statSync(path).size;
    if (!json) ctx.out(`上传 ${basename(path)}（${formatBytes(size)}）……`);
    let lastPercent = -1;
    const result = await upload(api, {
      purpose: 'scan',
      source: { path },
      ...(partMiB !== undefined ? { partSize: Math.round(partMiB * 1024 * 1024) } : {}),
      format,
      onProgress: (sent, total) => {
        const percent = Math.floor((sent / total) * 100);
        if (!json && percent >= lastPercent + 10) {
          lastPercent = percent;
          ctx.out(`  已上传 ${percent}%（${formatBytes(sent)} / ${formatBytes(total)}）`);
        }
      },
    });
    assetHash = result.assetHash;
    uploadInfo = { ...result };
    if (result.reused) {
      if (!json) ctx.out(`服务端已有同样的内容，直接复用资源 ${assetHash}`);
    } else if (result.jobId !== null) {
      if (!json) ctx.out(`上传完成，等待校验（任务 ${result.jobId}）……`);
      await waitForJob(api, result.jobId, waitOptions);
    }
  }
  // 导入扫描（scans）不收变换：给了 --transform 时（首次导入或重新对齐都一样）一律走
  // scans/{scan_id}/alignment，它只要求资源已校验，不要求扫描已经提交过。
  const options = {
    ...(observedAt !== undefined ? { observedAt } : {}),
    rebuild: !flag(values, 'no-rebuild'),
    voxelize: flag(values, 'voxelize'),
  };
  const started =
    transform !== undefined
      ? await api.alignScan(assetHash, { transform, ...options })
      : await api.importScan({ assetHash, ...options });
  const jobId = idOf(started, 'jobId');
  if (jobId === undefined) throw new CliError('导入扫描的响应里没有任务编号');
  if (!json) ctx.out(`已发起导入任务 ${jobId}（扫描编号 = 资源哈希 ${assetHash}）`);
  if (!wait) {
    if (json) printJson(ctx, { assetHash, jobId, upload: uploadInfo });
    return 0;
  }
  const job = await waitForJob(api, jobId, waitOptions);
  const result = (job.result ?? {}) as Record<string, unknown>;
  if (json) {
    printJson(ctx, { assetHash, jobId, job, upload: uploadInfo });
  } else if (result.needsAlignment === true) {
    ctx.out(`重扫配准误差 ${String(result.errorCm ?? '?')} 厘米，超过阈值，没有自动提交。`);
    ctx.out(`建议的变换：${JSON.stringify(result.proposedTransform ?? null)}`);
    ctx.out(`确认后用：metaverse scan --asset ${assetHash} --transform <16 个数>`);
  } else {
    ctx.out(
      `导入完成${job.resultCommitId ? `，提交 ${job.resultCommitId}` : ''}。运行 metaverse pull 更新工作区。`,
    );
  }
  return result.needsAlignment === true ? 2 : 0;
}
