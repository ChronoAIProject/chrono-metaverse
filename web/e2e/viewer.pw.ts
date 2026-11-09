import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import * as THREE from 'three';
import { frameBox } from '../src/viewer/framing';
import {
  brightCoverage,
  decodePng,
  imageStats,
  patchColor,
  patchLuma,
  type DecodedPng,
} from './png';

/*
 * 夹具模式的端到端测试：三种视图（含 ?view= 参数）、取景、灯光、锚点标签、形状 / 方块、剖切、
 * 时间轴、"现在"模式、组合页、预览页、错误页、移动端。
 * 截图写到 e2e/screenshots/（不进版本库），用来人工核对渲染（圆角和弧度、贴图、不是全黑）。
 */

const SHOTS = join(import.meta.dirname, 'screenshots');
const LINK = '/s/demo-lobby#share=fixture-share-token-0123456789abcdef';
const UNIVERSE = '/u/demo-street#share=fixture-universe-token-00112233445566778899';
const PREVIEW = '/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899';
const FLORIST = '/s/demo-florist#share=fixture-florist-token-fedcba9876543210';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // 夹具故意返回的 404（错误页测试）浏览器会记一条资源加载失败，不算页面错误。
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  return errors;
}

async function waitForScene(page: Page, mode: string) {
  const viewer = page.locator('.viewer');
  await expect(viewer).toHaveAttribute('data-mode', mode);
  await expect(viewer).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.page-loading')).toHaveCount(0);
  // 给渲染循环和贴图几帧时间。
  await page.waitForTimeout(900);
}

async function numberAttr(page: Page, name: string): Promise<number> {
  return Number(await page.locator('.viewer').getAttribute(name));
}

/** 画面不是全黑、也不是一片纯色：对画布截图，统计中央区域的亮度和颜色数。 */
async function expectRendered(page: Page) {
  const stats = imageStats(decodePng(await page.locator('.viewer__canvas').screenshot()));
  expect(stats.brightRatio).toBeGreaterThan(0.15);
  expect(stats.colors).toBeGreaterThan(20);
}

/** 房间（亮像素）占整个画布的比例。 */
async function roomCoverage(page: Page): Promise<number> {
  return brightCoverage(decodePng(await page.locator('.viewer__canvas').screenshot()));
}

/** 镜头取景的范围（data-frame）：[minX, minY, minZ, maxX, maxY, maxZ]。 */
async function frameRange(page: Page): Promise<number[]> {
  return (await page.locator('.viewer').getAttribute('data-frame'))!.split(',').map(Number);
}

/**
 * 按自动取景的结果（data-frame）还原镜头：和 SceneView 一样，竖直视场 50°、宽高比是画布的
 * 宽高比，用同一个 frameBox 算位置和观察点。`turned` 为 true 时绕观察点转半圈（拖动画布高度的
 * 一半就是转半圈，见 `turnAround`）。返回把世界坐标的点投影成画布像素位置的函数。
 */
async function projector(page: Page, turned = false) {
  const range = await frameRange(page);
  const canvas = (await page.locator('.viewer__canvas').boundingBox())!;
  const aspect = canvas.width / canvas.height;
  const box = new THREE.Box3(
    new THREE.Vector3(range[0], range[1], range[2]),
    new THREE.Vector3(range[3], range[4], range[5]),
  );
  const frame = frameBox(box, { fov: 50, aspect })!;
  const camera = new THREE.PerspectiveCamera(50, aspect, 0.05, 500);
  camera.position.copy(frame.position);
  if (turned) {
    camera.position.x = 2 * frame.target.x - frame.position.x;
    camera.position.z = 2 * frame.target.z - frame.position.z;
  }
  camera.lookAt(frame.target);
  camera.updateMatrixWorld();
  return (point: readonly [number, number, number]) => {
    const v = new THREE.Vector3(...point).project(camera);
    return { x: ((v.x + 1) / 2) * canvas.width, y: ((1 - v.y) / 2) * canvas.height };
  };
}

/**
 * 水平拖动画布高度的一半：OrbitControls 按"拖过整个画布高度 = 转一圈"旋转，所以镜头绕观察点
 * 转半圈，到房间的另一侧。阻尼每帧放掉剩下的 8%，等 100 帧（剩下不到万分之三）再返回。
 */
async function turnAround(page: Page) {
  const canvas = (await page.locator('.viewer__canvas').boundingBox())!;
  const y = canvas.y + canvas.height * 0.5;
  const x = canvas.x + canvas.width * 0.25;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + canvas.height / 2, y, { steps: 12 });
  await page.mouse.up();
  await page.mouse.move(canvas.x + 2, canvas.y + 2);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () => {
          frames += 1;
          if (frames >= 100) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** 一组世界坐标的点在画面上的平均亮度（每个点取 7 × 7 像素）；每个点都必须在画面里。 */
function meanLumaAt(
  png: DecodedPng,
  project: (point: readonly [number, number, number]) => { x: number; y: number },
  points: readonly (readonly [number, number, number])[],
): { mean: number; min: number } {
  const lumas = points.map((point) => {
    const { x, y } = project(point);
    expect(x, `${point.join(',')} 在画面里`).toBeGreaterThan(4);
    expect(x).toBeLessThan(png.width - 4);
    expect(y).toBeGreaterThan(4);
    expect(y).toBeLessThan(png.height - 4);
    return patchLuma(png, x, y, 3);
  });
  return {
    mean: lumas.reduce((sum, value) => sum + value, 0) / lumas.length,
    min: Math.min(...lumas),
  };
}

/** 画布截图，盖在上面的标签、状态栏、悬停提示和按钮先藏起来（只看三维场景本身的像素）。 */
async function sceneOnly(page: Page): Promise<DecodedPng> {
  const hide = await page.addStyleTag({
    content:
      '.viewer__labels, .viewer__hud, .viewer__bottom, .viewer__progress, .viewer__tooltip { visibility: hidden !important; }',
  });
  await page.waitForTimeout(150);
  const png = decodePng(await page.locator('.viewer__canvas').screenshot());
  await hide.evaluate((node) => (node as Element).remove());
  return png;
}

/** 当前看得见的锚点标签。 */
function visibleLabels(page: Page) {
  return page.locator('.viewer__anchor:visible');
}

/** 看得见的锚点标签两两不重叠（允许 1 像素误差）。 */
async function expectNoOverlap(page: Page) {
  const rects = await visibleLabels(page).evaluateAll((elements) =>
    elements.map((element) => {
      const r = element.getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom] as const;
    }),
  );
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const [a, b] = [rects[i]!, rects[j]!];
      const overlap = a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;
      expect(overlap, `标签 ${i} 和 ${j} 重叠`).toBe(false);
    }
  }
}

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.beforeEach(async ({ request }) => {
  await request.post('/__fixtures/reset');
});

test('三种视图：形状带圆角和贴图，同款物件共用几何体，网格在后台线程生成', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(LINK);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('演示前厅');
  await expect(page.locator('.space__version')).toContainText('版本 #4');

  await waitForScene(page, 'optimized');
  expect(await numberAttr(page, 'data-entities')).toBeGreaterThan(10);
  expect(await numberAttr(page, 'data-triangles')).toBeGreaterThan(1000);
  expect(await numberAttr(page, 'data-textured')).toBeGreaterThan(2);
  expect(await numberAttr(page, 'data-instanced')).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.viewer')).toHaveAttribute('data-threaded', 'true');
  await expect(page.locator('.viewer__anchor', { hasText: '1 号桌' })).toHaveCount(1);
  await expect(page.locator('.viewer__anchor', { hasText: '内部摄像头' })).toHaveCount(0);
  await expectRendered(page);
  await page.screenshot({ path: join(SHOTS, 'optimized.png') });
  // 近看：圆角、弧形挤出、旋转体、扫掠椅腿、贴图。
  const canvas = (await page.locator('.viewer__canvas').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.55);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -240);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, 'closeup.png') });
  await page.getByRole('button', { name: '回到全景' }).click();

  await page.getByRole('button', { name: '优化 + 扩展' }).click();
  await waitForScene(page, 'extended');
  await page.getByRole('button', { name: '回到全景' }).click();
  await page.waitForTimeout(500);
  await expect(page.locator('.viewer__virtual-tag')).toContainText('虚拟');
  expect(await numberAttr(page, 'data-voxel-faces')).toBeGreaterThan(100);
  await expectRendered(page);
  await page.screenshot({ path: join(SHOTS, 'extended.png') });

  await page.getByRole('button', { name: '原始', exact: true }).click();
  await waitForScene(page, 'raw');
  await expect(page.locator('.viewer')).toHaveAttribute('data-scan', 'true');
  await expectRendered(page);
  await page.screenshot({ path: join(SHOTS, 'raw.png') });

  // 点选物件：信息面板按纯文本列出 props。
  await page.getByRole('button', { name: '优化', exact: true }).click();
  await waitForScene(page, 'optimized');
  const box = (await page.locator('.viewer__canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.62);
  const info = page.getByRole('complementary', { name: '物件信息' });
  await expect(info).toBeVisible();
  await expect(info.locator('dt').first()).toHaveText('编号');
  await page.screenshot({ path: join(SHOTS, 'select-entity.png') });
  await info.getByRole('button', { name: '关闭' }).click();
  await expect(info).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('取景：房间占画面的大部分，"回到全景"用同样的取景', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  // 取景范围是实体区里的内容（6 × 5 米的前厅），不是整个场景。
  const frame = (await page.locator('.viewer').getAttribute('data-frame'))!.split(',').map(Number);
  expect(frame[3]! - frame[0]!).toBeLessThan(6.5);
  expect(frame[5]! - frame[2]!).toBeLessThan(5.5);
  await page.screenshot({ path: join(SHOTS, 'framing.png') });
  const framed = await roomCoverage(page);
  expect(framed).toBeGreaterThan(0.3);

  // 拉远以后房间变小，"回到全景"恢复同样的取景。
  const canvas = (await page.locator('.viewer__canvas').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(900);
  expect(await roomCoverage(page)).toBeLessThan(framed * 0.6);
  await page.getByRole('button', { name: '回到全景' }).click();
  await page.waitForTimeout(500);
  expect(await roomCoverage(page)).toBeGreaterThan(0.3);

  // 优化 + 扩展：虚拟区一起纳入取景（镜头没动过时换视图自动重新取景）。
  await page.getByRole('button', { name: '优化 + 扩展' }).click();
  await waitForScene(page, 'extended');
  await expect
    .poll(async () => {
      const box = (await page.locator('.viewer').getAttribute('data-frame'))!.split(',');
      return Number(box[3]);
    })
    .toBeGreaterThan(9.5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, 'framing-extended.png') });
  expect(await roomCoverage(page)).toBeGreaterThan(0.3);
});

test('?view= 指定打开时的视图：原始视图的房间占画面大部分，切换视图时更新地址', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/s/demo-lobby?view=raw#share=fixture-share-token-0123456789abcdef');
  await waitForScene(page, 'raw');
  await expect(page.getByRole('button', { name: '原始', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.viewer')).toHaveAttribute('data-scan', 'true');
  // 扫描带着门外、玻璃隔断外的零星碎片，取景仍然只看房间（6 × 5 米）。
  const frame = await frameRange(page);
  expect(frame[0]).toBeGreaterThan(-0.3);
  expect(frame[2]).toBeGreaterThan(-0.3);
  expect(frame[3]).toBeLessThan(6.3);
  expect(frame[5]).toBeLessThan(5.3);
  expect(await roomCoverage(page)).toBeGreaterThan(0.3);
  await page.screenshot({ path: join(SHOTS, 'view-param-raw.png') });

  // 切换视图：地址里的 view 跟着变，# 后面的令牌不变；刷新后还是这个视图。
  await page.getByRole('button', { name: '优化 + 扩展' }).click();
  await waitForScene(page, 'extended');
  await expect(page).toHaveURL(
    /\/s\/demo-lobby\?view=extended#share=fixture-share-token-0123456789abcdef$/,
  );
  await page.reload();
  await waitForScene(page, 'extended');
  await expect(page.getByRole('button', { name: '优化 + 扩展' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // 切回默认的优化视图：地址里不写 view。
  await page.getByRole('button', { name: '优化', exact: true }).click();
  await waitForScene(page, 'optimized');
  await expect(page).toHaveURL(/\/s\/demo-lobby#share=fixture-share-token-0123456789abcdef$/);
  expect(errors).toEqual([]);
});

test('灯光：优化视图里白色的纯色部件是亮的，背光面也不发黑', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  // 墙都是纯色 (232, 228, 220)。迎光面：南墙门洞左边那一段朝外的一面（z = 5.1 米），正对镜头，
  // 现在约 199。
  const south: [number, number, number][] = [];
  for (const x of [0.4, 1.0, 1.6, 2.2, 2.8]) {
    for (const y of [0.5, 1.0, 1.5, 2.0]) south.push([x, y, 5.1]);
  }
  const lit = meanLumaAt(await sceneOnly(page), await projector(page), south);
  expect(lit.mean).toBeGreaterThan(175);
  expect(lit.min).toBeGreaterThan(160);
  await page.screenshot({ path: join(SHOTS, 'lighting-optimized.png') });

  // 背光面：镜头转到房间另一侧，看北墙朝外的一面（z = −0.1 米，背对主光）。
  // 灯光强度没按物理单位（没乘 π）时这一面只有 145 左右，现在约 194，接近迎光面。
  await turnAround(page);
  const north: [number, number, number][] = [];
  for (const x of [1.5, 2.3, 3.1, 3.9, 4.7]) {
    for (const y of [1.3, 1.65, 2.0]) north.push([x, y, -0.1]);
  }
  const back = meanLumaAt(await sceneOnly(page), await projector(page, true), north);
  expect(back.mean).toBeGreaterThan(175);
  expect(back.min).toBeGreaterThan(160);
  await page.screenshot({ path: join(SHOTS, 'lighting-backlit.png') });
});

test('锚点标签：默认只显示有意义的，避让、有上限，悬停时显示，可以显示全部', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  const anchors = page.locator('.viewer__anchor');
  const total = await numberAttr(page, 'data-anchors');
  expect(total).toBeGreaterThanOrEqual(20);
  await expect.poll(() => numberAttr(page, 'data-labels')).toBeGreaterThan(3);
  const shown = await visibleLabels(page).count();
  // 1440 × 900 的画面最多 10 个。
  expect(shown).toBeLessThanOrEqual(10);
  expect(shown).toBeLessThan(total);
  expect(await numberAttr(page, 'data-labels')).toBe(shown);
  await expectNoOverlap(page);
  // 桌子、前台、门默认显示；座位默认不显示，有事件状态（有人）的座位显示。
  await expect(anchors.filter({ hasText: '1 号桌' })).toBeVisible();
  await expect(anchors.filter({ hasText: /^前台/ })).toBeVisible();
  await expect(anchors.filter({ hasText: '入口' })).toBeVisible();
  await expect(anchors.filter({ hasText: '座位 1' })).toBeHidden();
  await expect(anchors.filter({ hasText: '座位 2 · 有人 1 位' })).toBeVisible();
  // 桌上的小杂物在屏幕上太小，默认不放标签。
  await expect(anchors.filter({ hasText: '杂物' }).first()).toBeAttached();
  expect(await visibleLabels(page).filter({ hasText: '杂物' }).count()).toBeLessThan(
    await anchors.filter({ hasText: '杂物' }).count(),
  );
  await page.screenshot({ path: join(SHOTS, 'labels-default.png') });

  // 显示全部标签。
  const all = page.getByRole('checkbox', { name: '显示全部标签' });
  await all.check();
  const seat = anchors.filter({ hasText: '座位 1' });
  await expect(seat).toBeVisible();
  await expect.poll(() => visibleLabels(page).count()).toBeGreaterThan(shown);
  await page.screenshot({ path: join(SHOTS, 'labels-all.png') });
  // 标签中心就是锚点在屏幕上的位置：记下来，关掉"显示全部"后把鼠标移过去。
  const seatBox = (await seat.boundingBox())!;
  await all.uncheck();
  await expect(seat).toBeHidden();
  await expect.poll(() => visibleLabels(page).count()).toBe(shown);

  // 悬停在锚点上时显示，移开后隐藏。
  await page.mouse.move(seatBox.x + seatBox.width / 2, seatBox.y + seatBox.height / 2, {
    steps: 4,
  });
  await expect(seat).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'labels-hover.png') });
  const canvas = (await page.locator('.viewer__canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 20, canvas.y + 20, { steps: 4 });
  await expect(seat).toBeHidden();

  // 拉远：屏幕上变小的锚点不放标签，标签变少；有事件的锚点优先，仍然有标签。
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 400);
  await expect.poll(() => numberAttr(page, 'data-labels')).toBeLessThan(shown);
  const withEvents = /1 号桌|座位 2|前台|入口|休息区/;
  expect(await visibleLabels(page).filter({ hasText: withEvents }).count()).toBeGreaterThan(0);
  await expectNoOverlap(page);
  await page.screenshot({ path: join(SHOTS, 'labels-far.png') });
});

test('形状 / 方块：重建层两种内容都有时可以切换，地址里记住选择', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  const styles = page.getByRole('group', { name: '重建层画法' });
  const shapes = styles.getByRole('button', { name: '形状' });
  const blocks = styles.getByRole('button', { name: '方块' });
  await expect(shapes).toHaveAttribute('aria-pressed', 'true');
  // 形状画法：重建层物件都画，方块只有扩展层的地毯。
  const shapeEntities = await numberAttr(page, 'data-entities');
  const shapeFaces = await numberAttr(page, 'data-voxel-faces');
  expect(shapeEntities).toBeGreaterThan(20);

  await blocks.click();
  await expect(blocks).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/\?style=blocks#share=fixture-share-token-0123456789abcdef$/);
  await expect.poll(() => numberAttr(page, 'data-voxel-faces')).toBeGreaterThan(shapeFaces * 5);
  await waitForScene(page, 'optimized');
  // 方块画法：重建层物件不画（优化视图里扩展层没有物件）。
  expect(await numberAttr(page, 'data-entities')).toBe(0);
  await expectRendered(page);
  await page.screenshot({ path: join(SHOTS, 'style-blocks.png') });

  // 刷新：仍然是方块，# 后面的分享令牌照样有效。
  await page.reload();
  await waitForScene(page, 'optimized');
  await expect(blocks).toHaveAttribute('aria-pressed', 'true');
  expect(await numberAttr(page, 'data-voxel-faces')).toBeGreaterThan(shapeFaces * 5);

  // 优化 + 扩展：扩展层的物件（展台）照画。
  await page.getByRole('button', { name: '优化 + 扩展' }).click();
  await waitForScene(page, 'extended');
  expect(await numberAttr(page, 'data-entities')).toBeGreaterThan(0);
  expect(await numberAttr(page, 'data-entities')).toBeLessThan(shapeEntities);

  // 原始视图只画扫描，切换禁用。
  await page.getByRole('button', { name: '原始', exact: true }).click();
  await waitForScene(page, 'raw');
  await expect(blocks).toBeDisabled();

  // 换回形状：地址里去掉 style，物件回来、重建层区块不画。
  await page.getByRole('button', { name: '优化', exact: true }).click();
  await shapes.click();
  await expect(page).toHaveURL(/\/s\/demo-lobby#share=/);
  await expect.poll(() => numberAttr(page, 'data-entities')).toBe(shapeEntities);
  await waitForScene(page, 'optimized');
  expect(await numberAttr(page, 'data-voxel-faces')).toBe(shapeFaces);

  // 重建之前（版本 #1）重建层什么都没有，不显示切换。
  await page.getByRole('slider', { name: '时间' }).focus();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: '下一个提交' }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #1');
  await expect(styles).toHaveCount(0);
});

test('剖切：所有视图都能切掉某个高度以上的内容（含扫描模型）', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  const cut = page.getByRole('checkbox', { name: '剖切' });
  await cut.uncheck();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'cutaway-off.png') });
  const ceiling = await page.locator('.viewer__canvas').screenshot();

  await cut.check();
  await page.getByRole('slider', { name: '剖切高度' }).fill('1');
  await expect(page.locator('.cutaway__value')).toHaveText('1.00 米');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'cutaway-1m.png') });
  const low = await page.locator('.viewer__canvas').screenshot();
  expect(Buffer.compare(ceiling, low)).not.toBe(0);
  // 剖切高度以上的锚点标签隐藏（前台标签在 1.05 米高）。
  await page.getByRole('slider', { name: '剖切高度' }).fill('0.6');
  await expect(page.locator('.viewer__anchor', { hasText: '前台' })).toBeHidden();
  await page.getByRole('slider', { name: '剖切高度' }).fill('1');

  // 原始视图（扫描模型）同样被切。
  await page.getByRole('button', { name: '原始', exact: true }).click();
  await waitForScene(page, 'raw');
  await page.screenshot({ path: join(SHOTS, 'cutaway-raw-1m.png') });
  await expectRendered(page);
});

test('时间轴：拖到最早、按提交前后跳、回到现在', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  const now = page.getByRole('button', { name: '现在' });
  await expect(now).toHaveAttribute('aria-pressed', 'true');

  // 拖到时间轴最左端：第一次提交之前，什么都没有。
  const slider = page.getByRole('slider', { name: '时间' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(now).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.space__version')).toContainText('还没有任何提交');
  await expect(page.getByText('这个时刻还没有任何提交。')).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'timeline-earliest.png') });

  // 下一个提交：导入扫描（还没有优化模型），原始视图有扫描。
  await page.getByRole('button', { name: '下一个提交' }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #1');
  await expect(page.getByText('这个时刻还没有优化模型')).toBeVisible();
  await page.getByRole('button', { name: '原始', exact: true }).click();
  await waitForScene(page, 'raw');
  await page.screenshot({ path: join(SHOTS, 'before-rebuild-raw.png') });
  await page.getByRole('button', { name: '优化', exact: true }).click();

  await page.getByRole('button', { name: '下一个提交' }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #2');
  await page.getByRole('button', { name: /跳到提交 #3/ }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #3');

  // 回放：送花那天 10:30 之后，前台摆着花束（spawnEntity），时间窗里有客流热力。
  await slider.fill(String(Date.parse('2026-10-27T10:40:00Z')));
  await waitForScene(page, 'optimized');
  await expect(page.locator('.viewer')).toHaveAttribute('data-visuals', /[1-9]/);
  await page.screenshot({ path: join(SHOTS, 'replay-delivery-day.png') });

  await now.click();
  await expect(now).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.space__version')).toContainText('版本 #4');
});

test('现在模式：带 ETag 轮询 /head，增量拉到新事件，seq 变了换新快照', async ({
  page,
  request,
}) => {
  const heads: { status: number; ifNoneMatch?: string }[] = [];
  const sinceQueries: string[] = [];
  const snapshotQueries: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/head')) {
      heads.push({
        status: response.status(),
        ifNoneMatch: response.request().headers()['if-none-match'],
      });
    }
    if (url.pathname.endsWith('/events') && url.searchParams.has('since')) {
      sinceQueries.push(url.searchParams.get('since')!);
    }
    if (url.pathname.endsWith('/snapshot')) snapshotQueries.push(url.search);
  });

  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  await expect(page.locator('.viewer__hud')).toContainText('营业中');
  // 没有变化时 304。
  await expect
    .poll(() => heads.filter((h) => h.status === 304).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(heads.some((h) => h.ifNoneMatch !== undefined)).toBe(true);

  // 现实中发生了点什么：出了一份餐，营业状态改了。
  await request.post('/__fixtures/emit?kind=event');
  await expect(page.locator('.viewer__event[data-type="order.served"]')).toBeVisible({
    timeout: 9000,
  });
  await expect(page.locator('.viewer__hud')).toContainText('暂停营业');
  expect(sinceQueries.length).toBeGreaterThan(0);
  await page.screenshot({ path: join(SHOTS, 'live-new-event.png') });

  // 新的提交：seq 5。
  await request.post('/__fixtures/emit?kind=commit');
  await expect(page.locator('.space__version')).toContainText('版本 #5', { timeout: 12_000 });
  await waitForScene(page, 'optimized');
  // 一律按 seq 取快照，不走 ?at= 跳转。
  expect(snapshotQueries.every((q) => q.includes('seq='))).toBe(true);
  await page.screenshot({ path: join(SHOTS, 'live-new-commit.png') });
});

test('板、凸包、玻璃、灯箱和外部模型：画得出来，底部常驻 CC BY 署名，可展开完整来源', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto(FLORIST);
  await waitForScene(page, 'optimized');
  await expect(page.locator('.viewer')).toHaveAttribute('data-sources', '2');
  await expectRendered(page);
  const png = await sceneOnly(page);
  const project = await projector(page);
  // 灯箱不受光照：按材质颜色 (255, 128, 84) 原样显示（不做色调映射）。
  const sign = project([2, 1.97, 0.04]);
  const [r, g, b] = patchColor(png, sign.x, sign.y, 2);
  expect(r).toBeGreaterThan(235);
  expect(g).toBeGreaterThan(105);
  expect(g).toBeLessThan(150);
  expect(b).toBeLessThan(110);
  // 楔形底座（hull）朝南的三角面：深棕色，和浅色地砖明显不同。
  const wedge = project([3.75, 0.2, 0.8]);
  const wedgeColor = patchColor(png, wedge.x, wedge.y, 2);
  const floor = project([3.0, 0, 2.0]);
  const floorColor = patchColor(png, floor.x, floor.y, 2);
  const luma = ([cr, cg, cb]: number[]) => 0.2126 * cr! + 0.7152 * cg! + 0.0722 * cb!;
  expect(luma(floorColor) - luma(wedgeColor)).toBeGreaterThan(40);
  expect(wedgeColor[0] - wedgeColor[2]).toBeGreaterThan(8);
  await page.screenshot({ path: join(SHOTS, 'florist-solids.png') });

  // 署名默认可见：画面底边一行（不用点开），标题链到来源页、许可链到许可正文；
  // 在右下角工具按钮的下面，不挡按钮，也不压左下角的版本信息。
  const line = page.getByRole('note', { name: '模型署名' });
  await expect(line).toBeVisible();
  await expect(line).toHaveText(
    /^模型来源：玻璃瓶花束（示例） \/ 夹具作者乙 \/ CC-BY-4\.0 …，共 2 项/,
  );
  const title = line.getByRole('link', { name: '玻璃瓶花束（示例）' });
  await expect(title).toHaveAttribute('href', 'https://example.com/models/bouquet');
  await expect(title).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(line.getByRole('link', { name: 'CC-BY-4.0' })).toHaveAttribute(
    'href',
    'https://creativecommons.org/licenses/by/4.0/',
  );
  const lineBox = (await line.boundingBox())!;
  const toolsBox = (await page.locator('.viewer__tools').boundingBox())!;
  const infoBox = (await page.locator('.space__info').boundingBox())!;
  const viewerBox = (await page.locator('.viewer').boundingBox())!;
  expect(lineBox.y).toBeGreaterThanOrEqual(toolsBox.y + toolsBox.height);
  expect(lineBox.x).toBeGreaterThan(infoBox.x + infoBox.width);
  expect(viewerBox.y + viewerBox.height - (lineBox.y + lineBox.height)).toBeLessThan(24);
  await expect(page.getByRole('button', { name: /模型来源 ·/ })).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, 'florist-credit-line.png') });
  // 模型库的标题常有四五十个字符（前厅的显示器就是），一行放不下时只截短标题，
  // 许可链接和"共 N 项"照样整个在行里看得见（夹具的标题短，这里临时换成长标题量一下）。
  await line.evaluate((node) => {
    const title = node.querySelector<HTMLElement>('.viewer__credit-title')!;
    title.dataset.original = title.textContent ?? '';
    title.textContent = 'Computer Monitor 16:9 (Low Poly, Game Ready) '.repeat(3).trim();
  });
  const longTitle = await line.evaluate((node) => {
    const title = node.querySelector<HTMLElement>('.viewer__credit-title')!;
    const rest = node.querySelector<HTMLElement>('.viewer__credit-rest')!;
    const text = node.querySelector<HTMLElement>('.viewer__credit-text')!.getBoundingClientRect();
    const restBox = rest.getBoundingClientRect();
    return {
      titleTruncated: title.scrollWidth > title.clientWidth,
      restWhole: rest.scrollWidth <= rest.clientWidth,
      restInside: restBox.left >= text.left && restBox.right <= text.right + 0.5,
    };
  });
  expect(longTitle).toEqual({ titleTruncated: true, restWhole: true, restInside: true });
  await expect(line.getByRole('link', { name: 'CC-BY-4.0' })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'florist-credit-line-long-title.png') });
  await line.evaluate((node) => {
    const title = node.querySelector<HTMLElement>('.viewer__credit-title')!;
    title.textContent = title.dataset.original ?? '';
  });
  await expect(line).toHaveText(
    /^模型来源：玻璃瓶花束（示例） \/ 夹具作者乙 \/ CC-BY-4\.0 …，共 2 项/,
  );
  // 展开：列出两个外部模型的署名，链接新开窗口且不带来源信息。
  const toggle = line.getByRole('button');
  await expect(toggle).toHaveText('全部来源');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveText('收起');
  const panel = page.getByRole('region', { name: '模型来源' });
  await expect(panel).toBeVisible();
  const cc = panel.getByRole('link', { name: '玻璃瓶花束（示例）' });
  await expect(cc).toHaveAttribute('href', 'https://example.com/models/bouquet');
  await expect(cc).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(panel.getByText('CC BY 4.0（须署名）')).toBeVisible();
  await expect(panel.getByText('作者 夹具作者乙')).toBeVisible();
  await expect(panel.getByRole('link', { name: '木质花架（示例）' })).toBeVisible();
  // 注明改动（CC BY 的要求）：说明不依赖具体工具
  await expect(panel.getByText(/可能经过调整.*后重新导出，与原文件不同/)).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'florist-sources.png') });
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await expect(line).toBeVisible();

  // 手机宽度：署名照样在底边，在工具按钮下面，不重叠
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(line).toBeVisible();
  const narrowLine = (await line.boundingBox())!;
  const narrowTools = (await page.locator('.viewer__tools').boundingBox())!;
  expect(narrowLine.y).toBeGreaterThanOrEqual(narrowTools.y + narrowTools.height);
  expect(narrowLine.x).toBeGreaterThanOrEqual(0);
  expect(narrowLine.x + narrowLine.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(SHOTS, 'florist-credit-line-narrow.png') });
  expect(errors).toEqual([]);
});

test('组合页：两个空间按摆放拼在一起，连接可飞过去，送花路线', async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto(UNIVERSE);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('街角');
  await expect(page.locator('.viewer')).toHaveAttribute('data-members', '2');
  await waitForScene(page, 'optimized');
  await expect(page.locator('.viewer__member-tag', { hasText: '街角花店' })).toHaveCount(1);
  // 正在路上的一单：只有起点，在花店收银台显示图标。
  await expect(
    page.locator('.viewer__event[data-visual="path"][data-pending="origin"]'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: '回到全景' }).click();
  await page.waitForTimeout(500);
  await expectRendered(page);
  await page.screenshot({ path: join(SHOTS, 'universe.png') });

  // 花刚送到：完整路线（沿街道连接）。
  await request.post('/__fixtures/emit?kind=delivery');
  await expect(page.locator('.viewer__event[data-visual="path"]:not([data-pending])')).toHaveCount(
    1,
    {
      timeout: 12_000,
    },
  );
  await page.screenshot({ path: join(SHOTS, 'universe-delivery-arrived.png') });

  // 回放到送花途中：路线按两事件的时间差推进。
  await page.getByRole('slider', { name: '时间' }).fill(String(Date.parse('2026-10-27T10:12:00Z')));
  await expect(page.locator('.viewer__event[data-visual="path"]:not([data-pending])')).toHaveCount(
    1,
    {
      timeout: 12_000,
    },
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, 'universe-delivery-in-transit.png') });

  // 点连接标识：镜头飞到另一端。
  await page.locator('.viewer__link').first().click();
  await expect(page.locator('.viewer')).toHaveAttribute('data-fly-target', /,/);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, 'universe-fly.png') });
  expect(errors).toEqual([]);
});

test('预览页：标明草稿预览，草稿区块和新贴图经预览接口读取，不缓存', async ({ page }) => {
  const previewRequests: { url: string; auth?: string; cache?: string }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/public/')) {
      previewRequests.push({
        url: url.pathname,
        auth: response.request().headers().authorization,
        cache: response.headers()['cache-control'],
      });
    }
  });
  await page.goto(PREVIEW);
  await expect(page.locator('.space__badge')).toHaveText('草稿预览');
  await waitForScene(page, 'extended');
  await page.getByRole('button', { name: '回到全景' }).click();
  await page.waitForTimeout(800);
  expect(await numberAttr(page, 'data-textured')).toBeGreaterThan(0);
  await expectRendered(page);
  await page.screenshot({ path: join(SHOTS, 'preview.png') });
  expect(previewRequests.length).toBeGreaterThan(2);
  for (const request of previewRequests) {
    expect(request.url.startsWith('/api/public/previews')).toBe(true);
    expect(request.auth).toMatch(/^Preview /);
    expect(request.cache).toBe('no-store');
  }
});

test('错误页：链接无效和空间不存在给出同样的提示', async ({ page }) => {
  await page.goto('/s/demo-lobby#share=wrong');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('打不开这个空间');
  const wrongToken = await alert.textContent();
  await page.screenshot({ path: join(SHOTS, 'error.png') });
  await page.goto('/s/no-such-space#share=fixture-share-token-0123456789abcdef');
  await expect(page.getByRole('alert')).toContainText('打不开这个空间');
  expect(await page.getByRole('alert').textContent()).toBe(wrongToken);
  await page.goto('/s/demo-lobby');
  await expect(page.getByRole('alert')).toContainText('分享令牌');
  await page.goto('/u/demo-street#share=wrong');
  await expect(page.getByRole('alert')).toContainText('链接无效，或者组合不存在');
  await page.goto('/preview#t=wrong');
  await expect(page.getByRole('alert')).toContainText('预览链接无效或已过期');
});

test('浅色主题', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  // 跟随系统 → 浅色 → 深色：默认深色，点一次到"跟随系统"，再点到浅色。
  const toggle = page.locator('.theme-toggle');
  for (
    let i = 0;
    i < 3 && !(await page.evaluate(() => !document.body.hasAttribute('data-ds-dark-theme')));
    i += 1
  ) {
    await toggle.click();
  }
  await expect(page.locator('body')).not.toHaveAttribute('data-ds-dark-theme', '');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, 'light-theme.png') });
});

test.describe('移动端', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('手机宽度下可用，画布交给触控手势', async ({ page }) => {
    await page.goto(LINK);
    await waitForScene(page, 'optimized');
    await expect(page.locator('.viewer__canvas')).toHaveCSS('touch-action', 'none');
    await expect(page.getByRole('slider', { name: '时间' })).toBeVisible();
    // 页面不出现横向滚动条。
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // 手机上标签更少（最多 4 个），房间同样占画面的大部分。
    await expect.poll(() => numberAttr(page, 'data-labels')).toBeGreaterThan(0);
    expect(await visibleLabels(page).count()).toBeLessThanOrEqual(4);
    expect(await roomCoverage(page)).toBeGreaterThan(0.3);
    await page.screenshot({ path: join(SHOTS, 'mobile.png') });

    // 单指拖动旋转、双指张开缩放：画面都会变。
    const canvas = page.locator('.viewer__canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const session = await page.context().newCDPSession(page);
    const touch = async (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      points: { x: number; y: number }[],
    ) => {
      await session.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((p, id) => ({ ...p, id })),
      });
    };
    const before = await canvas.screenshot();
    await touch('touchStart', [{ x: cx, y: cy }]);
    for (let i = 1; i <= 8; i += 1) await touch('touchMove', [{ x: cx + i * 12, y: cy }]);
    await touch('touchEnd', []);
    await page.waitForTimeout(600);
    const rotated = await canvas.screenshot();
    expect(Buffer.compare(before, rotated)).not.toBe(0);
    await touch('touchStart', [
      { x: cx - 20, y: cy },
      { x: cx + 20, y: cy },
    ]);
    for (let i = 1; i <= 8; i += 1) {
      await touch('touchMove', [
        { x: cx - 20 - i * 10, y: cy },
        { x: cx + 20 + i * 10, y: cy },
      ]);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(600);
    const zoomed = await canvas.screenshot();
    expect(Buffer.compare(rotated, zoomed)).not.toBe(0);
    await page.screenshot({ path: join(SHOTS, 'mobile-touch.png') });
  });
});
