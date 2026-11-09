import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = join(import.meta.dirname, 'screenshots');
const LINK = '/s/demo-lobby#share=fixture-share-token-0123456789abcdef';

async function waitForScene(page: Page, mode: string) {
  const viewer = page.locator('.viewer');
  await expect(viewer).toHaveAttribute('data-mode', mode);
  await expect(viewer).toHaveAttribute('data-ready', 'true');
  // 给渲染循环几帧时间。
  await page.waitForTimeout(800);
}

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test('夹具空间：三种视图都能渲染并截图', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(LINK);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('演示前厅');
  await expect(page.locator('.space__version')).toContainText('版本 #4');

  // 优化视图：实体区的物件和地毯方块；有虚拟区以外的全部家具。
  await waitForScene(page, 'optimized');
  const viewer = page.locator('.viewer');
  expect(Number(await viewer.getAttribute('data-entities'))).toBeGreaterThan(10);
  expect(Number(await viewer.getAttribute('data-triangles'))).toBeGreaterThan(1000);
  await expect(page.locator('.viewer__anchor', { hasText: '1 号桌' })).toHaveCount(1);
  await expect(page.locator('.viewer__anchor', { hasText: '内部摄像头' })).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, 'optimized.png') });

  // 优化 + 扩展：多了虚拟展台、方块平台和"虚拟"标签。
  await page.getByRole('button', { name: '优化 + 扩展' }).click();
  await waitForScene(page, 'extended');
  await expect(page.locator('.viewer__virtual-tag')).toContainText('虚拟');
  expect(Number(await viewer.getAttribute('data-voxel-faces'))).toBeGreaterThan(100);
  await page.screenshot({ path: join(SHOTS, 'extended.png') });

  // 原始：扫描模型（夹具生成的 glb）。
  await page.getByRole('button', { name: '原始', exact: true }).click();
  await waitForScene(page, 'raw');
  await page.screenshot({ path: join(SHOTS, 'raw.png') });

  // 不剖切时能看到天花板。
  await page.getByRole('button', { name: '优化', exact: true }).click();
  await page.getByRole('checkbox', { name: '剖切' }).uncheck();
  await waitForScene(page, 'optimized');
  await page.screenshot({ path: join(SHOTS, 'optimized-no-cutaway.png') });

  expect(errors).toEqual([]);
});

test('时间轴：回到重建之前，再回到现在', async ({ page }) => {
  await page.goto(LINK);
  await waitForScene(page, 'optimized');
  const now = page.getByRole('button', { name: '现在' });
  await expect(now).toHaveAttribute('aria-pressed', 'true');

  // 提交 #1 和 #2 只差 20 分钟，标记会重叠：先点 #2，再用"上一个提交"回到 #1。
  await page.getByRole('button', { name: /跳到提交 #2/ }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #2');
  await page.getByRole('button', { name: '上一个提交' }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #1');
  await expect(now).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('这个时刻还没有优化模型')).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'before-rebuild.png') });

  await page.getByRole('button', { name: '下一个提交' }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #2');
  await page.getByRole('button', { name: /跳到提交 #3/ }).click();
  await expect(page.locator('.space__version')).toContainText('版本 #3');

  await now.click();
  await expect(now).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.space__version')).toContainText('版本 #4');
});

test('没有分享令牌时提示链接无效', async ({ page }) => {
  await page.goto('/s/demo-lobby');
  await expect(page.getByRole('alert')).toContainText('打不开这个空间');
  await expect(page.getByRole('alert')).toContainText('分享令牌');
});
