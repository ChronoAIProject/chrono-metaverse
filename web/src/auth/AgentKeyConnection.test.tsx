import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentKeyConnection } from './AgentKeyConnection';
import { browserKeyHeaders, readBrowserKey, saveBrowserKey } from './browserKey';

const identity = {
  keyId: 'key-cma',
  name: 'Metaverse CMA',
  credentialId: 'child-browser',
  credentialExpiresAt: null,
  keyExpiresAt: null,
};
const credential = 'nyx_test_browser_credential';
const session = {
  enabled: true,
  connected: true,
  subject: 'alice',
  csrfToken: 'csrf',
  workerAvailable: true,
  workerEnabled: true,
};
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

it('刷新复用浏览器凭据，核验后才启用；账号切换不发送旧 Key', async () => {
  saveBrowserKey('alice', credential, identity);
  const request = vi.fn<typeof fetch>(async () => Response.json(identity));
  const change = vi.fn();
  const view = render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  await screen.findByText('已连接 CMA · Metaverse CMA');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    '/api/auth/nyxid/worker/key/check',
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: `Bearer ${credential}`,
        'x-csrf-token': 'csrf',
      }),
    }),
  );
  expect(change).toHaveBeenLastCalledWith(true);
  view.rerender(
    <AgentKeyConnection
      session={{ ...session, subject: 'bob' }}
      request={request}
      onChange={change}
    />,
  );
  await screen.findByRole('button', { name: '授权此浏览器调用 CMA' });
  expect(browserKeyHeaders('bob')).toEqual({});
  expect(request).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenLastCalledWith(false);
});
it('授权展示独立验证码，审批交付仅保存浏览器；不自动发任务', async () => {
  const request = vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith('/request'))
      return Response.json({
        device_code: 'private-device',
        user_code: 'ABCD-1234',
        verification_uri: 'https://nyxid.ai/login/agent-key?services=cma',
        expires_in: 60,
        interval: 1,
      });
    if (String(input).endsWith('/poll')) return Response.json({ credential, identity });
    throw new Error('unexpected request');
  });
  const change = vi.fn();
  render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  await userEvent.click(await screen.findByRole('button', { name: '授权此浏览器调用 CMA' }));
  expect(await screen.findByText('ABCD-1234')).toBeVisible();
  expect(screen.getByRole('link', { name: '打开 NyxID 授权页' }).getAttribute('href')).not.toMatch(
    /ABCD|private-device/,
  );
  await screen.findByText('已连接 CMA · Metaverse CMA', {}, { timeout: 3000 });
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(request.mock.calls.map((c) => String(c[0]))).toEqual([
    '/api/auth/nyxid/worker/key/request',
    '/api/auth/nyxid/worker/key/poll',
  ]);
});
it('已撤销凭据会移除本地记录并要求重新授权', async () => {
  saveBrowserKey('alice', credential, identity);
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ code: 'cma_key_required', detail: '已撤销' }, { status: 403 }),
  );
  const change = vi.fn();
  render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('已撤销');
  expect(readBrowserKey('alice')).toBeNull();
  expect(change).not.toHaveBeenCalledWith(true);
});
it('服务端确认撤销后清除子凭据', async () => {
  saveBrowserKey('alice', credential, identity);
  const request = vi.fn<typeof fetch>(async (input) =>
    Response.json(String(input).endsWith('/check') ? identity : { revoked: true }),
  );
  render(<AgentKeyConnection session={session} request={request} onChange={vi.fn()} />);
  await userEvent.click(await screen.findByRole('button', { name: '断开此浏览器的 CMA 授权' }));
  await waitFor(() => expect(readBrowserKey('alice')).toBeNull());
  expect(request).toHaveBeenLastCalledWith(
    '/api/auth/nyxid/worker/key/revoke',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${credential}` }),
    }),
  );
});
it('过期或损坏凭据不复用，存储与工作记录分离', () => {
  saveBrowserKey('alice', credential, { ...identity, credentialExpiresAt: '2000-01-01T00:00:00Z' });
  expect(readBrowserKey('alice')).toBeNull();
  expect(browserKeyHeaders('alice')).toEqual({});
  expect(sessionStorage.getItem('metaverse-worker:alice')).toBeNull();
});
