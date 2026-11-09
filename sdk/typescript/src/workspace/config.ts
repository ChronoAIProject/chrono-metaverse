import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isObjectId, isSpaceId } from '../core/ids.js';

/**
 * 工作区配置 `metaverse.json`：空间编号、调用方式（经 NyxID 或直连本地接口服务）、
 * 地址、服务 slug 等。命令行参数优先于这里的值。
 */

export const CONFIG_FILE = 'metaverse.json';
export const DEFAULT_NYX_BASE = 'https://nyx-api.chrono-ai.fun';
export const DEFAULT_SLUG = 'chrono-metaverse';

export type TransportMode = 'nyxid' | 'direct';

export interface WorkspaceConfig {
  /** 空间编号。 */
  readonly spaceId: string;
  /** `nyxid`（默认，经 NyxID 代理调用线上服务）或 `direct`（直连本地接口服务，开发和测试用）。 */
  readonly mode: TransportMode;
  /** NyxID 地址（nyxid 模式）。 */
  readonly nyxBase?: string;
  /** 服务在 NyxID 里的 slug（nyxid 模式），默认 chrono-metaverse。 */
  readonly slug?: string;
  /** nyxid 命令行的配置名（读 ~/.nyxid/profiles/<名称>/access_token）。 */
  readonly profile?: string;
  /** 接口服务地址（direct 模式），例如 http://127.0.0.1:8080。 */
  readonly api?: string;
  /** 模拟 NyxID 的取令牌地址（direct 模式），例如 http://127.0.0.1:8090/dev/token。 */
  readonly devTokenUrl?: string;
  /** direct 模式取令牌时用的 sub（默认 dev-user）。 */
  readonly devSub?: string;
  /** direct 模式取令牌时附带的组织角色。 */
  readonly devOrgRole?: string;
  /** 网站地址，用来拼预览链接（例如 https://metaverse.chrono-ai.fun）。 */
  readonly webUrl?: string;
  /** 建造脚本（相对工作区），默认 build/main.ts。 */
  readonly buildScript?: string;
  /** 默认的目标地块（不给就是实体区）。 */
  readonly plot?: string;
  /** 本地查看器用的网站构建产物目录（默认在仓库里找 web/dist）。 */
  readonly webDist?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function validateConfig(value: unknown): WorkspaceConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${CONFIG_FILE} 必须是 JSON 对象`);
  }
  const config = value as Record<string, unknown>;
  if (!isSpaceId(config.spaceId)) {
    throw new ConfigError(`${CONFIG_FILE} 里的 spaceId 不合法（3–64 个小写字母、数字和 -）`);
  }
  const mode = config.mode ?? 'nyxid';
  if (mode !== 'nyxid' && mode !== 'direct') {
    throw new ConfigError(`${CONFIG_FILE} 里的 mode 只能是 nyxid 或 direct`);
  }
  for (const key of [
    'nyxBase',
    'slug',
    'profile',
    'api',
    'devTokenUrl',
    'devSub',
    'devOrgRole',
    'webUrl',
    'buildScript',
    'plot',
    'webDist',
  ]) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new ConfigError(`${CONFIG_FILE} 里的 ${key} 必须是字符串`);
    }
  }
  if (config.plot !== undefined && !isObjectId(config.plot)) {
    throw new ConfigError(`${CONFIG_FILE} 里的 plot 不是合法的地块编号`);
  }
  return { ...(config as unknown as WorkspaceConfig), mode };
}

/** 从 `start` 往上找含 metaverse.json 的目录。 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readConfig(root: string): WorkspaceConfig {
  const path = join(root, CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`找不到 ${path}：先运行 metaverse init <空间编号>`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} 不是合法的 JSON：${(error as Error).message}`);
  }
  return validateConfig(parsed);
}

export function writeConfig(root: string, config: WorkspaceConfig): void {
  validateConfig(config);
  writeFileSync(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}
