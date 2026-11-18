import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, FIXTURE_UNIVERSE_LINK } from '../App';
import { createPublicClient } from '../core/api/client';
import type { EntityBody } from '../core/api/types';
import type { SceneContent, ViewContent } from '../core/scene';
import type { ModelSource } from '../core/sources';
import { fixtureFetch } from '../fixtures/server';
import { fakeViewFactory } from '../test/fakeView';
import { InfoPanel } from './InfoPanel';
import { Viewer } from './Viewer';

const createClient = (share: string | null, universe?: string) =>
  createPublicClient({ share, universe, fetch: fixtureFetch });

function visit(url: string) {
  window.history.replaceState(null, '', url);
}

afterEach(() => {
  visit('/');
});

/** 只有外部模型物件的场景（直接交给查看器，不经过接口）。 */
function sceneWith(...sources: ModelSource[]): SceneContent {
  const entities: EntityBody[] = sources.map((source, i) => ({
    entityId: `model-${i}`,
    layer: 'rebuilt',
    kind: 'object',
    label: `模型 ${i}`,
    assetHash: 'ab'.repeat(32),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    props: { source },
  }));
  return {
    mode: 'optimized',
    links: [],
    members: [
      {
        spaceId: 'space-0',
        placement: { offset: [0, 0, 0], rotation: 0 },
        view: { entities, voxels: { chunks: [] } } as unknown as ViewContent,
      },
    ],
  };
}

const CC0: ModelSource = {
  library: 'polyhaven',
  id: 'shelf',
  page: 'https://example.com/models/shelf',
  author: '某作者',
  license: 'CC0-1.0',
  title: '木架',
};
const CC_BY: ModelSource = {
  library: 'objaverse',
  id: 'sofa',
  page: 'https://example.com/models/sofa',
  author: '另一位作者',
  license: 'CC-BY-3.0',
  title: '布艺沙发',
};

describe('引用版权', () => {
  it('组合场景从单独一个入口打开完整署名，关闭后焦点回到入口', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_UNIVERSE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    await waitFor(() => expect(views[0]?.last().members.length).toBe(2), { timeout: 5000 });
    const toggle = screen.getByRole('button', { name: '引用版权' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: '玻璃瓶花束（示例）' })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: '引用版权' });
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
    const close = within(panel).getByRole('button', { name: '关闭' });
    expect(close).toHaveFocus();
    expect(within(panel).getByText(/经过调整.*与原文件不同/)).toBeInTheDocument();
    const title = within(panel).getByRole('link', { name: '玻璃瓶花束（示例）' });
    expect(title).toHaveAttribute('href', 'https://example.com/models/bouquet');
    expect(title).toHaveAttribute('rel', 'noopener noreferrer');
    expect(title).toHaveAttribute('target', '_blank');
    expect(within(panel).getByText('作者 夹具作者乙')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'CC BY 4.0（须署名）' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/4.0/',
    );
    expect(within(panel).getByText('用于：花束')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'CC0 1.0（公有领域）' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/publicdomain/zero/1.0/',
    );

    await userEvent.keyboard('{Escape}');
    expect(panel).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    await userEvent.click(close);
    expect(panel).not.toBeVisible();
    expect(toggle).toHaveFocus();
  });

  it.each([
    [CC_BY, 'CC BY 3.0（须署名）', 'https://creativecommons.org/licenses/by/3.0/'],
    [CC0, 'CC0 1.0（公有领域）', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  ])('场景只有一种许可时也使用同一个入口', async (source, label, url) => {
    const { factory } = fakeViewFactory();
    render(<Viewer content={sceneWith(source)} cutaway={null} createView={factory} />);
    await userEvent.click(screen.getByRole('button', { name: '引用版权' }));
    const panel = screen.getByRole('region', { name: '引用版权' });
    expect(within(panel).getByRole('link', { name: source.title })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: label })).toHaveAttribute('href', url);
  });

  it('无署名的场景隐藏入口，切回时默认收起', async () => {
    const { factory } = fakeViewFactory();
    const content = sceneWith(CC0);
    const { rerender } = render(<Viewer content={content} cutaway={null} createView={factory} />);
    await userEvent.click(screen.getByRole('button', { name: '引用版权' }));
    rerender(<Viewer content={sceneWith()} cutaway={null} createView={factory} />);
    expect(screen.queryByRole('button', { name: '引用版权' })).toBeNull();
    expect(screen.queryByRole('region', { name: '引用版权' })).toBeNull();
    rerender(<Viewer content={content} cutaway={null} createView={factory} />);
    expect(screen.getByRole('button', { name: '引用版权' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('物件信息省略合规署名，旧版 source 仍作为普通属性显示', () => {
    const entity = sceneWith(CC_BY).members[0]!.view.entities[0]!;
    const onClose = vi.fn();
    const { rerender } = render(
      <InfoPanel selection={{ spaceId: 's', entity }} onClose={onClose} />,
    );
    expect(screen.queryByText('来源')).toBeNull();
    expect(screen.queryByText('source')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    const legacy = { ...entity, props: { source: 'hint' } };
    rerender(<InfoPanel selection={{ spaceId: 's', entity: legacy }} onClose={onClose} />);
    expect(screen.getByText('source')).toBeInTheDocument();
    expect(screen.getByText('hint')).toBeInTheDocument();
  });
});
