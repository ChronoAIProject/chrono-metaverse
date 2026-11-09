import { relative } from 'node:path';
import { buildManifest, runBuild, type BuildResult } from '../workspace/build.js';
import { paths } from '../workspace/files.js';
import { checkReport, diffSummary, formatDiff } from '../workspace/report.js';
import {
  displayPath,
  flag,
  openWorkspace,
  parse,
  printJson,
  str,
  type CliContext,
  type Values,
  type Workspace,
} from './common.js';

export const BUILD_HELP = `metaverse build [--plot <地块>] [--script <文件>] [--quiet]

运行建造脚本（默认 build/main.ts）：从拉取的基础状态重新生成操作，在本地作用一遍，
写出 out/ops.ndjson（一行一个操作）、out/result.json（变化清单）和变化了的区块。
可以反复运行。超出目标地块或实体区的操作会列出来（push 前用 check 检查）。`;

export const DIFF_HELP = `metaverse diff [--plot <地块>]

运行建造脚本并与拉取的版本对比：变化的区块、物件、锚点和新增方块的统计。`;

export const CHECK_HELP = `metaverse check [--plot <地块>]

运行建造脚本并检查每条操作的影响范围是否都落在目标地块（--plot）或实体区内。
有超出的操作时退出码为 1。`;

const BUILD_OPTIONS = {
  plot: { type: 'string' },
  script: { type: 'string' },
  quiet: { type: 'boolean' },
} as const;

function plotOf(values: Values): string | undefined {
  return str(values, 'plot');
}

async function build(ws: Workspace, values: Values, write: boolean): Promise<BuildResult> {
  const plot = plotOf(values);
  const script = str(values, 'script');
  return runBuild(ws.root, ws.config, {
    ...(plot !== undefined ? { plot } : {}),
    ...(script !== undefined ? { script } : {}),
    write,
  });
}

export async function runBuildCommand(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, BUILD_OPTIONS);
  if (flag(values, 'help')) {
    ctx.out(BUILD_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const result = await build(ws, values, true);
  if (flag(values, 'json')) {
    const manifest = buildManifest(result);
    printJson(ctx, { ...manifest, final: undefined });
    return 0;
  }
  if (flag(values, 'quiet')) return 0;
  const p = paths(ws.root);
  if (!result.base.pulled) ctx.err('注意：工作区还没有拉取（metaverse pull），基础状态是空的');
  ctx.out(`建造完成：${relative(ws.root, result.script)} → ${result.ops.length} 条操作`);
  ctx.out(formatDiff(diffSummary(result)));
  ctx.out(`输出：${displayPath(ctx, p.outOps)}、${displayPath(ctx, p.outResult)}`);
  const report = checkReport(result);
  if (!report.ok) ctx.err(`注意：${report.text}`);
  return 0;
}

export async function runDiff(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, BUILD_OPTIONS);
  if (flag(values, 'help')) {
    ctx.out(DIFF_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const result = await build(ws, values, false);
  const summary = diffSummary(result);
  if (flag(values, 'json')) printJson(ctx, summary);
  else ctx.out(formatDiff(summary));
  return 0;
}

export async function runCheck(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, BUILD_OPTIONS);
  if (flag(values, 'help')) {
    ctx.out(CHECK_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const result = await build(ws, values, false);
  const report = checkReport(result);
  if (flag(values, 'json')) {
    printJson(ctx, {
      ok: report.ok,
      scope: result.target.scope,
      boxes: result.target.boxes,
      opCount: result.ops.length,
      outside: result.outside,
    });
  } else if (report.ok) {
    ctx.out(report.text);
  } else {
    ctx.err(report.text);
  }
  return report.ok ? 0 : 1;
}
