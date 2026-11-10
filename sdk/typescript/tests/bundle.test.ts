import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/commands/index.js';
import { BundleError } from '../src/core/bundle.js';
import { DEFAULT_UPLOAD_LIMITS } from '../src/core/limits.js';
import type { Shape } from '../src/core/shape.js';
import { checkBundleDir } from '../src/workspace/bundle.js';
import { readDrafts } from '../src/workspace/drafts.js';
import { readBase, writeBase } from '../src/workspace/files.js';
import { sha256, writeBundle } from './helpers/bundle.js';
import { pngBytes } from './helpers/samples.js';
import { startFakeApi, type FakeApi, type FakeState } from './helpers/fakeApi.js';
import { makeContext, makeWorkspace, removeDir, tempDir } from './helpers/workspace.js';

/**
 * `metaverse bundle check`、`bundle push`、`publish`（重建草稿）对着假接口服务跑
 * （docs/design/server-slim.md 6.5、6.6；重建路径的接口按 2.3 的约定，接口服务那一步完成后联调）。
 */

let fake: FakeApi | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await fake?.close();
  fake = null;
  while (dirs.length > 0) removeDir(dirs.pop()!);
});

const SPACE = {
  id: 'demo-space',
  name: '演示空间',
  head: { seq: 5, at: '2026-11-05T00:00:00.000Z' },
  regions: [],
  plots: [],
  anchors: [],
  uploadLimits: DEFAULT_UPLOAD_LIMITS,
};

/** 工作区（direct 模式，指向假接口服务）和它的 out/bundle/。 */
function setup(options: Parameters<typeof writeBundle>[1] = {}) {
  const root = makeWorkspace({
    config: fake
      ? {
          mode: 'direct',
          api: fake.url,
          devTokenUrl: fake.devTokenUrl,
          webUrl: 'https://m.example',
        }
      : {},
  });
  dirs.push(root);
  const bundle = writeBundle(join(root, 'out', 'bundle'), options);
  return { root, bundle, ctx: makeContext(root) };
}

async function startWith(state: Partial<FakeState> = {}) {
  fake = await startFakeApi({ space: SPACE, ...state });
  return fake;
}

function rebuildRequests(api: FakeApi) {
  return api.requests.filter((r) => r.path.includes('/rebuild'));
}

describe('metaverse bundle check', () => {
  it('合格的包：清单、本地文件、模型与记录一致；默认上限', async () => {
    const { ctx } = setup();
    expect(await main(ctx, ['bundle', 'check'])).toBe(0);
    const text = ctx.lines.join('\n');
    expect(text).toContain('检查通过');
    expect(text).toContain('整体替换，模板 0 个、物件 2 件');
    expect(text).toContain('zip，网格成员 scan/mesh.drc');
    expect(text).toContain('glb，12 个三角形');
    expect(text).toContain('png 256×256');
    expect(text).toContain('上限：默认值');
    expect(ctx.errors).toEqual([]);
  });

  it('--json：每个文件的核对记录、引用表；本地没有的文件依赖空间里已有', async () => {
    const { ctx, bundle } = setup({ omit: ['scan/scan.zip'] });
    expect(await main(ctx, ['bundle', 'check', '--json'])).toBe(0);
    const report = JSON.parse(ctx.lines.join('\n'));
    expect(report.ok).toBe(true);
    expect(report.manifestHash).toBe(bundle.manifestHash);
    const scan = report.files.find((f: { path: string }) => f.path === 'scan/scan.zip');
    expect(scan.local).toBe(false);
    expect(scan.check).toBeUndefined();
    const model = report.files.find((f: { purpose: string }) => f.purpose === 'model');
    // float32 的顶点数据：-0.4 读出来是 -0.4000000059604645。
    expect(model.check.bounds.min[2]).toBeCloseTo(-0.4, 6);
    expect(model.check.bounds.max[1]).toBeCloseTo(0.9, 6);
    expect(Object.values(report.references).sort()).toEqual([
      'model',
      'scan',
      'script',
      'texture',
      'webmodel',
    ]);
  });

  it('文件和清单不一致、模型与记录不一致：列出每一处问题', async () => {
    const { ctx, root } = setup({ modelBounds: { min: [2, 0, 3], max: [3.5, 0.9, 3.8] } });
    writeFileSync(join(root, 'out', 'bundle', 'notes.md'), '# 改过了，长度不变吗？不。\n');
    expect(await main(ctx, ['bundle', 'check'])).toBe(1);
    const error = ctx.errors.join('\n');
    expect(error).toContain('notes.md：大小');
    expect(error).toContain('物件 rb.sofa-01');
    expect(error).toContain('x 轴');
  });

  it('同样大小但内容被改：sha256 不符；文件内容不合用途', async () => {
    const { ctx, root, bundle } = setup();
    const notes = join(root, 'out', 'bundle', 'notes.md');
    const original = readFileSync(notes);
    writeFileSync(notes, Buffer.alloc(original.length, 0x41));
    expect(await main(ctx, ['bundle', 'check'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('notes.md：sha256');
    // 网页用模型换成贴图的字节（清单跟着改）：内容检查不通过。
    writeBundle(join(root, 'out', 'bad'), {
      mutate: (m, files) => {
        const png = pngBytes(4, 4);
        files.set('web/scan-0.glb', png);
        (m.scan as { webModelHashes: string[] }).webModelHashes = [sha256(png)];
      },
    });
    expect(await main(ctx, ['bundle', 'check', 'out/bad'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain(
      'web/scan-0.glb：不是 glb 文件（缺少 glTF 魔数）（glb_header）',
    );
    expect(bundle.files.size).toBe(5);
  });

  it('清单不合规：报出字段', async () => {
    const { ctx } = setup({
      mutate: (m) =>
        ((m.rebuilt as { entities: { entityId: string }[] }).entities[0]!.entityId = 'wall-01'),
    });
    expect(await main(ctx, ['bundle', 'check'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('rebuilt.entities[0].entityId');
  });

  it('--seed：内部锚点和建模记录给出警告；base.spaceId 与工作区不同也警告', async () => {
    const { ctx } = setup({ internalAnchor: true, base: { spaceId: 'other-space', seq: 2 } });
    expect(await main(ctx, ['bundle', 'check', '--seed'])).toBe(0);
    const warnings = ctx.errors.join('\n');
    expect(warnings).toContain('内部级锚点：sofa-01');
    expect(warnings).toContain('建模记录');
    expect(warnings).toContain('bundle push 会拒绝');
  });

  it('上限取工作区的 limits.json 或 --limits；不合法时报错', async () => {
    const { ctx, root } = setup();
    const tight = {
      ...DEFAULT_UPLOAD_LIMITS,
      model: { ...DEFAULT_UPLOAD_LIMITS.model, maxTriangles: 10 },
    };
    writeFileSync(join(root, 'limits.json'), JSON.stringify(tight));
    expect(await main(ctx, ['bundle', 'check'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('超过上限 10');
    writeFileSync(join(root, 'loose.json'), JSON.stringify(DEFAULT_UPLOAD_LIMITS));
    expect(await main(ctx, ['bundle', 'check', '--limits', 'loose.json'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('上限：loose.json');
    writeFileSync(join(root, 'limits.json'), '{"v":2}');
    expect(await main(ctx, ['bundle', 'check'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('limits.json 不合法');
    expect(await main(ctx, ['bundle', 'check', '--limits', 'nope.json'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('--limits nope.json 不合法');
  });

  it('不在工作区里要给目录；目录里没有清单时报错', async () => {
    const outside = tempDir();
    dirs.push(outside);
    const ctx = makeContext(outside);
    expect(await main(ctx, ['bundle', 'check'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('请给出包目录');
    writeBundle(join(outside, 'b'));
    expect(await main(ctx, ['bundle', 'check', 'b'])).toBe(0);
    expect(await main(ctx, ['bundle', 'check', 'nothing'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('没有 manifest.json');
    expect(await main(ctx, ['bundle'])).toBe(1);
    expect(await main(ctx, ['bundle', '--help'])).toBe(0);
    expect(await main(ctx, ['bundle', 'check', '--help'])).toBe(0);
    expect(await main(ctx, ['bundle', 'push', '--help'])).toBe(0);
    expect(await main(ctx, ['bundle', 'pull'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('只有 check 和 push');
  });

  it('合并包可以引用工作区拉取的重建层模板', async () => {
    const { ctx, root } = setup({
      mode: 'merge',
      mutate: (m) =>
        (m.rebuilt as { entities: unknown[] }).entities.push({
          entityId: 'rb.chair-02',
          layer: 'rebuilt',
          kind: 'object',
          shape: { type: 'instance', template: 'rb.chair-a', transform: { position: [1, 0, 1] } },
          bounds: { min: [0.8, 0, 0.8], max: [1.2, 0.8, 1.2] },
        }),
    });
    expect(await main(ctx, ['bundle', 'check'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('rb.chair-a');
    const base = readBase(root, 'demo-space');
    writeBase(root, {
      ...base,
      entities: [
        ...base.entities,
        {
          entityId: 'rb.chair-a',
          layer: 'rebuilt',
          kind: 'template',
          shape: { type: 'box', size: [0.4, 0.8, 0.4] },
          bounds: { min: [-0.2, 0, -0.2], max: [0.2, 0.8, 0.2] },
        },
      ],
    });
    expect(await main(ctx, ['bundle', 'check'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('合并，模板 0 个、物件 3 件、删除 1 个编号');
  });
});

/** 向量 tests/vectors/bundle/ 经 bundle check 的目录检查跑一遍（文件都不在本地，只查清单），结果与 Rust 相同。 */
const BUNDLE_VECTORS = resolve(
  process.env.METAVERSE_VECTORS_DIR ??
    join(import.meta.dirname, '../../../api/crates/metaverse-core/tests/vectors'),
  'bundle',
);

describe.skipIf(!existsSync(BUNDLE_VECTORS))('bundle check 跑重建包清单向量', () => {
  const names = existsSync(BUNDLE_VECTORS)
    ? readdirSync(BUNDLE_VECTORS).filter((n) => n.startsWith('bundle_') && n.endsWith('.json'))
    : [];
  for (const name of names.sort()) {
    it(name, async () => {
      const vector = JSON.parse(readFileSync(join(BUNDLE_VECTORS, name), 'utf8'));
      if (vector.kind === 'bundle-limits') return;
      const dir = tempDir();
      dirs.push(dir);
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(vector.manifest));
      const templates = vector.spaceTemplates
        ? new Map(Object.entries(vector.spaceTemplates as Record<string, Shape>))
        : null;
      try {
        const report = await checkBundleDir(dir, {
          ...(vector.limits ? { limits: vector.limits } : {}),
          spaceTemplates: templates,
        });
        expect(vector.expect.valid).toBe(true);
        expect(report.files.every((f) => !f.local)).toBe(true);
        expect(Object.fromEntries(report.bundle.references)).toEqual(vector.expect.references);
      } catch (error) {
        expect(error).toBeInstanceOf(BundleError);
        expect({ valid: false, field: (error as BundleError).field }).toEqual({
          valid: vector.expect.valid,
          field: vector.expect.field,
        });
      }
    });
  }
});

describe('metaverse bundle push', () => {
  it('上传、等核对、建重建草稿、交包、等展开、预览；不发布，记进 drafts.json', async () => {
    const api = await startWith();
    const { ctx, root, bundle } = setup();
    expect(await main(ctx, ['bundle', 'push'])).toBe(0);
    const text = ctx.lines.join('\n');
    // 全部走重建路径。
    const uploads = rebuildRequests(api).filter(
      (r) => r.method === 'POST' && /\/rebuild\/uploads\/[a-z]+$/.test(r.path),
    );
    expect(uploads.map((r) => r.path.split('/').at(-1)).sort()).toEqual([
      'bundle',
      'model',
      'scan',
      'script',
      'texture',
      'webmodel',
    ]);
    const formats = Object.fromEntries(
      uploads.map((r) => [r.path.split('/').at(-1), JSON.parse(r.body.toString()).format]),
    );
    expect(formats).toEqual({
      scan: 'zip',
      webmodel: 'glb',
      model: 'glb',
      texture: 'png',
      script: 'text',
      bundle: 'json',
    });
    const draft = api.requests.find(
      (r) => r.method === 'POST' && r.path.endsWith('/rebuild/drafts'),
    );
    expect(JSON.parse(draft!.body.toString())).toEqual({ baseSeq: 5 });
    const applied = api.requests.find((r) => /\/rebuild\/drafts\/[^/]+\/bundle$/.test(r.path));
    expect(JSON.parse(applied!.body.toString())).toHaveProperty('uploadId');
    expect(
      api.requests.some((r) => r.path.includes('/jobs/') && !r.path.includes('/rebuild/')),
    ).toBe(false);
    expect(api.requests.some((r) => r.path.endsWith('/publish'))).toBe(false);
    expect(text).toContain('展开完成：放置物件 2 件，删除 0 件；新建锚点 1 个');
    expect(text).toContain('预览链接：https://m.example/preview#t=preview-token-abc');
    expect(text).toMatch(/metaverse publish draft-\d+/);
    const drafts = readDrafts(root);
    const [id, record] = Object.entries(drafts)[0]!;
    expect(record).toMatchObject({
      scope: 'rebuild',
      plot: null,
      baseSeq: 5,
      bundle: bundle.manifestHash,
    });
    expect(api.state.drafts.get(id)!.bundle).toBe(bundle.manifestHash);
  });

  it('没有 base 要 --base latest；空间不符、基础版本超过最新都拒绝', async () => {
    const api = await startWith();
    const { ctx } = setup({ base: null });
    expect(await main(ctx, ['bundle', 'push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('--base latest');
    expect(await main(ctx, ['bundle', 'push', '--base', 'seq3'])).toBe(1);
    expect(api.requests.filter((r) => r.path.includes('/rebuild/'))).toEqual([]);
    expect(await main(ctx, ['bundle', 'push', '--base', 'latest', '--no-preview'])).toBe(0);
    expect(ctx.errors.join('\n')).toContain('以最新版本 seq 5 为基础');
    const draft = api.requests.find(
      (r) => r.method === 'POST' && r.path.endsWith('/rebuild/drafts'),
    );
    expect(JSON.parse(draft!.body.toString())).toEqual({ baseSeq: 5 });
    expect(api.requests.some((r) => r.path.endsWith('/preview'))).toBe(false);

    const other = setup({ base: { spaceId: 'other-space', seq: 2 } });
    expect(await main(other.ctx, ['bundle', 'push'])).toBe(1);
    expect(other.ctx.errors.at(-1)).toContain('清单是空间 other-space 的');
    const future = setup({ base: { spaceId: 'demo-space', seq: 9 } });
    expect(await main(future.ctx, ['bundle', 'push'])).toBe(1);
    expect(future.ctx.errors.at(-1)).toContain('第 9 版');
  });

  it('时间线前进时提示；同一扫描换了变换时提示', async () => {
    await startWith({
      space: { ...SPACE, head: { seq: 7, at: '2026-11-07T00:00:00.000Z' } },
    });
    const { ctx, bundle } = setup();
    fake!.state.snapshot = {
      seq: 7,
      at: '2026-11-07T00:00:00.000Z',
      chunks: [],
      entities: [],
      anchors: [],
      regions: [],
      plots: [],
      scan: {
        assetHash: (bundle.manifest.scan as { assetHash: string }).assetHash,
        webModelHashes: [],
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
      },
    };
    expect(await main(ctx, ['bundle', 'push', '--no-preview'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('从第 5 版前进到第 7 版');
    expect(ctx.errors.join('\n')).toContain('变换不同');
  });

  it('同一扫描换了变换时 --publish 停下，--realign 才发布；换了扫描时提醒要配准', async () => {
    const snapshot = (assetHash: string) => ({
      seq: 5,
      at: '2026-11-05T00:00:00.000Z',
      chunks: [],
      entities: [],
      anchors: [],
      regions: [],
      plots: [],
      scan: {
        assetHash,
        webModelHashes: [],
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
      },
    });
    const api = await startWith();
    const first = setup();
    const scanHash = (first.bundle.manifest.scan as { assetHash: string }).assetHash;
    fake!.state.snapshot = snapshot(scanHash);
    expect(await main(first.ctx, ['bundle', 'push', '--publish', '--no-preview'])).toBe(1);
    expect(first.ctx.errors.at(-1)).toContain('没有推送');
    expect(first.ctx.errors.at(-1)).toContain('--realign');
    expect(api.requests.some((r) => r.path.endsWith('/rebuild/drafts'))).toBe(false);

    const second = setup();
    expect(
      await main(second.ctx, ['bundle', 'push', '--publish', '--realign', '--no-preview']),
    ).toBe(0);
    expect(second.ctx.errors.join('\n')).toContain('有意重新对齐');
    expect(api.requests.some((r) => r.path.endsWith('/publish'))).toBe(true);

    const third = setup();
    fake!.state.snapshot = snapshot('f'.repeat(64));
    expect(await main(third.ctx, ['bundle', 'push', '--no-preview'])).toBe(0);
    expect(third.ctx.errors.join('\n')).toContain('包换了扫描');
  });

  it('读不了快照时跳过变换核对', async () => {
    await startWith({ space: { ...SPACE, head: { seq: 7, at: 'x' } } });
    const { ctx } = setup();
    expect(await main(ctx, ['bundle', 'push', '--no-preview'])).toBe(0);
    expect(ctx.errors.join('\n')).toContain('跳过扫描变换的核对');
  });

  it('空间里已有的文件直接复用；本地没有又不能复用就停下，不建草稿', async () => {
    const api = await startWith();
    const { ctx, bundle, root } = setup({ omit: ['scan/scan.zip'] });
    expect(await main(ctx, ['bundle', 'push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('scan/scan.zip');
    expect(api.requests.some((r) => r.path.endsWith('/rebuild/drafts'))).toBe(false);
    expect(api.requests.some((r) => r.method === 'PUT')).toBe(false);
    // 空间里已有这份扫描（例如线上那份），本地不用有。
    const scanBytes = bundle.files.get('scan/scan.zip')!;
    api.state.assets.set(sha256(scanBytes), Buffer.from(scanBytes));
    const model = [...bundle.files.entries()].find(([p]) => p.startsWith('models/'))!;
    api.state.assets.set(sha256(model[1]), Buffer.from(model[1]));
    const before = api.requests.length;
    expect(await main(ctx, ['bundle', 'push', '--json'])).toBe(0);
    const out = JSON.parse(ctx.lines.at(-1)!);
    const files = Object.fromEntries(
      (out.files as { path: string; reused: boolean }[]).map((f) => [f.path, f.reused]),
    );
    expect(files['scan/scan.zip']).toBe(true);
    expect(files[model[0]]).toBe(true);
    expect(files['notes.md']).toBe(false);
    const puts = api.requests.slice(before).filter((r) => r.method === 'PUT');
    expect(puts.some((r) => r.path.includes('/uploads/scan/'))).toBe(false);
    expect(puts.some((r) => r.path.includes('/uploads/model/'))).toBe(false);
    expect(Object.keys(readDrafts(root))).toHaveLength(1);
  });

  it('--publish：直接发布；同一个包再推一次没有变化', async () => {
    const api = await startWith();
    const { ctx } = setup();
    expect(await main(ctx, ['bundle', 'push', '--publish', '--message', '前厅第 4 版'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('已发布草稿');
    const publish = api.requests.filter((r) => r.path.endsWith('/publish'));
    expect(publish[0]!.path).toContain('/rebuild/drafts/');
    expect(JSON.parse(publish[0]!.body.toString())).toEqual({ message: '前厅第 4 版' });
    expect(await main(ctx, ['bundle', 'push', '--publish'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('没有写新提交（最新仍是 seq 5）');
    // 不给 --message 时用清单的 note。
    expect(
      JSON.parse(api.requests.filter((r) => r.path.endsWith('/publish'))[1]!.body.toString()),
    ).toEqual({
      message: '测试包：一张沙发、一面墙',
    });
  });

  it('发布冲突：打印冲突的键；之后 metaverse publish --replay 走重建路径', async () => {
    const api = await startWith({ publishConflict: true, replayResolves: true });
    const { ctx, root } = setup();
    expect(await main(ctx, ['bundle', 'push', '--publish'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('table-1');
    expect(ctx.errors.at(-1)).toContain('--rebuild --replay');
    const [draftId] = Object.keys(readDrafts(root));
    expect(await main(ctx, ['publish', draftId!, '--replay'])).toBe(0);
    const last = api.requests.at(-1)!;
    expect(last.path).toBe(`/api/v1/spaces/demo-space/rebuild/drafts/${draftId}/publish`);
    expect(JSON.parse(last.body.toString())).toEqual({ replay: true });
    expect(ctx.lines.at(-2)).toContain('（重建草稿）');
    // 推送时就带 --replay。
    expect(await main(ctx, ['bundle', 'push', '--publish', '--replay'])).toBe(0);
    expect(await main(ctx, ['bundle', 'push', '--replay'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('--replay 要和 --publish 一起用');
  });

  it('没有重建权限：403 rebuild_permission_required', async () => {
    await startWith({ rebuildPermission: false });
    const { ctx } = setup();
    expect(await main(ctx, ['bundle', 'push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('rebuild_permission_required');
  });

  it('展开结果里跳过的锚点和锚点漂移', async () => {
    await startWith({
      bundleResult: {
        entities: { placed: 2, removed: 1 },
        anchors: {
          created: 0,
          skipped: [
            { id: 'sofa-01', reason: 'exists' },
            { id: 'counter-01', reason: 'existed' },
          ],
        },
        anchorDrift: [{ anchorId: 'counter-01', entityIds: ['rb.counter-01'] }],
      },
    });
    const { ctx } = setup();
    expect(await main(ctx, ['bundle', 'push', '--no-preview'])).toBe(0);
    const text = ctx.lines.join('\n');
    expect(text).toContain('新建锚点 0 个');
    expect(text).toContain('sofa-01（已存在）、counter-01（曾经存在，被删过）');
    expect(text).toContain('锚点漂移');
    expect(text).toContain('counter-01（rb.counter-01）');
  });

  it('只读工作区、检查不过、参数不对时什么也不传', async () => {
    const api = await startWith();
    const { ctx, root } = setup({ modelBounds: { min: [0, 0, 0], max: [5, 5, 5] } });
    expect(await main(ctx, ['bundle', 'push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('没有通过检查');
    const base = readBase(root, 'demo-space');
    writeBase(root, { ...base, space: { ...base.space, readOnly: true } });
    expect(await main(ctx, ['bundle', 'push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('只读');
    expect(await main(ctx, ['push'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('只读');
    writeBase(root, base);
    expect(await main(ctx, ['bundle', 'push', '--preview-ttl', '5'])).toBe(1);
    expect(await main(ctx, ['bundle', 'push', '--message', ''])).toBe(1);
    expect(await main(ctx, ['bundle', 'push', '--part-size', '0.1'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('256KiB');
    expect(api.requests).toEqual([]);
    const outside = tempDir();
    dirs.push(outside);
    writeBundle(join(outside, 'b'));
    expect(await main(makeContext(outside), ['bundle', 'push', 'b'])).toBe(1);
  });
});

describe('metaverse publish（重建草稿）', () => {
  it('--rebuild 走重建路径；没有变化时说明；--rebuild 和 --plot 不能一起给', async () => {
    const api = await startWith({ publishedBundles: new Set(['x']) });
    const { ctx } = setup();
    api.state.drafts.set('draft-r', {
      scopePath: '/api/v1/spaces/demo-space/rebuild',
      baseSeq: 5,
      ops: [],
      bundle: 'x',
    });
    expect(await main(ctx, ['publish', 'draft-r', '--rebuild'])).toBe(0);
    expect(ctx.lines.at(-1)).toContain('没有写新提交');
    const jsonCtx = makeContext(ctx.cwd);
    expect(await main(jsonCtx, ['publish', 'draft-r', '--rebuild', '--json'])).toBe(0);
    expect(JSON.parse(jsonCtx.lines.join('\n'))).toEqual({ unchanged: true, seq: 5 });
    expect(await main(ctx, ['publish', 'draft-r', '--rebuild', '--plot', 'p1'])).toBe(1);
    // 不走重建路径就找不到这个草稿。
    expect(await main(ctx, ['publish', 'draft-r'])).toBe(1);
  });

  it('模板引用不完整（409 broken_template_ref）、资源被清理：说明处理办法', async () => {
    const api = await startWith({
      publishProblem: {
        status: 409,
        code: 'broken_template_ref',
        detail: '模板 rb.chair-a 被删了',
        extra: { missing: [{ entityId: 'rb.chair-02', template: 'rb.chair-a' }] },
      },
    });
    const { ctx } = setup();
    api.state.drafts.set('draft-r', {
      scopePath: '/api/v1/spaces/demo-space/rebuild',
      baseSeq: 5,
      ops: [],
    });
    expect(await main(ctx, ['publish', 'draft-r', '--rebuild'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('rb.chair-02');
    expect(ctx.errors.at(-1)).toContain('bundle push');
    api.state.publishProblem = {
      status: 409,
      code: 'asset_gone',
      detail: '资源被清理',
      extra: { assets: ['a'.repeat(64)] },
    };
    expect(await main(ctx, ['publish', 'draft-r', '--rebuild'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('重新运行 metaverse bundle push');
  });
});
