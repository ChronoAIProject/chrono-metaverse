import { spawnSync } from 'node:child_process';
import { isSha256Hex } from '../core/hash.js';
import { idOf } from '../transport/api.js';
import { describeJob, waitForJob } from '../transport/upload.js';
import { readBase } from '../workspace/files.js';
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

export const VOXELIZE_HELP = `metaverse voxelize [--scan <扫描编号>] [--style <风格>] [--remote] [--no-wait]

体素化（方块风格，设计 6.3 第 9 步）。本地试跑要用和云端相同的处理镜像（需要 Docker），
结果只用于调参和预览，不直接上传；确认参数后用 --remote 发起云端任务（写进时间线）。

选项：
  --scan <哈希>   扫描编号（= 扫描资源的内容哈希），默认取工作区拉取的最新扫描
  --style <风格>  体素化风格（传给处理服务的 style 参数）
  --remote        发起云端 voxelize 任务（POST /api/v1/spaces/{space_id}/scans/{scan_id}/voxelize）
  --no-wait       发起任务后立刻返回`;

export interface VoxelizePlan {
  readonly scanId: string;
  readonly style?: string;
}

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0;
}

export async function runVoxelize(
  ctx: CliContext,
  args: readonly string[],
  hasDocker: () => boolean = dockerAvailable,
): Promise<number> {
  const { values } = parse(args, {
    scan: { type: 'string' },
    style: { type: 'string' },
    remote: { type: 'boolean' },
    'no-wait': { type: 'boolean' },
  });
  if (flag(values, 'help')) {
    ctx.out(VOXELIZE_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const base = readBase(ws.root, ws.config.spaceId);
  const scanId = str(values, 'scan') ?? base.space.scan?.assetHash;
  if (scanId === undefined) {
    throw new CliError(
      '不知道要体素化哪个扫描：用 --scan <扫描资源哈希>，或者先 metaverse pull（工作区里没有扫描信息）',
    );
  }
  if (!isSha256Hex(scanId)) throw new CliError('--scan 必须是 64 位小写十六进制的扫描资源哈希');
  const style = str(values, 'style');
  if (style !== undefined && !/^[a-z0-9_-]{1,32}$/.test(style)) {
    throw new CliError('--style 只能是 1–32 个小写字母、数字、- 和 _');
  }
  const plan: VoxelizePlan = { scanId, ...(style !== undefined ? { style } : {}) };
  if (flag(values, 'remote')) {
    const api = makeApi(ctx, ws, values);
    const started = await api.voxelizeScan(scanId, style !== undefined ? { style } : {});
    const jobId = idOf(started, 'jobId');
    if (jobId === undefined) throw new CliError('响应里没有任务编号');
    if (!flag(values, 'json')) ctx.out(`已发起体素化任务 ${jobId}`);
    if (flag(values, 'no-wait')) {
      if (flag(values, 'json')) printJson(ctx, { ...plan, jobId });
      return 0;
    }
    const job = await waitForJob(api, jobId, {
      onUpdate: (j) => {
        if (!flag(values, 'json')) ctx.out(describeJob(j));
      },
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    });
    if (flag(values, 'json')) printJson(ctx, { ...plan, jobId, job });
    else ctx.out('体素化完成，运行 metaverse pull 更新工作区');
    return 0;
  }
  if (!hasDocker()) {
    ctx.out('本地体素化需要 Docker（和云端相同的处理镜像），这台机器上没有可用的 Docker。');
    ctx.out('参数检查通过：');
    ctx.out(`  扫描编号：${scanId}`);
    if (style !== undefined) ctx.out(`  风格：${style}`);
    ctx.out('可以直接发起云端任务（结果写进时间线）：');
    ctx.out(
      `  metaverse voxelize --scan ${scanId}${style !== undefined ? ` --style ${style}` : ''} --remote`,
    );
    return 3;
  }
  ctx.out(
    '已检测到 Docker。本地试跑使用处理服务镜像（worker/ 的 Dockerfile），镜像就绪后在这里运行：',
  );
  ctx.out(
    `  docker run --rm -v "$PWD:/work" <处理服务镜像> voxelize --scan ${scanId}${style !== undefined ? ` --style ${style}` : ''}`,
  );
  ctx.out('第一版命令行只做参数检查和说明，不直接运行镜像。');
  return 0;
}
