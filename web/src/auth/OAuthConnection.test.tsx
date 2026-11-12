import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OAuthConnection } from './OAuthConnection';
const session = {
  enabled: true,
  connected: true,
  subject: 'alice',
  csrfToken: 'csrf',
  workerAvailable: true,
};
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
it('刷新及切换归属仅使用会话，不转发浏览器保存的 Key', async () => {
  localStorage.setItem('metaverse-cma-credential:v2:alice:alice', 'old-secret');
  sessionStorage.setItem('metaverse-cma-enrollment:v1:alice:alice', 'old-device');
  const request = vi.fn<typeof fetch>(async (_, init) =>
    Response.json({
      ready: true,
      ownerId: new Headers(init?.headers).get('x-metaverse-cma-owner') ?? 'alice',
    }),
  );
  const change = vi.fn();
  const view = render(<OAuthConnection session={session} request={request} onChange={change} />);
  await screen.findByText('已连接 CMA');
  expect(change).toHaveBeenLastCalledWith(true);
  expect(localStorage.getItem('metaverse-cma-credential:v2:alice:alice')).toBe('old-secret');
  expect(sessionStorage.getItem('metaverse-cma-enrollment:v1:alice:alice')).toBe('old-device');
  view.rerender(
    <OAuthConnection
      session={{ ...session, cmaOwnerId: 'org-one' }}
      request={request}
      onChange={change}
    />,
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  for (const [path, init] of request.mock.calls) {
    expect(path).toBe('/api/auth/nyxid/worker/connection');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.credentials).toBe('same-origin');
  }
  expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('x-metaverse-cma-owner')).toBe(
    'org-one',
  );
});
it('缺少 CMA 服务授权时只提供 OAuth 点击入口', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ code: 'cma_oauth_required', detail: '需要 CMA 服务授权' }, { status: 403 }),
  );
  render(<OAuthConnection session={session} request={request} onChange={vi.fn()} />);
  expect(await screen.findByRole('link', { name: '授权网页使用 CMA' })).toHaveAttribute(
    'href',
    '/api/auth/nyxid/login?workspace=1',
  );
  expect(screen.queryByRole('textbox')).toBeNull();
});
it('服务配置错误不诱导重复授权', async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json(
      { code: 'cma_command_authority_required', detail: 'CMA 的 OAuth 聊天能力尚未就绪' },
      { status: 503 },
    ),
  );
  const change = vi.fn();
  render(<OAuthConnection session={session} request={request} onChange={change} />);
  await screen.findByRole('alert');
  expect(change).not.toHaveBeenCalledWith(true);
  expect(screen.queryByRole('link', { name: '授权网页使用 CMA' })).toBeNull();
});
