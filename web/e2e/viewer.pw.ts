import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { decodePng, imageStats } from './png';

/*
 * 夹具模式的端到端测试：三种视图、剖切、时间轴、"现在"模式、组合页、预览页、错误页、移动端。
 * 截图写到 e2e/screenshots/（不进版本库），用来人工核对渲染（圆角和弧度、贴图、不是全黑）。
 */

const SHOTS = join(import.meta.dirname, 'screenshots');
const LINK = '/s/demo-lobby#share=fixture-share-token-0123456789abcdef';
const UNIVERSE = '/u/demo-street#share=fixture-universe-token-00112233445566778899';
const PREVIEW = '/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899';

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
  await page.getByRole('button', { name: '回到全景' }).click();
  await page.waitForTimeout(400);
  expect(errors).toEqual([]);
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
    await page.screenshot({ path: join(SHOTS, 'mobile.png') });
  });
});
