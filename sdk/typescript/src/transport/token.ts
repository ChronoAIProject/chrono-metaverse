import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * nyxid 模式的令牌来源，按顺序取第一个有的：
 *
 * 1. 命令行 `--token`；
 * 2. 环境变量 `NYXID_TOKEN`；
 * 3. 环境变量 `NYXID_TOKEN_FILE` 指定的文件；
 * 4. 给了 `--profile <名称>`（或 metaverse.json 的 profile）时读 `~/.nyxid/profiles/<名称>/access_token`；
 * 5. 否则读 `~/.nyxid/access_token`。
 *
 * 4、5 的文件位置是按 `nyxid login --agent-key --profile <名称>` 的说明推测的，
 * 实际不同时用 `NYXID_TOKEN_FILE` 指定。文件内容可以是令牌原文，也可以是带
 * `access_token` / `accessToken` / `token` 字段的 JSON。令牌只放进 Authorization 请求头，
 * 不写日志、不落盘。
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
  if (options.profile) return [join(home, '.nyxid', 'profiles', options.profile, 'access_token')];
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
      `  nyxid login --agent-key --profile <名称>，再加 --profile <名称>（读 ${join('~', '.nyxid', 'profiles', '<名称>', 'access_token')}）`,
      `已经找过：${candidates.join('、')}`,
    ].join('\n'),
  );
}
