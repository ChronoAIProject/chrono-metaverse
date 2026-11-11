import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../space/SpacePage', () => ({
  SpacePage: ({ spaceId }: { spaceId: string }) => (
    <div data-testid="private-viewer">{spaceId}</div>
  ),
}));
import { WorkspacePage } from './WorkspacePage';
import { resultLinks, viewerLink, type Transcript, type Operation } from './client';

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
function mockApi(
  options: {
    enabled?: boolean;
    loseCreate?: boolean;
    loseMessage?: boolean;
    setup?: boolean;
    followUp?: boolean;
    operation?: Operation | ((creates: number) => Operation);
    observeFailures?: number;
  } = {},
) {
  const writes: { action: string; body: Record<string, unknown> }[] = [];
  let creates = 0;
  let messages = 0;
  let observeFailures = options.observeFailures ?? 0;
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === '/api/public/previews')
      return reply({
        spaceId: 'my-lobby',
        preview: { draftId: 'draft_one', rev: 3, baseSeq: 1, scope: 'physical' },
      });
    if (url === '/api/auth/nyxid/spaces')
      return reply({
        items: [
          {
            id: 'my-lobby',
            name: '我的前厅',
            description: '',
            owner: { kind: 'org', id: 'org-one' },
            visibility: 'unlisted',
            access: 'manage',
            updatedAt: '2026-11-11T00:00:00Z',
          },
          {
            id: 'my-garden',
            name: '我的花园',
            description: '',
            owner: { kind: 'person', id: 'owner-a' },
            visibility: 'unlisted',
            access: 'manage',
            updatedAt: '2026-11-11T00:00:00Z',
          },
        ],
        organizations: [{ id: 'org-one', name: 'ChronoAI', role: 'admin' }],
        next: null,
      });
    if (url.endsWith('/connection'))
      return reply({
        ready: true,
        ownerId: new Headers(init?.headers).get('x-metaverse-cma-owner') ?? 'owner-a',
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
    if (action === 'observe' && body.operationId) {
      if (observeFailures-- > 0)
        return reply({ code: 'cma_unavailable', detail: 'temporary upstream error' }, 503);
      return reply({
        operation:
          typeof options.operation === 'function'
            ? options.operation(creates)
            : (options.operation ?? {
                id: 'op_one',
                status: 'succeeded',
                phase: 'ready',
                agent_id: 'agt_one',
              }),
      });
    }
    if (action === 'observe')
      return reply({ agent: { id: 'agt_one', status: 'ready' }, transcript });
    if (action === 'message') {
      messages++;
      if (messages === 1 && options.loseMessage)
        return reply(
          { code: 'cma_outcome_unknown', detail: 'CMA 消息回执超时，请保留原编号重试' },
          503,
        );
      return reply({ responseId: 'resp_one', commandId: 'cmd_one' }, 202);
    }
    if (action === 'response')
      return reply({
        response: {
          status: 'completed',
          output:
            options.followUp && messages
              ? [
                  {
                    id: 'msg_live',
                    type: 'message',
                    role: 'assistant',
                    content: [
                      {
                        type: 'output_text',
                        text: '已改为暖色，预览 /preview#t=preview-next-token',
                      },
                    ],
                  },
                ]
              : [],
        },
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
async function selectSpace(name = /我的前厅/) {
  await userEvent.click(await screen.findByRole('button', { name: '选择空间' }));
  await userEvent.click(await screen.findByRole('button', { name }));
}
async function openChat() {
  const launcher = screen.queryByRole('button', { name: '打开 CMA 聊天' });
  if (launcher) await userEvent.click(launcher);
}
async function fillTask() {
  await selectSpace();
  await openChat();
  await userEvent.type(screen.getByLabelText('给空间发消息'), '在入口建欢迎区，先给我预览');
}
beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/workspace');
});
afterEach(cleanup);

describe('CMA workspace', () => {
  it('新标签页直接打开组织空间时，从目录恢复归属并复用 OAuth 授权', async () => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/workspace?space=my-lobby');
    const api = mockApi();
    render(<WorkspacePage request={api.request} />);
    await userEvent.click(await screen.findByRole('button', { name: '打开 CMA 聊天' }));
    await screen.findByText('当前空间使用：ChronoAI的 CMA 连接');
    await screen.findByText('已连接 CMA');
    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem('metaverse-worker:owner-a')!).orgId).toBe('org-one'),
    );
    expect(api.request.mock.calls.some((call) => String(call[0]).endsWith('/key/request'))).toBe(
      false,
    );
    expect(
      api.request.mock.calls.filter((call) => String(call[0]).endsWith('/connection')).at(-1)?.[1]
        ?.headers,
    ).toMatchObject({
      'x-metaverse-cma-owner': 'org-one',
    });
  });
  it('requires explicit consent, submits one task, displays safe results and publishes only after confirmation', async () => {
    const api = mockApi({ enabled: false });
    const { container } = render(<WorkspacePage request={api.request} />);
    await screen.findByRole('button', { name: '选择空间' });
    await openChat();
    const enable = await screen.findByRole('button', { name: '启用 CMA 聊天' });
    expect(api.writes).toEqual([]);
    await userEvent.click(enable);
    await screen.findByRole('button', { name: '选择空间' });
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/<script>danger/);
    expect(container.querySelector('script')).toBeNull();
    expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
    // Latest preview opens automatically.
    expect(screen.getByTitle('三维空间预览')).toHaveAttribute(
      'src',
      '/preview#t=preview-safe-token',
    );
    const publish = screen.getByRole('button', { name: '请 worker 发布此草稿' });
    expect(publish).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/draft_one/)).toBeVisible());
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
  it('lists spaces before consent and opens the authenticated viewer without writes', async () => {
    const api = mockApi({ enabled: false });
    render(<WorkspacePage request={api.request} />);
    await selectSpace();
    await openChat();
    expect(screen.getByTestId('private-viewer')).toHaveTextContent('my-lobby');
    expect(screen.getByLabelText('给空间发消息')).toBeDisabled();
    expect(api.writes).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: '选择空间' }));
    await userEvent.selectOptions(screen.getByLabelText('空间归属'), 'person');
    expect(screen.queryByRole('button', { name: /我的前厅/ })).toBeNull();
    expect(screen.getByRole('button', { name: /我的花园/ })).toBeVisible();
  });
  it('keeps independent conversations and unsent messages for each space', async () => {
    const api = mockApi();
    render(<WorkspacePage request={api.request} />);
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/<script>danger/);
    await userEvent.type(screen.getByLabelText('给空间发消息'), '未发送的追问');
    await selectSpace(/我的花园/);
    expect(screen.getByLabelText('给空间发消息')).toHaveValue('');
    expect(screen.getByTestId('private-viewer')).toHaveTextContent('my-garden');
    expect(screen.queryByText(/<script>danger/)).toBeNull();
    await selectSpace();
    expect(screen.getByLabelText('给空间发消息')).toHaveValue('未发送的追问');
    await screen.findByText(/<script>danger/);
    expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
  });
  it('sends follow-up chat to the same worker, follows the new preview and requires fresh confirmation', async () => {
    const api = mockApi({ followUp: true });
    render(<WorkspacePage request={api.request} />);
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/<script>danger/);
    await waitFor(() => expect(screen.getByText(/draft_one/)).toBeVisible());
    await userEvent.click(screen.getByRole('checkbox', { name: /我已查看预览/ }));
    await userEvent.type(screen.getByLabelText('给空间发消息'), '暖色一些');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/已改为暖色/);
    expect(screen.getByTitle('三维空间预览')).toHaveAttribute(
      'src',
      '/preview#t=preview-next-token',
    );
    expect(screen.getByRole('checkbox', { name: /我已查看预览/ })).not.toBeChecked();
    expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
    expect(api.writes.find((w) => w.action === 'message')!.body.agentId).toBe('agt_one');
    expect(api.writes.find((w) => w.action === 'message')!.body.instruction).toBe('暖色一些');
  });
  it('retains a failed second message and its error across reload, then retries the same worker and request', async () => {
    const api = mockApi({ loseMessage: true, followUp: true });
    const mounted = render(<WorkspacePage request={api.request} />);
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText(/<script>danger/);
    await userEvent.type(screen.getByLabelText('给空间发消息'), '把机器狗挪动到门口');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '重试原请求' });
    const original = api.writes.find((w) => w.action === 'message')!;
    mounted.unmount();
    render(<WorkspacePage request={api.request} />);
    await screen.findByText('上次请求反馈：CMA 消息回执超时，请保留原编号重试');
    await userEvent.click(screen.getByText('请求详情'));
    expect(screen.getByText('操作：发送聊天消息')).toBeVisible();
    expect(screen.getByText(/HTTP 503/)).toBeVisible();
    expect(screen.getByText(String(original.body.idempotencyKey))).toBeVisible();
    expect(api.writes.filter((w) => w.action === 'message')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '重试原请求' }));
    await screen.findByText(/已改为暖色/);
    expect(api.writes.filter((w) => w.action === 'message')).toEqual([original, original]);
    expect(original.body.agentId).toBe('agt_one');
    expect(original.body.instruction).toBe('把机器狗挪动到门口');
    expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
  });
  it('recovers an uncertain creation after reload with identical body and key, and never automatically retries writes', async () => {
    const api = mockApi({ loseCreate: true });
    const mounted = render(<WorkspacePage request={api.request} />);
    await screen.findByRole('button', { name: '选择空间' });
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '重试原请求' });
    expect(api.writes).toHaveLength(1);
    mounted.unmount();
    render(<WorkspacePage request={api.request} />);
    await screen.findByText(/^上次请求反馈：连接中断/);
    await userEvent.click(screen.getByText('请求详情'));
    expect(screen.getByText('操作：准备在线 worker')).toBeVisible();
    expect(screen.getByText('network')).toBeVisible();
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
    await screen.findByRole('button', { name: '选择空间' });
    await fillTask();
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
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
    await screen.findByRole('button', { name: '选择空间' });
    await openChat();
    expect(await screen.findByLabelText('给空间发消息')).toHaveValue('');
    await userEvent.click(screen.getByText('会话与 worker'));
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

it('creates from a Scaniverse link with an automatic space id and selected owner', async () => {
  const api = mockApi();
  render(<WorkspacePage request={api.request} />);
  await userEvent.click(await screen.findByRole('button', { name: '创建空间' }));
  expect(screen.getByRole('dialog', { name: 'CMA 空间聊天' })).toBeVisible();
  expect(screen.queryByLabelText('目标空间编号')).toBeNull();
  expect(screen.queryByTestId('private-viewer')).toBeNull();
  await userEvent.selectOptions(await screen.findByLabelText('空间归属'), 'org-one');
  await userEvent.clear(screen.getByLabelText('空间名称'));
  await userEvent.type(screen.getByLabelText('空间名称'), '我的新家');
  await userEvent.type(
    screen.getByLabelText('给空间发消息'),
    'https://scaniverse.com/scan/abc123 保留家具布局',
  );
  await userEvent.click(screen.getByRole('button', { name: '开始创建' }));
  await waitFor(() => expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1));
  const context = api.writes.find((w) => w.action === 'create')!.body.context as Record<
    string,
    unknown
  >;
  expect(context.spaceId).toMatch(/^space-[0-9a-f]{16}$/);
  expect(context.orgId).toBe('org-one');
  expect(context.creation).toEqual({
    name: '我的新家',
    source: { kind: 'scaniverse', url: 'https://scaniverse.com/scan/abc123' },
  });
});

it('shows the sandbox event state and resumes a connection wait with the original request', async () => {
  const api = mockApi({
    operation: (creates) =>
      creates < 2
        ? {
            id: 'op_one',
            status: 'waiting_for_connection',
            phase: 'sandbox_ready',
            connection: { services: ['chrono-metaverse'], target: { type: 'sandbox_profile' } },
            events: [
              {
                sequence: 1,
                phase: 'sandbox_ready',
                status: 'running',
                message: 'Preparing the Agent Sandbox',
              },
            ],
          }
        : { id: 'op_one', status: 'succeeded', phase: 'ready', agent_id: 'agt_one' },
  });
  render(<WorkspacePage request={api.request} />);
  await fillTask();
  await userEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('需要完成 CMA 服务授权');
  expect(screen.queryByText('正在准备在线 worker')).toBeNull();
  expect(screen.getByText('待授权服务：chrono-metaverse')).toBeVisible();
  await userEvent.click(screen.getByText('启动详情'));
  expect(screen.getByText('Preparing the Agent Sandbox')).toBeVisible();
  expect(screen.getByText('准备沙箱 · 执行中')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '已完成授权，继续原任务' }));
  await screen.findByText(/<script>danger/);
  const creates = api.writes.filter((w) => w.action === 'create');
  expect(creates).toHaveLength(2);
  expect(creates[1]!.body).toEqual(creates[0]!.body);
});

it('retains a failed startup and its agent without treating that agent as ready', async () => {
  const api = mockApi({
    operation: {
      id: 'op_one',
      status: 'failed',
      phase: 'sandbox_ready',
      agent_id: 'agt_not_ready',
      error: 'Sandbox provisioning failed',
    },
  });
  render(<WorkspacePage request={api.request} />);
  await fillTask();
  await userEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('在线 worker 准备未完成');
  expect(screen.getByText('Sandbox provisioning failed')).toBeVisible();
  expect(screen.queryByText('正在准备在线 worker')).toBeNull();
  expect(screen.queryByTitle('三维空间预览')).toBeNull();
  const saved = JSON.parse(sessionStorage.getItem('metaverse-worker:owner-a')!);
  expect(saved.operationId).toBe('op_one');
  expect(saved.agentId).toBeUndefined();
  expect(screen.queryByRole('button', { name: '重新准备 worker' })).toBeNull();
  expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
});

it('recovers from a transient progress read failure without resubmitting creation', async () => {
  const api = mockApi({ observeFailures: 1 });
  render(<WorkspacePage request={api.request} />);
  await fillTask();
  await userEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('暂时无法读取 CMA 进度，正在重新连接。原任务已保留。');
  await screen.findByText(/<script>danger/, {}, { timeout: 3500 });
  expect(screen.queryByText('暂时无法读取 CMA 进度，正在重新连接。原任务已保留。')).toBeNull();
  expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
});

it('only starts a replacement after explicit action when startup failed before allocating an agent', async () => {
  const api = mockApi({
    operation: (creates) =>
      creates < 2
        ? {
            id: 'op_one',
            status: 'failed',
            phase: 'sandbox_ready',
            error: 'Sandbox provisioning failed',
          }
        : { id: 'op_one', status: 'succeeded', phase: 'ready', agent_id: 'agt_one' },
  });
  render(<WorkspacePage request={api.request} />);
  await fillTask();
  await userEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('在线 worker 准备未完成');
  expect(api.writes.filter((w) => w.action === 'create')).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: '重新准备 worker' }));
  await screen.findByText(/<script>danger/);
  const creates = api.writes.filter((w) => w.action === 'create');
  expect(creates).toHaveLength(2);
  expect(creates[1]!.body.idempotencyKey).not.toBe(creates[0]!.body.idempotencyKey);
  expect(creates[1]!.body.instruction).toBe(creates[0]!.body.instruction);
});
