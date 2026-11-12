import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { upload, waitForJob } from '../transport/upload.js';
import { readBase, writeJson } from '../workspace/files.js';
import {
  EDIT_SCRIPT,
  parseEdit,
  placementLayout,
  readEdit,
  type EditPlan,
} from '../workspace/edit.js';
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
import { messageError, runPush } from './push.js';

const HELP = `metaverse edit <inspect|plan|stage|check|upload|push> [--file work/edit.json] [--plot 地块]

  inspect  读取空间版本、物件、锚点和区域，供生成或调整标准操作
  plan     根据放置物件生成可选的地块布局计划；只写本地文件
  stage    从 JSON 操作准备编辑，不需要写脚本，不覆盖已有建造脚本
  check    检查新增、更新、删除等操作及资源文件是否有效并在授权范围内
  upload   先通过本地检查，再上传模型或贴图并等待服务端核对
  push     执行同一套检查和上传，生成草稿预览，等待用户确认发布

编辑计划：{version:1,message,baseSeq?,ops:[标准空间操作],assets?:[{hash,format,path?}]}。
物件可以是家具、装饰、建筑或参数形状；背景只是可选的显示属性。
不给 --plot 时使用当前工作区的作用范围，不要求新地块或背景前缀。`;

export async function runEdit(
  ctx: CliContext,
  args: readonly string[],
  supplied?: EditPlan,
): Promise<number> {
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
  if (!action || !['inspect', 'plan', 'stage', 'check', 'upload', 'push'].includes(action))
    throw new CliError(HELP);
  const ws = openWorkspace(ctx, values);
  const base = readBase(ws.root, ws.config.spaceId);
  if (!base.pulled) throw new CliError('先执行 metaverse pull 读取空间');
  if (action === 'inspect') {
    printJson(ctx, {
      spaceId: ws.config.spaceId,
      seq: base.space.seq,
      entities: base.entities,
      anchors: base.anchors,
      regions: base.space.regions,
      plots: base.space.plots,
    });
    return 0;
  }
  if (base.space.readOnly) throw new CliError('分享快照不能编辑，请通过当前账号重新拉取空间');
  const plan = supplied
    ? parseEdit(supplied)
    : readEdit(resolve(ws.root, str(values, 'file') ?? 'work/edit.json'));
  const error = messageError(plan.message);
  if (error) throw new CliError(error);
  if (plan.baseSeq !== undefined && plan.baseSeq !== base.space.seq)
    throw new CliError('空间版本与编辑计划不一致，请重新读取空间并核对改动');
  const plot = str(values, 'plot') ?? ws.config.plot;
  const directory = join(ws.root, 'out/edit');
  mkdirSync(directory, { recursive: true });
  if (action === 'plan') {
    if (!plot) throw new CliError('规划地块需要 --plot；已有实体区可直接 check 或 push');
    const entities = plan.ops.flatMap((op) =>
      op.op === 'placeEntity' && op.entity.kind !== 'template' ? [op.entity] : [],
    );
    const layout = placementLayout(base, entities, plot, plan.message);
    writeJson(join(directory, 'layout.json'), layout);
    printJson(ctx, { file: join(directory, 'layout.json'), baseSeq: base.space.seq, ...layout });
    return 0;
  }
  writeJson(join(directory, 'plan.json'), plan);
  const script = join(directory, 'build.ts');
  writeFileSync(script, EDIT_SCRIPT);
  const forwarded = Object.entries(values)
    .filter(([key]) => !['file', 'inline', 'preview-ttl', 'help'].includes(key))
    .flatMap(([key, value]) =>
      typeof value === 'string' ? ['--' + key, value] : value === true ? ['--' + key] : [],
    );
  const buildArgs = [...forwarded, '--script', script];
  if (action === 'stage') {
    printJson(ctx, { script, operations: plan.ops.length });
    return 0;
  }
  // 中间检查先缓存在本地；JSON 模式只输出当前命令的完整结果。
  const checkOutput: string[] = [];
  const reportCheck = () => checkOutput.forEach((line) => ctx.out(line));
  const check = await runCheck({ ...ctx, out: (line) => checkOutput.push(line) }, buildArgs);
  if (check !== 0) {
    reportCheck();
    return check;
  }
  // 所有资源先核对，再发出第一笔网络写入；支持复用已在线上的资源。
  const local = (plan.assets ?? []).map((asset) => {
    const file = resolve(ws.root, asset.path ?? `assets/${asset.hash}.${asset.format}`);
    let actual: string;
    try {
      actual = realpathSync(file);
    } catch {
      throw new CliError(`缺少资源 ${asset.hash}`);
    }
    const path = relative(realpathSync(ws.root), actual);
    if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
      throw new CliError('资源文件必须位于空间工作区内');
    const bytes = readFileSync(actual);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.hash)
      throw new CliError(`资源 ${asset.hash} 内容哈希不符`);
    return { ...asset, file: actual };
  });
  if (action === 'check') {
    reportCheck();
    return 0;
  }
  if (!flag(values, 'json')) reportCheck();
  const api = makeApi(ctx, ws, values);
  for (const asset of local) {
    const result = await upload(api, {
      purpose: asset.format === 'glb' ? 'model' : 'texture',
      format: asset.format === 'jpg' ? 'jpeg' : asset.format,
      scope: plot ?? null,
      source: { path: asset.file },
    });
    if (result.jobId)
      await waitForJob(api, result.jobId, {
        scope: plot ?? null,
        ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      });
    if (result.assetHash !== asset.hash) throw new CliError('服务端返回的资源哈希不符');
    if (!flag(values, 'json'))
      ctx.out(`资源已核对：${asset.hash}${result.reused ? '（复用）' : ''}`);
  }
  if (action === 'push')
    return runPush(ctx, [
      ...buildArgs,
      ...(flag(values, 'inline') ? ['--inline'] : []),
      ...(str(values, 'preview-ttl') ? ['--preview-ttl', str(values, 'preview-ttl')!] : []),
    ]);
  printJson(ctx, { uploaded: local.length, scope: plot ?? null });
  return 0;
}
