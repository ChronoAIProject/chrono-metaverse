// 固定版本检查（check-pins.mjs）的测试：node --test infra/chrono-cd/*.test.mjs
// 先确认仓库里的工作流、Dockerfile 和构建后端通过检查，再逐条改坏，确认每条规则都能报出来。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { checkPins, dockerfileProblems, requirementsProblems, workflowProblems } from './check-pins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const ci = read('.github/workflows/ci.yml');
const images = read('.github/workflows/images.yml');
const workerDockerfile = read('infra/worker/Dockerfile');
const buildRequirements = read('infra/worker/build-requirements.txt');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function assertProblem(problems, pattern) {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `应当报出 ${pattern}，实际：\n${problems.join('\n') || '（没有问题）'}`,
  );
}

test('仓库里的工作流、Dockerfile 和构建后端通过检查', () => {
  assert.deepEqual(checkPins(root), []);
});

test('工作流：action 必须固定到 40 位提交哈希并注明版本', () => {
  for (const ref of ['actions/checkout@v5', 'dtolnay/rust-toolchain@master', 'docker/login-action@v3.7.0', 'actions/checkout@0123456']) {
    const problems = workflowProblems(`steps:\n      - uses: ${ref}\n`, 'w.yml');
    assertProblem(problems, new RegExp(`w\\.yml:2：${ref.replace(/[.@/]/g, '\\$&')} 要固定到 40 位提交哈希`));
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
  assert.notEqual(withCache, images, 'images.yml 里应当有 no-cache: true');
  const problems = workflowProblems(withCache, 'images.yml', { publishesImages: true });
  assertProblem(problems, /发布镜像不能读写 Actions 缓存（cache-from: type=gha/);
  assertProblem(problems, /发布镜像不能读写 Actions 缓存（cache-to: type=gha/);
  // 不发布镜像的工作流可以用缓存（CI 的构建缓存不进发布镜像）。
  assert.deepEqual(workflowProblems('          cache-from: type=gha\n', 'ci.yml'), []);
  // 仓库里某个 action 换回标签，checkPins 也能报出来。
  const dir = mkdtempSync(join(tmpdir(), 'check-pins-'));
  try {
    cpSync(join(root, '.github', 'workflows'), join(dir, '.github', 'workflows'), { recursive: true });
    for (const service of ['api', 'web', 'worker']) {
      cpSync(join(root, 'infra', service), join(dir, 'infra', service), { recursive: true });
    }
    writeFileSync(join(dir, '.github', 'workflows', 'images.yml'), withCache.replace(/docker\/login-action@[0-9a-f]{40} # \S+/, 'docker/login-action@v3'));
    const found = checkPins(dir);
    assertProblem(found, /images\.yml:\d+：docker\/login-action@v3 要固定/);
    assertProblem(found, /images\.yml:\d+：发布镜像不能读写 Actions 缓存/);
    rmSync(join(dir, 'infra', 'worker', 'build-requirements.txt'));
    assertProblem(checkPins(dir), /缺少 infra\/worker\/build-requirements\.txt/);
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

test('Dockerfile：uv pip install 要按哈希装，或者不解析依赖、不用构建隔离（heredoc 里也查）', () => {
  assert.deepEqual(dockerfileProblems(workerDockerfile, 'worker'), []);
  const heredoc = (body, tail = '') => `FROM a@${DIGEST}\nRUN <<'INSTALL'\nset -eu\n${body}\nINSTALL\n${tail}`;
  // heredoc 结束后的 FROM 照常检查，heredoc 里的文字不当指令。
  assertProblem(dockerfileProblems(heredoc('true', 'FROM unpinned\n'), 'D'), /D:6：基础镜像 unpinned 要按摘要固定/);
  assert.ok(!dockerfileProblems(`FROM a@${DIGEST}\nRUN <<'X'\nFROM looks-like-an-instruction\nX\n`, 'D').length);

  for (const command of [
    'uv pip install --python /opt/venv/bin/python -r /tmp/requirements.txt',
    'uv pip install --python /opt/venv/bin/python --no-deps .',
    'uv pip install --python /opt/venv/bin/python .',
    'uv pip install --no-build-isolation .',
  ]) {
    assertProblem(dockerfileProblems(heredoc(command), 'D'), /D:4：uv pip install 要么按哈希装/);
  }
  assert.deepEqual(dockerfileProblems(heredoc('uv pip install --require-hashes -r /tmp/r.txt'), 'D'), []);
  assert.deepEqual(dockerfileProblems(heredoc('uv pip install --no-deps --no-build-isolation .'), 'D'), []);
  // 不在 heredoc 里的 RUN 同样检查。
  assertProblem(dockerfileProblems(`FROM a@${DIGEST}\nRUN uv pip install \\\n  numpy\n`, 'D'), /D:2：uv pip install 要么按哈希装/);

  // 仓库里的 worker Dockerfile 退回构建隔离（会从 PyPI 拉最新的 setuptools）时报错。
  const reverted = workerDockerfile.replace('--no-deps --no-build-isolation .', '--no-deps .');
  assert.notEqual(reverted, workerDockerfile);
  assertProblem(dockerfileProblems(reverted, 'worker'), /uv pip install 要么按哈希装/);
});

test('构建后端：每一项都是 名字==版本 并带 sha256 哈希', () => {
  assert.deepEqual(requirementsProblems(buildRequirements, 'b.txt'), []);
  assertProblem(requirementsProblems('setuptools>=75\n', 'b.txt'), /b\.txt:1：setuptools>=75 要写成 名字==确切版本/);
  assertProblem(requirementsProblems('setuptools>=75\n', 'b.txt'), /要带 --hash=sha256/);
  assertProblem(requirementsProblems('setuptools==84.2.1\n', 'b.txt'), /setuptools==84\.2\.1 要带 --hash=sha256/);
  assertProblem(
    requirementsProblems('# 说明\n\nsetuptools==84.2.1 \\\n    --hash=sha256:abc\n', 'b.txt'),
    /b\.txt:3：setuptools==84\.2\.1 要带 --hash/,
  );
  assertProblem(requirementsProblems('# 只有注释\n', 'b.txt'), /没有任何依赖/);
  assert.deepEqual(requirementsProblems(`wheel==0.45.1 --hash=${DIGEST}\n`, 'b.txt'), []);
  // 仓库里的文件删掉哈希后报错。
  const unhashed = buildRequirements.replace(/ \\\n\s+--hash=sha256:[0-9a-f]{64}/g, '');
  assertProblem(requirementsProblems(unhashed, 'b.txt'), /要带 --hash=sha256/);
});

test('命令行：通过时退出码 0，发现问题时退出码 1，读不到时退出码 2', () => {
  const script = join(here, 'check-pins.mjs');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /固定版本检查通过/);

  const dir = mkdtempSync(join(tmpdir(), 'check-pins-'));
  try {
    cpSync(join(root, '.github', 'workflows'), join(dir, '.github', 'workflows'), { recursive: true });
    cpSync(join(root, 'infra', 'worker'), join(dir, 'infra', 'worker'), { recursive: true });
    writeFileSync(join(dir, 'infra', 'worker', 'Dockerfile'), workerDockerfile.replace(/python:3\.13\.18-slim-trixie@sha256:[0-9a-f]{64} AS runtime/, 'python:3.13.18-slim-trixie AS runtime'));
    const failed = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /发现 1 个问题/);
    assert.match(failed.stderr, /基础镜像 python:3\.13\.18-slim-trixie 要按摘要固定/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const missing = spawnSync(process.execPath, [script, join(here, 'no-such-root')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /读取失败/);
});
