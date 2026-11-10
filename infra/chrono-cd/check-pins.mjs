#!/usr/bin/env node
// 构建发布镜像所用的外部输入都要固定到不可改写的引用（持续集成里运行）：
//
//   node infra/chrono-cd/check-pins.mjs [仓库根目录]
//
// - 工作流（.github/workflows/*.yml）：第三方 action 固定到 40 位提交哈希，并在注释里写版本
//   （`uses: owner/repo@<哈希> # v1.2.3`）。标签和分支（`@v2`、`@master`）可以被上游改写，上游
//   被入侵时恶意代码会跑在拿着 packages: write 令牌或能写 Actions 缓存的任务里。
//   `docker://` 镜像按摘要固定；install-action 的 `tool:` 写明版本。
// - 发布镜像的工作流（images.yml）不读写 Actions 缓存：缓存按仓库和分支共用、不分工作流，同一分支
//   上任何 CI 任务里的 action 都能写进构建层。
// - Dockerfile（infra/*/Dockerfile）：`# syntax=` 构建前端、`FROM` 和 `COPY --from=` 的外部镜像都按
//   摘要固定（`镜像:标签@sha256:<64 位>`，标签只作记号）。
//
// 处理服务的镜像下线后，它那两条规则（构建后端按版本和哈希固定、`uv pip install` 不从 PyPI 拉没固定的包）
// 一起删掉了：剩下的两个镜像（接口服务、网站）都不装 Python 包。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** 工作流里的问题。`name` 是报告里用的文件名；`publishesImages` 表示这是推发布镜像的工作流。 */
export function workflowProblems(text, name, { publishesImages = false } = {}) {
  const problems = [];
  text.split('\n').forEach((line, index) => {
    const at = `${name}:${index + 1}`;
    const uses = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/.exec(line);
    if (uses) {
      const ref = uses[2];
      const comment = (uses[3] ?? '').replace(/^#\s*/, '').trim();
      if (ref.startsWith('./')) return;
      if (ref.startsWith('docker://')) {
        if (!DIGEST.test(ref)) problems.push(`${at}：${ref} 要按摘要固定（docker://镜像@sha256:<64 位>）`);
        return;
      }
      const [path, version = ''] = ref.split('@');
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(path) || !SHA.test(version)) {
        problems.push(
          `${at}：${ref} 要固定到 40 位提交哈希（标签和分支可以被上游改写），` +
            `写成 ${path}@<提交哈希> # <版本>`,
        );
      } else if (comment === '') {
        problems.push(`${at}：${ref} 的注释里要写对应的版本（例如 # v1.2.3），方便核对和更新`);
      }
      return;
    }
    const tool = /^\s*tool:\s*(['"]?)([^'"#]+)\1\s*(#.*)?$/.exec(line);
    if (tool) {
      for (const item of tool[2].split(',').map((value) => value.trim()).filter(Boolean)) {
        if (!/@\d/.test(item)) problems.push(`${at}：工具 ${item} 要写明版本（${item}@<版本>）`);
      }
    }
    if (publishesImages && /^\s*cache-(from|to):/.test(line)) {
      problems.push(
        `${at}：发布镜像不能读写 Actions 缓存（${line.trim()}）。缓存按分支共用、不分工作流，` +
          `同一分支上任何 CI 任务里的 action 都能写进构建层`,
      );
    }
  });
  return problems;
}

/** Dockerfile 的逻辑指令（接上续行），带起始行号；heredoc 的内容（`RUN <<'X'` 里的 shell 命令）跳过。 */
function dockerfileLines(text) {
  const lines = text.split('\n');
  const result = [];
  let heredoc = null;
  let current = null;
  lines.forEach((line, index) => {
    if (heredoc !== null && current === null && line.trim() === heredoc) {
      heredoc = null;
      return;
    }
    if (heredoc !== null) return;
    if (current === null) current = { line: index + 1, text: '' };
    const continued = /\\\s*$/.test(line);
    current.text += `${continued ? line.replace(/\\\s*$/, '') : line} `;
    if (!continued) {
      if (heredoc === null) {
        const marker = /<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(current.text);
        if (marker && !/^\s*#/.test(current.text)) heredoc = marker[2];
      }
      result.push({ line: current.line, text: current.text.trim() });
      current = null;
    }
  });
  return result;
}

/** Dockerfile 里的问题。 */
export function dockerfileProblems(text, name) {
  const problems = [];
  const stages = new Set();
  const external = (ref) => ref !== 'scratch' && !stages.has(ref.toLowerCase()) && !/^\d+$/.test(ref);
  const syntax = /^#\s*syntax\s*=\s*(\S+)/.exec(text.split('\n')[0] ?? '');
  if (syntax && !DIGEST.test(syntax[1])) {
    problems.push(`${name}:1：构建前端 ${syntax[1]} 要按摘要固定（构建时它在 BuildKit 里执行）`);
  }
  for (const { line, text: instruction } of dockerfileLines(text)) {
    const at = `${name}:${line}`;
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(instruction);
    if (from) {
      if (external(from[1]) && !DIGEST.test(from[1])) {
        problems.push(`${at}：基础镜像 ${from[1]} 要按摘要固定（镜像:标签@sha256:<64 位>）`);
      }
      if (from[2]) stages.add(from[2].toLowerCase());
      continue;
    }
    // `COPY --from=镜像` 和 `RUN --mount=...,from=镜像`。
    for (const match of instruction.matchAll(/(?:--|,)from=([^\s,]+)/gi)) {
      if (external(match[1]) && !DIGEST.test(match[1])) {
        problems.push(`${at}：${match[1]} 要按摘要固定（镜像:标签@sha256:<64 位>）`);
      }
    }
  }
  return problems;
}

/** 检查仓库里的工作流和 Dockerfile，返回问题列表。 */
export function checkPins(root) {
  const problems = [];
  const workflows = join(root, '.github', 'workflows');
  for (const file of readdirSync(workflows).filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
    const name = `.github/workflows/${file}`;
    problems.push(
      ...workflowProblems(readFileSync(join(workflows, file), 'utf8'), name, { publishesImages: file === 'images.yml' }),
    );
  }
  const infra = join(root, 'infra');
  for (const service of readdirSync(infra).sort()) {
    const path = join(infra, service, 'Dockerfile');
    if (existsSync(path)) problems.push(...dockerfileProblems(readFileSync(path, 'utf8'), `infra/${service}/Dockerfile`));
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let problems;
  try {
    problems = checkPins(root);
  } catch (error) {
    console.error(`读取失败：${error.message}`);
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error(`固定版本检查发现 ${problems.length} 个问题：`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('固定版本检查通过');
}
