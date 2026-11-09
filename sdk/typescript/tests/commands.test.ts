import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/commands/index.js';
import { messageError, previewLink } from '../src/commands/push.js';
import { parseTransform, scanFormat } from '../src/commands/scan.js';
import { runVoxelize } from '../src/commands/voxelize.js';
import { describeAuthored, INLINE_AUTHORED_BYTES } from '../src/commands/authored.js';
import { validateLayout } from '../src/commands/admin.js';
import { chunkHash, compressChunk, emptyChunk } from '../src/core/chunk.js';
import { MetaverseApi } from '../src/transport/api.js';
import { ApiClient } from '../src/transport/client.js';
import { upload } from '../src/transport/upload.js';
import { readConfig, writeConfig } from '../src/workspace/config.js';
import { readBase } from '../src/workspace/files.js';
import { fakeGlb, startFakeApi, type FakeApi } from './helpers/fakeApi.js';
import {
  PALETTE,
  PLOTS,
  REGIONS,
  makeContext,
  makeWorkspace,
  removeDir,
  tempDir,
} from './helpers/workspace.js';

let fake: FakeApi | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await fake?.close();
  fake = null;
  while (dirs.length > 0) removeDir(dirs.pop()!);
});

function directWorkspace(api: FakeApi, script?: string): string {
  const root = makeWorkspace({
    config: {
      mode: 'direct',
      api: api.url,
      devTokenUrl: api.devTokenUrl,
      devSub: 'org-1',
      webUrl: 'https://m.example',
    },
    ...(script !== undefined ? { script } : {}),
  });
  dirs.push(root);
  return root;
}

function remoteSnapshot() {
  const cells = emptyChunk();
  cells[0] = 2;
  cells[1] = 3;
  const hash = chunkHash(cells);
  const model = Buffer.from('glTF fake model');
  const modelHash = createHash('sha256').update(model).digest('hex');
  return {
    hash,
    model,
    modelHash,
    state: {
      space: {
        id: 'demo-space',
        name: '演示空间',
        description: '说明',
        visibility: 'unlisted',
        head: { seq: 5, at: '2026-11-05T00:00:00.000Z' },
        regions: REGIONS,
        plots: PLOTS,
        anchors: [
          { anchorId: 'cam-1', kind: 'camera', position: [1, 2, 1], visibility: 'internal' },
        ],
      },
      snapshot: {
        spaceId: 'demo-space',
        seq: 5,
        at: '2026-11-05T00:00:00.000Z',
        paletteHash: 'a'.repeat(64),
        palette: { hash: 'a'.repeat(64), blocks: PALETTE },
        chunks: [{ layer: 'rebuilt', cx: 0, cy: 0, cz: 0, hash }],
        entities: [
          {
            id: 'wall-1',
            hash: 'x',
            body: {
              entityId: 'wall-1',
              layer: 'rebuilt',
              kind: 'structure',
              shape: { type: 'box', size: [4, 3, 0.1] },
              bounds: { min: [-2, 0, -0.05], max: [2, 3, 0.05] },
            },
          },
        ],
        anchors: [
          { anchorId: 'cam-1', kind: 'camera', position: [1, 2, 1], visibility: 'internal' },
        ],
        regions: REGIONS,
        plots: PLOTS,
        scan: {
          assetHash: 'c'.repeat(64),
          webModelHashes: [modelHash],
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      },
      chunks: new Map([[hash, Buffer.from(compressChunk(cells))]]),
      assets: new Map([[modelHash, model]]),
    },
  };
}

describe('metaverse pull', () => {
  it('下载空间、快照、区块和网页用模型（direct 模式，每个请求都有新令牌）', async () => {
    const remote = remoteSnapshot();
    fake = await startFakeApi(remote.state);
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['pull'])).toBe(0);
    expect(ctx.lines[0]).toContain('seq 5（最新）');
    const base = readBase(root, 'demo-space');
    expect(base.space).toMatchObject({ seq: 5, name: '演示空间', paletteHash: 'a'.repeat(64) });
    expect(base.chunks).toEqual([{ layer: 'rebuilt', cx: 0, cy: 0, cz: 0, hash: remote.hash }]);
    expect(base.entities[0]).toMatchObject({ entityId: 'wall-1', props: {} });
    expect(existsSync(join(root, 'chunks', `${remote.hash}.bin`))).toBe(true);
    expect(readFileSync(join(root, 'assets', `${remote.modelHash}.glb`))).toEqual(remote.model);
    expect(existsSync(join(root, '.claude/skills/metaverse-builder/SKILL.md'))).toBe(true);
    const apiRequests = fake.requests.filter((r) => r.path.startsWith('/api/'));
    expect(apiRequests.every((r) => typeof r.headers['x-nyxid-identity-token'] === 'string')).toBe(
      true,
    );
    expect(
      apiRequests.every((r) => r.headers.authorization?.toString().startsWith('Bearer access-')),
    ).toBe(true);
    const tokenRequests = fake.requests.filter((r) => r.path === '/dev/token');
    expect(tokenRequests).toHaveLength(apiRequests.length);
    expect(JSON.parse(tokenRequests[0]!.body.toString())).toEqual({ sub: 'org-1' });
    // 再拉一次：区块已经有了，不重复下载。
    const before = fake.requests.filter((r) => r.path.includes('/chunks/')).length;
    expect(await main(ctx, ['pull', '--json'])).toBe(0);
    expect(fake.requests.filter((r) => r.path.includes('/chunks/')).length).toBe(before);
    expect(JSON.parse(ctx.lines.at(-1)!)).toMatchObject({ seq: 5, downloadedChunks: 0, chunks: 1 });
  });

  it('新空间（seq 0）没有快照；区块哈希不符时报错', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    expect(await main(makeContext(root), ['pull'])).toBe(0);
    expect(readBase(root, 'demo-space').space.seq).toBe(0);
    const remote = remoteSnapshot();
    remote.state.chunks.set(remote.hash, Buffer.from(compressChunk(emptyChunk())));
    await fake.close();
    fake = await startFakeApi(remote.state);
    const root2 = directWorkspace(fake);
    const ctx = makeContext(root2);
    expect(await main(ctx, ['pull'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('哈希');
    expect(await main(ctx, ['pull', '--seq', '9'])).toBe(1);
  });

  it('nyxid 模式经代理路径，令牌按顺序取', async () => {
    const remote = remoteSnapshot();
    fake = await startFakeApi(remote.state);
    const root = makeWorkspace({ config: { mode: 'nyxid', slug: 'chrono-metaverse' } });
    dirs.push(root);
    // 假 NyxID 在本机回环地址上，只能由用户自己用 --nyx-base / METAVERSE_NYX_BASE 指定。
    const ctx = makeContext(root, { NYXID_TOKEN: 'agent-key-1', HOME: '/nonexistent' });
    expect(await main(ctx, ['pull', '--token', 'flag-key', '--nyx-base', fake.url])).toBe(0);
    const request = fake.requests.find((r) => r.path.endsWith('/api/v1/spaces/demo-space'))!;
    expect(request.path).toBe('/api/v1/proxy/s/chrono-metaverse/api/v1/spaces/demo-space');
    expect(request.headers.authorization).toBe('Bearer flag-key');
    expect(request.headers['x-nyxid-identity-token']).toBeUndefined();
    // 不是内置的可信地址：提示令牌的去向（不含令牌本身）。
    expect(ctx.errors.join('\n')).toContain(`NyxID 令牌（命令行 --token）将发给 ${fake.url}`);
    expect(ctx.errors.join('\n')).not.toContain('flag-key');
    const envCtx = makeContext(root, { NYXID_TOKEN: 'agent-key-1', METAVERSE_NYX_BASE: fake.url });
    expect(await main(envCtx, ['pull'])).toBe(0);
    expect(fake.requests.at(-1)!.headers.authorization).toBe('Bearer agent-key-1');
    // 找不到令牌。
    const noToken = makeContext(root, {
      NYXID_TOKEN_FILE: join(root, 'missing'),
      METAVERSE_NYX_BASE: fake.url,
    });
    expect(await main(noToken, ['pull'])).toBe(1);
    expect(noToken.errors.at(-1)).toContain('找不到 NyxID 令牌');
  });
});

/** 记录请求地址的 fetch：每个请求都回 404，命令以退出码 1 结束。 */
function recordingFetch(urls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ code: 'not_found', detail: '没有' }), {
      status: 404,
      headers: { 'content-type': 'application/problem+json' },
    });
  }) as typeof fetch;
}

describe('nyxid 模式的令牌只发给可信地址或用户自己指定的地址', () => {
  it('上级目录的 metaverse.json 把 nyxBase 指到别处（明文 http）：拒绝，一个请求都不发', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = makeWorkspace({
      spaceId: 'lobby',
      config: { mode: 'nyxid', nyxBase: fake.url },
    });
    dirs.push(root);
    const sub = join(root, 'sub');
    mkdirSync(sub);
    const env = { NYXID_TOKEN: 'secret-nyxid-agent-key', HOME: '/nonexistent' };
    for (const args of [
      ['pull'],
      ['admin', 'rotate-share-token'],
      ['admin', 'update-space', '--name', '改名'],
      ['admin', 'create-space', 'lobby', '--name', '大厅', '--owner', 'org-1'],
      // 用户自己给了 --nyx-base 也不行：工作区配置本身不合格，要先改掉。
      ['pull', '--nyx-base', 'https://nyx-api.chrono-ai.fun'],
    ]) {
      const ctx = makeContext(sub, env);
      expect(await main(ctx, args)).toBe(1);
      expect(ctx.errors.at(-1)).toContain('nyxBase 只能是');
      expect(ctx.errors.join('\n')).not.toContain('secret-nyxid-agent-key');
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('metaverse.json 的 nyxBase 是 https 但不在可信列表里：同样拒绝', async () => {
    for (const nyxBase of [
      'https://evil.example',
      'https://nyx-api.chrono-ai.fun.evil.example',
      'https://nyx-api.chrono-ai.fun:8443',
      'https://api.nyxid.ai/proxy',
    ]) {
      const root = makeWorkspace({ config: { mode: 'nyxid', nyxBase } });
      dirs.push(root);
      const urls: string[] = [];
      const ctx = { ...makeContext(root, { NYXID_TOKEN: 'k' }), fetch: recordingFetch(urls) };
      expect(await main(ctx, ['pull'])).toBe(1);
      expect(ctx.errors.at(-1)).toContain('nyxBase 只能是');
      expect(urls).toEqual([]);
    }
  });

  it('metaverse.json 写可信地址时照常使用，不提示', async () => {
    const root = makeWorkspace({ config: { mode: 'nyxid', nyxBase: 'https://api.nyxid.ai/' } });
    dirs.push(root);
    const urls: string[] = [];
    const ctx = { ...makeContext(root, { NYXID_TOKEN: 'k' }), fetch: recordingFetch(urls) };
    expect(await main(ctx, ['pull'])).toBe(1); // 假服务回 404
    expect(urls[0]).toBe(
      'https://api.nyxid.ai/api/v1/proxy/s/chrono-metaverse/api/v1/spaces/demo-space',
    );
    expect(ctx.errors.join('\n')).not.toContain('注意');
    // 没写 nyxBase 时用默认地址。
    const plain = makeWorkspace({ config: { mode: 'nyxid' } });
    dirs.push(plain);
    const plainUrls: string[] = [];
    const plainCtx = {
      ...makeContext(plain, { NYXID_TOKEN: 'k' }),
      fetch: recordingFetch(plainUrls),
    };
    expect(await main(plainCtx, ['pull'])).toBe(1);
    expect(plainUrls[0]).toMatch(/^https:\/\/nyx-api\.chrono-ai\.fun\/api\/v1\/proxy\/s\//);
  });

  it('--nyx-base 优先于 METAVERSE_NYX_BASE；自定义的 https 地址可以用，但会提示', async () => {
    const root = makeWorkspace({ config: { mode: 'nyxid' } });
    dirs.push(root);
    const urls: string[] = [];
    const env = { NYXID_TOKEN: 'k', METAVERSE_NYX_BASE: 'https://env.example/' };
    const ctx = { ...makeContext(root, env), fetch: recordingFetch(urls) };
    expect(await main(ctx, ['pull'])).toBe(1);
    expect(urls[0]).toMatch(/^https:\/\/env\.example\/api\/v1\/proxy\/s\/chrono-metaverse\//);
    expect(ctx.errors[0]).toContain('将发给 https://env.example，它不是内置的可信地址');
    expect(await main(ctx, ['pull', '--nyx-base', 'https://flag.example'])).toBe(1);
    expect(urls.at(-1)).toMatch(/^https:\/\/flag\.example\//);
    // 空的环境变量当作没设。
    const emptyCtx = {
      ...makeContext(root, { NYXID_TOKEN: 'k', METAVERSE_NYX_BASE: '' }),
      fetch: recordingFetch(urls),
    };
    expect(await main(emptyCtx, ['pull'])).toBe(1);
    expect(urls.at(-1)).toMatch(/^https:\/\/nyx-api\.chrono-ai\.fun\//);
  });

  it('显式指定的地址也必须是 https（回环地址除外）；profile、slug 不能拼路径', async () => {
    const root = makeWorkspace({ config: { mode: 'nyxid' } });
    dirs.push(root);
    const urls: string[] = [];
    const cases: [Record<string, string>, string[], string][] = [
      [{}, ['--nyx-base', 'http://evil.example'], '--nyx-base 必须是 https'],
      [{ METAVERSE_NYX_BASE: 'http://10.0.0.5:8080' }, [], 'METAVERSE_NYX_BASE 必须是 https'],
      [{}, ['--nyx-base', 'https://user:hunter2@nyx.example'], '不能带账号密码'],
      [{}, ['--nyx-base', 'https://nyx.example/x?y=1'], '不能带路径'],
      [{}, ['--nyx-base', 'nyx.example'], '不是合法的地址'],
      [{}, ['--nyx-base', 'ftp://nyx.example'], '必须是 https'],
      [{}, ['--profile', '../../x'], '--profile 只能用'],
      [{}, ['--slug', '..'], '--slug 只能用'],
    ];
    for (const [env, args, message] of cases) {
      const ctx = {
        ...makeContext(root, { NYXID_TOKEN: 'k', ...env }),
        fetch: recordingFetch(urls),
      };
      expect(await main(ctx, ['pull', ...args])).toBe(1);
      expect(ctx.errors.at(-1)).toContain(message);
      expect(ctx.errors.at(-1)).not.toContain('hunter2');
    }
    expect(urls).toEqual([]);
  });
});

const PUSH_SCRIPT = `export default (base, kit) => ({
  message: '放两张桌子',
  ops: [
    kit.place('table-1', kit.table({ at: [5.8, 0, 0.8] })),
    kit.place('table-2', kit.table({ at: [6.2, 0, 1.4], top: 'round', width: 0.6 })),
  ],
});`;

describe('metaverse push / publish', () => {
  it('上传 NDJSON → 建草稿 → ops-from-upload → 预览，打印草稿编号和预览链接', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = directWorkspace(fake, PUSH_SCRIPT);
    const ctx = makeContext(root);
    expect(await main(ctx, ['push', '--plot', 'p1'])).toBe(0);
    const text = ctx.lines.join('\n');
    expect(text).toContain('时间线已从 seq 3 前进到 5');
    expect(text).toContain('草稿编号：draft-');
    expect(text).toContain('预览链接：https://m.example/preview#t=preview-token-abc');
    const create = fake.requests.find(
      (r) => r.path === '/api/v1/spaces/demo-space/plots/p1/drafts',
    )!;
    // 建草稿只带 baseSeq（接口服务拒绝未知字段）；说明记进 drafts.json，发布时再给。
    expect(JSON.parse(create.body.toString())).toEqual({ baseSeq: 3 });
    expect(text).toContain('提交说明（发布时使用）：放两张桌子');
    const draft = [...fake.state.drafts.values()][0]!;
    expect(draft.scopePath).toBe('/api/v1/spaces/demo-space/plots/p1');
    expect(draft.ops.map((op) => (op as { op: string }).op)).toEqual([
      'placeEntity',
      'placeEntity',
    ]);
    const upload = fake.requests.find((r) => r.path.endsWith('/plots/p1/uploads/ops'))!;
    const uploadBody = JSON.parse(upload.body.toString()) as Record<string, unknown>;
    expect(Object.keys(uploadBody).sort()).toEqual(['format', 'partSize', 'sha256', 'size']);
    expect(uploadBody).toMatchObject({ format: 'ndjson', partSize: 8388608 });
    // ops-from-upload 只带上传编号（接口服务要求 uploadId 和 assetHash 二选一）。
    const fromUpload = fake.requests.find((r) => r.path.endsWith('/ops-from-upload'))!;
    expect(fromUpload.path).toMatch(/^\/api\/v1\/spaces\/demo-space\/plots\/p1\/drafts\//);
    expect(JSON.parse(fromUpload.body.toString())).toEqual({
      uploadId: [...fake.state.uploads.values()][0]!.id,
    });
    const drafts = JSON.parse(readFileSync(join(root, 'out/drafts.json'), 'utf8')) as Record<
      string,
      { plot: string; message?: string }
    >;
    const draftId = Object.keys(drafts)[0]!;
    expect(drafts[draftId]).toMatchObject({ plot: 'p1', message: '放两张桌子' });
    // 发布：草稿记住了地块，走同一范围的路径。
    const publishCtx = makeContext(root);
    expect(await main(publishCtx, ['publish', draftId, '--message', '确认'])).toBe(0);
    expect(publishCtx.lines[0]).toContain('seq 6');
    const publish = fake.requests.at(-1)!;
    expect(publish.path).toBe(`/api/v1/spaces/demo-space/plots/p1/drafts/${draftId}/publish`);
    expect(JSON.parse(publish.body.toString())).toEqual({ message: '确认' });
    // 不给 --message 时用 push 时记下的说明（建造脚本返回的 message）。
    expect(await main(makeContext(root), ['publish', draftId])).toBe(0);
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({ message: '放两张桌子' });
  });

  it('--message 覆盖脚本的说明；说明不合法时不推送、不发布', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = directWorkspace(fake, PUSH_SCRIPT);
    const ctx = makeContext(root);
    expect(
      await main(ctx, ['push', '--plot', 'p1', '--no-preview', '--json', '--message', '改说明']),
    ).toBe(0);
    const out = JSON.parse(ctx.lines.at(-1)!) as { draftId: string; message: string };
    expect(out.message).toBe('改说明');
    expect(await main(ctx, ['publish', out.draftId])).toBe(0);
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({ message: '改说明' });
    const before = fake.requests.length;
    expect(await main(ctx, ['push', '--plot', 'p1', '--message', '  '])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('不能为空');
    expect(await main(ctx, ['push', '--plot', 'p1', '--message', 'x'.repeat(2001)])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('2000');
    expect(await main(ctx, ['publish', out.draftId, '--message', 'a\u0007b'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('控制字符');
    expect(fake.requests.length).toBe(before);
    expect(messageError('第一行\n第二行')).toBeNull();
    expect(messageError('回车\r')).not.toBeNull();
  });

  it('操作文件已经传过（复用已有内容）时，ops-from-upload 仍然只带上传编号', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = directWorkspace(fake, PUSH_SCRIPT);
    expect(await main(makeContext(root), ['push', '--plot', 'p1', '--no-preview'])).toBe(0);
    expect(await main(makeContext(root), ['push', '--plot', 'p1', '--no-preview'])).toBe(0);
    const uploads = [...fake.state.uploads.values()];
    expect(uploads.map((u) => u.reused)).toEqual([false, true]);
    const bodies = fake.requests
      .filter((r) => r.path.endsWith('/ops-from-upload'))
      .map((r) => JSON.parse(r.body.toString()) as unknown);
    expect(bodies).toEqual([{ uploadId: uploads[0]!.id }, { uploadId: uploads[1]!.id }]);
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it('ops-from-upload 两个字段都给、都不给时，接口服务返回 422；只给资源哈希也行', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const api = new MetaverseApi(
      new ApiClient({ mode: 'direct', api: fake.url, devTokenUrl: fake.devTokenUrl }),
      'demo-space',
    );
    const ndjson = new TextEncoder().encode('{"op":"removeEntity","entityId":"x"}\n');
    const uploaded = await upload(api, {
      purpose: 'ops',
      source: { bytes: ndjson },
      format: 'ndjson',
    });
    const draft = await api.createDraft({ baseSeq: 5 });
    const both = { uploadId: uploaded.uploadId!, assetHash: uploaded.assetHash } as unknown as {
      uploadId: string;
    };
    await expect(api.opsFromUpload(draft.id!, both)).rejects.toMatchObject({ status: 422 });
    await expect(
      api.opsFromUpload(draft.id!, {} as unknown as { uploadId: string }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await api.opsFromUpload(draft.id!, { assetHash: uploaded.assetHash })).toMatchObject({
      jobId: expect.any(String),
    });
  });

  it('--preview-ttl 发 ttlSeconds；超出 60–604800 秒时什么也不建', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = directWorkspace(fake, PUSH_SCRIPT);
    const ctx = makeContext(root);
    expect(await main(ctx, ['push', '--plot', 'p1', '--preview-ttl', '3600'])).toBe(0);
    const preview = fake.requests.find((r) => r.path.endsWith('/preview'))!;
    expect(JSON.parse(preview.body.toString())).toEqual({ ttlSeconds: 3600 });
    expect(ctx.lines.join('\n')).toContain('预览链接：');
    const before = fake.requests.length;
    for (const bad of ['59', '604801', '90.5']) {
      expect(await main(ctx, ['push', '--plot', 'p1', '--preview-ttl', bad])).toBe(1);
      expect(ctx.errors.at(-1)).toContain('60 到 604800');
    }
    expect(fake.requests.length).toBe(before);
    expect(fake.state.drafts.size).toBe(1);
    // 不给时请求体是 {}，服务端用默认的 24 小时。
    expect(await main(ctx, ['push', '--plot', 'p1'])).toBe(0);
    expect(
      JSON.parse(
        fake.requests
          .filter((r) => r.path.endsWith('/preview'))
          .at(-1)!
          .body.toString(),
      ),
    ).toEqual({});
  });

  it('只开放地块路径的 agent key（设计 9.3）也能 push、publish：任务经地块路径查', async () => {
    const plotPrefix = '/api/v1/spaces/demo-space/plots/p1/';
    fake = await startFakeApi({ ...remoteSnapshot().state, allowedPrefixes: [plotPrefix] });
    const root = directWorkspace(fake, PUSH_SCRIPT);
    const ctx = makeContext(root);
    expect(await main(ctx, ['push', '--plot', 'p1', '--json'])).toBe(0);
    const out = JSON.parse(ctx.lines.at(-1)!) as { draftId: string; preview: string };
    expect(out.preview).toContain('#t=preview-token-abc');
    const api = fake.requests.filter((r) => r.path.startsWith('/api/'));
    // 只有读空间信息走了实体区路径（被拦下后跳过时间线检查），其余都在地块路径下。
    expect(api.filter((r) => !r.path.startsWith(plotPrefix)).map((r) => r.path)).toEqual([
      '/api/v1/spaces/demo-space',
    ]);
    const jobPolls = api.filter((r) => r.path.includes('/jobs/'));
    expect(jobPolls.length).toBeGreaterThan(0);
    expect(jobPolls.every((r) => r.path.startsWith(`${plotPrefix}jobs/`))).toBe(true);
    expect(new Set([...fake.state.jobs.values()].map((j) => j.kind))).toEqual(
      new Set(['upload_verify', 'ops_from_upload']),
    );
    const textCtx = makeContext(root);
    expect(await main(textCtx, ['push', '--plot', 'p1', '--no-preview'])).toBe(0);
    expect(textCtx.lines.join('\n')).toContain('跳过时间线检查');
    expect(await main(makeContext(root), ['publish', out.draftId])).toBe(0);
    expect(fake.requests.at(-1)!.path).toBe(`${plotPrefix}drafts/${out.draftId}/publish`);
  });

  it('实体区 push 读不了空间信息时照样报错（只有地块范围才跳过这项检查）', async () => {
    fake = await startFakeApi({
      ...remoteSnapshot().state,
      allowedPrefixes: ['/api/v1/spaces/demo-space/drafts', '/api/v1/spaces/demo-space/uploads'],
    });
    const root = directWorkspace(
      fake,
      "export default (base, kit) => [kit.fill([1, 0, 1, 3, 1, 3], base.block('stone'))];",
    );
    const ctx = makeContext(root);
    expect(await main(ctx, ['push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('HTTP 403');
    expect(fake.state.drafts.size).toBe(0);
  });

  it('地块路径查不到别的范围发起的任务', async () => {
    fake = await startFakeApi();
    fake.state.jobs.set('job-e', { id: 'job-e', kind: 'scan_import', polls: 0, runningPolls: 0 });
    const api = new MetaverseApi(
      new ApiClient({ mode: 'direct', api: fake.url, devTokenUrl: fake.devTokenUrl }),
      'demo-space',
    );
    await expect(api.getJob('job-e', 'p1')).rejects.toMatchObject({ status: 404 });
    expect(await api.getJob('job-e')).toMatchObject({ status: 'done' });
    expect(fake.requests.filter((r) => r.path.includes('/jobs/')).map((r) => r.path)).toEqual([
      '/api/v1/spaces/demo-space/plots/p1/jobs/job-e',
      '/api/v1/spaces/demo-space/jobs/job-e',
    ]);
  });

  it('--inline 分批调用批量操作接口；--json 输出', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = directWorkspace(fake, PUSH_SCRIPT);
    const ctx = makeContext(root);
    expect(await main(ctx, ['push', '--plot', 'p1', '--inline', '--no-preview', '--json'])).toBe(0);
    const out = JSON.parse(ctx.lines.at(-1)!) as Record<string, unknown>;
    expect(out).toMatchObject({ plot: 'p1', baseSeq: 3, opCount: 2, preview: null });
    expect(fake.requests.some((r) => r.path.endsWith('/ops') && r.method === 'POST')).toBe(true);
    expect(fake.requests.some((r) => r.path.includes('/uploads/'))).toBe(false);
  });

  it('超出范围时不推送；没有操作时什么也不做；没拉取时报错', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = directWorkspace(fake, PUSH_SCRIPT);
    const ctx = makeContext(root);
    // 实体区路径：桌子在虚拟区，超出范围。
    expect(await main(ctx, ['push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('没有推送');
    expect(fake.requests).toHaveLength(0);
    writeFileSync(join(root, 'build/main.ts'), 'export default () => [];');
    expect(await main(ctx, ['push'])).toBe(0);
    expect(ctx.lines.at(-1)).toContain('不用推送');
    const fresh = tempDir();
    dirs.push(fresh);
    writeConfig(fresh, {
      spaceId: 'demo-space',
      mode: 'direct',
      api: fake.url,
      devTokenUrl: fake.devTokenUrl,
    });
    writeFileSync(join(fresh, 'build.ts'), PUSH_SCRIPT);
    const freshCtx = makeContext(fresh);
    expect(await main(freshCtx, ['push', '--script', 'build.ts'])).toBe(1);
  });

  it('发布冲突时说明怎么处理', async () => {
    fake = await startFakeApi({ ...remoteSnapshot().state, publishConflict: true });
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    fake.state.drafts.set('draft-9', {
      scopePath: '/api/v1/spaces/demo-space',
      baseSeq: 3,
      ops: [],
    });
    expect(await main(ctx, ['publish', 'draft-9', '--replay'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('table-1');
    expect(ctx.errors.at(-1)).toContain('metaverse pull');
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({ replay: true });
    expect(await main(ctx, ['publish'])).toBe(1);
  });

  it('引用的资源已被定期清理（409 asset_gone）：列出哈希，提示重新上传，不建议重放', async () => {
    const gone = 'a'.repeat(64);
    fake = await startFakeApi({ ...remoteSnapshot().state, publishAssetsGone: [gone] });
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    fake.state.drafts.set('draft-9', {
      scopePath: '/api/v1/spaces/demo-space',
      baseSeq: 3,
      ops: [],
    });
    expect(await main(ctx, ['publish', 'draft-9'])).toBe(1);
    const message = ctx.errors.at(-1)!;
    expect(message).toContain('asset_gone');
    expect(message).toContain(gone);
    expect(message).toContain('重新上传');
    expect(message).toContain('metaverse publish draft-9');
    expect(message).not.toContain('--replay');
  });

  it('预览链接', () => {
    expect(previewLink('https://m.example/', { token: 't' })).toBe('https://m.example/preview#t=t');
    expect(previewLink(undefined, { url: 'https://x/preview#t=1' })).toBe('https://x/preview#t=1');
    expect(previewLink(undefined, {})).toBeNull();
    expect(previewLink(undefined, { token: 't' })).toBe('/preview#t=t');
  });
});

describe('metaverse scan', () => {
  it('上传扫描、等校验、发起导入并等任务完成', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    writeFileSync(join(root, 'lobby.glb'), fakeGlb(600 * 1024, 3));
    const ctx = makeContext(root);
    expect(
      await main(ctx, [
        'scan',
        'lobby.glb',
        '--part-size',
        '0.25',
        '--observed-at',
        '2026-11-01T10:00:00Z',
        '--voxelize',
      ]),
    ).toBe(0);
    const text = ctx.lines.join('\n');
    expect(text).toContain('已上传 100%');
    expect(text).toContain('已发起导入任务');
    expect(text).toContain('导入完成，提交 commit-9');
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);
    const create = fake.requests.find((r) => r.path.endsWith('/uploads/scan'))!;
    expect(JSON.parse(create.body.toString())).toMatchObject({ format: 'glb' });
    const scan = fake.requests.find((r) => r.path.endsWith('/scans'))!;
    expect(JSON.parse(scan.body.toString())).toMatchObject({
      observedAt: '2026-11-01T10:00:00Z',
      rebuild: true,
      voxelize: true,
    });
  });

  it('同一份扫描再导入：本空间已有就直接复用（同样是 201），不再传分片、不等校验', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    writeFileSync(join(root, 'lobby.glb'), fakeGlb(300 * 1024, 4));
    const ctx = makeContext(root);
    expect(await main(ctx, ['scan', 'lobby.glb', '--part-size', '0.25', '--no-wait'])).toBe(0);
    const putsBefore = fake.requests.filter((r) => r.method === 'PUT').length;
    expect(putsBefore).toBe(2);
    const second = makeContext(root);
    expect(await main(second, ['scan', 'lobby.glb', '--no-wait', '--json'])).toBe(0);
    const out = JSON.parse(second.lines.at(-1)!) as {
      assetHash: string;
      jobId: string;
      upload: { reused: boolean; parts: number };
    };
    expect(out.upload).toMatchObject({ reused: true, parts: 0 });
    expect(out.jobId).toBeTruthy();
    // 复用时不传分片、不调用 complete，直接按哈希发起导入。
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBefore);
    expect(fake.requests.filter((r) => r.path.endsWith('/complete'))).toHaveLength(1);
    const imports = fake.requests.filter((r) => r.path.endsWith('/scans'));
    expect(imports).toHaveLength(2);
    expect(JSON.parse(imports[1]!.body.toString())).toMatchObject({ assetHash: out.assetHash });
    const third = makeContext(root);
    expect(await main(third, ['scan', 'lobby.glb', '--no-wait'])).toBe(0);
    expect(third.lines.join('\n')).toContain('本空间已有同样的内容');
  });

  it('重扫配准误差超阈值时提示人工对齐；--asset + --transform 走重新对齐', async () => {
    const asset = Buffer.from('scan');
    const hash = createHash('sha256').update(asset).digest('hex');
    fake = await startFakeApi({
      assets: new Map([[hash, asset]]),
      scanResult: { needsAlignment: true, proposedTransform: [1], errorCm: 7.5 },
    });
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['scan', '--asset', hash, '--no-rebuild'])).toBe(2);
    expect(ctx.lines.join('\n')).toContain('7.5 厘米');
    const transform = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)).join(',');
    expect(
      await main(ctx, ['scan', '--asset', hash, '--transform', transform, '--no-wait', '--json']),
    ).toBe(0);
    expect(fake.requests.at(-1)!.path).toBe(`/api/v1/spaces/demo-space/scans/${hash}/alignment`);
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({
      transform: transform.split(',').map(Number),
      rebuild: true,
      voxelize: false,
    });
    // 重新对齐时 --no-rebuild、--voxelize、--observed-at 也带上（原来被静默丢掉）。
    expect(
      await main(ctx, [
        'scan',
        '--asset',
        hash,
        '--transform',
        transform,
        '--no-rebuild',
        '--voxelize',
        '--observed-at',
        '2026-11-02T08:00:00Z',
        '--no-wait',
      ]),
    ).toBe(0);
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({
      transform: transform.split(',').map(Number),
      observedAt: '2026-11-02T08:00:00Z',
      rebuild: false,
      voxelize: true,
    });
    expect(() => parseTransform('1,2,3')).toThrow('16 个数');
  });

  it('首次导入带 --transform：上传后走 alignment，不把 transform 发给 /scans', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    writeFileSync(join(root, 'lobby.glb'), fakeGlb(4096));
    const ctx = makeContext(root);
    const transform = '1,0,0,0, 0,1,0,0, 0,0,1,0, 2,0,3,1';
    expect(
      await main(ctx, [
        'scan',
        'lobby.glb',
        '--transform',
        transform,
        '--observed-at',
        '2026-11-01T10:00:00Z',
      ]),
    ).toBe(0);
    expect(fake.requests.some((r) => r.path.endsWith('/scans'))).toBe(false);
    const hash = [...fake.state.uploads.values()][0]!.sha256;
    const align = fake.requests.find((r) => r.path.endsWith('/alignment'))!;
    expect(align.path).toBe(`/api/v1/spaces/demo-space/scans/${hash}/alignment`);
    expect(JSON.parse(align.body.toString())).toEqual({
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 3, 1],
      observedAt: '2026-11-01T10:00:00Z',
      rebuild: true,
      voxelize: false,
    });
    expect(ctx.lines.join('\n')).toContain('导入完成，提交 commit-9');
    // /scans 收到 transform 时，接口服务（和假接口）返回 422。
    const api = new MetaverseApi(
      new ApiClient({ mode: 'direct', api: fake.url, devTokenUrl: fake.devTokenUrl }),
      'demo-space',
    );
    await expect(
      api.importScan({ assetHash: hash, transform: [1] } as unknown as { assetHash: string }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('--transform、--observed-at 不合法时，上传之前就报错', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    writeFileSync(join(root, 'lobby.glb'), fakeGlb(4096));
    const ctx = makeContext(root);
    expect(await main(ctx, ['scan', 'lobby.glb', '--transform', '1,2,3'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('16 个数');
    expect(await main(ctx, ['scan', 'lobby.glb', '--observed-at', '昨天'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('RFC 3339');
    expect(fake.requests).toHaveLength(0);
  });

  it('带贴图的扫描打包成 zip 上传（format: zip）', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2000, 1)]);
    writeFileSync(join(root, 'scaniverse.ZIP'), zip);
    const ctx = makeContext(root);
    expect(await main(ctx, ['scan', 'scaniverse.ZIP', '--no-wait', '--json'])).toBe(0);
    const create = fake.requests.find((r) => r.path.endsWith('/uploads/scan'))!;
    expect(JSON.parse(create.body.toString())).toMatchObject({ format: 'zip', size: zip.length });
    expect(scanFormat('a/b.obj')).toBe('obj');
    expect(scanFormat('a/b.drc')).toBe('drc');
    expect(scanFormat('a/b.ply')).toBeNull();
    // 扩展名和内容不符时，接口服务按文件头拒绝。
    writeFileSync(join(root, 'fake.zip'), 'v 0 0 0\n');
    expect(await main(ctx, ['scan', 'fake.zip'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('format_mismatch');
  });

  it('参数检查', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['scan'])).toBe(1);
    expect(await main(ctx, ['scan', 'nope.glb'])).toBe(1);
    writeFileSync(join(root, 'x.txt'), 'x');
    expect(await main(ctx, ['scan', 'x.txt'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('zip');
    expect(await main(ctx, ['scan', '--asset', 'xyz'])).toBe(1);
    expect(await main(ctx, ['scan', '--help'])).toBe(0);
  });
});

describe('metaverse admin', () => {
  it('建空间（没有工作区也行）、改名、轮换令牌、定义区域和地块、登记事件类型、抹除事件', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const cwd = tempDir();
    dirs.push(cwd);
    const flags = ['--mode', 'direct', '--api', fake.url, '--dev-token-url', fake.devTokenUrl];
    const ctx = makeContext(cwd);
    expect(
      await main(ctx, [
        'admin',
        'create-space',
        'new-space',
        '--name',
        '新店',
        '--owner',
        'org-1',
        ...flags,
      ]),
    ).toBe(0);
    expect(ctx.lines.join('\n')).toContain('share-secret-1');
    const created = fake.requests.find((r) => r.path === '/api/v1/admin/spaces')!;
    expect(JSON.parse(created.body.toString())).toEqual({
      id: 'new-space',
      name: '新店',
      owner: { kind: 'org', id: 'org-1' },
    });

    const root = directWorkspace(fake);
    const ws = makeContext(root);
    // 不带确认字段时接口服务返回 409；字段名不对（例如 confirmPublic）时 422。
    const admin = new MetaverseApi(
      new ApiClient({ mode: 'direct', api: fake.url, devTokenUrl: fake.devTokenUrl }),
      'demo-space',
    );
    await expect(admin.updateSpace({ visibility: 'public' })).rejects.toMatchObject({
      status: 409,
      code: 'confirmation_required',
    });
    await expect(
      admin.updateSpace({ visibility: 'public', confirmPublic: true } as unknown as {
        visibility: 'public';
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await main(ws, ['admin', 'update-space', '--visibility', 'public'])).toBe(1);
    expect(ws.errors.at(-1)).toContain('--yes');
    expect(
      await main(ws, [
        'admin',
        'update-space',
        '--name',
        '新名字',
        '--visibility',
        'public',
        '--yes',
      ]),
    ).toBe(0);
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({
      name: '新名字',
      visibility: 'public',
      confirmPublicHistory: true,
    });
    expect(ws.lines.at(-1)).toBe('已更新空间 demo-space：名称 新名字，可见性 public');
    expect(await main(ws, ['admin', 'update-space', '--description', '新说明', '--json'])).toBe(0);
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({ description: '新说明' });
    expect(JSON.parse(ws.lines.at(-1)!)).toMatchObject({
      id: 'demo-space',
      description: '新说明',
      visibility: 'public',
    });
    expect(await main(ws, ['admin', 'update-space'])).toBe(1);
    expect(await main(ws, ['admin', 'update-space', '--visibility', 'secret'])).toBe(1);
    // 轮换：不带请求体，按顶层的 { id, token } 打印新令牌。
    expect(await main(ws, ['admin', 'rotate-share-token'])).toBe(0);
    const rotate = fake.requests.at(-1)!;
    expect(rotate.path).toBe('/api/v1/admin/spaces/demo-space/share-tokens');
    expect(rotate.body.length).toBe(0);
    expect(ws.lines.slice(-3)).toEqual([
      '新的分享令牌（只显示这一次，旧令牌已全部吊销）：share-secret-2',
      '令牌编号：st_2',
      '查看链接：/s/demo-space#share=share-secret-2',
    ]);
    expect(await main(ws, ['admin', 'rotate-share-token', '--json'])).toBe(0);
    expect(JSON.parse(ws.lines.at(-1)!)).toEqual({ id: 'st_3', token: 'share-secret-3' });
    // 接口服务不支持按编号吊销，选项已经去掉。
    expect(await main(ws, ['admin', 'rotate-share-token', '--revoke', 'st_1'])).toBe(1);
    expect(fake.state.shareTokenRotations).toBe(2);

    writeFileSync(join(root, 'layout.json'), JSON.stringify({ regions: REGIONS, plots: PLOTS }));
    expect(await main(ws, ['admin', 'set-layout', 'layout.json', '--message', '划地块'])).toBe(0);
    const layout = fake.requests.at(-1)!;
    expect(layout.method).toBe('PUT');
    expect(JSON.parse(layout.body.toString())).toMatchObject({ baseSeq: 3, message: '划地块' });
    writeFileSync(
      join(root, 'bad-layout.json'),
      JSON.stringify({
        regions: REGIONS,
        plots: [{ id: 'p2', regionId: 'hall', boxes: [[0, 0, 0, 1, 1, 1]] }],
      }),
    );
    expect(await main(ws, ['admin', 'set-layout', 'bad-layout.json'])).toBe(1);
    expect(ws.errors.at(-1)).toContain('虚拟区');

    writeFileSync(
      join(root, 'event-type.json'),
      JSON.stringify({
        type: 'table.occupancy',
        schema: {},
        defaultVisibility: 'public',
        display: { kind: 'highlight' },
      }),
    );
    expect(await main(ws, ['admin', 'register-event-type', 'event-type.json'])).toBe(0);
    expect(ws.lines.at(-1)).toContain('table.occupancy 第 1 版');
    expect(await main(ws, ['admin', 'redact-event', 'ev-1'])).toBe(0);
    expect(fake.requests.at(-1)!.path).toBe('/api/v1/admin/spaces/demo-space/events/ev-1/redact');
    expect(fake.requests.at(-1)!.body.length).toBe(0);
    expect(ws.lines.at(-1)).toBe('已抹除事件 ev-1 的内容（共 2 条记录，含指向它的更正）');
    expect(await main(ws, ['admin', 'redact-event', 'ev-2', '--json'])).toBe(0);
    expect(JSON.parse(ws.lines.at(-1)!)).toEqual({ id: 'ev-2', redacted: true, records: 2 });
    // 接口服务不读原因，选项已经去掉（原来会被静默丢掉）。
    expect(await main(ws, ['admin', 'redact-event', 'ev-1', '--reason', '个人信息'])).toBe(1);
    expect(await main(ws, ['admin', 'redact-event'])).toBe(1);
    expect(await main(ws, ['admin'])).toBe(1);
    expect(await main(ws, ['admin', 'explode'])).toBe(1);
    expect(await main(ws, ['admin', 'create-space', 'x'])).toBe(1);
  });

  it('轮换的响应里没有令牌原文时报错，不静默输出', async () => {
    fake = await startFakeApi({
      ...remoteSnapshot().state,
      shareTokenResponse: { shareToken: { id: 'st_9', token: 'nested' } },
    });
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['admin', 'rotate-share-token'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('旧令牌已全部吊销');
    expect(ctx.lines.join('\n')).not.toContain('已处理');
    // --json 时先把原始响应打印出来，再报错。
    expect(await main(ctx, ['admin', 'rotate-share-token', '--json'])).toBe(1);
    expect(JSON.parse(ctx.lines.at(-1)!)).toEqual({ shareToken: { id: 'st_9', token: 'nested' } });
  });

  it('区域和地块的本地检查', () => {
    expect(validateLayout(REGIONS, PLOTS)).toBeNull();
    expect(validateLayout([...REGIONS, REGIONS[0]!], [])).toContain('重复');
    expect(
      validateLayout(REGIONS, [{ id: 'p1', regionId: 'garden', boxes: [[190, 0, 0, 210, 1, 1]] }]),
    ).toContain('超出');
    expect(
      validateLayout(REGIONS, [{ id: 'p1', regionId: 'nope', boxes: [[100, 0, 0, 101, 1, 1]] }]),
    ).toContain('不存在');
    expect(
      validateLayout([{ id: 'r', kind: 'physical', boxes: [[0, 0, 0, 0, 1, 1]] }], []),
    ).toContain('min < max');
  });
});

describe('metaverse voxelize', () => {
  it('没有 Docker 时做参数检查并说明；--remote 发起云端任务', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    const scan = 'd'.repeat(64);
    expect(await runVoxelize(ctx, ['--scan', scan, '--style', 'blocks'], () => false)).toBe(3);
    expect(ctx.lines.join('\n')).toContain('需要 Docker');
    expect(ctx.lines.join('\n')).toContain('--remote');
    expect(await runVoxelize(ctx, ['--scan', scan], () => true)).toBe(0);
    expect(await main(ctx, ['voxelize', '--scan', scan, '--remote'])).toBe(0);
    expect(
      fake.requests.some((r) => r.path === `/api/v1/spaces/demo-space/scans/${scan}/voxelize`),
    ).toBe(true);
    expect(ctx.lines.at(-1)).toContain('体素化完成');
    // 工作区里没有扫描信息、格式不对。
    expect(await main(ctx, ['voxelize'])).toBe(1);
    expect(await main(ctx, ['voxelize', '--scan', 'xyz'])).toBe(1);
    expect(await main(ctx, ['voxelize', '--scan', scan, '--style', 'Bad Style'])).toBe(1);
  });
});

function authoredDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    entities: [
      {
        entityId: 'panel-01',
        kind: 'object',
        shape: { type: 'box', size: [0.02, 1, 1], material: { bake: 'planar' } },
      },
    ],
    notes: '面板贴着西墙，烘焙',
    ...extra,
  };
}

const AUTHORED_RESULT = {
  authored: {
    entities: 3,
    templates: 1,
    structure: 'keep',
    fit: [
      { entityId: 'panel-01', points: 900, meanCm: 0.4, p90Cm: 0.9, coverage3cm: 0.99 },
      { entityId: 'counter-01', points: 20000, meanCm: 3.6, p90Cm: 7.1, coverage3cm: 0.71 },
      { entityId: 'chair-01', points: 3 },
    ],
    downloads: { models: 1, files: 5, bytes: 770000, redirects: 0 },
    bake: { entities: 1, parts: 2, textured: 1, fallback: 1 },
  },
};

describe('metaverse rebuild', () => {
  it('小的物件集随请求内联，等任务完成，列出偏差最大的几件', async () => {
    const pulled = remoteSnapshot();
    fake = await startFakeApi({ ...pulled.state, rebuildResult: AUTHORED_RESULT });
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['pull'])).toBe(0);
    writeFileSync(join(root, 'authored.json'), JSON.stringify(authoredDoc()));
    expect(await main(ctx, ['rebuild', '--authored', 'authored.json', '--hints', '{"x":1}'])).toBe(
      0,
    );
    const scan = 'c'.repeat(64);
    const call = fake.requests.find((r) => r.path.endsWith(`/scans/${scan}/rebuild`))!;
    expect(JSON.parse(call.body.toString())).toEqual({ hints: { x: 1 }, authored: authoredDoc() });
    expect(fake.requests.some((r) => r.path.includes('/uploads/'))).toBe(false);
    const text = ctx.lines.join('\n');
    expect(text).toContain('随请求内联提交');
    expect(text).toContain('counter-01：3.6 / 7.1 厘米，71%');
    expect(text.indexOf('counter-01')).toBeLessThan(text.indexOf('panel-01：'));
    expect(text).toContain('另有 1 件附近没有扫描');
    expect(text).toContain('外部模型：下载 1 个（5 个文件');
    expect(text).toContain('1 处附近没有扫描、用了后备纯色');
    expect(text).toContain('重建完成，提交 commit-10');
  });

  it('大的物件集先经 authored 用途上传，等校验，再用资源哈希；不带物件集就是普通重建', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    const scan = 'e'.repeat(64);
    const big = authoredDoc({ notes: '长'.repeat(Math.ceil(INLINE_AUTHORED_BYTES / 3) + 10) });
    writeFileSync(join(root, 'big.json'), JSON.stringify(big, null, 2));
    const ctx = makeContext(root);
    expect(await main(ctx, ['rebuild', '--authored', 'big.json', '--scan', scan, '--json'])).toBe(
      0,
    );
    const create = fake.requests.find((r) => r.path.endsWith('/uploads/authored'))!;
    const declared = JSON.parse(create.body.toString()) as { format: string; sha256: string };
    expect(declared.format).toBe('json');
    expect(fake.requests.some((r) => r.path.endsWith('/complete'))).toBe(true);
    const call = fake.requests.find((r) => r.path.endsWith(`/scans/${scan}/rebuild`))!;
    expect(JSON.parse(call.body.toString())).toEqual({ authoredAsset: declared.sha256 });
    const out = JSON.parse(ctx.lines.at(-1)!) as { authored: { inline: boolean }; jobId: string };
    expect(out.authored.inline).toBe(false);
    // 不带物件集：请求体是空对象
    const plain = makeContext(root);
    expect(await main(plain, ['rebuild', '--scan', scan, '--no-wait'])).toBe(0);
    const calls = fake.requests.filter((r) => r.path.endsWith(`/scans/${scan}/rebuild`));
    expect(JSON.parse(calls.at(-1)!.body.toString())).toEqual({});
  });

  it('参数和物件集的本地检查', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    const scan = 'e'.repeat(64);
    writeFileSync(join(root, 'bad.json'), '{"version": 2, "entities": [1]}');
    writeFileSync(join(root, 'empty.json'), '{"version": 1, "entities": []}');
    writeFileSync(join(root, 'notjson.json'), 'nope');
    writeFileSync(join(root, 'array.json'), '[1]');
    for (const args of [
      ['rebuild'],
      ['rebuild', '--scan', 'xyz'],
      ['rebuild', '--scan', scan, '--hints', '[1]'],
      ['rebuild', '--scan', scan, '--hints', 'nope'],
      ['rebuild', '--scan', scan, '--authored', 'bad.json'],
      ['rebuild', '--scan', scan, '--authored', 'empty.json'],
      ['rebuild', '--scan', scan, '--authored', 'notjson.json'],
      ['rebuild', '--scan', scan, '--authored', 'array.json'],
      ['rebuild', '--scan', scan, '--authored', 'missing.json'],
    ]) {
      expect(await main(ctx, args), args.join(' ')).toBe(1);
    }
    expect(fake.requests.some((r) => r.path.includes('/rebuild'))).toBe(false);
    const help = makeContext(root);
    expect(await main(help, ['rebuild', '--help'])).toBe(0);
    expect(help.lines.join('\n')).toContain('--authored');
  });

  it('describeAuthored 对没有物件集的结果什么也不输出', () => {
    expect(describeAuthored({})).toEqual([]);
    expect(describeAuthored(null)).toEqual([]);
  });
});

describe('metaverse scan --authored', () => {
  it('上传扫描后带物件集发起导入；--transform 时一并发给 alignment；不能和 --no-rebuild 一起用', async () => {
    fake = await startFakeApi({ scanResult: AUTHORED_RESULT });
    const root = directWorkspace(fake);
    writeFileSync(join(root, 'lobby.glb'), fakeGlb(300 * 1024, 5));
    writeFileSync(join(root, 'authored.json'), JSON.stringify(authoredDoc()));
    const ctx = makeContext(root);
    expect(await main(ctx, ['scan', 'lobby.glb', '--authored', 'authored.json'])).toBe(0);
    const scanCall = fake.requests.find((r) => r.path.endsWith('/scans'))!;
    expect(JSON.parse(scanCall.body.toString())).toMatchObject({
      rebuild: true,
      authored: authoredDoc(),
    });
    expect(ctx.lines.join('\n')).toContain('counter-01：3.6 / 7.1 厘米');
    const identity = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
    const again = makeContext(root);
    expect(
      await main(again, [
        'scan',
        'lobby.glb',
        '--authored',
        'authored.json',
        '--transform',
        identity,
        '--no-wait',
      ]),
    ).toBe(0);
    const align = fake.requests.find((r) => r.path.endsWith('/alignment'))!;
    expect(JSON.parse(align.body.toString())).toMatchObject({ authored: authoredDoc() });
    const puts = fake.requests.filter((r) => r.method === 'PUT').length;
    const bad = makeContext(root);
    expect(
      await main(bad, ['scan', 'lobby.glb', '--authored', 'authored.json', '--no-rebuild']),
    ).toBe(1);
    writeFileSync(join(root, 'bad.json'), '{"version": 1}');
    expect(await main(bad, ['scan', 'lobby.glb', '--authored', 'bad.json'])).toBe(1);
    // 物件集不对时扫描也不上传
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(puts);
  });
});

describe('命令行入口', () => {
  it('帮助、版本、未知命令', async () => {
    const ctx = makeContext(tempDir());
    expect(await main(ctx, [])).toBe(1);
    expect(await main(ctx, ['--help'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('metaverse <命令>');
    expect(await main(ctx, ['--version'])).toBe(0);
    expect(await main(ctx, ['explode'])).toBe(1);
    for (const name of [
      'admin',
      'scan',
      'pull',
      'build',
      'dev',
      'shot',
      'diff',
      'check',
      'push',
      'publish',
      'voxelize',
    ]) {
      expect(await main(ctx, [name, '--help'])).toBe(0);
    }
    // 不在工作区里。
    expect(await main(ctx, ['pull'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('metaverse init');
  });

  it('命令行参数覆盖 metaverse.json 的调用方式', async () => {
    fake = await startFakeApi(remoteSnapshot().state);
    const root = makeWorkspace({ config: { mode: 'nyxid' } });
    dirs.push(root);
    const ctx = makeContext(root, { METAVERSE_DEV_TOKEN_URL: fake.devTokenUrl });
    expect(await main(ctx, ['pull', '--mode', 'direct', '--api', fake.url, '--sub', 'me'])).toBe(0);
    expect(JSON.parse(fake.requests[0]!.body.toString())).toEqual({ sub: 'me' });
    expect(readConfig(root).mode).toBe('nyxid');
    expect(await main(ctx, ['pull', '--mode', 'ftp'])).toBe(1);
  });
});
