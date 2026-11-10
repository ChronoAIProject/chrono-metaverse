#!/usr/bin/env node
// 九步端到端验收（docs/BUILD_PLAN.md 第 5.2 节，按 docs/design/server-slim.md 10.4 改成"本地重建 → 命令行上传发布"）：
// 用 up.sh 在本机起全套（真实 MongoDB 副本集、模拟 NyxID、接口服务、网站开发服务器），再按九步依次执行并断言：
//
//   1. 用测试令牌建组织空间（再定义实体区、虚拟区和地块 p1）
//   2. 本地工具产出重建包：metaverse pull → metaverse-recon align → prepare → bundle --algorithm --anchors →
//      metaverse bundle check 通过（不需要服务）
//   3. 带重建权限的身份上传并发布：metaverse bundle push --publish（0.25MiB 一片，等后台核对和包展开），
//      提交的类别是 rebuild；同一个包再推一次得到 unchanged；按哈希复用只在本空间成立
//   4. 公开读接口按 seq 返回快照（重建前后两个版本、资源、没带令牌 404）
//   5. 网站三种视图都能渲染（无头浏览器截图，检查不是空白）
//   6. 时间轴能回到重建前
//   7. 写事件后"现在"模式能拉到（/head 变化、增量事件、页面状态栏）
//   8. 命令行 pull → build → check → push → publish 在地块内完成一次建造
//   9. 越权操作返回 403、404 或 422（含重建路径的权限、上传用途、rb. 编号、预览不给原始扫描和清单、旧接口 410）
//
// 用法：
//   node infra/dev/e2e.mjs [--only 1-9] [--scan <扫描文件>] [--keep]
//
// - 默认跑全部九步；`--only 1,8,9` 只跑不需要扫描的三步。选了某一步就要连同它依赖的步骤一起选（第 3 步要
//   第 2 步打的包，第 4 步要第 3 步的提交，第 6、7 步在第 5 步打开的页面上操作），否则报错；
// - 扫描文件不进版本库：用 --scan 或环境变量 METAVERSE_E2E_SCAN 指定（Scaniverse 式 zip 或 glb，本地工具
//   prepare / bundle 直接读的格式）。前厅扫描约 1 分 45 秒打完包（4 核）；
// - 本地工具用 recon/.venv/bin/metaverse-recon，没有时先 `uv sync --frozen`（要装好 uv）；命令行从
//   sdk/typescript 构建；
// - 重建身份是 rita（模拟 NyxID 按 infra/dev/org-roles.json 给 metaverse:rebuild:write），alice 是没有
//   重建权限的组织 admin；
// - 每次用随机库名和空闲端口，结束时停掉全套（down.sh）并删除这个库；--keep 保留现场排查；
// - 截图、工作区、日志和结果在 infra/dev/.run/e2e-<后缀>/（不进版本库）；
// - 浏览器：METAVERSE_E2E_BROWSER_PATH，没有时用 /opt/pw-browsers/chromium（存在的话），
//   再没有就交给网站依赖里的 Playwright 自己找；
// - 其他环境变量照 up.sh：METAVERSE_MONGODB_URI（副本集地址）等；
//   METAVERSE_E2E_JOB_TIMEOUT 等上传核对和包展开的上限（秒，默认 600）。
//
// 退出码：0 全部通过，1 有步骤失败，2 参数或环境不对（没开始验收）。

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  E2eError,
  check,
  parseOnly,
  decodePng,
  devClient,
  expectStatus,
  formatReport,
  freePort,
  imageStats,
  looksRendered,
  missingSteps,
  parseUpOutput,
  previewToken,
  randomSuffix,
  runSteps,
  waitFor,
} from './e2e-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const run = join(here, '.run');
const SCAN_FORMATS = ['.zip', '.glb'];
const ORG = 'chronoai';
const PLOT = 'p1';
/** 带重建权限的身份（infra/dev/org-roles.json 的 permissions）。 */
const REBUILDER = 'rita';
const REBUILD_PERMISSION = 'metaverse:rebuild:write';
const PART_SIZE = 256 * 1024;

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------

function usage(message, code = 2) {
  if (message) console.error(message);
  console.error('用法：node infra/dev/e2e.mjs [--only 1-9] [--scan <扫描文件（zip/glb）>] [--keep]');
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      scan: { type: 'string' },
      only: { type: 'string', default: '1-9' },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
} catch (error) {
  usage(error.message);
}
if (parsed.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 36).join('\n'));
  process.exit(0);
}

let only;
try {
  only = parseOnly(parsed.only, 9);
} catch (error) {
  usage(error.message);
}
const orphans = missingSteps(only);
if (orphans.length > 0) {
  usage(orphans.map(([step, needs]) => `第 ${step} 步要连同第 ${needs.join('、')} 步一起跑`).join('；'));
}
const scanPath = parsed.scan ?? process.env.METAVERSE_E2E_SCAN;
let scanFile = null;
if (only.has(2)) {
  if (!scanPath) usage('缺少扫描文件：用 --scan <文件> 或环境变量 METAVERSE_E2E_SCAN 指定（前厅扫描不进版本库）');
  scanFile = resolve(scanPath);
  if (!existsSync(scanFile)) usage(`找不到扫描文件 ${scanFile}`);
  if (!SCAN_FORMATS.includes(extname(scanFile).toLowerCase())) {
    usage(`扫描文件必须是 ${SCAN_FORMATS.join('、')}（本地工具直接读的格式）：${scanFile}`);
  }
}
for (const name of ['mongod', 'mock-nyxid', 'api', 'web']) {
  const pidFile = join(run, `${name}.pid`);
  if (!existsSync(pidFile)) continue;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) usage(`本地全套已经在运行（${name}，进程号 ${pid}）。先运行 infra/dev/down.sh，验收脚本要自己起一套`);
}

const jobTimeout = Number(process.env.METAVERSE_E2E_JOB_TIMEOUT ?? '600') * 1000;
const suffix = randomSuffix();
const database = `metaverse_e2e_${suffix}`;
const out = join(run, `e2e-${suffix}`);
mkdirSync(out, { recursive: true });

const ports = {
  MOCK_NYXID_PORT: process.env.MOCK_NYXID_PORT ?? String(await freePort()),
  METAVERSE_API_PORT: process.env.METAVERSE_API_PORT ?? String(await freePort()),
  METAVERSE_WEB_PORT: process.env.METAVERSE_WEB_PORT ?? String(await freePort()),
};
const urls = {
  nyx: `http://127.0.0.1:${ports.MOCK_NYXID_PORT}`,
  api: `http://127.0.0.1:${ports.METAVERSE_API_PORT}`,
  web: `http://127.0.0.1:${ports.METAVERSE_WEB_PORT}`,
};

const log = (line) => console.log(`[e2e] ${line}`);

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

/** 运行命令，输出同时转给终端（加前缀）并收集起来。 */
function runCommand(command, args, { cwd = repo, env = process.env, prefix = '', quiet = false, timeout } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // 超时就停掉子进程（退出码记成 null，调用方按失败处理）。
    const timer = timeout === undefined ? null : setTimeout(() => child.kill('SIGTERM'), timeout);
    let stdout = '';
    let stderr = '';
    const forward = (stream, chunk) => {
      if (quiet) return;
      for (const line of chunk.toString().split('\n')) if (line) stream.write(`${prefix}${line}\n`);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      forward(process.stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      forward(process.stderr, chunk);
    });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

const cliPath = join(repo, 'sdk', 'typescript', 'dist', 'cli.js');
const reconPath = join(repo, 'recon', '.venv', 'bin', 'metaverse-recon');
/** `metaverse` 命令的垫片目录：本地工具 bundle 最后会调用 PATH 里的 `metaverse bundle check`。 */
const shimDir = join(out, 'bin');

/**
 * metaverse 命令行；`--json` 时解析标准输出最后一个 JSON 值。`bundle push` 要等后台核对和包展开，
 * 最多等 METAVERSE_E2E_JOB_TIMEOUT 秒。
 */
async function metaverse(args, { cwd, expectCode = 0 } = {}) {
  const timeout = args[0] === 'bundle' && args[1] === 'push' ? jobTimeout : undefined;
  const result = await runCommand(process.execPath, [cliPath, ...args], {
    cwd,
    prefix: '    │ ',
    quiet: args.includes('--json'),
    timeout,
  });
  let json;
  if (args.includes('--json')) {
    const text = result.stdout.trim();
    try {
      json = JSON.parse(text);
    } catch {
      const start = text.lastIndexOf('\n{');
      json = start >= 0 ? JSON.parse(text.slice(start + 1)) : undefined;
    }
  }
  const name = args.slice(0, args[0] === 'bundle' ? 2 : 1).join(' ');
  check(
    result.code === expectCode,
    `metaverse ${name} 退出码 ${result.code}（期望 ${expectCode}）`,
    (result.stderr || result.stdout).slice(-2000),
  );
  return { ...result, json };
}

/** 本地重建工具 metaverse-recon（不连接服务）。 */
async function recon(args, { cwd }) {
  const env = { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` };
  const result = await runCommand(reconPath, args, { cwd, env, prefix: '    │ ' });
  writeFileSync(join(out, `recon-${args[0]}.log`), result.stdout + result.stderr);
  check(result.code === 0, `metaverse-recon ${args[0]} 退出码 ${result.code}`, (result.stderr || result.stdout).slice(-2000));
  return result;
}

// ---------------------------------------------------------------------------
// 起全套、收尾
// ---------------------------------------------------------------------------

let mongo = null;
let browser = null;
let cleaned = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await browser?.close().catch(() => {});
  if (parsed.keep) {
    log(`保留现场（--keep）：库 ${database}，网站 ${urls.web}，停止用 infra/dev/down.sh`);
    return;
  }
  log('停止全套（down.sh）');
  spawnSync('bash', [join(here, 'down.sh')], { stdio: 'inherit' });
  if (mongo) {
    const port = /:(\d+)\//.exec(mongo.mongoUri)?.[1] ?? '27017';
    const drop = spawnSync(process.execPath, [join(here, 'mongo.mjs'), 'drop', port, database], {
      stdio: 'inherit',
    });
    log(drop.status === 0 ? `已删除库 ${database}` : `删除库 ${database} 失败，请手动删除`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log(`收到 ${signal}，收尾`);
    await cleanup();
    process.exit(130);
  });
}

async function startStack() {
  log(`起全套：库 ${database}，模拟 NyxID ${urls.nyx}，接口服务 ${urls.api}，网站 ${urls.web}`);
  const result = await runCommand('bash', [join(here, 'up.sh')], {
    env: { ...process.env, ...ports, METAVERSE_DEV_DATABASE: database },
    prefix: '  │ ',
  });
  writeFileSync(join(out, 'up.log'), result.stdout + result.stderr);
  mongo = parseUpOutput(result.stdout);
  if (result.code !== 0) throw new E2eError(`up.sh 失败（退出码 ${result.code}），日志在 infra/dev/.run/*.log`);
  check(mongo !== null, '没从 up.sh 的输出里找到 MongoDB 连接串');
}

/** 页面（第 5 步打开；只跑部分步骤时由第 8 步按需打开）。 */
async function ensurePage(ctx) {
  if (ctx.page) return ctx.page;
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  ctx.page = page;
  ctx.pageErrors = [];
  page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
  await page.goto(`${urls.web}/s/${spaceId}#share=${ctx.share}`);
  await page.getByRole('heading', { level: 1, name: '验收前厅' }).waitFor({ timeout: 60_000 });
  return page;
}

async function buildSdk() {
  const sdk = join(repo, 'sdk', 'typescript');
  if (!existsSync(join(sdk, 'node_modules', '.package-lock.json'))) {
    log('安装命令行依赖（npm ci）');
    const ci = await runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: sdk, prefix: '  │ ' });
    if (ci.code !== 0) throw new E2eError('sdk/typescript 的 npm ci 失败');
  }
  log('构建命令行（npm run build）');
  const build = await runCommand('npm', ['run', 'build'], { cwd: sdk, prefix: '  │ ' });
  if (build.code !== 0) throw new E2eError('sdk/typescript 的 npm run build 失败');
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, 'metaverse');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`);
  chmodSync(shim, 0o755);
}

/** 本地重建工具的虚拟环境：没有就按锁文件装（设计 10.3：由需要它的地方准备）。 */
async function ensureRecon() {
  if (existsSync(reconPath)) return;
  log('准备本地重建工具（cd recon && uv sync --frozen）');
  const sync = await runCommand('uv', ['sync', '--frozen'], { cwd: join(repo, 'recon'), prefix: '  │ ' });
  if (sync.code !== 0) throw new E2eError('recon 的 uv sync --frozen 失败（要先装 uv：https://docs.astral.sh/uv/）', sync.stderr.slice(-2000));
  if (!existsSync(reconPath)) throw new E2eError(`uv sync 之后还是没有 ${reconPath}`);
}

// ---------------------------------------------------------------------------
// 浏览器
// ---------------------------------------------------------------------------

async function launchBrowser() {
  const requireFromWeb = createRequire(join(repo, 'web', 'package.json'));
  const { chromium } = requireFromWeb('@playwright/test');
  const preinstalled = '/opt/pw-browsers/chromium';
  const executablePath =
    process.env.METAVERSE_E2E_BROWSER_PATH ?? (existsSync(preinstalled) ? preinstalled : undefined);
  return chromium.launch({
    executablePath,
    // 无头环境没有显卡，用 SwiftShader 软件渲染 WebGL（与 web/e2e/playwright.config.ts 相同）。
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
}

async function waitForScene(page, mode) {
  await page.locator(`.viewer[data-mode="${mode}"][data-ready="true"]`).waitFor({ timeout: 180_000 });
  await page.locator('.page-loading').waitFor({ state: 'detached', timeout: 60_000 });
  // 给渲染循环和贴图几帧时间。
  await page.waitForTimeout(1500);
}

/** 镜头回到全景（扩展视图里虚拟区离实体区较远，要拉远才拍得到）。 */
async function overview(page) {
  await page.getByRole('button', { name: '回到全景' }).click();
  await page.waitForTimeout(800);
}

async function viewerNumber(page, name) {
  return Number(await page.locator('.viewer').getAttribute(name));
}

async function versionText(page) {
  return (await page.locator('.space__version').textContent()) ?? '';
}

async function renderedStats(page, file) {
  await page.screenshot({ path: join(out, file) });
  return imageStats(decodePng(await page.locator('.viewer__canvas').screenshot()));
}

// ---------------------------------------------------------------------------
// 九步
// ---------------------------------------------------------------------------

const call = devClient({ api: urls.api, nyx: urls.nyx });
const spaceId = `e2e-hall-${suffix}`;
const carolSpace = `e2e-carol-${suffix}`;
const ws = join(out, 'workspace');
const rebuildBase = `/api/v1/spaces/${spaceId}/rebuild`;

const LAYOUT = {
  message: '验收：实体区、虚拟区和地块',
  regions: [
    // 实体区要盖住对齐后的扫描，给足 ±30 米。
    { id: 'hall', kind: 'physical', name: '前厅', boxes: [[-600, -40, -600, 600, 200, 600]] },
    { id: 'garden', kind: 'virtual', name: '花园', boxes: [[640, 0, -200, 840, 80, 200]] },
  ],
  plots: [{ id: PLOT, regionId: 'garden', name: '验收地块', boxes: [[660, 0, -60, 760, 60, 60]] }],
};

/** 营业状态（空间级状态事件，显示在页面左上角的状态栏），与网站夹具的 shop.status 相同。 */
const STATUS_TYPE = {
  type: 'shop.status',
  schema: {
    type: 'object',
    properties: { status: { type: 'string', maxLength: 64 } },
    required: ['status'],
    additionalProperties: false,
  },
  publicFields: ['status'],
  defaultVisibility: 'public',
  state: { key: 'open', value: 'status' },
  display: { kind: 'label', color: [120, 200, 110], labelTemplate: '{status}' },
};

function statusEvent(id, status) {
  return { sourceEventId: id, type: 'shop.status', anchorId: '_space', at: new Date().toISOString(), data: { status } };
}

/** 建上传会话的请求体（与命令行相同：总大小、整体 sha256、分片大小、格式）。 */
function uploadBody(file, format) {
  return { size: file.size, sha256: file.sha256, partSize: PART_SIZE, format };
}

/** carol 的个人空间（凭哈希复用、越权的对照）；建过就不再建。 */
async function ensureCarolSpace(ctx) {
  if (ctx.carolSpace) return ctx.carolSpace;
  expectStatus(
    await call('POST', '/api/v1/admin/spaces', {
      as: 'carol',
      body: { id: carolSpace, name: 'carol 的房间', owner: { kind: 'person', id: 'carol' } },
    }),
    201,
    'carol 建个人空间',
  );
  ctx.carolSpace = carolSpace;
  return carolSpace;
}

const steps = [
  {
    name: '用测试令牌建组织空间',
    async run(ctx) {
      const created = expectStatus(
        await call('POST', '/api/v1/admin/spaces', {
          as: 'alice',
          body: { id: spaceId, name: '验收前厅', description: '九步验收', owner: { kind: 'org', id: ORG } },
        }),
        201,
        'alice（组织 admin）建组织空间',
      );
      ctx.share = created.body?.shareToken?.token;
      check(typeof ctx.share === 'string' && ctx.share.length > 0, '响应里没有分享令牌', created.body);
      check(created.body.space?.ownerEvidence?.basis === 'org_admin', '归属证据不是 org_admin', created.body.space);
      const layout = expectStatus(
        await call('PUT', `/api/v1/admin/spaces/${spaceId}/layout`, { as: 'alice', body: LAYOUT }),
        200,
        '定义区域和地块',
      );
      await metaverse(
        [
          'init', spaceId, ws, '--mode', 'direct', '--api', urls.api,
          '--dev-token-url', `${urls.nyx}/dev/token`, '--sub', 'alice', '--web-url', urls.web,
        ],
        { cwd: out },
      );
      return `空间 ${spaceId}（主人 org:${ORG}），布局提交 seq ${layout.body?.seq}，工作区 ${ws}`;
    },
  },
  {
    name: '本地工具产出重建包',
    async run(ctx) {
      const space = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}`), 200, '读空间');
      ctx.preScanSeq = space.body.head.seq;
      // pull 写 space.json（包的 base）和 limits.json（服务端的上传上限，本地工具按它检查）。
      await metaverse(['pull'], { cwd: ws });
      check(existsSync(join(ws, 'limits.json')), 'metaverse pull 没有写 limits.json');
      mkdirSync(join(ws, 'scan'), { recursive: true });
      const scanCopy = join(ws, 'scan', `scan${extname(scanFile).toLowerCase()}`);
      copyFileSync(scanFile, scanCopy);
      const seconds = {};
      for (const [name, args] of [
        // 第一次扫描：自动对齐，写 scan/transform.json；prepare 和 bundle 都用它。
        ['align', ['align', '--scan', scanCopy]],
        ['prepare', ['prepare', '--scan', scanCopy]],
        // --anchors：按类别建议的锚点也进包（默认只列出建议；验收要看锚点建出来、按 ifNew 跳过）。
        ['bundle', ['bundle', '--algorithm', '--anchors', '--scan', scanCopy, '--note', '验收：算法重建']],
      ]) {
        const started = Date.now();
        await recon(args, { cwd: ws });
        seconds[name] = Math.round((Date.now() - started) / 1000);
      }
      check(existsSync(join(ws, 'out', 'bundle', 'manifest.json')), '本地工具没有写出 out/bundle/manifest.json');
      const { json } = await metaverse(['bundle', 'check', '--json'], { cwd: ws });
      check(json?.ok === true, 'metaverse bundle check 没通过', json);
      check(
        json.base?.spaceId === spaceId && json.base?.seq === ctx.preScanSeq,
        '清单的 base 不是工作区拉取的版本',
        { base: json.base, want: { spaceId, seq: ctx.preScanSeq } },
      );
      const files = json.files ?? [];
      const scan = files.find((file) => file.purpose === 'scan');
      const webmodels = files.filter((file) => file.purpose === 'webmodel');
      check(scan !== undefined && webmodels.length > 0, '包里没有扫描或网页用模型', files);
      ctx.bundle = { manifestHash: json.manifestHash, files, scan, webmodels };
      const kinds = {};
      for (const file of files) kinds[file.purpose] = (kinds[file.purpose] ?? 0) + 1;
      return (
        `align ${seconds.align} 秒、prepare ${seconds.prepare} 秒、bundle ${seconds.bundle} 秒；` +
        `包里 ${files.length} 个文件（${Object.entries(kinds).map(([kind, count]) => `${kind} ${count}`).join('、')}），` +
        `清单 ${json.manifestHash.slice(0, 12)}…，base seq ${json.base.seq}；bundle check 通过`
      );
    },
  },
  {
    name: '带重建权限的身份上传并发布',
    async run(ctx) {
      const pushed = await metaverse(
        ['bundle', 'push', '--publish', '--part-size', '0.25', '--sub', REBUILDER, '--json'],
        { cwd: ws },
      );
      const result = pushed.json;
      check(typeof result?.draftId === 'string', 'bundle push 没有返回草稿编号', result);
      const seq = result.published?.seq;
      check(Number.isInteger(seq) && seq > ctx.preScanSeq, '发布没有产生新的 seq', result.published);
      check(result.published?.unchanged !== true, '第一次发布不应是 unchanged', result.published);
      // 扫描按 0.25MiB 分片上传，后台核对通过。
      const scanOutcome = (result.files ?? []).find((file) => file.path === ctx.bundle.scan.path);
      check(scanOutcome?.uploadId, '扫描没有上传会话', result.files);
      const session = expectStatus(
        await call('GET', `${rebuildBase}/uploads/scan/${scanOutcome.uploadId}`, { as: REBUILDER }),
        200,
        '读扫描的上传会话',
      );
      check(
        session.body.partSize === PART_SIZE && session.body.partCount > 1 && session.body.status === 'done',
        '扫描没有按 0.25MiB 分成多片上传，或核对没有完成',
        session.body,
      );
      // 提交：类别 rebuild，带扫描和网页用模型，重建层有物件，锚点建好了。
      const timeline = expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/timeline?limit=500`, { share: ctx.share }),
        200,
        '公开提交列表',
      );
      const commit = (timeline.body.items ?? []).find((item) => item.seq === seq);
      check(commit?.actor?.kind === 'rebuild', '提交的类别不是 rebuild', commit);
      const snapshot = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}/snapshot`), 200, '读最新快照');
      const entities = snapshot.body.entities ?? [];
      check(entities.length > 0, '发布后没有物件', { seq: snapshot.body.seq });
      check(entities.every((entity) => entity.id.startsWith('rb.') || entity.layer !== 'rebuilt'), '重建层编号不是 rb. 开头');
      check(snapshot.body.scan?.assetHash === ctx.bundle.scan.sha256, '提交的扫描不是包里的扫描', snapshot.body.scan);
      check((snapshot.body.scan?.webModelHashes ?? []).length === ctx.bundle.webmodels.length, '网页用模型的档数不对', snapshot.body.scan);
      const anchors = (snapshot.body.anchors ?? []).filter((anchor) => anchor.id !== '_space');
      check(anchors.length > 0, '包里的建议锚点没有建出来', snapshot.body.anchors);
      ctx.scanSeq = seq;
      ctx.latestSeq = seq;
      ctx.scanEntities = entities.length;

      // 同一个包再推一次（不带 --replay）：所有文件按哈希复用；草稿的基础版本还是清单的 base，中途只有
      // 同一个包清单的提交，不算冲突 → unchanged，不写提交（设计 6.7）。
      const again = await metaverse(['bundle', 'push', '--publish', '--sub', REBUILDER, '--json'], { cwd: ws });
      check(again.json?.published?.unchanged === true, '同一个包再推一次应当是 unchanged', again.json?.published);
      check((again.json.files ?? []).every((file) => file.reused), '再推一次时文件应当全部复用', again.json.files);
      const head = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}`), 200, '读空间');
      check(head.body.head.seq === seq, 'unchanged 不应写提交', { head: head.body.head.seq, seq });

      // 按哈希复用只在本空间成立：本空间同一份扫描直接复用；carol 的空间凭这个哈希拿不到，要完整上传。
      const scanUpload = uploadBody(ctx.bundle.scan, extname(ctx.bundle.scan.path).slice(1).toLowerCase());
      const same = expectStatus(
        await call('POST', `${rebuildBase}/uploads/scan`, { as: REBUILDER, body: scanUpload }),
        [200, 201],
        '本空间再上传同一份扫描',
      );
      check(same.body?.reused === true && same.body?.status === 'done', '本空间已有的扫描没有直接复用', same.body);
      const carol = await ensureCarolSpace(ctx);
      const foreign = expectStatus(
        await call('POST', `/api/v1/spaces/${carol}/rebuild/uploads/scan`, {
          as: 'carol',
          permissions: [REBUILD_PERMISSION],
          body: scanUpload,
        }),
        201,
        'carol 用前厅扫描的哈希建上传',
      );
      check(
        foreign.body?.reused !== true && foreign.body?.status === 'open' && foreign.body?.assetHash === undefined,
        '凭哈希复用了别的空间的扫描',
        foreign.body,
      );
      return (
        `草稿 ${result.draftId} 发布为 seq ${seq}（rebuild），扫描 ${session.body.partCount} 片；物件 ${entities.length} 件、` +
        `锚点 ${anchors.length} 个；再推一次 unchanged；本空间复用、carol 的空间要完整上传`
      );
    },
  },
  {
    name: '公开读接口按 seq 返回快照',
    async run(ctx) {
      const timeline = expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/timeline?limit=500`, { share: ctx.share }),
        200,
        '公开提交列表',
      );
      const commits = timeline.body.items ?? [];
      check(commits.some((commit) => commit.seq === ctx.scanSeq), '提交列表里没有重建的提交', commits);
      ctx.latestSeq = Math.max(...commits.map((commit) => commit.seq));
      const after = expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${ctx.scanSeq}`, { share: ctx.share }),
        200,
        `公开快照 seq=${ctx.scanSeq}`,
      );
      check(after.body.seq === ctx.scanSeq, '快照的 seq 不对', { want: ctx.scanSeq, got: after.body.seq });
      check((after.body.entities ?? []).length > 0, '重建后的公开快照没有物件');
      const models = after.body.scan?.webModelHashes ?? [];
      check(models.length > 0, '公开快照没有网页用模型');
      const before = expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${ctx.preScanSeq}`, { share: ctx.share }),
        200,
        `公开快照 seq=${ctx.preScanSeq}`,
      );
      check((before.body.entities ?? []).length === 0, '重建前的快照不应有物件', before.body.entities);
      check((before.body.scan?.webModelHashes ?? []).length === 0, '重建前的快照不应有扫描');
      const asset = await call('GET', `/api/public/assets/${models[0]}.bin`, { share: ctx.share });
      expectStatus(asset, 200, '网页用模型');
      check(/immutable/.test(asset.headers.get('cache-control') ?? ''), '资源响应不是 immutable', asset.headers.get('cache-control'));
      // 原始扫描不公开：提交里登记的只有网页用模型、物件模型和贴图。
      expectStatus(await call('GET', `/api/public/assets/${ctx.bundle.scan.sha256}.bin`, { share: ctx.share }), 404, '公开接口读原始扫描');
      const chunks = after.body.chunks ?? [];
      if (chunks.length > 0) {
        const chunk = expectStatus(await call('GET', `/api/public/chunks/${chunks[0].hash}.bin`), 200, '公开区块');
        check(/immutable/.test(chunk.headers.get('cache-control') ?? ''), '区块响应不是 immutable', chunk.headers.get('cache-control'));
      }
      expectStatus(await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${ctx.scanSeq}`), 404, '没带分享令牌');
      expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${ctx.scanSeq}`, { share: 'wrong-token' }),
        404,
        '分享令牌不对',
      );
      return `seq ${ctx.scanSeq}：物件 ${after.body.entities.length} 个、区块 ${chunks.length} 个；seq ${ctx.preScanSeq}：空；原始扫描、没带或带错令牌 404`;
    },
  },
  {
    name: '网站三种视图都能渲染',
    async run(ctx) {
      browser = await launchBrowser();
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      ctx.page = page;
      ctx.pageErrors = [];
      page.on('pageerror', (error) => ctx.pageErrors.push(error.message));
      await page.goto(`${urls.web}/s/${spaceId}#share=${ctx.share}`);
      await page.getByRole('heading', { level: 1, name: '验收前厅' }).waitFor({ timeout: 60_000 });
      const notes = [];
      for (const [button, mode] of [
        [null, 'optimized'],
        ['优化 + 扩展', 'extended'],
        ['原始', 'raw'],
      ]) {
        if (button) await page.getByRole('button', { name: button, exact: true }).click();
        await waitForScene(page, mode);
        await overview(page);
        const stats = await renderedStats(page, `view-${mode}.png`);
        check(looksRendered(stats), `${mode} 视图的截图像是空白`, stats);
        if (mode === 'optimized') {
          const entities = await viewerNumber(page, 'data-entities');
          check(entities > 0, '优化视图没有物件', { entities });
        } else if (mode === 'extended') {
          await page.locator('.viewer__virtual-tag', { hasText: '虚拟' }).first().waitFor({ timeout: 30_000 });
        } else {
          check((await page.locator('.viewer').getAttribute('data-scan')) === 'true', '原始视图没有扫描模型');
        }
        notes.push(`${mode}（${stats.colors} 种颜色，亮 ${(stats.brightRatio * 100).toFixed(0)}%）`);
      }
      check(ctx.pageErrors.length === 0, '页面有未捕获的错误', ctx.pageErrors);
      await page.getByRole('button', { name: '优化', exact: true }).click();
      await waitForScene(page, 'optimized');
      return `${notes.join('、')}；截图在 ${out}`;
    },
  },
  {
    name: '时间轴回到重建前',
    async run(ctx) {
      const { page } = ctx;
      // 相邻提交挨得很近、标记会重叠，所以直接派发点击事件到对应的提交标记上。
      await page
        .getByRole('button', { name: new RegExp(`^跳到提交 #${ctx.preScanSeq}(：|$)`) })
        .dispatchEvent('click');
      await waitFor(async () => (await versionText(page)).startsWith(`版本 #${ctx.preScanSeq} `), {
        timeout: 30_000,
        what: `页面显示版本 #${ctx.preScanSeq}`,
      });
      await page.getByText('这个时刻还没有优化模型').waitFor({ timeout: 30_000 });
      await page.screenshot({ path: join(out, 'timeline-before-rebuild.png') });
      const before = await versionText(page);
      await page.getByRole('button', { name: '现在' }).click();
      await waitFor(async () => (await versionText(page)).startsWith(`版本 #${ctx.latestSeq} `), {
        timeout: 30_000,
        what: `回到现在后显示版本 #${ctx.latestSeq}`,
      });
      await waitForScene(page, 'optimized');
      return `"${before.trim()}" 显示"还没有优化模型"；回到现在是版本 #${ctx.latestSeq}`;
    },
  },
  {
    name: '写事件后"现在"模式能拉到',
    async run(ctx) {
      const { page } = ctx;
      expectStatus(
        await call('POST', `/api/v1/admin/spaces/${spaceId}/event-types`, { as: 'alice', body: STATUS_TYPE }),
        201,
        '登记事件类型 shop.status',
      );
      // 页面在打开时读一次事件类型（公开空间信息的 eventTypes），打开后才登记的类型不认识；
      // 像真实场景那样（先接好数据源，再有人打开页面）重新打开一次，确认在"现在"模式后再写事件。
      await page.reload();
      await waitForScene(page, 'optimized');
      await page.getByRole('button', { name: '现在', pressed: true }).waitFor({ timeout: 30_000 });
      const headBefore = expectStatus(await call('GET', `/api/public/spaces/${spaceId}/head`, { share: ctx.share }), 200, '公开 head');
      const status = `验收中 ${suffix}`;
      const since = new Date(Date.now() - 5000).toISOString();
      const written = expectStatus(
        await call('POST', `/api/v1/spaces/${spaceId}/sources/e2e/events`, {
          as: 'alice',
          body: { events: [statusEvent(`status-${suffix}`, status)] },
        }),
        [200, 201, 202],
        '写事件',
      );
      check(written.body?.created === 1, '事件没有写入', written.body);
      await waitFor(
        async () => {
          const head = await call('GET', `/api/public/spaces/${spaceId}/head`, { share: ctx.share });
          return head.status === 200 && head.body.recordedAt !== headBefore.body.recordedAt;
        },
        { timeout: 15_000, what: '公开 head 的 recordedAt 变化' },
      );
      const events = expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/events?since=${encodeURIComponent(since)}`, { share: ctx.share }),
        200,
        '公开增量事件',
      );
      check(
        (events.body.items ?? []).some((event) => event.type === 'shop.status' && event.data?.status === status),
        '公开增量事件里没有刚写的事件',
        events.body,
      );
      // 页面在"现在"模式，每 5 秒查一次 /head，有变化就增量拉事件、更新状态栏。
      await page.locator('.viewer__hud', { hasText: status }).waitFor({ timeout: 30_000 });
      await page.screenshot({ path: join(out, 'live-event.png') });
      return `head.recordedAt 变化，公开增量事件和页面状态栏都出现"${status}"`;
    },
  },
  {
    name: '命令行在地块内 pull → build → push → publish',
    async run(ctx) {
      if (ctx.latestSeq === undefined) {
        // 只跑部分步骤时：最新版本从空间信息读，扩展视图先记下物件数。
        const space = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}`), 200, '读空间');
        ctx.latestSeq = space.body.head.seq;
      }
      const page = await ensurePage(ctx);
      await page.getByRole('button', { name: '优化 + 扩展', exact: true }).click();
      await waitForScene(page, 'extended');
      const before = await viewerNumber(page, 'data-entities');
      await metaverse(['pull'], { cwd: ws });
      await metaverse(['build', '--plot', PLOT], { cwd: ws });
      await metaverse(['check', '--plot', PLOT], { cwd: ws });
      const pushed = await metaverse(['push', '--plot', PLOT, '--message', '验收：地块建造', '--json'], { cwd: ws });
      const draftId = pushed.json?.draftId;
      check(typeof draftId === 'string', 'push 没有返回草稿编号', pushed.json);
      check(pushed.json.opCount > 0, '草稿里没有操作', pushed.json);
      const published = await metaverse(['publish', draftId, '--json'], { cwd: ws });
      const seq = published.json?.seq;
      check(Number.isInteger(seq) && seq > ctx.latestSeq, '发布没有产生新的 seq', published.json);
      const snapshot = expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${seq}`, { share: ctx.share }),
        200,
        `公开快照 seq=${seq}`,
      );
      const ids = new Set((snapshot.body.entities ?? []).map((entity) => entity.id));
      check(ids.has('demo-table'), '发布后的快照里没有示例脚本放的桌子', [...ids]);
      // 页面在"现在"模式：拉到新提交，扩展视图里能看到地块上的物件。
      await waitFor(async () => (await versionText(page)).startsWith(`版本 #${seq} `), {
        timeout: 30_000,
        what: `页面换到版本 #${seq}`,
      });
      await waitForScene(page, 'extended');
      await overview(page);
      const entities = await viewerNumber(page, 'data-entities');
      check(entities > before, '扩展视图里没有多出地块上的物件', { entities, before });
      await page.screenshot({ path: join(out, 'plot-build-extended.png') });
      ctx.latestSeq = seq;
      return `草稿 ${draftId}（${pushed.json.opCount} 个操作）发布为 seq ${seq}；页面扩展视图物件 ${before} → ${entities} 个`;
    },
  },
  {
    name: '越权操作返回 403、404 或 422',
    async run(ctx) {
      const carol = await ensureCarolSpace(ctx);
      const space = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}`), 200, '读空间');
      const baseSeq = space.body.head.seq;
      // 扫描和清单的上传请求体：跑过第 2 步就用包里的真实文件，否则用一份合法的假声明（越权必须由授权层或
      // 用途规则拒绝，而不是因为请求体不合法被挡掉）。
      const scanUpload = ctx.bundle
        ? uploadBody(ctx.bundle.scan, extname(ctx.bundle.scan.path).slice(1).toLowerCase())
        : { size: 4 * PART_SIZE, sha256: 'a'.repeat(64), partSize: PART_SIZE, format: 'zip' };
      const bundleUpload = { size: 1024, sha256: 'b'.repeat(64), partSize: PART_SIZE, format: 'json' };
      const cases = [
        { what: 'bob（组织 member）建地块草稿', status: 403, method: 'POST', path: `/api/v1/spaces/${spaceId}/plots/${PLOT}/drafts`, as: 'bob', body: {} },
        { what: 'bob（组织 member）建实体区草稿', status: 403, method: 'POST', path: `/api/v1/spaces/${spaceId}/drafts`, as: 'bob', body: {} },
        { what: 'bob（组织 member）写事件', status: 403, method: 'POST', path: `/api/v1/spaces/${spaceId}/sources/e2e/events`, as: 'bob', body: { events: [statusEvent(`bob-${suffix}`, 'bob 写的')] } },
        { what: 'bob（组织 member）登记事件类型', status: 403, method: 'POST', path: `/api/v1/admin/spaces/${spaceId}/event-types`, as: 'bob', body: STATUS_TYPE },
        { what: 'dave（不是组织成员）读空间', status: 404, method: 'GET', path: `/api/v1/spaces/${spaceId}`, as: 'dave' },
        { what: 'dave（不是组织成员）建草稿', status: 404, method: 'POST', path: `/api/v1/spaces/${spaceId}/plots/${PLOT}/drafts`, as: 'dave', body: {} },
        { what: 'alice 读 carol 的个人空间', status: 404, method: 'GET', path: `/api/v1/spaces/${carol}`, as: 'alice' },
        { what: 'alice 在 carol 的个人空间建草稿', status: 404, method: 'POST', path: `/api/v1/spaces/${carol}/drafts`, as: 'alice', body: {} },
        { what: 'bob 冒充组织建组织空间', status: 403, method: 'POST', path: '/api/v1/admin/spaces', as: 'bob', body: { id: `e2e-bob-${suffix}`, name: 'x', owner: { kind: 'org', id: ORG } } },
        // 重建路径（设计 3.1）：写操作要 metaverse:rebuild:write，并且要"管理"级别。
        { what: 'alice（组织 admin，没有重建权限）建重建草稿', status: 403, code: 'rebuild_permission_required', method: 'POST', path: `${rebuildBase}/drafts`, as: 'alice', body: { baseSeq } },
        { what: 'alice（没有重建权限）经重建路径上传扫描', status: 403, code: 'rebuild_permission_required', method: 'POST', path: `${rebuildBase}/uploads/scan`, as: 'alice', body: scanUpload },
        { what: 'bob（组织 member，带重建权限）建重建草稿', status: 403, method: 'POST', path: `${rebuildBase}/drafts`, as: 'bob', permissions: [REBUILD_PERMISSION], body: { baseSeq } },
        // 上传用途按路径（设计 2.3）：扫描只经重建路径，重建包清单不能经地块路径。
        { what: 'alice 经实体区路径上传扫描', status: 422, code: 'purpose_not_allowed', method: 'POST', path: `/api/v1/spaces/${spaceId}/uploads/scan`, as: 'alice', body: scanUpload },
        { what: 'alice 经地块路径上传重建包清单', status: 403, code: 'scope_violation', method: 'POST', path: `/api/v1/spaces/${spaceId}/plots/${PLOT}/uploads/bundle`, as: 'alice', body: bundleUpload },
        // 下线的旧接口一律 410。
        { what: 'alice 调已下线的扫描导入', status: 410, code: 'endpoint_retired', method: 'POST', path: `/api/v1/spaces/${spaceId}/scans`, as: 'alice', body: { assetHash: scanUpload.sha256 } },
      ];
      const lines = [];
      for (const item of cases) {
        const reply = await call(item.method, item.path, {
          as: item.as,
          ...(item.body !== undefined ? { body: item.body } : {}),
          ...(item.permissions ? { permissions: item.permissions } : {}),
        });
        expectStatus(reply, item.status, item.what);
        if (item.code) check(reply.body?.code === item.code, `${item.what}：错误码不是 ${item.code}`, reply.body);
        lines.push(`${item.what} ${reply.status}`);
      }
      expectStatus(await call('GET', `/api/public/spaces/${carol}`), 404, '没带令牌读别人的空间');

      // 地块草稿不能放 rb. 开头的编号（留给重建层，核心库规则）。
      const plotDraft = expectStatus(
        await call('POST', `/api/v1/spaces/${spaceId}/plots/${PLOT}/drafts`, { as: 'alice', body: {} }),
        201,
        'alice 建地块草稿',
      );
      const draftId = plotDraft.body?.draftId ?? plotDraft.body?.id;
      check(typeof draftId === 'string', '建地块草稿没有返回草稿编号', plotDraft.body);
      const rbOp = {
        op: 'placeEntity',
        entity: {
          entityId: `rb.e2e-${suffix}`,
          layer: 'ext',
          kind: 'object',
          shape: { type: 'box', size: [1, 1, 1], transform: { position: [35.5, 0, 0] } },
          bounds: { min: [35, 0, -0.5], max: [36, 1, 0.5] },
        },
      };
      const rejected = await call('POST', `/api/v1/spaces/${spaceId}/plots/${PLOT}/drafts/${draftId}/ops`, {
        as: 'alice',
        body: { ops: [rbOp] },
      });
      expectStatus(rejected, 422, '地块草稿放 rb. 编号');
      check(rejected.body?.code === 'invalid_op', '地块草稿放 rb. 编号：错误码不是 invalid_op', rejected.body);
      lines.push('地块草稿放 rb. 编号 422');

      if (!ctx.bundle) {
        // 没跑第 2、3 步：预览令牌的断言跳过。
        return lines.join('；');
      }
      // 预览令牌只能读可预览的资源（网页用模型、物件模型、贴图）：原始扫描和包清单 404（设计 2.8）。
      // 同一个包推一次但不发布，拿到预览链接。
      const preview = await metaverse(['bundle', 'push', '--sub', REBUILDER, '--json'], { cwd: ws });
      const token = previewToken(preview.json?.preview);
      check(token !== null, 'bundle push 没有给出预览链接', preview.json);
      const asPreview = { headers: { authorization: `Preview ${token}` } };
      expectStatus(await call('GET', '/api/public/previews', asPreview), 200, '预览快照');
      expectStatus(await call('GET', `/api/public/previews/assets/${ctx.bundle.webmodels[0].sha256}`, asPreview), 200, '预览读网页用模型');
      expectStatus(await call('GET', `/api/public/previews/assets/${ctx.bundle.scan.sha256}`, asPreview), 404, '预览读原始扫描');
      expectStatus(await call('GET', `/api/public/previews/assets/${ctx.bundle.manifestHash}`, asPreview), 404, '预览读包清单');
      lines.push('预览令牌读网页用模型 200、读原始扫描和包清单 404');
      return lines.join('；');
    },
  },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let exitCode = 1;
try {
  if (only.has(2)) await ensureRecon();
  await startStack();
  await buildSdk();
  const selected = steps
    .map((step, index) => ({ ...step, number: index + 1 }))
    .filter((step) => only.has(step.number));
  log(`开始九步验收：第 ${[...only].join('、')} 步${scanFile ? `（扫描 ${scanFile}）` : ''}`);
  const context = {};
  const { ok, results } = await runSteps(selected, context, { log });
  if (!ok && context.page) {
    // 失败时留一张整页截图，方便看当时页面的样子。
    await context.page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  }
  const report = formatReport(results);
  writeFileSync(join(out, 'report.md'), `# 九步验收\n\n- 库：${database}\n- 扫描：${scanFile ?? '（没跑第 2 步）'}\n\n${report}\n`);
  writeFileSync(join(out, 'report.json'), JSON.stringify({ ok, database, scan: scanFile, urls, results }, null, 2));
  console.log(`\n${report}\n`);
  log(ok ? `九步全部通过（结果和截图在 ${out}）` : `验收失败（结果、截图和日志在 ${out}、infra/dev/.run/*.log）`);
  exitCode = ok ? 0 : 1;
} catch (error) {
  log(`验收没能开始：${error.message}`);
  if (error instanceof E2eError && error.detail !== undefined) log(JSON.stringify(error.detail).slice(0, 2000));
  exitCode = 2;
} finally {
  await cleanup();
}
process.exit(exitCode);
