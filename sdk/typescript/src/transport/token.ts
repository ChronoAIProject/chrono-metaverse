import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSafeName } from '../workspace/config.js';

/**
 * nyxid 模式的令牌来源，按顺序取第一个有的：
 *
 * 1. 命令行 `--token`；
 * 2. 环境变量 `NYXID_TOKEN`；
 * 3. 环境变量 `NYXID_TOKEN_FILE` 指定的文件；
 * 4. 指定 profile 时，通过其 auth_kind 识别 Agent Key，旧 profile 使用 access_token；
 * 5. 默认读取 ~/.nyxid/access_token。
 */

export interface TokenSourceOptions {
  readonly token?: string;
  readonly profile?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly readFile?: (path: string) => string | null;
}

export interface ResolvedToken {
  readonly token: string;
  /** 令牌从哪里来（给用户看，不含令牌本身）。 */
  readonly source: string;
  readonly authKind?: 'agent_key';
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 文件内容 → 令牌：原文，或者 JSON 里的 access_token / accessToken / token。 */
export function tokenFromFileContent(content: string): string | null {
  const text = content.trim();
  if (text === '') return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['access_token', 'accessToken', 'token']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
      }
      return null;
    } catch {
      return null;
    }
  }
  return text.split(/\r?\n/)[0]!.trim() || null;
}

/** 可能的令牌文件位置（按顺序）。 */
export function tokenFileCandidates(options: TokenSourceOptions): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (env.NYXID_TOKEN_FILE) return [env.NYXID_TOKEN_FILE];
  if (options.profile !== undefined) {
    if (!isSafeName(options.profile)) {
      throw new TokenError('nyxid 配置名（profile）只能用 1–64 个字母、数字、_ 和 -');
    }
    return [join(home, '.nyxid', 'profiles', options.profile, 'access_token')];
  }
  return [join(home, '.nyxid', 'access_token')];
}

export function resolveNyxToken(options: TokenSourceOptions = {}): ResolvedToken {
  const env = options.env ?? process.env;
  if (options.token !== undefined && options.token.trim() !== '') {
    return { token: options.token.trim(), source: '命令行 --token' };
  }
  if (env.NYXID_TOKEN !== undefined && env.NYXID_TOKEN.trim() !== '') {
    return { token: env.NYXID_TOKEN.trim(), source: '环境变量 NYXID_TOKEN' };
  }
  const read = options.readFile ?? defaultRead;
  const candidates = tokenFileCandidates(options);
  if (options.profile !== undefined && !env.NYXID_TOKEN_FILE) {
    const directory = dirname(candidates[0]!);
    if (read(join(directory, 'auth_kind'))?.trim() === 'agent_key') {
      const path = join(directory, 'token');
      const content = read(path);
      const token = content === null ? null : tokenFromFileContent(content);
      if (!token) throw new TokenError(`找不到 profile ${options.profile} 的 Agent Key（${path}）`);
      return { token, source: `文件 ${path}`, authKind: 'agent_key' };
    }
  }
  for (const path of candidates) {
    const content = read(path);
    const token = content === null ? null : tokenFromFileContent(content);
    if (token !== null) return { token, source: `文件 ${path}` };
  }
  throw new TokenError(
    [
      '找不到 NyxID 令牌。可以用下面任一种方式提供：',
      '  --token <令牌>',
      '  环境变量 NYXID_TOKEN',
      '  环境变量 NYXID_TOKEN_FILE=<令牌文件>',
      '  nyxid login --agent-key --profile <名称>，再加 --profile <名称>',
      `已经找过：${candidates.join('、')}`,
    ].join('\n'),
  );
}
