#!/usr/bin/env node
// 只更新目标环境的两个镜像，保留线上配置、数据库和密钥。
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORG = '52aa284c-b5b2-49bd-9d12-79f24772dbd7';
const PROXY = 'https://nyx-api.chrono-ai.fun/api/v1/proxy/s/chrono-cd/api/v1';
export const TARGETS = {
  dev: { environment: 'staging', app: 'chrono-metaverse', prefix: 'metaverse' },
  main: { environment: 'production', app: 'chrono-metaverse-prod', prefix: 'metaverse-prod' },
};

/** 只接受分支对应的环境和两个合法摘要，拒绝缺失、额外或混合的输入。 */
export function deployment(ref, environment, sha, digests) {
  const branch = ref?.replace(/^refs\/heads\//, '');
  const target = TARGETS[branch];
  if (!target || environment !== target.environment) throw new Error('分支与部署环境不匹配');
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('部署必须提供完整提交哈希');
  if (Object.keys(digests).sort().join(',') !== 'api,web') throw new Error('部署必须同时提供 api、web 的摘要');
  const services = {};
  for (const [name, digest] of Object.entries(digests)) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`${name} 的摘要不合法`);
    services[`${target.prefix}-${name}`] = {
      image: `ghcr.io/chronoaiproject/chrono-metaverse-${name}:${sha.slice(0, 7)}@${digest}`,
    };
  }
  return { ...target, services };
}

/** 从当前规格生成完整 PUT，只替换指定镜像，去掉 CD 生成的只读摘要。 */
export function deploymentSpec(current, services) {
  if (!current?.services || typeof current.services !== 'object') throw new Error('缺少当前应用规格');
  const spec = structuredClone(current);
  for (const [name, update] of Object.entries(services)) {
    if (!spec.services[name]) throw new Error(`目标缺少服务 ${name}`);
    spec.services[name].image = update.image;
  }
  for (const service of Object.values(spec.services)) delete service.image_digest;
  return spec;
}

/** 对部署通道的错误只报告状态码，不把凭据或响应中的敏感字段写入日志。 */
export async function deploy({ ref, environment, sha, digests, key }, {
  request = fetch,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  attempts = 90,
} = {}) {
  const target = deployment(ref, environment, sha, digests);
  if (!key) throw new Error('缺少 CHRONO_CD_API_KEY');
  const path = `/projects/metaverse/apps/${target.app}`;
  async function api(suffix = '', options = {}) {
    const response = await request(`${PROXY}${path}${suffix}?org_id=${ORG}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'X-API-Key': key,
        'User-Agent': 'chrono-metaverse-deploy',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`chrono-cd ${options.method ?? 'GET'} 返回 ${response.status}`);
    return response.json();
  }
  const current = await api();
  if (current.name !== target.app || current.owner !== ORG || !Number.isInteger(current.generation)) {
    throw new Error('部署目标或应用版本不匹配');
  }
  const applied = await api('', {
    method: 'PUT',
    headers: { 'If-Match': String(current.generation) },
    body: JSON.stringify(deploymentSpec(current.spec, target.services)),
  });
  for (let index = 0; index < attempts; index += 1) {
    const status = await api('/status');
    if (status.phase === 'ready') {
      const actual = await api();
      if (actual.generation !== applied.generation) throw new Error('验证期间应用已被其他部署更新');
      for (const [service, spec] of Object.entries(target.services)) {
        const digest = spec.image.split('@')[1];
        const live = actual.spec.services[service];
        if (live.image_digest !== digest && !live.image?.endsWith(`@${digest}`)) {
          throw new Error(`${service} 的线上摘要与本次构建不一致`);
        }
      }
      return { environment, app: target.app, url: actual.url, generation: actual.generation, revision: actual.revision, sha };
    }
    if (['degraded', 'error', 'deleting'].includes(status.phase)) throw new Error(`部署状态为 ${status.phase}`);
    await pause(10_000);
  }
  throw new Error('等待部署就绪超时，请查看 chrono-cd 状态');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const digests = Object.fromEntries(['api', 'web'].map((name) => [name,
      readFileSync(resolve(process.argv[2] ?? 'digests', `${name}.txt`), 'utf8').trim(),
    ]));
    const result = await deploy({
      ref: process.env.GITHUB_REF, environment: process.env.DEPLOY_ENVIRONMENT,
      sha: process.env.GITHUB_SHA, digests, key: process.env.CHRONO_CD_API_KEY,
    });
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n部署 **${result.environment}**：[${result.app}](${result.url})，提交 \`${result.sha}\`，修订 ${result.revision}。\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
