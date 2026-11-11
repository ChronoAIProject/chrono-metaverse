import { expect, test } from '@playwright/test';

test('CMA OAuth 会话在刷新后复用，不读取或发送浏览器 Key', async ({ page }) => {
  let probes = 0;
  await page.addInitScript(() => {
    localStorage.setItem('metaverse-cma-credential:v2:owner:owner', 'obsolete-secret');
  });
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().headers().authorization).toBeUndefined();
    if (path.endsWith('/session'))
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'owner',
          csrfToken: 'csrf',
          workerAvailable: true,
          workerEnabled: true,
        },
      });
    if (path.endsWith('/spaces'))
      return route.fulfill({ json: { items: [], organizations: [], next: null } });
    if (path.endsWith('/connection')) {
      probes++;
      return route.fulfill({ json: { ready: true, ownerId: 'owner' } });
    }
    throw new Error(`Unexpected auth operation: ${path}`);
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  await expect(page.getByText('已连接 CMA', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('metaverse-cma-credential:v2:owner:owner')),
    )
    .toBeNull();
  await page.reload();
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  await expect(page.getByText('已连接 CMA', { exact: true })).toBeVisible();
  expect(probes).toBeGreaterThanOrEqual(2);
});

test('原登录缺少 CMA grant 时提供 OAuth 入口，不申请新 Key', async ({ page }) => {
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'owner',
          csrfToken: 'csrf',
          workerAvailable: true,
          workerEnabled: false,
        },
      });
    if (path.endsWith('/spaces'))
      return route.fulfill({ json: { items: [], organizations: [], next: null } });
    if (path.endsWith('/connection'))
      return route.fulfill({
        status: 403,
        json: { code: 'cma_oauth_required', detail: '请授权网页使用 CMA' },
      });
    throw new Error(`Unexpected auth operation: ${path}`);
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  await expect(page.getByRole('link', { name: '授权网页使用 CMA' })).toHaveAttribute(
    'href',
    '/api/auth/nyxid/login?workspace=1',
  );
  await expect(page.getByRole('button', { name: '启用 CMA 聊天' })).toHaveCount(0);
});
