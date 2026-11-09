#!/usr/bin/env node
// 九步端到端验收（docs/BUILD_PLAN.md 第 5.2 节）：用 up.sh 在本机起全套（真实 MongoDB 副本集、
// 模拟 NyxID、接口服务、网站开发服务器），再按九步依次执行并断言：
//
//   1. 用测试令牌建组织空间（再定义实体区、虚拟区和地块 p1）
//   2. 分片上传前厅扫描（metaverse scan，0.25MiB 一片）
//   3. 处理服务完成对齐和 AI 重建，写入提交
//   4. 公开读接口按 seq 返回快照（重建前后两个版本、区块和资源、没带令牌 404）
//   5. 网站三种视图都能渲染（无头浏览器截图，检查不是空白）
//   6. 时间轴能回到重建前
//   7. 写事件后"现在"模式能拉到（/head 变化、增量事件、页面状态栏）
//   8. 命令行 pull → build → check → push → publish 在地块内完成一次建造
//   9. 越权操作返回 403 或 404
//
// 用法：
//   node infra/dev/e2e.mjs [--only 1,8,9] [--scan <扫描文件>] [--voxelize] [--keep]
//
// - 处理服务已下线（docs/design/server-slim.md 13.3）：第 2–7 步依赖处理服务的重建结果，改造完成（S9）
//   之前默认只跑第 1、8、9 步（`--only` 的默认值）；`--only 1-9` 照旧跑全部九步（要有处理服务的旧镜像）；
//   只有选了第 2 步才需要扫描文件；
// - 扫描文件不进版本库：用 --scan 或环境变量 METAVERSE_E2E_SCAN 指定（glb、drc、obj、zip，命令行
//   metaverse scan 接受的格式）；
// - 每次用随机库名和空闲端口，结束时停掉全套（down.sh）并删除这个库；--keep 保留现场排查；
// - 截图、工作区、日志和结果在 infra/dev/.run/e2e-<后缀>/（不进版本库）；
// - 浏览器：METAVERSE_E2E_BROWSER_PATH，没有时用 /opt/pw-browsers/chromium（存在的话），
//   再没有就交给网站依赖里的 Playwright 自己找；
// - 其他环境变量照 up.sh：METAVERSE_MONGODB_URI（副本集地址）等；
//   METAVERSE_E2E_JOB_TIMEOUT 任务的等待上限（秒，默认 1800）。
//
// 退出码：0 全部通过，1 有步骤失败，2 参数或环境不对（没开始验收）。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
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
  parseUpOutput,
  randomSuffix,
  runSteps,
  waitFor,
} from './e2e-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const run = join(here, '.run');
const SCAN_FORMATS = ['.glb', '.drc', '.obj', '.zip'];
const ORG = 'chronoai';
const PLOT = 'p1';

// ---------------------------------------------------------------------------
// 参数与环境
// ---------------------------------------------------------------------------

function usage(message, code = 2) {
  if (message) console.error(message);
  console.error(
    '用法：node infra/dev/e2e.mjs [--only 1,8,9] [--scan <扫描文件（glb/drc/obj/zip）>] [--voxelize] [--keep]',
  );
  process.exit(code);
}

/** `--only` 的默认值：处理服务下线后、九步改完之前只跑不依赖重建结果的三步。 */
const DEFAULT_ONLY = '1,8,9';

let parsed;
try {
  parsed = parseArgs({
    options: {
      scan: { type: 'string' },
      only: { type: 'string', default: DEFAULT_ONLY },
      voxelize: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
} catch (error) {
  usage(error.message);
}
if (parsed.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n'));
  process.exit(0);
}

let only;
try {
  only = parseOnly(parsed.only, 9);
} catch (error) {
  usage(error.message);
}
const scanPath = parsed.scan ?? process.env.METAVERSE_E2E_SCAN;
let scanFile = null;
if (only.has(2)) {
  if (!scanPath) usage('缺少扫描文件：用 --scan <文件> 或环境变量 METAVERSE_E2E_SCAN 指定（前厅扫描不进版本库）');
  scanFile = resolve(scanPath);
  if (!existsSync(scanFile)) usage(`找不到扫描文件 ${scanFile}`);
  if (!SCAN_FORMATS.includes(extname(scanFile).toLowerCase())) {
    usage(`扫描文件必须是 ${SCAN_FORMATS.join('、')}（metaverse scan 接受的格式）：${scanFile}`);
  }
}
for (const name of ['mongod', 'mock-nyxid', 'api', 'worker', 'web']) {
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

const jobTimeout = Number(process.env.METAVERSE_E2E_JOB_TIMEOUT ?? '1800') * 1000;
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
function runCommand(command, args, { cwd = repo, env = process.env, prefix = '', quiet = false } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

const cliPath = join(repo, 'sdk', 'typescript', 'dist', 'cli.js');

/** metaverse 命令行；`--json` 时解析标准输出最后一个 JSON 值。 */
async function metaverse(args, { cwd, expectCode = 0 } = {}) {
  const result = await runCommand(process.execPath, [cliPath, ...args], { cwd, prefix: '    │ ', quiet: args.includes('--json') });
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
  check(
    result.code === expectCode,
    `metaverse ${args[0]} 退出码 ${result.code}（期望 ${expectCode}）`,
    (result.stderr || result.stdout).slice(-2000),
  );
  return { ...result, json };
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
const ws = join(out, 'workspace');

const LAYOUT = {
  message: '验收：实体区、虚拟区和地块',
  regions: [
    // 实体区要盖住对齐后的扫描（体素化只保留实体区里的格子），给足 ±30 米。
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
    name: '分片上传扫描',
    async run(ctx) {
      const space = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}`), 200, '读空间');
      ctx.preScanSeq = space.body.head.seq;
      const args = ['scan', scanFile, '--part-size', '0.25', '--no-wait', '--json'];
      if (parsed.voxelize) args.push('--voxelize');
      const { json } = await metaverse(args, { cwd: ws });
      check(json && /^[0-9a-f]{64}$/.test(json.assetHash ?? ''), '命令行没有返回资源哈希', json);
      check(typeof json.jobId === 'string', '命令行没有返回导入任务编号', json);
      check(json.upload?.reused || json.upload?.parts > 1, '扫描没有分成多片上传', json.upload);
      ctx.scanJob = json.jobId;
      ctx.scanAsset = json.assetHash;
      // 同一份内容再建一次上传：本空间已经拥有（真正传过数据的上传已校验通过），直接复用，不再收数据。
      // 两种情况都是 201，不同只在 reused / status（别的空间凭哈希复用不到，见第 9 步）。
      ctx.scanUpload = {
        size: statSync(scanFile).size,
        sha256: json.assetHash,
        partSize: 256 * 1024,
        format: extname(scanFile).slice(1).toLowerCase(),
      };
      const again = expectStatus(
        await call('POST', `/api/v1/spaces/${spaceId}/uploads/scan`, { as: 'alice', body: ctx.scanUpload }),
        201,
        '同一空间再上传同一份扫描',
      );
      check(
        again.body?.reused === true && again.body?.status === 'done' && again.body?.assetHash === json.assetHash,
        '本空间已有的扫描没有直接复用',
        again.body,
      );
      return `${json.upload?.parts ?? 0} 片（${json.upload?.size ?? '?'} 字节），资源 ${json.assetHash.slice(0, 12)}…，任务 ${json.jobId}；同一空间再上传直接复用`;
    },
  },
  {
    name: '处理服务完成对齐和 AI 重建',
    async run(ctx) {
      const job = await waitFor(
        async () => {
          const reply = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}/jobs/${ctx.scanJob}`), 200, '查任务');
          return ['done', 'failed'].includes(reply.body.status) ? reply.body : null;
        },
        { timeout: jobTimeout, interval: 3000, what: 'scan_import 任务完成' },
      );
      check(job.status === 'done', `scan_import 任务失败：${job.lastError?.message ?? JSON.stringify(job.lastError)}`, job);
      check(job.result?.needsAlignment !== true, '第一次扫描不应要求人工对齐', job.result);
      // 体素化等后续任务也做完。
      await waitFor(
        async () => {
          const reply = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}/jobs?limit=100`), 200, '列任务');
          const items = Array.isArray(reply.body) ? reply.body : (reply.body.items ?? reply.body.jobs ?? []);
          const failed = items.find((item) => item.status === 'failed');
          if (failed) throw new E2eError(`任务 ${failed.id}（${failed.kind}）失败`, failed);
          return items.every((item) => item.status === 'done');
        },
        { timeout: jobTimeout, interval: 3000, what: '全部任务完成' },
      );
      const snapshot = expectStatus(await call('GET', `/api/v1/spaces/${spaceId}/snapshot`), 200, '读最新快照');
      const entities = snapshot.body.entities ?? [];
      check(entities.length > 0, '重建后没有物件', { seq: snapshot.body.seq });
      check((snapshot.body.scan?.webModelHashes ?? []).length > 0, '没有网页用模型', snapshot.body.scan);
      check(snapshot.body.seq > ctx.preScanSeq, '导入后 seq 没有前进', { before: ctx.preScanSeq, after: snapshot.body.seq });
      ctx.scanEntities = entities.length;
      // --voxelize：导入任务另建一个 voxelize 任务，它写的提交带重建层区块。
      const chunks = (snapshot.body.chunks ?? []).length;
      if (parsed.voxelize) check(chunks > 0, '体素化后最新快照没有区块', { seq: snapshot.body.seq });
      const timings = job.result?.timings ? `，耗时 ${JSON.stringify(job.result.timings)}` : '';
      return `seq ${ctx.preScanSeq} → ${snapshot.body.seq}，物件 ${entities.length} 个，区块 ${chunks} 个，网页用模型 ${snapshot.body.scan.webModelHashes.length} 档${timings}`;
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
      const scanCommit = commits.find((commit) => commit.seq > ctx.preScanSeq);
      check(scanCommit !== undefined, '提交列表里没有导入扫描的提交', commits);
      ctx.scanSeq = scanCommit.seq;
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
      let chunks = after.body.chunks ?? [];
      let chunkSeq = ctx.scanSeq;
      if (parsed.voxelize) {
        // 体素化结果在导入之后的另一次提交里（voxelize 任务写的），按最新版本读。
        chunkSeq = ctx.latestSeq;
        const voxelized = expectStatus(
          await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${chunkSeq}`, { share: ctx.share }),
          200,
          `公开快照 seq=${chunkSeq}`,
        );
        chunks = voxelized.body.chunks ?? [];
        check(chunks.length > 0, '体素化后的公开快照没有区块', { seq: chunkSeq });
      }
      if (chunks.length > 0) {
        // 区块按内容哈希公开读取，不带分享令牌；处理服务写回后要补上 publishedAt 才读得到。
        const chunk = expectStatus(await call('GET', `/api/public/chunks/${chunks[0].hash}.bin`), 200, '公开区块');
        check(/immutable/.test(chunk.headers.get('cache-control') ?? ''), '区块响应不是 immutable', chunk.headers.get('cache-control'));
      }
      expectStatus(await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${ctx.scanSeq}`), 404, '没带分享令牌');
      expectStatus(
        await call('GET', `/api/public/spaces/${spaceId}/snapshot?seq=${ctx.scanSeq}`, { share: 'wrong-token' }),
        404,
        '分享令牌不对',
      );
      const chunkNote =
        chunkSeq === ctx.scanSeq ? `、区块 ${chunks.length} 个` : `；seq ${chunkSeq}：区块 ${chunks.length} 个`;
      return `seq ${ctx.scanSeq}：物件 ${after.body.entities.length} 个${chunkNote}；seq ${ctx.preScanSeq}：空；没带或带错令牌 404`;
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
      if (parsed.voxelize) {
        // 重建层既有物件又有区块：优化视图切到"方块"画法，区块画出来、重建层物件不画，再换回"形状"。
        await page.getByRole('button', { name: '优化', exact: true }).click();
        await waitForScene(page, 'optimized');
        const styles = page.getByRole('group', { name: '重建层画法' });
        await styles.getByRole('button', { name: '方块' }).click();
        const faces = await waitFor(
          async () => {
            const count = await viewerNumber(page, 'data-voxel-faces');
            return count > 0 ? count : null;
          },
          { timeout: 60_000, what: '方块画法画出区块' },
        );
        await waitForScene(page, 'optimized');
        await overview(page);
        const entities = await viewerNumber(page, 'data-entities');
        check(entities === 0, '方块画法不应再画重建层物件', { entities });
        const stats = await renderedStats(page, 'view-optimized-blocks.png');
        check(looksRendered(stats), '方块画法的截图像是空白', stats);
        notes.push(`方块（${faces} 个面，${stats.colors} 种颜色，亮 ${(stats.brightRatio * 100).toFixed(0)}%）`);
        await styles.getByRole('button', { name: '形状' }).click();
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
      if (ctx.scanEntities === undefined) {
        await page.getByRole('button', { name: '优化 + 扩展', exact: true }).click();
        await waitForScene(page, 'extended');
        ctx.scanEntities = await viewerNumber(page, 'data-entities');
      }
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
      await page.getByRole('button', { name: '优化 + 扩展', exact: true }).click();
      await waitForScene(page, 'extended');
      await overview(page);
      const entities = await viewerNumber(page, 'data-entities');
      check(entities > ctx.scanEntities, '扩展视图里没有多出地块上的物件', { entities, before: ctx.scanEntities });
      await page.screenshot({ path: join(out, 'plot-build-extended.png') });
      ctx.latestSeq = seq;
      return `草稿 ${draftId}（${pushed.json.opCount} 个操作）发布为 seq ${seq}；页面扩展视图物件 ${entities} 个`;
    },
  },
  {
    name: '越权操作返回 403 或 404',
    async run(ctx) {
      const carolSpace = `e2e-carol-${suffix}`;
      expectStatus(
        await call('POST', '/api/v1/admin/spaces', {
          as: 'carol',
          body: { id: carolSpace, name: 'carol 的房间', owner: { kind: 'person', id: 'carol' } },
        }),
        201,
        'carol 建个人空间',
      );
      const cases = [
        ['bob（组织 member）建地块草稿', 403, 'POST', `/api/v1/spaces/${spaceId}/plots/${PLOT}/drafts`, 'bob', {}],
        ['bob（组织 member）建实体区草稿', 403, 'POST', `/api/v1/spaces/${spaceId}/drafts`, 'bob', {}],
        // 请求体都是合法的：越权必须由授权层拒绝，而不是因为请求体不合法被 422 挡掉。
        ['bob（组织 member）写事件', 403, 'POST', `/api/v1/spaces/${spaceId}/sources/e2e/events`, 'bob', { events: [statusEvent(`bob-${suffix}`, 'bob 写的')] }],
        ['bob（组织 member）登记事件类型', 403, 'POST', `/api/v1/admin/spaces/${spaceId}/event-types`, 'bob', STATUS_TYPE],
        ['dave（不是组织成员）读空间', 404, 'GET', `/api/v1/spaces/${spaceId}`, 'dave', undefined],
        ['dave（不是组织成员）建草稿', 404, 'POST', `/api/v1/spaces/${spaceId}/plots/${PLOT}/drafts`, 'dave', {}],
        ['alice 读 carol 的个人空间', 404, 'GET', `/api/v1/spaces/${carolSpace}`, 'alice', undefined],
        ['alice 在 carol 的个人空间建草稿', 404, 'POST', `/api/v1/spaces/${carolSpace}/drafts`, 'alice', {}],
        ['bob 冒充组织建组织空间', 403, 'POST', '/api/v1/admin/spaces', 'bob', { id: `e2e-bob-${suffix}`, name: 'x', owner: { kind: 'org', id: ORG } }],
      ];
      const lines = [];
      for (const [what, expected, method, path, as, body] of cases) {
        const reply = await call(method, path, { as, ...(body !== undefined ? { body } : {}) });
        expectStatus(reply, expected, what);
        lines.push(`${what} ${reply.status}`);
      }
      expectStatus(await call('GET', `/api/public/spaces/${carolSpace}`), 404, '没带令牌读别人的空间');
      if (!ctx.scanUpload) {
        // 没跑第 2 步（没有上传过扫描）：凭哈希复用的两组断言跳过。
        return lines.join('；');
      }
      // 凭哈希拿不到别的空间的资源：carol 用前厅扫描的哈希建上传，必须完整上传（不复用、不说明别处有没有）；
      // 不上传就直接导入，没有本空间的已校验上传，422。
      const foreign = expectStatus(
        await call('POST', `/api/v1/spaces/${carolSpace}/uploads/scan`, { as: 'carol', body: ctx.scanUpload }),
        201,
        'carol 用别的空间的扫描哈希建上传',
      );
      check(
        foreign.body?.reused !== true && foreign.body?.status === 'open' && foreign.body?.assetHash === undefined,
        '凭哈希复用了别的空间的扫描',
        foreign.body,
      );
      lines.push('carol 用前厅扫描的哈希建上传 201（要完整上传）');
      const imported = expectStatus(
        await call('POST', `/api/v1/spaces/${carolSpace}/scans`, { as: 'carol', body: { assetHash: ctx.scanAsset } }),
        422,
        'carol 凭哈希导入别的空间的扫描',
      );
      check(imported.body?.code === 'asset_unknown', '错误码不是 asset_unknown', imported.body);
      lines.push('carol 凭哈希导入前厅扫描 422');
      return lines.join('；');
    },
  },
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let exitCode = 1;
try {
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
