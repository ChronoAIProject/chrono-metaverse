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
  WORKER_SERVICE,
  checkApp,
  checkRepository,
  parseCpu,
  parseMemoryMiB,
  parsePositiveInt,
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
const workerEnv = (copy) => copy.services[WORKER_SERVICE].env;

function problemsOf(edited, options = {}) {
  return checkApp(edited, options);
}

function assertProblem(problems, pattern) {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `应当报出 ${pattern}，实际：\n${problems.join('\n') || '（没有问题）'}`,
  );
}

test('仓库里的 app.json、README、up.sh 通过检查', () => {
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
    writeFileSync(path, JSON.stringify(variant((copy) => delete workerEnv(copy).OPENBLAS_NUM_THREADS)));
    const failed = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /发现 \d+ 个问题/);
    assert.match(failed.stderr, /缺少 OPENBLAS_NUM_THREADS/);
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

test('处理服务：缺少线程变量时报错', () => {
  for (const name of ['OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS']) {
    const problems = problemsOf(variant((copy) => delete workerEnv(copy)[name]));
    assertProblem(problems, new RegExp(`缺少 ${name}.*RLIMIT_AS`));
  }
  const problems = problemsOf(variant((copy) => delete workerEnv(copy).MALLOC_ARENA_MAX));
  assertProblem(problems, /缺少 MALLOC_ARENA_MAX/);
});

test('处理服务：线程数不是正整数或超过 cpu_limit 时报错', () => {
  assertProblem(
    problemsOf(variant((copy) => (workerEnv(copy).OPENBLAS_NUM_THREADS = '0'))),
    /OPENBLAS_NUM_THREADS 必须是正整数/,
  );
  assertProblem(
    problemsOf(variant((copy) => (workerEnv(copy).OMP_NUM_THREADS = 'auto'))),
    /OMP_NUM_THREADS 必须是正整数/,
  );
  assertProblem(
    problemsOf(variant((copy) => (workerEnv(copy).OPENBLAS_NUM_THREADS = '8'))),
    /OPENBLAS_NUM_THREADS=8 超过 cpu_limit（2 核）/,
  );
  assertProblem(
    problemsOf(variant((copy) => (workerEnv(copy).MALLOC_ARENA_MAX = '-1'))),
    /MALLOC_ARENA_MAX 必须是正整数/,
  );
});

test('处理服务：cpu_limit 按向上取整算核数，不足 1 核按 1 核', () => {
  const at = (cpu, threads) =>
    problemsOf(
      variant((copy) => {
        copy.services[WORKER_SERVICE].resources.cpu_limit = cpu;
        workerEnv(copy).OPENBLAS_NUM_THREADS = threads;
        workerEnv(copy).OMP_NUM_THREADS = threads;
      }),
    );
  assert.deepEqual(at('1500m', '2'), []);
  assert.deepEqual(at('500m', '1'), []);
  assertProblem(at('500m', '2'), /超过 cpu_limit（1 核）/);
  assertProblem(at('two', '2'), /cpu_limit 不合法/);
});

test('处理服务：子进程内存上限不小于容器上限时报错', () => {
  assertProblem(
    problemsOf(variant((copy) => (workerEnv(copy).WORKER_JOB_MEMORY_MB = '8192'))),
    /WORKER_JOB_MEMORY_MB=8192 不小于容器内存上限（8192MiB）/,
  );
  assertProblem(
    problemsOf(variant((copy) => (workerEnv(copy).WORKER_JOB_MEMORY_MB = '6GB'))),
    /WORKER_JOB_MEMORY_MB 必须是正整数/,
  );
  assertProblem(
    problemsOf(variant((copy) => (copy.services[WORKER_SERVICE].resources.memory_limit = 'lots'))),
    /memory_limit 不合法/,
  );
  assert.deepEqual(problemsOf(variant((copy) => (workerEnv(copy).WORKER_JOB_MEMORY_MB = '8191'))), []);
});

test('接口服务：没有可信地址头时，限流额度必须显式设置并高于按单个访客的默认值', () => {
  const missing = problemsOf(variant((copy) => delete apiEnv(copy).PUBLIC_RATE_LIMIT_PER_MINUTE));
  assertProblem(missing, /必须显式设置 PUBLIC_RATE_LIMIT_PER_MINUTE/);

  const atDefault = problemsOf(variant((copy) => (apiEnv(copy).PUBLIC_BLOB_RATE_LIMIT_BURST = '2000')));
  assertProblem(atDefault, /PUBLIC_BLOB_RATE_LIMIT_BURST=2000 没有高于按单个访客设计的默认值 2000/);

  const invalid = problemsOf(variant((copy) => (apiEnv(copy).PUBLIC_RATE_LIMIT_BURST = '0')));
  assertProblem(invalid, /PUBLIC_RATE_LIMIT_BURST 必须是 1 到 4294967295 的整数.*启动失败/);

  const tooLarge = problemsOf(variant((copy) => (apiEnv(copy).PUBLIC_RATE_LIMIT_PER_MINUTE = '4294967296')));
  assertProblem(tooLarge, /PUBLIC_RATE_LIMIT_PER_MINUTE 必须是 1 到 4294967295 的整数/);
});

test('接口服务：设了平台确认的单值头后，限流额度可以回到默认值', () => {
  const confirmed = variant((copy) => {
    const env = apiEnv(copy);
    env.TRUSTED_CLIENT_IP_HEADER = 'CF-Connecting-IP';
    for (const name of Object.keys(env).filter((key) => key.startsWith('PUBLIC_'))) delete env[name];
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

  const withoutThreads = readme.replaceAll('`OPENBLAS_NUM_THREADS`', 'OPENBLAS 线程数');
  assertProblem(problemsOf(spec, { readme: withoutThreads }), /没有 metaverse-worker 的 `OPENBLAS_NUM_THREADS`/);

  const withoutAddon = readme.replaceAll('`MONGODB_DATABASE`', '库名');
  assertProblem(problemsOf(spec, { readme: withoutAddon }), /没有 metaverse-api 的 `MONGODB_DATABASE`/);

  const withoutPending = readme.replaceAll('`TRUSTED_CLIENT_IP_HEADER`', '可信头');
  assertProblem(problemsOf(spec, { readme: withoutPending }), /要写明 `TRUSTED_CLIENT_IP_HEADER` 还没设置/);
});

test('up.sh 必须给处理服务设同样的线程变量', () => {
  const stripped = upScript
    .split('\n')
    .filter((line) => !/^\s*(OPENBLAS_NUM_THREADS|MALLOC_ARENA_MAX)=/.test(line))
    .join('\n');
  const problems = problemsOf(spec, { upScript: stripped });
  assertProblem(problems, /up\.sh 没有给处理服务设 OPENBLAS_NUM_THREADS/);
  assertProblem(problems, /up\.sh 没有给处理服务设 MALLOC_ARENA_MAX/);
  assert.ok(!problems.some((problem) => problem.includes('OMP_NUM_THREADS')), '没删的不报');
});

test('缺服务或没有 services 时报错', () => {
  assert.deepEqual(checkApp(null), ['app.json 没有 services']);
  assert.deepEqual(checkApp({}), ['app.json 没有 services']);
  const problems = checkApp(variant((copy) => delete copy.services[WORKER_SERVICE]));
  assertProblem(problems, /缺少服务 metaverse-worker/);
  assertProblem(checkApp(variant((copy) => delete copy.services[API_SERVICE])), /缺少服务 metaverse-api/);
});
