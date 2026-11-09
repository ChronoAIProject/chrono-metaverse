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
//   没有可信头时限流按网关地址计，所有访客共用几个桶，一个来源持续多发请求就能耗尽它们、让所有
//   访客都 429。所以这时四个额度必须显式设到单个进程处理不了的高度（每核每秒 100 万次），
//   等于关掉限流，靠每空间并发上限和进程内缓存兜底（README 第 1 节"公开接口限流"）。
// - 镜像：每个服务都按摘要固定（`仓库[:7 位提交哈希]@sha256:<64 位>`），仓库与服务名对应。ghcr 的标签
//   可以被任何分支里改过的工作流改写，chrono-cd 每次 PUT / PATCH 都把标签重新解析成摘要，按标签
//   写的规格在一次只改环境变量的 PATCH 里也会换成别人推上去的镜像（README 第 1 步"镜像按摘要固定"）。
// - README 的环境变量表列出了 app.json 里的每一个环境变量和密钥名；本地 up.sh 起处理服务时给它设了
//   同样的线程变量，本地测的内存和线上一致（up.sh 已不再起处理服务，见 docs/design/server-slim.md 13.3，
//   这条只在它起处理服务时检查）。
// - 部署配置种子：`demo-seed.json` 和接口服务的 `METAVERSE_DEMO_SEED` 内容一致（后者是前者压缩成的
//   一行）；种子按接口服务的规则静态校验（拒绝未知字段、https 地址、sha256 和大小、主人是部署这个
//   应用的组织、提示不超过 4KB）；凭链接查看时 `secret_keys` 里要有 `METAVERSE_DEMO_SHARE_TOKEN`，
//   README 要写明用 `set_app_secrets` 设置它（README 第 5 步"密钥"、"演示数据"一节）。
//   种子可选带 AI 物件集 `authored: {url, sha256, size}`：地址必须是 raw.githubusercontent.com 上按
//   40 位提交哈希固定的 `infra/chrono-cd/demo/*.json`（分支名会变，内容就和 sha256 对不上），大小 ≤ 4MB，
//   这时 `rebuild` 不能是 false（README 第 8 步"AI 物件集"）。
// - 处理服务的 `WORKER_MODEL_HOSTS`（AI 物件集外部模型允许下载的主机）必须显式写出，每项是主机名、
//   以点开头的后缀或 `主机:端口`，不带协议和路径（规则同 worker/src/metaverse_worker/fetch.py）。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_SERVICE = 'metaverse-api';
export const WORKER_SERVICE = 'metaverse-worker';

/** 每个服务的镜像仓库（images.yml 推送的包）。 */
export const IMAGE_REPOSITORIES = {
  'metaverse-web': 'ghcr.io/chronoaiproject/chrono-metaverse-web',
  [API_SERVICE]: 'ghcr.io/chronoaiproject/chrono-metaverse-api',
  [WORKER_SERVICE]: 'ghcr.io/chronoaiproject/chrono-metaverse-worker',
};

/**
 * 按摘要固定的镜像引用：`仓库[:标签]@sha256:<64 位小写十六进制>`。chrono-cd 在标签和摘要都有时
 * 只按摘要拉取，标签只是给人看的记号，所以只允许 7 位提交哈希（images.yml 的短哈希标签），
 * 不允许 `main` 这类分支标签，免得记号和实际镜像对不上。
 */
const PINNED_IMAGE = /^(?<repo>[a-z0-9.-]+(?:\/[a-z0-9._-]+)+?)(?::(?<tag>[^@:/]+))?@(?<digest>sha256:[0-9a-f]{64})$/;
const COMMIT_TAG = /^[0-9a-f]{7}$/;

/** 解析按摘要固定的镜像引用；不是这种形式时返回 null。 */
export function parsePinnedImage(image) {
  const match = typeof image === 'string' ? PINNED_IMAGE.exec(image) : null;
  if (!match) return null;
  const { repo, tag, digest } = match.groups;
  return { repo, tag: tag ?? null, digest };
}

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

/**
 * 没有可信地址头时，每个桶每秒至少能放行的请求数（按接口服务 `cpu_limit` 的每核计）。
 *
 * 这时来源地址是 Google 前端代理或 nginx 副本的地址，所有访客共用少数几个桶。额度只要是
 * 进程处理得了的速率，一台机器持续以略高于它的速度请求（例如有进程内缓存、几乎没有成本的
 * `/head`）就能把这些桶耗尽，之后所有访客的公开查看都是 429。每核每秒 100 万次远超接口服务
 * 的处理能力，进程被打满之前限流器不会拒绝任何人，限流也就不再是一个便宜的"全站 429 开关"。
 * 突发额度至少是一秒的量：额度很高而突发很小时，同一瞬间到达的几个请求也会被拒。
 */
export const SHARED_BUCKET_PER_CORE_PER_SECOND = 1_000_000;

/** 每个限流变量的下限是"每秒多少次"的几倍：每分钟的额度乘 60，突发额度按一秒算。 */
const SHARED_BUCKET_SECONDS = {
  PUBLIC_RATE_LIMIT_PER_MINUTE: 60,
  PUBLIC_RATE_LIMIT_BURST: 1,
  PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE: 60,
  PUBLIC_BLOB_RATE_LIMIT_BURST: 1,
};

/**
 * 没有可信地址头时四个限流变量的下限：按接口服务的 `cpu_limit`（向上取整、至少 1 核）放大。
 * `cpuLimit` 不合法时按 1 核算（`cpu_limit` 本身由 chrono-cd 校验）。
 */
export function sharedBucketFloor(cpuLimit) {
  const cpu = parseCpu(cpuLimit);
  const cores = cpu === null ? 1 : Math.max(1, Math.ceil(cpu));
  return Object.fromEntries(
    Object.entries(SHARED_BUCKET_SECONDS).map(([name, seconds]) => [
      name,
      SHARED_BUCKET_PER_CORE_PER_SECOND * cores * seconds,
    ]),
  );
}

/** 值是一串地址（逐跳追加）的转发头：接口服务只认恰好一个 IP 的值，这些头配了也不起作用。 */
export const CHAIN_HEADERS = ['x-forwarded-for', 'forwarded', 'x-forwarded', 'x-original-forwarded-for', 'via'];

/** 部署配置种子（api/crates/metaverse-api/src/demo_seed/config.rs）。 */
export const SEED_VAR = 'METAVERSE_DEMO_SEED';
export const SEED_TOKEN_VAR = 'METAVERSE_DEMO_SHARE_TOKEN';
const SEED_KEYS = [
  'spaceId',
  'name',
  'description',
  'owner',
  'visibility',
  'observedAt',
  'files',
  'rebuild',
  'voxelize',
  'hints',
  'revision',
  'authored',
];
const SEED_FILE_KEYS = ['url', 'name', 'sha256', 'size'];
const SEED_AUTHORED_KEYS = ['url', 'sha256', 'size'];
/** AI 物件集的大小上限（接口服务 `metaverse_core::authored::MAX_AUTHORED_BYTES`）。 */
export const MAX_AUTHORED_BYTES = 4 * 1024 * 1024;
/**
 * 种子里物件集的地址：raw.githubusercontent.com 上按 40 位提交哈希固定的 infra/chrono-cd/demo/*.json。
 * 用分支名的地址内容会变，sha256 就对不上了（接口服务按失败处理，演示空间建不起来）。
 */
export const AUTHORED_URL =
  /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/infra\/chrono-cd\/demo\/[A-Za-z0-9_.-]+\.json$/;
/** 处理服务 `WORKER_MODEL_HOSTS` 的一项（规则同 worker/src/metaverse_worker/fetch.py 的 parse_hosts）。 */
const MODEL_HOST = /^(?:\.?[a-z0-9-]+(?:\.[a-z0-9-]+)+|[a-z0-9-]+(?:\.[a-z0-9-]+)*:[0-9]{1,5})$/;
const MESH_EXTENSIONS = ['glb', 'drc', 'obj'];
const SIDE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'mtl'];
/** 提示规范化后的上限（接口服务 `MAX_HINTS_BYTES`）。 */
export const MAX_HINTS_BYTES = 4096;
/** 扫描上传的默认上限（接口服务 `UPLOAD_MAX_SCAN_BYTES` 的默认值）。 */
const DEFAULT_MAX_SCAN_BYTES = 1 << 30;
/**
 * 种子文件总大小的固定上限（接口服务 `MAX_SEED_TOTAL_BYTES`，256MiB）：文件和打包的 zip 都在内存里，
 * 实际上限取它和扫描上传上限中较小的一个。
 */
export const MAX_SEED_TOTAL_BYTES = 256 * 1024 * 1024;

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

  const hosts = env.WORKER_MODEL_HOSTS;
  if (hosts === undefined) {
    problems.push(
      `${WORKER_SERVICE}：缺少 WORKER_MODEL_HOSTS（AI 物件集外部模型允许下载的主机）。显式写出来，` +
        `部署规格里就能看到处理服务要访问哪些模型库`,
    );
  } else {
    const entries = typeof hosts === 'string' ? hosts.split(',').map((item) => item.trim().toLowerCase()) : [];
    const bad = entries.filter((entry) => !MODEL_HOST.test(entry));
    if (entries.length === 0 || entries.every((entry) => entry === '') || bad.length > 0) {
      problems.push(
        `${WORKER_SERVICE}：WORKER_MODEL_HOSTS 每项必须是主机名、以点开头的后缀或 主机:端口，不带协议和路径` +
          `（${bad.length > 0 ? `不合法：${bad.map((entry) => JSON.stringify(entry)).join('、')}` : '现在是空的'}）`,
      );
    }
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

  // 没有可信头：来源地址是网关或 nginx 的地址，所有访客共用几个桶。额度必须高到进程被打满之前
  // 不会拒绝任何人，否则一个来源就能把桶耗尽、让所有访客都 429（SHARED_BUCKET_PER_CORE_PER_SECOND）。
  const cpuLimit = spec.services[API_SERVICE].resources?.cpu_limit;
  const floor = sharedBucketFloor(cpuLimit);
  for (const [name, perVisitor] of Object.entries(PUBLIC_RATE_DEFAULTS)) {
    const value = parsePositiveInt(env[name] ?? '', U32_MAX);
    if (!(name in env)) {
      problems.push(
        `${API_SERVICE}：没有设 TRUSTED_CLIENT_IP_HEADER 时限流按网关地址计、所有访客共用几个桶，` +
          `必须显式设置 ${name}（至少 ${floor[name]}；接口服务默认的 ${perVisitor} 是按单个访客设计的）`,
      );
    } else if (value !== null && value < floor[name]) {
      problems.push(
        `${API_SERVICE}：${name}=${value} 低于 ${floor[name]}（cpu_limit ${cpuLimit} 下每核每秒 ` +
          `${SHARED_BUCKET_PER_CORE_PER_SECOND} 次）。按网关地址计时所有访客共用几个桶，` +
          `一个来源持续以略高于额度的速度请求就能让所有访客的公开查看都返回 429`,
      );
    }
  }
}

function checkImages(spec, problems) {
  for (const [name, service] of Object.entries(spec.services)) {
    const image = service?.image;
    const pinned = parsePinnedImage(image);
    if (pinned === null) {
      problems.push(
        `${name}：image 必须按摘要固定（仓库[:7 位提交哈希]@sha256:<64 位>，现在是 ${JSON.stringify(image)}）。` +
          `ghcr 的标签可以被任何分支的工作流改写，chrono-cd 每次 PUT / PATCH 都会重新解析标签，` +
          `一次只改环境变量的 PATCH 也会把别人推上去的镜像部署上线；用 pin-images.mjs 生成`,
      );
      continue;
    }
    if (pinned.tag !== null && !COMMIT_TAG.test(pinned.tag)) {
      problems.push(
        `${name}：image 的标签 ${pinned.tag} 不是 7 位提交哈希。标签和摘要都有时 chrono-cd 只看摘要，` +
          `标签只是记号；写分支名之类的标签会让人以为部署的是别的版本`,
      );
    }
    const expected = IMAGE_REPOSITORIES[name];
    if (expected !== undefined && pinned.repo !== expected) {
      problems.push(`${name}：image 的仓库应当是 ${expected}（现在是 ${pinned.repo}）`);
    }
  }
}

/** 规范化 JSON（键按码点排序，没有空白）：与接口服务的 `canonical_json` 对这里会出现的值相同。 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * 按接口服务的规则静态校验种子（不下载文件）。`targetOrg` 是部署这个应用的组织，`maxScanBytes` 是
 * 接口服务的扫描上传上限。返回问题列表。
 */
export function seedProblems(seed, { targetOrg, maxScanBytes = DEFAULT_MAX_SCAN_BYTES } = {}) {
  const problems = [];
  const limit = Math.min(maxScanBytes, MAX_SEED_TOTAL_BYTES);
  const bad = (text) => problems.push(`demo-seed.json：${text}`);
  if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) {
    bad('必须是 JSON 对象');
    return problems;
  }
  for (const key of Object.keys(seed)) {
    if (!SEED_KEYS.includes(key)) bad(`不认识的字段 ${key}（接口服务会拒绝，启动失败）`);
  }
  if (typeof seed.spaceId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(seed.spaceId)) {
    bad('spaceId 必须是 3–64 个字符的小写字母、数字和 -，首尾不能是 -');
  }
  if (typeof seed.name !== 'string' || seed.name.trim() === '' || [...seed.name].length > 200) {
    bad('name 不能为空，最多 200 个字符');
  }
  if (seed.description !== undefined && (typeof seed.description !== 'string' || [...seed.description].length > 2000)) {
    bad('description 最多 2000 个字符');
  }
  const owner = seed.owner;
  if (owner === null || typeof owner !== 'object' || owner.kind !== 'org' || typeof owner.id !== 'string') {
    bad('owner 必须是 {"kind": "org", "id": <组织编号>}');
  } else {
    const extra = Object.keys(owner).filter((key) => !['kind', 'id'].includes(key));
    if (extra.length > 0) bad(`owner 有不认识的字段 ${extra.join('、')}`);
    if (targetOrg !== undefined && owner.id !== targetOrg) {
      bad(`owner.id（${owner.id}）不是部署这个应用的组织（target_org_id ${targetOrg}）`);
    }
  }
  const visibility = seed.visibility ?? 'unlisted';
  if (!['unlisted', 'public'].includes(visibility)) bad('visibility 只能是 unlisted 或 public');
  if (seed.observedAt !== undefined && (typeof seed.observedAt !== 'string' || Number.isNaN(Date.parse(seed.observedAt)))) {
    bad('observedAt 必须是 RFC 3339 时间');
  }
  for (const key of ['rebuild', 'voxelize']) {
    if (seed[key] !== undefined && typeof seed[key] !== 'boolean') bad(`${key} 必须是 true 或 false`);
  }
  if (seed.revision !== undefined && !(Number.isInteger(seed.revision) && seed.revision >= 1 && seed.revision <= U32_MAX)) {
    bad('revision 必须是从 1 开始的整数');
  }
  if (seed.hints !== undefined && seed.hints !== null) {
    if (typeof seed.hints !== 'object' || Array.isArray(seed.hints)) {
      bad('hints 必须是 JSON 对象');
    } else if (Buffer.byteLength(canonicalJson(seed.hints)) > MAX_HINTS_BYTES) {
      bad(`hints 规范化后超过 ${MAX_HINTS_BYTES} 字节`);
    }
  }
  if (seed.authored !== undefined && seed.authored !== null) {
    const authored = seed.authored;
    if (typeof authored !== 'object' || Array.isArray(authored)) {
      bad('authored 必须是 {url, sha256, size}');
    } else {
      for (const key of Object.keys(authored)) {
        if (!SEED_AUTHORED_KEYS.includes(key)) bad(`authored 有不认识的字段 ${key}`);
      }
      if (typeof authored.url !== 'string' || !AUTHORED_URL.test(authored.url)) {
        bad(
          `authored.url 必须是 https://raw.githubusercontent.com/<组织>/<仓库>/<40 位提交哈希>/infra/chrono-cd/demo/<文件>.json` +
            `（按提交哈希固定，不能用分支名；现在是 ${JSON.stringify(authored.url)}）`,
        );
      }
      if (typeof authored.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(authored.sha256)) {
        bad('authored.sha256 必须是 64 位小写十六进制');
      }
      if (!Number.isSafeInteger(authored.size) || authored.size <= 0 || authored.size > MAX_AUTHORED_BYTES) {
        bad(`authored.size 必须是 1–${MAX_AUTHORED_BYTES} 的整数`);
      }
      if (seed.rebuild === false) bad('带 authored（AI 物件集）时 rebuild 不能是 false');
    }
  }
  const files = Array.isArray(seed.files) ? seed.files : [];
  if (files.length === 0 || files.length > 32) bad('files 要有 1–32 个文件');
  let total = 0;
  const names = new Set();
  const extensions = [];
  for (const [index, file] of files.entries()) {
    const label = `files[${index}]`;
    if (file === null || typeof file !== 'object') {
      bad(`${label} 必须是对象`);
      continue;
    }
    for (const key of Object.keys(file)) {
      if (!SEED_FILE_KEYS.includes(key)) bad(`${label} 有不认识的字段 ${key}`);
    }
    let url = null;
    try {
      url = new URL(file.url);
    } catch {
      bad(`${label}.url 不是合法地址`);
    }
    if (url !== null) {
      const httpsOk = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
      if (!httpsOk || url.username !== '' || url.password !== '' || url.hash !== '') {
        bad(`${label}.url 必须是 https，不带用户名、密码和片段（${file.url}）`);
      }
    }
    const name = typeof file.name === 'string' ? file.name : '';
    const extension = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(name) ? name.split('.').pop().toLowerCase() : '';
    if (![...MESH_EXTENSIONS, ...SIDE_EXTENSIONS, 'zip'].includes(extension) || !name.includes('.')) {
      bad(`${label}.name 不合法（${JSON.stringify(file.name)}）：扩展名只能是 glb、drc、obj、jpg、jpeg、png、webp、mtl、zip`);
    }
    if (names.has(name.toLowerCase())) bad(`${label}.name 重复：${name}`);
    names.add(name.toLowerCase());
    extensions.push(extension);
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      bad(`${label}.sha256 必须是 64 位小写十六进制`);
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limit) {
      bad(`${label}.size 必须是 1–${limit} 的整数`);
    } else {
      total += file.size;
    }
  }
  if (total > limit) {
    bad(`文件总大小 ${total} 超过上限 ${limit}（种子在内存里处理，取 256MiB 和 UPLOAD_MAX_SCAN_BYTES 中较小的）`);
  }
  const meshes = extensions.filter((extension) => MESH_EXTENSIONS.includes(extension)).length;
  const archives = extensions.filter((extension) => extension === 'zip').length;
  const usable = files.length === 1 ? meshes + archives === 1 : meshes === 1 && archives === 0;
  if (files.length > 0 && !usable) {
    bad('files 要么是单独一个 glb / drc / obj / zip，要么是一个网格加贴图和材质（会打包成 zip）');
  }
  return problems;
}

function checkSeed(spec, seedText, problems) {
  const service = spec?.services?.[API_SERVICE];
  if (!service) return;
  const env = service.env ?? {};
  const value = env[SEED_VAR];
  if (seedText === undefined || seedText === null) {
    if (value !== undefined) problems.push(`${API_SERVICE}：设了 ${SEED_VAR}，但 infra/chrono-cd/demo-seed.json 不存在（两处要一致）`);
    return;
  }
  let seed;
  try {
    seed = JSON.parse(seedText);
  } catch (error) {
    problems.push(`demo-seed.json 不是合法的 JSON：${error.message}`);
    return;
  }
  const expected = JSON.stringify(seed);
  if (value === undefined) {
    problems.push(`${API_SERVICE}：没有 ${SEED_VAR}，与 infra/chrono-cd/demo-seed.json 不一致（不用种子时两处一起删）`);
  } else if (typeof value !== 'string' || value.includes('\n')) {
    problems.push(`${API_SERVICE}：${SEED_VAR} 必须是压缩成一行的 JSON`);
  } else if (value !== expected) {
    let same = false;
    try {
      same = canonicalJson(JSON.parse(value)) === canonicalJson(seed);
    } catch {
      same = false;
    }
    problems.push(
      same
        ? `${API_SERVICE}：${SEED_VAR} 与 demo-seed.json 内容相同但不是它压缩成的一行（用 node infra/dev/demo-seed.mjs compact infra/chrono-cd/demo-seed.json 生成）`
        : `${API_SERVICE}：${SEED_VAR} 与 infra/chrono-cd/demo-seed.json 不一致（用 node infra/dev/demo-seed.mjs compact infra/chrono-cd/demo-seed.json 重新生成）`,
    );
  }
  const maxScanBytes = parsePositiveInt(env.UPLOAD_MAX_SCAN_BYTES) ?? DEFAULT_MAX_SCAN_BYTES;
  problems.push(...seedProblems(seed, { targetOrg: spec.target_org_id, maxScanBytes }));
  const secrets = service.secret_keys ?? [];
  if ((seed.visibility ?? 'unlisted') === 'unlisted' && !secrets.includes(SEED_TOKEN_VAR)) {
    problems.push(
      `${API_SERVICE}：种子是凭链接查看（unlisted），secret_keys 里要有 ${SEED_TOKEN_VAR}（分享令牌原文，用 set_app_secrets 设置）`,
    );
  }
  if (secrets.includes(SEED_TOKEN_VAR) && SEED_TOKEN_VAR in env) {
    problems.push(`${API_SERVICE}：${SEED_TOKEN_VAR} 是密钥，不能写进 env（get_app 会原样返回）`);
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
      ...(service.secret_keys ?? []),
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
  const hasSecrets = Object.values(spec?.services ?? {}).some((service) => (service.secret_keys ?? []).length > 0);
  if (hasSecrets && !readme.includes('set_app_secrets')) {
    problems.push('README 要写明密钥怎么设置（chrono-cd 的 `set_app_secrets`，值不进仓库、不交给 AI）');
  }
}

/** up.sh 是否在本地起处理服务（`start worker …`）。 */
export function devScriptStartsWorker(upScript) {
  return /^\s*start worker\b/m.test(upScript);
}

function checkDevScript(upScript, problems) {
  // 处理服务下线以后（docs/design/server-slim.md 13.3），up.sh 不再起它，本地也就没有要和线上
  // 对齐的处理服务内存；线上在 R2 之前仍跑旧的处理服务，app.json 里它的线程变量照旧检查。
  if (!devScriptStartsWorker(upScript)) return;
  for (const name of [...WORKER_THREAD_VARS, WORKER_ARENA_VAR]) {
    if (!new RegExp(`(^|\\s)${name}=`, 'm').test(upScript)) {
      problems.push(`infra/dev/up.sh 没有给处理服务设 ${name}：本地测的内存和线上不一致`);
    }
  }
}

/**
 * 检查应用规格，返回问题列表（空表示通过）。
 * `readme`、`upScript` 是对应文件的文本，不给就跳过那部分检查；`seed` 是 demo-seed.json 的文本
 * （`null` 表示文件不存在，不给就跳过种子检查）。
 */
export function checkApp(spec, { readme, upScript, seed } = {}) {
  const problems = [];
  if (spec === null || typeof spec !== 'object' || typeof spec.services !== 'object' || spec.services === null) {
    return ['app.json 没有 services'];
  }
  checkImages(spec, problems);
  checkWorker(spec, problems);
  checkApi(spec, problems);
  if (readme !== undefined) checkReadme(spec, readme, problems);
  if (upScript !== undefined) checkDevScript(upScript, problems);
  if (seed !== undefined) checkSeed(spec, seed, problems);
  return problems;
}

/** 读仓库里的文件并检查。 */
export function checkRepository(appPath) {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = JSON.parse(readFileSync(appPath ?? join(here, 'app.json'), 'utf8'));
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  const upScript = readFileSync(join(here, '..', 'dev', 'up.sh'), 'utf8');
  const seedPath = join(here, 'demo-seed.json');
  const seed = existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : null;
  return checkApp(spec, { readme, upScript, seed });
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
