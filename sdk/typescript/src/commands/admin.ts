import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gridBoxError, coveredBy, type GridBox } from '../core/grid.js';
import { isObjectId, isSpaceId, isSubjectId } from '../core/ids.js';
import type { Plot, Region } from '../core/scope.js';
import type { EventTypeRequest, LayoutFile } from '../transport/api.js';
import { readBase } from '../workspace/files.js';
import {
  CliError,
  flag,
  makeApi,
  openWorkspace,
  parse,
  printJson,
  str,
  workspaceOrFlags,
  type CliContext,
  type Values,
} from './common.js';

export const ADMIN_HELP = `metaverse admin <子命令> …（管理接口 /api/v1/admin，要求"管理"级别；不进 AI 工具）

子命令：
  create-space <空间编号> --name <名称> [--description <说明>] [--owner-kind org|person]
               --owner <NyxID 主体编号> [--visibility unlisted|public]
      创建空间。组织空间要求调用者是组织本身（组织的 agent key）或组织 admin。
      分享令牌原文只在创建时返回这一次，请妥善保存。
  update-space [--name <名称>] [--description <说明>] [--visibility unlisted|public] [--yes]
      修改名称、说明或可见性。改成 public 会公开全部历史，必须加 --yes 确认。
  rotate-share-token
      轮换分享令牌：吊销全部现有令牌（旧的查看链接立即失效），新建一个令牌，原文只显示这一次。
  set-layout <layout.json> [--message <说明>] [--base-seq <n>]
      定义区域和地块（写一次提交）。文件格式：{ "regions": [...], "plots": [...] }，
      盒子单位是格 [x0,y0,z0,x1,y1,z1]。默认基于工作区拉取的 seq。
  register-event-type <event-type.json>
      登记事件类型（只追加的版本记录）：{ type, schema, publicFields, defaultVisibility, state?, maxAgeSec?, display }。
  redact-event <事件编号> [--reason <原因>]
      抹除一条事件的内容（之后读接口不再返回它的 data）。`;

function readJsonFile<T>(ctx: CliContext, file: string | undefined, what: string): T {
  if (file === undefined) throw new CliError(`缺少 ${what} 文件参数`);
  try {
    return JSON.parse(readFileSync(resolve(ctx.cwd, file), 'utf8')) as T;
  } catch (error) {
    throw new CliError(`读不了 ${file}：${(error as Error).message}`);
  }
}

/** 区域和地块的本地检查（与 metaverse-core `validate_layout` 相同的规则）。 */
export function validateLayout(regions: readonly Region[], plots: readonly Plot[]): string | null {
  const byId = new Map<string, Region>();
  for (const region of regions) {
    if (
      !isObjectId(region.id) ||
      !Array.isArray(region.boxes) ||
      region.boxes.length === 0 ||
      region.boxes.length > 64
    ) {
      return `区域 ${region.id} 的编号或盒子数不合法`;
    }
    if (region.kind !== 'physical' && region.kind !== 'virtual')
      return `区域 ${region.id} 的 kind 只能是 physical 或 virtual`;
    for (const box of region.boxes) {
      const error = gridBoxError(box);
      if (error !== null) return `区域 ${region.id} 的盒子 ${JSON.stringify(box)}：${error}`;
    }
    if (byId.has(region.id)) return `区域编号重复：${region.id}`;
    byId.set(region.id, region);
  }
  const plotIds = new Set<string>();
  for (const plot of plots) {
    if (
      !isObjectId(plot.id) ||
      !Array.isArray(plot.boxes) ||
      plot.boxes.length === 0 ||
      plot.boxes.length > 64
    ) {
      return `地块 ${plot.id} 的编号或盒子数不合法`;
    }
    for (const box of plot.boxes) {
      const error = gridBoxError(box);
      if (error !== null) return `地块 ${plot.id} 的盒子 ${JSON.stringify(box)}：${error}`;
    }
    if (plotIds.has(plot.id)) return `地块编号重复：${plot.id}`;
    plotIds.add(plot.id);
    const region = byId.get(plot.regionId);
    if (region === undefined) return `地块 ${plot.id} 所属的区域不存在`;
    if (region.kind !== 'virtual') return `地块 ${plot.id} 必须划在虚拟区内`;
    if (!plot.boxes.every((box: GridBox) => coveredBy(box, region.boxes))) {
      return `地块 ${plot.id} 超出了所属区域`;
    }
  }
  return null;
}

async function createSpace(
  ctx: CliContext,
  values: Values,
  positionals: string[],
): Promise<number> {
  const [spaceId] = positionals;
  if (spaceId === undefined || !isSpaceId(spaceId)) {
    throw new CliError(
      '用法：metaverse admin create-space <空间编号> --name <名称> --owner <主体编号>',
    );
  }
  const name = str(values, 'name');
  if (name === undefined || name.trim() === '') throw new CliError('缺少 --name');
  const ownerKind = str(values, 'owner-kind') ?? 'org';
  if (ownerKind !== 'org' && ownerKind !== 'person')
    throw new CliError('--owner-kind 只能是 org 或 person');
  const owner = str(values, 'owner');
  if (owner === undefined || !isSubjectId(owner)) {
    throw new CliError('缺少 --owner（NyxID 主体编号：组织编号或个人编号，不认 slug）');
  }
  const visibility = str(values, 'visibility');
  if (visibility !== undefined && visibility !== 'unlisted' && visibility !== 'public') {
    throw new CliError('--visibility 只能是 unlisted 或 public');
  }
  const ws = workspaceOrFlags(ctx, values, spaceId);
  const api = makeApi(ctx, ws, values);
  const result = await api.createSpace({
    id: spaceId,
    name,
    ...(str(values, 'description') !== undefined
      ? { description: str(values, 'description') }
      : {}),
    owner: { kind: ownerKind, id: owner },
    ...(visibility !== undefined ? { visibility } : {}),
  });
  if (flag(values, 'json')) {
    printJson(ctx, result);
    return 0;
  }
  ctx.out(`已创建空间 ${spaceId}（${name}）`);
  if (result.shareToken) {
    ctx.out(`分享令牌（只显示这一次，请保存好）：${result.shareToken.token}`);
    ctx.out(`令牌编号：${result.shareToken.id}`);
    ctx.out(`查看链接：/s/${spaceId}#share=${result.shareToken.token}`);
  }
  return 0;
}

async function updateSpace(ctx: CliContext, values: Values): Promise<number> {
  const ws = openWorkspace(ctx, values);
  const visibility = str(values, 'visibility');
  if (visibility !== undefined && visibility !== 'unlisted' && visibility !== 'public') {
    throw new CliError('--visibility 只能是 unlisted 或 public');
  }
  if (visibility === 'public' && !flag(values, 'yes')) {
    throw new CliError(
      '改成 public 会公开全部历史（已经发出去的区块和资源收不回）。确认的话加 --yes',
    );
  }
  const request = {
    ...(str(values, 'name') !== undefined ? { name: str(values, 'name') } : {}),
    ...(str(values, 'description') !== undefined
      ? { description: str(values, 'description') }
      : {}),
    ...(visibility !== undefined ? { visibility: visibility as 'unlisted' | 'public' } : {}),
    // 接口服务要求显式确认公开全部历史（字段名 confirmPublicHistory）。
    ...(visibility === 'public' ? { confirmPublicHistory: true } : {}),
  };
  if (Object.keys(request).length === 0)
    throw new CliError('至少给出 --name、--description 或 --visibility 之一');
  const space = await makeApi(ctx, ws, values).updateSpace(request);
  if (flag(values, 'json')) printJson(ctx, space);
  else
    ctx.out(
      `已更新空间 ${space.id ?? ws.config.spaceId}：名称 ${space.name ?? '（未知）'}，可见性 ${space.visibility ?? '（未知）'}`,
    );
  return 0;
}

async function rotateShareToken(ctx: CliContext, values: Values): Promise<number> {
  const ws = openWorkspace(ctx, values);
  // 接口服务不收请求体：先吊销全部现有令牌，再返回 201 { id, token }（原文只返回这一次）。
  const result = await makeApi(ctx, ws, values).rotateShareToken();
  if (flag(values, 'json')) {
    printJson(ctx, result);
  } else if (typeof result.token === 'string' && result.token !== '') {
    ctx.out(`新的分享令牌（只显示这一次，旧令牌已全部吊销）：${result.token}`);
    if (result.id !== undefined) ctx.out(`令牌编号：${result.id}`);
    ctx.out(`查看链接：/s/${ws.config.spaceId}#share=${result.token}`);
  }
  if (typeof result.token !== 'string' || result.token === '') {
    // 旧令牌这时已经吊销了，不能当作成功：凭链接查看的空间没有任何有效链接。
    throw new CliError(
      `轮换的响应里没有新令牌原文（${JSON.stringify(result)}）。旧令牌已全部吊销，请再轮换一次。`,
    );
  }
  return 0;
}

async function setLayout(ctx: CliContext, values: Values, positionals: string[]): Promise<number> {
  const ws = openWorkspace(ctx, values);
  const layout = readJsonFile<LayoutFile>(ctx, positionals[0], '区域和地块');
  const regions = layout.regions ?? [];
  const plots = layout.plots ?? [];
  const error = validateLayout(regions, plots);
  if (error !== null) throw new CliError(`区域和地块不合法：${error}`);
  const baseSeqText = str(values, 'base-seq');
  const baseSeq =
    baseSeqText !== undefined
      ? Number(baseSeqText)
      : readBase(ws.root, ws.config.spaceId).space.seq;
  if (!Number.isInteger(baseSeq) || baseSeq < 0) throw new CliError('--base-seq 必须是非负整数');
  const message = str(values, 'message') ?? layout.message;
  const result = await makeApi(ctx, ws, values).setLayout({
    baseSeq,
    regions,
    plots,
    ...(message !== undefined ? { message } : {}),
  });
  if (flag(values, 'json')) printJson(ctx, result);
  else
    ctx.out(
      `已定义 ${regions.length} 个区域、${plots.length} 个地块${result.seq !== undefined ? `（seq ${result.seq}）` : ''}；运行 metaverse pull 更新工作区`,
    );
  return 0;
}

async function registerEventType(
  ctx: CliContext,
  values: Values,
  positionals: string[],
): Promise<number> {
  const ws = openWorkspace(ctx, values);
  const request = readJsonFile<EventTypeRequest>(ctx, positionals[0], '事件类型');
  if (
    typeof request.type !== 'string' ||
    request.display === undefined ||
    request.schema === undefined
  ) {
    throw new CliError('事件类型至少要有 type、schema、defaultVisibility、display');
  }
  if (request.defaultVisibility !== 'public' && request.defaultVisibility !== 'internal') {
    throw new CliError('defaultVisibility 只能是 public 或 internal');
  }
  const result = await makeApi(ctx, ws, values).registerEventType(request);
  if (flag(values, 'json')) printJson(ctx, result);
  else
    ctx.out(
      `已登记事件类型 ${request.type}${result.version !== undefined ? ` 第 ${result.version} 版` : ''}`,
    );
  return 0;
}

async function redactEvent(
  ctx: CliContext,
  values: Values,
  positionals: string[],
): Promise<number> {
  const ws = openWorkspace(ctx, values);
  const eventId = positionals[0];
  if (eventId === undefined) throw new CliError('用法：metaverse admin redact-event <事件编号>');
  const reason = str(values, 'reason');
  await makeApi(ctx, ws, values).redactEvent(eventId, reason !== undefined ? { reason } : {});
  ctx.out(`已抹除事件 ${eventId} 的内容`);
  return 0;
}

export async function runAdmin(ctx: CliContext, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parse(rest, {
    name: { type: 'string' },
    description: { type: 'string' },
    'owner-kind': { type: 'string' },
    owner: { type: 'string' },
    visibility: { type: 'string' },
    yes: { type: 'boolean' },
    message: { type: 'string' },
    'base-seq': { type: 'string' },
    reason: { type: 'string' },
  });
  if (
    sub === undefined ||
    sub === 'help' ||
    sub === '--help' ||
    sub === '-h' ||
    flag(values, 'help')
  ) {
    ctx.out(ADMIN_HELP);
    return sub === undefined ? 1 : 0;
  }
  switch (sub) {
    case 'create-space':
      return createSpace(ctx, values, positionals);
    case 'update-space':
      return updateSpace(ctx, values);
    case 'rotate-share-token':
      return rotateShareToken(ctx, values);
    case 'set-layout':
      return setLayout(ctx, values, positionals);
    case 'register-event-type':
      return registerEventType(ctx, values, positionals);
    case 'redact-event':
      return redactEvent(ctx, values, positionals);
    default:
      throw new CliError(`不认识的管理子命令 ${sub}\n\n${ADMIN_HELP}`);
  }
}
