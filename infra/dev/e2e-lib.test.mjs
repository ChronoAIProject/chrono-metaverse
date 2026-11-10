// 九步验收脚本小工具的测试：node --test infra/dev/*.test.mjs
// 浏览器、全套服务不在这里起；这里只测步骤执行、等待、请求头、截图判断这些纯逻辑。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  E2eError,
  check,
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
  parseOnly,
  runSteps,
  waitFor,
} from './e2e-lib.mjs';
import { startMockNyxid } from './mock-nyxid.mjs';

// ---------------------------------------------------------------------------
// 造一张 PNG（8 位 RGB，每行用不同的过滤方式，覆盖解码的各分支）
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** `pixel(x, y)` 返回 [r, g, b]；第 y 行用过滤方式 y % 5 编码。 */
function encodePng(width, height, pixel) {
  const rows = [];
  const raw = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) row.push(...pixel(x, y));
    raw.push(row);
  }
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5;
    const line = [filter];
    for (let x = 0; x < width * 3; x += 1) {
      const value = raw[y][x];
      const a = x >= 3 ? raw[y][x - 3] : 0;
      const b = y > 0 ? raw[y - 1][x] : 0;
      const c = x >= 3 && y > 0 ? raw[y - 1][x - 3] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line.push((value - predicted) & 0xff);
    }
    rows.push(Buffer.from(line));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG 解码：五种过滤方式都还原成原像素', () => {
  const pixel = (x, y) => [(x * 37 + y * 11) & 0xff, (x * 5 + y * 71) & 0xff, (x * y) & 0xff];
  const png = decodePng(encodePng(16, 10, pixel));
  assert.equal(png.width, 16);
  assert.equal(png.height, 10);
  assert.equal(png.channels, 3);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const i = (y * 16 + x) * 3;
      assert.deepEqual([...png.pixels.subarray(i, i + 3)], pixel(x, y), `像素 (${x}, ${y})`);
    }
  }
});

test('PNG 解码：不支持的格式报错', () => {
  const png = encodePng(2, 2, () => [0, 0, 0]);
  const bad = Buffer.from(png);
  bad[8 + 8 + 9] = 3; // IHDR 的颜色类型改成调色板
  assert.throws(() => decodePng(bad), /不支持的颜色类型 3/);
});

test('截图判断：纯色和全黑不算画出了东西，彩色场景算', () => {
  const black = imageStats(decodePng(encodePng(64, 64, () => [0, 0, 0])));
  assert.deepEqual(black, { brightRatio: 0, colors: 1 });
  assert.equal(looksRendered(black), false);

  const flat = imageStats(decodePng(encodePng(64, 64, () => [200, 200, 200])));
  assert.equal(flat.brightRatio, 1);
  assert.equal(looksRendered(flat), false, '一片纯色');

  const scene = imageStats(decodePng(encodePng(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2])));
  assert.ok(scene.colors > 12 && scene.brightRatio > 0.02, JSON.stringify(scene));
  assert.equal(looksRendered(scene), true);
});

test('runSteps：按顺序执行，第一个失败后其余标为未执行', async () => {
  const order = [];
  const logs = [];
  const { ok, results } = await runSteps(
    [
      { name: '一', run: async (ctx) => { order.push(1); ctx.value = 42; return '好'; } },
      { name: '二', run: async (ctx) => { order.push(2); check(ctx.value === 0, '值不对', { value: ctx.value }); } },
      { name: '三', run: async () => { order.push(3); } },
    ],
    {},
    { log: (line) => logs.push(line) },
  );
  assert.equal(ok, false);
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(
    results.map((r) => [r.name, r.ok, Boolean(r.skipped)]),
    [['一', true, false], ['二', false, false], ['三', false, true]],
  );
  assert.equal(results[0].detail, '好');
  assert.equal(results[1].detail, '值不对');
  assert.deepEqual(results[1].error, { value: 42 });
  assert.ok(logs.some((line) => line.startsWith('✘ 2. 二：值不对')));
  assert.ok(logs.some((line) => line.includes('"value":42')), '失败时打印细节');

  const report = formatReport(results);
  assert.match(report, /\| 1\. 一 \| 通过 \|/);
  assert.match(report, /\| 2\. 二 \| 失败 \|/);
  assert.match(report, /\| 3\. 三 \| 未执行 \|/);
});

test('runSteps：全部通过；普通异常也记成失败', async () => {
  const passed = await runSteps([{ name: '一', run: async () => undefined }], {});
  assert.equal(passed.ok, true);
  assert.equal(passed.results[0].detail, '');
  const thrown = await runSteps([{ name: '炸', run: async () => { throw new TypeError('坏了'); } }], {});
  assert.equal(thrown.ok, false);
  assert.match(thrown.results[0].error, /TypeError: 坏了/);
});

test('formatReport：说明里的竖线和换行不破坏表格', () => {
  const report = formatReport([{ name: 'x', ok: true, detail: 'a|b\nc', ms: 1500 }]);
  assert.match(report, /\| 1\. x \| 通过 \| 1\.5 秒 \| a\\\|b c \|/);
});

test('waitFor：返回第一个真值；超时报出等的是什么', async () => {
  let calls = 0;
  const value = await waitFor(async () => (++calls >= 3 ? { done: calls } : null), { interval: 5, timeout: 1000 });
  assert.deepEqual(value, { done: 3 });
  await assert.rejects(
    waitFor(async () => false, { interval: 5, timeout: 30, what: '任务完成' }),
    (error) => error instanceof E2eError && /等待任务完成超时/.test(error.message),
  );
});

test('check / expectStatus：失败时带上细节', () => {
  assert.doesNotThrow(() => check(true, '不会'));
  assert.throws(() => check(false, '出错了', { a: 1 }), (error) => error.detail.a === 1);
  const reply = { status: 403, body: { code: 'forbidden' } };
  assert.equal(expectStatus(reply, [403, 404], '越权'), reply);
  assert.throws(
    () => expectStatus(reply, 201, '建空间'),
    (error) => /建空间：期望 201，实际 403/.test(error.message) && error.detail.code === 'forbidden',
  );
});

test('parseUpOutput：取出 up.sh 打印的连接串和库名', () => {
  const text = [
    '本地全套已启动（停止：infra/dev/down.sh；日志：infra/dev/.run/*.log）',
    '  MongoDB      mongodb://127.0.0.1:27018/?replicaSet=rs0（库 metaverse_e2e_ab12cd34）',
    '  模拟 NyxID   http://127.0.0.1:8090（服务编号 dev-service）',
  ].join('\n');
  assert.deepEqual(parseUpOutput(text), {
    mongoUri: 'mongodb://127.0.0.1:27018/?replicaSet=rs0',
    database: 'metaverse_e2e_ab12cd34',
  });
  assert.equal(parseUpOutput('up.sh 失败'), null);
});

test('randomSuffix 和 freePort', async () => {
  const a = randomSuffix();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, randomSuffix());
  assert.match(randomSuffix(2), /^[0-9a-f]{4}$/);
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});

// ---------------------------------------------------------------------------
// devClient：对着模拟 NyxID 和一个回显请求头的假接口服务
// ---------------------------------------------------------------------------

let mock;
let echo;
let echoUrl;
let rolesDir;

before(async () => {
  rolesDir = await mkdtemp(join(tmpdir(), 'e2e-lib-'));
  const roles = join(rolesDir, 'roles.json');
  await writeFile(roles, JSON.stringify({ orgs: {}, permissions: { rita: ['metaverse:rebuild:write'] } }));
  mock = await startMockNyxid({ port: 0, rolesPath: roles, log: () => {} });
  echo = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => (body += part));
    request.on('end', () => {
      if (request.url === '/text') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end('binary');
        return;
      }
      response.writeHead(request.url.includes('missing') ? 404 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ method: request.method, url: request.url, headers: request.headers, body }));
    });
  });
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoUrl = `http://127.0.0.1:${echo.address().port}`;
});

after(async () => {
  await mock?.close();
  await new Promise((resolve) => echo?.close(resolve));
  await rm(rolesDir, { recursive: true, force: true });
});

const decodeClaims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

test('devClient：/api/v1 每次带新的身份令牌和转发的访问令牌', async () => {
  const call = devClient({ api: `${echoUrl}/`, nyx: mock.url });
  const first = await call('POST', '/api/v1/spaces/x/drafts', { as: 'bob', body: { baseSeq: 1 } });
  assert.equal(first.status, 200);
  assert.equal(first.body.method, 'POST');
  assert.equal(first.body.body, '{"baseSeq":1}');
  assert.equal(first.body.headers['content-type'], 'application/json');
  const identity = first.body.headers['x-nyxid-identity-token'];
  assert.equal(decodeClaims(identity).sub, 'bob');
  assert.match(first.body.headers.authorization, /^Bearer /);
  assert.equal(decodeClaims(first.body.headers.authorization.slice(7)).token_type, 'access');

  const second = await call('GET', '/api/v1/spaces/x');
  assert.equal(decodeClaims(second.body.headers['x-nyxid-identity-token']).sub, 'alice', '默认 alice');
  assert.notEqual(
    decodeClaims(second.body.headers['x-nyxid-identity-token']).jti,
    decodeClaims(identity).jti,
    '每次一个新的 jti',
  );
});

test('devClient：权限不给时按角色文件，给了就以给的为准', async () => {
  const call = devClient({ api: echoUrl, nyx: mock.url });
  const permissionsOf = (reply) => decodeClaims(reply.body.headers['x-nyxid-identity-token']).permissions;
  assert.deepEqual(permissionsOf(await call('GET', '/api/v1/spaces/x', { as: 'rita' })), ['metaverse:rebuild:write']);
  assert.deepEqual(permissionsOf(await call('GET', '/api/v1/spaces/x', { as: 'bob' })), []);
  assert.deepEqual(
    permissionsOf(await call('GET', '/api/v1/spaces/x', { as: 'bob', permissions: ['metaverse:rebuild:write'] })),
    ['metaverse:rebuild:write'],
  );
  assert.deepEqual(permissionsOf(await call('GET', '/api/v1/spaces/x', { as: 'rita', permissions: [] })), []);
});

test('devClient：/api/public 不带身份，给了分享令牌才带 Authorization: Share', async () => {
  const call = devClient({ api: echoUrl, nyx: mock.url });
  const plain = await call('GET', '/api/public/spaces/x');
  assert.equal(plain.body.headers['x-nyxid-identity-token'], undefined);
  assert.equal(plain.body.headers.authorization, undefined);
  const shared = await call('GET', '/api/public/spaces/x', { share: 'tok' });
  assert.equal(shared.body.headers.authorization, 'Share tok');
  const missing = await call('GET', '/api/public/missing');
  assert.equal(missing.status, 404);
  const text = await call('GET', '/text');
  assert.equal(text.body, 'binary', '不是 JSON 时保留文本');
});

test('devClient：取令牌失败时抛出 E2eError', async () => {
  const call = devClient({ api: echoUrl, nyx: mock.url });
  await assert.rejects(call('GET', '/api/v1/spaces/x', { as: '' }), (error) => error instanceof E2eError && /取令牌失败/.test(error.message));
});

// ---------------------------------------------------------------------------
// e2e.mjs 的参数检查（不起全套）
// ---------------------------------------------------------------------------

const script = fileURLToPath(new URL('./e2e.mjs', import.meta.url));

function runScript(args, env = {}) {
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.METAVERSE_E2E_SCAN;
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...cleanEnv, ...env } });
}

test('e2e.mjs：选了第 2 步却没给扫描文件、文件不存在、格式不对时退出码 2，不起全套', async () => {
  // 默认跑全部九步，要扫描文件。
  const missing = runScript([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /缺少扫描文件/);

  const absent = runScript(['--only', '1,2', '--scan', join(rolesDir, 'none.zip')]);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /找不到扫描文件/);

  // 本地工具 prepare / bundle 直接读的格式：Scaniverse 式 zip（网格 + 贴图）或 glb。
  const wrong = join(rolesDir, 'scan.drc');
  await writeFile(wrong, 'drc');
  const format = runScript(['--only', '1,2'], { METAVERSE_E2E_SCAN: wrong });
  assert.equal(format.status, 2);
  assert.match(format.stderr, /扫描文件必须是 \.zip、\.glb/);

  // 选了某一步却没选它依赖的步骤。
  const orphan = runScript(['--only', '1,4']);
  assert.equal(orphan.status, 2);
  assert.match(orphan.stderr, /第 4 步要连同第 3 步一起跑/);

  const unknown = runScript(['--bogus']);
  assert.equal(unknown.status, 2);
  const badOnly = runScript(['--only', '10']);
  assert.equal(badOnly.status, 2);
  assert.match(badOnly.stderr, /--only/);
});

test('e2e.mjs --help 打印说明', () => {
  const help = runScript(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /九步端到端验收/);
});

test('missingSteps：选了的步骤缺了依赖时列出来', () => {
  assert.deepEqual(missingSteps(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])), []);
  assert.deepEqual(missingSteps(new Set([1, 8, 9])), []);
  assert.deepEqual(missingSteps(new Set([1, 3])), [[3, [2]]]);
  assert.deepEqual(missingSteps(new Set([8])), [[8, [1]]]);
  assert.deepEqual(missingSteps(new Set([1, 2, 3, 6, 7])), [
    [6, [5]],
    [7, [5]],
  ]);
});

test('previewToken：从命令行给的预览链接里取令牌', () => {
  assert.equal(previewToken('http://127.0.0.1:5173/preview#t=abc_DEF-123'), 'abc_DEF-123');
  assert.equal(previewToken('https://x/preview?a=1&t=tok'), 'tok');
  assert.equal(previewToken('https://x/preview'), null);
  assert.equal(previewToken(null), null);
});

test('parseOnly：编号和区间，排好序；写法不对或越界报错', () => {
  assert.deepEqual([...parseOnly('1,8,9', 9)], [1, 8, 9]);
  assert.deepEqual([...parseOnly('9, 2-4,1', 9)], [1, 2, 3, 4, 9]);
  assert.deepEqual([...parseOnly('1-9', 9)], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const bad of ['', '0', '10', '3-2', 'a', '1,,x']) {
    assert.throws(() => parseOnly(bad, 9), /--only/, bad);
  }
});

test('runSteps：只跑部分步骤时保留原来的编号', async () => {
  const lines = [];
  const { results } = await runSteps([{ name: '地块建造', number: 8, run: async () => 'ok' }], {}, {
    log: (line) => lines.push(line),
  });
  assert.ok(lines.some((line) => line.includes('8. 地块建造')), lines.join('\n'));
  assert.match(formatReport(results), /\| 8\. 地块建造 \| 通过/);
});
