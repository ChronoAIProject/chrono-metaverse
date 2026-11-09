import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/commands/index.js';
import { previewLink } from '../src/commands/push.js';
import { parseTransform } from '../src/commands/scan.js';
import { runVoxelize } from '../src/commands/voxelize.js';
import { validateLayout } from '../src/commands/admin.js';
import { chunkHash, compressChunk, emptyChunk } from '../src/core/chunk.js';
import { readConfig, writeConfig } from '../src/workspace/config.js';
import { readBase } from '../src/workspace/files.js';
import { startFakeApi, type FakeApi } from './helpers/fakeApi.js';
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
    const root = makeWorkspace({
      config: { mode: 'nyxid', nyxBase: fake.url, slug: 'chrono-metaverse' },
    });
    dirs.push(root);
    const ctx = makeContext(root, { NYXID_TOKEN: 'agent-key-1', HOME: '/nonexistent' });
    expect(await main(ctx, ['pull', '--token', 'flag-key'])).toBe(0);
    const request = fake.requests.find((r) => r.path.endsWith('/api/v1/spaces/demo-space'))!;
    expect(request.path).toBe('/api/v1/proxy/s/chrono-metaverse/api/v1/spaces/demo-space');
    expect(request.headers.authorization).toBe('Bearer flag-key');
    expect(request.headers['x-nyxid-identity-token']).toBeUndefined();
    expect(await main(makeContext(root, { NYXID_TOKEN: 'agent-key-1' }), ['pull'])).toBe(0);
    expect(fake.requests.at(-1)!.headers.authorization).toBe('Bearer agent-key-1');
    // 找不到令牌。
    const noToken = makeContext(root, { NYXID_TOKEN_FILE: join(root, 'missing') });
    expect(await main(noToken, ['pull'])).toBe(1);
    expect(noToken.errors.at(-1)).toContain('找不到 NyxID 令牌');
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
    expect(JSON.parse(create.body.toString())).toEqual({ baseSeq: 3, message: '放两张桌子' });
    const draft = [...fake.state.drafts.values()][0]!;
    expect(draft.scopePath).toBe('/api/v1/spaces/demo-space/plots/p1');
    expect(draft.ops.map((op) => (op as { op: string }).op)).toEqual([
      'placeEntity',
      'placeEntity',
    ]);
    const upload = fake.requests.find((r) => r.path.endsWith('/plots/p1/uploads/ops'))!;
    expect(JSON.parse(upload.body.toString())).toMatchObject({
      contentType: 'application/x-ndjson',
      partSize: 8388608,
    });
    const drafts = JSON.parse(readFileSync(join(root, 'out/drafts.json'), 'utf8')) as Record<
      string,
      { plot: string }
    >;
    const draftId = Object.keys(drafts)[0]!;
    expect(drafts[draftId]!.plot).toBe('p1');
    // 发布：草稿记住了地块，走同一范围的路径。
    const publishCtx = makeContext(root);
    expect(await main(publishCtx, ['publish', draftId, '--message', '确认'])).toBe(0);
    expect(publishCtx.lines[0]).toContain('seq 6');
    const publish = fake.requests.at(-1)!;
    expect(publish.path).toBe(`/api/v1/spaces/demo-space/plots/p1/drafts/${draftId}/publish`);
    expect(JSON.parse(publish.body.toString())).toEqual({ message: '确认' });
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
    writeFileSync(join(root, 'lobby.glb'), Buffer.alloc(600 * 1024, 3));
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
    const scan = fake.requests.find((r) => r.path.endsWith('/scans'))!;
    expect(JSON.parse(scan.body.toString())).toMatchObject({
      observedAt: '2026-11-01T10:00:00Z',
      rebuild: true,
      voxelize: true,
    });
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
    expect(() => parseTransform('1,2,3')).toThrow('16 个数');
  });

  it('参数检查', async () => {
    fake = await startFakeApi();
    const root = directWorkspace(fake);
    const ctx = makeContext(root);
    expect(await main(ctx, ['scan'])).toBe(1);
    expect(await main(ctx, ['scan', 'nope.glb'])).toBe(1);
    writeFileSync(join(root, 'x.txt'), 'x');
    expect(await main(ctx, ['scan', 'x.txt'])).toBe(1);
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
      confirmPublic: true,
    });
    expect(
      await main(ws, ['admin', 'rotate-share-token', '--revoke', 'st_1', '--revoke', 'st_0']),
    ).toBe(0);
    expect(JSON.parse(fake.requests.at(-1)!.body.toString())).toEqual({ revoke: ['st_1', 'st_0'] });
    expect(ws.lines.join('\n')).toContain('share-secret-2');

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
    expect(await main(ws, ['admin', 'redact-event', 'ev-1', '--reason', '个人信息'])).toBe(0);
    expect(fake.requests.at(-1)!.path).toBe('/api/v1/admin/spaces/demo-space/events/ev-1/redact');
    expect(await main(ws, ['admin'])).toBe(1);
    expect(await main(ws, ['admin', 'explode'])).toBe(1);
    expect(await main(ws, ['admin', 'create-space', 'x'])).toBe(1);
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
