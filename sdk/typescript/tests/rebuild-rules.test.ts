import { describe, expect, it } from 'vitest';
import {
  BundleError,
  checkBundle,
  checkBundleText,
  isBundlePath,
  looksLikeLocalPath,
} from '../src/core/bundle.js';
import { DEFAULT_UPLOAD_LIMITS } from '../src/core/limits.js';
import {
  layerOfKind,
  OpError,
  parseOp,
  scopeKindOf,
  touchedToModel,
  transformError,
  validateScanSpec,
  WorkingState,
  type Op,
} from '../src/core/ops.js';
import { isRebuiltId, type EntityBody } from '../src/core/record.js';
import { AllowedArea, parsePathScope, type Plot, type Region } from '../src/core/scope.js';
import { textureRefs, type Shape } from '../src/core/shape.js';
import { isRfc3339, parseRfc3339 } from '../src/core/timestamp.js';
import { buildTarget } from '../src/workspace/build.js';
import type { BaseState } from '../src/workspace/files.js';

/**
 * 服务端瘦身的核心规则（docs/design/server-slim.md 2.4、2.5；SHAPES 3、7、8）里，跨语言向量没有逐条
 * 覆盖到的细节：路径范围的"除去"模式、RFC 3339、扫描变换、贴图引用、清单结构的边界。
 */

const HEX = (c: string) => c.repeat(64);

const VIRTUAL: Region = { id: 'garden', kind: 'virtual', boxes: [[100, 0, 0, 200, 60, 100]] };
const PLOT: Plot = { id: 'p1', regionId: 'garden', boxes: [[100, 0, 0, 140, 40, 40]] };

describe('路径范围：重建与"除去"模式', () => {
  it('rebuild 是合法的范围，允许范围同实体区，但不能动空间级锚点', () => {
    expect(parsePathScope('rebuild')).toBe('rebuild');
    const regions: Region[] = [
      { id: 'hall', kind: 'physical', boxes: [[0, 0, 0, 100, 60, 100]] },
      VIRTUAL,
    ];
    const area = AllowedArea.forScope('rebuild', regions, [PLOT]);
    expect(area.mode).toBe('within');
    expect(() => area.check({ cells: [[0, 0, 0, 1, 1, 1]], spaceWide: false })).not.toThrow();
    expect(() => area.check({ cells: [], spaceWide: true })).toThrow('rebuild');
    expect(
      AllowedArea.forScope('physical', regions, [PLOT]).outside({ cells: [], spaceWide: true }),
    ).toEqual({ spaceWide: false, cells: [] });
  });

  it('没有实体区时，除去虚拟区和地块都能改（只碰边界不算）', () => {
    for (const scope of ['physical', 'rebuild'] as const) {
      const area = AllowedArea.forScope(scope, [VIRTUAL], [PLOT]);
      expect(area.mode).toBe('except');
      expect(area.allows([-500, 0, -500, 100, 10, 100])).toBe(true);
      expect(area.allows([99, 0, 0, 101, 1, 1])).toBe(false);
      expect(area.outside({ cells: [[150, 0, 0, 151, 1, 1]], spaceWide: false }).cells).toEqual([
        [150, 0, 0, 151, 1, 1],
      ]);
    }
    const empty = AllowedArea.forScope('physical', [], []);
    expect(empty.allows([0, 0, 0, 1, 1, 1])).toBe(true);
    expect(() => empty.check({ cells: [], spaceWide: true })).not.toThrow();
  });

  it('本地建造的目标：没有实体区时是"除去"模式，检查报告列出不能碰的盒子', () => {
    const base = {
      pulled: true,
      space: { regions: [VIRTUAL], plots: [PLOT] },
    } as unknown as BaseState;
    const { target, area } = buildTarget(base, null);
    expect(area.mode).toBe('except');
    expect(target).toMatchObject({
      scope: 'physical',
      mode: 'except',
      boxes: [],
      excluded: [VIRTUAL.boxes[0], PLOT.boxes[0]],
      bounds: null,
    });
    const inPlot = buildTarget(base, 'p1').target;
    expect(inPlot).toMatchObject({ mode: 'within', excluded: [], boxes: PLOT.boxes });
  });
});

describe('RFC 3339（与 Rust 的 time 库相同）', () => {
  it('接受和拒绝的写法', () => {
    const ok: [string, string][] = [
      ['2026-11-20T08:00:00Z', '2026-11-20T08:00:00.000Z'],
      ['2026-11-20t08:00:00z', '2026-11-20T08:00:00.000Z'],
      ['2026-11-20 08:00:00Z', '2026-11-20T08:00:00.000Z'],
      ['2026-11-20T08:00:00.1234567891Z', '2026-11-20T08:00:00.123Z'],
      ['2026-12-31T23:59:60Z', '2026-12-31T23:59:59.999Z'],
      ['2026-11-20T08:00:00+23:59', '2026-11-19T08:01:00.000Z'],
      ['2026-11-20T08:00:00-00:00', '2026-11-20T08:00:00.000Z'],
      ['2024-02-29T08:00:00Z', '2024-02-29T08:00:00.000Z'],
      ['0000-01-01T00:00:00Z', '0000-01-01T00:00:00.000Z'],
    ];
    for (const [text, utc] of ok) {
      const millis = parseRfc3339(text);
      expect(millis, text).not.toBeNull();
      const iso = new Date(millis!).toISOString();
      expect(iso.replace(/^\+?0*(\d{4})/, '$1')).toBe(utc);
    }
    for (const bad of [
      '2026-11-20T08:00:60Z',
      '2026-11-20T08:00:00+24:00',
      '2026-02-29T08:00:00Z',
      '2026-11-20T24:00:00Z',
      '2026-11-20T08:00Z',
      '2026-11-20T08:00:00.Z',
      '+2026-11-20T08:00:00Z',
      '2026-11-20T08:00:00+0800',
      '2026-1-20T08:00:00Z',
      '昨天',
      `2026-11-20T08:00:00.${'1'.repeat(60)}Z`,
    ]) {
      expect(isRfc3339(bad), bad).toBe(false);
    }
  });
});

describe('扫描层与操作', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 3, 1];

  it('扫描变换的规则同 Rust check_transform', () => {
    expect(transformError(identity)).toBeNull();
    expect(transformError(identity.slice(0, 15))).not.toBeNull();
    const scaled = (s: number) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
    expect(transformError(scaled(0.0099))).not.toBeNull();
    expect(transformError(scaled(0.011))).toBeNull();
    const mirrored = [...identity];
    mirrored[0] = -1;
    expect(transformError(mirrored)).not.toBeNull();
    const projective = [...identity];
    projective[3] = 0.5;
    expect(transformError(projective)).not.toBeNull();
    const far = [...identity];
    far[12] = 100_001;
    expect(transformError(far)).not.toBeNull();
    expect(transformError([...identity.slice(0, 15), Number.NaN])).not.toBeNull();
  });

  it('setScan 的取值检查', () => {
    const scan = { assetHash: HEX('1'), webModelHashes: [HEX('2')], transform: identity };
    expect(() => validateScanSpec(scan)).not.toThrow();
    for (const bad of [
      { ...scan, assetHash: HEX('A') },
      { ...scan, webModelHashes: [] },
      { ...scan, webModelHashes: [HEX('2'), HEX('2')] },
      { ...scan, alignment: { note: 'x'.repeat(4096) } },
      { ...scan, alignment: { n: 2 ** 60 } },
    ]) {
      expect(() => validateScanSpec(bad)).toThrow(OpError);
    }
  });

  it('解析新操作和新字段；setScan 在扩展草稿里不允许', () => {
    expect(parseOp({ op: 'clearRebuilt' })).toEqual({ op: 'clearRebuilt' });
    expect(parseOp({ op: 'removeEntity', entityId: 'x', ifPresent: null })).toEqual({
      op: 'removeEntity',
      entityId: 'x',
    });
    expect(() => parseOp({ op: 'createAnchor', ifNew: 'yes', anchor: {} })).toThrow(OpError);
    const setScan = parseOp({
      op: 'setScan',
      scan: { assetHash: HEX('1'), webModelHashes: [HEX('2')], transform: identity },
      observedAt: '2026-10-20T00:00:00+08:00',
    });
    const ext = new WorkingState();
    try {
      ext.apply(setScan);
      expect.unreachable();
    } catch (error) {
      expect((error as OpError).kind).toBe('notAllowed');
    }
    const rebuild = new WorkingState({ kind: 'rebuild' });
    const touched = rebuild.apply(setScan);
    expect(touchedToModel(touched)).toMatchObject({ scan: true });
    expect(touchedToModel(touched)).not.toHaveProperty('rebuiltLayer');
    expect(rebuild.scan?.observedAt).toBe('2026-10-20T00:00:00+08:00');
    // 克隆带着范围种类、锚点历史和草稿的扫描。
    const copy = new WorkingState({ kind: 'rebuild', anchorHistory: ['gone'] }).clone();
    expect(copy.kind).toBe('rebuild');
    expect(copy.anchorHistory.has('gone')).toBe(true);
    expect(rebuild.clone().scan).not.toBeNull();
    // 一批里失败时状态不变（包括草稿的扫描）。
    const state = new WorkingState({ kind: 'rebuild' });
    const ops: Op[] = [setScan, { op: 'fill', box: [0, 0, 0, 1, 1, 1], block: 2 }];
    expect(() => state.applySequence(ops, null)).toThrow(OpError);
    expect(state.scan).toBeNull();
  });

  it('范围种类与层、编号前缀、贴图引用', () => {
    expect(scopeKindOf('rebuild')).toBe('rebuild');
    expect(scopeKindOf('plot:p1')).toBe('ext');
    expect(layerOfKind('rebuild')).toBe('rebuilt');
    expect(isRebuiltId('rb.wall')).toBe(true);
    expect(isRebuiltId('wall-rb.')).toBe(false);
    const shape = {
      type: 'group',
      material: { texture: HEX('1'), uv: 'box' },
      children: [
        {
          type: 'box',
          size: [1, 1, 1],
          material: { color: [1, 2, 3], normalMap: HEX('2'), uv: 'box' },
        },
        {
          type: 'instance',
          template: 'rb.t',
          material: { roughnessMap: HEX('3'), color: [1, 1, 1], uv: 'mesh' },
        },
      ],
    } as unknown as Shape;
    expect([...textureRefs(shape)].sort()).toEqual([HEX('1'), HEX('2'), HEX('3')]);
  });

  it('usersOfTemplate 只算同一层；brokenTemplateRefs 列出跨层的旧引用', () => {
    const template: EntityBody = {
      entityId: 'rb.t',
      layer: 'rebuilt',
      kind: 'template',
      shape: { type: 'box', size: [1, 1, 1] },
      bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
    };
    const user = (id: string, layer: 'ext' | 'rebuilt'): EntityBody => ({
      entityId: id,
      layer,
      kind: 'object',
      shape: { type: 'instance', template: 'rb.t', transform: { position: [1, 0, 1] } },
      bounds: { min: [0.5, 0, 0.5], max: [1.5, 1, 1.5] },
    });
    const state = new WorkingState({
      entities: new Map([
        ['rb.t', template],
        ['rb.u', user('rb.u', 'rebuilt')],
        ['old', user('old', 'ext')],
      ]),
    });
    expect(state.usersOfTemplate('rb.t').map((e) => e.entityId)).toEqual(['rb.u']);
    expect(state.brokenTemplateRefs()).toEqual([{ entityId: 'old', template: 'rb.t' }]);
    expect([...state.templatesOf('ext').keys()]).toEqual([]);
    expect([...state.templatesOf('rebuilt').keys()]).toEqual(['rb.t']);
  });
});

describe('重建包清单的结构校验', () => {
  const minimal = () => ({
    format: 'chrono-metaverse-rebuild-bundle',
    version: 1,
    tool: { name: 'metaverse-recon', version: '0.2.0' },
    note: '只加锚点',
    createdAt: '2026-11-20T08:00:00Z',
    anchors: [{ anchorId: 'a1', kind: 'table', box: [0, 0, 0, 1, 1, 1], visibility: 'public' }],
    files: [] as unknown[],
  });
  const fieldOf = (value: unknown): string | null => {
    try {
      checkBundle(value);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(BundleError);
      return (error as BundleError).field;
    }
  };

  it('最小的清单通过；结构不对一律报在 $ 上', () => {
    expect(fieldOf(minimal())).toBeNull();
    expect(fieldOf([])).toBe('$');
    for (const change of [
      (m: Record<string, unknown>) => (m.anchors = null),
      (m: Record<string, unknown>) => (m.files = undefined),
      (m: Record<string, unknown>) => (m.tool = { name: 'x', version: '1', extra: 1 }),
      (m: Record<string, unknown>) => (m.base = { spaceId: 'abc', seq: -1 }),
      (m: Record<string, unknown>) => (m.rebuilt = { mode: 'replace', templates: null }),
      (m: Record<string, unknown>) => (m.rebuilt = { mode: 'patch' }),
      (m: Record<string, unknown>) =>
        (m.files = [{ path: 'a', purpose: 'bundle', sha256: HEX('1'), size: 1 }]),
      (m: Record<string, unknown>) =>
        (m.scan = { assetHash: HEX('1'), webModelHashes: [], transform: [], observedAt: 'x' }),
    ]) {
      const manifest = minimal() as Record<string, unknown>;
      change(manifest);
      expect(fieldOf(manifest)).toBe('$');
    }
    // 值为 null 的可选字段等于没给。
    expect(fieldOf({ ...minimal(), base: null, scan: null, notes: null, report: null })).toBeNull();
  });

  it('清单本身的大小、文本格式和各项边界', () => {
    const text = JSON.stringify(minimal());
    expect(() =>
      checkBundleText(text, {
        limits: { ...DEFAULT_UPLOAD_LIMITS, bundle: { maxBytes: text.length - 1 } },
      }),
    ).toThrow('$');
    expect(() => checkBundleText('{')).toThrow(BundleError);
    expect(fieldOf({ ...minimal(), note: 'a\tb' })).toBe('note');
    expect(fieldOf({ ...minimal(), note: '第一行\n第二行' })).toBeNull();
    expect(fieldOf({ ...minimal(), tool: { name: 'x'.repeat(65), version: '1' } })).toBe(
      'tool.name',
    );
    expect(fieldOf({ ...minimal(), base: { spaceId: 'Bad', seq: 1 } })).toBe('base.spaceId');
    expect(fieldOf({ ...minimal(), report: { a: ['ok', '~/x'] } })).toBe('report.a[1]');
    expect(fieldOf({ ...minimal(), report: { '/abs': 1 } })).toBe('report');
    expect(fieldOf({ ...minimal(), report: [1] })).toBe('report');
    expect(fieldOf({ ...minimal(), report: { n: 2 ** 60 } })).toBe('report');
    expect(fieldOf({ ...minimal(), notes: 'x' })).toBe('notes');
    const anchors = Array.from({ length: 2001 }, (_, i) => ({
      anchorId: `a${i}`,
      kind: 'table',
      box: [0, 0, 0, 1, 1, 1],
      visibility: 'public',
    }));
    expect(fieldOf({ ...minimal(), anchors })).toBe('anchors');
    expect(isBundlePath('a/b.c')).toBe(true);
    for (const bad of ['', 'a//b', 'a/./b', 'a b', 'x'.repeat(201)]) {
      expect(isBundlePath(bad), bad).toBe(false);
    }
    expect(looksLikeLocalPath('D:/scan')).toBe(true);
    expect(looksLikeLocalPath('C:x')).toBe(false);
  });
});
