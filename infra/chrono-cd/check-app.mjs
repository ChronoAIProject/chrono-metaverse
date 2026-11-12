#!/usr/bin/env node
// chrono-cd 应用规格（app.json）的静态检查。持续集成里运行，改 app.json 前后也可以本地跑：
//
//   node infra/chrono-cd/check-app.mjs [app.json]
//
// 检查的都是"写错了服务也能启动、但线上行为不对"的配置：
//
// - 服务：只有 `metaverse-web`、`metaverse-api` 两个。处理服务已下线（docs/design/server-slim.md 10.1），
//   规格里出现 `metaverse-worker` 就报错——chrono-cd 的 PUT 是整份替换，规格里留着它就还会跑旧镜像。
// - 接口服务：公开接口的限流额度必须是合法正整数（否则接口服务启动失败）；可信客户端地址头
//   只能是单值头（接口服务只认恰好一个 IP 的值，X-Forwarded-For 这类转发链会被忽略）；
//   没有可信头时限流按网关地址计，所有访客共用几个桶，一个来源持续多发请求就能耗尽它们、让所有
//   访客都 429。所以这时四个额度必须显式设到单个进程处理不了的高度（每核每秒 100 万次），
//   等于关掉限流，靠每空间并发上限和进程内缓存兜底（README 第 1 节"公开接口限流"）。
// - 接口服务的内存预算（设计 4.8）：物件模型、网页用模型、贴图的上限，公开接口缓存和并发分片数
//   必须显式写出且是正整数，部署规格里就能看到按哪组数估的内存（README 第 1 节"内存预算"）。
// - 镜像：每个服务都按摘要固定（`仓库[:7 位提交哈希]@sha256:<64 位>`），仓库与服务名对应。ghcr 的标签
//   可以被任何分支里改过的工作流改写，chrono-cd 每次 PUT / PATCH 都把标签重新解析成摘要，按标签
//   写的规格在一次只改环境变量的 PATCH 里也会换成别人推上去的镜像（README 第 1 步"镜像按摘要固定"）。
// - README 的环境变量表列出了 app.json 里的每一个环境变量和密钥名。
// - 部署配置种子：`demo-seed.json` 和接口服务的 `METAVERSE_DEMO_SEED` 内容一致（后者是前者压缩成的
//   一行）；种子按接口服务的规则静态校验（docs/design/server-slim.md 7.1：拒绝未知字段，旧格式的
//   `files`、`rebuild`、`hints`、`authored` 等报错——接口服务遇到旧格式会跳过种子；主人是部署这个应用
//   的组织；带 `bundle` 时清单和来源表按地址、sha256、大小固定，地址是 https、主机在
//   `METAVERSE_DEMO_SEED_HOSTS` 里，raw.githubusercontent.com 的地址按 40 位提交哈希固定）；有种子时
//   `METAVERSE_DEMO_SEED_HOSTS` 必须显式写出、每项合法，并且和本地 `infra/dev/up.sh` 的默认值相同
//   （本地 `--demo-seed` 和线上下载同一组主机）；凭链接查看时 `secret_keys` 里要有
//   `METAVERSE_DEMO_SHARE_TOKEN`，README 要写明用 `set_app_secrets` 设置它（README 第 5 步"密钥"、
//   第 8 步"演示数据"）。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_SERVICE = 'metaverse-api';
export const WEB_SERVICE = 'metaverse-web';
/** 已下线的服务：规格里不能再出现（docs/design/server-slim.md 10.1）。 */
export const RETIRED_SERVICES = ['metaverse-worker'];

/** 每个服务的镜像仓库（publish-main.yml 推送的包）。 */
export const IMAGE_REPOSITORIES = {
  [WEB_SERVICE]: 'ghcr.io/chronoaiproject/chrono-metaverse-web',
  [API_SERVICE]: 'ghcr.io/chronoaiproject/chrono-metaverse-api',
};

/**
 * 按摘要固定的镜像引用：`仓库[:标签]@sha256:<64 位小写十六进制>`。chrono-cd 在标签和摘要都有时
 * 只按摘要拉取，标签只是给人看的记号，所以只允许 7 位提交哈希（publish-main.yml 的短哈希标签），
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

/**
 * 接口服务必须显式写出的上限和缓存配置（设计 4.8、10.1）：内存预算按这组数估算，写在部署规格里
 * 才看得到；值必须是正整数（接口服务读到 0 或非数字会启动失败，见 api/crates/metaverse-api/src/ingest/mod.rs）。
 */
export const EXPLICIT_API_VARS = [
  'UPLOAD_MODEL_MAX_TRIANGLES',
  'UPLOAD_MODEL_MAX_TEXTURE_SIDE',
  'UPLOAD_WEBMODEL_MAX_TRIANGLES',
  'UPLOAD_MAX_TEXTURE_SIDE',
  'PUBLIC_CACHE_BYTES',
  'UPLOAD_MAX_CONCURRENT_PARTS',
];

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
const SEED_KEYS = ['spaceId', 'name', 'description', 'owner', 'visibility', 'revision', 'bundle'];
/** 旧格式（处理服务下线前）的字段：接口服务记错误日志、跳过种子。 */
export const LEGACY_SEED_KEYS = ['files', 'rebuild', 'voxelize', 'hints', 'authored', 'observedAt'];
const SEED_BUNDLE_KEYS = ['manifest', 'sources'];
const SEED_PINNED_KEYS = ['url', 'sha256', 'size'];
/** 部署种子允许下载的主机（接口服务 `demo_seed::hosts`）。 */
export const SEED_HOSTS_VAR = 'METAVERSE_DEMO_SEED_HOSTS';
/** 清单的大小上限（接口服务 `UPLOAD_MAX_BUNDLE_BYTES` 的默认值，也是它的最大值）。 */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** 来源表的大小上限（接口服务 `demo_seed::sources::MAX_SOURCES_BYTES`）。 */
export const MAX_SOURCES_BYTES = 1024 * 1024;
/** raw.githubusercontent.com 的地址：`/<组织>/<仓库>/<40 位提交哈希>/…`（分支名会变，内容就和 sha256 对不上）。 */
const RAW_GITHUB_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\//;

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

function checkServices(spec, problems) {
  for (const name of RETIRED_SERVICES) {
    if (name in spec.services) {
      problems.push(
        `${name} 已下线（docs/design/server-slim.md 10.1）：从规格里删掉。chrono-cd 的 PUT 整份替换，` +
          `留着它就还会按旧镜像跑处理服务、占配额`,
      );
    }
  }
  for (const name of [WEB_SERVICE, API_SERVICE]) {
    if (!spec.services[name]) problems.push(`缺少服务 ${name}`);
  }
}

function checkApi(spec, problems) {
  if (!spec?.services?.[API_SERVICE]) return;
  const env = serviceEnv(spec, API_SERVICE);

  for (const name of EXPLICIT_API_VARS) {
    if (!(name in env)) {
      problems.push(`${API_SERVICE}：缺少 ${name}。内存预算按这组上限估算（设计 4.8），要在部署规格里显式写出`);
    } else if (parsePositiveInt(env[name]) === null) {
      problems.push(`${API_SERVICE}：${name} 必须是正整数（现在是 ${JSON.stringify(env[name])}），否则接口服务启动失败`);
    }
  }

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
 * 解析主机列表（规则同接口服务 `demo_seed::hosts` 和本地工具的主机列表）：逗号分隔；`主机名` 精确
 * 匹配且只许 443 端口；`.后缀` 匹配子域名；`主机:端口` 只匹配那个端口。返回 `{entries, bad}`。
 */
export function parseSeedHosts(text) {
  const entries = [];
  const bad = [];
  for (const item of String(text ?? '').split(',')) {
    const raw = item.trim().toLowerCase();
    if (raw === '') continue;
    const suffix = raw.startsWith('.');
    const name = suffix ? raw.slice(1) : raw;
    const [host, port, ...extra] = name.split(':');
    const portOk = port === undefined || (/^[0-9]{1,5}$/.test(port) && Number(port) > 0 && Number(port) < 65536);
    const hostOk = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host ?? '');
    if (extra.length > 0 || !portOk || !hostOk || (suffix && (port !== undefined || !host.includes('.')))) {
      bad.push(item.trim());
      continue;
    }
    entries.push(suffix ? { suffix: `.${host}` } : { host, port: port === undefined ? null : Number(port) });
  }
  return { entries, bad };
}

/** 地址能不能下载：https（或本机 http），不带用户名、密码和片段，主机和端口在列表里。 */
export function seedUrlAllowed(url, entries) {
  const https = url.protocol === 'https:';
  if (!(https || (url.protocol === 'http:' && isLoopbackHost(url.hostname)))) return false;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const port = url.port === '' ? (https ? 443 : 80) : Number(url.port);
  return entries.some((entry) =>
    entry.suffix !== undefined
      ? https && port === 443 && host.length > entry.suffix.length && host.endsWith(entry.suffix)
      : entry.host === host && (entry.port === null ? https && port === 443 : port === entry.port),
  );
}

/**
 * 按接口服务的规则静态校验种子（不下载文件）。`targetOrg` 是部署这个应用的组织，`hosts` 是
 * `METAVERSE_DEMO_SEED_HOSTS` 的值（没设时为 undefined），`maxManifestBytes` 是清单的上限。返回问题列表。
 */
export function seedProblems(seed, { targetOrg, hosts, maxManifestBytes = MAX_MANIFEST_BYTES } = {}) {
  const problems = [];
  const bad = (text) => problems.push(`demo-seed.json：${text}`);
  if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) {
    bad('必须是 JSON 对象');
    return problems;
  }
  const legacy = Object.keys(seed).filter((key) => LEGACY_SEED_KEYS.includes(key));
  if (legacy.length > 0) {
    bad(
      `是旧格式（${legacy.join('、')}）：旧格式的种子要处理服务，已不支持，改成 bundle（docs/design/server-slim.md 7.1）；接口服务会跳过种子`,
    );
  }
  for (const key of Object.keys(seed)) {
    if (!SEED_KEYS.includes(key) && !LEGACY_SEED_KEYS.includes(key)) {
      bad(`不认识的字段 ${key}（接口服务会拒绝，启动失败）`);
    }
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
  if (seed.revision !== undefined && !(Number.isInteger(seed.revision) && seed.revision >= 1 && seed.revision <= U32_MAX)) {
    bad('revision 必须是从 1 开始的整数');
  }
  const parsedHosts = hosts === undefined ? null : parseSeedHosts(hosts);
  if (parsedHosts !== null && parsedHosts.bad.length > 0) {
    bad(`${SEED_HOSTS_VAR} 里的 ${parsedHosts.bad.map((item) => JSON.stringify(item)).join('、')} 不是合法的主机（写主机名、.后缀 或 主机:端口，不带协议和路径）`);
  }
  if (seed.bundle !== undefined && seed.bundle !== null) {
    const bundle = seed.bundle;
    if (typeof bundle !== 'object' || Array.isArray(bundle)) {
      bad('bundle 必须是 {manifest, sources}');
      return problems;
    }
    for (const key of Object.keys(bundle)) {
      if (!SEED_BUNDLE_KEYS.includes(key)) bad(`bundle 有不认识的字段 ${key}`);
    }
    if (parsedHosts === null || parsedHosts.entries.length === 0) {
      bad(`带 bundle 时 metaverse-api 必须设 ${SEED_HOSTS_VAR}（允许下载的主机，逗号分隔）`);
    }
    for (const [what, max] of [
      ['manifest', maxManifestBytes],
      ['sources', MAX_SOURCES_BYTES],
    ]) {
      const pinned = bundle[what];
      const label = `bundle.${what}`;
      if (pinned === null || typeof pinned !== 'object' || Array.isArray(pinned)) {
        bad(`${label} 必须是 {url, sha256, size}`);
        continue;
      }
      for (const key of Object.keys(pinned)) {
        if (!SEED_PINNED_KEYS.includes(key)) bad(`${label} 有不认识的字段 ${key}`);
      }
      let url = null;
      try {
        url = new URL(pinned.url);
      } catch {
        bad(`${label}.url 不是合法地址`);
      }
      if (url !== null) {
        if (!seedUrlAllowed(url, parsedHosts?.entries ?? [])) {
          bad(`${label}.url 必须是 https、不带用户名密码和片段，主机在 ${SEED_HOSTS_VAR} 里（现在是 ${url.host}）`);
        } else if (url.hostname === 'raw.githubusercontent.com' && !RAW_GITHUB_PATH.test(url.pathname)) {
          bad(`${label}.url 要按 40 位提交哈希固定（raw.githubusercontent.com/<组织>/<仓库>/<提交哈希>/…，不能用分支名）`);
        }
      }
      if (typeof pinned.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pinned.sha256)) {
        bad(`${label}.sha256 必须是 64 位小写十六进制`);
      }
      if (!Number.isSafeInteger(pinned.size) || pinned.size <= 0 || pinned.size > max) {
        bad(`${label}.size 必须是 1–${max} 的整数`);
      }
    }
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
  if (!(SEED_HOSTS_VAR in env)) {
    problems.push(
      `${API_SERVICE}：有种子时必须显式写出 ${SEED_HOSTS_VAR}（允许下载的主机，逗号分隔）。种子带重建包时` +
        `接口服务按它下载清单、来源表和文件；不带包时也写上，换成带包的种子时就只改种子一项`,
    );
  } else if (parseSeedHosts(env[SEED_HOSTS_VAR]).entries.length === 0) {
    problems.push(`${API_SERVICE}：${SEED_HOSTS_VAR} 是空的`);
  }
  const maxManifestBytes = Math.min(parsePositiveInt(env.UPLOAD_MAX_BUNDLE_BYTES) ?? MAX_MANIFEST_BYTES, MAX_MANIFEST_BYTES);
  problems.push(...seedProblems(seed, { targetOrg: spec.target_org_id, hosts: env[SEED_HOSTS_VAR], maxManifestBytes }));
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

/** up.sh 里接口服务 `METAVERSE_DEMO_SEED_HOSTS` 的默认值（`${METAVERSE_DEMO_SEED_HOSTS:-<默认>}`）；没有时返回 null。 */
export function devSeedHosts(upScript) {
  const match = /METAVERSE_DEMO_SEED_HOSTS="\$\{METAVERSE_DEMO_SEED_HOSTS:-([^}"]*)\}"/.exec(upScript);
  return match ? match[1] : null;
}

function checkDevScript(spec, upScript, problems) {
  // 本地 `up.sh --demo-seed` 默认用线上的 demo-seed.json，下载的主机也要和线上一样，
  // 本地能导入的种子线上才一定能导入（设计 10.3）。
  const online = serviceEnv(spec, API_SERVICE)[SEED_HOSTS_VAR];
  if (online === undefined) return;
  const local = devSeedHosts(upScript);
  if (local === null) {
    problems.push(`infra/dev/up.sh 没有给接口服务设 ${SEED_HOSTS_VAR} 的默认值（要和 app.json 的相同）`);
  } else if (local !== online) {
    problems.push(`infra/dev/up.sh 的 ${SEED_HOSTS_VAR} 默认值（${local}）和 app.json 的（${online}）不同`);
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
  checkServices(spec, problems);
  checkImages(spec, problems);
  checkApi(spec, problems);
  if (readme !== undefined) checkReadme(spec, readme, problems);
  if (upScript !== undefined) checkDevScript(spec, upScript, problems);
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
