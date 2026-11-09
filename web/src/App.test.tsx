import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App, FIXTURE_LINK } from './App';
import { createPublicClient } from './core/api/client';
import { fixtureFetch } from './fixtures/server';
import { fakeViewFactory } from './test/fakeView';
import { Viewer } from './viewer/Viewer';

const createClient = (share: string | null) => createPublicClient({ share, fetch: fixtureFetch });

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

  it('未知路径和组合页给出中文提示', () => {
    visit('/nope/x/y');
    const { unmount } = render(<App createClient={createClient} />);
    expect(screen.getByRole('alert')).toHaveTextContent('找不到这个页面');
    unmount();
    visit('/u/street');
    render(<App createClient={createClient} />);
    expect(screen.getByRole('alert')).toHaveTextContent('组合视图还没有上线');
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
