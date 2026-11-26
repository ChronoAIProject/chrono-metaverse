import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../space/SpacePage', () => ({
  SpacePage: ({ spaceId, previewToken }: { spaceId: string; previewToken?: string }) => (
    <div data-testid="private-viewer" data-preview={previewToken}>
      {spaceId}
    </div>
  ),
}));
import { WorkspacePage } from './WorkspacePage';
import { viewerLink, resultLinks } from './client';
const request = vi.fn<typeof fetch>(async (input) => {
  if (String(input).endsWith('/session'))
    return Response.json({ enabled: true, connected: true, subject: 'owner-a', csrfToken: 'csrf' });
  if (String(input).endsWith('/spaces'))
    return Response.json({
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
  throw new Error(String(input));
});
afterEach(cleanup);
it('从目录打开空间，使用 SDK 挂件并按归属筛选空间', async () => {
  const { container } = render(<WorkspacePage request={request} />);
  await userEvent.click(await screen.findByRole('button', { name: '选择空间' }));
  await userEvent.click(await screen.findByRole('button', { name: /我的前厅/ }));
  expect(screen.getByTestId('private-viewer')).toHaveTextContent('my-lobby');
  expect(container.querySelector('nyx-assistant')?.getAttribute('data-session')).toBe('my-lobby');
  await userEvent.click(screen.getByRole('button', { name: '选择空间' }));
  await userEvent.selectOptions(screen.getByLabelText('空间归属'), 'person');
  expect(screen.queryByRole('button', { name: /我的前厅/ })).toBeNull();
  expect(screen.getByRole('button', { name: /我的花园/ })).toBeVisible();
});
it('只允许本站的查看器链接并从回复中提取草稿', () => {
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
  expect(
    resultLinks('草稿 /preview#t=preview-safe-token 与 https://other.example/s/lobby'),
  ).toEqual(['/preview#t=preview-safe-token']);
});
