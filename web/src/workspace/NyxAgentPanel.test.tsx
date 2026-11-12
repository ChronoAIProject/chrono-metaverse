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
  expect(writes[0]).toMatchObject({ spaceId: 'lobby', instruction: '添加欢迎牌' });
  expect(writes[0]).not.toHaveProperty('conversationId');
  await userEvent.type(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' }), '改成蓝色');
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({ instruction: '改成蓝色', conversationId: 'conv_test' });
  expect(writes[1]!.idempotencyKey).not.toBe(writes[0]!.idempotencyKey);
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
});

it('断流后刷新只恢复本地状态，用户恢复时重发完全相同的请求', async () => {
  const writes: string[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/key/check')) return Response.json(identity);
    if (String(url).endsWith('/message')) {
      writes.push(String(init?.body));
      return sse(writes.length > 1);
    }
    throw new Error(`unexpected ${url}`);
  });
  const props = { session, space, request, onPreview: vi.fn(), onBusy: vi.fn() };
  const view = render(<NyxAgentPanel {...props} />);
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  await userEvent.type(screen.getByRole('textbox', { name: '给 NyxAgent 发消息' }), '添加欢迎牌');
  await userEvent.click(screen.getByRole('button', { name: '发送给 NyxAgent' }));
  await screen.findByRole('button', { name: '核对 NyxAgent 结果' });
  expect(writes).toHaveLength(1);
  const pending = readNyxagentNote('alice', 'lobby').pending;
  expect(pending?.responseId).toBe('resp_test');
  expect(pending?.body).not.toHaveProperty('conversationId');
  view.unmount();
  render(<NyxAgentPanel {...props} />);
  await screen.findByText('已连接 NyxAgent · NyxAgent');
  expect(writes).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: '恢复 NyxAgent 原请求' }));
  await screen.findByText('草稿预览 /preview#t=safe-preview-token');
  expect(writes).toEqual([writes[0], writes[0]]);
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
  expect(screen.getByRole('button', { name: '恢复 NyxAgent 原请求' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '核对 NyxAgent 结果' })).toBeDisabled();
  expect(request).toHaveBeenCalledTimes(1);
});
