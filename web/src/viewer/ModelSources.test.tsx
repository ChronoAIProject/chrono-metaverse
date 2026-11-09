import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, FIXTURE_LINK, FIXTURE_UNIVERSE_LINK } from '../App';
import { createPublicClient } from '../core/api/client';
import type { EntityBody } from '../core/api/types';
import type { SceneContent, ViewContent } from '../core/scene';
import type { ModelSource } from '../core/sources';
import { fixtureFetch } from '../fixtures/server';
import { fakeViewFactory } from '../test/fakeView';
import { InfoPanel } from './InfoPanel';
import { MODIFIED_NOTE } from './ModelSources';
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

describe('模型来源', () => {
  it('有 CC BY 模型时底部常驻一行署名（标题、作者、许可都可见），点"全部来源"展开完整列表', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_UNIVERSE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    // 组合场景要加载两个空间，机器忙的时候超过默认的 1 秒（整套单元测试和编译同时跑时偶发失败）
    await waitFor(() => expect(views[0]?.last().members.length).toBe(2), { timeout: 5000 });
    // 不用点开就能看到：第一个须署名的模型 + 总数
    const line = await screen.findByRole('note', { name: '模型署名' });
    expect(line).toHaveTextContent(
      '模型来源：玻璃瓶花束（示例） / 夹具作者乙 / CC-BY-4.0 …，共 2 项',
    );
    const title = within(line).getByRole('link', { name: '玻璃瓶花束（示例）' });
    expect(title).toHaveAttribute('href', 'https://example.com/models/bouquet');
    expect(title).toHaveAttribute('rel', 'noopener noreferrer');
    expect(title).toHaveAttribute('target', '_blank');
    const license = within(line).getByRole('link', { name: 'CC-BY-4.0' });
    expect(license).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
    expect(license).toHaveAttribute('rel', 'noopener noreferrer');
    // 一行放不下时只截短标题：作者、许可和"共 N 项"在不截短的那一段里
    expect(title).toHaveClass('viewer__credit-title');
    expect(license.closest('.viewer__credit-rest')).toHaveTextContent(
      '/ 夹具作者乙 / CC-BY-4.0 …，共 2 项',
    );
    // 底部有署名行时，右下角不再另放"模型来源"按钮
    expect(screen.queryByRole('button', { name: /模型来源 ·/ })).toBeNull();
    expect(screen.queryByRole('region', { name: '模型来源' })).toBeNull();
    const toggle = within(line).getByRole('button', { name: '全部来源' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('收起');
    const panel = screen.getByRole('region', { name: '模型来源' });
    expect(within(panel).getByText(/其中 1 个按 CC BY 许可署名/)).toBeInTheDocument();
    // CC BY 要求注明改动：模型可能经过调整后重新导出，不是原文件（说法不依赖具体工具）
    expect(
      within(panel).getByText(
        /可能经过调整（摆放烘进模型、减面、调色、缩小贴图）后重新导出，与原文件不同/,
      ),
    ).toBeInTheDocument();
    expect(panel).not.toHaveTextContent(/本服务|处理服务/);
    const cc = within(panel).getByRole('link', { name: '玻璃瓶花束（示例）' });
    expect(cc).toHaveAttribute('href', 'https://example.com/models/bouquet');
    expect(cc).toHaveAttribute('rel', 'noopener noreferrer');
    expect(cc).toHaveAttribute('target', '_blank');
    expect(within(panel).getByText('作者 夹具作者乙')).toBeInTheDocument();
    expect(within(panel).getByText('CC BY 4.0（须署名）')).toBeInTheDocument();
    expect(within(panel).getByText('CC0 1.0（公有领域）')).toBeInTheDocument();
    expect(within(panel).getByText('用于：花束')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'CC0 1.0（公有领域）' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/publicdomain/zero/1.0/',
    );
    await userEvent.click(toggle);
    expect(screen.queryByRole('region', { name: '模型来源' })).toBeNull();
    await userEvent.click(toggle);
    await userEvent.click(
      within(screen.getByRole('region', { name: '模型来源' })).getByRole('button', {
        name: '关闭',
      }),
    );
    expect(screen.queryByRole('region', { name: '模型来源' })).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // 收起面板后署名行还在
    expect(screen.getByRole('note', { name: '模型署名' })).toBeInTheDocument();
  });

  it('只有一个须署名的模型：署名行不带"共 N 项"', async () => {
    const { factory } = fakeViewFactory();
    render(<Viewer content={sceneWith(CC_BY)} cutaway={null} createView={factory} />);
    const line = await screen.findByRole('note', { name: '模型署名' });
    expect(line).toHaveTextContent(/^模型来源：布艺沙发 \/ 另一位作者 \/ CC-BY-3\.0全部来源$/);
    expect(within(line).getByRole('link', { name: 'CC-BY-3.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/3.0/',
    );
  });

  it('只有 CC0 模型（不要求署名）：没有署名行，右下角的"模型来源"按钮照样能展开', async () => {
    const { factory } = fakeViewFactory();
    render(<Viewer content={sceneWith(CC0)} cutaway={null} createView={factory} />);
    const toggle = await screen.findByRole('button', { name: '模型来源 · 1' });
    expect(screen.queryByRole('note', { name: '模型署名' })).toBeNull();
    await userEvent.click(toggle);
    const panel = screen.getByRole('region', { name: '模型来源' });
    expect(within(panel).getByRole('link', { name: '木架' })).toBeInTheDocument();
    expect(within(panel).queryByText(/按 CC BY 许可署名/)).toBeNull();
    expect(panel).toHaveTextContent(MODIFIED_NOTE);
  });

  it('没有外部模型的场景既没有署名行也没有按钮', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    await waitFor(() => expect(views[0]?.contents.length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /模型来源/ })).toBeNull();
    expect(screen.queryByRole('note', { name: '模型署名' })).toBeNull();
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
