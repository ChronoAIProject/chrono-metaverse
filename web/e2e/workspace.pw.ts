import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/public/{chunks,assets}/**', async (route) => {
    const response = await route.fetch({
      headers: {
        ...route.request().headers(),
        Authorization: 'Share fixture-share-token-0123456789abcdef',
      },
    });
    await route.fulfill({ response });
  });
});

test('在线工作台：明确授权、创建 worker、查看结果并确认发布', async ({ page }, testInfo) => {
  let enabled = false;
  let firstInstruction = '';
  let followUp = false;
  const writes: { action: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/view/')) {
      expect(route.request().headers()['x-csrf-token']).toBe('private-csrf');
      const source = new URL(route.request().url());
      source.pathname = source.pathname.replace('/api/auth/nyxid/view', '/api/public');
      const response = await route.fetch({
        url: source.href,
        method: 'GET',
        headers: { Authorization: 'Share fixture-share-token-0123456789abcdef' },
      });
      return route.fulfill({ response });
    }
    const action = path.split('/').at(-1)!;
    if (action === 'spaces')
      return route.fulfill({
        json: {
          items: [
            {
              id: 'demo-lobby',
              name: '演示前厅',
              description: '已有的组织空间',
              owner: { kind: 'org', id: 'org-one' },
              visibility: 'unlisted',
              access: 'manage',
              updatedAt: '2026-11-11T00:00:00Z',
            },
          ],
          organizations: [{ id: 'org-one', name: 'ChronoAI', role: 'admin' }],
          next: null,
        },
      });
    if (action === 'session')
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'web-owner',
          csrfToken: 'private-csrf',
          workerAvailable: true,
          workerEnabled: enabled,
        },
      });
    expect(route.request().headers()['x-csrf-token']).toBe('private-csrf');
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (['create', 'message', 'consent'].includes(action)) writes.push({ action, body });
    if (action === 'consent') {
      enabled = body.enabled === true;
      return route.fulfill({ json: { workerEnabled: enabled } });
    }
    if (action === 'create') {
      firstInstruction = String(body.instruction);
      return route.fulfill({ status: 202, json: { id: 'op_online', status: 'pending' } });
    }
    if (action === 'observe' && body.operationId)
      return route.fulfill({
        json: {
          operation: {
            id: 'op_online',
            status: 'succeeded',
            phase: 'ready',
            agent_id: 'agt_online',
          },
        },
      });
    if (action === 'observe')
      return route.fulfill({
        json: {
          agent: { id: 'agt_online', status: 'ready' },
          transcript: {
            turns: [
              {
                turn_sequence: 1,
                owner_message: firstInstruction,
                outcome: 'completed',
                messages: [
                  {
                    sequence: 2,
                    role: 'assistant',
                    content: `已建立草稿并核对预览，请查看：${new URL(route.request().url()).origin}/preview#t=web-preview-token`,
                  },
                ],
              },
            ],
          },
        },
      });
    if (action === 'message') {
      if (String(body.instruction) === '暖色一些') followUp = true;
      return route.fulfill({
        status: 202,
        json: { responseId: 'resp_online', commandId: 'cmd_online' },
      });
    }
    if (action === 'response')
      return route.fulfill({
        json: {
          response: {
            status: 'completed',
            output: followUp
              ? [
                  {
                    id: 'msg_live',
                    type: 'message',
                    role: 'assistant',
                    content: [
                      {
                        type: 'output_text',
                        text: '已调整为暖色，新的草稿 /preview#t=web-preview-next',
                      },
                    ],
                  },
                ]
              : [],
          },
          controls: { target_active: false, agent_revision: 5 },
        },
      });
    await route.abort();
  });
  await page.route('**/api/public/previews', (route) =>
    route.fulfill({
      json: {
        spaceId: 'demo-lobby',
        preview: { draftId: 'draft_online', rev: 3, baseSeq: 1, scope: 'physical' },
      },
    }),
  );
  await page.route('**/preview', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body>三维预览夹具</body></html>' }),
  );
  await page.goto('/');
  await page.getByRole('link', { name: '打开在线工作台' }).click();
  const enable = page.getByRole('button', { name: '同意并启用' });
  await expect(enable).toBeDisabled();
  expect(writes).toEqual([]);
  await page.getByRole('checkbox', { name: /允许此浏览器/ }).check();
  await enable.click();
  await page.getByRole('button', { name: /演示前厅/ }).click();
  await expect(page.locator('.workspace__scene .viewer[data-ready="true"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('existing-space-desktop.png'),
    fullPage: true,
  });
  await page.getByLabel('给空间发消息').fill('在入口建一个欢迎区，先给我预览。');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText(/已建立草稿并核对预览/)).toBeVisible();
  // New drafts open automatically, without clicking a result link.
  await expect(page.getByTitle('三维空间预览')).toHaveAttribute(
    'src',
    '/preview#t=web-preview-token',
  );
  await expect(page.getByRole('button', { name: '请 worker 发布此草稿' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('workspace-desktop.png'), fullPage: true });
  await page.getByLabel('给空间发消息').fill('暖色一些');
  await page.getByLabel('给空间发消息').press('Enter');
  await expect(page.getByText(/已调整为暖色/)).toBeVisible();
  await expect(page.getByTitle('三维空间预览')).toHaveAttribute(
    'src',
    '/preview#t=web-preview-next',
  );
  await expect(page.getByRole('checkbox', { name: /我已查看预览/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /我已查看预览/ }).check();
  await page.getByRole('button', { name: '请 worker 发布此草稿' }).click();
  await expect.poll(() => writes.filter((w) => w.action === 'message').length).toBe(2);
  expect(writes.filter((w) => w.action === 'message').at(-1)?.body.instruction).toContain(
    'draft_online',
  );
  expect(writes.filter((w) => w.action === 'create')).toHaveLength(1);
  expect(await page.locator('body').innerText()).not.toContain('private-csrf');
});

test('手机端：创建回复丢失后刷新页面，恢复原请求不会重复建任务', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const requests: unknown[] = [];
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/view/')) {
      expect(route.request().headers()['x-csrf-token']).toBe('private-csrf');
      const source = new URL(route.request().url());
      source.pathname = source.pathname.replace('/api/auth/nyxid/view', '/api/public');
      const response = await route.fetch({
        url: source.href,
        method: 'GET',
        headers: { Authorization: 'Share fixture-share-token-0123456789abcdef' },
      });
      return route.fulfill({ response });
    }
    const action = path.split('/').at(-1)!;
    if (action === 'spaces')
      return route.fulfill({
        json: {
          items: [
            {
              id: 'demo-lobby',
              name: '演示前厅',
              description: '已有的组织空间',
              owner: { kind: 'org', id: 'org-one' },
              visibility: 'unlisted',
              access: 'manage',
              updatedAt: '2026-11-11T00:00:00Z',
            },
          ],
          organizations: [{ id: 'org-one', name: 'ChronoAI', role: 'admin' }],
          next: null,
        },
      });
    if (action === 'session')
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'web-owner',
          csrfToken: 'private-csrf',
          workerAvailable: true,
          workerEnabled: true,
        },
      });
    if (action === 'create') {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) return route.abort('failed');
      return route.fulfill({ status: 202, json: { id: 'op_online', status: 'pending' } });
    }
    if (action === 'observe')
      return route.fulfill({
        json: { operation: { id: 'op_online', status: 'pending', phase: 'preparing' } },
      });
    await route.abort();
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: /演示前厅/ }).click();
  await page.getByLabel('给空间发消息').fill('改成一个可以交流的小广场');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('button', { name: '重试原请求' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '重试原请求' })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: '重试原请求' }).click();
  await expect(page.getByText(/正在准备在线 worker/)).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
});
