import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectPage } from './ConnectPage';
import { readBrowserKey, saveBrowserKey } from './browserKey';

afterEach(() => window.history.replaceState(null, '', '/'));

it('忽略未知回调标记，包括对象原型属性名', async () => {
  window.history.replaceState(null, '', '/connect?error=constructor');
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ enabled: true, connected: false }));
  render(<ConnectPage request={request} />);
  await screen.findByRole('link', { name: '前往 NyxID 授权' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(window.location.search).toBe('');
});

it('授权入口只指向服务端，取消授权后可重试', async () => {
  window.history.replaceState(null, '', '/connect?error=denied');
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ enabled: true, connected: false }));
  render(<ConnectPage request={request} />);
  expect(await screen.findByRole('link', { name: '前往 NyxID 授权' })).toHaveAttribute(
    'href',
    '/api/auth/nyxid/login',
  );
  expect(screen.getByText(/授权已取消/)).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(
    '/api/auth/nyxid/session',
    expect.objectContaining({
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
});

it('断开使用服务端 CSRF 令牌，成功后恢复授权入口', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ enabled: true, connected: true, subject: 'alice', csrfToken: 'csrf-proof' }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  render(<ConnectPage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '断开连接' }));
  expect(request).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: '确认断开' }));
  expect(await screen.findByRole('link', { name: '前往 NyxID 授权' })).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith(
    '/api/auth/nyxid/disconnect',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': 'csrf-proof' },
    }),
  );
});

const connected = { enabled: true, connected: true, subject: 'alice', csrfToken: 'csrf-proof' };

it('从当前账号的组织列表选择后，再实时查询权限', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(
      Response.json({
        subject: 'alice',
        organizations: [{ id: 'org-123', name: 'ChronoAI', role: 'admin' }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        subject: 'alice',
        status: 'ready',
        organization: { id: 'org-123', role: 'viewer', access: 'read' },
      }),
    );
  render(<ConnectPage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '选择我的组织' }));
  await userEvent.selectOptions(
    await screen.findByRole('combobox', { name: '我的组织' }),
    'org-123',
  );
  expect(screen.getByRole('textbox', { name: '组织编号' })).toHaveValue('org-123');
  expect(screen.queryByText('管理员 · 可管理组织资源')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '查询权限' }));
  expect(await screen.findByText('查看者 · 可读取组织资源')).toBeInTheDocument();
});

it('组织列表为空时，保留手动检查入口', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(Response.json({ subject: 'alice', organizations: [] }));
  render(<ConnectPage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '选择我的组织' }));
  expect(await screen.findByText(/没有返回此账号所属的组织/)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '组织编号' })).toBeEnabled();
});

it('显示实际账号，并区分保存授权与实时连接检查', async () => {
  window.history.replaceState(null, '', '/connect?connected=1');
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(
      Response.json({ subject: 'alice', status: 'ready', organization: null }),
    );
  render(<ConnectPage request={request} />);
  expect(await screen.findByText('alice')).toBeInTheDocument();
  expect(screen.getByText('授权已保存')).toBeInTheDocument();
  expect(screen.queryByText('连接有效')).toBeNull();
  expect(screen.getByText(/授权成功，连接已保存/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('csrf-proof');
  expect(window.location.search).toBe('');
  await userEvent.click(screen.getByRole('button', { name: '检查连接' }));
  expect(await screen.findByText('连接有效')).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith(
    '/api/auth/nyxid/check',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: '{}',
      headers: { 'x-csrf-token': 'csrf-proof', 'Content-Type': 'application/json' },
    }),
  );
});

it.each([
  ['admin', 'manage', '管理员 · 可管理组织资源'],
  ['member', 'read', '成员 · 可读取组织资源'],
  ['viewer', 'read', '查看者 · 可读取组织资源'],
  [null, 'none', '未确认组织成员身份'],
])('查询并展示组织角色 %s', async (role, access, label) => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(
      Response.json({
        subject: 'alice',
        status: 'ready',
        organization: { id: 'org-123', role, access },
      }),
    );
  render(<ConnectPage request={request} />);
  await screen.findByText('alice');
  await userEvent.type(screen.getByRole('textbox', { name: '组织编号' }), 'org-123');
  await userEvent.click(screen.getByRole('button', { name: '查询权限' }));
  expect(await screen.findByText(label)).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith(
    '/api/auth/nyxid/check',
    expect.objectContaining({ body: '{"orgId":"org-123"}' }),
  );
});

it('组织服务故障时清除旧权限结果，允许重试而不声称用户无权限', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(
      Response.json({
        subject: 'alice',
        status: 'ready',
        organization: { id: 'org-123', role: 'admin', access: 'manage' },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  render(<ConnectPage request={request} />);
  await screen.findByText('alice');
  await userEvent.type(screen.getByRole('textbox', { name: '组织编号' }), 'org-123');
  await userEvent.click(screen.getByRole('button', { name: '查询权限' }));
  await screen.findByText('管理员 · 可管理组织资源');
  await userEvent.click(screen.getByRole('button', { name: '查询权限' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('检查失败不代表没有组织权限');
  expect(screen.queryByText('管理员 · 可管理组织资源')).toBeNull();
  expect(screen.queryByText('未确认组织成员身份')).toBeNull();
  expect(screen.getByRole('button', { name: '查询权限' })).toBeEnabled();
});

it('失效连接恢复授权入口，组织查询不再可用', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  render(<ConnectPage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '检查连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接已失效');
  expect(screen.getByRole('link', { name: '前往 NyxID 授权' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '组织编号' })).toBeDisabled();
  expect(screen.queryByText('alice')).toBeNull();
});

it('取消断开不发送请求，断开失败时可重试', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  render(<ConnectPage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '断开连接' }));
  await userEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '确认断开' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '断开连接' }));
  await userEvent.click(screen.getByRole('button', { name: '确认断开' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('断开失败');
  expect(screen.getByText('alice')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '确认断开' })).toBeEnabled();
});

it('刷新发现其他会话已断开时移除原账号和操作', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(connected))
    .mockResolvedValueOnce(Response.json({ enabled: true, connected: false }));
  render(<ConnectPage request={request} />);
  await screen.findByText('alice');
  await userEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await screen.findByRole('link', { name: '前往 NyxID 授权' });
  expect(screen.queryByText('alice')).toBeNull();
  expect(screen.queryByRole('button', { name: '断开连接' })).toBeNull();
});

it('回调失败给出恢复入口，不显示未知错误原文或伪造成功', async () => {
  window.history.replaceState(null, '', '/connect?error=expired&connected=1&code=secret-code');
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ enabled: true, connected: false }));
  render(<ConnectPage request={request} />);
  expect(screen.getByRole('alert')).toHaveTextContent('授权链接已过期');
  await screen.findByRole('link', { name: '前往 NyxID 授权' });
  expect(screen.queryByText(/授权成功/)).toBeNull();
  expect(document.body.textContent).not.toContain('secret-code');
  expect(window.location.search).toBe('');
});

it('格式错误的会话响应不能变成已连接状态', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ enabled: true, connected: true, subject: 'alice' }));
  render(<ConnectPage request={request} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取连接状态');
  expect(screen.queryByRole('button', { name: '检查连接' })).toBeNull();
});

it('网络失败可重试，未启用时不显示授权入口', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ enabled: false, connected: false }));
  render(<ConnectPage request={request} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取连接状态');
  await userEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText(/此部署尚未启用/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '前往 NyxID 授权' })).toBeNull();
});

it('断开账号先撤销浏览器子凭据，再删除 OAuth 连接', async () => {
  const identity = {
    keyId: 'key-cma',
    name: 'CMA',
    credentialId: 'child',
    credentialExpiresAt: null,
    keyExpiresAt: null,
  };
  saveBrowserKey('alice', 'nyx_test_connect_child', identity);
  const request = vi.fn<typeof fetch>(async (input) =>
    Response.json(String(input).endsWith('/session') ? connected : { ok: true }),
  );
  render(<ConnectPage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '断开连接' }));
  await userEvent.click(screen.getByRole('button', { name: '确认断开' }));
  await screen.findByRole('link', { name: '前往 NyxID 授权' });
  expect(request.mock.calls.map((c) => String(c[0]))).toEqual([
    '/api/auth/nyxid/session',
    '/api/auth/nyxid/worker/key/revoke',
    '/api/auth/nyxid/disconnect',
  ]);
  expect(readBrowserKey('alice')).toBeNull();
});
it('子凭据撤销状态未知时保留连接以供恢复', async () => {
  saveBrowserKey('alice', 'nyx_test_connect_child', {
    keyId: 'key-cma',
    name: 'CMA',
    credentialId: 'child',
    credentialExpiresAt: null,
    keyExpiresAt: null,
  });
  const request = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith('/session')
      ? Response.json(connected)
      : Response.json({ code: 'cma_key_unavailable' }, { status: 503 }),
  );
  render(<ConnectPage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '断开连接' }));
  await userEvent.click(screen.getByRole('button', { name: '确认断开' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('尚未确认撤销');
  expect(request).toHaveBeenCalledTimes(2);
  expect(readBrowserKey('alice')).not.toBeNull();
  sessionStorage.clear();
});
