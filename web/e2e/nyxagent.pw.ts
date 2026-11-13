import { expect, test } from '@playwright/test';

test('AI 页面动作切换空间、视图、草稿和镜头，保留同一个 WebGL 查看器及模型缓存', async ({
  page,
}) => {
  const identity = {
    ownerId: 'owner',
    credentialVersion: 'n'.repeat(43),
    keyId: 'nyx-key',
    name: 'NyxAgent',
    credentialId: 'child',
    credentialExpiresAt: null,
    keyExpiresAt: null,
  };
  await page.addInitScript((identity) => {
    localStorage.setItem(
      'metaverse-nyxagent-credential:v2:owner:owner',
      JSON.stringify({ subject: 'owner', credential: 'nyx_browser_page_actions', identity }),
    );
    sessionStorage.setItem('metaverse-chat-provider', 'nyxagent');
  }, identity);
  let nextActions: unknown[] = [];
  let turn = 0;
  let failed = false;
  const writes: Record<string, unknown>[] = [];
  const share = 'Share fixture-share-token-0123456789abcdef';
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/view/')) {
      const second = url.pathname.includes('/demo-second');
      url.pathname = url.pathname
        .replace('/api/auth/nyxid/view', '/api/public')
        .replace('demo-second', 'demo-lobby');
      const response = await route.fetch({
        url: url.href,
        method: 'GET',
        headers: { Authorization: share },
      });
      if (second && response.headers()['content-type']?.includes('json'))
        return route.fulfill({
          response,
          body: (await response.text()).replaceAll('demo-lobby', 'demo-second'),
        });
      return route.fulfill({ response });
    }
    if (url.pathname.endsWith('/session'))
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
    if (url.pathname.endsWith('/spaces'))
      return route.fulfill({
        json: {
          items: ['demo-lobby', 'demo-second'].map((id) => ({
            id,
            name: id === 'demo-lobby' ? '前厅' : '第二空间',
            description: '',
            owner: { kind: 'person', id: 'owner' },
            visibility: 'private',
            access: 'manage',
          })),
          organizations: [],
          next: null,
        },
      });
    if (url.pathname.endsWith('/key/check')) return route.fulfill({ json: identity });
    if (url.pathname.endsWith('/nyxagent/message')) {
      writes.push(route.request().postDataJSON());
      turn++;
      const text = `将执行页面操作 ${turn}。\n\`\`\`metaverse-view\n${JSON.stringify({ actions: nextActions })}\n\`\`\``;
      const response = {
        id: `resp_page_${turn}`,
        conversation: { id: 'conv_page' },
        status: failed ? 'failed' : 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      };
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: failed ? 'response.failed' : 'response.completed', response })}\n\n`,
      });
    }
    throw new Error(`Unexpected operation ${url.pathname}`);
  });
  await page.route('**/api/public/{chunks,assets}/**', (route) =>
    route.continue({ headers: { Authorization: share } }),
  );
  await page.route('**/api/public/previews', async (route) => {
    const response = await route.fetch({
      url: new URL('/api/public/spaces/demo-lobby/snapshot?seq=4', route.request().url()).href,
      headers: { Authorization: share },
    });
    const snapshot = await response.json();
    await route.fulfill({
      json: {
        ...snapshot,
        spaceName: '前厅',
        preview: {
          draftId: 'draft_page',
          rev: 1,
          baseSeq: 4,
          scope: 'rebuild',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      },
    });
  });
  await page.route('**/api/public/previews/chunks/**', async (route) => {
    const url = new URL(route.request().url());
    url.pathname = url.pathname.replace('/previews/', '/') + '.bin';
    await route.fulfill({
      response: await route.fetch({ url: url.href, headers: { Authorization: share } }),
    });
  });
  const downloads: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/public\/(?:previews\/)?assets\//.test(r.url())) downloads.push(r.url());
  });
  await page.goto('/workspace?space=demo-lobby');
  await page.getByRole('button', { name: '打开空间助手', exact: true }).click();
  await expect(page.getByText('已连接 NyxAgent', { exact: true })).toBeVisible();
  const viewer = page.locator('.workspace__scene .viewer');
  const ready = async () => {
    await expect(viewer).toHaveAttribute('data-ready', 'true');
    await expect(viewer).toHaveAttribute('data-models-pending', '0');
    await expect(viewer).toHaveAttribute('data-textures-pending', '0');
  };
  await ready();
  const canvas = await viewer.locator('canvas').first().elementHandle();
  async function send(actions: unknown[]) {
    nextActions = actions;
    await page.getByLabel('给 NyxAgent 发消息').fill(`页面请求 ${turn + 1}`);
    await page.getByRole('button', { name: '发送给 NyxAgent', exact: true }).click();
    if (!failed) await expect(page.getByLabel('给 NyxAgent 发消息')).toBeEnabled();
  }
  await send([{ type: 'mode', value: 'raw' }]);
  await expect(viewer).toHaveAttribute('data-mode', 'raw');
  await ready();
  await send([
    { type: 'mode', value: 'extended' },
    { type: 'style', value: 'blocks' },
    { type: 'cutaway', height: null },
  ]);
  await expect(viewer).toHaveAttribute('data-mode', 'extended');
  await ready();
  await expect(page).toHaveURL(/style=blocks/);
  await send([
    { type: 'mode', value: 'optimized' },
    { type: 'style', value: 'shapes' },
    { type: 'camera', kind: 'overview' },
    { type: 'camera', kind: 'focus', entityId: 'desk-01' },
  ]);
  await expect(viewer).toHaveAttribute('data-mode', 'optimized');
  await expect(viewer).toHaveAttribute('data-camera-command', 'resp_page_3');
  await ready();
  await expect(page.getByRole('complementary', { name: '物件信息' })).toContainText('desk-01');
  const count = downloads.length;
  await send([{ type: 'preview', url: '/preview#t=page-preview' }]);
  await expect(page.locator('[data-preview="true"]')).toHaveAttribute('data-preview-rev', '1');
  await ready();
  expect(downloads).toHaveLength(count);
  await page.getByRole('button', { name: '切换空间视图', exact: true }).click();
  await page.getByRole('button', { name: '当前空间', exact: true }).click();
  await expect(page.locator('[data-preview="true"]')).toHaveCount(0);
  await ready();
  expect(await canvas!.evaluate((canvas) => canvas.isConnected)).toBe(true);
  expect(downloads).toHaveLength(count);
  await send([{ type: 'preview', url: '/preview#t=page-preview' }]);
  await expect(page.locator('[data-preview="true"]')).toBeVisible();
  await ready();
  await send([
    { type: 'current' },
    { type: 'camera', kind: 'orbit', yaw: 40, pitch: -10 },
    { type: 'camera', kind: 'zoom', factor: 0.7 },
  ]);
  await expect(page.locator('[data-preview="true"]')).toHaveCount(0);
  await expect(viewer).toHaveAttribute('data-camera-command', 'resp_page_6');
  await ready();
  await send([
    { type: 'space', spaceId: 'demo-second' },
    { type: 'camera', kind: 'overview' },
  ]);
  await expect(page.locator('[data-space-id="demo-second"]')).toBeVisible();
  await ready();
  await send([{ type: 'space', spaceId: 'demo-lobby' }]);
  await expect(page.locator('[data-space-id="demo-lobby"]')).toBeVisible();
  await ready();
  expect(await canvas!.evaluate((canvas) => canvas.isConnected)).toBe(true);
  expect(downloads).toHaveLength(count);
  await send([
    { type: 'cutaway', height: 0.5 },
    { type: 'camera', kind: 'overview' },
  ]);
  await expect
    .poll(async () => Number((await viewer.getAttribute('data-frame'))!.split(',')[4]))
    .toBe(0.5);
  await send([
    { type: 'cutaway', height: null },
    { type: 'camera', kind: 'overview' },
  ]);
  await expect
    .poll(async () => Number((await viewer.getAttribute('data-frame'))!.split(',')[4]))
    .toBeGreaterThan(0.5);
  await send([
    { type: 'space', spaceId: 'not-authorized' },
    { type: 'mode', value: 'raw' },
  ]);
  await expect(page.getByText('无法打开该空间，请先在空间列表中核对访问权限。')).toBeVisible();
  await expect(viewer).toHaveAttribute('data-mode', 'optimized');
  failed = true;
  await send([{ type: 'mode', value: 'raw' }]);
  await expect(
    page.getByText('NyxAgent 本轮执行失败，请核对已完成的操作后开始新的 NyxAgent 对话。'),
  ).toBeVisible();
  await expect(viewer).toHaveAttribute('data-mode', 'optimized');
  expect(writes[0]).toMatchObject({
    instructionsVersion: 4,
    viewerContext: {
      spaces: [
        { id: 'demo-lobby', name: '前厅' },
        { id: 'demo-second', name: '第二空间' },
      ],
    },
  });
  expect(await page.locator('body').innerText()).not.toContain('metaverse-view');
  await page.unrouteAll({ behavior: 'wait' });
});

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
