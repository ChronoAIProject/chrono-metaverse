import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_OPS_PER_BATCH } from '../core/ops.js';
import { idOf } from '../transport/api.js';
import { ApiError } from '../transport/client.js';
import { describeJob, upload, waitForJob } from '../transport/upload.js';
import { opsToNdjson, runBuild } from '../workspace/build.js';
import { paths, writeJson } from '../workspace/files.js';
import { checkReport, diffSummary, formatDiff } from '../workspace/report.js';
import {
  CliError,
  flag,
  makeApi,
  num,
  openWorkspace,
  parse,
  printJson,
  str,
  type CliContext,
} from './common.js';

export const PUSH_HELP = `metaverse push [--plot <地块>] [--message <说明>]

把本地建造结果推成草稿：运行建造脚本 → 检查范围 → 操作写成 NDJSON → 分片上传（ops 用途）→
建草稿 → "从上传应用操作" → 生成预览。打印草稿编号、统计和预览链接，由人看过预览后再
metaverse publish <草稿编号>。

选项：
  --plot <地块>       目标地块（不给就是实体区，或 metaverse.json 的 plot）
  --message <说明>    提交说明（默认用建造脚本返回的 message）
  --inline            不上传文件，直接分批（每批 ≤ ${MAX_OPS_PER_BATCH} 条）调用批量操作接口
  --no-preview        不生成预览链接
  --preview-ttl <秒>  预览链接有效期（默认 24 小时，最长 7 天）
  --part-size <MiB>   上传分片大小（默认 8）`;

export const PUBLISH_HELP = `metaverse publish <草稿编号> [--plot <地块>] [--message <说明>] [--replay]

发布草稿（所用 agent key 的操作范围要包含发布接口）。草稿属于创建时的路径范围：push 时记下了
草稿的地块，也可以用 --plot 指定。时间线已前进且与草稿冲突时返回冲突的键；--replay 请服务端
在最新版本上重放草稿的操作。`;

interface DraftRecord {
  readonly plot: string | null;
  readonly baseSeq: number;
  readonly opCount: number;
  readonly createdAt: string;
  readonly preview?: string;
}

function draftsFile(root: string): string {
  return join(paths(root).out, 'drafts.json');
}

function readDrafts(root: string): Record<string, DraftRecord> {
  const file = draftsFile(root);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, DraftRecord>;
  } catch {
    return {};
  }
}

function saveDraft(root: string, draftId: string, record: DraftRecord): void {
  mkdirSync(paths(root).out, { recursive: true });
  writeJson(draftsFile(root), { ...readDrafts(root), [draftId]: record });
}

/** 预览链接：服务端给了完整地址就用它，否则用网站地址拼 `/preview#t=<令牌>`。 */
export function previewLink(
  webUrl: string | undefined,
  preview: { url?: string; token?: string },
): string | null {
  if (preview.url) return preview.url;
  if (!preview.token) return null;
  const base = (webUrl ?? '').replace(/\/+$/, '');
  return `${base}/preview#t=${preview.token}`;
}

export async function runPush(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    plot: { type: 'string' },
    script: { type: 'string' },
    message: { type: 'string' },
    inline: { type: 'boolean' },
    'no-preview': { type: 'boolean' },
    'preview-ttl': { type: 'string' },
    'part-size': { type: 'string' },
  });
  if (flag(values, 'help')) {
    ctx.out(PUSH_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const json = flag(values, 'json');
  const say = (line: string) => {
    if (!json) ctx.out(line);
  };
  const plot = str(values, 'plot') ?? ws.config.plot ?? null;
  const script = str(values, 'script');
  const result = await runBuild(ws.root, ws.config, {
    plot,
    ...(script !== undefined ? { script } : {}),
  });
  const report = checkReport(result);
  if (!report.ok) throw new CliError(`没有推送：${report.text}`);
  if (result.ops.length === 0) {
    say('建造脚本没有产生任何操作，不用推送');
    return 0;
  }
  if (!result.base.pulled) throw new CliError('工作区还没有拉取：先运行 metaverse pull');
  const api = makeApi(ctx, ws, values);
  const waitOptions = {
    onUpdate: (job: Parameters<typeof describeJob>[0]) => say(describeJob(job)),
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  };
  const baseSeq = result.base.space.seq;
  const space = await api.getSpace();
  if (space.head.seq !== baseSeq) {
    say(
      `注意：时间线已从 seq ${baseSeq} 前进到 ${space.head.seq}；发布时服务端会检查冲突（冲突就先 pull 再 build、push）`,
    );
  }
  const message = str(values, 'message') ?? result.message ?? undefined;
  const draft = await api.createDraft(
    { baseSeq, ...(message !== undefined ? { message } : {}) },
    plot,
  );
  const draftId = idOf(draft, 'draftId');
  if (draftId === undefined) throw new CliError('建草稿的响应里没有草稿编号');
  say(`已建草稿 ${draftId}（${plot ? `地块 ${plot}` : '实体区'}，基于 seq ${baseSeq}）`);
  let applied: unknown = null;
  if (flag(values, 'inline')) {
    for (let start = 0; start < result.ops.length; start += MAX_OPS_PER_BATCH) {
      const batch = result.ops.slice(start, start + MAX_OPS_PER_BATCH);
      applied = await api.addOps(draftId, batch, plot);
      say(`  已提交第 ${start + 1}–${start + batch.length} 条`);
    }
  } else {
    const ndjson = new TextEncoder().encode(opsToNdjson(result.ops));
    const partMiB = num(values, 'part-size');
    const uploaded = await upload(api, {
      purpose: 'ops',
      source: { bytes: ndjson },
      plot,
      format: 'ndjson',
      ...(partMiB !== undefined ? { partSize: Math.round(partMiB * 1024 * 1024) } : {}),
    });
    say(
      `已上传操作文件（${result.ops.length} 条，${ndjson.length} 字节，资源 ${uploaded.assetHash}）`,
    );
    if (uploaded.jobId !== null) await waitForJob(api, uploaded.jobId, waitOptions);
    // 接口服务只接受 { uploadId } 或 { assetHash } 之一：有上传编号（包括复用已有内容时）就用它。
    const started = await api.opsFromUpload(
      draftId,
      uploaded.uploadId !== null
        ? { uploadId: uploaded.uploadId }
        : { assetHash: uploaded.assetHash },
      plot,
    );
    const jobId = idOf(started, 'jobId');
    if (jobId !== undefined) {
      const job = await waitForJob(api, jobId, waitOptions);
      applied = job.result ?? null;
    } else {
      applied = started;
    }
  }
  let link: string | null = null;
  if (!flag(values, 'no-preview')) {
    const ttl = num(values, 'preview-ttl');
    const preview = await api.preview(draftId, ttl !== undefined ? { ttlSec: ttl } : {}, plot);
    link = previewLink(ws.config.webUrl, preview);
  }
  saveDraft(ws.root, draftId, {
    plot,
    baseSeq,
    opCount: result.ops.length,
    createdAt: new Date().toISOString(),
    ...(link !== null ? { preview: link } : {}),
  });
  const summary = diffSummary(result);
  if (json) {
    printJson(ctx, {
      draftId,
      plot,
      baseSeq,
      opCount: result.ops.length,
      summary,
      applied,
      preview: link,
    });
    return 0;
  }
  ctx.out('');
  ctx.out(formatDiff(summary));
  ctx.out('');
  ctx.out(`草稿编号：${draftId}`);
  if (link !== null) ctx.out(`预览链接：${link}`);
  ctx.out(`请人看过预览后再发布：metaverse publish ${draftId}`);
  return 0;
}

export async function runPublish(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    plot: { type: 'string' },
    message: { type: 'string' },
    replay: { type: 'boolean' },
  });
  if (flag(values, 'help')) {
    ctx.out(PUBLISH_HELP);
    return 0;
  }
  const draftId = positionals[0];
  if (draftId === undefined) throw new CliError('用法：metaverse publish <草稿编号>');
  const ws = openWorkspace(ctx, values);
  const record = readDrafts(ws.root)[draftId];
  const plot = str(values, 'plot') ?? record?.plot ?? null;
  const api = makeApi(ctx, ws, values);
  const message = str(values, 'message');
  try {
    const result = await api.publish(
      draftId,
      {
        ...(message !== undefined ? { message } : {}),
        ...(flag(values, 'replay') ? { replay: true } : {}),
      },
      plot,
    );
    if (flag(values, 'json')) printJson(ctx, result);
    else {
      ctx.out(
        `已发布草稿 ${draftId}${result.seq !== undefined ? `：seq ${result.seq}` : ''}${result.at ? `（${result.at}）` : ''}`,
      );
      ctx.out('运行 metaverse pull 把工作区更新到最新版本');
    }
    return 0;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const body = (error.body ?? {}) as Record<string, unknown>;
      const conflicts = body.conflicts ?? body.conflictingKeys;
      throw new CliError(
        [
          `发布冲突：${error.message}`,
          conflicts !== undefined ? `冲突的键：${JSON.stringify(conflicts)}` : '',
          '处理：metaverse pull → metaverse build → metaverse push 生成新草稿；或者 --replay 请服务端在最新版本上重放。',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    throw error;
  }
}
