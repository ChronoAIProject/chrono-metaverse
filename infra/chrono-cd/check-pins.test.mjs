// 固定版本检查（check-pins.mjs）的测试：node --test infra/chrono-cd/*.test.mjs
// 先确认仓库里的工作流和 Dockerfile 通过检查，再逐条改坏，确认每条规则都能报出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { checkPins, dockerfileProblems, workflowProblems } from './check-pins.mjs';

/** 把任意文字转成正则里按原样匹配的写法（反斜杠也转义）。 */
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/@-]/g, '\\$&');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const ci = read('.github/workflows/ci.yml');
const images = read('.github/workflows/publish.yml');
const apiDockerfile = read('infra/api/Dockerfile');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function assertProblem(problems, pattern) {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `应当报出 ${pattern}，实际：\n${problems.join('\n') || '（没有问题）'}`,
  );
}

test('仓库里的工作流和 Dockerfile 通过检查', () => {
  assert.deepEqual(checkPins(root), []);
});

test('工作流：action 必须固定到 40 位提交哈希并注明版本', () => {
  for (const ref of ['actions/checkout@v5', 'dtolnay/rust-toolchain@master', 'docker/login-action@v3.7.0', 'actions/checkout@0123456']) {
    const problems = workflowProblems(`steps:\n      - uses: ${ref}\n`, 'w.yml');
    assertProblem(problems, new RegExp(`w\\.yml:2：${escapeRegExp(ref)} 要固定到 40 位提交哈希`));
  }
  // 带引号、在 with 之前的写法同样检查。
  assertProblem(workflowProblems(`      - name: x\n        uses: "astral-sh/setup-uv@v6"\n`, 'w.yml'), /w\.yml:2：astral-sh\/setup-uv@v6 要固定/);
  // 哈希对了但没写版本注释。
  assertProblem(workflowProblems(`      - uses: actions/checkout@${SHA}\n`, 'w.yml'), /注释里要写对应的版本/);
  // 本地 action 不管；docker:// 要按摘要。
  assert.deepEqual(workflowProblems('      - uses: ./.github/actions/local\n', 'w.yml'), []);
  assertProblem(workflowProblems('      - uses: docker://alpine:3.22\n', 'w.yml'), /docker:\/\/alpine:3\.22 要按摘要固定/);
  assert.deepEqual(workflowProblems(`      - uses: docker://alpine:3.22@${DIGEST}\n`, 'w.yml'), []);
  assert.deepEqual(workflowProblems(`      - uses: actions/checkout@${SHA} # v5.1.0\n`, 'w.yml'), []);
});

test('工作流：install-action 的工具要写明版本', () => {
  assertProblem(workflowProblems('          tool: cargo-deny\n', 'w.yml'), /工具 cargo-deny 要写明版本/);
  assertProblem(workflowProblems('          tool: cargo-deny@0.20.2, cargo-nextest\n', 'w.yml'), /工具 cargo-nextest 要写明版本/);
  assert.deepEqual(workflowProblems('          tool: cargo-deny@0.20.2\n', 'w.yml'), []);
  // 仓库里的 ci.yml 去掉版本后会被报出来。
  assertProblem(workflowProblems(ci.replace('cargo-deny@0.20.2', 'cargo-deny'), 'ci.yml'), /工具 cargo-deny 要写明版本/);
});

test('工作流：发布镜像不读写 Actions 缓存', () => {
  const withCache = images.replace(
    'no-cache: true',
    'cache-from: type=gha,scope=x\n          cache-to: type=gha,mode=max,scope=x',
  );
  assert.notEqual(withCache, images, 'publish.yml 里应当有 no-cache: true');
  const problems = workflowProblems(withCache, 'publish.yml', { publishesImages: true });
  assertProblem(problems, /发布镜像不能读写 Actions 缓存（cache-from: type=gha/);
  assertProblem(problems, /发布镜像不能读写 Actions 缓存（cache-to: type=gha/);
  // 不发布镜像的工作流可以用缓存（CI 的构建缓存不进发布镜像）。
  assert.deepEqual(workflowProblems('          cache-from: type=gha\n', 'ci.yml'), []);
  // 仓库里某个 action 换回标签，checkPins 也能报出来。
  const dir = mkdtempSync(join(tmpdir(), 'check-pins-'));
  try {
    cpSync(join(root, '.github', 'workflows'), join(dir, '.github', 'workflows'), { recursive: true });
    for (const service of ['api', 'web']) {
      cpSync(join(root, 'infra', service), join(dir, 'infra', service), { recursive: true });
    }
    writeFileSync(join(dir, '.github', 'workflows', 'publish.yml'), withCache.replace(/docker\/login-action@[0-9a-f]{40} # \S+/, 'docker/login-action@v3'));
    const found = checkPins(dir);
    assertProblem(found, /publish\.yml:\d+：docker\/login-action@v3 要固定/);
    assertProblem(found, /publish\.yml:\d+：发布镜像不能读写 Actions 缓存/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Dockerfile：构建前端、基础镜像和外部 COPY --from 都按摘要固定', () => {
  const pinned = `# syntax=docker/dockerfile:1@${DIGEST}\nFROM rust:1.97.0-slim@${DIGEST} AS build\nRUN true\nFROM scratch\nCOPY --from=build /a /a\nCOPY --from=0 /b /b\n`;
  assert.deepEqual(dockerfileProblems(pinned, 'D'), []);

  assertProblem(dockerfileProblems('# syntax=docker/dockerfile:1\nFROM scratch\n', 'D'), /D:1：构建前端 docker\/dockerfile:1 要按摘要固定/);
  assertProblem(dockerfileProblems('FROM python:3.13-slim AS build\n', 'D'), /D:1：基础镜像 python:3\.13-slim 要按摘要固定/);
  assertProblem(dockerfileProblems('FROM --platform=linux/amd64 node:22\n', 'D'), /基础镜像 node:22 要按摘要固定/);
  assertProblem(
    dockerfileProblems(`FROM a@${DIGEST} AS build\nCOPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uv\n`, 'D'),
    /D:2：ghcr\.io\/astral-sh\/uv:0\.11\.32 要按摘要固定/,
  );
  assertProblem(
    dockerfileProblems(`FROM a@${DIGEST}\nRUN --mount=type=bind,from=alpine:3,target=/x true\n`, 'D'),
    /D:2：alpine:3 要按摘要固定/,
  );
  // 后面的阶段用前面的阶段名（大小写不敏感）不算外部镜像。
  assert.deepEqual(dockerfileProblems(`FROM a@${DIGEST} AS Base\nFROM base\n`, 'D'), []);
  // 续行接起来再看。
  assertProblem(dockerfileProblems('FROM \\\n  node:22 AS build\n', 'D'), /D:1：基础镜像 node:22 要按摘要固定/);
});

test('Dockerfile：heredoc 里的文字不当指令，heredoc 结束后的指令照常检查', () => {
  assert.deepEqual(dockerfileProblems(apiDockerfile, 'api'), []);
  const heredoc = (body, tail = '') => `FROM a@${DIGEST}\nRUN <<'INSTALL'\nset -eu\n${body}\nINSTALL\n${tail}`;
  assertProblem(dockerfileProblems(heredoc('true', 'FROM unpinned\n'), 'D'), /D:6：基础镜像 unpinned 要按摘要固定/);
  assert.ok(!dockerfileProblems(`FROM a@${DIGEST}\nRUN <<'X'\nFROM looks-like-an-instruction\nX\n`, 'D').length);
});

test('命令行：通过时退出码 0，发现问题时退出码 1，读不到时退出码 2', () => {
  const script = join(here, 'check-pins.mjs');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /固定版本检查通过/);

  const dir = mkdtempSync(join(tmpdir(), 'check-pins-'));
  try {
    cpSync(join(root, '.github', 'workflows'), join(dir, '.github', 'workflows'), { recursive: true });
    cpSync(join(root, 'infra', 'api'), join(dir, 'infra', 'api'), { recursive: true });
    const unpinned = apiDockerfile.replace(/(rust:1\.97\.0-slim-trixie)@sha256:[0-9a-f]{64} AS build/, '$1 AS build');
    assert.notEqual(unpinned, apiDockerfile);
    writeFileSync(join(dir, 'infra', 'api', 'Dockerfile'), unpinned);
    const failed = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /发现 1 个问题/);
    assert.match(failed.stderr, /基础镜像 rust:1\.97\.0-slim-trixie 要按摘要固定/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const missing = spawnSync(process.execPath, [script, join(here, 'no-such-root')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /读取失败/);
});
