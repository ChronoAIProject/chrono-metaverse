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
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByRole('link', { name: '打开在线工作台' }).click();
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  const enable = page.getByRole('button', { name: '同意并启用' });
  await expect(enable).toBeDisabled();
  expect(writes).toEqual([]);
  await page.getByRole('checkbox', { name: /允许此浏览器/ }).check();
  await enable.click();
  await page.getByRole('button', { name: '选择空间', exact: true }).click();
  await page.getByRole('button', { name: /演示前厅/ }).click();
  if (await page.getByRole('button', { name: '打开 CMA 聊天' }).isVisible())
    await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  await expect(page.locator('.workspace__scene .viewer[data-ready="true"]')).toBeVisible();
  const stage = await page.locator('.workspace__stage').boundingBox();
  const scene = await page.locator('.workspace__scene').boundingBox();
  const chat = await page.getByRole('dialog', { name: 'CMA 空间聊天' }).boundingBox();
  expect(chat!.x).toBeGreaterThanOrEqual(scene!.x + scene!.width);
  expect(scene!.width).toBeGreaterThanOrEqual(850);
  expect(stage!.width).toBe(1280);
  expect(scene!.width + chat!.width).toBe(1280);
  expect(chat!.x + chat!.width).toBeLessThanOrEqual(1280);
  expect(chat!.y + chat!.height).toBeLessThanOrEqual(720);
  await page.getByRole('button', { name: '收起 CMA 聊天' }).click();
  await expect(page.getByRole('dialog', { name: 'CMA 空间聊天' })).toBeHidden();
  expect((await page.locator('.workspace__scene').boundingBox())!.width).toBe(1280);
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
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
  await page.getByRole('button', { name: '选择空间', exact: true }).click();
  await page.getByRole('button', { name: /演示前厅/ }).click();
  if (await page.getByRole('button', { name: '打开 CMA 聊天' }).isVisible())
    await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
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
  const canvasArea = await page.locator('.workspace__scene .viewer').boundingBox();
  expect(canvasArea!.height).toBeGreaterThan(80);
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
});

for (const loseUpload of [false, true])
  test(`创建模型：${loseUpload ? '上传断网后刷新并恢复原文件和请求' : '只上传文件也能启动，自动提交同一 worker'}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const bytes = Buffer.from('glTF\u0002\u0000\u0000\u0000');
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const writes: { action: string; body: Record<string, unknown> }[] = [];
    let uploads = 0;
    const uploadKeys: string[] = [];
    await page.route('**/api/auth/nyxid/**', async (route) => {
      const url = new URL(route.request().url());
      const action = url.pathname.split('/').at(-1)!;
      if (action === 'session')
        return route.fulfill({
          json: {
            enabled: true,
            connected: true,
            subject: 'owner-model',
            csrfToken: 'csrf-model',
            workerAvailable: true,
            workerEnabled: true,
          },
        });
      if (action === 'spaces')
        return route.fulfill({ json: { items: [], organizations: [], next: null } });
      expect(route.request().headers()['x-csrf-token']).toBe('csrf-model');
      if (action === 'attachment') {
        uploads++;
        expect(url.searchParams.get('agentId')).toBe('agt_model');
        expect(url.searchParams.get('name')).toBe('room.glb');
        expect(route.request().headers()['idempotency-key']).toBeTruthy();
        uploadKeys.push(route.request().headers()['idempotency-key']!);
        if (loseUpload && uploads === 1) return route.abort('failed');
        expect(route.request().postDataBuffer()).toEqual(bytes);
        return route.fulfill({
          status: 201,
          json: {
            id: 'att_model',
            agent_id: 'agt_model',
            name: 'room.glb',
            path: '/home/attachments/agt_model/att_model/room.glb',
            size_bytes: bytes.length,
            media_type: 'model/gltf-binary',
            sha256: sha,
          },
        });
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (['create', 'message'].includes(action)) writes.push({ action, body });
      if (action === 'create')
        return route.fulfill({ status: 202, json: { id: 'op_model', status: 'pending' } });
      if (action === 'observe' && body.operationId)
        return route.fulfill({
          json: {
            operation: {
              id: 'op_model',
              status: 'succeeded',
              phase: 'ready',
              agent_id: 'agt_model',
            },
          },
        });
      if (action === 'observe')
        return route.fulfill({
          json: { agent: { id: 'agt_model', status: 'ready' }, transcript: { turns: [] } },
        });
      if (action === 'message')
        return route.fulfill({
          status: 202,
          json: { responseId: 'resp_model', commandId: 'cmd_model' },
        });
      if (action === 'response')
        return route.fulfill({
          json: {
            response: { status: 'in_progress', output: [] },
            controls: { target_active: false, agent_revision: 2 },
          },
        });
      return route.abort();
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '创建空间', exact: true }).click();
    await page
      .getByLabel('选择模型文件')
      .setInputFiles({ name: 'room.glb', mimeType: 'model/gltf-binary', buffer: bytes });
    await expect(page.getByText(/room.glb ·/)).toBeVisible();
    await expect(page.getByLabel('给空间发消息')).toHaveValue('');
    await expect(page.getByRole('button', { name: '开始创建' })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath('create-model-13-inch.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '开始创建' }).click();
    if (loseUpload) {
      await expect(page.getByRole('button', { name: '重试原请求' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('button', { name: '重试原请求' })).toBeVisible();
      expect(uploads).toBe(1);
      expect(writes.filter((w) => w.action === 'create')).toHaveLength(1);
      await page
        .getByLabel('选择模型文件')
        .setInputFiles({ name: 'room.glb', mimeType: 'model/gltf-binary', buffer: bytes });
      await page.getByRole('button', { name: '重试原请求' }).click();
    }
    await expect.poll(() => writes.filter((w) => w.action === 'message').length).toBe(1);
    expect(uploads).toBe(loseUpload ? 2 : 1);
    expect(new Set(uploadKeys).size).toBe(1);
    const prepared = writes.find((w) => w.action === 'create')!.body;
    expect(prepared.prepareOnly).toBe(true);
    expect(prepared.context).toMatchObject({
      spaceId: expect.stringMatching(/^space-/),
      creation: { source: { kind: 'file', name: 'room.glb', sha256: sha } },
    });
    const submitted = writes.find((w) => w.action === 'message')!.body;
    expect(submitted.agentId).toBe('agt_model');
    expect(submitted.context).toMatchObject({
      creation: { source: { attachment: { id: 'att_model', sha256: sha } } },
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  });

test('恢复旧任务：手机直接看到沙箱阶段的授权阻塞', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'metaverse-worker:startup-owner',
      JSON.stringify({
        spaceId: 'fixture-space',
        orgId: '',
        instruction: '',
        operationId: 'op_waiting',
      }),
    ),
  );
  await page.route('**/api/auth/nyxid/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/session'))
      return route.fulfill({
        json: {
          enabled: true,
          connected: true,
          subject: 'startup-owner',
          csrfToken: 'fixture',
          workerAvailable: true,
          workerEnabled: true,
        },
      });
    if (path.endsWith('/spaces'))
      return route.fulfill({ json: { items: [], organizations: [], next: null } });
    if (path.endsWith('/observe'))
      return route.fulfill({
        json: {
          operation: {
            id: 'op_waiting',
            status: 'waiting_for_connection',
            phase: 'sandbox_ready',
            connection: { services: ['chrono-metaverse'], target: {} },
            events: [],
          },
        },
      });
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开 CMA 聊天' }).click();
  const scene = await page.locator('.workspace__scene').boundingBox();
  const chat = await page.getByRole('dialog', { name: 'CMA 空间聊天' }).boundingBox();
  expect(scene!.y + scene!.height).toBeLessThanOrEqual(chat!.y);
  expect(scene!.height).toBeGreaterThanOrEqual(120);
  await page.getByText('需要完成 CMA 服务授权', { exact: true }).waitFor();
  await expect(page.getByText('需要完成 CMA 服务授权', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '刷新启动进度' })).toBeInViewport();
  await page.getByText('准备任务', { exact: false }).first().scrollIntoViewIfNeeded();
  await expect(page.getByText('准备任务', { exact: false }).first()).toBeInViewport();
  await expect(page.getByRole('heading', { name: '你想怎样调整这个空间？' })).toHaveCount(0);
});
