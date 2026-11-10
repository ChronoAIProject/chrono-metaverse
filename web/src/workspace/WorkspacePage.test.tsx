import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePage } from './WorkspacePage';
import { resultLinks, viewerLink, type Transcript } from './client';

const connected = {
  enabled: true,
  connected: true,
  subject: 'owner-a',
  csrfToken: 'csrf-secret',
  workerAvailable: true,
  workerEnabled: true,
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const transcript: Transcript = {
  turns: [
    {
      turn_sequence: 1,
      owner_message: '建欢迎区',
      outcome: 'completed',
      messages: [
        {
          sequence: 2,
          role: 'assistant',
          content: `请查看 ${window.location.origin}/preview#t=preview-safe-token\n<script>danger()</script>`,
        },
      ],
    },
  ],
};
function mockApi(options: { enabled?: boolean; loseCreate?: boolean; setup?: boolean } = {}) {
  const writes: { action: string; body: Record<string, unknown> }[] = [];
  let creates = 0;
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === '/api/public/previews')
      return reply({
        spaceId: 'my-lobby',
        preview: { draftId: 'draft_one', rev: 3, baseSeq: 1, scope: 'physical' },
      });
    if (url.endsWith('/session'))
      return reply({ ...connected, workerEnabled: options.enabled ?? true });
    const action = url.split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (['consent', 'create', 'message', 'cancel'].includes(action)) writes.push({ action, body });
    if (action === 'consent') return reply({ workerEnabled: body.enabled });
    if (action === 'create') {
      creates++;
      if (creates === 1 && options.loseCreate) throw new TypeError('lost response');
      if (creates === 1 && options.setup)
        return reply({ code: 'cma_setup_required', detail: '请先登录 CMA 完成运行环境授权' }, 409);
      return reply({ id: 'op_one', status: 'pending' }, 202);
    }
    if (action === 'observe' && body.operationId)
      return reply({
        operation: { id: 'op_one', status: 'succeeded', phase: 'ready', agent_id: 'agt_one' },
      });
    if (action === 'observe')
      return reply({ agent: { id: 'agt_one', status: 'ready' }, transcript });
    if (action === 'message') return reply({ responseId: 'resp_one', commandId: 'cmd_one' }, 202);
    if (action === 'response')
      return reply({
        response: { status: 'completed' },
        controls: { target_active: false, agent_revision: 2 },
      });
    if (action === 'agents')
      return reply({
        items: [{ id: 'agt_one', title: '我的建造 worker', status: 'ready' }],
        next: null,
      });
    throw new Error(`unexpected ${url}`);
  });
  return { request, writes };
}
async function fillTask() {
  await userEvent.type(screen.getByLabelText('目标空间编号'), 'my-lobby');
  await userEvent.type(
    screen.getByLabelText('你想让空间发生什么变化'),
    '在入口建欢迎区，先给我预览',
  );
}
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe('CMA workspace', () => {
  it('requires explicit consent, submits one task, displays safe results and publishes only after confirmation', async () => {
    const api = mockApi({ enabled: false });
    const { container } = render(<WorkspacePage request={api.request} />);
    const enable = await screen.findByRole('button', { name: '同意并启用' });
    expect(enable).toBeDisabled();
    expect(api.writes).toEqual([]);
    await userEvent.click(screen.getByRole('checkbox', { name: /允许此浏览器/ }));
    await userEvent.click(enable);
    await screen.findByRole('button', { name: '创建 worker 并开始' });
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '创建 worker 并开始' }));
    await screen.findByText(/<script>danger/);
    expect(container.querySelector('script')).toBeNull();
    expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '草稿预览 1' }));
    expect(screen.getByTitle('三维空间预览')).toHaveAttribute(
      'src',
      '/preview#t=preview-safe-token',
    );
    const publish = screen.getByRole('button', { name: '请 worker 发布此草稿' });
    expect(publish).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /我已查看预览/ }));
    await userEvent.click(publish);
    await waitFor(() => expect(api.writes.filter((w) => w.action === 'message')).toHaveLength(1));
    const body = api.writes.find((w) => w.action === 'message')!.body;
    expect(body.instruction).toContain('draft_one');
    expect(body.instruction).toContain('rev=3');
    expect(body.instruction).not.toContain('preview-safe-token');
    expect(body.agentId).toBe('agt_one');
    expect(sessionStorage.getItem('metaverse-worker:owner-a')).not.toContain('csrf-secret');
    expect(sessionStorage.getItem('metaverse-worker:owner-a')).not.toContain('preview-safe-token');
  });
  it('recovers an uncertain creation after reload with identical body and key, and never automatically retries writes', async () => {
    const api = mockApi({ loseCreate: true });
    const mounted = render(<WorkspacePage request={api.request} />);
    await screen.findByRole('button', { name: '创建 worker 并开始' });
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '创建 worker 并开始' }));
    await screen.findByRole('button', { name: '重试原请求' });
    expect(api.writes).toHaveLength(1);
    mounted.unmount();
    render(<WorkspacePage request={api.request} />);
    const retry = await screen.findByRole('button', { name: '重试原请求' });
    expect(api.writes).toHaveLength(1);
    await userEvent.click(retry);
    await screen.findByText(/<script>danger/);
    expect(api.writes).toHaveLength(2);
    expect(api.writes[1]).toEqual(api.writes[0]);
  });
  it('uses a new key only after CMA definitively refuses creation for missing setup', async () => {
    const api = mockApi({ setup: true });
    render(<WorkspacePage request={api.request} />);
    await screen.findByRole('button', { name: '创建 worker 并开始' });
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '创建 worker 并开始' }));
    const retry = await screen.findByRole('button', { name: '已完成授权，重新提交' });
    expect(screen.getByRole('link', { name: '登录 CMA ↗' })).toHaveAttribute(
      'href',
      'https://cma.nyxid.ai/auth/login',
    );
    await userEvent.click(retry);
    await screen.findByText(/<script>danger/);
    const [first, second] = api.writes;
    expect(second!.body.idempotencyKey).not.toBe(first!.body.idempotencyKey);
    expect(second!.body.instruction).toBe(first!.body.instruction);
    expect(second!.body.context).toEqual(first!.body.context);
  });
  it('does not load another user’s task and can explicitly close CMA access without claiming task cancellation', async () => {
    sessionStorage.setItem(
      'metaverse-worker:other-person',
      JSON.stringify({
        spaceId: 'secret-space',
        orgId: '',
        instruction: 'secret-task',
        agentId: 'agt_secret',
      }),
    );
    const api = mockApi();
    render(<WorkspacePage request={api.request} />);
    expect(await screen.findByLabelText('目标空间编号')).toHaveValue('');
    await userEvent.click(screen.getByText('网页授权'));
    await userEvent.click(screen.getByRole('button', { name: '关闭网页 CMA 调用' }));
    await screen.findByText('已关闭网页 CMA 调用。已受理的任务仍在 CMA 中运行。');
    expect(api.writes).toEqual([{ action: 'consent', body: { enabled: false } }]);
  });
});
it('only embeds same-origin viewer routes and extracts links from assistant results', () => {
  for (const url of [
    'javascript:alert(1)',
    'https://evil.test/preview#t=x',
    '/api/auth/nyxid/session',
    '//evil.test/s/lobby',
    '/workspace',
    '/s/a%2fb',
    '/preview?target=other#t=x',
  ])
    expect(viewerLink(url)).toBeNull();
  expect(viewerLink('/s/my-lobby#share=token-safe')).toBe('/s/my-lobby#share=token-safe');
  expect(resultLinks(transcript)).toEqual(['/preview#t=preview-safe-token']);
});
