import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectPage } from './ConnectPage';

afterEach(() => window.history.replaceState(null, '', '/'));

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
  expect(await screen.findByRole('link', { name: '前往 NyxID 授权' })).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith('/api/auth/nyxid/disconnect', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': 'csrf-proof' },
  });
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
