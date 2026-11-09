import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWebDist, startDev } from '../src/commands/dev.js';
import { browserPath } from '../src/commands/shot.js';
import { decompressChunk } from '../src/core/chunk.js';
import { findWebDist, startDevServer, type DevServer } from '../src/dev/server.js';
import { buildManifest, runBuild } from '../src/workspace/build.js';
import { readConfig } from '../src/workspace/config.js';
import { floorChunk, makeContext, makeWorkspace, removeDir, tempDir } from './helpers/workspace.js';

const SCRIPT = `export default (base, kit) => ({
  message: '本地放一张桌子',
  ops: [
    kit.place('table-1', kit.table({ at: [5.8, 0, 0.8] }), { label: '1 号桌' }),
    kit.fill([100, 0, 0, 104, 1, 4], 2),
  ],
});`;

const dirs: string[] = [];
let server: DevServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  while (dirs.length > 0) removeDir(dirs.pop()!);
});

function webDist(): string {
  const dir = tempDir('metaverse-web-');
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>查看器</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

async function start(root: string, dist: string | null, now?: () => number): Promise<DevServer> {
  const config = readConfig(root);
  server = await startDevServer({
    root,
    spaceId: config.spaceId,
    webDist: dist,
    rebuild: async () => buildManifest(await runBuild(root, config, { plot: 'p1' })),
    ...(now ? { now } : {}),
  });
  return server;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: AnyJson }> {
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    headers: response.headers,
    body: response.status === 304 ? null : ((await response.json()) as AnyJson),
  };
}

describe('本地查看器的接口（公开读接口的形状）', () => {
  it('空间信息、head（ETag / 304）、时间线、快照、区块', async () => {
    const root = makeWorkspace({ script: SCRIPT });
    dirs.push(root);
    let clock = Date.parse('2026-11-09T00:00:00.000Z');
    const dev = await start(root, webDist(), () => clock);
    const api = `${dev.url}/api/public/spaces/demo-space`;

    const space = await getJson(api);
    expect(space.status).toBe(200);
    expect(space.body).toMatchObject({
      id: 'demo-space',
      name: '演示空间（本地预览）',
      head: { seq: 4, recordedAt: null },
    });
    // 只给公开锚点；本地建造结果里的锚点。
    expect(space.body.anchors.map((a: { anchorId: string }) => a.anchorId)).toEqual([
      '_space',
      't1',
    ]);

    const head = await getJson(`${api}/head`);
    expect(head.body.seq).toBe(4);
    const etag = head.headers.get('etag')!;
    expect((await getJson(`${api}/head`, { 'If-None-Match': etag })).status).toBe(304);

    const timeline = await getJson(`${api}/timeline`);
    expect(timeline.body.items.map((c: { seq: number }) => c.seq)).toEqual([3, 4]);
    expect(timeline.body.items[1].message).toBe('本地放一张桌子');
    expect(timeline.body.items[1].changedEntities).toEqual([
      { id: 'table-1', hash: expect.any(String) },
    ]);

    const local = await getJson(`${api}/snapshot?seq=4`);
    expect(local.body.seq).toBe(4);
    expect(local.body.entities.map((e: { id: string }) => e.id)).toEqual(['table-1', 'wall-1']);
    expect(local.body.entities[0].body.label).toBe('1 号桌');
    expect(local.body.chunks).toHaveLength(2);
    const base = await getJson(`${api}/snapshot?seq=3`);
    expect(base.body.entities.map((e: { id: string }) => e.id)).toEqual(['wall-1']);
    expect(base.body.chunks).toEqual([floorChunk().ref]);
    expect((await getJson(`${api}/snapshot?at=2026-11-09T00:00:00.000Z`)).body.seq).toBe(4);
    expect((await getJson(`${api}/snapshot?at=2020-01-01T00:00:00.000Z`)).body.seq).toBe(3);

    for (const chunk of local.body.chunks as { hash: string }[]) {
      const response = await fetch(`${dev.url}/api/public/chunks/${chunk.hash}.bin`);
      expect(response.status).toBe(200);
      decompressChunk(new Uint8Array(await response.arrayBuffer()), chunk.hash);
    }
    expect((await fetch(`${dev.url}/api/public/chunks/${'0'.repeat(64)}.bin`)).status).toBe(404);
    expect((await fetch(`${dev.url}/api/public/assets/${'0'.repeat(64)}.bin`)).status).toBe(404);

    expect((await getJson(`${api}/events`)).body).toEqual({ items: [], nextAfter: null });
    expect((await getJson(`${api}/events/density?from=a&to=b&bucket=60`)).body.buckets).toEqual([]);
    expect((await getJson(`${api}/state?at=2026-11-09T00:00:00Z`)).body.states).toEqual([]);
    expect((await getJson(`${dev.url}/api/public/previews`)).body.seq).toBe(4);
    expect((await getJson(`${dev.url}/api/public/spaces/other`)).status).toBe(404);
    expect((await getJson(`${api}/nope`)).status).toBe(404);
    expect((await fetch(api, { method: 'POST' })).status).toBe(405);

    // 重建：seq 加 1（查看器按 seq 缓存场景），ETag 跟着变。
    clock += 5000;
    await dev.rebuild();
    expect(dev.version()).toBe(2);
    const after = await getJson(`${api}/head`, { 'If-None-Match': etag });
    expect(after.status).toBe(200);
    expect(after.body.seq).toBe(5);
    expect((await getJson(`${dev.url}/__metaverse/status`)).body).toMatchObject({
      version: 2,
      seq: 5,
      error: null,
    });
  });

  it('托管 web/dist：静态文件、页面路由回到 index.html、不能跳出目录', async () => {
    const root = makeWorkspace({ script: SCRIPT });
    dirs.push(root);
    const dev = await start(root, webDist());
    const page = await fetch(`${dev.url}/s/demo-space`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('查看器');
    const js = await fetch(`${dev.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    const escape = await fetch(`${dev.url}/..%2f..%2fetc%2fpasswd`);
    expect(await escape.text()).toContain('查看器');
  });

  it('没有网站构建产物时给出说明；建造失败时保留上一次的结果', async () => {
    const root = makeWorkspace({ script: SCRIPT });
    dirs.push(root);
    const dev = await start(root, null);
    expect(await (await fetch(`${dev.url}/`)).text()).toContain('npm run build');
    writeFileSync(
      join(root, 'build', 'main.ts'),
      'export default () => { throw new Error("脚本坏了"); };',
    );
    await dev.rebuild();
    expect(dev.lastError()).toContain('脚本坏了');
    expect(dev.version()).toBe(1);
    const snapshot = await getJson(`${dev.url}/api/public/spaces/demo-space/snapshot?seq=4`);
    expect(snapshot.body.entities.map((e: { id: string }) => e.id)).toContain('table-1');
  });

  it('dev 命令：监视建造脚本，改了自动重建', async () => {
    const root = makeWorkspace({ script: SCRIPT });
    dirs.push(root);
    const ctx = makeContext(root);
    const started = await startDev(ctx, { port: '0', 'web-dist': webDist() }, true);
    server = started.server;
    expect(server.version()).toBe(1);
    writeFileSync(join(root, 'build', 'main.ts'), SCRIPT.replace('本地放一张桌子', '改过的脚本'));
    const deadline = Date.now() + 8000;
    while (server.version() < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    expect(server.version()).toBeGreaterThanOrEqual(2);
    const timeline = await getJson(`${server.url}/api/public/spaces/demo-space/timeline`);
    expect(timeline.body.items.at(-1).message).toBe('改过的脚本');
    expect(ctx.errors.join('\n')).toContain('已重建');
  });

  it('网站构建产物和浏览器的查找', () => {
    const root = makeWorkspace();
    dirs.push(root);
    const ctx = makeContext(root);
    const dist = webDist();
    expect(resolveWebDist(ctx, { root, config: readConfig(root) }, { 'web-dist': dist })).toBe(
      dist,
    );
    expect(() =>
      resolveWebDist(ctx, { root, config: readConfig(root) }, { 'web-dist': root }),
    ).toThrow('index.html');
    expect(findWebDist(dist)).toBeNull();
    const repo = tempDir();
    dirs.push(repo);
    mkdirSync(join(repo, 'web', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'web', 'dist', 'index.html'), '');
    mkdirSync(join(repo, 'sdk', 'typescript'), { recursive: true });
    expect(findWebDist(join(repo, 'sdk', 'typescript'))).toBe(join(repo, 'web', 'dist'));
    expect(() => browserPath(ctx, '/nope/chrome')).toThrow('找不到浏览器');
    expect(browserPath(makeContext(root, { METAVERSE_BROWSER_PATH: dist }), undefined)).toBe(dist);
  });
});
