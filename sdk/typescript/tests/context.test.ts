import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../src/commands/index.js';
import { coveredBy, boxesIntersect } from '../src/core/grid.js';
import type { EntityBody } from '../src/core/record.js';
import { readBase, writeBase } from '../src/workspace/files.js';
import {
  checkContextOwnership,
  contextLayout,
  type ContextArtifact,
} from '../src/workspace/context.js';
import { makeContext, makeWorkspace, removeDir } from './helpers/workspace.js';
import { startFakeApi, type FakeApi } from './helpers/fakeApi.js';
import { meshGlb } from './helpers/samples.js';

const roots: string[] = [];
let fake: FakeApi | undefined;
afterEach(async () => {
  roots.splice(0).forEach(removeDir);
  await fake?.close();
  fake = undefined;
});

function setup() {
  const root = makeWorkspace({ script: 'export default function build() { return []; }' });
  roots.push(root);
  const base = readBase(root, 'demo-space');
  const data = meshGlb();
  const hash = createHash('sha256').update(data).digest('hex');
  const entity: EntityBody = {
    entityId: 'outside.building',
    layer: 'ext',
    kind: 'object',
    regionId: 'garden',
    assetHash: hash,
    bounds: { min: [5.5, 0, 0.5], max: [6.5, 1, 1.5] },
    props: { background: true },
  };
  const artifact: ContextArtifact = {
    version: 1,
    entityPrefix: 'outside.',
    message: '外景',
    entities: [entity],
  };
  mkdirSync(join(root, 'out/context'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'out/context/entities.json'), JSON.stringify(artifact));
  writeFileSync(join(root, 'assets', hash + '.glb'), data);
  return { root, base, artifact, data, hash };
}

it('规划独立区域并保留主体及其他地块', () => {
  const { base, artifact } = setup();
  artifact.entities[0] = {
    ...artifact.entities[0]!,
    bounds: { min: [-10, -10, -10], max: [-5, -5, -5] },
  };
  const layout = contextLayout(base, artifact, 'context');
  expect(layout.regions.slice(0, 2)).toEqual(base.space.regions);
  expect(layout.plots[0]).toEqual(base.space.plots[0]);
  const boxes = layout.plots.at(-1)!.boxes;
  expect(
    boxes.every((box) =>
      base.space.regions.every((region) =>
        region.boxes.every((occupied) => !boxesIntersect(box, occupied)),
      ),
    ),
  ).toBe(true);
  expect(coveredBy([-200, -200, -200, -100, -100, -100], boxes)).toBe(true);
});

it('背景跨越已有区域时在修改布局前拒绝', () => {
  const { base, artifact } = setup();
  artifact.entities[0] = {
    ...artifact.entities[0]!,
    bounds: { min: [-10, -10, -10], max: [20, 20, 20] },
  };
  expect(() => contextLayout(base, artifact, 'context')).toThrow('与已有区域重叠');
});

it('拒绝覆盖主体物件的前缀', () => {
  const { base, artifact } = setup();
  expect(() =>
    checkContextOwnership(
      { ...base, entities: [{ ...artifact.entities[0]!, props: {} }] },
      artifact,
    ),
  ).toThrow('冲突');
});

it('按地块权限上传并等待核对，生成草稿预览后等待确认', async () => {
  const { root, base, artifact } = setup();
  fake = await startFakeApi();
  const config = JSON.parse(readFileSync(join(root, 'metaverse.json'), 'utf8'));
  writeFileSync(
    join(root, 'metaverse.json'),
    JSON.stringify({
      ...config,
      api: fake.url,
      devTokenUrl: fake.devTokenUrl,
      plot: 'p1',
      webUrl: 'https://viewer.example',
    }),
  );
  const primary = JSON.stringify(base.entities);
  const ctx = makeContext(root);
  const originalScript = readFileSync(join(root, 'build/main.ts'), 'utf8');
  expect(await main(ctx, ['context', 'push', '--inline', '--preview-ttl', '120'])).toBe(0);
  expect(ctx.lines.join('\n')).toContain('/preview#t=');
  expect(fake.requests.some((call) => call.path.includes('/plots/p1/uploads/model'))).toBe(true);
  expect(fake.requests.some((call) => call.path.endsWith('/publish'))).toBe(false);
  expect(JSON.stringify(readBase(root, 'demo-space').entities)).toBe(primary);
  expect(readFileSync(join(root, 'build/main.ts'), 'utf8')).toBe(originalScript);
  // 模拟保存后重新拉取，移除旧背景但保留其他前缀，重复生成不叠加。
  writeBase(root, {
    ...base,
    entities: [
      ...base.entities,
      artifact.entities[0]!,
      { ...artifact.entities[0]!, entityId: 'outside.old' },
    ],
  });
  expect(await main(ctx, ['context', 'check'])).toBe(0);
});

it('模型内容与哈希不符时在网络写入前失败', async () => {
  const { root, hash } = setup();
  writeFileSync(join(root, 'assets', hash + '.glb'), 'broken');
  const ctx = makeContext(root);
  expect(await main(ctx, ['context', 'upload', '--plot', 'p1'])).toBe(1);
  expect(ctx.errors.join('\n')).toContain('哈希不符');
});
