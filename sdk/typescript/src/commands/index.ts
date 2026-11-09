import { CanonicalError } from '../core/canonical.js';
import { ChunkError } from '../core/chunk.js';
import { GridError } from '../core/grid.js';
import { OpError } from '../core/ops.js';
import { RecordError } from '../core/record.js';
import { ShapeError } from '../core/shape.js';
import { ApiError } from '../transport/client.js';
import { TokenError } from '../transport/token.js';
import { UploadError } from '../transport/upload.js';
import { BuildError } from '../workspace/build.js';
import { ConfigError } from '../workspace/config.js';
import { WorkspaceError } from '../workspace/files.js';
import { runAdmin } from './admin.js';
import { runBuildCommand, runCheck, runDiff } from './build.js';
import { CliError, type CliContext } from './common.js';
import { runDev } from './dev.js';
import { runInit } from './init.js';
import { runPublish, runPush } from './push.js';
import { runPull } from './pull.js';
import { runScan } from './scan.js';
import { runShot } from './shot.js';
import { runVoxelize } from './voxelize.js';

export const HELP = `metaverse —— chrono-metaverse 的本地工作区和建造命令行

用法：metaverse <命令> [选项]（每个命令加 --help 看详细说明）

  init <空间编号>        创建工作区，写入技能说明 .claude/skills/metaverse-builder/SKILL.md
  admin …                管理命令：建空间、改名和可见性、轮换分享令牌、定义区域和地块、登记事件类型、抹除事件
  scan <文件>            分片上传扫描，发起导入任务并等待
  pull                   下载空间的当前状态
  build                  运行建造脚本（每次从基础状态重新生成）
  dev                    本地查看器（脚本改了自动重建）
  shot                   无头浏览器截图，供 AI 看图自查
  diff                   与拉取的版本对比
  check                  检查改动是否都落在目标地块或实体区内
  push [--plot <地块>]   推成草稿，打印草稿编号和预览链接
  publish <草稿编号>     发布草稿
  voxelize               体素化（本地试跑需要 Docker；--remote 发起云端任务）

通用选项：
  --dir <目录>           工作区目录（默认从当前目录往上找 metaverse.json）
  --json                 输出 JSON
  --mode nyxid|direct    调用方式（覆盖 metaverse.json）
  --token <令牌>         NyxID 令牌（nyxid 模式；也可以用 NYXID_TOKEN、NYXID_TOKEN_FILE、--profile）
  --profile <名称>       nyxid 命令行的配置名（读 ~/.nyxid/profiles/<名称>/access_token）
  --slug <slug>          服务在 NyxID 里的 slug（默认 chrono-metaverse）
  --nyx-base <地址>      NyxID 地址（默认 https://nyx-api.chrono-ai.fun；也可以用 METAVERSE_NYX_BASE）。
                         令牌会发到这里，必须是 https；metaverse.json 里只能写内置的可信地址
  --api <地址>           direct 模式的接口服务地址
  --dev-token-url <地址> direct 模式的取令牌地址（也可以用 METAVERSE_DEV_TOKEN_URL）
  --sub <主体编号>       direct 模式取令牌用的 sub（也可以用 METAVERSE_DEV_SUB）`;

type Command = (ctx: CliContext, args: readonly string[]) => number | Promise<number>;

const COMMANDS: Record<string, Command> = {
  init: runInit,
  admin: runAdmin,
  scan: runScan,
  pull: runPull,
  build: runBuildCommand,
  dev: runDev,
  shot: runShot,
  diff: runDiff,
  check: runCheck,
  push: runPush,
  publish: runPublish,
  voxelize: (ctx, args) => runVoxelize(ctx, args),
};

const KNOWN_ERRORS = [
  CliError,
  ApiError,
  BuildError,
  ConfigError,
  WorkspaceError,
  TokenError,
  UploadError,
  OpError,
  RecordError,
  ShapeError,
  CanonicalError,
  ChunkError,
  GridError,
];

/** 运行一条命令，返回退出码。已知的错误打印说明，不打印调用栈。 */
export async function main(ctx: CliContext, argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    ctx.out(HELP);
    return name === undefined ? 1 : 0;
  }
  if (name === '--version' || name === 'version') {
    ctx.out('0.1.0');
    return 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    ctx.err(`不认识的命令 ${name}\n\n${HELP}`);
    return 1;
  }
  try {
    return await command(ctx, args);
  } catch (error) {
    if (KNOWN_ERRORS.some((type) => error instanceof type)) {
      ctx.err(`错误：${(error as Error).message}`);
      return error instanceof CliError ? error.exitCode : 1;
    }
    throw error;
  }
}
