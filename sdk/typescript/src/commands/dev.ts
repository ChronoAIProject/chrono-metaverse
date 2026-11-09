import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { findWebDist, startDevServer, type DevServer } from '../dev/server.js';
import { buildManifest, runBuild, type BuildManifest } from '../workspace/build.js';
import { paths } from '../workspace/files.js';
import {
  CliError,
  flag,
  num,
  openWorkspace,
  parse,
  str,
  type CliContext,
  type Values,
  type Workspace,
} from './common.js';

export const DEV_HELP = `metaverse dev [选项]

本地查看器：起一个本地服务，按公开读接口提供"拉取的基础状态 + 本地建造结果"，并托管网站的
构建产物（和线上网站同一套代码）。建造脚本改了自动重建，页面几秒内刷新（时间线上的
"本地建造结果"就是这次的输出，"拉取的基础版本"是改动之前）。

选项：
  --port <端口>       默认 4321（0 表示随便找一个空闲端口）
  --host <地址>       默认 127.0.0.1
  --web-dist <目录>   网站构建产物（默认 metaverse.json 的 webDist，或在 SDK 所在的仓库里找 web/dist）
  --plot <地块>       目标地块
  --internal          锚点也显示内部级（默认只显示公开级，和预览一致）
  --no-watch          不监视文件改动`;

export function resolveWebDist(ctx: CliContext, ws: Workspace, values: Values): string | null {
  const given = str(values, 'web-dist') ?? ws.config.webDist;
  if (given !== undefined) {
    const dir = isAbsolute(given)
      ? given
      : resolve(str(values, 'web-dist') !== undefined ? ctx.cwd : ws.root, given);
    if (!existsSync(join(dir, 'index.html')))
      throw new CliError(`${dir} 里没有 index.html（不是网站的构建产物）`);
    return dir;
  }
  return findWebDist(ctx.sdkRoot);
}

/** 用子进程跑一次 build（每次都是新的进程，建造脚本和它引用的文件改了都能重新加载）。 */
function childRebuild(
  ctx: CliContext,
  ws: Workspace,
  plot: string | undefined,
): () => Promise<BuildManifest> {
  return () =>
    new Promise((resolveBuild, reject) => {
      const args = [
        ctx.cliPath!,
        'build',
        '--quiet',
        '--dir',
        ws.root,
        ...(plot ? ['--plot', plot] : []),
      ];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `build 退出码 ${code}`));
          return;
        }
        try {
          resolveBuild(JSON.parse(readFileSync(paths(ws.root).outResult, 'utf8')) as BuildManifest);
        } catch (error) {
          reject(error as Error);
        }
      });
    });
}

function inProcessRebuild(ws: Workspace, plot: string | undefined): () => Promise<BuildManifest> {
  return async () =>
    buildManifest(await runBuild(ws.root, ws.config, plot !== undefined ? { plot } : {}));
}

export async function startDev(
  ctx: CliContext,
  values: Values,
  watch: boolean,
): Promise<{ server: DevServer; ws: Workspace }> {
  const ws = openWorkspace(ctx, values);
  const webDist = resolveWebDist(ctx, ws, values);
  if (webDist === null) {
    ctx.err(
      '注意：找不到网站的构建产物（web/dist）。在平台仓库里运行 cd web && npm ci && npm run build，或用 --web-dist 指定',
    );
  }
  const plot = str(values, 'plot') ?? ws.config.plot;
  const server = await startDevServer({
    root: ws.root,
    spaceId: ws.config.spaceId,
    webDist,
    host: str(values, 'host') ?? '127.0.0.1',
    port: num(values, 'port') ?? 4321,
    rebuild: ctx.cliPath ? childRebuild(ctx, ws, plot) : inProcessRebuild(ws, plot),
    watch,
    includeInternal: flag(values, 'internal'),
    log: (message) => ctx.err(message),
  });
  return { server, ws };
}

export const DEV_OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  'web-dist': { type: 'string' },
  plot: { type: 'string' },
  internal: { type: 'boolean' },
  'no-watch': { type: 'boolean' },
} as const;

export async function runDev(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, DEV_OPTIONS);
  if (flag(values, 'help')) {
    ctx.out(DEV_HELP);
    return 0;
  }
  const { server, ws } = await startDev(ctx, values, !flag(values, 'no-watch'));
  ctx.out(`本地查看器：${server.url}/s/${ws.config.spaceId}`);
  if (server.lastError() !== null) ctx.err(`建造失败：${server.lastError()}`);
  ctx.out('按 Ctrl+C 退出');
  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  return 0;
}
