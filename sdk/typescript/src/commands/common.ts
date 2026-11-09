import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { ApiClient, type TransportConfig } from '../transport/client.js';
import { MetaverseApi } from '../transport/api.js';
import { resolveNyxToken } from '../transport/token.js';
import {
  findWorkspaceRoot,
  readConfig,
  validateConfig,
  type TransportMode,
  type WorkspaceConfig,
} from '../workspace/config.js';

/** 命令行的运行环境（测试里换成假的）。 */
export interface CliContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetch?: typeof fetch;
  /** SDK 包的根目录（技能说明、工作区里的类型链接都指向这里）。 */
  readonly sdkRoot: string;
  /** 构建后的命令行入口（dev 用子进程重建时需要）；测试里没有。 */
  readonly cliPath?: string;
  /** 等待用的 sleep（测试里换成立即返回）。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** SDK 根目录：本文件在 src/commands 或 dist/commands 下，往上两级。 */
export function defaultSdkRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

type Options = NonNullable<ParseArgsConfig['options']>;

/** 所有命令都认的选项。 */
export const GLOBAL_OPTIONS = {
  dir: { type: 'string' },
  json: { type: 'boolean' },
  mode: { type: 'string' },
  token: { type: 'string' },
  profile: { type: 'string' },
  slug: { type: 'string' },
  'nyx-base': { type: 'string' },
  api: { type: 'string' },
  'dev-token-url': { type: 'string' },
  sub: { type: 'string' },
  'org-role': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies Options;

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Parsed {
  readonly values: Values;
  readonly positionals: string[];
}

export function parse(args: readonly string[], options: Options): Parsed {
  try {
    const result = parseArgs({
      args: [...args],
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: result.values as Values, positionals: result.positionals };
  } catch (error) {
    throw new CliError(`参数不对：${(error as Error).message}`);
  }
}

export function str(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

export function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

export function num(values: Values, key: string): number | undefined {
  const value = str(values, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CliError(`--${key} 必须是数字`);
  return parsed;
}

export interface Workspace {
  readonly root: string;
  readonly config: WorkspaceConfig;
}

/** 命令行参数覆盖 metaverse.json 里的调用方式。 */
function overrides(values: Values, env: CliContext['env']): Partial<WorkspaceConfig> {
  const mode = str(values, 'mode');
  if (mode !== undefined && mode !== 'nyxid' && mode !== 'direct') {
    throw new CliError('--mode 只能是 nyxid 或 direct');
  }
  const out: Record<string, string> = {};
  const set = (key: keyof WorkspaceConfig, value: string | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set('mode', mode);
  set('slug', str(values, 'slug'));
  set('nyxBase', str(values, 'nyx-base'));
  set('profile', str(values, 'profile'));
  set('api', str(values, 'api') ?? env.METAVERSE_API_URL);
  set('devTokenUrl', str(values, 'dev-token-url') ?? env.METAVERSE_DEV_TOKEN_URL);
  set('devSub', str(values, 'sub') ?? env.METAVERSE_DEV_SUB);
  set('devOrgRole', str(values, 'org-role') ?? env.METAVERSE_DEV_ORG_ROLE);
  return out as Partial<WorkspaceConfig>;
}

/** 打开工作区（`--dir` 或从当前目录往上找 metaverse.json）。 */
export function openWorkspace(ctx: CliContext, values: Values): Workspace {
  const start = resolve(ctx.cwd, str(values, 'dir') ?? '.');
  const root = findWorkspaceRoot(start);
  if (root === null) {
    throw new CliError(
      `${start} 不在工作区里（找不到 metaverse.json）：先运行 metaverse init <空间编号>`,
    );
  }
  const config = readConfig(root);
  return { root, config: { ...config, ...overrides(values, ctx.env) } };
}

/** 没有工作区时（例如 admin create-space），只用命令行参数和环境变量。 */
export function workspaceOrFlags(ctx: CliContext, values: Values, spaceId: string): Workspace {
  const start = resolve(ctx.cwd, str(values, 'dir') ?? '.');
  const root = findWorkspaceRoot(start);
  if (root !== null) {
    const config = readConfig(root);
    if (config.spaceId === spaceId)
      return { root, config: { ...config, ...overrides(values, ctx.env) } };
  }
  const merged = { spaceId, mode: 'nyxid' as TransportMode, ...overrides(values, ctx.env) };
  return { root: start, config: validateConfig(merged) };
}

/** 按工作区配置建接口客户端。nyxid 模式立刻解析令牌，找不到就报错。 */
export function makeApi(ctx: CliContext, ws: Workspace, values: Values): MetaverseApi {
  const config = ws.config;
  const transport: TransportConfig =
    config.mode === 'nyxid'
      ? (() => {
          const resolved = resolveNyxToken({
            ...(str(values, 'token') !== undefined ? { token: str(values, 'token') } : {}),
            ...(config.profile !== undefined ? { profile: config.profile } : {}),
            env: ctx.env,
          });
          return {
            mode: 'nyxid',
            ...(config.nyxBase !== undefined ? { nyxBase: config.nyxBase } : {}),
            ...(config.slug !== undefined ? { slug: config.slug } : {}),
            token: () => resolved.token,
            ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
          };
        })()
      : {
          mode: 'direct',
          ...(config.api !== undefined ? { api: config.api } : {}),
          ...(config.devTokenUrl !== undefined ? { devTokenUrl: config.devTokenUrl } : {}),
          ...(config.devSub !== undefined ? { devSub: config.devSub } : {}),
          ...(config.devOrgRole !== undefined ? { devOrgRole: config.devOrgRole } : {}),
          ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
          ...(ctx.sleep ? { retryDelayMs: 0 } : {}),
        };
  try {
    return new MetaverseApi(new ApiClient(transport), config.spaceId);
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}

export function printJson(ctx: CliContext, value: unknown): void {
  ctx.out(JSON.stringify(value, null, 2));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
