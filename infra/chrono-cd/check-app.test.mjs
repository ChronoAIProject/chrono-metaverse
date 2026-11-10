// app.json 静态检查的测试：node --test infra/chrono-cd/*.test.mjs
// 先确认仓库里的 app.json、README、up.sh 通过检查，再逐条改坏，确认每条规则都能报出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  API_SERVICE,
  EXPLICIT_API_VARS,
  RETIRED_SERVICES,
  SHARED_BUCKET_PER_CORE_PER_SECOND,
  canonicalJson,
  checkApp,
  checkRepository,
  devSeedHosts,
  parseCpu,
  parseMemoryMiB,
  parsePinnedImage,
  parsePositiveInt,
  parseSeedHosts,
  seedProblems,
  seedUrlAllowed,
  sharedBucketFloor,
} from './check-app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, 'app.json'), 'utf8'));
const readme = readFileSync(join(here, 'README.md'), 'utf8');
const upScript = readFileSync(join(here, '..', 'dev', 'up.sh'), 'utf8');

/** 深拷贝一份规格，再按 `edit` 改。 */
function variant(edit) {
  const copy = structuredClone(spec);
  edit(copy);
  return copy;
}

const apiEnv = (copy) => copy.services[API_SERVICE].env;

function problemsOf(edited, options = {}) {
  return checkApp(edited, options);
}

function assertProblem(problems, pattern) {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `应当报出 ${pattern}，实际：\n${problems.join('\n') || '（没有问题）'}`,
  );
}

test('仓库里的 app.json、README、up.sh、demo-seed.json 通过检查', () => {
  assert.deepEqual(checkRepository(), []);
  assert.deepEqual(checkApp(spec, { readme, upScript }), []);
});

test('命令行：通过时退出码 0，发现问题时退出码 1 并列出问题', () => {
  const script = join(here, 'check-app.mjs');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /检查通过/);

  const dir = mkdtempSync(join(tmpdir(), 'check-app-'));
  try {
    const path = join(dir, 'app.json');
    writeFileSync(path, JSON.stringify(variant((copy) => delete apiEnv(copy).PUBLIC_CACHE_BYTES)));
    const failed = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /发现 \d+ 个问题/);
    assert.match(failed.stderr, /缺少 PUBLIC_CACHE_BYTES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const broken = spawnSync(process.execPath, [script, join(here, 'check-app.test.mjs')], { encoding: 'utf8' });
  assert.equal(broken.status, 2, '读不成 JSON 时退出码 2');
  assert.match(broken.stderr, /读取应用规格失败/);
});

test('数量解析：CPU、内存、正整数', () => {
  assert.equal(parseCpu('2'), 2);
  assert.equal(parseCpu('1.5'), 1.5);
  assert.equal(parseCpu('500m'), 0.5);
  assert.equal(parseCpu('2 cores'), null);
  assert.equal(parseCpu(undefined), null);
  assert.equal(parseMemoryMiB('8Gi'), 8192);
  assert.equal(parseMemoryMiB('512Mi'), 512);
  assert.equal(parseMemoryMiB('1048576'), 1);
  assert.equal(parseMemoryMiB('8GB'), null);
  assert.equal(parsePositiveInt('12000'), 12000);
  for (const bad of ['0', '-1', '1.5', ' 2', '2 ', '', '01', 'abc', undefined, 2]) {
    assert.equal(parsePositiveInt(bad), null, `${JSON.stringify(bad)} 不是正整数`);
  }
  assert.equal(parsePositiveInt('4294967296', 4_294_967_295), null, '超过 u32');
});

test('共用桶的额度下限：每核每秒 100 万次，按 cpu_limit 向上取整，不合法时按 1 核', () => {
  assert.deepEqual(sharedBucketFloor('1'), {
    PUBLIC_RATE_LIMIT_PER_MINUTE: 60_000_000,
    PUBLIC_RATE_LIMIT_BURST: 1_000_000,
    PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE: 60_000_000,
    PUBLIC_BLOB_RATE_LIMIT_BURST: 1_000_000,
  });
  assert.equal(sharedBucketFloor('250m').PUBLIC_RATE_LIMIT_BURST, 1_000_000);
  assert.equal(sharedBucketFloor('2').PUBLIC_RATE_LIMIT_PER_MINUTE, 120_000_000);
  assert.equal(sharedBucketFloor('2.5').PUBLIC_BLOB_RATE_LIMIT_BURST, 3_000_000);
  assert.equal(sharedBucketFloor(undefined).PUBLIC_RATE_LIMIT_PER_MINUTE, 60_000_000);
  assert.equal(SHARED_BUCKET_PER_CORE_PER_SECOND, 1_000_000);
});

test('服务：只有网站和接口服务，已下线的处理服务出现在规格里就报错', () => {
  assert.deepEqual(Object.keys(spec.services).sort(), ['metaverse-api', 'metaverse-web']);
  assert.deepEqual(RETIRED_SERVICES, ['metaverse-worker']);
  const withWorker = variant(
    (copy) =>
      (copy.services['metaverse-worker'] = {
        image: `ghcr.io/chronoaiproject/chrono-metaverse-worker:c882bca@sha256:${'7'.repeat(64)}`,
        port: 8080,
      }),
  );
  assertProblem(problemsOf(withWorker), /metaverse-worker 已下线.*从规格里删掉/);
  // 处理服务的镜像仓库不再认：也按"仓库与服务对应"之外的服务处理，只要求按摘要固定。
  assert.ok(!problemsOf(withWorker).some((problem) => problem.includes('image')), problemsOf(withWorker).join('\n'));
});

test('接口服务：内存预算用到的上限和缓存配置必须显式写出且是正整数', () => {
  assert.deepEqual(EXPLICIT_API_VARS, [
    'UPLOAD_MODEL_MAX_TRIANGLES',
    'UPLOAD_MODEL_MAX_TEXTURE_SIDE',
    'UPLOAD_WEBMODEL_MAX_TRIANGLES',
    'UPLOAD_MAX_TEXTURE_SIDE',
    'PUBLIC_CACHE_BYTES',
    'UPLOAD_MAX_CONCURRENT_PARTS',
  ]);
  for (const name of EXPLICIT_API_VARS) {
    assertProblem(problemsOf(variant((copy) => delete apiEnv(copy)[name])), new RegExp(`缺少 ${name}。内存预算`));
    for (const bad of ['0', '-1', '128MiB', '']) {
      assertProblem(
        problemsOf(variant((copy) => (apiEnv(copy)[name] = bad))),
        new RegExp(`${name} 必须是正整数`),
      );
    }
  }
  // 线上的值就是设计 4.8 估算用的那组。
  const env = apiEnv(structuredClone(spec));
  assert.equal(env.PUBLIC_CACHE_BYTES, String(128 * 1024 * 1024));
  assert.equal(env.UPLOAD_MAX_CONCURRENT_PARTS, '4');
  assert.equal(env.UPLOAD_MAX_TEXTURE_SIDE, '4096');
  assert.deepEqual(spec.services[API_SERVICE].resources, {
    cpu_request: '250m',
    memory_request: '384Mi',
    cpu_limit: '1',
    memory_limit: '1536Mi',
  });
});

test('接口服务：没有可信地址头时，限流额度必须显式设到进程处理不了的高度（共用的桶不能被一个来源耗尽）', () => {
  const missing = problemsOf(variant((copy) => delete apiEnv(copy).PUBLIC_RATE_LIMIT_PER_MINUTE));
  assertProblem(missing, /必须显式设置 PUBLIC_RATE_LIMIT_PER_MINUTE（至少 60000000/);

  // 按单个访客的默认值、以及以前"调高 10 倍到演示规模"的额度：一台机器每秒几百到几千次就能耗尽。
  const atDefault = problemsOf(variant((copy) => (apiEnv(copy).PUBLIC_BLOB_RATE_LIMIT_BURST = '2000')));
  assertProblem(atDefault, /PUBLIC_BLOB_RATE_LIMIT_BURST=2000 低于 1000000.*所有访客的公开查看都返回 429/);
  const demoScale = problemsOf(
    variant((copy) => {
      Object.assign(apiEnv(copy), {
        PUBLIC_RATE_LIMIT_PER_MINUTE: '12000',
        PUBLIC_RATE_LIMIT_BURST: '2000',
        PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE: '120000',
        PUBLIC_BLOB_RATE_LIMIT_BURST: '20000',
      });
    }),
  );
  for (const name of ['PUBLIC_RATE_LIMIT_PER_MINUTE', 'PUBLIC_RATE_LIMIT_BURST', 'PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE', 'PUBLIC_BLOB_RATE_LIMIT_BURST']) {
    assertProblem(demoScale, new RegExp(`${name}=\\d+ 低于`));
  }

  // 只差一点也不行；正好等于下限可以。
  assertProblem(
    problemsOf(variant((copy) => (apiEnv(copy).PUBLIC_RATE_LIMIT_PER_MINUTE = '59999999'))),
    /PUBLIC_RATE_LIMIT_PER_MINUTE=59999999 低于 60000000/,
  );
  assert.deepEqual(
    problemsOf(
      variant((copy) => {
        Object.assign(apiEnv(copy), {
          PUBLIC_RATE_LIMIT_PER_MINUTE: '60000000',
          PUBLIC_RATE_LIMIT_BURST: '1000000',
          PUBLIC_BLOB_RATE_LIMIT_PER_MINUTE: '60000000',
          PUBLIC_BLOB_RATE_LIMIT_BURST: '1000000',
        });
      }),
    ),
    [],
  );

  // 接口服务的核数调高后，进程能处理的请求也多了，下限跟着放大。
  const twoCores = problemsOf(variant((copy) => (copy.services[API_SERVICE].resources.cpu_limit = '1500m')));
  assertProblem(twoCores, /PUBLIC_RATE_LIMIT_PER_MINUTE=60000000 低于 120000000（cpu_limit 1500m/);
  assertProblem(twoCores, /PUBLIC_BLOB_RATE_LIMIT_BURST=1000000 低于 2000000/);

  const invalid = problemsOf(variant((copy) => (apiEnv(copy).PUBLIC_RATE_LIMIT_BURST = '0')));
  assertProblem(invalid, /PUBLIC_RATE_LIMIT_BURST 必须是 1 到 4294967295 的整数.*启动失败/);

  const tooLarge = problemsOf(variant((copy) => (apiEnv(copy).PUBLIC_RATE_LIMIT_PER_MINUTE = '4294967296')));
  assertProblem(tooLarge, /PUBLIC_RATE_LIMIT_PER_MINUTE 必须是 1 到 4294967295 的整数/);
});

test('接口服务：设了平台确认的单值头后，限流额度可以回到默认值', () => {
  const confirmed = variant((copy) => {
    const env = apiEnv(copy);
    env.TRUSTED_CLIENT_IP_HEADER = 'CF-Connecting-IP';
    for (const name of Object.keys(env).filter((key) => key.startsWith('PUBLIC_') && key.includes('RATE_LIMIT'))) {
      delete env[name];
    }
  });
  assert.deepEqual(problemsOf(confirmed, { readme, upScript }), []);

  // 设了头，额度仍然必须合法。
  const invalid = variant((copy) => {
    apiEnv(copy).TRUSTED_CLIENT_IP_HEADER = 'cf-connecting-ip';
    apiEnv(copy).PUBLIC_RATE_LIMIT_BURST = 'many';
  });
  assertProblem(problemsOf(invalid), /PUBLIC_RATE_LIMIT_BURST 必须是 1 到/);
});

test('接口服务：转发链头和不合法的头名不能当可信地址头', () => {
  for (const header of ['X-Forwarded-For', 'forwarded', 'Via']) {
    const problems = problemsOf(variant((copy) => (apiEnv(copy).TRUSTED_CLIENT_IP_HEADER = header)));
    assertProblem(problems, new RegExp(`TRUSTED_CLIENT_IP_HEADER=${header.toLowerCase()} 不起作用`));
  }
  const bad = problemsOf(variant((copy) => (apiEnv(copy).TRUSTED_CLIENT_IP_HEADER = 'cf connecting ip')));
  assertProblem(bad, /不是合法的请求头名/);
});

test('README 必须列出 app.json 里的每个环境变量', () => {
  const withExtra = variant((copy) => (apiEnv(copy).SOME_NEW_SETTING = '1'));
  assertProblem(problemsOf(withExtra, { readme }), /README 的环境变量表里没有 metaverse-api 的 `SOME_NEW_SETTING`/);

  const withoutCache = readme.replaceAll('`PUBLIC_CACHE_BYTES`', '缓存上限');
  assertProblem(problemsOf(spec, { readme: withoutCache }), /没有 metaverse-api 的 `PUBLIC_CACHE_BYTES`/);

  const withoutAddon = readme.replaceAll('`MONGODB_DATABASE`', '库名');
  assertProblem(problemsOf(spec, { readme: withoutAddon }), /没有 metaverse-api 的 `MONGODB_DATABASE`/);

  const withoutPending = readme.replaceAll('`TRUSTED_CLIENT_IP_HEADER`', '可信头');
  assertProblem(problemsOf(spec, { readme: withoutPending }), /要写明 `TRUSTED_CLIENT_IP_HEADER` 还没设置/);
});

test('up.sh 的种子主机列表默认值与 app.json 相同', () => {
  assert.equal(devSeedHosts(upScript), apiEnv(structuredClone(spec)).METAVERSE_DEMO_SEED_HOSTS);
  const changed = upScript.replace('scaniverse.com}', 'example.com}');
  assert.notEqual(changed, upScript);
  assertProblem(problemsOf(spec, { upScript: changed }), /up\.sh 的 METAVERSE_DEMO_SEED_HOSTS 默认值（.*example\.com）和 app\.json 的（.*scaniverse\.com）不同/);
  assertProblem(
    problemsOf(spec, { upScript: 'start api "$target/debug/metaverse-api"\n' }),
    /up\.sh 没有给接口服务设 METAVERSE_DEMO_SEED_HOSTS 的默认值/,
  );
  // 不用种子（app.json 里没有主机列表）时不查。
  const noHosts = variant((copy) => delete apiEnv(copy).METAVERSE_DEMO_SEED_HOSTS);
  assert.ok(!problemsOf(noHosts, { upScript: '' }).some((problem) => problem.includes('up.sh')));
  assert.equal(devSeedHosts(''), null);
});

test('镜像：每个服务都按摘要固定，标签只能是 7 位提交哈希，仓库与服务对应', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const image = (service, value) => problemsOf(variant((copy) => (copy.services[service].image = value)));

  // 只写标签（分支名、提交哈希都不行）：标签可以被改写，PUT / PATCH 时会重新解析。
  for (const value of [
    'ghcr.io/chronoaiproject/chrono-metaverse-api:main',
    'ghcr.io/chronoaiproject/chrono-metaverse-api:aabf88f',
    'ghcr.io/chronoaiproject/chrono-metaverse-api:latest',
  ]) {
    assertProblem(image(API_SERVICE, value), /metaverse-api：image 必须按摘要固定.*重新解析标签/);
  }
  // 摘要格式不对、缺 image、多出一段 @。
  for (const value of [
    `ghcr.io/chronoaiproject/chrono-metaverse-web@sha256:${'A'.repeat(64)}`,
    `ghcr.io/chronoaiproject/chrono-metaverse-web@sha256:${'a'.repeat(63)}`,
    `ghcr.io/chronoaiproject/chrono-metaverse-web@sha512:${'a'.repeat(64)}`,
    `ghcr.io/chronoaiproject/chrono-metaverse-web:aabf88f@${digest}@${digest}`,
    undefined,
    '',
  ]) {
    assertProblem(image('metaverse-web', value), /metaverse-web：image 必须按摘要固定/);
  }
  // 分支名当记号会误导人。
  assertProblem(
    image('metaverse-web', `ghcr.io/chronoaiproject/chrono-metaverse-web:main@${digest}`),
    /metaverse-web：image 的标签 main 不是 7 位提交哈希/,
  );
  // 换成别的仓库（例如把已下线的处理服务的镜像写到接口服务上，或者别人的包）。
  assertProblem(
    image(API_SERVICE, `ghcr.io/chronoaiproject/chrono-metaverse-worker:aabf88f@${digest}`),
    /metaverse-api：image 的仓库应当是 ghcr\.io\/chronoaiproject\/chrono-metaverse-api（现在是 ghcr\.io\/chronoaiproject\/chrono-metaverse-worker）/,
  );
  assertProblem(image(API_SERVICE, `ghcr.io/someone/chrono-metaverse-api@${digest}`), /image 的仓库应当是/);

  // 只有摘要、或者提交哈希加摘要，都可以。
  assert.deepEqual(image(API_SERVICE, `ghcr.io/chronoaiproject/chrono-metaverse-api@${digest}`), []);
  assert.deepEqual(image(API_SERVICE, `ghcr.io/chronoaiproject/chrono-metaverse-api:0123abc@${digest}`), []);

  // 别的服务（以后加的）也要按摘要固定。
  const extra = problemsOf(
    variant((copy) => (copy.services['metaverse-extra'] = { image: 'ghcr.io/chronoaiproject/extra:1' })),
  );
  assertProblem(extra, /metaverse-extra：image 必须按摘要固定/);

  assert.deepEqual(parsePinnedImage(`ghcr.io/o/p:abc1234@${digest}`), {
    repo: 'ghcr.io/o/p',
    tag: 'abc1234',
    digest,
  });
  assert.deepEqual(parsePinnedImage(`ghcr.io/o/sub/p@${digest}`), { repo: 'ghcr.io/o/sub/p', tag: null, digest });
  assert.equal(parsePinnedImage('ghcr.io/o/p:abc1234'), null);
  assert.equal(parsePinnedImage(42), null);
});

test('缺服务或没有 services 时报错', () => {
  assert.deepEqual(checkApp(null), ['app.json 没有 services']);
  assert.deepEqual(checkApp({}), ['app.json 没有 services']);
  assertProblem(checkApp(variant((copy) => delete copy.services['metaverse-web'])), /缺少服务 metaverse-web/);
  assertProblem(checkApp(variant((copy) => delete copy.services[API_SERVICE])), /缺少服务 metaverse-api/);
});

// ---------------------------------------------------------------------------
// 部署配置种子（demo-seed.json 与接口服务的 METAVERSE_DEMO_SEED）
// ---------------------------------------------------------------------------

const seedText = readFileSync(join(here, 'demo-seed.json'), 'utf8');
const seed = JSON.parse(seedText);

/** 改种子，同时把 app.json 的 METAVERSE_DEMO_SEED 同步成改后的一行（只测种子本身的规则）。 */
function seedVariant(edit) {
  const copy = structuredClone(seed);
  edit(copy);
  const app = variant((spec) => (apiEnv(spec).METAVERSE_DEMO_SEED = JSON.stringify(copy)));
  return checkApp(app, { seed: JSON.stringify(copy, null, 2) });
}

test('种子：app.json 的 METAVERSE_DEMO_SEED 就是 demo-seed.json 压缩成的一行', () => {
  assert.equal(apiEnv(structuredClone(spec)).METAVERSE_DEMO_SEED, JSON.stringify(seed));
  assert.deepEqual(checkApp(spec, { seed: seedText }), []);

  const drifted = variant((copy) => {
    const changed = { ...seed, name: '别的名字' };
    apiEnv(copy).METAVERSE_DEMO_SEED = JSON.stringify(changed);
  });
  assertProblem(checkApp(drifted, { seed: seedText }), /METAVERSE_DEMO_SEED 与 infra\/chrono-cd\/demo-seed\.json 不一致/);

  const pretty = variant((copy) => (apiEnv(copy).METAVERSE_DEMO_SEED = JSON.stringify(seed, null, 2)));
  assertProblem(checkApp(pretty, { seed: seedText }), /必须是压缩成一行的 JSON/);

  const reordered = variant((copy) => {
    const { spaceId, ...rest } = seed;
    apiEnv(copy).METAVERSE_DEMO_SEED = JSON.stringify({ ...rest, spaceId });
  });
  assertProblem(checkApp(reordered, { seed: seedText }), /内容相同但不是它压缩成的一行/);

  const missing = variant((copy) => delete apiEnv(copy).METAVERSE_DEMO_SEED);
  assertProblem(checkApp(missing, { seed: seedText }), /没有 METAVERSE_DEMO_SEED/);
  assertProblem(checkApp(spec, { seed: null }), /demo-seed\.json 不存在/);
  assertProblem(checkApp(spec, { seed: '{"spaceId": ' }), /demo-seed\.json 不是合法的 JSON/);

  // 两处都没有：不用种子，不报。
  assert.deepEqual(checkApp(missing, { seed: null }), []);
});

test('种子：按接口服务的规则静态校验', () => {
  assertProblem(seedVariant((s) => (s.extra = 1)), /不认识的字段 extra/);
  assertProblem(seedVariant((s) => (s.spaceId = 'ChronoAI_Lobby')), /spaceId 必须是/);
  assertProblem(seedVariant((s) => (s.name = ' ')), /name 不能为空/);
  assertProblem(seedVariant((s) => (s.owner = { kind: 'person', id: 'alice' })), /owner 必须是/);
  assertProblem(seedVariant((s) => (s.owner.id = 'chronoai')), /不是部署这个应用的组织/);
  assertProblem(seedVariant((s) => (s.owner.slug = 'chronoai')), /owner 有不认识的字段 slug/);
  assertProblem(seedVariant((s) => (s.visibility = 'private')), /visibility 只能是/);
  assertProblem(seedVariant((s) => (s.revision = 0)), /revision 必须是从 1 开始的整数/);
  // 规范化 JSON：键按码点排序、没有空白。
  assert.equal(canonicalJson({ b: [1, { d: 2, c: 'x' }], a: null }), '{"a":null,"b":[1,{"c":"x","d":2}]}');
  // 仓库里的种子（第 4 版带包）按 app.json 的主机列表校验通过；不给主机列表时带包的种子要报。
  const hosts = apiEnv(spec).METAVERSE_DEMO_SEED_HOSTS;
  assert.deepEqual(seedProblems(seed, { targetOrg: spec.target_org_id, hosts }), []);
  assertProblem(seedProblems(seed, { targetOrg: spec.target_org_id }), /带 bundle 时 metaverse-api 必须设 METAVERSE_DEMO_SEED_HOSTS/);
  assertProblem(seedProblems(null), /必须是 JSON 对象/);
});

test('种子：旧格式（处理服务时代的 files、rebuild、hints、authored……）报错', () => {
  for (const key of ['files', 'rebuild', 'voxelize', 'hints', 'authored', 'observedAt']) {
    const problems = seedVariant((s) => (s[key] = key === 'files' ? [] : true));
    assertProblem(problems, new RegExp(`是旧格式（${key}）.*改成 bundle`));
    assert.ok(!problems.some((problem) => problem.includes('不认识的字段')), problems.join('\n'));
  }
});

test('种子：bundle 的清单和来源表按地址、sha256、大小固定，主机在 METAVERSE_DEMO_SEED_HOSTS 里', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const raw = `https://raw.githubusercontent.com/chronoaiproject/chrono-metaverse/${commit}/infra/chrono-cd/demo/lobby-r4`;
  const bundle = {
    manifest: { url: `${raw}/manifest.json`, sha256: 'a'.repeat(64), size: 312345 },
    sources: { url: `${raw}/sources.json`, sha256: 'b'.repeat(64), size: 4567 },
  };
  const hosts = 'raw.githubusercontent.com,github.com,scaniverse.com';
  const check = (edit, hostList = hosts) => {
    const copy = structuredClone({ ...seed, revision: 4, bundle });
    edit(copy);
    // null 表示没设主机列表。
    return seedProblems(copy, { targetOrg: spec.target_org_id, hosts: hostList ?? undefined });
  };
  assert.deepEqual(
    check(() => {}),
    [],
  );
  assertProblem(check(() => {}, null), /带 bundle 时 metaverse-api 必须设 METAVERSE_DEMO_SEED_HOSTS/);
  assertProblem(check(() => {}, 'github.com'), /bundle\.manifest\.url 必须是 https.*主机在 METAVERSE_DEMO_SEED_HOSTS 里/);
  assertProblem(check(() => {}, 'https://raw.githubusercontent.com/'), /不是合法的主机/);
  assertProblem(
    check((s) => (s.bundle.manifest.url = s.bundle.manifest.url.replace('https:', 'http:'))),
    /manifest\.url 必须是 https/,
  );
  assertProblem(
    check((s) => (s.bundle.sources.url = s.bundle.sources.url.replace(commit, 'main'))),
    /sources\.url 要按 40 位提交哈希固定/,
  );
  assertProblem(check((s) => (s.bundle.manifest.url = 'not a url')), /manifest\.url 不是合法地址/);
  assertProblem(check((s) => (s.bundle.manifest.sha256 = 'ABC')), /manifest\.sha256 必须是 64 位小写十六进制/);
  assertProblem(check((s) => (s.bundle.manifest.size = 0)), /manifest\.size 必须是 1–16777216 的整数/);
  assertProblem(check((s) => (s.bundle.sources.size = 1024 * 1024 + 1)), /sources\.size 必须是 1–1048576 的整数/);
  assertProblem(check((s) => (s.bundle.manifest.name = 'x')), /bundle\.manifest 有不认识的字段 name/);
  assertProblem(check((s) => (s.bundle.zip = [])), /bundle 有不认识的字段 zip/);
  assertProblem(check((s) => delete s.bundle.sources), /bundle\.sources 必须是/);
  assertProblem(check((s) => (s.bundle = [])), /bundle 必须是/);
  // 清单上限跟着 UPLOAD_MAX_BUNDLE_BYTES（调小时）。
  assertProblem(
    seedProblems({ ...seed, bundle }, { targetOrg: spec.target_org_id, hosts, maxManifestBytes: 1000 }),
    /manifest\.size 必须是 1–1000 的整数/,
  );
  // app.json 里的配置一起核对：带 bundle 却没设主机列表。
  const withBundle = { ...seed, revision: 4, bundle };
  const app = variant((copy) => {
    apiEnv(copy).METAVERSE_DEMO_SEED = JSON.stringify(withBundle);
    delete apiEnv(copy).METAVERSE_DEMO_SEED_HOSTS;
  });
  assertProblem(checkApp(app, { seed: JSON.stringify(withBundle) }), /必须设 METAVERSE_DEMO_SEED_HOSTS/);
  const listed = variant((copy) => {
    apiEnv(copy).METAVERSE_DEMO_SEED = JSON.stringify(withBundle);
    apiEnv(copy).METAVERSE_DEMO_SEED_HOSTS = hosts;
  });
  assert.deepEqual(checkApp(listed, { seed: JSON.stringify(withBundle) }), []);
});

test('种子：主机列表的写法同接口服务（主机名只许 443，.后缀匹配子域名，主机:端口只匹配那个端口）', () => {
  const { entries, bad } = parseSeedHosts(
    ' raw.githubusercontent.com, .GitHubUserContent.com,127.0.0.1:9000 ,, x/y, *.a.com, .com, .a.com:443',
  );
  assert.deepEqual(bad, ['x/y', '*.a.com', '.com', '.a.com:443']);
  for (const [text, ok] of [
    ['https://raw.githubusercontent.com/o/r/x', true],
    ['https://raw.githubusercontent.com:8443/x', false],
    ['https://objects.githubusercontent.com/x', true],
    ['https://githubusercontent.com/x', false],
    ['http://127.0.0.1:9000/x', true],
    ['http://127.0.0.1:9001/x', false],
    ['http://raw.githubusercontent.com/x', false],
    ['https://u:p@raw.githubusercontent.com/x', false],
    ['https://raw.githubusercontent.com/x#y', false],
  ]) {
    assert.equal(seedUrlAllowed(new URL(text), entries), ok, text);
  }
});

test('种子：有种子时 METAVERSE_DEMO_SEED_HOSTS 必须显式写出（不带包也一样）', () => {
  // 仓库里的种子（第 4 版）带包；去掉包的种子只保证空间存在，主机列表照样要写。
  for (const current of [seed, (({ bundle, ...plain }) => plain)(seed)]) {
    const text = JSON.stringify(current, null, 2);
    const withSeed = (edit) =>
      variant((copy) => {
        apiEnv(copy).METAVERSE_DEMO_SEED = JSON.stringify(current);
        edit(copy);
      });
    assert.deepEqual(checkApp(withSeed(() => {}), { seed: text }), []);
    const missing = withSeed((copy) => delete apiEnv(copy).METAVERSE_DEMO_SEED_HOSTS);
    assertProblem(checkApp(missing, { seed: text }), /有种子时必须显式写出 METAVERSE_DEMO_SEED_HOSTS/);
    const empty = withSeed((copy) => (apiEnv(copy).METAVERSE_DEMO_SEED_HOSTS = ' , '));
    assertProblem(checkApp(empty, { seed: text }), /METAVERSE_DEMO_SEED_HOSTS 是空的/);
    const bad = withSeed((copy) => (apiEnv(copy).METAVERSE_DEMO_SEED_HOSTS = 'https://github.com/'));
    assertProblem(checkApp(bad, { seed: text }), /不是合法的主机/);
  }
  // 两处都不用种子时不要求。
  const noSeed = variant((copy) => {
    delete apiEnv(copy).METAVERSE_DEMO_SEED;
    delete apiEnv(copy).METAVERSE_DEMO_SEED_HOSTS;
  });
  assert.deepEqual(checkApp(noSeed, { seed: null }), []);
});

test('种子：凭链接查看要声明分享令牌密钥，令牌不能写进 env，README 要写明 set_app_secrets', () => {
  const noSecret = variant((copy) => delete copy.services[API_SERVICE].secret_keys);
  assertProblem(checkApp(noSecret, { seed: seedText }), /secret_keys 里要有 METAVERSE_DEMO_SHARE_TOKEN/);

  const leaked = variant((copy) => (apiEnv(copy).METAVERSE_DEMO_SHARE_TOKEN = 'x'.repeat(43)));
  assertProblem(checkApp(leaked, { seed: seedText }), /是密钥，不能写进 env/);

  // 公开空间不需要令牌。
  const publicSeed = { ...seed, visibility: 'public' };
  const publicApp = variant((copy) => {
    delete copy.services[API_SERVICE].secret_keys;
    apiEnv(copy).METAVERSE_DEMO_SEED = JSON.stringify(publicSeed);
  });
  assert.deepEqual(checkApp(publicApp, { seed: JSON.stringify(publicSeed) }), []);

  const withoutSecretDoc = readme.replaceAll('`METAVERSE_DEMO_SHARE_TOKEN`', '分享令牌');
  assertProblem(checkApp(spec, { readme: withoutSecretDoc }), /没有 metaverse-api 的 `METAVERSE_DEMO_SHARE_TOKEN`/);
  const withoutTool = readme.replaceAll('set_app_secrets', '设置密钥的工具');
  assertProblem(checkApp(spec, { readme: withoutTool }), /README 要写明密钥怎么设置/);
});
