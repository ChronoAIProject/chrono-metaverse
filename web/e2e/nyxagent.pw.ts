import { expect, test } from '@playwright/test';

test('独立 Agent Key 聊天，无 CMA 配置也可续聊；刷新后显式恢复原请求', async ({ page }) => {
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
              owner: { kind: 'person', id: 'owner' },
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
    throw new Error(`Unexpected operation ${path}`);
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开 NyxAgent 聊天' }).click();
  await expect(page.getByText('已连接 NyxAgent · NyxAgent')).toBeVisible();
  await page.getByLabel('给 NyxAgent 发消息').fill('第一条');
  await page.getByRole('button', { name: '发送给 NyxAgent' }).click();
  await expect(page.getByText('已完成第一轮')).toBeVisible();
  expect(writes[0]).not.toHaveProperty('conversationId');
  await page.getByLabel('给 NyxAgent 发消息').fill('第二条');
  await page.getByRole('button', { name: '发送给 NyxAgent' }).click();
  await expect(page.getByRole('button', { name: '恢复 NyxAgent 原请求' })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]!.conversationId).toBe('conv_test');
  await page.reload();
  await page.getByRole('button', { name: '打开 NyxAgent 聊天' }).click();
  await expect(page.getByText('已连接 NyxAgent · NyxAgent')).toBeVisible();
  expect(writes).toHaveLength(2);
  await page.getByRole('button', { name: '恢复 NyxAgent 原请求' }).click();
  await expect(page.getByText('已恢复原请求')).toBeVisible();
  expect(writes).toHaveLength(3);
  expect(writes[2]).toEqual(writes[1]);
  expect(
    await page.evaluate(() => localStorage.getItem('metaverse-cma-credential:v2:owner:owner')),
  ).toBeNull();
});
