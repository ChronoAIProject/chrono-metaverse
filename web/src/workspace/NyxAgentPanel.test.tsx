import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { saveBrowserKey } from '../auth/browserKey';
import { NyxAgentPanel } from './NyxAgentPanel';
import { readNyxagentNote, saveNyxagentNote } from './nyxagent';
import type { SpaceSummary } from './client';

const session = { enabled: true, connected: true, subject: 'alice', csrfToken: 'csrf' };
const identity = {
  keyId: 'nyx-key',
  name: 'NyxAgent',
  credentialId: 'child',
  credentialVersion: 'v'.repeat(43),
  credentialExpiresAt: null,
  keyExpiresAt: null,
};
const space: SpaceSummary = {
  id: 'lobby',
  name: '前厅',
  description: '',
  owner: { kind: 'person', id: 'alice' },
  visibility: 'private',
  access: 'manage',
  updatedAt: '',
};
function sse(complete = true) {
  const response = {
    id: 'resp_test',
    conversation: { id: 'conv_test' },
    status: 'in_progress',
    output: [],
  };
  return new Response(
    `data: ${JSON.stringify({ type: 'response.created', response })}\n\n` +
      (complete
        ? `data: ${JSON.stringify({ type: 'response.completed', response: { ...response, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '草稿预览 /preview#t=safe-preview-token' }] }] } })}\n\n`
        : ''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  saveBrowserKey('alice', 'nyx_test_nyxagent_browser_credential', identity, 'alice', 'nyxagent');
});

it('从工作台发送、显示完成预览，再用同一个会话续聊', async () => {
  const writes: Record<string, unknown>[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message')) {
      writes.push(JSON.parse(String(init?.body)));
      return sse();
    }
    throw new Error(`unexpected ${url}`);
  });
  const preview = vi.fn();
  const onBusy = vi.fn();
  render(
    <NyxAgentPanel
      session={session}
      space={space}
      request={request}
      onPreview={preview}
      onBusy={onBusy}
    />,
  );
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  await userEvent.type(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' }), '添加欢迎牌');
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await screen.findByText('草稿预览 /preview#t=safe-preview-token');
  expect(preview).toHaveBeenCalledWith('/preview#t=safe-preview-token');
  expect(readNyxagentNote('alice', 'lobby').pending).toBeUndefined();
  expect(writes[0]).toMatchObject({
    spaceId: 'lobby',
    instruction: '添加欢迎牌',
    instructionsVersion: 3,
  });
  expect(writes[0]).not.toHaveProperty('conversationId');
  await userEvent.type(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' }), '改成蓝色');
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({ instruction: '改成蓝色', conversationId: 'conv_test' });
  expect(writes[1]!.idempotencyKey).not.toBe(writes[0]!.idempotencyKey);
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
});

it('断流后刷新只恢复本地状态，自动只读取原结果，不重复执行', async () => {
  const writes: string[] = [];
  let reads = 0;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message')) {
      writes.push(String(init?.body));
      return sse(writes.length > 1);
    }
    if (String(url).endsWith('/response')) {
      reads++;
      return Response.json({
        id: 'resp_test',
        conversation: { id: 'conv_test' },
        status: reads === 1 ? 'in_progress' : 'completed',
        output:
          reads === 1
            ? []
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: '原请求已完成' }],
                },
              ],
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  const props = { session, space, request, onPreview: vi.fn(), onBusy: vi.fn() };
  const view = render(<NyxAgentPanel {...props} />);
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  await userEvent.type(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' }), '添加欢迎牌');
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await screen.findByRole('button', { name: '查看任务进度' });
  expect(writes).toHaveLength(1);
  const pending = readNyxagentNote('alice', 'lobby').pending;
  expect(pending?.responseId).toBe('resp_test');
  expect(pending?.body.instructionsVersion).toBe(3);
  expect(pending?.body).not.toHaveProperty('conversationId');
  view.unmount();
  render(<NyxAgentPanel {...props} />);
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  expect(writes).toHaveLength(1);
  await screen.findByText('原请求已完成', {}, { timeout: 3000 });
  expect(writes).toHaveLength(1);
  expect(reads).toBe(2);
});

it('任务示例只填写输入框，发布必须确认具体预览，取消确认不会发送', async () => {
  const writes: Record<string, unknown>[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message')) {
      writes.push(JSON.parse(String(init?.body)));
      return sse();
    }
    throw new Error(`unexpected ${url}`);
  });
  const preview = vi.fn();
  render(
    <NyxAgentPanel
      session={session}
      space={space}
      request={request}
      onPreview={preview}
      onBusy={vi.fn()}
    />,
  );
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  await userEvent.click(screen.getByRole('button', { name: '看看这个空间里有什么' }));
  const input = screen.getByRole('textbox', { name: '给 NyxAgent 发消息' });
  expect(input).toHaveValue('看看这个空间里有什么');
  expect(input).toHaveFocus();
  expect(writes).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await screen.findByRole('button', { name: '查看草稿预览' });
  await userEvent.click(screen.getByRole('button', { name: '发布这个草稿…' }));
  expect(writes).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: '暂不发布' }));
  expect(writes).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: '发布这个草稿…' }));
  await userEvent.click(screen.getByRole('button', { name: '确认发布此预览' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({
    conversationId: 'conv_test',
    instruction: '我已查看并确认发布这个草稿预览：/preview#t=safe-preview-token',
  });
});

it('换 Key 后不能恢复旧请求，也不会自动创建任务', async () => {
  saveNyxagentNote('alice', 'lobby', {
    instruction: '',
    messages: [],
    pending: {
      credentialVersion: 'x'.repeat(43),
      responseId: 'resp_old',
      body: { spaceId: 'lobby', instruction: '原请求', idempotencyKey: 'stable-old-request-001' },
    },
  });
  const request = vi.fn<typeof fetch>(async () => Response.json(identity));
  render(
    <NyxAgentPanel
      session={session}
      space={space}
      request={request}
      onPreview={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  expect(screen.queryByRole('button', { name: '继续这次任务' })).toBeNull();
  expect(screen.getByRole('button', { name: '查看任务进度' })).toBeDisabled();
  expect(request).toHaveBeenCalledTimes(1);
});

it('组织归属加载后通知工作台打开待恢复对话，没有响应编号时不自动发送', async () => {
  const pending = {
    credentialVersion: identity.credentialVersion,
    body: {
      spaceId: 'lobby',
      orgId: 'team',
      instruction: '原组织空间请求',
      idempotencyKey: 'stable-org-request-001',
    },
  };
  saveNyxagentNote('alice', 'lobby', { instruction: '', messages: [], pending });
  const request = vi.fn<typeof fetch>(async () => Response.json(identity));
  const onRestore = vi.fn();
  render(
    <NyxAgentPanel
      session={session}
      space={{ ...space, owner: { kind: 'org', id: 'team' } }}
      request={request}
      onPreview={vi.fn()}
      onBusy={vi.fn()}
      onRestore={onRestore}
    />,
  );
  await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  expect(readNyxagentNote('alice', 'lobby', 'team').pending).toEqual(pending);
  expect(request.mock.calls.every(([url]) => String(url).endsWith('/key/check'))).toBe(true);
  expect(screen.getByRole('button', { name: '继续这次任务' })).toBeEnabled();
});

it('升级后恢复旧待确认请求，不补写新协议版本', async () => {
  const body = {
    spaceId: 'lobby',
    instruction: '旧版未完成的修改',
    idempotencyKey: 'stable-legacy-request-001',
  };
  saveNyxagentNote('alice', 'lobby', {
    instruction: '',
    messages: [],
    pending: { body, credentialVersion: identity.credentialVersion },
  });
  const writes: string[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message')) {
      writes.push(String(init?.body));
      return sse();
    }
    throw new Error(`unexpected ${url}`);
  });
  render(
    <NyxAgentPanel
      session={session}
      space={space}
      request={request}
      onPreview={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  expect(writes).toEqual([]);
  await userEvent.click(screen.getByRole('button', { name: '继续这次任务' }));
  await screen.findByText('草稿预览 /preview#t=safe-preview-token');
  expect(writes).toEqual([JSON.stringify(body)]);
});

it('主动中断显示可操作的提示，并保留响应与原请求', async () => {
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message')) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_test', conversation: { id: 'conv_test' } } })}\n\n`,
              ),
            );
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('BodyStreamBuffer was aborted', 'AbortError')),
            );
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    throw new Error(`unexpected ${url}`);
  });
  render(
    <NyxAgentPanel
      session={session}
      space={space}
      request={request}
      onPreview={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  await userEvent.type(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' }), '修改立方体');
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await waitFor(() =>
    expect(readNyxagentNote('alice', 'lobby').pending?.responseId).toBe('resp_test'),
  );
  await userEvent.click(screen.getByRole('button', { name: '停止等待' }));
  await screen.findByText('连接已中断，操作结果尚未确认。请先核对结果，避免重复操作。');
  expect(screen.queryByText('BodyStreamBuffer was aborted')).toBeNull();
  expect(readNyxagentNote('alice', 'lobby').pending?.body.instruction).toBe('修改立方体');
  expect(screen.getByRole('button', { name: '查看任务进度' })).toBeEnabled();
});

it('失败终态完成核对，保留会话并指引开始新对话', async () => {
  const request = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message'))
      return new Response(
        `data: ${JSON.stringify({ type: 'response.failed', response: { id: 'resp_test', conversation: { id: 'conv_test' }, status: 'failed', output: [] } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    throw new Error(`unexpected ${url}`);
  });
  render(
    <NyxAgentPanel
      session={session}
      space={space}
      request={request}
      onPreview={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  await userEvent.type(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' }), '修改立方体');
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await screen.findByText('NyxAgent 本轮执行失败，请核对已完成的操作后开始新的 NyxAgent 对话。');
  expect(readNyxagentNote('alice', 'lobby').pending).toBeUndefined();
  expect(readNyxagentNote('alice', 'lobby').conversationId).toBe('conv_test');
  expect(screen.getByRole('button', { name: '开始新的 NyxAgent 对话' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' })).toBeDisabled();
  expect(readNyxagentNote('alice', 'lobby').recoveryRequired).toBe(true);
});

it('原会话无法恢复时持久保存核对状态，不再提供无效重试或续聊', async () => {
  saveNyxagentNote('alice', 'lobby', {
    instruction: '',
    messages: [],
    pending: {
      credentialVersion: identity.credentialVersion,
      body: {
        spaceId: 'lobby',
        instruction: '原请求',
        idempotencyKey: 'stable-unknown-request-001',
      },
    },
  });
  const writes = vi.fn();
  const request = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message')) {
      writes();
      return Response.json(
        { code: 'nyxagent_recovery_required', detail: '原会话无法继续执行' },
        { status: 409 },
      );
    }
    throw new Error(`unexpected ${url}`);
  });
  const props = { session, space, request, onPreview: vi.fn(), onBusy: vi.fn() };
  const view = render(<NyxAgentPanel {...props} />);
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  await userEvent.click(screen.getByRole('button', { name: '继续这次任务' }));
  await screen.findByText('需要核对已执行的操作');
  expect(screen.queryByRole('button', { name: '继续这次任务' })).toBeNull();
  expect(readNyxagentNote('alice', 'lobby').pending?.body.idempotencyKey).toBe(
    'stable-unknown-request-001',
  );
  view.unmount();
  render(<NyxAgentPanel {...props} />);
  await screen.findByText('需要核对已执行的操作');
  expect(writes).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: '开始新的 NyxAgent 对话' }));
  await userEvent.click(screen.getByRole('button', { name: '确认开始新的 NyxAgent 对话' }));
  expect(readNyxagentNote('alice', 'lobby').recoveryRequired).toBeUndefined();
  expect(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' })).toBeEnabled();
});
