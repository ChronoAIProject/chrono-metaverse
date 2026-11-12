import { beforeEach, expect, it, vi } from 'vitest';
import { saveBrowserKey, clearBrowserKey, readBrowserKey } from '../auth/browserKey';
import { clearEnrollment, readEnrollment, saveEnrollment } from '../auth/browserEnrollment';
import {
  emptyNyxagentNote,
  readNyxagentNote,
  saveNyxagentNote,
  streamNyxagent,
  type NyxagentPending,
  type NyxagentResponse,
} from './nyxagent';

const identity = {
  keyId: 'nyx-key',
  name: 'NyxAgent',
  credentialId: 'child',
  credentialVersion: 'v'.repeat(43),
  credentialExpiresAt: null,
  keyExpiresAt: null,
};
const credential = 'nyx_test_nyxagent_browser_credential';
const pending: NyxagentPending = {
  credentialVersion: identity.credentialVersion,
  body: { spaceId: 'lobby', instruction: '添加欢迎牌', idempotencyKey: 'stable-nyx-request-001' },
};
const session = {
  enabled: true,
  connected: true,
  subject: 'alice',
  csrfToken: 'csrf',
  chatProvider: 'nyxagent' as const,
  cmaAuthMethod: 'agent_key' as const,
};
const completed: NyxagentResponse = {
  id: 'resp_test',
  conversation: { id: 'conv_test' },
  status: 'completed',
  output: [
    {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '草稿已预览' }],
    },
  ],
};
const frame = (type: string, value: object) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...value })}\r\n\r\n`;
function stream(frames: string) {
  const bytes = new TextEncoder().encode(frames);
  return new Response(
    new ReadableStream({
      start(controller) {
        // One-byte chunks also split multi-byte Chinese characters and CRLF pairs.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

it('SSE 分块保留原始 Key、正文、续聊与终态，工具状态及中文增量正常显示', async () => {
  saveBrowserKey('alice', credential, identity, 'alice', 'nyxagent');
  const body = { ...pending.body, conversationId: 'conv_test' };
  const request = vi.fn<typeof fetch>(async () =>
    stream(
      frame('response.created', { response: { ...completed, status: 'in_progress', output: [] } }) +
        frame('response.mcp_call.in_progress', {}) +
        frame('response.output_text.delta', { output_index: 0, delta: '你好' }) +
        frame('response.completed', { response: completed }),
    ),
  );
  const update = vi.fn();
  expect(
    await streamNyxagent(
      session,
      { ...pending, body },
      new AbortController().signal,
      update,
      request,
    ),
  ).toEqual(completed);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    '/api/auth/nyxid/nyxagent/message',
    expect.objectContaining({
      body: JSON.stringify(body),
      credentials: 'same-origin',
      headers: expect.objectContaining({
        Authorization: `Bearer ${credential}`,
        'x-csrf-token': 'csrf',
        'x-metaverse-cma-credential': identity.credentialVersion,
      }),
    }),
  );
  expect(update.mock.calls.some(([v]) => v.text === '你好')).toBe(true);
  expect(update.mock.calls.some(([v]) => v.activity === '正在调用已授权工具…')).toBe(true);
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      responseId: 'resp_test',
      conversationId: 'conv_test',
      text: '草稿已预览',
    }),
  );
});

it('中断或仅 DONE 不能宣称完成，也不会自动重发', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    stream(frame('response.created', { response: completed }) + 'data: [DONE]\n\n'),
  );
  await expect(
    streamNyxagent(session, pending, new AbortController().signal, vi.fn(), request),
  ).rejects.toThrow('结果尚未确认');
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  { ...completed, id: 'resp_other' },
  { ...completed, conversation: { id: 'conv_other' } },
  { ...completed, status: 'in_progress' },
])('不接受终态中的响应、会话或状态错配', async (response) => {
  const request = vi.fn<typeof fetch>(async () =>
    stream(
      frame('response.created', { response: completed }) +
        frame('response.completed', { response }),
    ),
  );
  await expect(
    streamNyxagent(session, pending, new AbortController().signal, vi.fn(), request),
  ).rejects.toThrow();
});

it('恢复请求仍绑定原响应和会话', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    stream(frame('response.completed', { response: completed })),
  );
  await expect(
    streamNyxagent(
      session,
      { ...pending, responseId: 'resp_other' },
      new AbortController().signal,
      vi.fn(),
      request,
    ),
  ).rejects.toThrow('原请求不一致');
  await expect(
    streamNyxagent(
      session,
      { ...pending, body: { ...pending.body, conversationId: 'conv_other' } },
      new AbortController().signal,
      vi.fn(),
      request,
    ),
  ).rejects.toThrow('原请求不一致');
});

it('聊天和未确认请求按账号、空间、组织隔离，不包含凭据且精确保留重试正文', () => {
  const note = {
    instruction: '',
    messages: [{ role: 'user' as const, text: pending.body.instruction }],
    conversationId: 'conv_test',
    pending,
  };
  saveNyxagentNote('alice', 'lobby', note);
  expect(readNyxagentNote('alice', 'lobby')).toEqual(note);
  expect(readNyxagentNote('bob', 'lobby')).toEqual(emptyNyxagentNote());
  expect(readNyxagentNote('alice', 'garden')).toEqual(emptyNyxagentNote());
  expect(readNyxagentNote('alice', 'lobby', 'another-org')).toEqual(emptyNyxagentNote());
  expect(JSON.stringify(note)).not.toContain(credential);
});

it('NyxAgent 与 CMA 的 Key 和待确认授权分别保存和清除', () => {
  saveBrowserKey('alice', 'nyx_test_cma_credential', identity);
  saveBrowserKey('alice', credential, identity, 'alice', 'nyxagent');
  const enrollment = {
    device_code: 'device',
    user_code: 'ABCD-1234',
    verification_uri: 'https://nyxid.ai/login/agent-key?user_code=ABCD-1234',
    expires_in: 300,
    interval: 1,
    expiresAt: Date.now() + 300000,
    nextPollAt: Date.now(),
  };
  saveEnrollment('alice', 'alice', enrollment);
  saveEnrollment('alice', 'alice', enrollment, 'nyxagent');
  clearBrowserKey('alice', undefined, 'nyxagent');
  clearEnrollment('alice', undefined, 'nyxagent');
  expect(readBrowserKey('alice', 'alice', 'nyxagent')).toBeNull();
  expect(readBrowserKey('alice')?.credential).toBe('nyx_test_cma_credential');
  expect(readEnrollment('alice', 'alice', 'nyxagent')).toBeNull();
  expect(readEnrollment('alice', 'alice')).toEqual(enrollment);
});
