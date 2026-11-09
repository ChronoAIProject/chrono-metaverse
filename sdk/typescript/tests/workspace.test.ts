import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/commands/index.js';
import { decompressChunk } from '../src/core/chunk.js';
import {
  runBuild,
  flattenOps,
  findScript,
  BuildError,
  type BuildManifest,
} from '../src/workspace/build.js';
import {
  ConfigError,
  findWorkspaceRoot,
  readConfig,
  validateConfig,
  writeConfig,
} from '../src/workspace/config.js';
import { baseWorkingState, readBase, readChunk, WorkspaceError } from '../src/workspace/files.js';
import { checkReport, diffSummary, formatDiff } from '../src/workspace/report.js';
import { SDK_ROOT, makeContext, makeWorkspace, removeDir, tempDir } from './helpers/workspace.js';

const dirs: string[] = [];
function track(dir: string): string {
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop()!);
});

/** 在地块 p1（x 5–7 米、z 0–2 米）里放一张桌子和一圈方块的脚本。 */
const PLOT_SCRIPT = `
export default function build(base, kit) {
  const [x, y, z] = base.target.origin;
  return {
    message: '地块里放桌子',
    ops: [
      kit.addBlock('brick', 'solid', { color: '#b4503c' }),
      kit.hollowBox([100, 0, 0, 110, 2, 10], 'brick'),
      [kit.place('table-1', kit.table({ at: [x + 1, y, z + 1] }), { label: '1 号桌' })],
      null,
      false,
      kit.createAnchor(kit.anchor('t9', 'table', { box: [110, 0, 10, 130, 15, 30] })),
    ],
  };
}
`;

describe('工作区配置', () => {
  it('校验、读写、往上找 metaverse.json', () => {
    const root = track(tempDir());
    writeConfig(root, { spaceId: 'front-hall', mode: 'nyxid', slug: 'chrono-metaverse' });
    expect(readConfig(root)).toEqual({
      spaceId: 'front-hall',
      mode: 'nyxid',
      slug: 'chrono-metaverse',
    });
    const nested = join(root, 'build', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(root);
    expect(findWorkspaceRoot('/')).toBeNull();
    expect(validateConfig({ spaceId: 'abc' }).mode).toBe('nyxid');
    expect(() => validateConfig({ spaceId: 'AB' })).toThrow(ConfigError);
    expect(() => validateConfig({ spaceId: 'abc', mode: 'ftp' })).toThrow('mode');
    expect(() => validateConfig({ spaceId: 'abc', api: 1 })).toThrow('api');
    expect(() => validateConfig({ spaceId: 'abc', plot: 'a:b' })).toThrow('plot');
    expect(() => validateConfig([])).toThrow();
    writeFileSync(join(root, 'metaverse.json'), '{oops');
    expect(() => readConfig(root)).toThrow('不是合法的 JSON');
    expect(() => readConfig(join(root, 'missing'))).toThrow('metaverse init');
  });
});

describe('metaverse init', () => {
  it('写入配置、示例脚本、技能说明、tsconfig、.gitignore 和工具包链接', async () => {
    const cwd = track(tempDir());
    const ctx = makeContext(cwd);
    expect(
      await main(ctx, [
        'init',
        'front-hall',
        '--mode',
        'direct',
        '--plot',
        'p1',
        '--web-url',
        'https://m.example',
      ]),
    ).toBe(0);
    const root = join(cwd, 'front-hall');
    const config = readConfig(root);
    expect(config).toMatchObject({
      spaceId: 'front-hall',
      mode: 'direct',
      api: 'http://127.0.0.1:8080',
      devTokenUrl: 'http://127.0.0.1:8090/dev/token',
      plot: 'p1',
      webUrl: 'https://m.example',
      buildScript: 'build/main.ts',
    });
    const skill = readFileSync(join(root, '.claude/skills/metaverse-builder/SKILL.md'), 'utf8');
    expect(skill).toBe(readFileSync(join(SDK_ROOT, 'skills/metaverse-builder/SKILL.md'), 'utf8'));
    expect(skill).toContain('GRID_UNIT = 0.05');
    expect(readFileSync(join(root, 'build/main.ts'), 'utf8')).toContain(
      'export default function build',
    );
    expect(existsSync(join(root, 'tsconfig.json'))).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('out/');
    expect(lstatSync(join(root, 'node_modules/@chrono-metaverse/sdk')).isSymbolicLink()).toBe(true);
    // 再来一次要 --force；--force 不覆盖已有的建造脚本。
    writeFileSync(join(root, 'build/main.ts'), '// 我的脚本');
    expect(await main(ctx, ['init', 'front-hall'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('--force');
    expect(await main(ctx, ['init', 'front-hall', '--force'])).toBe(0);
    expect(readFileSync(join(root, 'build/main.ts'), 'utf8')).toBe('// 我的脚本');
    expect(readConfig(root).mode).toBe('nyxid');
  });

  it('参数检查', async () => {
    const ctx = makeContext(track(tempDir()));
    expect(await main(ctx, ['init'])).toBe(1);
    expect(await main(ctx, ['init', 'Bad_Id'])).toBe(1);
    expect(await main(ctx, ['init', 'abc', '--mode', 'ftp'])).toBe(1);
    expect(await main(ctx, ['init', 'abc', '--plot', 'a:b'])).toBe(1);
    expect(await main(ctx, ['init', 'abc', '--nope'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('参数不对');
    expect(await main(ctx, ['init', '--help'])).toBe(0);
  });
});

describe('基础状态', () => {
  it('读出拉取的文件并构造工作状态（区块按哈希核对）', () => {
    const root = track(makeWorkspace());
    const base = readBase(root, 'demo-space');
    expect(base.pulled).toBe(true);
    expect(base.space.seq).toBe(3);
    expect(base.entities[0]!.props).toEqual({});
    const state = baseWorkingState(root, base);
    expect(state.blockAt('rebuilt', [5, 0, 5])).toBe(2);
    expect(state.effectiveBlock([5, 1, 5])).toBe(0);
    expect(() => readChunk(root, 'f'.repeat(64))).toThrow(WorkspaceError);
    expect(() => readBase(root, 'other-space')).toThrow('不一致');
    // 还没拉取：空的基础状态。
    const empty = readBase(track(tempDir()), 'abc');
    expect(empty).toMatchObject({ pulled: false, chunks: [], space: { seq: 0, regions: [] } });
  });
});

describe('metaverse build', () => {
  it('从基础状态运行脚本，在本地作用，写出 ops.ndjson、result.json 和新区块', async () => {
    const root = track(makeWorkspace({ script: PLOT_SCRIPT, config: { plot: 'p1' } }));
    const config = readConfig(root);
    const result = await runBuild(root, config);
    expect(result.message).toBe('地块里放桌子');
    expect(result.ops.map((op) => op.op)).toEqual([
      'addBlock',
      'hollowBox',
      'placeEntity',
      'createAnchor',
    ]);
    expect(result.target).toMatchObject({ scope: 'plot:p1', plotId: 'p1', origin: [5, 0, 0] });
    expect(result.outside).toEqual([]);
    expect(result.provisionalBlocks).toEqual([
      { id: 4, name: 'brick', kind: 'solid', color: [180, 80, 60], tags: [] },
    ]);
    expect(result.entityChanges.map((c) => c.id)).toEqual(['table-1']);
    expect(result.anchorChanges.map((c) => c.id)).toEqual(['t9']);
    const ndjson = readFileSync(join(root, 'out/ops.ndjson'), 'utf8').trim().split('\n');
    expect(ndjson).toHaveLength(4);
    expect(JSON.parse(ndjson[1]!)).toEqual({
      op: 'hollowBox',
      box: [100, 0, 0, 110, 2, 10],
      block: 'brick',
    });
    const manifest = JSON.parse(
      readFileSync(join(root, 'out/result.json'), 'utf8'),
    ) as BuildManifest;
    expect(manifest.baseSeq).toBe(3);
    expect(manifest.opCount).toBe(4);
    expect(manifest.final.palette.map((b) => b.name)).toEqual(['stone', 'oak', 'brick']);
    expect(manifest.final.chunks.length).toBe(2);
    const ext = manifest.chunkChanges.find((c) => c.layer === 'ext')!;
    const cells = decompressChunk(
      readFileSync(join(root, 'out/chunks', `${ext.hash}.bin`)),
      ext.hash!,
    );
    expect(cells[4]).toBe(4); // x = 100 落在区块 3 的第 4 格
    // 反复运行结果一样。
    const again = await runBuild(root, config, { write: false });
    expect(again.chunkChanges).toEqual(result.chunkChanges);
    expect(again.entityChanges).toEqual(result.entityChanges);
  });

  it('check：超出地块的操作列出来，退出码 1；实体区路径同样检查', async () => {
    const root = track(
      makeWorkspace({
        script: `export default (base, kit) => [
          kit.fill([135, 0, 0, 145, 1, 5], 2),
          kit.updateAnchor('_space', { label: '营业中' }),
          kit.place('ok-box', kit.box([0.2, 0.2, 0.2], { at: [5.5, 0, 0.5] })),
        ];`,
      }),
    );
    const config = readConfig(root);
    const inPlot = await runBuild(root, config, { plot: 'p1', write: false });
    expect(inPlot.outside.map((v) => v.index)).toEqual([0, 1]);
    expect(inPlot.outside[0]!.cells).toEqual([[135, 0, 0, 145, 1, 5]]);
    expect(inPlot.outside[1]!.spaceWide).toBe(true);
    const report = checkReport(inPlot);
    expect(report.ok).toBe(false);
    expect(report.text).toContain('超出了地块 p1');
    expect(report.text).toContain('_space');
    const ctx = makeContext(root);
    expect(await main(ctx, ['check', '--plot', 'p1'])).toBe(1);
    expect(ctx.errors.join('\n')).toContain('第 0 条 fill');
    // 实体区路径：fill 在虚拟区，box 也在虚拟区。
    const physical = await runBuild(root, config, { plot: null, write: false });
    expect(physical.outside.map((v) => v.index)).toEqual([0, 2]);
    expect(await main(makeContext(root), ['check', '--json'])).toBe(1);
  });

  it('check 通过时退出码 0；diff 给出统计', async () => {
    const root = track(makeWorkspace({ script: PLOT_SCRIPT }));
    const ctx = makeContext(root);
    expect(await main(ctx, ['check', '--plot', 'p1'])).toBe(0);
    expect(ctx.lines.at(-1)).toContain('全部 4 条操作都落在地块 p1 内');
    const result = await runBuild(root, readConfig(root), { plot: 'p1', write: false });
    const summary = diffSummary(result);
    expect(summary).toMatchObject({
      baseSeq: 3,
      scope: 'plot:p1',
      opCount: 4,
      opsByType: { addBlock: 1, hollowBox: 1, placeEntity: 1, createAnchor: 1 },
      chunks: { ext: { added: 1, modified: 0, removed: 0 } },
      entities: { added: 1, ids: { added: ['table-1'] } },
      anchors: { added: 1 },
    });
    const text = formatDiff(summary);
    expect(text).toContain('扩展层区块：新增 1');
    expect(text).toContain('新增方块：brick（临时编号 4）');
    expect(await main(ctx, ['diff', '--plot', 'p1'])).toBe(0);
    expect(ctx.lines.join('\n')).toContain('物件：新增 1，修改 0，删除 0');
    expect(await main(ctx, ['diff', '--json', '--plot', 'p1'])).toBe(0);
    expect(JSON.parse(ctx.lines.at(-1)!).opCount).toBe(4);
  });

  it('修改和删除：清掉重建层地面、删除锚点、改基础物件都会统计', async () => {
    const root = track(
      makeWorkspace({
        script: `export default (base, kit) => [
          kit.fill([0, 0, 0, 32, 1, 32], 1),
          kit.removeAnchor('cam-1'),
          kit.updateAnchor('t1', { label: '一号桌' }),
        ];`,
      }),
    );
    const result = await runBuild(root, readConfig(root), { write: false });
    const summary = diffSummary(result);
    expect(summary.chunks.ext.added).toBe(1);
    expect(summary.anchors).toMatchObject({ added: 0, modified: 1, removed: 1 });
    expect(result.state.effectiveBlock([3, 0, 3])).toBe(0);
  });

  it('脚本的错误：找不到、没有默认导出、抛异常、返回不合法的操作、作用失败', async () => {
    const root = track(makeWorkspace());
    const config = readConfig(root);
    await expect(runBuild(root, config)).rejects.toThrow('找不到建造脚本');
    writeFileSync(join(root, 'build/main.ts'), 'export const x = 1;');
    await expect(runBuild(root, config)).rejects.toThrow('默认导出');
    writeFileSync(
      join(root, 'build/main.ts'),
      'export default () => { throw new Error("坏了"); };',
    );
    await expect(runBuild(root, config)).rejects.toThrow('建造脚本出错：坏了');
    writeFileSync(
      join(root, 'build/main.ts'),
      'export default () => [{ op: "fill", box: [0,0,0,1,1,1] }];',
    );
    await expect(runBuild(root, config)).rejects.toThrow(BuildError);
    writeFileSync(
      join(root, 'build/main.ts'),
      'export default (base, kit) => [kit.fill([0,0,0,1,1,1], 2), kit.removeEntity("wall-1")];',
    );
    await expect(runBuild(root, config)).rejects.toThrow('第 1 条操作：物件 wall-1 属于重建层');
    await expect(runBuild(root, config, { plot: 'p9' })).rejects.toThrow('地块 p9 不存在');
    const ctx = makeContext(root);
    expect(await main(ctx, ['build'])).toBe(1);
    expect(ctx.errors.at(-1)).toContain('wall-1');
  });

  it('脚本可以是 .mjs，也可以用 --script 指定；返回值可以是 Promise', async () => {
    const root = track(makeWorkspace());
    writeFileSync(
      join(root, 'build/alt.mjs'),
      'export default async (base) => base.seq > 0 ? [] : null;',
    );
    const config = readConfig(root);
    expect(findScript(root, config, 'build/alt.mjs')).toBe(join(root, 'build/alt.mjs'));
    const result = await runBuild(root, config, { script: 'build/alt.mjs', write: false });
    expect(result.ops).toEqual([]);
    expect(() => findScript(root, { ...config, buildScript: undefined })).toThrow('找不到建造脚本');
    expect(flattenOps({ ops: [[[]]], message: 1 } as never)).toEqual({ ops: [], message: null });
  });

  it('build 命令输出说明和 --json 清单', async () => {
    const root = track(makeWorkspace({ script: PLOT_SCRIPT }));
    const ctx = makeContext(root);
    expect(await main(ctx, ['build', '--plot', 'p1'])).toBe(0);
    expect(ctx.lines[0]).toContain('4 条操作');
    expect(await main(ctx, ['build', '--json'])).toBe(0);
    const json = JSON.parse(ctx.lines.at(-1)!) as Record<string, unknown>;
    expect(json.opCount).toBe(4);
    expect(json.final).toBeUndefined();
    // 实体区路径下这些操作超出范围：build 只提示，不失败。
    expect(await main(ctx, ['build'])).toBe(0);
    expect(ctx.errors.join('\n')).toContain('超出了实体区范围');
    expect(await main(ctx, ['build', '--quiet'])).toBe(0);
  });
});

describe('技能说明里的示例脚本', () => {
  it('能运行，并且全部落在 2 × 2 米的地块里', async () => {
    const skill = readFileSync(join(SDK_ROOT, 'skills/metaverse-builder/SKILL.md'), 'utf8');
    const match = /```ts\n(import type \{ BuildBase, Kit \}[\s\S]*?)```/.exec(skill);
    expect(match).not.toBeNull();
    const root = track(makeWorkspace({ script: match![1]!, config: { plot: 'p1' } }));
    const result = await runBuild(root, readConfig(root), { write: false });
    expect(result.outside).toEqual([]);
    expect(result.ops.length).toBeGreaterThan(8);
    expect(result.entityChanges.map((c) => c.id)).toContain('cafe-table-01');
    expect(checkReport(result).ok).toBe(true);
  });

  it('init 写入的示例脚本也能运行', async () => {
    const cwd = track(tempDir());
    await main(makeContext(cwd), ['init', 'demo-space', 'ws']);
    const root = join(cwd, 'ws');
    const template = readFileSync(join(root, 'build/main.ts'), 'utf8');
    const ws = track(makeWorkspace({ script: template, config: { plot: 'p1' } }));
    const result = await runBuild(ws, readConfig(ws), { write: false });
    expect(result.ops).toHaveLength(3);
    expect(result.outside).toEqual([]);
  });
});
