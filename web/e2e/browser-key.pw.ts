import { expect, test } from '@playwright/test';

for (const organization of [false, true])
  test(`CMA ${organization ? '组织' : '个人'}点击授权、刷新复用和撤销，凭据不进入恢复记录`, async ({
    page,
    context,
  }) => {
    const owner = organization ? 'org-one' : 'browser-owner';
    const storage = `metaverse-cma-credential:v2:browser-owner:${owner}`;
    if (organization)
      await page.addInitScript(() => {
        if (!sessionStorage.getItem('metaverse-worker:browser-owner'))
          sessionStorage.setItem(
            'metaverse-worker:browser-owner',
            JSON.stringify({ spaceId: '', orgId: 'org-one', instruction: '' }),
          );
      });
    const identity = {
      ownerId: owner,
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
    let approved = false;
    let pendingPolls = 0;
    // 使用明确的审批夹具，不批准真实 NyxID 请求。
    await context.route(/^https:\/\/nyxid\.ai\/login\/agent-key(?:\?|$)/, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      expect(params.get('user_code')).toBe('ABCD-1234');
      expect(params.has('owner_id')).toBe(false);
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<form method="post" action="/metaverse-test-approve"><p>CMA 专用授权</p><button>确认授权 CMA</button></form>',
      });
    });
    await context.route('https://nyxid.ai/metaverse-test-approve', async (route) => {
      expect(route.request().method()).toBe('POST');
      approved = true;
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<p>已授权，请返回 Metaverse</p>',
      });
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await context.route('**/api/auth/nyxid/**', async (route) => {
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
        return route.fulfill({
          json: {
            items: [
              {
                id: 'browser-space',
                name: '已有测试空间',
                description: '',
                owner: { kind: organization ? 'org' : 'person', id: owner },
                access: 'manage',
                visibility: 'private',
                updatedAt: '2026-11-11T00:00:00Z',
              },
            ],
            organizations: organization
              ? [{ id: 'org-one', name: 'Example team', role: 'admin' }]
              : [],
            next: null,
          },
        });
      expect(route.request().headers()['x-csrf-token']).toBe('csrf');
      if (path.includes('/view/'))
        return route.fulfill({
          status: 404,
          json: { code: 'fixture_no_scene', detail: '仅测试授权恢复' },
        });
      expect(route.request().headers()['x-metaverse-cma-owner']).toBe(
        organization ? owner : undefined,
      );
      if (path.endsWith('/key/request')) {
        enrollments++;
        return route.fulfill({
          json: {
            device_code: 'private-device',
            user_code: 'ABCD-1234',
            verification_uri: 'https://nyxid.ai/login/agent-key?services=cma&user_code=ABCD-1234',
            expires_in: 300,
            interval: 1,
          },
        });
      }
      if (path.endsWith('/key/poll')) {
        if (approved) return route.fulfill({ json: { credential, identity } });
        pendingPolls++;
        return route.fulfill({
          status: 400,
          json: { code: 'cma_key_pending', detail: '等待确认' },
        });
      }
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
    await expect(
      page.getByText(`当前空间使用：${organization ? 'Example team' : '个人账号'}的 CMA`),
    ).toBeVisible();
    await page.getByRole('button', { name: '授权此浏览器调用 CMA' }).click();
    await expect(page.getByText(/无需输入验证码或 Key/)).toBeVisible();
    const href = await page.getByRole('link', { name: '打开 NyxID 授权页' }).getAttribute('href');
    expect(new URL(href!).searchParams.get('user_code')).toBe('ABCD-1234');
    expect(href).not.toMatch(/private-device|nyx_browser/);
    await expect.poll(() => pendingPolls).toBeGreaterThan(0);
    await page.reload();
    await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
    await expect(page.getByRole('link', { name: '打开 NyxID 授权页' })).toHaveAttribute(
      'href',
      href!,
    );
    expect(enrollments).toBe(1);
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: '打开 NyxID 授权页' }).click();
    const approval = await popupPromise;
    await approval.waitForLoadState('domcontentloaded');
    await expect(approval.getByRole('textbox')).toHaveCount(0);
    await expect.poll(() => pendingPolls).toBeGreaterThan(0);
    await expect(page.getByText('已连接 CMA · Metaverse CMA')).toHaveCount(0);
    await approval.getByRole('button', { name: '确认授权 CMA' }).click();
    await expect(page.getByText('已连接 CMA · Metaverse CMA')).toBeVisible();
    await approval.close();
    expect(await page.evaluate((key) => localStorage.getItem(key), storage)).toContain(credential);
    expect(
      await page.evaluate(() => sessionStorage.getItem('metaverse-worker:browser-owner') ?? ''),
    ).not.toContain(credential);
    await page.reload();
    await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
    await expect(page.getByText('已连接 CMA · Metaverse CMA')).toBeVisible();
    expect(enrollments).toBe(1);
    expect(checks).toBeGreaterThan(0);
    await page.getByRole('button', { name: '选择空间' }).click();
    await page.getByRole('button', { name: /已有测试空间/ }).click();
    await expect(page.getByText('已连接 CMA · Metaverse CMA')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
    await expect(page.getByText('已连接 CMA · Metaverse CMA')).toBeVisible();
    // 新标签页没有聊天恢复记录，必须依据目录归属找到同一凭据。
    const other = await context.newPage();
    await other.goto('/');
    expect(
      await other.evaluate(() => sessionStorage.getItem('metaverse-worker:browser-owner')),
    ).toBeNull();
    await other.goto('/workspace?space=browser-space');
    await other.getByRole('button', { name: '打开 CMA 聊天' }).click();
    await expect(other.getByText('已连接 CMA · Metaverse CMA')).toBeVisible();
    expect(enrollments).toBe(1);
    // 切到另一归属时，不能借用原归属的凭据。
    await other.evaluate(
      (org) =>
        sessionStorage.setItem(
          'metaverse-worker:browser-owner',
          JSON.stringify({
            spaceId: '',
            orgId: org ? '' : 'org-one',
            instruction: '',
          }),
        ),
      organization,
    );
    await other.goto('/workspace');
    await other.getByRole('button', { name: '打开 CMA 聊天' }).click();
    await expect(other.getByRole('button', { name: '授权此浏览器调用 CMA' })).toBeVisible();
    await other.close();
    await page.screenshot({ path: '/tmp/metaverse-browser-key-1280.png' });
    await page.getByRole('button', { name: '断开此浏览器的 CMA 授权' }).click();
    await expect(page.getByRole('button', { name: '授权此浏览器调用 CMA' })).toBeVisible();
    expect(revocations).toBe(1);
    expect(await page.evaluate((key) => localStorage.getItem(key), storage)).toBeNull();
  });
