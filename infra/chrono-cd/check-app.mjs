#!/usr/bin/env node
// chrono-cd 应用规格（app.json）的静态检查。持续集成里运行，改 app.json 前后也可以本地跑：
//
//   node infra/chrono-cd/check-app.mjs [app.json]
//
// 检查的都是"写错了服务也能启动、但线上行为不对"的配置：
//
// - 处理服务：BLAS / OpenMP 线程数不超过 cpu_limit，并限制 malloc 分配区。重计算子进程用
//   RLIMIT_AS 限的是地址空间，OpenBLAS 按节点可见核数建线程、每个线程约占 41MB 地址空间，
//   不限制时大节点上空闲就吃掉大半额度（README 第 1 节"处理服务的线程数"）；
//   子进程内存上限要小于容器内存上限。
// - 接口服务：公开接口的限流额度必须是合法正整数（否则接口服务启动失败）；可信客户端地址头
//   只能是单值头（接口服务只认恰好一个 IP 的值，X-Forwarded-For 这类转发链会被忽略）；
//   没有可信头时限流按网关地址计，所有访客共用额度，必须显式调高到演示规模
//   （README 第 1 节"公开接口限流"）。
// - README 的环境变量表列出了 app.json 里的每一个环境变量；本地 up.sh 给处理服务设了同样的
//   线程变量，本地测的内存和线上一致。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_SERVICE = 'metaverse-api';
export const WORKER_SERVICE = 'metaverse-worker';

/** 处理服务必须设置的线程相关变量。 */
export const WORKER_THREAD_VARS = ['OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS'];
export const WORKER_ARENA_VAR = 'MALLOC_ARENA_MAX';

/**
 * 接口服务公开接口的限流变量和接口服务里按"每个访客"设计的默认值
 * （api/crates/metaverse-api/src/public/mod.rs 的 DEFAULT_*）。
 */
export const PUBLIC_RATE_DEFAULTS = {
  PUBLIC_RATE_LIMIT_PER_MINUTE: 1200,
  PUBLIC_RATE_LIMIT_BURST: 200,
  PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE: 12000,
  PUBLIC_BLOB_RATE_LIMIT_BURST: 2000,
};

/** 值是一串地址（逐跳追加）的转发头：接口服务只认恰好一个 IP 的值，这些头配了也不起作用。 */
export const CHAIN_HEADERS = ['x-forwarded-for', 'forwarded', 'x-forwarded', 'x-original-forwarded-for', 'via'];

const U32_MAX = 4_294_967_295;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Kubernetes 的 CPU 数量（"2"、"1.5"、"500m"）换成核数；不合法时返回 null。 */
export function parseCpu(text) {
  const value = String(text ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)(m?)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2] === 'm' ? amount / 1000 : amount;
}

/** Kubernetes 的内存数量（"8Gi"、"512Mi"、"1G"、字节数）换成 MiB；不合法时返回 null。 */
export function parseMemoryMiB(text) {
  const value = String(text ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value);
  if (!match) return null;
  const bytes = {
    undefined: 1,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  }[match[2]];
  return (Number(match[1]) * bytes) / 1024 ** 2;
}

/** 正整数（十进制、不带符号和空白）；不是时返回 null。 */
export function parsePositiveInt(text, max = Number.MAX_SAFE_INTEGER) {
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) return null;
  const value = Number(text);
  return value <= max ? value : null;
}

function serviceEnv(spec, name) {
  return spec?.services?.[name]?.env ?? {};
}

function checkWorker(spec, problems) {
  const service = spec?.services?.[WORKER_SERVICE];
  if (!service) {
    problems.push(`缺少服务 ${WORKER_SERVICE}`);
    return;
  }
  const env = service.env ?? {};
  const cpu = parseCpu(service.resources?.cpu_limit);
  const cores = cpu === null ? null : Math.max(1, Math.ceil(cpu));
  if (cores === null) problems.push(`${WORKER_SERVICE}：resources.cpu_limit 不合法（${service.resources?.cpu_limit}）`);

  for (const name of WORKER_THREAD_VARS) {
    if (!(name in env)) {
      problems.push(
        `${WORKER_SERVICE}：缺少 ${name}。OpenBLAS / OpenMP 默认按节点可见核数建线程，每个线程约占 41MB 地址空间，` +
          `会挤占重计算子进程的 RLIMIT_AS 额度；设成与 cpu_limit 一致`,
      );
      continue;
    }
    const threads = parsePositiveInt(env[name]);
    if (threads === null) {
      problems.push(`${WORKER_SERVICE}：${name} 必须是正整数（现在是 ${JSON.stringify(env[name])}）`);
    } else if (cores !== null && threads > cores) {
      problems.push(`${WORKER_SERVICE}：${name}=${threads} 超过 cpu_limit（${cores} 核），多出的线程只会被 CFS 限流`);
    }
  }

  if (!(WORKER_ARENA_VAR in env)) {
    problems.push(`${WORKER_SERVICE}：缺少 ${WORKER_ARENA_VAR}（glibc 每个分配区预留 64MB 地址空间，最多 8×核数个）`);
  } else if (parsePositiveInt(env[WORKER_ARENA_VAR]) === null) {
    problems.push(`${WORKER_SERVICE}：${WORKER_ARENA_VAR} 必须是正整数（现在是 ${JSON.stringify(env[WORKER_ARENA_VAR])}）`);
  }

  const limitMiB = parseMemoryMiB(service.resources?.memory_limit);
  const jobMiB = parsePositiveInt(env.WORKER_JOB_MEMORY_MB);
  if (limitMiB === null) {
    problems.push(`${WORKER_SERVICE}：resources.memory_limit 不合法（${service.resources?.memory_limit}）`);
  }
  if ('WORKER_JOB_MEMORY_MB' in env && jobMiB === null) {
    problems.push(`${WORKER_SERVICE}：WORKER_JOB_MEMORY_MB 必须是正整数（现在是 ${JSON.stringify(env.WORKER_JOB_MEMORY_MB)}）`);
  } else if (jobMiB !== null && limitMiB !== null && jobMiB >= limitMiB) {
    problems.push(
      `${WORKER_SERVICE}：WORKER_JOB_MEMORY_MB=${jobMiB} 不小于容器内存上限（${limitMiB}MiB），` +
        `子进程超限前容器就会被系统杀掉`,
    );
  }
}

function checkApi(spec, problems) {
  if (!spec?.services?.[API_SERVICE]) {
    problems.push(`缺少服务 ${API_SERVICE}`);
    return;
  }
  const env = serviceEnv(spec, API_SERVICE);

  for (const name of Object.keys(PUBLIC_RATE_DEFAULTS)) {
    if (name in env && parsePositiveInt(env[name], U32_MAX) === null) {
      problems.push(`${API_SERVICE}：${name} 必须是 1 到 ${U32_MAX} 的整数（现在是 ${JSON.stringify(env[name])}），否则接口服务启动失败`);
    }
  }

  const header = env.TRUSTED_CLIENT_IP_HEADER;
  if (header !== undefined) {
    const name = String(header).trim().toLowerCase();
    if (!HEADER_TOKEN.test(name)) {
      problems.push(`${API_SERVICE}：TRUSTED_CLIENT_IP_HEADER 不是合法的请求头名（${JSON.stringify(header)}）`);
    } else if (CHAIN_HEADERS.includes(name)) {
      problems.push(
        `${API_SERVICE}：TRUSTED_CLIENT_IP_HEADER=${name} 不起作用：这个头逐跳追加、值是多个地址，` +
          `接口服务只认恰好一个 IP 的值，会退回连接地址。用平台确认过的单值头（例如 cf-connecting-ip）`,
      );
    }
    return;
  }

  // 没有可信头：来源地址是网关或 nginx 的地址，所有访客共用额度。
  for (const [name, perVisitor] of Object.entries(PUBLIC_RATE_DEFAULTS)) {
    const value = parsePositiveInt(env[name] ?? '', U32_MAX);
    if (!(name in env)) {
      problems.push(
        `${API_SERVICE}：没有设 TRUSTED_CLIENT_IP_HEADER 时限流按网关地址计、所有访客共用额度，` +
          `必须显式设置 ${name}（接口服务默认的 ${perVisitor} 是按单个访客设计的）`,
      );
    } else if (value !== null && value <= perVisitor) {
      problems.push(
        `${API_SERVICE}：${name}=${value} 没有高于按单个访客设计的默认值 ${perVisitor}；` +
          `按网关地址计时几十个访客就会共同触发 429`,
      );
    }
  }
}

/** README 里以 `名称` 出现过的环境变量。 */
function documentedNames(readme) {
  return new Set([...readme.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1]));
}

function checkReadme(spec, readme, problems) {
  const documented = documentedNames(readme);
  for (const [serviceName, service] of Object.entries(spec?.services ?? {})) {
    const names = [
      ...Object.keys(service.env ?? {}),
      ...Object.values(service.addon_env ?? {}).flatMap((mapping) => Object.values(mapping ?? {})),
    ];
    for (const name of names) {
      if (!documented.has(name)) {
        problems.push(`README 的环境变量表里没有 ${serviceName} 的 \`${name}\``);
      }
    }
  }
  if (serviceEnv(spec, API_SERVICE).TRUSTED_CLIENT_IP_HEADER === undefined && !documented.has('TRUSTED_CLIENT_IP_HEADER')) {
    problems.push('README 要写明 `TRUSTED_CLIENT_IP_HEADER` 还没设置（待向平台确认）以及限流按网关地址计');
  }
}

function checkDevScript(upScript, problems) {
  for (const name of [...WORKER_THREAD_VARS, WORKER_ARENA_VAR]) {
    if (!new RegExp(`(^|\\s)${name}=`, 'm').test(upScript)) {
      problems.push(`infra/dev/up.sh 没有给处理服务设 ${name}：本地测的内存和线上不一致`);
    }
  }
}

/**
 * 检查应用规格，返回问题列表（空表示通过）。
 * `readme`、`upScript` 是对应文件的文本，不给就跳过那部分检查。
 */
export function checkApp(spec, { readme, upScript } = {}) {
  const problems = [];
  if (spec === null || typeof spec !== 'object' || typeof spec.services !== 'object' || spec.services === null) {
    return ['app.json 没有 services'];
  }
  checkWorker(spec, problems);
  checkApi(spec, problems);
  if (readme !== undefined) checkReadme(spec, readme, problems);
  if (upScript !== undefined) checkDevScript(upScript, problems);
  return problems;
}

/** 读仓库里的文件并检查。 */
export function checkRepository(appPath) {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = JSON.parse(readFileSync(appPath ?? join(here, 'app.json'), 'utf8'));
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  const upScript = readFileSync(join(here, '..', 'dev', 'up.sh'), 'utf8');
  return checkApp(spec, { readme, upScript });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  let problems;
  try {
    problems = checkRepository(appPath);
  } catch (error) {
    console.error(`读取应用规格失败：${error.message}`);
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error(`app.json 检查发现 ${problems.length} 个问题：`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('app.json 检查通过');
}
