import { expect, test } from '@playwright/test';

test('授权管理：从首页进入、核对账号、查询角色，再确认断开', async ({ page }) => {
  let connected = true;
  let role = 'admin';
  let disconnects = 0;
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session')) {
      await route.fulfill({
        json: connected
          ? { enabled: true, connected: true, subject: 'account-alice', csrfToken: 'private-csrf' }
          : { enabled: true, connected: false },
      });
    } else if (path.endsWith('/organizations')) {
      await route.fulfill({
        json: {
          subject: 'account-alice',
          organizations: [{ id: 'org-chronoai', name: 'ChronoAI', role: 'admin' }],
        },
      });
    } else if (path.endsWith('/check')) {
      expect(route.request().headers()['x-csrf-token']).toBe('private-csrf');
      const body = route.request().postDataJSON() as { orgId?: string };
      await route.fulfill({
        json: {
          subject: 'account-alice',
          status: 'ready',
          organization: body.orgId
            ? { id: body.orgId, role, access: role === 'admin' ? 'manage' : 'read' }
            : null,
        },
      });
    } else if (path.endsWith('/disconnect')) {
      expect(route.request().headers()['x-csrf-token']).toBe('private-csrf');
      connected = false;
      disconnects += 1;
      await route.fulfill({ status: 204 });
    } else await route.abort();
  });
  await page.goto('/');
  await page.getByRole('link', { name: '连接 NyxID' }).click();
  await expect(page.getByText('account-alice')).toBeVisible();
  await expect(page.getByText('连接有效', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(page.getByText('连接有效', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '选择我的组织' }).click();
  await page.getByRole('combobox', { name: '我的组织' }).selectOption('org-chronoai');
  await expect(page.getByRole('textbox', { name: '组织编号' })).toHaveValue('org-chronoai');
  await page.getByRole('button', { name: '查询权限' }).click();
  await expect(page.getByText('管理员 · 可管理组织资源')).toBeVisible();
  role = 'viewer';
  await page.getByRole('button', { name: '查询权限' }).click();
  await expect(page.getByText('查看者 · 可读取组织资源')).toBeVisible();
  await expect(page.getByText('管理员 · 可管理组织资源')).toHaveCount(0);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  expect(disconnects).toBe(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.getByRole('button', { name: '确认断开', exact: true }).click();
  await expect(page.getByRole('link', { name: '前往 NyxID 授权' })).toHaveAttribute(
    'href',
    '/api/auth/nyxid/login',
  );
  await expect(page.getByText('account-alice')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '组织编号' })).toBeDisabled();
  expect(disconnects).toBe(1);
  expect(await page.locator('body').innerText()).not.toContain('private-csrf');
});

test('手机端可滚动阅读授权范围，回调错误可以恢复', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.route('**/api/auth/nyxid/session', (route) =>
    route.fulfill({ json: { enabled: true, connected: false } }),
  );
  await page.goto('/connect?error=expired&code=private-code');
  await expect(page.getByRole('alert')).toContainText('授权链接已过期');
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByRole('link', { name: '前往 NyxID 授权' })).toBeVisible();
  await page.getByText('这份授权是否只能查询组织角色？').click();
  await expect(page.getByText(/目前不能这样保证/)).toBeVisible();
  await page.getByText('凭据保存在哪里，如何撤销？').click();
  await expect(page.getByRole('link', { name: '打开 NyxID' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  expect(await page.locator('body').innerText()).not.toContain('private-code');
});
