import { expect, test } from '@playwright/test';

test('CMA 浏览器审批、刷新复用和撤销，凭据不进入恢复记录', async ({ page }) => {
  const identity = {
    keyId: 'key-cma',
    name: 'Metaverse CMA',
    credentialId: 'child-browser',
    credentialExpiresAt: null,
    keyExpiresAt: null,
  };
  const credential = 'nyx_browser_playwright_only';
  let enrollments = 0;
  let checks = 0;
  let revocations = 0;
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'browser-owner',
          csrfToken: 'csrf',
          workerAvailable: true,
          workerEnabled: true,
        },
      });
    if (path.endsWith('/spaces'))
      return route.fulfill({ json: { items: [], organizations: [], next: null } });
    expect(route.request().headers()['x-csrf-token']).toBe('csrf');
    if (path.endsWith('/key/request')) {
      enrollments++;
      return route.fulfill({
        json: {
          device_code: 'private-device',
          user_code: 'ABCD-1234',
          verification_uri: 'https://nyxid.ai/login/agent-key?services=cma',
          expires_in: 300,
          interval: 1,
        },
      });
    }
    if (path.endsWith('/key/poll')) return route.fulfill({ json: { credential, identity } });
    expect(route.request().headers()['authorization']).toBe(`Bearer ${credential}`);
    if (path.endsWith('/key/check')) {
      checks++;
      return route.fulfill({ json: identity });
    }
    if (path.endsWith('/key/revoke')) {
      revocations++;
      return route.fulfill({ json: { revoked: true } });
    }
    throw new Error(`unexpected write ${path}`);
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  await page.getByRole('button', { name: '授权此浏览器调用 CMA' }).click();
  await expect(page.getByText('ABCD-1234')).toBeVisible();
  const href = await page.getByRole('link', { name: '打开 NyxID 授权页' }).getAttribute('href');
  expect(href).not.toMatch(/ABCD|private-device/);
  await expect(page.getByText('已连接 CMA · Metaverse CMA')).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('metaverse-cma-credential:v1')),
  ).toContain(credential);
  expect(
    await page.evaluate(() => sessionStorage.getItem('metaverse-worker:browser-owner') ?? ''),
  ).not.toContain(credential);
  await page.reload();
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  await expect(page.getByText('已连接 CMA · Metaverse CMA')).toBeVisible();
  expect(enrollments).toBe(1);
  expect(checks).toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/metaverse-browser-key-1280.png' });
  await page.getByRole('button', { name: '断开此浏览器的 CMA 授权' }).click();
  await expect(page.getByRole('button', { name: '授权此浏览器调用 CMA' })).toBeVisible();
  expect(revocations).toBe(1);
  expect(
    await page.evaluate(() => sessionStorage.getItem('metaverse-cma-credential:v1')),
  ).toBeNull();
});
