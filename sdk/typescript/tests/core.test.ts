import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  CanonicalError,
  compareCodePoints,
  contentHash,
} from '../src/core/canonical.js';
import {
  chunkHash,
  ChunkError,
  compressChunk,
  decodeChunk,
  decompressChunk,
  emptyChunk,
  encodeChunk,
  locateCell,
  parseChunkKey,
} from '../src/core/chunk.js';
import {
  aabbGridCover,
  anyOverlap,
  boxContainsBox,
  boxContainsCell,
  boxSize,
  boxSubtract,
  boxUnion,
  boxVolume,
  ceilToGrid,
  coveredBy,
  floorToGrid,
  gridBox,
  GridError,
  metresBoxToGrid,
  roundToGrid,
  roundHalfAway,
} from '../src/core/grid.js';
import { isObjectId, isSpaceId, isSubjectId } from '../src/core/ids.js';
import { OpError, parseOp, touchedToModel, WorkingState, type Op } from '../src/core/ops.js';
import {
  anchorFootprint,
  parseAnchorBody,
  parseEntityBody,
  RecordError,
} from '../src/core/record.js';
import { AllowedArea, parsePathScope, plotScope, ScopeError } from '../src/core/scope.js';
import {
  applyTransform,
  arcExtremes,
  sinCosDegrees,
  templateRefs,
  validateShape,
} from '../src/core/shape.js';

describe('网格', () => {
  it('米和格互换时吸附浮点噪声，取整与 Rust 一致', () => {
    expect(floorToGrid(0.15)).toBe(3);
    expect(ceilToGrid(0.15)).toBe(3);
    expect(floorToGrid(0.151)).toBe(3);
    expect(ceilToGrid(0.151)).toBe(4);
    expect(floorToGrid(-0.01)).toBe(-1);
    expect(roundToGrid(0.124)).toBe(2);
    expect(roundHalfAway(-2.5)).toBe(-3);
    expect(roundHalfAway(2.5)).toBe(3);
    expect(Object.is(roundHalfAway(-0.2), 0)).toBe(true);
  });

  it('盒子运算', () => {
    const outer = gridBox([0, 0, 0, 10, 10, 10]);
    const inner = gridBox([2, 2, 2, 5, 5, 5]);
    expect(boxVolume(outer)).toBe(1000);
    expect(boxSize(inner)).toEqual([3, 3, 3]);
    expect(boxContainsBox(outer, inner)).toBe(true);
    expect(boxContainsBox(inner, outer)).toBe(false);
    expect(boxContainsCell(outer, [9, 9, 9])).toBe(true);
    expect(boxContainsCell(outer, [10, 0, 0])).toBe(false);
    const pieces = boxSubtract(outer, inner);
    expect(pieces.reduce((n, b) => n + boxVolume(b), 0)).toBe(1000 - 27);
    expect(boxSubtract(inner, gridBox([20, 0, 0, 21, 1, 1]))).toEqual([inner]);
    expect(boxUnion(inner, gridBox([8, 0, 0, 9, 1, 1]))).toEqual([2, 0, 0, 9, 5, 5]);
    expect(
      coveredBy(gridBox([3, 0, 0, 7, 4, 4]), [
        gridBox([0, 0, 0, 5, 4, 4]),
        gridBox([5, 0, 0, 10, 4, 4]),
      ]),
    ).toBe(true);
    expect(
      coveredBy(gridBox([3, 0, 0, 7, 5, 4]), [
        gridBox([0, 0, 0, 5, 4, 4]),
        gridBox([5, 0, 0, 10, 4, 4]),
      ]),
    ).toBe(false);
    expect(coveredBy(inner, [])).toBe(false);
    expect(anyOverlap([inner], [outer])).toBe(true);
    expect(() => gridBox([0, 0, 0, 0, 1, 1])).toThrow(GridError);
    expect(() => gridBox([0, 0, 0, 2 ** 30 + 1, 1, 1])).toThrow('超出范围');
    expect(() => gridBox([0, 0, 0.5, 1, 1, 1])).toThrow('整数');
  });

  it('米坐标包围盒覆盖的格子；厚度为 0 时占一格', () => {
    expect(aabbGridCover({ min: [-0.01, 0, 0.1], max: [0.15, 0, 0.26] })).toEqual([
      -1, 0, 2, 3, 1, 6,
    ]);
    expect(metresBoxToGrid([0, 0, 0, 1, 1, 1])).toEqual([0, 0, 0, 20, 20, 20]);
    expect(() => aabbGridCover({ min: [0, 0, 0], max: [Number.NaN, 0, 0] })).toThrow(GridError);
    expect(() => aabbGridCover({ min: [1, 0, 0], max: [0, 0, 0] })).toThrow(GridError);
    expect(() => aabbGridCover({ min: [0, 0, 0], max: [1e12, 0, 0] })).toThrow('超出范围');
  });
});

describe('规范化 JSON', () => {
  it('键按码点排序、数字和字符串的写法、undefined 视为不存在', () => {
    expect(canonicalJson({ b: 1, a: [1.5, -0, 'x"y'], c: undefined, d: null, e: true })).toBe(
      '{"a":[1.5,0,"x\\"y"],"b":1,"d":null,"e":true}',
    );
    expect(compareCodePoints('\u{1f600}', '｡')).toBe(1);
    expect(compareCodePoints('a', 'ab')).toBe(-1);
    expect(compareCodePoints('ab', 'ab')).toBe(0);
    expect(contentHash({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('拒绝非有限值、超出安全范围的整数和不支持的类型', () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalError);
    expect(() => canonicalJson(2 ** 53)).toThrow('安全范围');
    expect(() => canonicalJson({ f: () => 1 })).toThrow('不支持');
    expect(() => canonicalJson(10n)).toThrow('不支持');
  });
});

describe('区块编码', () => {
  it('编码、压缩、解压、核对哈希', () => {
    const cells = emptyChunk();
    cells[1024] = 0x0302;
    const bytes = encodeChunk(cells);
    expect([bytes[2048], bytes[2049]]).toEqual([0x02, 0x03]);
    expect(decodeChunk(bytes)).toEqual(cells);
    const restored = decompressChunk(compressChunk(cells), chunkHash(cells));
    expect(restored).toEqual(cells);
    expect(chunkHash(bytes)).toBe(chunkHash(cells));
  });

  it('长度不对、压缩数据损坏、压缩炸弹、哈希不符都被拒绝', async () => {
    const { deflateSync } = await import('node:zlib');
    expect(() => encodeChunk(new Uint16Array(3))).toThrow(ChunkError);
    expect(() => decodeChunk(new Uint8Array(3))).toThrow(ChunkError);
    expect(() => chunkHash(new Uint8Array(3))).toThrow(ChunkError);
    expect(() => decompressChunk(new Uint8Array([1, 2, 3]))).toThrow('无法解压');
    expect(() => decompressChunk(deflateSync(Buffer.alloc(65538)))).toThrow('无法解压');
    expect(() => decompressChunk(deflateSync(Buffer.alloc(100)))).toThrow('无法解压');
    expect(() => decompressChunk(compressChunk(emptyChunk()), 'f'.repeat(64))).toThrow(
      '哈希不一致',
    );
  });

  it('负坐标按向下取整定位区块', () => {
    expect(locateCell([-1, 0, 33])).toEqual([
      [-1, 0, 1],
      [31, 0, 1],
    ]);
    expect(parseChunkKey('ext:-1:2:3')).toEqual({ layer: 'ext', cx: -1, cy: 2, cz: 3 });
  });
});

describe('编号、范围、记录', () => {
  it('编号格式', () => {
    expect(isSpaceId('front-hall')).toBe(true);
    expect(isSpaceId('ab')).toBe(false);
    expect(isSpaceId('-abc')).toBe(false);
    expect(isObjectId('_space')).toBe(true);
    expect(isObjectId('.x')).toBe(false);
    expect(isObjectId('a:b')).toBe(false);
    expect(isSubjectId('org_1-x')).toBe(true);
    expect(isSubjectId('a.b')).toBe(false);
  });

  it('路径范围', () => {
    expect(parsePathScope('physical')).toBe('physical');
    expect(plotScope('p1')).toBe('plot:p1');
    for (const bad of ['plot:', 'plot:a:b', 'zone:x', 'nothing'])
      expect(() => parsePathScope(bad)).toThrow(ScopeError);
    expect(() => AllowedArea.forScope('source:pos', [], [])).toThrow('不能修改几何');
    expect(() => AllowedArea.forScope('plot:p9', [], [])).toThrow('p9 不存在');
  });

  it('记录的结构检查', () => {
    expect(() => parseEntityBody(null)).toThrow(RecordError);
    const base = {
      entityId: 'a',
      layer: 'ext',
      kind: 'object',
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    };
    expect(
      parseEntityBody({ ...base, label: null, shape: { type: 'box', size: [1, 1, 1] } }),
    ).toEqual({
      ...base,
      shape: { type: 'box', size: [1, 1, 1] },
      props: {},
    });
    for (const bad of [
      { ...base, layer: 'scan' },
      { ...base, textures: [1] },
      { ...base, bounds: { min: [0, 0], max: [1, 1, 1] } },
      { ...base, bounds: { min: [0, 0, 0], max: [1, 1, 1], extra: 1 } },
      { ...base, fit: { meanCm: '1', p90Cm: 1, coverage3cm: 0.5 } },
      { ...base, props: [] },
      { ...base, label: 3 },
      { ...base, entityId: 7 },
    ]) {
      expect(() => parseEntityBody(bad)).toThrow(RecordError);
    }
    expect(() =>
      parseAnchorBody({ anchorId: 't', kind: 'table', visibility: 'public', box: 'x' }),
    ).toThrow('box');
    expect(() => parseAnchorBody({ anchorId: 1, kind: 'table', visibility: 'public' })).toThrow(
      'anchorId',
    );
    expect(() =>
      anchorFootprint({
        anchorId: 't',
        kind: 'table',
        position: [1e12, 0, 0],
        visibility: 'public',
      }),
    ).toThrow('position');
  });
});

describe('形状细节', () => {
  it('90° 的整数倍取精确的 sin/cos；变换顺序', () => {
    expect(sinCosDegrees(-90)).toEqual([-1, 0]);
    expect(sinCosDegrees(720)).toEqual([0, 1]);
    expect(applyTransform({ position: [10, 0, 0], yaw: 90, scale: [2, 1, 1] }, [1, 0, 0])).toEqual([
      10, 0, -2,
    ]);
    expect(applyTransform({ roll: 90 }, [1, 0, 0])).toEqual([0, 1, 0]);
    expect(applyTransform({ pitch: 90 }, [0, 1, 0])).toEqual([0, 0, 1]);
    expect(applyTransform(undefined, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('圆弧极值和模板引用', () => {
    expect(arcExtremes([0, -1], [1, 0], 0.1)).toEqual([]);
    expect(arcExtremes([0, 0], [0, 0], 1)).toEqual([]);
    expect(arcExtremes([-1, 0], [1, 0], -1).every((p) => p[1] >= 0)).toBe(true);
    const refs = templateRefs({
      type: 'group',
      children: [
        { type: 'instance', template: 'a' },
        { type: 'group', children: [{ type: 'instance', template: 'b' }] },
      ],
    });
    expect([...refs].sort()).toEqual(['a', 'b']);
  });

  it('结构错误：类型、未知字段、null、截面写法、嵌套和节点数上限', () => {
    for (const bad of [
      { type: 'sphere', radius: 1 },
      { type: 'box', size: [1, 1, 1], colour: [1, 2, 3] },
      { type: 'box', size: [1, 1, 1], transform: null },
      { type: 'box', size: [1, 1, 1], transform: { rotation: [0, 0, 0] } },
      { type: 'box', size: [1, 1, 1], transform: { scale: [0, 1, 1] } },
      { type: 'box', size: [1, 1, 1], transform: { yaw: 4000 } },
      { type: 'box', size: [1, 1, 1], material: { color: [1, 2, 3], tint: [1, 1, 1] } },
      { type: 'box', size: [1, 1, 1], material: { texture: 'x', uv: 'box' } },
      { type: 'box', size: [1, 1, 1], material: { texture: 'a'.repeat(64) } },
      { type: 'box', size: [1, 1, 1], material: { uv: 'sphere', texture: 'a'.repeat(64) } },
      {
        type: 'sweep',
        path: [
          [0, 0, 0],
          [0, 1, 0],
        ],
        section: { circle: 0.1, rect: [1, 1] },
      },
      { type: 'sweep', path: [[0, 0, 0]], section: { circle: 0.1 } },
      {
        type: 'sweep',
        path: [
          [0, 0, 0],
          [0, 1, 0],
        ],
        section: { circle: 0.1 },
        caps: 'yes',
      },
      {
        type: 'extrude',
        height: 1,
        outline: {
          points: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          closed: false,
        },
      },
      {
        type: 'extrude',
        height: 1,
        outline: {
          points: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          arcs: [{ from: 5, bulge: 1 }],
        },
      },
      {
        type: 'extrude',
        height: 1,
        outline: {
          points: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          arcs: [{ from: 0, bulge: 5000 }],
        },
      },
      {
        type: 'extrude',
        height: 1,
        outline: {
          points: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          fillets: [{ at: 0, radius: 0 }],
        },
      },
      {
        type: 'lathe',
        profile: [
          [0, 0],
          [1, 1],
        ],
        angle: 400,
      },
      {
        type: 'loft',
        sections: [
          { y: 0 },
          {
            y: 1,
            outline: {
              points: [
                [0, 0],
                [1, 0],
                [0, 1],
              ],
            },
          },
        ],
      },
      { type: 'instance', template: 7 },
      'box',
    ]) {
      expect(() => validateShape(bad)).toThrow();
    }
    let nested: unknown = { type: 'box', size: [1, 1, 1] };
    for (let i = 0; i <= 16; i += 1) nested = { type: 'group', children: [nested] };
    expect(() => validateShape(nested)).toThrow('16 层');
    const wide = {
      type: 'group',
      children: Array.from({ length: 4096 }, () => ({ type: 'box', size: [1, 1, 1] })),
    };
    expect(() => validateShape(wide)).toThrow('4096');
  });
});

describe('工作状态', () => {
  const palette = [
    { id: 2, name: 'stone', kind: 'solid' as const, color: [1, 1, 1] as const, tags: [] },
  ];

  it('一批最多 200 条；失败时状态不变', () => {
    const state = new WorkingState({ palette });
    const fill = parseOp({ op: 'fill', box: [0, 0, 0, 1, 1, 1], block: 2 });
    expect(() =>
      state.applyInScope(
        Array.from({ length: 201 }, () => fill),
        null,
      ),
    ).toThrow(expect.objectContaining({ kind: 'tooManyOps' }));
    expect(() => state.applyInScope([fill, { ...fill, block: 9 } as Op], null)).toThrow(OpError);
    expect(state.chunks.size).toBe(0);
    const touched = state.applyInScope([fill], null);
    expect(touchedToModel(touched)).toEqual({
      chunks: [{ layer: 'ext', cx: 0, cy: 0, cz: 0 }],
      entities: [],
      anchors: [],
      palette: false,
    });
    expect(() =>
      new WorkingState().apply({ op: 'fill', box: [0, 0, 0, 4096, 4096, 1], block: 0 }),
    ).toThrow('4194304');
  });

  it('写时复制：克隆之后写一边不影响另一边', () => {
    const base = new WorkingState({ palette });
    base.apply(parseOp({ op: 'fill', box: [0, 0, 0, 2, 2, 2], block: 2 }));
    const copy = base.clone();
    copy.apply(parseOp({ op: 'fill', box: [0, 0, 0, 1, 1, 1], block: 0 }));
    expect(base.blockAt('ext', [0, 0, 0])).toBe(2);
    expect(copy.blockAt('ext', [0, 0, 0])).toBe(0);
    base.apply(parseOp({ op: 'fill', box: [1, 1, 1, 2, 2, 2], block: 0 }));
    expect(copy.blockAt('ext', [1, 1, 1])).toBe(2);
    // 批量作用成功后，原对象接手新数组，再写也不影响之前的克隆。
    const snapshot = base.clone();
    base.applySequence([parseOp({ op: 'fill', box: [0, 0, 0, 1, 1, 1], block: 2 })], null);
    base.apply(parseOp({ op: 'fill', box: [0, 1, 0, 1, 2, 1], block: 0 }));
    expect(snapshot.blockAt('ext', [0, 0, 0])).toBe(2);
    expect(snapshot.blockAt('ext', [0, 1, 0])).toBe(2);
    expect(base.blockAt('ext', [0, 1, 0])).toBe(0);
  });

  it('方块编号用完、名称重复', () => {
    const full = new WorkingState({
      palette: [{ id: 0xffff, name: 'last', kind: 'solid', color: [1, 1, 1], tags: [] }],
    });
    expect(() =>
      full.apply(
        parseOp({ op: 'addBlock', block: { name: 'more', kind: 'solid', color: [1, 1, 1] } }),
      ),
    ).toThrow('用完');
    expect(() =>
      full.apply(
        parseOp({ op: 'addBlock', block: { name: 'last', kind: 'solid', color: [1, 1, 1] } }),
      ),
    ).toThrow('已存在');
    expect(() =>
      full.apply(
        parseOp({
          op: 'addBlock',
          block: {
            name: 'x',
            kind: 'solid',
            tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
            color: [1, 1, 1],
          },
        }),
      ),
    ).toThrow('标签');
  });
});
