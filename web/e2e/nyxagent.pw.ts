import { expect, test } from '@playwright/test';

test('等待授权后交付一次性凭据，切换助手不丢失交付，刷新复用原授权', async ({ page }) => {
  const credential = 'nyx_browser_nyxagent_delivery_credential';
  const identity = {
    ownerId: 'owner',
    credentialVersion: 'n'.repeat(43),
    keyId: 'nyx-key',
    name: '网页授权',
    credentialId: 'nyx-child',
    credentialExpiresAt: null,
    keyExpiresAt: null,
  };
  let requests = 0;
  let polls = 0;
  let deliver: () => void = () => {};
  const delivery = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'owner',
          csrfToken: 'csrf',
          workerAvailable: false,
          workerEnabled: false,
        },
      });
    if (path.endsWith('/spaces'))
      return route.fulfill({ json: { items: [], organizations: [], next: null } });
    if (path.endsWith('/nyxagent/key/request')) {
      requests++;
      return route.fulfill({
        json: {
          device_code: 'private-device',
          user_code: 'ABCD-1234',
          expires_in: 300,
          interval: 1,
          verification_uri: 'https://nyxid.ai/login/agent-key?user_code=ABCD-1234',
        },
      });
    }
    if (path.endsWith('/nyxagent/key/poll')) {
      polls++;
      expect(route.request().postDataJSON()).toEqual({ deviceCode: 'private-device' });
      if (polls === 1)
        return route.fulfill({
          status: 403,
          json: { code: 'nyxagent_key_pending', detail: '等待授权' },
        });
      expect(polls).toBe(2);
      await delivery;
      return route.fulfill({ json: { credential, identity } });
    }
    if (path.endsWith('/nyxagent/key/check')) {
      expect(route.request().headers().authorization).toBe(`Bearer ${credential}`);
      return route.fulfill({ json: identity });
    }
    throw new Error(`Unexpected operation ${path}`);
  });
  await page.goto('/workspace');
  await page.locator('.workspace__chat-launcher').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: '打开空间助手' }).isVisible())
    await page.getByRole('button', { name: '打开空间助手' }).click();
  await page.getByRole('combobox', { name: '空间助手' }).selectOption('nyxagent');
  await page.getByRole('button', { name: '授权此浏览器调用 NyxAgent' }).click();
  await expect(page.getByRole('link', { name: '打开 NyxID 授权页' })).toBeVisible();
  await expect.poll(() => polls).toBe(2);
  await page.getByRole('combobox', { name: '空间助手' }).selectOption('cma');
  await page.getByRole('combobox', { name: '空间助手' }).selectOption('nyxagent');
  deliver();
  await expect(page.getByText('已连接 NyxAgent', { exact: true })).toBeVisible();
  await page.reload();
  await page.locator('.workspace__chat-launcher').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: '打开空间助手' }).isVisible())
    await page.getByRole('button', { name: '打开空间助手' }).click();
  await page.getByRole('combobox', { name: '空间助手' }).selectOption('nyxagent');
  await expect(page.getByText('已连接 NyxAgent', { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  expect(polls).toBe(2);
});

test('独立 Agent Key 聊天，无 CMA 配置也可续聊；刷新后自动查询原请求结果', async ({ page }) => {
  const key = 'nyx_browser_nyxagent_test_credential';
  const identity = {
    ownerId: 'owner',
    credentialVersion: 'n'.repeat(43),
    keyId: 'nyx-key',
    name: 'NyxAgent',
    credentialId: 'nyx-child',
    credentialExpiresAt: null,
    keyExpiresAt: null,
  };
  const writes: Record<string, unknown>[] = [];
  await page.addInitScript(
    ({ key, identity }) => {
      localStorage.setItem(
        'metaverse-nyxagent-credential:v2:owner:owner',
        JSON.stringify({ subject: 'owner', credential: key, identity }),
      );
      if (!sessionStorage.getItem('metaverse-worker:owner'))
        sessionStorage.setItem(
          'metaverse-worker:owner',
          JSON.stringify({ spaceId: 'lobby', orgId: '', instruction: '' }),
        );
    },
    { key, identity },
  );
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'owner',
          csrfToken: 'csrf',
          workerAvailable: false,
          workerEnabled: false,
        },
      });
    if (path.endsWith('/spaces'))
      return route.fulfill({
        json: {
          items: [
            {
              id: 'lobby',
              name: '测试空间',
              description: '',
              owner: { kind: 'org', id: 'team' },
              visibility: 'unlisted',
              access: 'manage',
            },
          ],
          organizations: [],
          next: null,
        },
      });
    if (path.includes('/view/')) return route.fulfill({ status: 404, json: {} });
    if (path.includes('/worker/'))
      return route.fulfill({
        status: 503,
        json: { code: 'cma_unavailable', detail: '未配置 CMA' },
      });
    expect(path).toContain('/nyxagent/');
    const headers = route.request().headers();
    expect(headers.authorization).toBe(`Bearer ${key}`);
    expect(headers['x-csrf-token']).toBe('csrf');
    if (path.endsWith('/key/check')) return route.fulfill({ json: identity });
    if (path.endsWith('/message')) {
      expect(headers['x-metaverse-cma-credential']).toBe(identity.credentialVersion);
      writes.push(route.request().postDataJSON());
      const response = {
        id: writes.length === 1 ? 'resp_first' : 'resp_second',
        conversation: { id: 'conv_test' },
        status: 'in_progress',
        output: [],
      };
      const created = `data: ${JSON.stringify({ type: 'response.created', response })}\n\n`;
      // The second turn ends without a terminal event; retry commits the same response.
      const terminal =
        writes.length === 2
          ? ''
          : `data: ${JSON.stringify({ type: 'response.completed', response: { ...response, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: writes.length === 1 ? '已完成第一轮' : '已恢复原请求' }] }] } })}\n\n`;
      return route.fulfill({ contentType: 'text/event-stream', body: created + terminal });
    }
    if (path.endsWith('/response')) {
      expect(route.request().postDataJSON()).toEqual({ responseId: 'resp_second' });
      return route.fulfill({
        json: {
          id: 'resp_second',
          conversation: { id: 'conv_test' },
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '已恢复原请求' }],
            },
          ],
        },
      });
    }
    throw new Error(`Unexpected operation ${path}`);
  });
  await page.goto('/workspace');
  await page.locator('.workspace__chat-launcher').waitFor({ state: 'attached' });
  if (await page.getByRole('button', { name: '打开空间助手' }).isVisible())
    await page.getByRole('button', { name: '打开空间助手' }).click();
  await page.getByRole('combobox', { name: '空间助手' }).selectOption('nyxagent');
  await expect(page.getByText('已连接 NyxAgent', { exact: true })).toBeVisible();
  await page.getByLabel('给 NyxAgent 发消息').fill('第一条');
  await page.getByRole('button', { name: '发送给 NyxAgent' }).click();
  await expect(page.getByText('已完成第一轮')).toBeVisible();
  expect(writes[0]).not.toHaveProperty('conversationId');
  expect(writes[0]!.orgId).toBe('team');
  await page.getByLabel('给 NyxAgent 发消息').fill('第二条');
  await page.getByRole('button', { name: '发送给 NyxAgent' }).click();
  await expect(page.getByRole('button', { name: '查看任务进度' })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]!.conversationId).toBe('conv_test');
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'NyxAgent 空间聊天' })).toBeVisible();
  await expect(page.getByText('已连接 NyxAgent', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  await expect(page.getByText('已恢复原请求')).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(
    await page.evaluate(() => localStorage.getItem('metaverse-cma-credential:v2:owner:owner')),
  ).toBeNull();
});
