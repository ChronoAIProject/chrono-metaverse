// 本地部署配置种子小工具的测试：node --test infra/dev/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SeedFileError, compactSeed, newShareToken, readSeed } from './demo-seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'demo-seed.mjs');
const production = join(here, '..', 'chrono-cd', 'demo-seed.json');

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('线上种子压缩成一行，内容不变', () => {
  const seed = readSeed(production);
  const line = compactSeed(seed);
  assert.ok(!line.includes('\n'));
  assert.deepEqual(JSON.parse(line), seed);
  const cli = run('compact', production);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, `${line}\n`);
  // 与 app.json 里接口服务的 METAVERSE_DEMO_SEED 完全相同（check-app.mjs 也查这一点）。
  const app = JSON.parse(readFileSync(join(here, '..', 'chrono-cd', 'app.json'), 'utf8'));
  assert.equal(app.services['metaverse-api'].env.METAVERSE_DEMO_SEED, line);
});

test('--owner 只换主人编号', () => {
  const seed = readSeed(production);
  const local = JSON.parse(compactSeed(seed, { owner: 'chronoai' }));
  assert.deepEqual(local.owner, { kind: 'org', id: 'chronoai' });
  assert.deepEqual({ ...local, owner: seed.owner }, seed);
  const cli = run('compact', production, '--owner', 'chronoai');
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).owner.id, 'chronoai');
  assert.throws(() => compactSeed(seed, { owner: 'chronoai/../x' }), SeedFileError);
});

test('旧格式（处理服务时代的 files、hints、authored……）直接报错', () => {
  const seed = readSeed(production);
  for (const key of ['files', 'rebuild', 'voxelize', 'hints', 'authored', 'observedAt']) {
    assert.throws(() => compactSeed({ ...seed, [key]: [] }), (error) => {
      assert.ok(error instanceof SeedFileError);
      assert.match(error.message, new RegExp(`旧格式（${key}）.*改成 bundle`));
      return true;
    });
  }
  const dir = mkdtempSync(join(tmpdir(), 'demo-seed-'));
  try {
    const old = join(dir, 'old.json');
    writeFileSync(old, JSON.stringify({ ...seed, files: [], hints: {} }));
    const cli = run('compact', old);
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /旧格式（files、hints）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('分享令牌：256 位随机数的 base64url，每次不同', () => {
  const a = newShareToken();
  const b = run('token').stdout.trim();
  for (const token of [a, b]) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('空间编号和出错时的退出码', () => {
  assert.equal(run('space-id', production).stdout.trim(), 'chronoai-lobby');
  const dir = mkdtempSync(join(tmpdir(), 'demo-seed-'));
  try {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{"spaceId": ');
    const bad = run('compact', broken);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /读不成种子配置/);
    const list = join(dir, 'list.json');
    writeFileSync(list, '[1, 2]');
    assert.match(run('compact', list).stderr, /必须是 JSON 对象/);
    const noId = join(dir, 'no-id.json');
    writeFileSync(noId, '{}');
    assert.equal(run('space-id', noId).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const usage = run('compact');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /用法/);
});

test('up.sh 把种子和分享令牌交给接口服务，令牌存在 .run 里复用', () => {
  const up = readFileSync(join(here, 'up.sh'), 'utf8');
  assert.match(up, /--demo-seed\) seed_file="\$repo\/infra\/chrono-cd\/demo-seed\.json"/);
  assert.match(up, /METAVERSE_DEMO_SEED="\$seed_json"/);
  assert.match(up, /METAVERSE_DEMO_SHARE_TOKEN="\$seed_token"/);
  assert.match(up, /umask 077/);
  assert.match(up, /\$run\/demo-share-token/);
  const help = spawnSync('bash', [join(here, 'up.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--demo-seed/);
  assert.ok(!help.stdout.includes('set -euo'), '帮助只打印注释');
  const unknown = spawnSync('bash', [join(here, 'up.sh'), '--bogus'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /--demo-seed/);
});
