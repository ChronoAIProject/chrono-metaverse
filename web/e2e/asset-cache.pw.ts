import { expect, test, type Request } from '@playwright/test';

const PREVIEW = '/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899';

test('草稿模型和贴图在刷新后复用浏览器缓存，预览授权每次重新验证', async ({ page }) => {
  const assets: string[] = [];
  const pending = new Set<Request>();
  let previews = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/previews/assets/')) {
      assets.push(path);
      pending.add(request);
    }
    if (path === '/api/public/previews') previews++;
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  await page.goto(PREVIEW);
  const viewer = page.locator('.viewer');
  await expect(viewer).toHaveAttribute('data-ready', 'true');
  await expect(viewer).toHaveAttribute('data-models-pending', '0');
  await expect.poll(() => pending.size).toBe(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open('chrono-metaverse-models-v1');
        return (await cache.keys()).length;
      }),
    )
    .toBeGreaterThan(0);
  const first = assets.length;
  const initialPreviews = previews;
  expect(first).toBeGreaterThan(0);
  expect(initialPreviews).toBeGreaterThan(0);
  await page.reload();
  await expect(viewer).toHaveAttribute('data-ready', 'true');
  await expect(viewer).toHaveAttribute('data-models-pending', '0');
  await expect.poll(() => pending.size).toBe(0);
  expect(assets.length).toBe(first);
  // 开发模式的 StrictMode 会重跑一次加载；每次刷新仍必须重新请求授权。
  expect(previews).toBe(initialPreviews * 2);

  // 缓存存在时，过期或撤销的预览仍必须显示错误页。
  await page.route('**/api/public/previews', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      body: JSON.stringify({ title: '预览已失效' }),
    }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: '打不开这个预览' })).toBeVisible();
  await expect(viewer).toHaveCount(0);
  expect(assets.length).toBe(first);
});

test('浏览器拒绝持久存储时仍可加载草稿', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'caches', {
      value: { open: () => Promise.reject(new Error('storage disabled')) },
    });
  });
  await page.goto(PREVIEW);
  await expect(page.locator('.viewer')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.viewer')).toHaveAttribute('data-models-pending', '0');
  await expect(page.locator('.viewer')).toHaveAttribute('data-models-failed', '0');
});
