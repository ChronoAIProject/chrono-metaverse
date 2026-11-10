#!/usr/bin/env node
// 本地开发设施的部署配置种子小工具（up.sh 调用；Node 22，无第三方依赖）。
//
//   node infra/dev/demo-seed.mjs compact <种子.json> [--owner <组织编号>]   压缩成一行（接口服务的 METAVERSE_DEMO_SEED）
//   node infra/dev/demo-seed.mjs token                                      新的分享令牌（256 位随机数，base64url）
//   node infra/dev/demo-seed.mjs space-id <种子.json>                       种子的空间编号（拼演示链接用）
//
// 种子格式见 api/README.md"部署配置种子"和 docs/design/server-slim.md 7.1（按哈希固定的重建包清单和
// 来源表）；线上用的是 infra/chrono-cd/demo-seed.json。旧格式（files、rebuild、hints、authored……）
// 要处理服务，已不支持：接口服务会跳过它，这里直接报错。
// 本地的模拟 NyxID 里组织编号是 chronoai 这样的短字符串：要让 alice（chronoai 的 admin）能管理种子
// 建的空间，就用 --owner chronoai 换掉配置里的线上组织编号（只换 owner.id，其他原样）。
// 退出码：0 成功；2 参数不对或文件读不成 JSON。

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class SeedFileError extends Error {}

/** 旧格式（处理服务下线前）的字段。 */
export const LEGACY_SEED_KEYS = ['files', 'rebuild', 'voxelize', 'hints', 'authored', 'observedAt'];

/** 读种子文件（JSON 对象）。 */
export function readSeed(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SeedFileError(`读不成种子配置 ${path}：${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SeedFileError(`种子配置 ${path} 必须是 JSON 对象`);
  }
  return value;
}

/**
 * 压缩成一行；给了 `owner` 时换掉 `owner.id`。不改其他字段（校验留给接口服务，配置不对它会启动失败）；
 * 旧格式直接报错（接口服务会跳过它，本地起服务时容易看不到）。
 */
export function compactSeed(seed, { owner } = {}) {
  const legacy = Object.keys(seed).filter((key) => LEGACY_SEED_KEYS.includes(key));
  if (legacy.length > 0) {
    throw new SeedFileError(
      `种子配置是旧格式（${legacy.join('、')}）：旧格式要处理服务，已不支持，改成 bundle（docs/design/server-slim.md 7.1）`,
    );
  }
  const copy = structuredClone(seed);
  if (owner !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(owner)) throw new SeedFileError(`--owner 不是合法的组织编号：${owner}`);
    copy.owner = { ...(copy.owner ?? {}), kind: 'org', id: owner };
  }
  return JSON.stringify(copy);
}

/** 新的分享令牌：32 字节随机数的 base64url（43 个字符）。 */
export function newShareToken() {
  return randomBytes(32).toString('base64url');
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'token' && rest.length === 0) return newShareToken();
  if (command === 'space-id' && rest.length === 1) {
    const id = readSeed(rest[0]).spaceId;
    if (typeof id !== 'string' || id === '') throw new SeedFileError('种子配置没有 spaceId');
    return id;
  }
  if (command === 'compact' && (rest.length === 1 || (rest.length === 3 && rest[1] === '--owner'))) {
    return compactSeed(readSeed(rest[0]), { owner: rest[2] });
  }
  throw new SeedFileError('用法：demo-seed.mjs compact <种子.json> [--owner <组织>] | token | space-id <种子.json>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error) {
    if (!(error instanceof SeedFileError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
}
