import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentKeyConnection } from './AgentKeyConnection';
import {
  browserKeyHeaders,
  clearBrowserKey,
  readBrowserKey,
  readBrowserKeys,
  saveBrowserKey,
} from './browserKey';
import { readEnrollment } from './browserEnrollment';

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
it('授权链接预填请求，无需输入验证码或 Key；交付仅保存浏览器且不自动发任务', async () => {
  const request = vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith('/request'))
      return Response.json({
        device_code: 'private-device',
        user_code: 'ABCD-1234',
        verification_uri: 'https://nyxid.ai/login/agent-key?services=cma&user_code=ABCD-1234',
        expires_in: 60,
        interval: 1,
      });
    if (String(input).endsWith('/poll')) return Response.json({ credential, identity });
    if (String(input).endsWith('/check')) return Response.json(identity);
    throw new Error('unexpected request');
  });
  const change = vi.fn();
  render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  await userEvent.click(await screen.findByRole('button', { name: '授权此浏览器调用 CMA' }));
  const link = await screen.findByRole('link', { name: '打开 NyxID 授权页' });
  const url = new URL(link.getAttribute('href')!);
  expect(url.searchParams.get('user_code')).toBe('ABCD-1234');
  expect(link.getAttribute('href')).not.toMatch(/private-device|nyx_test/);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByText(/无需输入验证码或 Key/)).toBeVisible();
  await screen.findByText('已连接 CMA · Metaverse CMA', {}, { timeout: 3000 });
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(request.mock.calls.map((c) => String(c[0]))).toEqual([
    '/api/auth/nyxid/worker/key/request',
    '/api/auth/nyxid/worker/key/poll',
    '/api/auth/nyxid/worker/key/check',
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
it('首次批准后先保存 Key，CMA 核验失败不显示已连接，重试不重新授权', async () => {
  let finishCheck: (response: Response) => void = () => {};
  let available = false;
  const request = vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith('/request'))
      return Response.json({
        device_code: 'private-device',
        user_code: 'ABCD-1234',
        verification_uri: 'https://nyxid.ai/login/agent-key?user_code=ABCD-1234',
        expires_in: 60,
        interval: 1,
      });
    if (String(input).endsWith('/poll')) return Response.json({ credential, identity });
    if (String(input).endsWith('/check')) {
      if (available) return Response.json(identity);
      return new Promise<Response>((resolve) => {
        finishCheck = resolve;
      });
    }
    throw new Error('unexpected request');
  });
  const change = vi.fn();
  render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  await userEvent.click(await screen.findByRole('button', { name: '授权此浏览器调用 CMA' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3), { timeout: 3000 });
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(change).not.toHaveBeenCalledWith(true);
  expect(screen.queryByText('已连接 CMA · Metaverse CMA')).not.toBeInTheDocument();
  finishCheck(
    Response.json({ code: 'cma_key_not_accepted', detail: 'CMA 尚未接受此授权' }, { status: 503 }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('CMA 尚未接受此授权');
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(change).not.toHaveBeenCalledWith(true);
  available = true;
  await userEvent.click(screen.getByRole('button', { name: '重新检查 CMA 授权' }));
  await screen.findByText('已连接 CMA · Metaverse CMA');
  expect(change).toHaveBeenLastCalledWith(true);
  expect(request.mock.calls.filter(([input]) => String(input).endsWith('/request'))).toHaveLength(
    1,
  );
  expect(request.mock.calls.filter(([input]) => String(input).endsWith('/poll'))).toHaveLength(1);
  expect(
    request.mock.calls
      .filter(([input]) => String(input).endsWith('/check'))
      .every(
        ([, init]) => new Headers(init?.headers).get('authorization') === `Bearer ${credential}`,
      ),
  ).toBe(true);
});
it('刷新时暂时无法核验仍保留凭据，点击重试复用原凭据', async () => {
  saveBrowserKey('alice', credential, identity);
  let available = false;
  const request = vi.fn<typeof fetch>(async () =>
    available
      ? Response.json(identity)
      : Response.json({ code: 'cma_key_unavailable', detail: '暂时无法核验' }, { status: 503 }),
  );
  const change = vi.fn();
  render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法核验');
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(change).not.toHaveBeenCalledWith(true);
  available = true;
  await userEvent.click(screen.getByRole('button', { name: '重新检查 CMA 授权' }));
  await screen.findByText('已连接 CMA · Metaverse CMA');
  expect(request.mock.calls.every((call) => String(call[0]).endsWith('/key/check'))).toBe(true);
});
it.each(['', 'user_code=WXYZ-5678', 'user_code=ABCD-1234&user_code=ABCD-1234'])(
  '不打开缺失、错配或重复请求码的授权链接：%s',
  async (query) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        device_code: 'private-device',
        user_code: 'ABCD-1234',
        verification_uri: `https://nyxid.ai/login/agent-key?${query}`,
        expires_in: 60,
        interval: 1,
      }),
    );
    render(<AgentKeyConnection session={session} request={request} onChange={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: '授权此浏览器调用 CMA' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法核对授权入口');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  },
);
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

it('个人和组织缓存互相隔离，切换归属后核验对应凭据', async () => {
  const org = 'org-one';
  const orgIdentity = { ...identity, ownerId: org };
  saveBrowserKey('alice', credential, identity);
  saveBrowserKey('alice', 'nyx_test_org_credential', orgIdentity, org);
  const request = vi.fn<typeof fetch>(async (_input, init) => {
    const owner = new Headers(init?.headers).get('x-metaverse-cma-owner');
    return Response.json(owner ? orgIdentity : { ...identity, ownerId: 'alice' });
  });
  const change = vi.fn();
  const view = render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  await waitFor(() => expect(change).toHaveBeenLastCalledWith(true));
  view.rerender(
    <AgentKeyConnection
      session={{ ...session, cmaOwnerId: org }}
      request={request}
      onChange={change}
    />,
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(change).toHaveBeenLastCalledWith(true));
  expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer nyx_test_org_credential',
    'x-metaverse-cma-owner': org,
  });
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(readBrowserKey('bob', org)).toBeNull();
  expect(browserKeyHeaders('alice', 'org-other')).toEqual({ 'x-metaverse-cma-owner': 'org-other' });
  expect(() => saveBrowserKey('alice', credential, identity, org)).toThrow();
  expect(() => saveBrowserKey('alice', credential, orgIdentity)).toThrow();
});

it('浏览器授权跨标签页复用，账号和归属分别保存，断开不删除其他账号', () => {
  saveBrowserKey('alice', credential, { ...identity, ownerId: 'alice' });
  saveBrowserKey(
    'alice',
    'nyx_test_org_credential',
    { ...identity, ownerId: 'org-one' },
    'org-one',
  );
  saveBrowserKey('bob', 'nyx_test_bob_credential', { ...identity, ownerId: 'bob' });
  sessionStorage.clear();
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(
    readBrowserKeys('alice')
      .map((key) => key.owner)
      .sort(),
  ).toEqual(['alice', 'org-one']);
  expect(readBrowserKey('bob', 'org-one')).toBeNull();
  clearBrowserKey('alice');
  expect(readBrowserKeys('alice')).toEqual([]);
  expect(readBrowserKey('bob')?.credential).toBe('nyx_test_bob_credential');
});

it('迁移旧标签页授权后，刷新和新标签页继续使用，撤销后不从旧缓存复活', () => {
  sessionStorage.setItem(
    'metaverse-cma-credential:v1',
    JSON.stringify({ subject: 'alice', credential, identity }),
  );
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  expect(sessionStorage.getItem('metaverse-cma-credential:v1')).toBeNull();
  sessionStorage.clear();
  expect(readBrowserKey('alice')?.credential).toBe(credential);
  clearBrowserKey('alice');
  expect(readBrowserKey('alice')).toBeNull();
});

it('NyxID 已批准但尚未交付时刷新，恢复原申请并接收结果，不再创建授权', async () => {
  const request = vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith('/request'))
      return Response.json({
        device_code: 'private-original-device',
        user_code: 'ABCD-1234',
        verification_uri: 'https://nyxid.ai/login/agent-key?user_code=ABCD-1234',
        expires_in: 60,
        interval: 1,
      });
    if (String(input).endsWith('/poll')) return Response.json({ credential, identity });
    if (String(input).endsWith('/check')) return Response.json(identity);
    throw new Error('unexpected request');
  });
  const change = vi.fn();
  const first = render(
    <AgentKeyConnection session={session} request={request} onChange={change} />,
  );
  await userEvent.click(await screen.findByRole('button', { name: '授权此浏览器调用 CMA' }));
  await screen.findByRole('link', { name: '打开 NyxID 授权页' });
  const pending = readEnrollment('alice', 'alice')!;
  first.unmount();
  render(<AgentKeyConnection session={session} request={request} onChange={change} />);
  await screen.findByRole('link', { name: '打开 NyxID 授权页' });
  expect(readEnrollment('alice', 'alice')?.expiresAt).toBe(pending.expiresAt);
  await screen.findByText('已连接 CMA · Metaverse CMA', {}, { timeout: 3000 });
  expect(request.mock.calls.filter((call) => String(call[0]).endsWith('/request'))).toHaveLength(1);
  expect(request.mock.calls.find((call) => String(call[0]).endsWith('/poll'))?.[1]?.body).toBe(
    JSON.stringify({ deviceCode: 'private-original-device' }),
  );
  expect(readEnrollment('alice', 'alice')).toBeNull();
  expect(readBrowserKey('alice')?.credential).toBe(credential);
});
