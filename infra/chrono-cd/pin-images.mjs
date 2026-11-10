#!/usr/bin/env node
// 把应用规格里的镜像换成按摘要固定的引用（README 第 4 步、第 3 节"日常更新"、第 4 节"回滚"）：
//
//   node infra/chrono-cd/pin-images.mjs <提交哈希> api=sha256:<64 位> web=sha256:<64 位>
//       → 输出整份规格（PUT 的请求体），其余内容取自 infra/chrono-cd/app.json
//   node infra/chrono-cd/pin-images.mjs --patch <提交哈希> api=sha256:<64 位> [web=…]
//       → 只输出镜像的 JSON 合并补丁（PATCH 的请求体），可以只换一部分服务
//   --app <路径> 换一份基础规格（默认 infra/chrono-cd/app.json）
//
// 摘要取自这次提交在部署分支上的 Images 运行（.github/workflows/images.yml 的运行摘要里
// `api=sha256:…` 这样的行），不要按标签去仓库查：ghcr 的标签可以被任何分支里改过的工作流改写。
// 生成的引用是 `ghcr.io/chronoaiproject/chrono-metaverse-<服务>:<7 位提交哈希>@sha256:<摘要>`：
// chrono-cd 标签和摘要都有时只按摘要拉取，标签只是给人看的记号。处理服务已下线，只有 api、web 两个镜像。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_SERVICE, IMAGE_REPOSITORIES, WEB_SERVICE, checkApp } from './check-app.mjs';

/** 命令行里的短名和服务名的对应。 */
export const SHORT_NAMES = {
  web: WEB_SERVICE,
  api: API_SERVICE,
};

const COMMIT = /^[0-9a-f]{7,40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class UsageError extends Error {}

/** 解析命令行参数；不合法时抛 UsageError。 */
export function parseArgs(argv) {
  let patch = false;
  let appPath;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--patch') {
      patch = true;
    } else if (arg === '--app') {
      appPath = argv[index + 1];
      if (appPath === undefined) throw new UsageError('--app 后面要跟规格文件的路径');
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`不认识的选项 ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [commit, ...pairs] = positional;
  if (commit === undefined || !COMMIT.test(commit)) {
    throw new UsageError(`第一个参数要是提交哈希（7–40 位小写十六进制），现在是 ${JSON.stringify(commit)}`);
  }
  const digests = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const short = at < 0 ? pair : pair.slice(0, at);
    const digest = at < 0 ? '' : pair.slice(at + 1);
    const service = SHORT_NAMES[short];
    if (service === undefined) {
      throw new UsageError(`不认识的服务 ${JSON.stringify(short)}（只能是 ${Object.keys(SHORT_NAMES).join('、')}）`);
    }
    if (!DIGEST.test(digest)) {
      throw new UsageError(`${short} 的摘要要是 sha256: 加 64 位小写十六进制，现在是 ${JSON.stringify(digest)}`);
    }
    if (service in digests) throw new UsageError(`${short} 写了两次`);
    digests[service] = digest;
  }
  if (Object.keys(digests).length === 0) throw new UsageError('至少要给一个服务的摘要（例如 api=sha256:…）');
  if (!patch) {
    const missing = Object.entries(SHORT_NAMES)
      .filter(([, service]) => !(service in digests))
      .map(([short]) => short);
    if (missing.length > 0) {
      throw new UsageError(`生成整份规格要给全两个服务的摘要，缺 ${missing.join('、')}（只换一部分用 --patch）`);
    }
  }
  return { patch, appPath, commit, digests };
}

/** 一个服务按摘要固定的镜像引用。 */
export function pinnedImage(service, commit, digest) {
  const repository = IMAGE_REPOSITORIES[service];
  if (repository === undefined) throw new UsageError(`服务 ${service} 没有对应的镜像仓库`);
  if (!COMMIT.test(commit)) throw new UsageError(`提交哈希不合法：${JSON.stringify(commit)}`);
  if (!DIGEST.test(digest)) throw new UsageError(`摘要不合法：${JSON.stringify(digest)}`);
  return `${repository}:${commit.slice(0, 7)}@${digest}`;
}

/** 整份规格：在 `spec` 的副本里把每个给了摘要的服务的镜像换掉，规格里要有这些服务。 */
export function pinSpec(spec, commit, digests) {
  const copy = structuredClone(spec);
  for (const [service, digest] of Object.entries(digests)) {
    if (!copy?.services?.[service]) throw new UsageError(`规格里没有服务 ${service}`);
    copy.services[service].image = pinnedImage(service, commit, digest);
  }
  return copy;
}

/** 只换镜像的 JSON 合并补丁。 */
export function imagePatch(commit, digests) {
  const services = {};
  for (const [service, digest] of Object.entries(digests)) {
    services[service] = { image: pinnedImage(service, commit, digest) };
  }
  return { services };
}

/** 按参数生成输出文本；整份规格还要通过 check-app 的全部检查。 */
export function run(argv, { readSpec = (path) => readFileSync(path, 'utf8') } = {}) {
  const options = parseArgs(argv);
  if (options.patch) return `${JSON.stringify(imagePatch(options.commit, options.digests))}\n`;
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = JSON.parse(readSpec(options.appPath ? resolve(options.appPath) : join(here, 'app.json')));
  const pinned = pinSpec(spec, options.commit, options.digests);
  const problems = checkApp(pinned);
  if (problems.length > 0) {
    throw new UsageError(`生成的规格没有通过检查：\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  }
  return `${JSON.stringify(pinned, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : `失败：${error.message}`);
    process.exit(error instanceof UsageError ? 1 : 2);
  }
}
