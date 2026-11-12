import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../src/commands/index.js';
import { entity, place } from '../src/kit/ops.js';
import { box } from '../src/kit/shapes.js';
import { readBase, writeBase } from '../src/workspace/files.js';
import { parseEdit, type EditPlan } from '../src/workspace/edit.js';
import { startFakeApi, type FakeApi } from './helpers/fakeApi.js';
import { makeContext, makeWorkspace, removeDir } from './helpers/workspace.js';
import { meshGlb, pngBytes } from './helpers/samples.js';

const roots: string[] = [];
let fake: FakeApi | undefined;
afterEach(async () => {
  roots.splice(0).forEach(removeDir);
  await fake?.close();
  fake = undefined;
});

function setup(plan: EditPlan) {
  const root = makeWorkspace({ script: 'export default () => [];' });
  roots.push(root);
  mkdirSync(join(root, 'work'), { recursive: true });
  writeFileSync(join(root, 'work/edit.json'), JSON.stringify(plan));
  return root;
}

async function connect(root: string) {
  fake = await startFakeApi();
  const config = JSON.parse(readFileSync(join(root, 'metaverse.json'), 'utf8'));
  writeFileSync(
    join(root, 'metaverse.json'),
    JSON.stringify({ ...config, api: fake.url, devTokenUrl: fake.devTokenUrl }),
  );
  return fake;
}

it('家具、参数形状、锚点和删除共用标准操作，不要求背景、前缀或新地块', async () => {
  const plan: EditPlan = {
    version: 1,
    message: '调整陈设',
    baseSeq: 3,
    ops: [
      place('chair', box([0.5, 1, 0.5], { at: [3, 0, 3] })),
      place('decoration', box([0.2, 0.4, 0.2], { at: [2, 0, 2] })),
      { op: 'removeEntity', entityId: 'old-lamp' },
      { op: 'moveAnchor', anchorId: 't1', position: [1, 1, 1] },
      { op: 'fill', box: [60, 0, 60, 61, 1, 61], block: 2 },
    ],
  };
  const root = setup(plan);
  const base = readBase(root, 'demo-space');
  writeBase(root, {
    ...base,
    entities: [
      ...base.entities,
      entity('chair', box([0.5, 1, 0.5], { at: [1, 0, 1] })),
      entity('old-lamp', box([0.2, 1, 0.2], { at: [2, 0, 2] })),
    ],
  });
  const api = await connect(root);
  const source = readFileSync(join(root, 'build/main.ts'), 'utf8');
  expect(await main(makeContext(root), ['edit', 'push', '--inline'])).toBe(0);
  const draft = [...api.state.drafts.values()][0]!;
  expect(draft.scopePath).toBe('/api/v1/spaces/demo-space');
  expect(draft.ops).toEqual(plan.ops);
  expect(api.requests.some((r) => r.path.endsWith('/preview'))).toBe(true);
  expect(api.requests.some((r) => r.path.endsWith('/publish') || r.path.includes('/admin/'))).toBe(
    false,
  );
  expect(readFileSync(join(root, 'build/main.ts'), 'utf8')).toBe(source);
  const result = JSON.parse(readFileSync(join(root, 'out/result.json'), 'utf8'));
  expect(result.final.entities.some((e: { entityId: string }) => e.entityId === 'old-lamp')).toBe(
    false,
  );
  expect(
    result.final.entities.find((e: { entityId: string }) => e.entityId === 'chair').bounds.min[0],
  ).toBe(2.75);
});

it('普通模型和贴图走同一资源流程；不要求每个物件都有模型文件', async () => {
  const model = meshGlb(),
    texture = pngBytes(8, 8);
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const plan: EditPlan = {
    version: 1,
    message: '摆放模型与带贴图的形状',
    ops: [
      {
        op: 'placeEntity',
        entity: {
          entityId: 'sculpture',
          layer: 'ext',
          kind: 'object',
          assetHash: hash(model),
          bounds: { min: [1, 0, 1], max: [2, 1, 2] },
        },
      },
      place(
        'sign',
        box([0.5, 0.5, 0.1], { at: [3, 0, 3], texture: { hash: hash(texture), uv: 'box' } }),
      ),
    ],
    assets: [
      { hash: hash(model), format: 'glb' },
      { hash: hash(texture), format: 'png' },
    ],
  };
  const root = setup(plan);
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', hash(model) + '.glb'), model);
  writeFileSync(join(root, 'assets', hash(texture) + '.png'), texture);
  const api = await connect(root);
  expect(await main(makeContext(root), ['edit', 'push', '--inline'])).toBe(0);
  expect(api.requests.some((r) => r.path.endsWith('/uploads/model'))).toBe(true);
  expect(api.requests.some((r) => r.path.endsWith('/uploads/texture'))).toBe(true);
});

it('过期计划和资源哈希错误都在网络写入前拒绝', async () => {
  const plan: EditPlan = {
    version: 1,
    message: '摆放内容',
    baseSeq: 2,
    ops: [place('object', box([1, 1, 1], { at: [2, 0, 2] }))],
  };
  const root = setup(plan);
  const api = await connect(root);
  const ctx = makeContext(root);
  expect(await main(ctx, ['edit', 'push'])).toBe(1);
  expect(ctx.errors.join('\n')).toContain('空间版本');
  const data = meshGlb();
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'a'.repeat(64) + '.glb'), data);
  writeFileSync(
    join(root, 'work/edit.json'),
    JSON.stringify({ ...plan, baseSeq: 3, assets: [{ hash: 'a'.repeat(64), format: 'glb' }] }),
  );
  expect(await main(ctx, ['edit', 'push'])).toBe(1);
  expect(ctx.errors.join('\n')).toContain('哈希不符');
  expect(api.requests).toHaveLength(0);
});

it('通用计划拒绝未知操作、资源路径逃逸和只读快照', async () => {
  expect(() =>
    parseEdit({ version: 1, message: '内容', ops: [{ op: 'placeBuilding' }] }),
  ).toThrow();
  const root = setup({ version: 1, message: '内容', ops: [] });
  const outside = setup({ version: 1, message: '其他工作区', ops: [] });
  writeFileSync(
    join(root, 'work/edit.json'),
    JSON.stringify({
      version: 1,
      message: '内容',
      ops: [],
      assets: [
        {
          hash: 'a'.repeat(64),
          format: 'glb',
          path: relative(root, join(outside, 'metaverse.json')),
        },
      ],
    }),
  );
  const escaped = makeContext(root);
  expect(await main(escaped, ['edit', 'check'])).toBe(1);
  expect(escaped.errors.join('\n')).toContain('资源文件必须位于空间工作区内');
  const base = readBase(root, 'demo-space');
  writeBase(root, { ...base, space: { ...base.space, readOnly: true } });
  const ctx = makeContext(root);
  expect(await main(ctx, ['edit', 'push'])).toBe(1);
  expect(ctx.errors.join('\n')).toContain('分享快照不能编辑');
});
