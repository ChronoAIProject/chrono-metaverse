import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { createPublicClient } from '../core/api/client';
import { resetFixtureStore, SPACE_ID, UNIVERSE_ID, UNIVERSE_SHARE_TOKEN } from '../fixtures';
import { fixtureFetch } from '../fixtures/server';
import { fakeViewFactory } from '../test/fakeView';
import type { ViewerCommand } from './viewerActions';

vi.mock('./NyxAgentPanel', () => ({
  NyxAgentPanel: ({ onViewerCommand }: { onViewerCommand: (command: ViewerCommand) => void }) => (
    <>
      <button
        onClick={() =>
          onViewerCommand({
            id: 'route-batch',
            actions: [
              { type: 'universe', universeId: 'demo-street' },
              { type: 'mode', value: 'raw' },
              { type: 'style', value: 'shapes' },
              { type: 'look', styleId: 'voxel-blocks', spaceId: 'demo-lobby' },
              { type: 'camera', kind: 'focus', entityId: 'chair', spaceId: 'demo-lobby' },
            ],
          })
        }
      >
        应用组合动作
      </button>
      <button
        onClick={() =>
          onViewerCommand({
            id: 'global-batch',
            actions: [
              { type: 'universe', universeId: 'demo-street' },
              { type: 'mode', value: 'raw' },
              { type: 'style', value: 'blocks' },
              { type: 'look', styleId: 'blueprint' },
              { type: 'camera', kind: 'overview' },
            ],
          })
        }
      >
        应用全局样式动作
      </button>
    </>
  ),
}));
vi.mock('../space/SpacePage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../space/SpacePage')>();
  return {
    ...original,
    SpacePage: (props: import('../space/SpacePage').SpacePageProps) =>
      props.embedded ? <div>工作台查看器</div> : <original.SpacePage {...props} />,
  };
});
afterEach(() => vi.unstubAllGlobals());

it.each(['成员样式', '全局样式'] as const)(
  '将工作台的%s动作交给组合查看器并释放旧覆盖',
  async (scope) => {
    resetFixtureStore();
    sessionStorage.clear();
    localStorage.clear();
    window.history.replaceState(null, '', '/workspace?space=demo-lobby');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/session'))
          return Response.json({
            enabled: true,
            connected: true,
            subject: 'owner',
            csrfToken: 'csrf',
          });
        if (url.endsWith('/spaces'))
          return Response.json({
            items: [
              {
                id: SPACE_ID,
                name: '前厅',
                owner: { kind: 'person', id: 'owner' },
                visibility: 'public',
                access: 'manage',
                updatedAt: '',
              },
            ],
            organizations: [],
            next: null,
          });
        if (url.endsWith('/connection'))
          return Response.json({
            ready: true,
            credentialVersion: 'v'.repeat(43),
            ownerId: 'owner',
          });
        throw new Error(`未预期的工作台请求： ${url}`);
      }),
    );
    const s = fakeViewFactory();
    const camera = vi.fn(() => true);
    const factory: typeof s.factory = (host, options) => {
      const view = s.factory(host, options);
      view.applyCamera = camera;
      return view;
    };
    render(
      <App
        createView={factory}
        createClient={() =>
          createPublicClient({
            share: UNIVERSE_SHARE_TOKEN,
            universe: UNIVERSE_ID,
            fetch: fixtureFetch,
          })
        }
      />,
    );
    await screen.findByText('前厅', { selector: '.workspace__space-trigger span' });
    await userEvent.click(
      await screen.findByRole('button', {
        name: scope === '成员样式' ? '应用组合动作' : '应用全局样式动作',
      }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/s/demo-street'));
    await waitFor(() => expect(camera).toHaveBeenCalledOnce());
    expect(camera.mock.calls[0]).toBeDefined();
    const members = s.views[0]!.last().members;
    if (scope === '成员样式') {
      expect(
        members.find((member) => member.spaceId === `${UNIVERSE_ID}/${SPACE_ID}`)!.view,
      ).toMatchObject({
        mode: 'optimized',
        style: 'blocks',
      });
      expect(
        members.find((member) => member.spaceId !== `${UNIVERSE_ID}/${SPACE_ID}`)!.view,
      ).toMatchObject({
        mode: 'optimized',
        style: 'shapes',
      });
    } else {
      expect(
        members.every(
          (member) =>
            member.view.styleId === 'blueprint' &&
            member.view.mode === 'optimized' &&
            member.view.style === 'shapes',
        ),
      ).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '显示设置' }));
      fireEvent.click(screen.getByRole('button', { name: '体素方块世界' }));
      await waitFor(() =>
        expect(
          s.views[0]!.last().members.every((member) => member.view.styleId === 'voxel-blocks'),
        ).toBe(true),
      );
      fireEvent.click(screen.getByRole('button', { name: '各自独立' }));
      await waitFor(() =>
        expect(
          s.views[0]!.last().members.find(
            (member) => member.spaceId === `${UNIVERSE_ID}/${SPACE_ID}`,
          )!.view.styleId,
        ).toBe('arch-realistic'),
      );
    }
  },
);
