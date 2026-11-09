import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/commands/index.js';
import { DEFAULT_UPLOAD_LIMITS } from '../src/core/limits.js';
import { parseShareLink } from '../src/transport/public.js';
import { readBase } from '../src/workspace/files.js';
import { sha256 } from './helpers/bundle.js';
import { startFakeApi, type FakeApi, type FakeState } from './helpers/fakeApi.js';
import { meshGlb, zipBytes } from './helpers/samples.js';
import { makeContext, makeWorkspace, removeDir } from './helpers/workspace.js';

/**
 * `metaverse pull` 的新部分（docs/design/server-slim.md 8.5）：limits.json、`--scan` 分段下载和断点续传、
 * `--share` 只读公开快照（分享令牌不写进工作区）。
 */

let fake: FakeApi | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await fake?.close();
  fake = null;
  while (dirs.length > 0) removeDir(dirs.pop()!);
});

const TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 3, 1];

function scanZip(): Uint8Array {
  return zipBytes([
    { name: 'mesh.drc', data: new Uint8Array(1500).fill(7) },
    { name: 'texture.jpg', data: new Uint8Array(800).fill(9) },
  ]);
}

function state(scan: Uint8Array, extra: Partial<FakeState> = {}): Partial<FakeState> {
  const web = meshGlb();
  const model = meshGlb({ nodes: [{ mesh: 0, scale: [2, 2, 2] }] });
  return {
    space: {
      id: 'demo-space',
      name: '演示空间',
      visibility: 'unlisted',
      head: { seq: 4, at: '2026-11-04T00:00:00.000Z' },
      regions: [],
      plots: [],
      anchors: [],
      uploadLimits: DEFAULT_UPLOAD_LIMITS,
    },
    snapshot: {
      spaceId: 'demo-space',
      seq: 4,
      at: '2026-11-04T00:00:00.000Z',
      chunks: [],
      entities: [
        {
          id: 'rb.sofa-01',
          body: {
            entityId: 'rb.sofa-01',
            layer: 'rebuilt',
            kind: 'object',
            assetHash: sha256(model),
            bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
          },
        },
      ],
      anchors: [
        { anchorId: 'door-1', kind: 'door', box: [0, 0, 0, 20, 40, 4], visibility: 'public' },
        { anchorId: 'cam-1', kind: 'camera', position: [1, 2, 1], visibility: 'internal' },
      ],
      regions: [],
      plots: [],
      scan: {
        assetHash: sha256(scan),
        webModelHashes: [sha256(web)],
        transform: TRANSFORM,
        observedAt: '2026-10-20T00:00:00.000Z',
      },
    },
    assets: new Map([
      [sha256(scan), Buffer.from(scan)],
      [sha256(web), Buffer.from(web)],
      [sha256(model), Buffer.from(model)],
    ]),
    ...extra,
  };
}

function workspace(api: FakeApi): string {
  const root = makeWorkspace({
    config: { mode: 'direct', api: api.url, devTokenUrl: api.devTokenUrl },
  });
  dirs.push(root);
  return root;
}

describe('metaverse pull：limits.json', () => {
  it('接口服务给出 uploadLimits 时写 limits.json；没有或不认识时不写、提示', async () => {
    const scan = scanZip();
    fake = await startFakeApi(state(scan));
    const root = workspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['pull'])).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'limits.json'), 'utf8'))).toEqual(
      DEFAULT_UPLOAD_LIMITS,
    );
    expect(ctx.lines.join('\n')).toContain('limits.json');
    // 扫描不在 --scan 时不下载。
    expect(existsSync(join(root, 'scan'))).toBe(false);
    delete fake.state.space.uploadLimits;
    expect(await main(ctx, ['pull'])).toBe(0);
    expect(ctx.errors.at(-1)).toContain('没有给出上传上限');
    fake.state.space.uploadLimits = { v: 2 };
    const jsonCtx = makeContext(root);
    expect(await main(jsonCtx, ['pull', '--json'])).toBe(0);
    const out = JSON.parse(jsonCtx.lines.join('\n'));
    expect(out.limits).toBe(false);
    expect(out.warnings[0]).toContain('不认识');
  });
});

describe('metaverse pull --scan', () => {
  it('分段下载原始扫描、写 scan/transform.json；已有就不重下', async () => {
    const scan = scanZip();
    fake = await startFakeApi(state(scan, { rangeChunk: 500 }));
    const root = workspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['pull', '--scan'])).toBe(0);
    expect(readFileSync(join(root, 'scan', 'scan.zip'))).toEqual(Buffer.from(scan));
    const ranges = fake.requests.filter((r) => r.headers.range !== undefined);
    expect(ranges.length).toBe(Math.ceil(scan.length / 500));
    expect(ranges[0]!.headers.range).toBe(`bytes=0-${64 * 1024 * 1024 - 1}`);
    expect(ranges[1]!.headers.range).toMatch(/^bytes=500-/);
    expect(JSON.parse(readFileSync(join(root, 'scan', 'transform.json'), 'utf8'))).toEqual({
      transform: TRANSFORM,
      source: 'pull',
      seq: 4,
    });
    expect(ctx.lines.join('\n')).toContain('原始扫描');
    expect(readdirSync(join(root, 'scan')).filter((n) => n.endsWith('.part'))).toEqual([]);
    const before = fake.requests.length;
    expect(await main(ctx, ['pull', '--scan'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('内容相同，没有重新下载');
    expect(fake.requests.slice(before).some((r) => r.headers.range !== undefined)).toBe(false);
  });

  it('断点续传：从 .part 的长度接着下；连接断开时重试', async () => {
    const scan = scanZip();
    fake = await startFakeApi(state(scan, { rangeChunk: 700, dropAssetRequests: 2 }));
    const root = workspace(fake);
    const ctx = makeContext(root);
    const hash = sha256(scan);
    const part = join(root, 'scan', `.scan-${hash}.part`);
    // 上次下到一半。
    expect(await main(ctx, ['pull'])).toBe(0);
    mkdirSync(join(root, 'scan'), { recursive: true });
    writeFileSync(part, scan.subarray(0, 900));
    const jsonCtx = makeContext(root);
    expect(await main(jsonCtx, ['pull', '--scan', '--json'])).toBe(0);
    const out = JSON.parse(jsonCtx.lines.join('\n'));
    expect(out.scan).toMatchObject({ resumedFrom: 900, skipped: false, transform: true });
    expect(readFileSync(join(root, 'scan', 'scan.zip'))).toEqual(Buffer.from(scan));
    const ranges = fake.requests.filter((r) => r.headers.range !== undefined);
    expect(ranges[0]!.headers.range).toMatch(/^bytes=900-/);
  });

  it('不是 zip 的扫描按格式起名并提示；这个版本没有扫描时报错', async () => {
    const glb = meshGlb();
    fake = await startFakeApi(state(glb));
    const root = workspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['pull', '--scan'])).toBe(0);
    expect(existsSync(join(root, 'scan', 'scan.glb'))).toBe(true);
    expect(ctx.errors.join('\n')).toContain('不是 zip');
    fake.state.snapshot = { ...fake.state.snapshot!, scan: null };
    expect(await main(ctx, ['pull', '--scan'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('没有原始扫描');
    expect(await main(ctx, ['pull', '--assets'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('--share');
  });

  it('内容与哈希不符：删掉下到一半的文件', async () => {
    const scan = scanZip();
    const s = state(scan);
    s.assets!.set(sha256(scan), Buffer.from(scanZip().map((b) => b ^ 1)));
    fake = await startFakeApi(s);
    const root = workspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['pull', '--scan'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('sha256');
    expect(readdirSync(join(root, 'scan')).filter((n) => n.endsWith('.part'))).toEqual([]);
  });
});

describe('metaverse pull --share', () => {
  it('只读公开快照：公开锚点、变换、只读标记；分享令牌不写进工作区；之后不能推送', async () => {
    const scan = scanZip();
    fake = await startFakeApi(state(scan));
    const root = workspace(fake);
    const ctx = makeContext(root);
    const link = `${fake.url}/s/demo-space#share=${fake.state.shareToken}`;
    expect(await main(ctx, ['pull', '--share', link, '--assets'])).toBe(0);
    // 不经 NyxID：没有取开发令牌，也没有 /api/v1 的请求。
    expect(fake.state.devTokens).toBe(0);
    expect(fake.requests.every((r) => r.path.startsWith('/api/public/'))).toBe(true);
    expect(fake.requests[0]!.headers.authorization).toBe(`Share ${fake.state.shareToken}`);
    const base = readBase(root, 'demo-space');
    expect(base.space.readOnly).toBe(true);
    expect(base.space.seq).toBe(4);
    expect(base.anchors.map((a) => a.anchorId)).toEqual(['door-1']);
    expect(base.space.scan).toEqual({
      webModelHashes: (fake.state.snapshot!.scan as { webModelHashes: string[] }).webModelHashes,
      transform: TRANSFORM,
    });
    expect(JSON.parse(readFileSync(join(root, 'scan', 'transform.json'), 'utf8')).seq).toBe(4);
    const assets = readdirSync(join(root, 'assets'));
    expect(assets).toHaveLength(2);
    // 令牌不出现在工作区的任何文件里，也不出现在输出里。
    const grep = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) return [];
        if (entry.isDirectory()) return grep(path);
        return readFileSync(path).includes(fake!.state.shareToken) ? [path] : [];
      });
    expect(grep(root)).toEqual([]);
    expect([...ctx.lines, ...ctx.errors].join('\n')).not.toContain(fake.state.shareToken);
    expect(ctx.lines.join('\n')).toContain('只读');
    // 只读工作区不能推送；经 NyxID 重新拉取后去掉标记。
    expect(await main(ctx, ['push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('只读');
    expect(await main(ctx, ['pull'])).toBe(0);
    expect(readBase(root, 'demo-space').space.readOnly).toBeUndefined();
  });

  it('令牌可以用 METAVERSE_SHARE_TOKEN 给；公开空间不要令牌；没有令牌、空间不符、--scan 都报错', async () => {
    fake = await startFakeApi(state(scanZip()));
    const root = workspace(fake);
    const link = `${fake.url}/s/demo-space`;
    const env = makeContext(root, { METAVERSE_SHARE_TOKEN: fake.state.shareToken });
    expect(await main(env, ['pull', '--share', link, '--seq', '4', '--json'])).toBe(0);
    expect(JSON.parse(env.lines.join('\n'))).toMatchObject({ seq: 4, readOnly: true, assets: 0 });
    const ctx = makeContext(root);
    expect(await main(ctx, ['pull', '--share', link])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('HTTP 404');
    expect(ctx.errors.at(-1)).not.toContain(fake.state.shareToken);
    fake.state.space = { ...fake.state.space, visibility: 'public' };
    expect(await main(ctx, ['pull', '--share', link])).toBe(0);
    expect(await main(ctx, ['pull', '--share', `${fake.url}/s/other-space`])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('other-space');
    expect(await main(ctx, ['pull', '--share', link, '--scan'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('原始扫描不公开');
    expect(await main(ctx, ['pull', '--share', link, '--seq', '9'])).toBe(1);
    expect(await main(ctx, ['pull', '--share', 'http://example.com/s/demo-space'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('https');
  });

  it('分享链接的解析', () => {
    expect(parseShareLink('https://m.example/s/demo-space#share=abc')).toEqual({
      origin: 'https://m.example',
      spaceId: 'demo-space',
      token: 'abc',
    });
    expect(parseShareLink('https://m.example/s/demo-space', 'env').token).toBe('env');
    expect(parseShareLink('https://m.example/s/demo-space', '').token).toBeNull();
    expect(parseShareLink('http://127.0.0.1:5173/s/demo-space#share=x').origin).toBe(
      'http://127.0.0.1:5173',
    );
    expect(() => parseShareLink('not a link')).toThrow('不是合法的地址');
    expect(() => parseShareLink('https://u:p@m.example/s/demo-space')).toThrow('账号密码');
    expect(() => parseShareLink('https://m.example/u/demo-space')).toThrow('/s/<空间编号>');
    expect(() => parseShareLink('https://m.example/s/Bad_Id')).toThrow('/s/<空间编号>');
  });
});
