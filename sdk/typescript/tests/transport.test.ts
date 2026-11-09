import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MetaverseApi, scopePath } from '../src/transport/api.js';
import { ApiClient, ApiError, PROXY_SAFE_HEADERS } from '../src/transport/client.js';
import {
  resolveNyxToken,
  TokenError,
  tokenFileCandidates,
  tokenFromFileContent,
} from '../src/transport/token.js';
import {
  checkPartSize,
  describeJob,
  upload,
  UploadError,
  waitForJob,
} from '../src/transport/upload.js';
import { startFakeApi, type FakeApi } from './helpers/fakeApi.js';
import { removeDir, tempDir } from './helpers/workspace.js';

describe('令牌来源顺序', () => {
  const files: Record<string, string> = {
    '/home/me/.nyxid/access_token': 'default-token\n',
    '/home/me/.nyxid/profiles/builder/access_token': '{"access_token":"profile-token"}',
    '/tmp/custom-token': 'custom-token',
  };
  const readFile = (path: string) => files[path] ?? null;

  it('--token > NYXID_TOKEN > NYXID_TOKEN_FILE > --profile > 默认文件', () => {
    const env = { NYXID_TOKEN: 'env-token', NYXID_TOKEN_FILE: '/tmp/custom-token' };
    const base = { home: '/home/me', readFile, profile: 'builder' };
    expect(resolveNyxToken({ ...base, env, token: 'flag-token' })).toEqual({
      token: 'flag-token',
      source: '命令行 --token',
    });
    expect(resolveNyxToken({ ...base, env }).token).toBe('env-token');
    expect(resolveNyxToken({ ...base, env: { NYXID_TOKEN_FILE: '/tmp/custom-token' } }).token).toBe('custom-token');
    expect(resolveNyxToken({ ...base, env: {} })).toEqual({
      token: 'profile-token',
      source: '文件 /home/me/.nyxid/profiles/builder/access_token',
    });
    expect(resolveNyxToken({ home: '/home/me', readFile, env: {} }).token).toBe('default-token');
    // 空白值视为没有。
    expect(resolveNyxToken({ home: '/home/me', readFile, env: { NYXID_TOKEN: '  ' }, token: ' ' }).token).toBe(
      'default-token',
    );
  });

  it('都没有时报错并列出找过的位置', () => {
    expect(() => resolveNyxToken({ home: '/nowhere', readFile, env: {} })).toThrow(TokenError);
    try {
      resolveNyxToken({ home: '/nowhere', readFile, env: {}, profile: 'x' });
    } catch (error) {
      expect((error as Error).message).toContain('/nowhere/.nyxid/profiles/x/access_token');
    }
    expect(tokenFileCandidates({ home: '/h', env: { NYXID_TOKEN_FILE: '/f' }, profile: 'p' })).toEqual(['/f']);
  });

  it('文件内容：原文或 JSON 字段', () => {
    expect(tokenFromFileContent('abc\nsecond line')).toBe('abc');
    expect(tokenFromFileContent('{"accessToken":"x"}')).toBe('x');
    expect(tokenFromFileContent('{"token":"y"}')).toBe('y');
    expect(tokenFromFileContent('{"other":1}')).toBeNull();
    expect(tokenFromFileContent('{broken')).toBeNull();
    expect(tokenFromFileContent('   ')).toBeNull();
  });

  it('真实文件读取', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'tok'), 'file-token');
      expect(resolveNyxToken({ env: { NYXID_TOKEN_FILE: join(dir, 'tok') } }).token).toBe('file-token');
    } finally {
      removeDir(dir);
    }
  });
});

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function capturingFetch(responses: (() => Response)[], captured: Captured[]): typeof fetch {
  let index = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body });
    const make = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return make();
  }) as typeof fetch;
}

const ok = (value: unknown, status = 200) => () =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('nyxid 模式的请求构造', () => {
  it('经 NyxID 代理的地址、Bearer 令牌，只发标准请求头', async () => {
    const captured: Captured[] = [];
    const client = new ApiClient({
      mode: 'nyxid',
      slug: 'chrono-metaverse',
      token: () => 'agent-key-token',
      fetch: capturingFetch([ok({ id: 'x' })], captured),
    });
    expect(client.url('/api/v1/spaces/front-hall', { seq: 3, skip: undefined })).toBe(
      'https://nyx-api.chrono-ai.fun/api/v1/proxy/s/chrono-metaverse/api/v1/spaces/front-hall?seq=3',
    );
    await client.json('POST', '/api/v1/spaces/front-hall/drafts', {
      json: { baseSeq: 3 },
      ifMatch: '"3"',
      idempotencyKey: 'k1',
    });
    const request = captured[0]!;
    expect(request.method).toBe('POST');
    expect(request.headers.authorization).toBe('Bearer agent-key-token');
    expect(request.headers['if-match']).toBe('"3"');
    expect(request.headers['idempotency-key']).toBe('k1');
    expect(request.headers['content-type']).toBe('application/json');
    for (const key of Object.keys(request.headers)) expect(PROXY_SAFE_HEADERS.has(key)).toBe(true);
    expect(request.body).toBe('{"baseSeq":3}');
  });

  it('自定义 NyxID 地址和 slug；路径必须以 /api/ 开头', () => {
    const client = new ApiClient({ mode: 'nyxid', nyxBase: 'https://nyx.example/', slug: 'my svc', token: () => 't' });
    expect(client.url('/api/v1/x')).toBe('https://nyx.example/api/v1/proxy/s/my%20svc/api/v1/x');
    expect(() => client.url('/v1/x')).toThrow(ApiError);
  });

  it('没有令牌函数时报错', async () => {
    const client = new ApiClient({ mode: 'nyxid', fetch: capturingFetch([ok({})], []) });
    await expect(client.json('GET', '/api/v1/x')).rejects.toThrow('没有令牌');
  });
});

describe('direct 模式的请求构造', () => {
  it('每个请求先取一对新令牌，带 X-NyxID-Identity-Token 和 Bearer', async () => {
    const captured: Captured[] = [];
    let n = 0;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      captured.push({ url, method: init?.method ?? 'GET', headers, body: init?.body });
      if (url.endsWith('/dev/token')) {
        n += 1;
        return ok({ identityToken: `id-${n}`, accessToken: `acc-${n}` })();
      }
      return ok({ ok: true })();
    }) as typeof fetch;
    const client = new ApiClient({
      mode: 'direct',
      api: 'http://127.0.0.1:8080/',
      devTokenUrl: 'http://127.0.0.1:8090/dev/token',
      devSub: 'org-1',
      devOrgRole: 'admin',
      fetch: fetcher,
    });
    await client.json('GET', '/api/v1/spaces/a');
    await client.json('GET', '/api/v1/spaces/a');
    expect(captured.map((c) => c.url)).toEqual([
      'http://127.0.0.1:8090/dev/token',
      'http://127.0.0.1:8080/api/v1/spaces/a',
      'http://127.0.0.1:8090/dev/token',
      'http://127.0.0.1:8080/api/v1/spaces/a',
    ]);
    expect(JSON.parse(captured[0]!.body as string)).toEqual({ sub: 'org-1', orgRole: 'admin' });
    expect(captured[1]!.headers['x-nyxid-identity-token']).toBe('id-1');
    expect(captured[1]!.headers.authorization).toBe('Bearer acc-1');
    expect(captured[3]!.headers['x-nyxid-identity-token']).toBe('id-2');
  });

  it('缺少地址或取令牌失败时报错', async () => {
    expect(() => new ApiClient({ mode: 'direct', devTokenUrl: 'http://x' })).toThrow('接口服务地址');
    expect(() => new ApiClient({ mode: 'direct', api: 'http://x' })).toThrow('取令牌地址');
    const client = new ApiClient({
      mode: 'direct',
      api: 'http://a',
      devTokenUrl: 'http://t',
      fetch: capturingFetch([() => new Response('no', { status: 500 })], []),
    });
    await expect(client.json('GET', '/api/v1/x')).rejects.toThrow('取开发令牌失败');
    const bad = new ApiClient({
      mode: 'direct',
      api: 'http://a',
      devTokenUrl: 'http://t',
      fetch: capturingFetch([ok({ identityToken: 1 })], []),
    });
    await expect(bad.json('GET', '/api/v1/x')).rejects.toThrow('identityToken');
  });
});

describe('错误和重试', () => {
  it('按问题文档解析 code 和 detail，带上提示', async () => {
    const client = new ApiClient({
      mode: 'nyxid',
      token: () => 't',
      fetch: capturingFetch(
        [
          () =>
            new Response(JSON.stringify({ code: 'forbidden', detail: '没有写入权限' }), {
              status: 403,
              headers: { 'content-type': 'application/problem+json' },
            }),
        ],
        [],
      ),
    });
    const error = (await client.json('POST', '/api/v1/x').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('没有写入权限');
    expect(error.message).toContain('操作范围');
  });

  it('GET 遇到 503 和网络错误自动重试，POST 不重试', async () => {
    const captured: Captured[] = [];
    let calls = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      captured.push({ url: String(input), method: init?.method ?? 'GET', headers: {}, body: undefined });
      if (calls === 1) throw new Error('connection reset');
      if (calls === 2) return new Response('busy', { status: 503 });
      return ok({ fine: true })();
    }) as typeof fetch;
    const client = new ApiClient({ mode: 'nyxid', token: () => 't', fetch: flaky, retryDelayMs: 0 });
    expect(await client.json('GET', '/api/v1/x')).toEqual({ fine: true });
    expect(calls).toBe(3);
    const once = new ApiClient({
      mode: 'nyxid',
      token: () => 't',
      retryDelayMs: 0,
      fetch: capturingFetch([() => new Response('busy', { status: 503 })], captured),
    });
    await expect(once.json('POST', '/api/v1/x')).rejects.toMatchObject({ status: 503 });
    const network = new ApiClient({
      mode: 'nyxid',
      token: () => 't',
      retries: 0,
      fetch: (async () => {
        throw new Error('down');
      }) as typeof fetch,
    });
    await expect(network.json('GET', '/api/v1/x')).rejects.toThrow('网络错误');
  });

  it('allow 里的状态码不当作错误；空响应体解析成 {}', async () => {
    const client = new ApiClient({
      mode: 'nyxid',
      token: () => 't',
      fetch: capturingFetch([() => new Response(null, { status: 404 }), () => new Response('', { status: 200 })], []),
    });
    expect((await client.request('GET', '/api/v1/x', { allow: [404] })).status).toBe(404);
    expect(await client.json('PUT', '/api/v1/y', { body: new Uint8Array([1]) })).toEqual({});
  });
});

describe('分片上传（本地假服务器）', () => {
  let fake: FakeApi;
  afterEach(async () => {
    await fake?.close();
  });

  function api(): MetaverseApi {
    return new MetaverseApi(
      new ApiClient({ mode: 'direct', api: fake.url, devTokenUrl: fake.devTokenUrl, retryDelayMs: 0 }),
      'demo-space',
    );
  }

  it('分片大小必须是 256KiB 的整数倍、不超过 32MiB', () => {
    expect(() => checkPartSize(256 * 1024)).not.toThrow();
    expect(() => checkPartSize(1000)).toThrow(UploadError);
    expect(() => checkPartSize(64 * 1024 * 1024)).toThrow(UploadError);
  });

  it('按片上传、最后一片较小、完成后等校验任务', async () => {
    fake = await startFakeApi();
    const bytes = new Uint8Array(256 * 1024 * 2 + 1000).map((_, i) => i % 251);
    const progress: number[] = [];
    const result = await upload(api(), {
      purpose: 'ops',
      source: { bytes },
      partSize: 256 * 1024,
      contentType: 'application/x-ndjson',
      onProgress: (sent) => progress.push(sent),
    });
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(result).toMatchObject({ assetHash: sha, reused: false, parts: 3, size: bytes.length });
    expect(progress).toEqual([262144, 524288, 525288]);
    const parts = fake.requests.filter((r) => r.method === 'PUT');
    expect(parts.map((r) => r.path.split('/').pop())).toEqual(['0', '1', '2']);
    expect(parts.map((r) => r.body.length)).toEqual([262144, 262144, 1000]);
    const create = fake.requests.find((r) => r.path.endsWith('/uploads/ops') && r.method === 'POST')!;
    expect(JSON.parse(create.body.toString())).toEqual({
      size: bytes.length,
      sha256: sha,
      partSize: 262144,
      contentType: 'application/x-ndjson',
    });
    // 每个请求都带了新的开发令牌。
    const tokens = fake.requests.filter((r) => r.headers['x-nyxid-identity-token']).map((r) => r.headers['x-nyxid-identity-token']);
    expect(new Set(tokens).size).toBe(tokens.length);
    const job = await waitForJob(api(), result.jobId!, { sleep: async () => {} });
    expect(job.status).toBe('done');
    expect(fake.state.assets.has(sha)).toBe(true);
  });

  it('内容已存在时直接复用，不传数据', async () => {
    const bytes = new TextEncoder().encode('{"op":"fill"}\n');
    const sha = createHash('sha256').update(bytes).digest('hex');
    fake = await startFakeApi({ assets: new Map([[sha, Buffer.from(bytes)]]) });
    const result = await upload(api(), { purpose: 'ops', source: { bytes } });
    expect(result).toMatchObject({ reused: true, jobId: null, assetHash: sha, parts: 0 });
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('从文件上传，地块路径；分片 503 时重试', async () => {
    fake = await startFakeApi({ failNextPart: true });
    const dir = tempDir();
    try {
      const file = join(dir, 'model.glb');
      writeFileSync(file, Buffer.alloc(300 * 1024, 7));
      const result = await upload(api(), { purpose: 'model', source: { path: file }, plot: 'p1', partSize: 256 * 1024 });
      expect(result.parts).toBe(2);
      const puts = fake.requests.filter((r) => r.method === 'PUT');
      expect(puts).toHaveLength(3);
      expect(puts[0]!.path).toMatch(/^\/api\/v1\/spaces\/demo-space\/plots\/p1\/uploads\/model\/up-\d+\/parts\/0$/);
    } finally {
      removeDir(dir);
    }
  });

  it('空文件和地块路径下上传扫描都被拒绝', async () => {
    fake = await startFakeApi();
    await expect(upload(api(), { purpose: 'ops', source: { bytes: new Uint8Array() } })).rejects.toThrow('空文件');
    await expect(
      upload(api(), { purpose: 'scan', source: { bytes: new Uint8Array([1]) }, plot: 'p1' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('任务失败时报出 lastError；状态说明', async () => {
    fake = await startFakeApi();
    fake.state.jobs.set('job-x', { id: 'job-x', kind: 'scan_import', polls: 0, runningPolls: 1, fail: '解析失败' });
    const updates: string[] = [];
    await expect(
      waitForJob(api(), 'job-x', { sleep: async () => {}, onUpdate: (job) => updates.push(describeJob(job)) }),
    ).rejects.toThrow('解析失败');
    expect(updates[0]).toContain('处理中');
    expect(updates[1]).toContain('失败');
    expect(scopePath('a b', 'p/1')).toBe('/api/v1/spaces/a%20b/plots/p%2F1');
  });
});
