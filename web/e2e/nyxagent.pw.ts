import { expect, test, type Page } from '@playwright/test';

const relay = 'https://nyx-assistant-sdk-staging-chronoai.apps.nyxid.ai';
const services = ['llm-nyx', 'chrono-llm-public', 'chrono-metaverse'];
const sdkIdentity = {
  credential_id: 'child',
  api_key: {
    id: 'parent',
    owner_id: 'owner',
    owner_type: 'personal',
    scopes: 'proxy',
    allow_all_services: false,
    allow_auto_connected_services: false,
    allow_all_nodes: false,
    allowed_node_ids: [],
    allowed_service_ids: services,
    effective_services: services.map((slug) => ({
      id: slug,
      slug,
      catalog_service_slug: slug === 'chrono-metaverse' ? null : slug,
      is_active: true,
    })),
  },
};
async function verifyGrant(page: Page) {
  await page.route(relay + '/api/v1/auth/agent-key/self', (route) => {
    expect(route.request().headers().authorization).toMatch(/^Bearer nyx_/);
    return route.fulfill({ json: sdkIdentity });
  });
}
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
  }, identity);
  let nextActions: unknown[] = [];
  let turn = 0;
  let failed = false;
  let readAndFocus = false;
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
    throw new Error(`未预期的工作台调用 ${url.pathname}`);
  });
  await verifyGrant(page);
  await page.route(relay + '/api/v1/proxy/s/llm-nyx/v1/responses', async (route) => {
    const body = JSON.parse(route.request().postDataJSON().input);
    writes.push(body);
    turn++;
    const call = (name: string, args: unknown) =>
      '```nyx-host-call\n' +
      JSON.stringify({ requestId: body.requestId, name, arguments: args }) +
      '\n```';
    let text =
      body.input.type === 'user'
        ? call('set_view', { actions: nextActions })
        : body.input.result?.ok === false
          ? body.input.result.message
          : '页面已收到操作。';
    if (readAndFocus) {
      if (body.input.type === 'user') text = call('read_selection', {});
      else if (body.input.name === 'read_selection')
        text = call('focus_selection', body.input.result.value);
      else text = JSON.stringify(body.input.result);
    }
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
  await page.getByRole('button', { name: 'Nyx 助手', exact: true }).click();
  await expect(page.getByRole('button', { name: '断开授权' })).toBeVisible();
  const viewer = page.locator('.workspace__scene .viewer');
  const ready = async () => {
    await expect(viewer).toHaveAttribute('data-ready', 'true');
    await expect(viewer).toHaveAttribute('data-models-pending', '0');
    await expect(viewer).toHaveAttribute('data-textures-pending', '0');
  };
  await ready();
  const canvas = await viewer.locator('canvas').first().elementHandle();
  async function send(actions: { type: string; [key: string]: unknown }[]) {
    nextActions = actions;
    const launcher = page.getByRole('button', { name: 'Nyx 助手', exact: true });
    if ((await launcher.getAttribute('aria-expanded')) === 'false') await launcher.click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(`页面请求 ${turn + 1}`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    if (
      actions[0]?.type === 'space' &&
      ['demo-second', 'demo-lobby'].includes(String(actions[0].spaceId))
    ) {
      await expect(page.locator('nyx-assistant')).toHaveAttribute(
        'data-session',
        String(actions[0].spaceId),
      );
    } else if (!failed)
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
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
  await expect(viewer).toHaveAttribute('data-camera-command', /^[a-f0-9-]{36}$/);
  await ready();
  await expect(page.getByRole('complementary', { name: '物件信息' })).toContainText('desk-01');
  const count = downloads.length;
  await send([{ type: 'preview', url: '/preview#t=page-preview' }]);
  await expect(page.locator('[data-preview="true"]')).toHaveAttribute('data-preview-rev', '1');
  await ready();
  expect(downloads).toHaveLength(count);
  await page.getByRole('button', { name: '选择空间', exact: true }).click();
  await page.getByRole('button', { name: '查看与预览', exact: true }).click();
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
  await expect(viewer).toHaveAttribute('data-camera-command', /^[a-f0-9-]{36}$/);
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
  await send([{ type: 'camera', kind: 'focus', entityId: 'desk-01' }]);
  await expect(page.getByRole('complementary', { name: '物件信息' })).toContainText('desk-01');
  readAndFocus = true;
  const initialWrites = writes.length;
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('读取并聚焦当前选区');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const selected = { spaceId: 'demo-lobby', entityId: 'desk-01' };
  const focused = { ok: true, value: { ...selected, focused: true } };
  await expect(page.getByText(JSON.stringify(focused), { exact: true })).toBeVisible();
  expect(writes).toHaveLength(initialWrites + 3);
  expect(writes[initialWrites + 1]!.input).toMatchObject({
    name: 'read_selection',
    result: { ok: true, value: selected },
  });
  expect(writes[initialWrites + 2]!.input).toMatchObject({
    name: 'focus_selection',
    result: focused,
  });
  readAndFocus = false;
  failed = true;
  await send([{ type: 'mode', value: 'raw' }]);
  await expect(page.getByText('NyxID 报告本次请求失败。')).toBeVisible();
  await expect(viewer).toHaveAttribute('data-mode', 'optimized');
  expect(writes[0]).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ name: 'read_selection' }),
      expect.objectContaining({ name: 'focus_selection' }),
      expect.objectContaining({ name: 'set_view' }),
    ]),
    context: {
      spaces: [
        { id: 'demo-lobby', name: '前厅' },
        { id: 'demo-second', name: '第二空间' },
      ],
    },
  });
  expect(await page.locator('body').innerText()).not.toContain('metaverse-view');
  await page.unrouteAll({ behavior: 'wait' });
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
    throw new Error(`未预期的工作台调用 ${path}`);
  });
  await verifyGrant(page);
  await page.route(relay + '/api/v1/proxy/s/llm-nyx/v1/responses**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/responses')) {
      expect(route.request().headers().authorization).toBe(`Bearer ${key}`);
      writes.push(JSON.parse(route.request().postDataJSON().input));
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
    if (path.endsWith('/responses/resp_second')) {
      expect(route.request().method()).toBe('GET');
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
  await page.goto('/workspace?space=lobby');
  await page.getByRole('button', { name: 'Nyx 助手', exact: true }).click();
  await expect(page.getByRole('button', { name: '断开授权' })).toBeVisible();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('第一条');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('已完成第一轮')).toBeVisible();
  expect(writes[0]).not.toHaveProperty('conversationId');
  expect(writes[0]!.context).toMatchObject({ orgId: 'team' });
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('第二条');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对原请求' })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]!.conversationId).toBe('conv_test');
  await page.reload();
  await page.getByRole('button', { name: 'Nyx 助手', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Nyx 助手' })).toBeVisible();
  await expect(page.getByRole('button', { name: '断开授权' })).toBeVisible();
  expect(writes).toHaveLength(2);
  await expect(page.getByText('已恢复原请求')).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(
    await page.evaluate(() => localStorage.getItem('metaverse-cma-credential:v2:owner:owner')),
  ).toBeNull();
});

async function personalWorkspace(page: Page) {
  await page.route('**/api/auth/nyxid/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'owner',
          csrfToken: 'csrf',
        },
      });
    if (path.endsWith('/spaces'))
      return route.fulfill({
        json: {
          items: [
            {
              id: 'lobby',
              name: '测试空间',
              owner: { kind: 'person', id: 'owner' },
              visibility: 'private',
              access: 'manage',
            },
          ],
          organizations: [],
          next: null,
        },
      });
    if (path.includes('/view/')) return route.fulfill({ status: 404, json: {} });
    throw Error(path);
  });
}

test('空间助手在深浅主题下可读，桌面和手机可展开、收起并访问空间菜单', async ({ page }) => {
  await personalWorkspace(page);
  await page.goto('/workspace?space=lobby');
  const launcher = page.getByRole('button', { name: 'Nyx 助手', exact: true });
  const panel = page.getByRole('dialog', { name: 'Nyx 助手' });
  const connect = panel.getByRole('button', { name: '连接 NyxID' });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => localStorage.setItem('metaverse:appearance', theme), theme);
    await page.reload();
    await launcher.click();
    const ratio = () =>
      connect.evaluate((button) => {
        const luminance = (rgb: string) => {
          const [r, g, b] = rgb
            .match(/[0-9.]+/g)!
            .map((v) => Number(v) / 255)
            .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const { color, backgroundColor } = getComputedStyle(button);
        const a = luminance(color),
          b = luminance(backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    expect(await ratio()).toBeGreaterThanOrEqual(4.5);
    await connect.hover();
    expect(await ratio()).toBeGreaterThanOrEqual(4.5);
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [768, 1024],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      const rect = await panel.boundingBox();
      const header = await page.locator('.workspace__header').boundingBox();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
      await page.getByRole('button', { name: '选择空间', exact: true }).click();
      await page.getByRole('button', { name: '关闭空间菜单' }).click();
      await panel.getByRole('button', { name: '收起助手' }).click();
      await expect(launcher).toHaveAttribute('aria-expanded', 'false');
      await launcher.click();
    }
  }
});
test('在已有工作台连接 NyxID，刷新恢复加密授权，断开后可重新连接', async ({ page }) => {
  await personalWorkspace(page);
  const key = 'nyx_browser_sdk_login_fixture';
  let requested = 0,
    revoked = 0;
  await page.route(relay + '/api/v1/auth/agent-key/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/request')) {
      requested++;
      return route.fulfill({
        json: {
          device_code: 'test-device',
          user_code: 'TEST-1234',
          expires_in: 120,
          interval: 1,
          verification_uri: 'https://nyxid.ai/login/agent-key',
        },
      });
    }
    if (path.endsWith('/poll')) return route.fulfill({ json: { ...sdkIdentity, credential: key } });
    expect(route.request().headers().authorization).toBe('Bearer ' + key);
    if (route.request().method() === 'DELETE') revoked++;
    return route.fulfill({ json: sdkIdentity });
  });
  await page.goto('/workspace?space=lobby');
  await page.getByRole('button', { name: 'Nyx 助手', exact: true }).click();
  await page.getByRole('button', { name: '连接 NyxID', exact: true }).click();
  await expect(page.getByRole('link', { name: '打开 NyxID 授权页' })).toHaveAttribute(
    'href',
    /user_code=TEST-1234/,
  );
  await expect(page.getByRole('button', { name: '断开授权' })).toBeVisible();
  const values = await page.evaluate(() => Object.values(localStorage) as string[]);
  expect(values.some((v) => v.startsWith('nyx-sealed:v1:'))).toBe(true);
  expect(values.join('')).not.toContain(key);
  await page.reload();
  await page.getByRole('button', { name: 'Nyx 助手', exact: true }).click();
  await page.getByRole('button', { name: '断开授权' }).click();
  await expect(page.getByRole('button', { name: '连接 NyxID', exact: true })).toBeVisible();
  expect([requested, revoked]).toEqual([1, 1]);
});
