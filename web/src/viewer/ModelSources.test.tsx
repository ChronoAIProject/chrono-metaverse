import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, FIXTURE_LINK, FIXTURE_UNIVERSE_LINK } from '../App';
import { createPublicClient } from '../core/api/client';
import type { EntityBody } from '../core/api/types';
import { fixtureFetch } from '../fixtures/server';
import { fakeViewFactory } from '../test/fakeView';
import { InfoPanel } from './InfoPanel';

const createClient = (share: string | null, universe?: string) =>
  createPublicClient({ share, universe, fetch: fixtureFetch });

function visit(url: string) {
  window.history.replaceState(null, '', url);
}

afterEach(() => {
  visit('/');
});

describe('模型来源', () => {
  it('场景里有外部模型时一直有"模型来源"按钮，点开列出标题、作者、许可和来源链接', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_UNIVERSE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    // 组合场景要加载两个空间，机器忙的时候超过默认的 1 秒（整套单元测试和编译同时跑时偶发失败）
    await waitFor(() => expect(views[0]?.last().members.length).toBe(2), { timeout: 5000 });
    const toggle = await screen.findByRole('button', { name: '模型来源 · 2' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: '模型来源' });
    expect(within(panel).getByText(/其中 1 个按 CC BY 许可署名/)).toBeInTheDocument();
    const cc = within(panel).getByRole('link', { name: '玻璃瓶花束（示例）' });
    expect(cc).toHaveAttribute('href', 'https://example.com/models/bouquet');
    expect(cc).toHaveAttribute('rel', 'noopener noreferrer');
    expect(cc).toHaveAttribute('target', '_blank');
    expect(within(panel).getByText('作者 夹具作者乙')).toBeInTheDocument();
    expect(within(panel).getByText('CC BY 4.0（须署名）')).toBeInTheDocument();
    expect(within(panel).getByText('CC0 1.0（公有领域）')).toBeInTheDocument();
    expect(within(panel).getByText('用于：花束')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('region', { name: '模型来源' })).toBeNull();
  });

  it('没有外部模型的场景不显示按钮', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    await waitFor(() => expect(views[0]?.contents.length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /模型来源/ })).toBeNull();
  });

  it('信息面板把署名显示成来源，不合规则的 source 照旧按纯文本列出', async () => {
    const entity: EntityBody = {
      entityId: 'sofa-01',
      layer: 'rebuilt',
      kind: 'object',
      label: '沙发',
      assetHash: 'ab'.repeat(32),
      props: {
        source: {
          library: 'sketchfab',
          id: 'abc',
          page: 'https://example.com/m/abc',
          author: '某作者',
          license: 'CC-BY-3.0',
          title: '<b>沙发</b>',
        },
      },
    };
    const onClose = vi.fn();
    const { rerender } = render(
      <InfoPanel selection={{ spaceId: 's', entity }} onClose={onClose} />,
    );
    const link = screen.getByRole('link', { name: '<b>沙发</b>' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('CC BY 3.0（须署名）')).toBeInTheDocument();
    expect(screen.getByText('Sketchfab')).toBeInTheDocument();
    expect(screen.queryByText('source')).toBeNull();
    const unsafe: EntityBody = {
      ...entity,
      props: { source: { ...(entity.props!.source as object), page: 'javascript:alert(1)' } },
    };
    rerender(<InfoPanel selection={{ spaceId: 's', entity: unsafe }} onClose={onClose} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('source')).toBeInTheDocument();
  });
});
