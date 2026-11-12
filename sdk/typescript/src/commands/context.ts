import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { upload, waitForJob } from '../transport/upload.js';
import {
  checkContextOwnership,
  contextLayout,
  CONTEXT_SCRIPT,
  readContext,
} from '../workspace/context.js';
import { readBase, writeJson } from '../workspace/files.js';
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
import { runCheck } from './build.js';
import { runPush } from './push.js';

const HELP = `metaverse context <子命令> [--file out/context/entities.json] [--plot 地块]

  plan     根据背景范围生成 out/context/layout.json；保留主体和其他地块，不写线上数据
  stage    核对背景清单，准备独立的 out/context/build.ts，不覆盖已有建造脚本
  upload   通过当前用户权限上传背景 GLB，并等待服务端核对完成
  check    检查背景清单、物件范围和当前地块权限范围
  push     范围检查通过后上传模型并生成原生草稿预览；保持草稿，等待用户确认发布

首次导入：metaverse-recon context … → context plan → admin set-layout out/context/layout.json
→ pull → context check → context push → 用户看预览 → publish。
所有数据和脚本都在用户工作区，不需要 Git 或平台仓库写权限。`;

export async function runContext(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    file: { type: 'string' },
    plot: { type: 'string' },
    'preview-ttl': { type: 'string' },
    inline: { type: 'boolean' },
  });
  if (flag(values, 'help')) {
    ctx.out(HELP);
    return 0;
  }
  const action = positionals[0];
  if (!action || !['plan', 'stage', 'upload', 'check', 'push'].includes(action))
    throw new CliError(HELP);
  const ws = openWorkspace(ctx, values);
  const base = readBase(ws.root, ws.config.spaceId);
  if (!base.pulled || base.space.readOnly)
    throw new CliError('先通过当前账号执行 metaverse pull，不能从分享快照写入');
  const plot = str(values, 'plot') ?? ws.config.plot;
  if (!plot) throw new CliError('背景需要独立地块，请指定 --plot');
  const file = resolve(ws.root, str(values, 'file') ?? 'out/context/entities.json');
  const artifact = readContext(file);
  checkContextOwnership(base, artifact);
  const directory = join(ws.root, 'out/context');
  mkdirSync(directory, { recursive: true });
  if (action === 'plan') {
    const layout = contextLayout(base, artifact, plot);
    writeJson(join(directory, 'layout.json'), layout);
    printJson(ctx, { file: join(directory, 'layout.json'), baseSeq: base.space.seq, ...layout });
    return 0;
  }
  if (
    artifact.entities.some(
      (entity) => entity.regionId !== base.space.plots.find((item) => item.id === plot)?.regionId,
    )
  ) {
    throw new CliError('背景所属区域与目标地块不一致；先 plan、set-layout、pull，再重新生成清单');
  }
  const destination = join(directory, 'entities.json');
  if (file !== destination) copyFileSync(file, destination);
  const script = join(directory, 'build.ts');
  writeFileSync(script, CONTEXT_SCRIPT);
  const forwarded = Object.entries(values)
    .filter(([key]) => !['file', 'plot', 'inline', 'preview-ttl', 'help'].includes(key))
    .flatMap(([key, value]) =>
      typeof value === 'string' ? ['--' + key, value] : value === true ? ['--' + key] : [],
    );
  const buildArgs = [...forwarded, '--script', script, '--plot', plot];
  if (action === 'stage') {
    printJson(ctx, { script, entities: artifact.entities.length });
    return 0;
  }
  const check = await runCheck(ctx, buildArgs);
  if (check !== 0 || action === 'check') return check;
  const assets = [...new Set(artifact.entities.map((entity) => entity.assetHash!))];
  // 先核对全部本地文件，再进行第一笔网络写入；不相信文件名声称的哈希。
  for (const hash of assets) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(ws.root, 'assets', hash + '.glb'));
    } catch {
      throw new CliError(`缺少模型 ${hash}，请恢复工作区资源后再上传`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new CliError(`模型 ${hash} 内容哈希不符`);
  }
  const api = makeApi(ctx, ws, values);
  for (const hash of assets) {
    const result = await upload(api, {
      purpose: 'model',
      format: 'glb',
      scope: plot,
      source: { path: join(ws.root, 'assets', hash + '.glb') },
    });
    if (result.jobId)
      await waitForJob(api, result.jobId, {
        scope: plot,
        ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      });
    if (result.assetHash !== hash) throw new CliError('服务端返回的模型哈希不符');
    if (!flag(values, 'json')) ctx.out(`背景模型已核对：${hash}${result.reused ? '（复用）' : ''}`);
  }
  if (action === 'push')
    return runPush(ctx, [
      ...buildArgs,
      ...(flag(values, 'inline') ? ['--inline'] : []),
      ...(str(values, 'preview-ttl') ? ['--preview-ttl', str(values, 'preview-ttl')!] : []),
    ]);
  printJson(ctx, { uploaded: assets.length, scope: plot });
  return 0;
}
