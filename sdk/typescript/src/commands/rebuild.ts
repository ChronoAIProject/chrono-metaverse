import { isSha256Hex } from '../core/hash.js';
import { idOf, type JobView } from '../transport/api.js';
import { describeJob, waitForJob } from '../transport/upload.js';
import { readBase } from '../workspace/files.js';
import { authoredRequest, describeAuthored } from './authored.js';
import {
  CliError,
  flag,
  makeApi,
  openWorkspace,
  parse,
  printJson,
  str,
  type CliContext,
} from './common.js';

export const REBUILD_HELP = `metaverse rebuild [--authored <文件>] [--scan <扫描编号>] [选项]

对已导入的扫描重跑 AI 重建（rebuild 任务），结果写成一次新提交，等待并显示任务进度。

带 --authored 时不跑物体重建算法，重建层换成 AI 物件集里的物件（本地的 AI 逐件完成：先去模型库找
看起来差不多的现成模型，找不到再手写参数形状）。物件集格式：
  {"version": 1, "templates": [...], "entities": [...], "notes": "...", "structure": "keep" | "replace"}
规则见 worker/README.md "AI 物件集"。规范化后不超过 1MB 时随请求内联，更大的（≤ 4MB）先经 authored
用途分片上传、等校验通过再用资源哈希。处理服务下载并核对外部模型、烘焙贴图、逐件计算偏差，完成后
这里列出偏差最大的几件。

选项：
  --authored <文件>  AI 物件集（JSON）
  --scan <哈希>      扫描编号（= 扫描资源的内容哈希），默认取工作区拉取的最新扫描
  --hints <JSON>     给处理服务的提示（JSON 对象，≤ 4KB）
  --no-wait          发起任务后立刻返回`;

export async function runRebuild(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    authored: { type: 'string' },
    scan: { type: 'string' },
    hints: { type: 'string' },
    'no-wait': { type: 'boolean' },
  });
  if (flag(values, 'help')) {
    ctx.out(REBUILD_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const json = flag(values, 'json');
  const scanId = str(values, 'scan') ?? readBase(ws.root, ws.config.spaceId).space.scan?.assetHash;
  if (scanId === undefined) {
    throw new CliError(
      '不知道要重建哪个扫描：用 --scan <扫描资源哈希>，或者先 metaverse pull（工作区里没有扫描信息）',
    );
  }
  if (!isSha256Hex(scanId)) throw new CliError('--scan 必须是 64 位小写十六进制的扫描资源哈希');
  let hints: unknown;
  const hintsText = str(values, 'hints');
  if (hintsText !== undefined) {
    try {
      hints = JSON.parse(hintsText);
    } catch {
      throw new CliError('--hints 必须是 JSON 对象');
    }
    if (typeof hints !== 'object' || hints === null || Array.isArray(hints)) {
      throw new CliError('--hints 必须是 JSON 对象');
    }
  }
  const api = makeApi(ctx, ws, values);
  const waitOptions = {
    onUpdate: (job: JobView) => {
      if (!json) ctx.out(describeJob(job));
    },
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  };
  const authoredFile = str(values, 'authored');
  const authored =
    authoredFile !== undefined
      ? await authoredRequest(ctx, api, authoredFile, { json, wait: waitOptions })
      : undefined;
  const started = await api.rebuildScan(scanId, {
    ...(hints !== undefined ? { hints } : {}),
    ...(authored?.request ?? {}),
  });
  const jobId = idOf(started, 'jobId');
  if (jobId === undefined) throw new CliError('重建的响应里没有任务编号');
  if (!json) ctx.out(`已发起重建任务 ${jobId}（扫描 ${scanId}）`);
  const summary = { scanId, jobId, ...(authored ? { authored: authored.info } : {}) };
  if (flag(values, 'no-wait')) {
    if (json) printJson(ctx, summary);
    return 0;
  }
  // 任务失败时 waitForJob 抛出（带处理服务给的原因，例如哪个物件不合法、哪个模型的哈希不符）
  const job = await waitForJob(api, jobId, waitOptions);
  if (json) {
    printJson(ctx, { ...summary, job });
    return 0;
  }
  const result = (job.result ?? {}) as Record<string, unknown>;
  for (const line of describeAuthored(result)) ctx.out(line);
  if (result.unchanged === true) ctx.out('结果与当前状态完全相同，没有新提交。');
  else
    ctx.out(
      `重建完成${job.resultCommitId ? `，提交 ${job.resultCommitId}` : ''}。运行 metaverse pull 更新工作区。`,
    );
  return 0;
}
