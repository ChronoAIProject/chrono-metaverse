import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App, FIXTURE_LINK, FIXTURE_PREVIEW_LINK, FIXTURE_UNIVERSE_LINK } from './App';
import { createPublicClient } from './core/api/client';
import type { Visual } from './core/visuals';
import { fixtureFetch } from './fixtures/server';
import { fakeViewFactory } from './test/fakeView';
import { Viewer } from './viewer/Viewer';

const createClient = (share: string | null, universe?: string) =>
  createPublicClient({ share, universe, fetch: fixtureFetch });

function lastVisuals(view: { visuals: (readonly Visual[])[] }): readonly Visual[] {
  return view.visuals[view.visuals.length - 1] ?? [];
}

function visit(url: string) {
  window.history.replaceState(null, '', url);
}

afterEach(() => {
  visit('/');
});

describe('应用外壳', () => {
  it('首页在夹具模式下给出演示空间的链接', () => {
    visit('/');
    render(<App createClient={createClient} showFixtureLink />);
    expect(screen.getByRole('heading', { name: 'chrono-metaverse 查看器' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /演示前厅/ })).toHaveAttribute('href', FIXTURE_LINK);
  });

  it('未知路径给出中文提示', () => {
    visit('/nope/x/y');
    render(<App createClient={createClient} />);
    expect(screen.getByRole('alert')).toHaveTextContent('找不到这个页面');
  });

  it('首页也给出组合和预览的夹具链接', () => {
    visit('/');
    render(<App createClient={createClient} showFixtureLink />);
    expect(screen.getByRole('link', { name: /组合/ })).toHaveAttribute(
      'href',
      FIXTURE_UNIVERSE_LINK,
    );
    expect(screen.getByRole('link', { name: /草稿预览/ })).toHaveAttribute(
      'href',
      FIXTURE_PREVIEW_LINK,
    );
  });

  it('现在模式：营业状态、桌位高亮、客流热力、前台的花束都交给场景', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    await screen.findByRole('heading', { name: '演示前厅' });
    await waitFor(() => {
      const visuals = lastVisuals(views[0]!);
      expect(visuals.some((v) => v.kind === 'label' && v.text === '营业中')).toBe(true);
      expect(
        visuals.some(
          (v) =>
            v.kind === 'highlight' && v.anchor.anchorId === 'table-01' && v.text === '有人 3 位',
        ),
      ).toBe(true);
      expect(visuals.some((v) => v.kind === 'heat')).toBe(true);
      expect(visuals.some((v) => v.kind === 'spawn' && v.anchor.anchorId === 'counter-01')).toBe(
        true,
      );
    });
  });

  it('组合页：成员按摆放放进同一场景，连接和正在路上的送花交给场景', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_UNIVERSE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    expect(await screen.findByRole('heading', { name: '街角' })).toBeInTheDocument();
    await waitFor(() => expect(views[0]?.last().members.length).toBe(2));
    const content = views[0]!.last();
    const florist = content.members.find((m) => m.spaceId === 'demo-florist')!;
    expect(florist.placement).toEqual({ offset: [120, 0, 240], rotation: 180 });
    expect(florist.name).toBe('街角花店');
    expect(content.links).toHaveLength(1);
    expect(screen.getByText(/组合修订 #2/)).toBeInTheDocument();
    await waitFor(() => {
      const path = lastVisuals(views[0]!).find((v) => v.kind === 'path');
      expect(path).toMatchObject({ correlationId: 'demo-florist:live', progress: null });
    });
    // 提交标记来自两个空间。
    expect(screen.getByRole('button', { name: /跳到提交 街角花店 #2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /跳到提交 演示前厅 #4/ })).toBeInTheDocument();
  });

  it('组合页：跳到花店加入之前，只剩前厅', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_UNIVERSE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    await screen.findByRole('heading', { name: '街角' });
    await userEvent.click(await screen.findByRole('button', { name: /跳到提交 演示前厅 #3/ }));
    await waitFor(() => expect(screen.getByText(/组合修订 #1/)).toBeInTheDocument());
    await waitFor(() =>
      expect(views[0]!.last().members.map((m) => m.spaceId)).toEqual(['demo-lobby']),
    );
  });

  it('组合页：令牌不对时统一提示链接无效', async () => {
    visit('/u/demo-street#share=wrong');
    render(<App createClient={createClient} createView={fakeViewFactory().factory} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('链接无效，或者组合不存在');
  });

  it('预览页：标明草稿预览，草稿里的物件和区块交给场景', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_PREVIEW_LINK);
    render(<App createClient={createClient} createView={factory} />);
    expect(await screen.findByText('草稿预览')).toBeInTheDocument();
    expect(await screen.findByText(/基于版本 #4/)).toBeInTheDocument();
    await waitFor(() => expect(views[0]?.contents.length).toBeGreaterThan(0));
    const member = views[0]!.last().members[0]!;
    expect(member.view.entities.some((e) => e.entityId === 'bench-draft')).toBe(true);
    expect(member.view.voxels.chunks.length).toBeGreaterThan(0);
    expect(screen.queryByRole('group', { name: '时间轴' })).toBeNull();
  });

  it('预览页：没有令牌或令牌无效都给出提示', async () => {
    visit('/preview');
    const { unmount } = render(<App createClient={createClient} />);
    expect(screen.getByRole('alert')).toHaveTextContent('没有预览令牌');
    unmount();
    visit('/preview#t=wrong');
    render(<App createClient={createClient} createView={fakeViewFactory().factory} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('预览链接无效或已过期');
  });

  it('打开夹具空间：加载场景，切换三种视图，剖切传给场景', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    expect(await screen.findByRole('heading', { name: '演示前厅' })).toBeInTheDocument();
    await waitFor(() => expect(views[0]?.contents.length).toBeGreaterThan(0));
    const view = views[0]!;
    const last = () => view.last();
    const member = () => last().members[0]!;
    expect(last().mode).toBe('optimized');
    expect(member().view.entities.some((e) => e.entityId === 'kiosk-01')).toBe(false);
    expect(view.cutaway).toBeCloseTo(2.2);
    expect(screen.getByText(/版本 #4/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '优化 + 扩展' }));
    await waitFor(() => expect(last().mode).toBe('extended'));
    expect(member().view.entities.some((e) => e.entityId === 'kiosk-01')).toBe(true);
    expect(screen.getByText('虚拟区')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '原始' }));
    await waitFor(() => expect(last().mode).toBe('raw'));
    expect(member().scan).toBeInstanceOf(ArrayBuffer);
    expect(member().scanTransform).toHaveLength(16);

    await userEvent.click(screen.getByRole('checkbox', { name: '剖切' }));
    await waitFor(() => expect(view.cutaway).toBeNull());
  });

  it('跳到第一次提交：优化视图为空并提示', async () => {
    const { factory, views } = fakeViewFactory();
    visit(FIXTURE_LINK);
    render(<App createClient={createClient} createView={factory} />);
    await screen.findByRole('heading', { name: '演示前厅' });
    await userEvent.click(await screen.findByRole('button', { name: /跳到提交 #1/ }));
    await waitFor(() => expect(screen.getByText(/版本 #1/)).toBeInTheDocument());
    await waitFor(() => {
      const view = views[0]!;
      expect(view.last().members[0]!.view.entities).toEqual([]);
    });
    expect(await screen.findByText(/还没有优化模型/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '现在' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: '现在' }));
    await waitFor(() => expect(screen.getByText(/版本 #4/)).toBeInTheDocument());
  });

  it('没有分享令牌时提示链接不完整', async () => {
    visit('/s/demo-lobby');
    render(<App createClient={createClient} createView={fakeViewFactory().factory} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('分享令牌');
  });

  it('空间不存在和令牌不对的提示完全一样（不暴露空间是否存在）', async () => {
    visit('/s/no-such-space#share=fixture-share-token-0123456789abcdef');
    const { unmount } = render(
      <App createClient={createClient} createView={fakeViewFactory().factory} />,
    );
    const missing = (await screen.findByRole('alert')).textContent;
    unmount();
    visit('/s/demo-lobby#share=wrong-token');
    render(<App createClient={createClient} createView={fakeViewFactory().factory} />);
    expect((await screen.findByRole('alert')).textContent).toBe(missing);
    expect(missing).toContain('链接无效，或者空间不存在');
    // 404 不给"重试"。
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });
});

describe('查看器外壳', () => {
  it('WebGL 不可用时给出提示，不抛错', () => {
    render(
      <Viewer
        content={null}
        cutaway={null}
        createView={() => {
          throw new Error('WebGL unavailable');
        }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('无法显示三维场景');
  });

  it('卸载时释放场景', async () => {
    const { factory, views } = fakeViewFactory();
    const { unmount } = render(<Viewer content={null} cutaway={1} createView={factory} />);
    await act(async () => undefined);
    unmount();
    expect(views[0]!.dispose).toHaveBeenCalled();
  });
});
