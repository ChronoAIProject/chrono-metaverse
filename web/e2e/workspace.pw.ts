import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/public/{chunks,assets}/**', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        Authorization: 'Share fixture-share-token-0123456789abcdef',
      },
    });
  });
});

// 等夹具回调结束后再关闭页面，保留真实的路由错误。
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('工作台：手机上复制空间链接，收件人在新会话中免登录查看', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const token = 'fixture-share-token-0123456789abcdef';
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 375, height: 720 });
  await page.route('**/api/auth/nyxid/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        connected: true,
        subject: 'web-owner',
        csrfToken: 'private-csrf',
      },
    }),
  );
  await page.route('**/api/auth/nyxid/spaces', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'demo-lobby',
            name: '演示前厅',
            description: '',
            owner: { kind: 'person', id: 'web-owner' },
            visibility: 'unlisted',
            access: 'manage',
            updatedAt: '2026-11-11T00:00:00Z',
          },
        ],
        organizations: [],
        next: null,
      },
    }),
  );
  await page.route('**/api/auth/nyxid/view/**', (route) => route.abort());
  await page.route('**/api/auth/nyxid/spaces/demo-lobby/share', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe('private-csrf');
    return route.fulfill({ json: { token } });
  });
  await page.goto('/workspace?space=demo-lobby');
  await page.getByRole('button', { name: '分享空间' }).click();
  const dialog = page.getByRole('dialog', { name: '分享空间' });
  const url = `${baseURL}/s/demo-lobby#share=${token}`;
  await expect(dialog.getByRole('textbox', { name: '分享链接' })).toHaveValue(url);
  await dialog.getByRole('button', { name: '复制链接' }).click();
  await expect(dialog.getByRole('status')).toHaveText('已复制链接');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(url);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '分享空间' })).toBeFocused();

  const recipient = await browser.newPage();
  try {
    const metadata = recipient.waitForRequest('**/api/public/spaces/demo-lobby');
    await recipient.goto(copied);
    const request = await metadata;
    expect(request.headers()['authorization']).toBe(`Share ${token}`);
    expect(await request.headerValue('cookie')).toBeNull();
    await expect(recipient.locator('.viewer[data-ready="true"]')).toBeVisible();
  } finally {
    await recipient.close();
  }
});
