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

/**
 * metaverse.json 里允许写的 NyxID 地址。nyxid 模式会把令牌（agent key，或者人的登录态）
 * 发到 nyxBase，而工作区可能来自别人（git 仓库、压缩包），命令行还会从上级目录找
 * metaverse.json，所以工作区配置只能在这几个地址里选。别的地址只能由用户自己在命令行用
 * `--nyx-base` 或环境变量 `METAVERSE_NYX_BASE` 指定。
 */
export const TRUSTED_NYX_BASES: readonly string[] = [DEFAULT_NYX_BASE, 'https://api.nyxid.ai'];

export type TransportMode = 'nyxid' | 'direct';

export interface WorkspaceConfig {
  /** 空间编号。 */
  readonly spaceId: string;
  /** `nyxid`（默认，经 NyxID 代理调用线上服务）或 `direct`（直连本地接口服务，开发和测试用）。 */
  readonly mode: TransportMode;
  /**
   * NyxID 地址（nyxid 模式）。写在 metaverse.json 里时只能是 TRUSTED_NYX_BASES 之一；
   * 命令行 `--nyx-base` 和环境变量 `METAVERSE_NYX_BASE` 可以指定别的 https 地址。
   */
  readonly nyxBase?: string;
  /** 服务在 NyxID 里的 slug（nyxid 模式），默认 chrono-metaverse。只能用字母、数字、_ 和 -。 */
  readonly slug?: string;
  /** nyxid 命令行的配置名（读 ~/.nyxid/profiles/<名称>/access_token）。只能用字母、数字、_ 和 -。 */
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

/** 只有显式指定的 NyxID 地址可以用这些主机的 http（令牌不出本机，方便本地调试）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** profile 和 slug 允许的字符：profile 用来拼 `~/.nyxid/profiles/<名称>/` 路径，slug 拼代理路径。 */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_NAME.test(value);
}

/**
 * 检查 NyxID 地址并规整成"协议 + 主机 + 端口"（去掉末尾的 /）。不能带账号密码、路径、
 * 查询参数和片段；协议必须是 https，`allowLoopbackHttp` 时另外接受本机回环地址的 http。
 * 不合格时抛出 ConfigError，`what` 说明地址从哪里来。
 */
export function normalizeNyxBase(value: string, what: string, allowLoopbackHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${what} 不是合法的地址`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${what} 不能带账号密码`);
  }
  const where = `${url.protocol}//${url.host}`;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${what} 只能是协议、主机和端口，不能带路径、查询参数和片段（${where}）`);
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.origin;
  }
  throw new ConfigError(
    `${what} 必须是 https（令牌会发到这个地址，明文传输会泄露令牌${
      allowLoopbackHttp ? '；只有本机回环地址 127.0.0.1、localhost、[::1] 可以用 http' : ''
    }）：${where}`,
  );
}

/** 是不是内置的可信 NyxID 地址（见 TRUSTED_NYX_BASES）。 */
export function isTrustedNyxBase(value: string): boolean {
  try {
    return TRUSTED_NYX_BASES.includes(normalizeNyxBase(value, 'NyxID 地址'));
  } catch {
    return false;
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
  if (config.nyxBase !== undefined && !isTrustedNyxBase(config.nyxBase as string)) {
    throw new ConfigError(
      `${CONFIG_FILE} 里的 nyxBase 只能是 ${TRUSTED_NYX_BASES.join('、')} 之一：` +
        '令牌会发到这个地址，而工作区配置可能来自别人。' +
        '要用别的 NyxID 地址，请删掉这一项，每次运行时自己用 --nyx-base 或环境变量 METAVERSE_NYX_BASE 指定',
    );
  }
  for (const key of ['slug', 'profile']) {
    if (config[key] !== undefined && !isSafeName(config[key])) {
      throw new ConfigError(`${CONFIG_FILE} 里的 ${key} 只能用 1–64 个字母、数字、_ 和 -`);
    }
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
