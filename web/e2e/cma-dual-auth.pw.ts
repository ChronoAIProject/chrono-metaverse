import { expect, test } from '@playwright/test';

test('两种授权连续聊天；切换及刷新不重发未知消息，仅原凭据恢复沿用原编号', async ({ page }) => {
  const key = 'nyx_browser_test_credential';
  const writes: { body: unknown; mode: string; bearer?: string }[] = [];
  let rejectFollow = true;
  await page.addInitScript(
    ({ key }) => {
      if (localStorage.getItem('dual-auth-fixture')) return;
      localStorage.setItem('dual-auth-fixture', 'ready');
      localStorage.setItem('metaverse-cma-auth-method:v1:owner', 'agent_key');
      localStorage.setItem(
        'metaverse-cma-credential:v2:owner:owner',
        JSON.stringify({
          subject: 'owner',
          credential: key,
          identity: {
            ownerId: 'owner',
            credentialVersion: 'k'.repeat(43),
            keyId: 'key',
            name: 'CMA',
            credentialId: 'child',
            credentialExpiresAt: null,
            keyExpiresAt: null,
          },
        }),
      );
      sessionStorage.setItem(
        'metaverse-worker:owner',
        JSON.stringify({ spaceId: 'lobby', orgId: '', agentId: 'agt_test', instruction: '' }),
      );
    },
    { key },
  );
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = route.request().headers();
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
    const mode = headers['x-metaverse-cma-auth']!;
    expect(headers.authorization).toBe(mode === 'agent_key' ? `Bearer ${key}` : undefined);
    if (path.endsWith('/key/check'))
      return route.fulfill({
        json: {
          ownerId: 'owner',
          credentialVersion: 'k'.repeat(43),
          keyId: 'key',
          name: 'CMA',
          credentialId: 'child',
          credentialExpiresAt: null,
          keyExpiresAt: null,
        },
      });
    if (path.endsWith('/connection'))
      return route.fulfill({
        json: { ready: true, ownerId: 'owner', credentialVersion: 'o'.repeat(43) },
      });
    if (path.endsWith('/observe'))
      return route.fulfill({
        json: { agent: { id: 'agt_test', status: 'ready' }, transcript: { turns: [] } },
      });
    if (path.endsWith('/response'))
      return route.fulfill({
        json: {
          response: { id: 'resp_test', status: 'completed', output: [] },
          controls: { target_active: false, agent_revision: 1 },
        },
      });
    if (path.endsWith('/message')) {
      expect(headers['x-metaverse-cma-credential']).toBe((mode === 'oauth' ? 'o' : 'k').repeat(43));
      const body = route.request().postDataJSON();
      writes.push({ body, mode, bearer: headers.authorization });
      if (body.instruction === '第二条' && rejectFollow)
        return route.fulfill({
          status: 503,
          json: { code: 'cma_outcome_unknown', detail: '结果尚未确认' },
        });
      return route.fulfill({
        status: 202,
        json: { responseId: 'resp_test', commandId: 'cmd_test' },
      });
    }
    throw new Error(`Unexpected operation ${path}`);
  });
  await page.goto('/workspace');
  const open = page.getByRole('button', { name: '打开 CMA 聊天' });
  await open.click();
  await expect(page.getByText('已连接 CMA · CMA')).toBeVisible();
  await page.getByLabel('给空间发消息').fill('第一条');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByLabel('给空间发消息')).toBeEnabled();
  await page.getByLabel('给空间发消息').fill('第二条');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试原请求' })).toBeVisible();
  expect(writes).toHaveLength(2);
  await page.getByLabel('聊天授权方式').selectOption('oauth');
  await expect(page.getByText('已连接 CMA', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  await page.reload();
  if (await open.isVisible()) await open.click();
  await expect(page.getByLabel('聊天授权方式')).toHaveValue('oauth');
  await expect(page.getByText('已连接 CMA', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  await page.getByRole('button', { name: '重试原请求' }).click();
  await expect(page.getByText(/^上次请求反馈：聊天凭据已变化/)).toBeVisible();
  expect(writes).toHaveLength(2);
  await page.getByLabel('聊天授权方式').selectOption('agent_key');
  await expect(page.getByText('已连接 CMA · CMA')).toBeVisible();
  rejectFollow = false;
  await page.getByRole('button', { name: '重试原请求' }).click();
  await expect.poll(() => writes.length).toBe(3);
  expect(writes[1]!.body).toEqual(writes[2]!.body);
  expect(writes.map((v) => v.mode)).toEqual(['agent_key', 'agent_key', 'agent_key']);
  expect(writes[2]!.bearer).toBe(`Bearer ${key}`);
  await page.getByLabel('聊天授权方式').selectOption('oauth');
  await expect(page.getByText('已连接 CMA', { exact: true })).toBeVisible();
  await expect(page.getByLabel('给空间发消息')).toBeEnabled();
  await page.getByLabel('给空间发消息').fill('OAuth 后续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => writes.length).toBe(4);
  expect(writes[3]!.mode).toBe('oauth');
  expect(writes[3]!.bearer).toBeUndefined();
  await expect(page.getByLabel('给空间发消息')).toBeEnabled();
  await page.getByLabel('给空间发消息').fill('OAuth 第二条');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => writes.length).toBe(5);
  expect(writes[4]!.mode).toBe('oauth');
  expect(
    await page.evaluate(() => localStorage.getItem('metaverse-cma-credential:v2:owner:owner')),
  ).toContain(key);
});
