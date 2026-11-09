// 九步验收脚本（e2e.mjs）用的小工具，单独放一个文件方便测试（e2e-lib.test.mjs）。
// Node 22，无第三方依赖。

import { createServer } from 'node:net';
import { inflateSync } from 'node:zlib';

/** 验收失败：带上步骤里看到的事实，打印给人看。 */
export class E2eError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'E2eError';
    this.detail = detail;
  }
}

/** 断言：不成立时抛 E2eError。 */
export function check(condition, message, detail) {
  if (!condition) throw new E2eError(message, detail);
}

/** 断言 HTTP 状态码。 */
export function expectStatus(reply, expected, what) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  check(
    allowed.includes(reply.status),
    `${what}：期望 ${allowed.join(' 或 ')}，实际 ${reply.status}`,
    reply.body,
  );
  return reply;
}

/** 让系统挑一个本机空闲端口。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 每隔 `interval` 毫秒调用一次 `probe`，返回第一个"真"值；超时抛 E2eError。 */
export async function waitFor(probe, { timeout = 30_000, interval = 500, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() >= deadline) throw new E2eError(`等待${what}超时（${Math.round(timeout / 1000)} 秒）`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * 调用本地接口服务的客户端，请求头与 call.mjs 相同：
 * - `/api/v1/*`：每次先向模拟 NyxID 取一对新令牌，带 `X-NyxID-Identity-Token` 和
 *   `Authorization: Bearer <访问令牌>`；
 * - `/api/public/*`：不带身份，给了 `share` 时带 `Authorization: Share <令牌>`。
 * 返回 `{status, headers, body}`；body 能按 JSON 解析就解析，否则是文本。
 */
export function devClient({ api, nyx, fetchImpl = fetch }) {
  const base = api.replace(/\/$/, '');
  const nyxBase = nyx.replace(/\/$/, '');
  return async function call(method, path, { as = 'alice', body, share, orgRole, headers: extra } = {}) {
    const headers = { accept: 'application/json', ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (path.startsWith('/api/v1/')) {
      const tokenRequest = { sub: as, ...(orgRole ? { orgRole } : {}) };
      const tokenReply = await fetchImpl(`${nyxBase}/dev/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tokenRequest),
      });
      const tokens = await tokenReply.json();
      if (!tokenReply.ok) throw new E2eError(`取令牌失败：${tokenReply.status}`, tokens);
      headers['x-nyxid-identity-token'] = tokens.identityToken;
      headers.authorization = `Bearer ${tokens.accessToken}`;
    } else if (share !== undefined) {
      headers.authorization = `Share ${share}`;
    }
    const reply = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      redirect: 'manual',
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await reply.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // 不是 JSON（区块、资源），保留文本长度就够了。
    }
    return { status: reply.status, headers: reply.headers, body: parsed, size: text.length };
  };
}

/** 从 up.sh 的输出里取 MongoDB 连接串（"MongoDB      <连接串>（库 <库名>）"）。 */
export function parseUpOutput(text) {
  const match = /MongoDB\s+(mongodb(?:\+srv)?:\/\/[^\s（]+)（库 ([^）]+)）/.exec(text);
  return match ? { mongoUri: match[1], database: match[2] } : null;
}

/** 随机后缀（小写十六进制）：库名、空间编号用，每次验收互不干扰。 */
export function randomSuffix(bytes = 4) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 按顺序执行步骤，遇到第一个失败就停止（后面的步骤依赖前面的结果）。
 * 每个步骤是 `{name, run}`，`run(context)` 返回给人看的说明（字符串）。
 * 返回 `{ok, results}`，results 里每项 `{name, ok, detail, ms, error?}`；没执行的步骤标 `skipped`。
 */
export async function runSteps(steps, context, { log = () => {} } = {}) {
  const results = [];
  let failed = false;
  for (const [index, step] of steps.entries()) {
    const label = `${index + 1}. ${step.name}`;
    if (failed) {
      results.push({ name: step.name, ok: false, skipped: true, detail: '前面的步骤失败，没有执行', ms: 0 });
      continue;
    }
    log(`▶ ${label}`);
    const started = Date.now();
    try {
      const detail = (await step.run(context)) ?? '';
      const ms = Date.now() - started;
      results.push({ name: step.name, ok: true, detail, ms });
      log(`✔ ${label}（${(ms / 1000).toFixed(1)} 秒）${detail ? `：${detail}` : ''}`);
    } catch (error) {
      failed = true;
      const ms = Date.now() - started;
      results.push({
        name: step.name,
        ok: false,
        detail: error.message,
        error: error instanceof E2eError ? error.detail : error.stack,
        ms,
      });
      log(`✘ ${label}：${error.message}`);
      if (error instanceof E2eError && error.detail !== undefined) {
        log(`  ${JSON.stringify(error.detail).slice(0, 2000)}`);
      }
    }
  }
  return { ok: !failed, results };
}

/** 结果表（Markdown），打印到终端，也写进 report.md。 */
export function formatReport(results) {
  const lines = ['| 步骤 | 结果 | 耗时 | 说明 |', '|---|---|---|---|'];
  for (const [index, result] of results.entries()) {
    const state = result.skipped ? '未执行' : result.ok ? '通过' : '失败';
    const detail = String(result.detail ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    lines.push(`| ${index + 1}. ${result.name} | ${state} | ${(result.ms / 1000).toFixed(1)} 秒 | ${detail} |`);
  }
  return lines.join('\n');
}

/** 最小 PNG 解码（8 位 RGB / RGBA、不隔行，Chromium 截图就是这种），与 web/e2e/png.ts 相同。 */
export function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('只支持 8 位、不隔行的 PNG');
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (channels === 0) throw new Error(`不支持的颜色类型 ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** 中央一半区域：亮像素（亮度 > 60）的比例和不同颜色（每通道取高 4 位）的数量。 */
export function imageStats({ width, height, channels, pixels }) {
  let bright = 0;
  let total = 0;
  const colors = new Set();
  for (let y = Math.floor(height / 4); y < Math.floor((height * 3) / 4); y += 2) {
    for (let x = Math.floor(width / 4); x < Math.floor((width * 3) / 4); x += 2) {
      const i = (y * width + x) * channels;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (0.2126 * r + 0.7152 * g + 0.0722 * b > 60) bright += 1;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      total += 1;
    }
  }
  return { brightRatio: total === 0 ? 0 : bright / total, colors: colors.size };
}

/** 截图"画出了东西"：不是一片纯色（颜色数够多），也不是几乎全黑。 */
export function looksRendered(stats, { minColors = 12, minBright = 0.02 } = {}) {
  return stats.colors >= minColors && stats.brightRatio >= minBright;
}
