// pin-images.mjs 的测试：node --test infra/chrono-cd/*.test.mjs
// 生成的规格和补丁只用按摘要固定的镜像；参数不合法时一律拒绝，不输出半成品。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { checkApp } from './check-app.mjs';
import { UsageError, imagePatch, parseArgs, pinSpec, pinnedImage, run } from './pin-images.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'pin-images.mjs');
const spec = JSON.parse(readFileSync(join(here, 'app.json'), 'utf8'));

const API = `sha256:${'1'.repeat(64)}`;
const WEB = `sha256:${'2'.repeat(64)}`;
const WORKER = `sha256:${'3'.repeat(64)}`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ALL = [`api=${API}`, `web=${WEB}`, `worker=${WORKER}`];

test('整份规格：三个服务换成"仓库:7 位提交哈希@摘要"，其余内容原样保留并通过检查', () => {
  const output = run([COMMIT, ...ALL]);
  const pinned = JSON.parse(output);
  assert.equal(pinned.services['metaverse-api'].image, `ghcr.io/chronoaiproject/chrono-metaverse-api:0123456@${API}`);
  assert.equal(pinned.services['metaverse-web'].image, `ghcr.io/chronoaiproject/chrono-metaverse-web:0123456@${WEB}`);
  assert.equal(
    pinned.services['metaverse-worker'].image,
    `ghcr.io/chronoaiproject/chrono-metaverse-worker:0123456@${WORKER}`,
  );
  // 除镜像以外和 app.json 完全一样。
  for (const service of Object.values(pinned.services)) delete service.image;
  const original = structuredClone(spec);
  for (const service of Object.values(original.services)) delete service.image;
  assert.deepEqual(pinned, original);
  // 原规格没有被改动。
  assert.match(spec.services['metaverse-api'].image, /@sha256:/);
  assert.notEqual(spec.services['metaverse-api'].image, `ghcr.io/chronoaiproject/chrono-metaverse-api:0123456@${API}`);
});

test('补丁：只含镜像，可以只换一部分服务', () => {
  assert.equal(
    run(['--patch', 'abc1234', `worker=${WORKER}`]),
    `${JSON.stringify({
      services: { 'metaverse-worker': { image: `ghcr.io/chronoaiproject/chrono-metaverse-worker:abc1234@${WORKER}` } },
    })}\n`,
  );
  const patch = imagePatch('abc1234', { 'metaverse-api': API, 'metaverse-web': WEB });
  assert.deepEqual(Object.keys(patch.services).sort(), ['metaverse-api', 'metaverse-web']);
  // 补丁合并进规格后通过检查（镜像都按摘要固定）。
  const merged = structuredClone(spec);
  for (const [name, value] of Object.entries(patch.services)) merged.services[name].image = value.image;
  assert.deepEqual(checkApp(merged), []);
});

test('参数不合法时拒绝', () => {
  const rejects = (argv, pattern) => assert.throws(() => parseArgs(argv), (error) => error instanceof UsageError && pattern.test(error.message));
  rejects([], /第一个参数要是提交哈希/);
  rejects(['main', ...ALL], /第一个参数要是提交哈希/);
  rejects(['ABC1234', ...ALL], /第一个参数要是提交哈希/);
  rejects(['abc123', ...ALL], /第一个参数要是提交哈希/);
  rejects(['abc1234'], /至少要给一个服务的摘要/);
  rejects(['abc1234', `db=${API}`], /不认识的服务 "db"/);
  rejects(['abc1234', `api=${API}`, `api=${API}`, `web=${WEB}`, `worker=${WORKER}`], /api 写了两次/);
  rejects(['abc1234', 'api=main', `web=${WEB}`, `worker=${WORKER}`], /api 的摘要要是 sha256:/);
  rejects(['abc1234', `api=sha256:${'A'.repeat(64)}`, `web=${WEB}`, `worker=${WORKER}`], /api 的摘要要是/);
  rejects(['abc1234', 'api', `web=${WEB}`, `worker=${WORKER}`], /api 的摘要要是/);
  rejects(['abc1234', `api=${API}`], /要给全三个服务的摘要，缺 web、worker/);
  rejects(['--force', 'abc1234', ...ALL], /不认识的选项 --force/);
  rejects(['abc1234', ...ALL, '--app'], /--app 后面要跟/);

  assert.throws(() => pinnedImage('metaverse-db', 'abc1234', API), /没有对应的镜像仓库/);
  assert.throws(() => pinnedImage('metaverse-api', 'abc1234', 'sha256:short'), /摘要不合法/);
  assert.throws(() => pinSpec({ services: {} }, 'abc1234', { 'metaverse-api': API }), /规格里没有服务 metaverse-api/);
});

test('生成的整份规格没通过检查时不输出', () => {
  const broken = structuredClone(spec);
  delete broken.services['metaverse-worker'].env.OPENBLAS_NUM_THREADS;
  assert.throws(
    () => run(['--app', 'broken.json', 'abc1234', ...ALL], { readSpec: () => JSON.stringify(broken) }),
    (error) => error instanceof UsageError && /没有通过检查[\s\S]*OPENBLAS_NUM_THREADS/.test(error.message),
  );
});

test('命令行：成功时输出 JSON，参数不合法时退出码 1、不输出', () => {
  const ok = spawnSync(process.execPath, [script, '--patch', 'abc1234', `api=${API}`], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).services['metaverse-api'].image, `ghcr.io/chronoaiproject/chrono-metaverse-api:abc1234@${API}`);

  const bad = spawnSync(process.execPath, [script, 'abc1234', 'api=latest'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /api 的摘要要是/);

  const missing = spawnSync(process.execPath, [script, '--app', join(here, 'no-such.json'), 'abc1234', ...ALL], {
    encoding: 'utf8',
  });
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /失败：/);
});
