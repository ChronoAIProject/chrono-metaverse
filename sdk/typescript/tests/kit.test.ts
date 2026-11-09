import { describe, expect, it } from 'vitest';
import { aabbGridCover } from '../src/core/grid.js';
import { parseOp, WorkingState } from '../src/core/ops.js';
import { entityFootprint, validateEntityBody } from '../src/core/record.js';
import {
  shapeBounds,
  ShapeError,
  signedArea,
  validateShape,
  type Shape,
} from '../src/core/shape.js';
import * as kit from '../src/kit/index.js';

function close(actual: readonly number[], expected: readonly number[], eps = 1e-9) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(eps));
}

describe('单位换算', () => {
  it('米和格互换，网格单位 0.05 米', () => {
    expect(kit.GRID_UNIT).toBe(0.05);
    expect(kit.toGrid(1.2)).toBe(24);
    expect(kit.toGrid(0.15)).toBe(3);
    expect(kit.toGrid(-0.125)).toBe(-3);
    expect(kit.toMetres(24)).toBeCloseTo(1.2, 12);
    expect(kit.cm(75)).toBe(0.75);
    expect(kit.cellAt([1, 0.5, -1])).toEqual([20, 10, -20]);
  });

  it('两个角点之间的格子盒子：min 向下、max 向上取整，吸附浮点噪声', () => {
    expect(kit.cellsBetween([0, 0, 0], [1.2, 0.05, 0.6])).toEqual([0, 0, 0, 24, 1, 12]);
    expect(kit.cellsBetween([0.151, 0, 0], [0.15, 1, 0.3])).toEqual([3, 0, 0, 4, 20, 6]);
    expect(kit.cells([1, 2, 3], [4, 1, 2])).toEqual([1, 2, 3, 5, 3, 5]);
    expect(() => kit.cells([0, 0, 0], [0, 1, 1])).toThrow();
    close([...kit.boxMetres([0, 0, 0, 20, 2, 40]).max], [1, 0.1, 2]);
    expect(kit.tidy(0.1 + 0.2)).toBe(0.3);
    expect(kit.tidy(-0.0000001)).toBe(0);
  });
});

describe('板、凸包和材质外观', () => {
  it('plate：法向按右手定则，板往背后长；坏数据立刻报错', () => {
    const top = kit.plate(
      [
        [0, 0.75, 0],
        [0, 0.75, 0.6],
        [1.2, 0.75, 0.6],
        [1.2, 0.75, 0],
      ],
      0.03,
      { color: '#B08A5A', at: [1, 0, 0] },
    );
    expect(top.type).toBe('plate');
    expect(top.transform).toEqual({ position: [1, 0, 0] });
    const bounds = shapeBounds(top);
    close([...bounds.min], [1, 0.72, 0]);
    close([...bounds.max], [2.2, 0.75, 0.6]);
    expect(() =>
      kit.plate(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0.01],
          [0, 1, 0],
        ],
        0.02,
      ),
    ).toThrow(ShapeError);
    expect(() =>
      kit.plate(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        2,
      ),
    ).toThrow('厚度');
  });

  it('hull：凸包的包围盒取全部点；共面的点不行', () => {
    const wedge = kit.hull(
      [
        [0, 0, 0],
        [1.6, 0, 0],
        [0, 0.9, 0],
        [0, 0, 0.6],
        [1.6, 0, 0.6],
        [0, 0.9, 0.6],
      ],
      { color: [90, 90, 96], yaw: 90 },
    );
    const bounds = shapeBounds(wedge);
    close([...bounds.min], [0, 0, -1.6]);
    close([...bounds.max], [0.6, 0.9, 0]);
    expect(() =>
      kit.hull([
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0.0005, 1],
      ]),
    ).toThrow('共面');
  });

  it('opacity、unlit 跟着颜色或贴图走', () => {
    const glass = kit.box([1, 2, 0.01], { color: [210, 230, 240], opacity: 0.3 });
    expect(glass.material).toEqual({ color: [210, 230, 240], opacity: 0.3 });
    const screen = kit.box([3, 1.7, 0.05], {
      texture: { hash: 'ab'.repeat(32), uv: 'planar' },
      unlit: true,
    });
    expect(screen.material).toEqual({ texture: 'ab'.repeat(32), uv: 'planar', unlit: true });
    expect(() => kit.box([1, 1, 1], { opacity: 0.5 })).toThrow('color 或 texture');
    expect(() => kit.box([1, 1, 1], { color: [1, 1, 1], opacity: 1.5 })).toThrow('不透明度');
  });

  it('平铺、着色、法线、粗糙度：贴图材质和颜色材质都能带，tile 写一个数是正方形', () => {
    const floor = kit.box([4, 0.02, 3], {
      texture: { hash: 'ab'.repeat(32), uv: 'planar' },
      tile: 0.6,
      rotate: 90,
      offset: [0.3, 0],
      shading: 'albedo',
      normalMap: 'cd'.repeat(32),
      normalScale: 0.8,
      roughnessMap: 'ef'.repeat(32),
      roughness: 0.9,
    });
    expect(floor.material).toEqual({
      texture: 'ab'.repeat(32),
      uv: 'planar',
      tile: [0.6, 0.6],
      rotate: 90,
      offset: [0.3, 0],
      shading: 'albedo',
      normalMap: 'cd'.repeat(32),
      normalScale: 0.8,
      roughnessMap: 'ef'.repeat(32),
      roughness: 0.9,
    });
    const leather = kit.box([1, 0.1, 0.5], {
      color: '#5a3d2b',
      uv: 'box',
      tile: [0.25, 0.4],
      normalMap: 'cd'.repeat(32),
    });
    expect(leather.material).toEqual({
      color: [90, 61, 43],
      uv: 'box',
      tile: [0.25, 0.4],
      normalMap: 'cd'.repeat(32),
    });
    const steel = kit.cylinder(0.02, 1, { color: [180, 180, 186], roughness: 0.55, metalness: 1 });
    expect(steel.material).toEqual({ color: [180, 180, 186], roughness: 0.55, metalness: 1 });
    // withOptions 只换位置时保留整个材质（含新字段）。
    expect(kit.withOptions(floor, { at: [1, 0, 1] }).material).toEqual(floor.material);
  });

  it('材质选项写错立刻报错', () => {
    expect(() => kit.box([1, 1, 1], { tile: 1 })).toThrow('材质选项 tile 要和 color 或 texture');
    expect(() => kit.box([1, 1, 1], { uv: 'box', normalMap: 'cd'.repeat(32) })).toThrow(
      '材质选项 normalMap、uv 要和 color 或 texture 一起给',
    );
    expect(() =>
      kit.box([1, 1, 1], { texture: { hash: 'ab'.repeat(32), uv: 'box' }, uv: 'planar' }),
    ).toThrow('texture.uv');
    // 颜色材质带法线贴图却没给 uv、没有贴图坐标却带 tile、越界：按形状规则报错，带路径。
    expect(() => kit.box([1, 1, 1], { color: [1, 2, 3], normalMap: 'cd'.repeat(32) })).toThrow(
      '必须给出 uv',
    );
    expect(() => kit.box([1, 1, 1], { color: [1, 2, 3], tile: 1 })).toThrow(
      '$.material.tile: tile、offset、rotate 只用于有贴图坐标（uv）的材质',
    );
    expect(() =>
      kit.box([1, 1, 1], { texture: { hash: 'ab'.repeat(32), uv: 'box' }, tile: 0 }),
    ).toThrow(ShapeError);
    expect(() =>
      kit.box([1, 1, 1], { texture: { hash: 'ab'.repeat(32), uv: 'box' }, rotate: 30 }),
    ).toThrow('只能和 tile 一起给');
  });
});

describe('形状构造', () => {
  it('box 带圆角、倒角、位置、旋转和颜色', () => {
    const shape = kit.box([1.2, 0.03, 0.75], {
      at: [1, 0.72, 2],
      yaw: 90,
      fillet: 0.01,
      color: '#B08A5A',
    });
    expect(shape).toEqual({
      type: 'box',
      size: [1.2, 0.03, 0.75],
      fillet: 0.01,
      transform: { position: [1, 0.72, 2], yaw: 90 },
      material: { color: [176, 138, 90] },
    });
    const bounds = shapeBounds(shape);
    close([...bounds.min], [1 - 0.375, 0.72, 2 - 0.6]);
    close([...bounds.max], [1 + 0.375, 0.75, 2 + 0.6]);
  });

  it('构造时就按服务端规则校验，错误带路径', () => {
    expect(() => kit.box([1, 0, 1])).toThrow(ShapeError);
    expect(() => kit.box([1, 1, 1], { color: '#12345' })).toThrow('颜色格式不对');
    expect(() =>
      kit.box([1, 1, 1], { color: [1, 2, 3], texture: { hash: 'a'.repeat(64), uv: 'box' } }),
    ).toThrow();
    expect(() => kit.cylinder(0.3, 1, { segments: 2 })).toThrow('分段数');
    expect(() =>
      kit.extrude(
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ],
        1,
      ),
    ).toThrow('逆时针');
    expect(() =>
      kit.lathe([
        [0, 0],
        [0, 1],
      ]),
    ).toThrow('不在轴上');
    expect(() => kit.loft([{ y: 0, outline: kit.rect(1, 1) }])).toThrow('2 到 8');
    expect(() => kit.group([])).toThrow('至少');
    expect(() => kit.instance('bad id')).toThrow('模板编号');
    try {
      kit.group([kit.box([1, 1, 1]), { type: 'box', size: [1, -1, 1] } as Shape]);
    } catch (error) {
      expect((error as ShapeError).path).toBe('$.children[1].size[1]');
    }
  });

  it('贴图材质和缩放、俯仰、翻滚', () => {
    const shape = kit.box([1, 1, 1], {
      texture: { hash: 'b'.repeat(64), uv: 'planar', tint: [250, 250, 250] },
      pitch: 10,
      roll: 5,
      scale: [1, 2, 1],
    });
    expect(shape.material).toEqual({
      texture: 'b'.repeat(64),
      uv: 'planar',
      tint: [250, 250, 250],
    });
    expect(shape.transform).toEqual({ pitch: 10, roll: 5, scale: [1, 2, 1] });
    // 角度为 0 的不写进 JSON。
    expect(kit.box([1, 1, 1], { yaw: 0 }).transform).toBeUndefined();
  });

  it('圆柱、圆台、圆锥、旋转体、扫掠、放样', () => {
    close([...shapeBounds(kit.cylinder(0.2, 1, { radiusTop: 0.5 })).max], [0.5, 1, 0.5]);
    close([...shapeBounds(kit.cone(0.15, 0.4, { at: [1, 0.8, 1] })).min], [0.85, 0.8, 0.85]);
    const lathe = kit.lathe(
      [
        [0, 0],
        [0.3, 0.1],
        [0.1, 0.9],
      ],
      { angle: 90, segments: 24 },
    );
    close([...shapeBounds(lathe).min], [-0.3, 0, -0.3]);
    const leg = kit.sweep(
      [
        [0, 0.015, 0],
        [0, 0.43, 0],
      ],
      0.015,
      { smooth: 0.02, caps: true },
    );
    expect(leg.section).toEqual({ circle: 0.015 });
    close([...shapeBounds(leg).min], [-0.015, 0, -0.015]);
    const rail = kit.sweep(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      { rect: [0.06, 0.08] },
    );
    close([shapeBounds(rail).max[0]], [1.05]);
    const vase = kit.loft([
      { y: 0, outline: kit.circle(0.1) },
      { y: 0.3, outline: kit.circle(0.15) },
    ]);
    close([...shapeBounds(vase).max], [0.15, 0.3, 0.15]);
  });

  it('withOptions 换位置时保留原材质', () => {
    const base = kit.box([1, 1, 1], { color: [1, 2, 3], at: [5, 0, 5] });
    const moved = kit.withOptions(base, { at: [0, 1, 0] });
    expect(moved.transform).toEqual({ position: [0, 1, 0] });
    expect(moved.material).toEqual({ color: [1, 2, 3] });
    expect(kit.withOptions(base, { color: '#000000' }).material).toEqual({ color: [0, 0, 0] });
  });
});

describe('二维轮廓', () => {
  it('rect 逆时针，radius 给四个角倒圆角', () => {
    const outline = kit.rect(2, 1, { center: [1, 0], radius: 0.1 });
    expect(signedArea(outline.points)).toBeGreaterThan(0);
    expect(outline.fillets).toHaveLength(4);
    expect(kit.rect(1, 1).fillets).toBeUndefined();
  });

  it('circle 用四段 90° 圆弧，包围盒就是圆', () => {
    const shape = kit.extrude(kit.circle(0.5, [1, 1]), 0.1);
    const bounds = shapeBounds(shape);
    close([...bounds.min], [0.5, 0, 0.5], 1e-12);
    close([...bounds.max], [1.5, 0.1, 1.5], 1e-12);
    expect(kit.bulgeFor(90)).toBeCloseTo(Math.tan(Math.PI / 8), 15);
    expect(kit.bulgeFor(180)).toBeCloseTo(1, 15);
  });

  it('stadium 两端半圆；长度不超过宽度时退化成圆', () => {
    const bounds = shapeBounds(kit.extrude(kit.stadium(2, 0.8), 0.03));
    close([bounds.min[0], bounds.max[0], bounds.min[2], bounds.max[2]], [-1, 1, -0.4, 0.4], 1e-12);
    expect(kit.stadium(0.5, 0.8).arcs).toHaveLength(4);
  });

  it('lShape 逆时针，ccw 自动纠正顺时针的点', () => {
    const l = kit.lShape(2, 2, 0.6, 0.02);
    expect(signedArea(l.points)).toBeGreaterThan(0);
    validateShape(kit.extrude(l, 1));
    const clockwise: [number, number][] = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ];
    expect(signedArea(kit.ccw(clockwise))).toBeGreaterThan(0);
    expect(kit.ccw(kit.ccw(clockwise))).toEqual(kit.ccw(clockwise));
    expect(
      kit.outline(
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        { arcs: [] },
      ),
    ).toEqual({
      points: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    });
  });
});

describe('物件、模板和锚点记录', () => {
  it('entity 自动算包围盒（取到微米），通过服务端规则的校验', () => {
    const shape = kit.box([0.5, 0.5, 0.5], { at: [0.1 + 0.2, 0, 1] });
    const body = kit.entity('box-1', shape, { label: '箱子', props: { note: null, n: 1 } });
    expect(body.layer).toBe('ext');
    expect(body.kind).toBe('object');
    expect(body.bounds.min[0]).toBe(0.05);
    expect(body.bounds.max[0]).toBe(0.55);
    expect(body.props).toEqual({ note: null, n: 1 });
    validateEntityBody(body, new Map());
    expect(entityFootprint(body)).toEqual([1, 0, 15, 11, 10, 25]);
    expect(() => kit.entity('_reserved', shape)).toThrow('entityId');
    expect(() => kit.entity('x', shape, { label: 'a\u0007b' })).toThrow('label');
  });

  it('template + instance：实例的包围盒按模板计算', () => {
    const chairShape = kit.chair();
    const tpl = kit.template('chair-a', chairShape, { label: '餐椅' });
    expect(tpl.kind).toBe('template');
    const templates = new Map([['chair-a', chairShape]]);
    const one = kit.entity(
      'chair-1',
      kit.instance('chair-a', { at: [2, 0, 3], color: [10, 20, 30] }),
      {
        templates,
      },
    );
    const local = shapeBounds(chairShape);
    close([...one.bounds.min], [2 + local.min[0], local.min[1], 3 + local.min[2]], 1e-6);
    expect(() => kit.entity('chair-2', kit.instance('chair-b'))).toThrow('找不到模板');
    // 模板引用别的模板。
    const row = kit.template('row', kit.group([kit.instance('chair-a', { at: [-0.6, 0, 0] })]), {
      templates,
    });
    expect(row.bounds.min[0]).toBeLessThan(-0.6);
  });

  it('anchor 默认公开；box 和 position 二选一', () => {
    expect(kit.anchor('t2', 'table', { box: [0, 0, 0, 10, 15, 10] }, { label: '2 号桌' })).toEqual({
      anchorId: 't2',
      kind: 'table',
      box: [0, 0, 0, 10, 15, 10],
      label: '2 号桌',
      visibility: 'public',
    });
    expect(
      kit.anchor('d1', 'door', { position: [1, 0, 2] }, { visibility: 'internal' }).visibility,
    ).toBe('internal');
    expect(() => kit.anchor('_x', 'door', { position: [0, 0, 0] })).toThrow('anchorId');
    expect(() => kit.anchor('t3', 'table', { box: [0, 0, 0, 0, 1, 1] })).toThrow();
  });
});

describe('操作构造', () => {
  it('生成的 JSON 就是接口请求体，能通过结构检查', () => {
    const ops = [
      kit.fill([0, 0, 0, 4, 1, 4], 2),
      kit.hollowBox([0, 0, 0, 4, 4, 4], 'brick', 2),
      kit.hollowBox([0, 0, 0, 4, 4, 4], 'brick'),
      kit.replace([0, 0, 0, 4, 4, 4], 2, 1),
      kit.copyRegion([0, 0, 0, 4, 4, 4], [10, 0, 0]),
      kit.addBlock('brick', 'solid', { color: '#b4503c' }, ['wall']),
      kit.addBlock('tile', 'solid', {
        texture: { top: 'c'.repeat(64), side: 'c'.repeat(64), bottom: 'c'.repeat(64) },
      }),
      kit.place('lamp', kit.cylinder(0.1, 1.5)),
      kit.removeEntity('lamp'),
      kit.createAnchor(kit.anchor('t9', 'seat', { position: [1, 0, 1] })),
      kit.moveAnchor('t9', { box: [0, 0, 0, 2, 2, 2] }),
      kit.moveAnchor('t9', { position: [2, 0, 2] }),
      kit.updateAnchor('t9', { label: '靠窗座位', visibility: 'internal', kind: 'seat' }),
      kit.removeAnchor('t9'),
    ];
    for (const op of ops) expect(parseOp(JSON.parse(JSON.stringify(op)))).toEqual(op);
    expect(ops[2]).toEqual({ op: 'hollowBox', box: [0, 0, 0, 4, 4, 4], block: 'brick' });
    expect(ops[5]).toEqual({
      op: 'addBlock',
      block: { name: 'brick', kind: 'solid', color: [180, 80, 60], tags: ['wall'] },
    });
  });

  it('不合法的参数立刻报错', () => {
    expect(() => kit.fill([0, 0, 0, 0, 1, 1], 2)).toThrow();
    expect(() => kit.fill([0, 0, 0, 1, 1, 1], 70000)).toThrow('方块编号');
    expect(() => kit.copyRegion([0, 0, 0, 1, 1, 1], [0.5, 0, 0])).toThrow('整数');
    expect(() => kit.addBlock('bad name', 'solid', { color: [1, 2, 3] })).toThrow('方块名称');
    expect(() =>
      kit.addBlock('ok', 'solid', { texture: { top: 'x', side: 'x', bottom: 'x' } }),
    ).toThrow('贴图');
  });

  it('构造的操作能在本地作用', () => {
    const state = new WorkingState({
      palette: [{ id: 2, name: 'stone', kind: 'solid', color: [1, 1, 1], tags: [] }],
    });
    const touched = state.applySequence(
      [
        kit.addBlock('brick', 'solid', { color: '#b4503c' }),
        kit.hollowBox([0, 0, 0, 3, 3, 3], 'brick'),
        kit.place('table-1', kit.table({ at: [2, 0, 2] }), { label: '1 号桌' }),
      ],
      null,
    );
    expect(state.blockAt('ext', [0, 0, 0])).toBe(3);
    expect(state.blockAt('ext', [1, 1, 1])).toBe(0);
    expect([...touched.entities]).toEqual(['table-1']);
  });
});

describe('家具和结构', () => {
  const footprint = (shape: Shape) => aabbGridCover(shapeBounds(shape));

  it('table：真实尺寸，矩形 / 圆形 / 跑道形', () => {
    const rect = shapeBounds(kit.table());
    close([...rect.min], [-0.6, 0, -0.375]);
    close([...rect.max], [0.6, 0.75, 0.375]);
    const round = shapeBounds(kit.table({ top: 'round', width: 0.9, at: [1, 0, 1] }));
    close([round.min[0], round.max[0], round.max[1]], [0.55, 1.45, 0.75]);
    const stadium = shapeBounds(
      kit.table({ top: 'stadium', width: 1.8, depth: 0.9, height: 0.74 }),
    );
    close([stadium.min[0], stadium.max[0], stadium.max[1]], [-0.9, 0.9, 0.74]);
  });

  it('chair：腿不伸到地面以下，靠背在 -z 一侧，yaw 180 转向', () => {
    const chair = kit.chair();
    const bounds = shapeBounds(chair);
    expect(bounds.min[1]).toBeGreaterThanOrEqual(0);
    close([bounds.max[1]], [0.87]);
    expect(bounds.min[2]).toBeCloseTo(-0.225, 9);
    const turned = shapeBounds(kit.chair({ at: [1, 0, 1], yaw: 180 }));
    close([turned.min[0], turned.max[0]], [0.775, 1.225]);
    expect(footprint(kit.chair({ at: [5.5, 0, 0.5] }))[1]).toBe(0);
  });

  it('stool、counter、cornerCounter、cabinet、shelf、platform 都是合法的组合形状', () => {
    for (const shape of [
      kit.stool({ at: [1, 0, 1] }),
      kit.counter({ length: 2, toeKick: 0 }),
      kit.counter(),
      kit.cornerCounter({ yaw: 90 }),
      kit.cabinet({ doors: 1 }),
      kit.cabinet({ doors: 3, width: 1.2 }),
      kit.shelf({ shelves: 4 }),
      kit.platform({ width: 2, depth: 1, radius: 0.05 }),
    ]) {
      validateShape(shape);
      expect(shape.type).toBe('group');
      expect(shapeBounds(shape).min[1]).toBeGreaterThanOrEqual(-1e-9);
    }
    close([shapeBounds(kit.counter()).max[1]], [1.1]);
    close([shapeBounds(kit.stool()).max[1]], [0.75]);
  });

  it('wall：沿 from→to 摆放，门窗洞把墙拆成几块板', () => {
    const plain = kit.wall({ from: [0, 0], to: [4, 0] });
    expect(plain.children).toHaveLength(1);
    expect(plain.transform).toEqual({ position: [2, 0, 0] });
    const b = shapeBounds(plain);
    close([...b.min], [0, 0, -0.06]);
    close([...b.max], [4, 2.8, 0.06]);
    const withHoles = kit.wall({
      from: [0, 0],
      to: [0, 5],
      openings: [kit.windowOpening(2.5), kit.doorOpening(0.5)],
    });
    // 门：左段 + 门上（落地门没有下段）；窗：中段、窗下、窗上、玻璃；右段。
    expect(withHoles.children).toHaveLength(7);
    expect(withHoles.transform?.yaw).toBe(-90);
    const wb = shapeBounds(withHoles);
    close([wb.min[0], wb.max[0], wb.min[2], wb.max[2]], [-0.06, 0.06, 0, 5], 1e-9);
    expect(() => kit.wall({ from: [0, 0], to: [0, 0] })).toThrow('重合');
    expect(() =>
      kit.wall({ from: [0, 0], to: [3, 0], openings: [kit.doorOpening(0.5), kit.doorOpening(1)] }),
    ).toThrow('重叠');
    expect(() =>
      kit.wall({ from: [0, 0], to: [3, 0], height: 2, openings: [kit.doorOpening(0.5)] }),
    ).toThrow('比墙还高');
    const diagonal = kit.wall({ from: [0, 0], to: [3, 3] });
    expect(diagonal.transform?.yaw).toBe(-45);
  });
});
