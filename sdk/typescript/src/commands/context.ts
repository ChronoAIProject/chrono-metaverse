import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contextEdit, readContext } from '../workspace/context.js';
import { readBase } from '../workspace/files.js';
import { CliError, flag, openWorkspace, parse, str, type CliContext } from './common.js';
import { runEdit } from './edit.js';

const HELP = `metaverse context <plan|stage|upload|check|push> [--file out/context/entities.json] [--plot 地块]

兼容背景内容提供方的清单；所有检查、资源上传和草稿预览统一由 metaverse edit 处理。
新的家具、装饰、形状或模型编辑直接使用 metaverse edit，不需要背景标记或专用地块。
plan 同时保留 out/context/layout.json 供旧工作流使用。`;

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
  const plot = str(values, 'plot') ?? ws.config.plot;
  if (!plot)
    throw new CliError('旧背景清单需要指定 --plot；普通物件可用 metaverse edit 直接编辑实体区');
  const artifact = readContext(
    resolve(ws.root, str(values, 'file') ?? 'out/context/entities.json'),
  );
  if (
    action !== 'plan' &&
    artifact.entities.some(
      (entity) => entity.regionId !== base.space.plots.find((item) => item.id === plot)?.regionId,
    )
  )
    throw new CliError('背景所属区域与目标地块不一致；先 plan、set-layout、pull，再重新生成清单');
  const forwarded = Object.entries(values)
    .filter(([key]) => !['file', 'help'].includes(key))
    .flatMap(([key, value]) =>
      typeof value === 'string' ? ['--' + key, value] : value === true ? ['--' + key] : [],
    );
  const result = await runEdit(ctx, [action, ...forwarded], contextEdit(base, artifact));
  if (action === 'plan' && result === 0) {
    mkdirSync(join(ws.root, 'out/context'), { recursive: true });
    copyFileSync(join(ws.root, 'out/edit/layout.json'), join(ws.root, 'out/context/layout.json'));
  }
  return result;
}
