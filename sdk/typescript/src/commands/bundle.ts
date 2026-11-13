import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { uploadFormatFromPath } from '../core/check/index.js';
import { parseUploadLimits, type UploadLimits } from '../core/limits.js';
import {
  idOf,
  PREVIEW_TTL_MAX,
  PREVIEW_TTL_MIN,
  REBUILD,
  type MetaverseApi,
  type SnapshotView,
  type UploadFormat,
} from '../transport/api.js';
import { ApiError } from '../transport/client.js';
import {
  checkPartSize,
  DEFAULT_PART_SIZE,
  describeJob,
  upload,
  waitForJob,
  type UploadResult,
} from '../transport/upload.js';
import {
  BundleFilesError,
  checkBundleDir,
  defaultBundleDir,
  describeBundleReport,
  readLimits,
  workspaceRebuiltTemplates,
  type BundleFileReport,
  type BundleReport,
} from '../workspace/bundle.js';
import { findWorkspaceRoot } from '../workspace/config.js';
import { saveDraft } from '../workspace/drafts.js';
import { readBase } from '../workspace/files.js';
import {
  CliError,
  displayPath,
  flag,
  formatBytes,
  makeApi,
  num,
  openWorkspace,
  parse,
  printJson,
  str,
  type CliContext,
  type Values,
  type Workspace,
} from './common.js';
import {
  describePublish,
  messageError,
  previewLink,
  publishDraft,
  READ_ONLY_PUSH,
} from './push.js';

export const BUNDLE_HELP = `metaverse bundle <check | push> [目录] [选项]

重建包是本地重建工具（metaverse-recon bundle）的输出：清单 manifest.json 加清单里列出的文件
（docs/SHAPES.md 第 7 节）。默认目录是工作区的 out/bundle/。

  metaverse bundle check [目录] [--seed] [--limits <文件>]
      检查清单的全部规则（与服务端相同，不展开成操作）；本地有的文件核对大小、sha256 和内容
      （glb、图片、扫描 zip，规则同服务端的上传核对）；只有模型的物件与模型的实测包围盒一致。
      本地没有的文件记成"依赖空间里已有"。上限取工作区的 limits.json（metaverse pull 写的），
      没有就用默认值。--seed：种子用的包，含内部锚点或建模记录时给出警告（种子包会公开）。

  metaverse bundle push [目录] [选项]
      先跑一遍 check；按清单的 base 建重建草稿；经 /rebuild/ 路径上传文件（同时 4 个；空间里已有、
      核对结果合乎用途的直接复用，本地没有又不能复用就停下）和清单；交包、等服务端展开；生成预览链接。
      默认不发布：人看过预览后用 metaverse publish <草稿编号> 发布。要求目标空间管理权；Agent Key 还需允许对应重建操作。

      --base latest       清单没有 base 时，以空间的最新版本为基础（冲突检查只覆盖从现在起的变化）
      --publish           展开后直接发布（agent key 的操作范围要包含发布接口）
      --replay            和 --publish 一起用：冲突时在最新版本上重放
      --realign           有意给线上同一份扫描换变换（重新对齐）时才加：不加时 --publish 遇到这种包会停下
      --message <说明>    提交说明（默认用清单的 note）
      --no-preview        不生成预览链接
      --preview-ttl <秒>  预览链接有效期，60–604800 秒（默认 24 小时）
      --part-size <MiB>   上传分片大小（默认 8）`;

/** 同时上传的文件数。 */
const UPLOAD_CONCURRENCY = 4;

interface BundleTarget {
  readonly dir: string;
  readonly ws: Workspace | null;
  readonly limits: UploadLimits | undefined;
  readonly limitsSource: string;
}

/** 包目录、工作区和上限：目录不给时用工作区的 out/bundle/；上限 --limits 优先，其次工作区的 limits.json。 */
function target(ctx: CliContext, values: Values, positional: string | undefined): BundleTarget {
  const start = resolve(ctx.cwd, str(values, 'dir') ?? '.');
  const root = findWorkspaceRoot(start);
  const ws = root !== null ? openWorkspace(ctx, values) : null;
  let dir: string;
  if (positional !== undefined) dir = resolve(ctx.cwd, positional);
  else if (ws !== null) dir = defaultBundleDir(ws.root);
  else {
    throw new CliError(
      `${start} 不在工作区里（找不到 metaverse.json）：请给出包目录，例如 metaverse bundle check out/bundle`,
    );
  }
  const limitsFile = str(values, 'limits');
  if (limitsFile !== undefined) {
    const path = resolve(ctx.cwd, limitsFile);
    try {
      return {
        dir,
        ws,
        limits: parseUploadLimits(JSON.parse(readFileSync(path, 'utf8'))),
        limitsSource: displayPath(ctx, path),
      };
    } catch (error) {
      throw new CliError(`--limits ${limitsFile} 不合法：${(error as Error).message}`);
    }
  }
  if (ws !== null) {
    const limits = readLimits(ws.root);
    if (limits !== null) {
      return {
        dir,
        ws,
        limits,
        limitsSource: `${displayPath(ctx, join(ws.root, 'limits.json'))}（服务端的当前上限）`,
      };
    }
  }
  return { dir, ws, limits: undefined, limitsSource: '默认值（工作区没有 limits.json）' };
}

async function check(t: BundleTarget, seed: boolean): Promise<BundleReport> {
  const spaceTemplates =
    t.ws !== null ? workspaceRebuiltTemplates(t.ws.root, t.ws.config.spaceId) : null;
  try {
    return await checkBundleDir(t.dir, {
      ...(t.limits !== undefined ? { limits: t.limits } : {}),
      limitsSource: t.limitsSource,
      spaceTemplates,
      ...(t.ws !== null ? { spaceId: t.ws.config.spaceId } : {}),
      seed,
    });
  } catch (error) {
    if (error instanceof BundleFilesError)
      throw new CliError(`重建包没有通过检查：${error.message}`);
    throw error;
  }
}

export async function runBundleCheck(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    seed: { type: 'boolean' },
    limits: { type: 'string' },
  });
  if (flag(values, 'help')) {
    ctx.out(BUNDLE_HELP);
    return 0;
  }
  const report = await check(target(ctx, values, positionals[0]), flag(values, 'seed'));
  if (flag(values, 'json')) {
    printJson(ctx, {
      ok: true,
      dir: report.dir,
      manifestHash: report.manifestHash,
      base: report.bundle.base,
      files: report.files.map((file) => ({
        path: file.path,
        purpose: file.purpose,
        sha256: file.sha256,
        size: file.size,
        local: file.local,
        ...(file.check !== undefined ? { check: file.check } : {}),
      })),
      references: Object.fromEntries(report.bundle.references),
      warnings: report.warnings,
    });
    return 0;
  }
  for (const line of describeBundleReport(report, formatBytes)) ctx.out(line);
  for (const warning of report.warnings) ctx.err(`注意：${warning}`);
  ctx.out('检查通过');
  return 0;
}

/** 上传时声明的格式：本地有文件就按核对记录，否则按扩展名猜（只用于复用探测）。 */
function formatOf(file: BundleFileReport): UploadFormat {
  const format = file.check?.format ?? uploadFormatFromPath(file.purpose, file.path);
  if (format === null) {
    throw new CliError(
      `${file.path}：本地没有这个文件，也认不出它的格式（按扩展名），没法探测空间里有没有`,
    );
  }
  return format as UploadFormat;
}

interface FileOutcome {
  readonly path: string;
  readonly reused: boolean;
  readonly uploadId: string | null;
}

/** 按顺序跑 `tasks`，同时最多 `limit` 个；有一个失败就不再开始新的，等手上的做完后抛出第一个错误。 */
async function pool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await task(item);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw failure;
}

/** 等上传核对任务（重建范围）。 */
async function settle(
  api: MetaverseApi,
  result: UploadResult,
  say: (line: string) => void,
  sleep: CliContext['sleep'],
): Promise<void> {
  if (result.jobId === null || result.reused) return;
  await waitForJob(api, result.jobId, {
    scope: REBUILD,
    onUpdate: (job) => say(`    ${describeJob(job)}`),
    ...(sleep ? { sleep } : {}),
  });
}

function describeApplied(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return [];
  const r = result as Record<string, unknown>;
  const lines: string[] = [];
  const entities = (r.entities ?? {}) as Record<string, unknown>;
  const anchors = (r.anchors ?? {}) as Record<string, unknown>;
  const count = (value: unknown): string =>
    Array.isArray(value) ? String(value.length) : typeof value === 'number' ? String(value) : '?';
  lines.push(
    `展开完成：放置物件 ${count(entities.placed)} 件，删除 ${count(entities.removed)} 件；新建锚点 ${count(anchors.created)} 个`,
  );
  if (Array.isArray(anchors.created) && anchors.created.length > 0) {
    lines.push(`  新建的锚点：${anchors.created.map(String).join('、')}`);
  }
  const skipped = Array.isArray(anchors.skipped)
    ? (anchors.skipped as Record<string, unknown>[])
    : [];
  if (skipped.length > 0) {
    lines.push(
      `  跳过的锚点（编号已经用过，不会覆盖；请人确认是不是被别人占了）：${skipped
        .map(
          (item) =>
            `${String(item.id ?? item.anchorId)}（${item.reason === 'existed' ? '曾经存在，被删过' : '已存在'}）`,
        )
        .join('、')}`,
    );
  }
  const drift = Array.isArray(r.anchorDrift) ? (r.anchorDrift as Record<string, unknown>[]) : [];
  if (drift.length > 0) {
    lines.push(
      `  锚点漂移（关联的物件不在锚点的盒子里，重建挪了物件、锚点没动）：${drift
        .map(
          (item) =>
            `${String(item.anchorId)}（${Array.isArray(item.entityIds) ? item.entityIds.join('、') : ''}）`,
        )
        .join('、')}`,
    );
    lines.push(
      '  建议：在实体区草稿里挪这些锚点（metaverse build 写 moveAnchor，再 metaverse push）',
    );
  }
  return lines;
}

export async function runBundlePush(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    base: { type: 'string' },
    publish: { type: 'boolean' },
    replay: { type: 'boolean' },
    realign: { type: 'boolean' },
    message: { type: 'string' },
    'no-preview': { type: 'boolean' },
    'preview-ttl': { type: 'string' },
    'part-size': { type: 'string' },
    limits: { type: 'string' },
  });
  if (flag(values, 'help')) {
    ctx.out(BUNDLE_HELP);
    return 0;
  }
  const json = flag(values, 'json');
  const say = (line: string) => {
    if (!json) ctx.out(line);
  };
  const t = target(ctx, values, positionals[0]);
  if (t.ws === null) {
    throw new CliError('bundle push 要在工作区里运行（metaverse init 建的目录，或用 --dir 指定）');
  }
  const ws = t.ws;
  const base = readBase(ws.root, ws.config.spaceId);
  if (base.space.readOnly === true) throw new CliError(READ_ONLY_PUSH);
  const baseFlag = str(values, 'base');
  if (baseFlag !== undefined && baseFlag !== 'latest') {
    throw new CliError('--base 只能是 latest（基础版本平时写在清单的 base 里）');
  }
  if (flag(values, 'replay') && !flag(values, 'publish')) {
    throw new CliError(
      '--replay 要和 --publish 一起用；草稿建好以后也可以 metaverse publish <草稿编号> --replay',
    );
  }
  const ttl = flag(values, 'no-preview') ? undefined : num(values, 'preview-ttl');
  if (
    ttl !== undefined &&
    (!Number.isInteger(ttl) || ttl < PREVIEW_TTL_MIN || ttl > PREVIEW_TTL_MAX)
  ) {
    throw new CliError(
      `--preview-ttl 必须是 ${PREVIEW_TTL_MIN} 到 ${PREVIEW_TTL_MAX} 之间的整数（秒）`,
    );
  }
  const partMiB = num(values, 'part-size');
  const partSize = partMiB !== undefined ? Math.round(partMiB * 1024 * 1024) : undefined;
  if (partSize !== undefined) checkPartSize(partSize);
  const message = str(values, 'message');
  if (message !== undefined) {
    const error = messageError(message);
    if (error !== null) throw new CliError(`没有推送：${error}`);
  }

  // 1. 检查。
  const report = await check(t, false);
  const bundle = report.bundle;
  say(
    `重建包 ${displayPath(ctx, t.dir)} 检查通过（${report.files.length} 个文件，清单 ${report.manifestHash.slice(0, 12)}…）`,
  );
  for (const warning of report.warnings) ctx.err(`注意：${warning}`);

  // 2. 基础版本。
  if (bundle.base === null && baseFlag !== 'latest') {
    throw new CliError(
      '清单没有 base（基于空间的第几版），没有推送：用工作区里的 metaverse-recon bundle 重新打包（会写上 base），' +
        '或者加 --base latest 以最新版本为基础（冲突检查只覆盖从现在起的变化）',
    );
  }
  if (bundle.base !== null && bundle.base.spaceId !== ws.config.spaceId) {
    throw new CliError(
      `清单是空间 ${bundle.base.spaceId} 的（base.spaceId），工作区是 ${ws.config.spaceId}，没有推送`,
    );
  }
  const api = makeApi(ctx, ws, values);
  const space = await api.getSpace();
  const head = space.head.seq;
  let baseSeq: number;
  if (bundle.base === null) {
    baseSeq = head;
    ctx.err(`注意：清单没有 base，以最新版本 seq ${head} 为基础；冲突检查只覆盖从现在起的变化`);
  } else {
    baseSeq = bundle.base.seq;
    if (baseSeq > head) {
      throw new CliError(
        `清单基于第 ${baseSeq} 版，但空间最新只到第 ${head} 版：包不是这个空间现在的时间线上做的（空间可能删掉重建过）`,
      );
    }
    if (head > baseSeq) {
      say(`注意：时间线已经从第 ${baseSeq} 版前进到第 ${head} 版，发布时服务端会检查冲突`);
    }
  }
  if (bundle.scan !== null && head > 0) {
    let current: SnapshotView['scan'];
    try {
      current = (await api.getSnapshot(head)).scan;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      ctx.err(`注意：读不了最新快照（HTTP ${error.status}），跳过扫描变换的核对`);
    }
    if (current !== undefined && current !== null) {
      const sameScan = current.assetHash === bundle.scan.assetHash;
      const sameTransform =
        current.transform !== undefined &&
        current.transform.length === 16 &&
        current.transform.every((v, i) => v === bundle.scan!.transform[i]);
      if (sameScan && !sameTransform) {
        const why =
          '包里的扫描与线上相同，但变换不同：线上的物件、锚点和扩展层是按线上的变换摆的，换变换会让它们与扫描错位';
        if (flag(values, 'publish') && !flag(values, 'realign')) {
          throw new CliError(
            `${why}。没有推送：用 metaverse pull 写的 scan/transform.json 重新打包；确实要重新对齐就加 --realign`,
          );
        }
        ctx.err(
          `注意：${why}。` +
            (flag(values, 'realign')
              ? '（--realign：按有意重新对齐处理）'
              : '不是有意重新对齐的话，用 metaverse pull 写的 scan/transform.json 重新打包'),
        );
      } else if (!sameScan) {
        ctx.err(
          '注意：包换了扫描：它的变换必须是配准到线上扫描得到的（metaverse-recon align --reference），' +
            '否则重建层会与锚点、扩展层错位；发布前看一眼预览',
        );
      }
    }
  }

  // 3. 上传文件：本地没有的先做复用探测，全部能复用才开始传别的。
  const outcomes = new Map<string, FileOutcome>();
  const missing = report.files.filter((file) => !file.local);
  const unavailable: string[] = [];
  for (const file of missing) {
    const session = await api.createUpload(
      file.purpose,
      {
        size: file.size,
        sha256: file.sha256,
        partSize: partSize ?? DEFAULT_PART_SIZE,
        format: formatOf(file),
      },
      REBUILD,
    );
    if (
      session.reused === true ||
      (session.status === 'done' && session.assetHash === file.sha256)
    ) {
      outcomes.set(file.path, {
        path: file.path,
        reused: true,
        uploadId: idOf(session, 'uploadId') ?? null,
      });
      say(`  ${file.path}（${file.purpose}）：本地没有，复用空间里已有的同一内容`);
    } else {
      unavailable.push(file.path);
    }
  }
  if (unavailable.length > 0) {
    throw new CliError(
      `这些文件本地没有，空间里也没有可以复用的同一内容（或者核对结果不合用途），没有推送：${unavailable.join('、')}。` +
        `把文件放进 ${displayPath(ctx, t.dir)} 的对应路径再推送`,
    );
  }
  const local = report.files.filter((file) => file.local);
  await pool(local, UPLOAD_CONCURRENCY, async (file) => {
    const result = await upload(api, {
      purpose: file.purpose,
      source: { path: join(t.dir, file.path) },
      scope: REBUILD,
      format: formatOf(file),
      known: { size: file.size, sha256: file.sha256 },
      ...(partSize !== undefined ? { partSize } : {}),
    });
    say(
      result.reused
        ? `  ${file.path}（${file.purpose}，${formatBytes(file.size)}）：空间里已有，直接复用`
        : `  ${file.path}（${file.purpose}，${formatBytes(file.size)}）：已上传 ${result.parts} 片，等服务端核对`,
    );
    await settle(api, result, say, ctx.sleep);
    outcomes.set(file.path, { path: file.path, reused: result.reused, uploadId: result.uploadId });
  });

  // 4. 清单本身。
  const manifest = await upload(api, {
    purpose: 'bundle',
    source: { path: report.manifestPath },
    scope: REBUILD,
    format: 'json',
    known: { size: report.manifestBytes, sha256: report.manifestHash },
    ...(partSize !== undefined ? { partSize } : {}),
  });
  await settle(api, manifest, say, ctx.sleep);
  say(`  清单 manifest.json：${manifest.reused ? '空间里已有' : '已上传，核对通过'}`);

  // 5. 建重建草稿、交包、等展开。
  const draft = await api.createDraft({ baseSeq }, REBUILD);
  const draftId = idOf(draft, 'draftId');
  if (draftId === undefined) throw new CliError('建草稿的响应里没有草稿编号');
  say(`已建重建草稿 ${draftId}（基于 seq ${baseSeq}）`);
  const started = await api.applyBundle(
    draftId,
    manifest.uploadId !== null
      ? { uploadId: manifest.uploadId }
      : { assetHash: manifest.assetHash },
  );
  const jobId = idOf(started, 'jobId');
  let applied: unknown = started;
  if (jobId !== undefined) {
    const job = await waitForJob(api, jobId, {
      scope: REBUILD,
      onUpdate: (j) => say(`  ${describeJob(j)}`),
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    });
    applied = job.result ?? null;
  }
  for (const line of describeApplied(applied)) say(line);

  // 6. 预览。
  let link: string | null = null;
  let previewRev: number | undefined;
  if (!flag(values, 'no-preview')) {
    const preview = await api.preview(
      draftId,
      ttl !== undefined ? { ttlSeconds: ttl } : {},
      REBUILD,
    );
    link = previewLink(ws.config.webUrl, preview);
    previewRev = preview.rev;
  }
  saveDraft(ws.root, draftId, {
    plot: null,
    scope: 'rebuild',
    ...(previewRev !== undefined ? { previewRev } : {}),
    baseSeq,
    bundle: report.manifestHash,
    createdAt: new Date().toISOString(),
    ...(message !== undefined ? { message } : {}),
    ...(link !== null ? { preview: link } : {}),
  });

  // 7. 发布（或者等人看过预览）。
  let published = null;
  if (flag(values, 'publish')) {
    published = await publishDraft(
      api,
      draftId,
      {
        message: message ?? bundle.note,
        ...(flag(values, 'replay') ? { replay: true } : {}),
      },
      REBUILD,
    );
  }
  if (json) {
    printJson(ctx, {
      draftId,
      baseSeq,
      manifestHash: report.manifestHash,
      files: [...outcomes.values()],
      applied,
      preview: link,
      previewRev: previewRev ?? null,
      published,
    });
    return 0;
  }
  ctx.out('');
  ctx.out(`草稿编号：${draftId}`);
  if (link !== null) ctx.out(`预览链接：${link}`);
  if (published !== null) {
    ctx.out(describePublish(draftId, published));
  } else {
    ctx.out(`请人看过预览后再发布：metaverse publish ${draftId}`);
  }
  return 0;
}

export async function runBundle(ctx: CliContext, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'check') return runBundleCheck(ctx, rest);
  if (sub === 'push') return runBundlePush(ctx, rest);
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    ctx.out(BUNDLE_HELP);
    return sub === undefined ? 1 : 0;
  }
  throw new CliError(`metaverse bundle 只有 check 和 push 两个子命令，不认识 ${sub}`);
}
