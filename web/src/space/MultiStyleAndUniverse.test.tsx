import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createPublicClient } from '../core/api/client';
import { placePoint, type SceneContent } from '../core/scene';
import {
  fixtureStore,
  resetFixtureStore,
  SPACE_ID,
  SHARE_TOKEN,
  UNIVERSE_ID,
  UNIVERSE_SHARE_TOKEN,
  FLORIST_ID,
  PREVIEW_TOKEN,
} from '../fixtures';
import { fixtureFetch } from '../fixtures/server';
import { fakeViewFactory } from '../test/fakeView';
import { SceneView } from '../viewer/sceneView';
import {
  consumePendingViewerCommand,
  setPendingViewerCommand,
  type CameraAction,
  type ViewerCommand,
} from '../workspace/viewerActions';
import { SpacePage } from './SpacePage';
import { PreviewPage } from './PreviewPage';
import { UniversePage } from './UniversePage';

beforeEach(() => {
  resetFixtureStore();
  consumePendingViewerCommand();
  window.history.replaceState(null, '', '/s/demo-lobby');
});

function 打开面板(label: string) {
  const trigger = screen.getByRole('button', { name: label });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
}
function 设置按钮(name: string | RegExp) {
  打开面板('显示设置');
  return screen.getByRole('button', { name });
}
function 成员控件(label: string) {
  打开面板('空间导览');
  return screen.getByLabelText(label);
}

function 打开完整应用(url: string) {
  window.history.replaceState(null, '', url);
  const fetcher = vi.fn<typeof fetch>(fixtureFetch);
  const createClient = vi.fn((share: string | null, universe?: string) =>
    createPublicClient({ share, universe, fetch: fetcher }),
  );
  const scene = fakeViewFactory();
  const page = render(<App createClient={createClient} createView={scene.factory} />);
  return { ...scene, ...page, createClient, fetcher };
}

function 验证请求授权(
  fetcher: ReturnType<typeof 打开完整应用>['fetcher'],
  path: string,
  authorization: string,
) {
  const requests = fetcher.mock.calls.filter(([input]) => String(input).startsWith(path));
  expect(requests.length, '必须通过客户端实际请求目标资源').toBeGreaterThan(0);
  for (const [input, init] of requests) {
    expect(new Headers(init?.headers).get('Authorization'), '请求必须携带片段对应的授权').toBe(
      authorization,
    );
    expect(String(input), '请求地址不得包含令牌片段').not.toContain('#');
  }
}

it.each([
  ['', 'optimized', 'shapes'],
  ['?view=raw&style=blocks', 'raw', null],
  ['?look=brand-open-day', 'extended', 'shapes'],
] as const)(
  '完整应用的空间分享片段在样式画廊与基础控制切换后保持原值（参数：`%s`）',
  async (search, mode, style) => {
    const hash = `#share=${SHARE_TOKEN}`;
    const app = 打开完整应用(`/s/${SPACE_ID}${search}${hash}`);
    await waitFor(() =>
      expect(app.views[0]?.last().members[0]?.view).toMatchObject({ mode, style }),
    );
    expect(app.createClient).toHaveBeenCalledWith(SHARE_TOKEN, undefined);
    验证请求授权(app.fetcher, `/api/public/spaces/${SPACE_ID}`, `Share ${SHARE_TOKEN}`);
    expect(window.location.hash).toBe(hash);
    打开面板('显示设置');
    const gallery = within(screen.getByRole('group', { name: '空间样式画廊' }));
    fireEvent.click(gallery.getByRole('button', { name: /品牌开放日.*开放日策展/ }));
    await waitFor(() =>
      expect(app.views[0]?.last().members[0]?.view).toMatchObject({
        styleId: 'brand-open-day',
        mode: 'extended',
        extensions: {
          badge: '开放日策展',
          exhibition: { title: '前厅共创展', edition: 2026, zones: ['实体区', '虚拟展区'] },
        },
      }),
    );
    expect(new URLSearchParams(window.location.search).get('look')).toBe('brand-open-day');
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(new URLSearchParams(window.location.search).has('style')).toBe(false);
    expect(window.location.hash).toBe(hash);
    fireEvent.click(gallery.getByRole('button', { name: '工程蓝图' }));
    await waitFor(() => expect(app.views[0]?.last().members[0]?.view.styleId).toBe('blueprint'));
    expect(window.location.hash).toBe(hash);
    fireEvent.click(
      within(screen.getByRole('group', { name: '视图模式' })).getByRole('button', {
        name: '优化 + 扩展',
      }),
    );
    await waitFor(() => expect(app.views[0]?.last().mode).toBe('extended'));
    expect(new URLSearchParams(window.location.search).get('view')).toBe('extended');
    expect(window.location.hash).toBe(hash);
    fireEvent.click(设置按钮('方块'));
    await waitFor(() => expect(app.views[0]?.last().members[0]?.view.style).toBe('blocks'));
    expect(new URLSearchParams(window.location.search).get('style')).toBe('blocks');
    expect(window.location.hash).toBe(hash);
    验证请求授权(app.fetcher, `/api/public/spaces/${SPACE_ID}`, `Share ${SHARE_TOKEN}`);
  },
);

it('完整应用的组合分享片段在主题排布与成员样式指定清除后保持原值', async () => {
  const hash = `#share=${UNIVERSE_SHARE_TOKEN}`;
  const app = 打开完整应用(`/u/${UNIVERSE_ID}${hash}`);
  await waitFor(() => expect(app.views[0]?.last().members).toHaveLength(2));
  expect(app.createClient).toHaveBeenCalledWith(UNIVERSE_SHARE_TOKEN, undefined);
  验证请求授权(
    app.fetcher,
    `/api/public/spaces/${UNIVERSE_ID}/scene`,
    `Share ${UNIVERSE_SHARE_TOKEN}`,
  );
  for (const id of [SPACE_ID, FLORIST_ID]) {
    验证请求授权(app.fetcher, `/api/public/spaces/${id}`, `Share ${UNIVERSE_SHARE_TOKEN}`);
    const requests = app.fetcher.mock.calls.filter(([input]) =>
      String(input).startsWith(`/api/public/spaces/${id}`),
    );
    expect(
      requests.every(
        ([input]) =>
          new URL(String(input), window.location.origin).searchParams.get('universe') ===
          UNIVERSE_ID,
      ),
      '成员信息与快照请求必须携带组合上下文',
    ).toBe(true);
  }
  expect(window.location.hash).toBe(hash);
  fireEvent.click(设置按钮('工程蓝图总览'));
  await waitFor(() =>
    expect(app.views[0]!.last().members.map((member) => member.view.styleId)).toEqual([
      'blueprint',
      'blueprint',
    ]),
  );
  expect(new URLSearchParams(window.location.search).get('themeId')).toBe('blueprint-atlas');
  expect(window.location.hash).toBe(hash);
  fireEvent.click(设置按钮('并排展廊'));
  await waitFor(() =>
    expect(
      app.views[0]!.last().members.find(
        (member) => member.spaceId === `${UNIVERSE_ID}/${FLORIST_ID}`,
      )!.placement,
    ).toMatchObject({
      offset: [26, 0, 0],
      rotation: 0,
    }),
  );
  expect(new URLSearchParams(window.location.search).get('layout')).toBe('side-by-side');
  expect(window.location.hash).toBe(hash);
  const selector = 成员控件(`${fixtureStore().spaces.get(SPACE_ID)!.name} 样式`);
  fireEvent.change(selector, { target: { value: 'brand-open-day' } });
  await waitFor(() => {
    const members = app.views[0]!.last().members;
    expect(
      members.find((member) => member.spaceId === `${UNIVERSE_ID}/${SPACE_ID}`)!.view,
    ).toMatchObject({
      styleId: 'brand-open-day',
      mode: 'extended',
      extensions: { badge: '开放日策展' },
    });
    expect(
      members.find((member) => member.spaceId === `${UNIVERSE_ID}/${FLORIST_ID}`)!.view,
    ).toMatchObject({
      styleId: 'blueprint',
      mode: 'optimized',
    });
  });
  expect(new URLSearchParams(window.location.search).get('memberStyles')).toBe(
    `${UNIVERSE_ID}/${SPACE_ID}:brand-open-day`,
  );
  expect(window.location.hash).toBe(hash);
  fireEvent.change(selector, { target: { value: '' } });
  await waitFor(() =>
    expect(
      app.views[0]!.last().members.every((member) => member.view.styleId === 'blueprint'),
    ).toBe(true),
  );
  const params = new URLSearchParams(window.location.search);
  expect(params.has('memberStyles')).toBe(false);
  expect(params.get('themeId')).toBe('blueprint-atlas');
  expect(params.get('layout')).toBe('side-by-side');
  expect(window.location.hash).toBe(hash);
});

it.each(['', `&share=${SHARE_TOKEN}`])(
  '完整应用的草稿预览片段在样式与模式切换后保持原值且隔离分享解析（附加片段：`%s`）',
  async (extra) => {
    const hash = `#t=${PREVIEW_TOKEN}${extra}`;
    const app = 打开完整应用(`/preview?view=raw${hash}`);
    await waitFor(() => expect(app.views[0]?.last().mode).toBe('raw'));
    expect(app.createClient).toHaveBeenCalledWith(null);
    expect(app.createClient.mock.calls.every(([share]) => share === null)).toBe(true);
    验证请求授权(app.fetcher, '/api/public/previews', `Preview ${PREVIEW_TOKEN}`);
    expect(window.location.hash).toBe(hash);
    fireEvent.click(设置按钮(/品牌开放日.*开放日策展/));
    await waitFor(() =>
      expect(app.views[0]?.last().members[0]?.view).toMatchObject({
        styleId: 'brand-open-day',
        mode: 'extended',
        extensions: { badge: '开放日策展' },
      }),
    );
    expect(new URLSearchParams(window.location.search).get('look')).toBe('brand-open-day');
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(window.location.hash).toBe(hash);
    fireEvent.click(
      within(screen.getByRole('group', { name: '视图模式' })).getByRole('button', { name: '优化' }),
    );
    await waitFor(() => expect(app.views[0]?.last().mode).toBe('optimized'));
    expect(new URLSearchParams(window.location.search).get('view')).toBe('optimized');
    expect(window.location.hash).toBe(hash);
    验证请求授权(app.fetcher, '/api/public/previews', `Preview ${PREVIEW_TOKEN}`);
    expect(
      app.fetcher.mock.calls.some(([, init]) =>
        new Headers(init?.headers).get('Authorization')?.startsWith('Share '),
      ),
      '预览请求不得误用分享令牌',
    ).toBe(false);
    app.unmount();
    const spaceHash = `#share=${SHARE_TOKEN}&t=${PREVIEW_TOKEN}`;
    const space = 打开完整应用(`/s/${SPACE_ID}?look=brand-open-day${spaceHash}`);
    await waitFor(() =>
      expect(space.views[0]?.last().members[0]?.view.styleId).toBe('brand-open-day'),
    );
    expect(space.createClient).toHaveBeenCalledWith(SHARE_TOKEN, undefined);
    验证请求授权(space.fetcher, `/api/public/spaces/${SPACE_ID}`, `Share ${SHARE_TOKEN}`);
    expect(window.location.hash).toBe(spaceHash);
  },
);

it('样式画廊读取策展扩展标签并在实际切换后的场景视图保留结构化信息', async () => {
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const s = fakeViewFactory();
  render(<SpacePage spaceId={SPACE_ID} client={client} hasShareToken createView={s.factory} />);
  await screen.findByRole('button', { name: '显示设置' });
  打开面板('显示设置');
  const button = await screen.findByRole('button', { name: /品牌开放日.*开放日策展/ });
  expect(within(button).getByText('开放日策展')).toBeVisible();
  fireEvent.click(button);
  await waitFor(() =>
    expect(s.views[0]?.last().members[0]?.view).toMatchObject({
      styleId: 'brand-open-day',
      extensions: {
        badge: '开放日策展',
        exhibition: { title: '前厅共创展', edition: 2026, zones: ['实体区', '虚拟展区'] },
      },
    }),
  );
  fireEvent.click(设置按钮(/写实建筑/));
  await waitFor(() => {
    const view = s.views[0]?.last().members[0]?.view;
    expect(view?.styleId).toBe('arch-realistic');
    expect(view).not.toHaveProperty('extensions');
  });
});

it.each([
  ['voxel-blocks', 'optimized', 'blocks', false],
  ['raw-scan', 'raw', null, true],
  ['extended-full', 'extended', 'shapes', false],
] as const)('打开样式 `%s` 时采用对应模式、几何与选中控件', async (look, mode, style, scan) => {
  window.history.replaceState(null, '', `/s/demo-lobby?look=${look}`);
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const s = fakeViewFactory();
  render(<SpacePage spaceId={SPACE_ID} client={client} hasShareToken createView={s.factory} />);
  await waitFor(() =>
    expect(s.views[0]?.last().members[0]?.view).toMatchObject({ mode, style, showScan: scan }),
  );
  expect(s.views[0]!.last().mode).toBe(mode);
  if (scan) expect(s.views[0]!.last().members[0]!.scan?.byteLength).toBeGreaterThan(0);
  const modes = within(screen.getByRole('group', { name: '视图模式' }));
  expect(modes.getByRole('button', { pressed: true })).toHaveTextContent(
    mode === 'raw' ? '原始' : mode === 'extended' ? '扩展' : '优化',
  );
});

it('先应用样式动作再发送镜头动作，并允许显式覆盖', async () => {
  const s = fakeViewFactory();
  const camera = vi.fn(() => true);
  const factory = vi.fn<typeof s.factory>((host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = camera;
    return view;
  });
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const props = { spaceId: SPACE_ID, client, hasShareToken: true, createView: factory };
  const page = render(<SpacePage {...props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(1));
  const command: ViewerCommand = {
    id: 'look-command',
    actions: [
      { type: 'look', styleId: 'voxel-blocks' },
      { type: 'camera', kind: 'overview' },
    ],
  };
  page.rerender(<SpacePage {...props} viewerCommand={command} />);
  await waitFor(() => expect(camera).toHaveBeenCalledOnce());
  expect(camera.mock.calls[0]).toBeDefined();
  expect(s.views[0]!.last().members[0]!.view.style).toBe('blocks');
  打开面板('显示设置');
  fireEvent.click(
    within(screen.getByRole('group', { name: '重建层画法' })).getByRole('button', { name: '形状' }),
  );
  await waitFor(() => expect(s.views[0]!.last().members[0]!.view.style).toBe('shapes'));
  fireEvent.click(
    within(screen.getByRole('group', { name: '视图模式' })).getByRole('button', { name: /扩展/ }),
  );
  await waitFor(() => expect(s.views[0]!.last().mode).toBe('extended'));
  打开面板('空间导览');
  fireEvent.click(screen.getByRole('button', { name: /^全景$/ }));
  打开面板('空间导览');
  fireEvent.click(screen.getByRole('button', { name: /^全景$/ }));
  expect(s.views[0]!.frameContent).toHaveBeenCalledTimes(2);
});

it('遵循保存的默认样式、显式地址覆盖和原始扫描预览样式', async () => {
  const base = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const snapshot = base.snapshot;
  const client = {
    ...base,
    snapshot: vi.fn(async (...args: Parameters<typeof snapshot>) => ({
      ...(await snapshot(...args)),
      defaultStyleId: 'voxel-blocks',
    })),
  };
  const s = fakeViewFactory();
  const page = render(
    <SpacePage spaceId={SPACE_ID} client={client} hasShareToken createView={s.factory} />,
  );
  await waitFor(() => expect(s.views[0]?.last().members[0]?.view.style).toBe('blocks'));
  page.unmount();
  window.history.replaceState(null, '', '/s/demo-lobby?look=raw-scan&view=extended&style=blocks');
  const explicit = fakeViewFactory();
  const overridden = render(
    <SpacePage spaceId={SPACE_ID} client={base} hasShareToken createView={explicit.factory} />,
  );
  await waitFor(() =>
    expect(explicit.views[0]?.last().members[0]?.view).toMatchObject({
      mode: 'extended',
      style: 'blocks',
      showScan: false,
    }),
  );
  overridden.unmount();
  window.history.replaceState(null, '', '/preview?look=raw-scan');
  const preview = fakeViewFactory();
  render(<PreviewPage token={PREVIEW_TOKEN} client={base} createView={preview.factory} />);
  await waitFor(() =>
    expect(preview.views[0]?.last().members[0]?.view).toMatchObject({
      mode: 'raw',
      showScan: true,
    }),
  );
  expect(preview.views[0]!.last().members[0]!.scan?.byteLength).toBeGreaterThan(0);
});

function universe(search = '') {
  window.history.replaceState(null, '', `/u/${UNIVERSE_ID}${search}`);
  const client = createPublicClient({
    share: UNIVERSE_SHARE_TOKEN,
    universe: UNIVERSE_ID,
    fetch: fixtureFetch,
  });
  const s = fakeViewFactory();
  return {
    ...s,
    client,
    props: { universeId: UNIVERSE_ID, client, hasShareToken: true, createView: s.factory },
  };
}

it('`VE-P12-01`：三类跨空间连接双向跳转到公开锚点，重复点击与全景清理均生效', async () => {
  const s = universe();
  const original = s.client.universe;
  const links = [
    {
      kind: 'street' as const,
      from: { spaceId: FLORIST_ID, anchorId: 'door' },
      to: { spaceId: SPACE_ID, anchorId: 'door-01' },
    },
    {
      kind: 'door' as const,
      from: { spaceId: FLORIST_ID, anchorId: 'counter' },
      to: { spaceId: SPACE_ID, anchorId: 'counter-01' },
    },
    {
      kind: 'portal' as const,
      from: { spaceId: FLORIST_ID, anchorId: 'door' },
      to: { spaceId: SPACE_ID, anchorId: 'zone-virtual' },
    },
  ];
  vi.spyOn(s.client, 'universe').mockImplementation(async (...args) => ({
    ...(await original(...args)),
    links: [...links, { kind: 'door', from: links[1]!.to, to: links[1]!.to }],
  }));
  const page = render(<UniversePage {...s.props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  const view = s.views[0]!;
  打开面板('空间导览');
  const sidebar = within(page.container.querySelector<HTMLElement>('.space__links')!);
  expect(sidebar.getAllByRole('button')).toHaveLength(7);
  const names = new Map([
    [SPACE_ID, fixtureStore().spaces.get(SPACE_ID)!.name],
    [FLORIST_ID, fixtureStore().spaces.get(FLORIST_ID)!.name],
  ]);
  for (const link of links) {
    const label = { street: '街区通道', door: '门洞', portal: '传送门' }[link.kind];
    for (const [here, there] of [
      [link.from, link.to],
      [link.to, link.from],
    ] as const) {
      const button = sidebar.getByRole('button', {
        name: `${label} · ${names.get(here.spaceId)} → ${names.get(there.spaceId)}`,
      });
      expect(button).toHaveAttribute('title', `跳转到${names.get(there.spaceId)}`);
      expect(`${button.textContent} ${button.title}`).not.toMatch(/[a-z]/i);
      view.focusAnchor.mockClear();
      fireEvent.click(button);
      expect(view.focusMember).toHaveBeenLastCalledWith(there.spaceId);
      expect(view.focusAnchor).toHaveBeenLastCalledWith(there);
      if (link.kind === 'street') {
        const firstRef = view.focusAnchor.mock.calls[0]![0];
        fireEvent.click(button);
        expect(view.focusAnchor).toHaveBeenCalledTimes(2);
        expect(view.focusAnchor.mock.calls[1]![0]).toEqual(firstRef);
        expect(view.focusAnchor.mock.calls[1]![0]).not.toBe(firstRef);
      }
    }
  }
  打开面板('空间导览');
  const members = within(screen.getByRole('complementary', { name: '成员空间' }));
  fireEvent.click(members.getByRole('button', { name: '聚焦' }));
  expect(view.focusAnchor).toHaveBeenLastCalledWith(null);
  expect(view.focusMember).toHaveBeenLastCalledWith(SPACE_ID);
  fireEvent.click(sidebar.getByRole('button', { name: /街区通道.*→ 演示前厅/ }));
  fireEvent.click(members.getByRole('button', { name: '全景' }));
  expect(view.focusAnchor).toHaveBeenLastCalledWith(null);
  expect(view.frameContent).toHaveBeenCalledTimes(1);
  fireEvent.click(sidebar.getByRole('button', { name: /街区通道.*→ 街角花店/ }));
  fireEvent.click(members.getByRole('button', { name: '全景总览' }));
  expect(view.focusAnchor).toHaveBeenLastCalledWith(null);
  expect(view.frameContent).toHaveBeenCalledTimes(2);
});

it('`VE-P12-02`：空间公开锚点导览传递目标，全景导览清理聚焦并支持回到全景', async () => {
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const s = fakeViewFactory();
  render(<SpacePage spaceId={SPACE_ID} client={client} hasShareToken createView={s.factory} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(1));
  const view = s.views[0]!;
  打开面板('空间导览');
  const bar = within(screen.getByRole('group', { name: '空间锚点导览' }));
  const anchors = view
    .last()
    .members[0]!.view.anchors.filter((anchor) => anchor.visibility !== 'internal');
  expect(anchors.length).toBeGreaterThan(0);
  const buttons = bar.getAllByRole('button');
  expect(buttons).toHaveLength(anchors.length + 1);
  for (const [index, anchor] of anchors.entries()) {
    expect(buttons[index + 1]).toHaveTextContent(anchor.label!);
    fireEvent.click(buttons[index + 1]!);
    expect(view.focusAnchor).toHaveBeenLastCalledWith({
      spaceId: SPACE_ID,
      anchorId: anchor.anchorId,
    });
  }
  fireEvent.click(bar.getByRole('button', { name: '全景' }));
  expect(view.focusAnchor).toHaveBeenLastCalledWith(null);
  expect(view.frameContent).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '回到全景' }));
  expect(view.frameContent).toHaveBeenCalledTimes(2);
});

it('`VE-P12-04`：连接聚焦后先应用成员样式再定位实体，重建内容不恢复旧锚点', async () => {
  const s = universe();
  const snapshot = s.client.snapshot;
  vi.spyOn(s.client, 'snapshot').mockImplementation(async (...args) => {
    const saved = await snapshot(...args);
    return {
      ...saved,
      entities: [
        ...saved.entities,
        {
          id: 'camera-target',
          body: {
            entityId: 'camera-target',
            kind: 'object',
            layer: 'ext',
            label: '镜头目标',
            bounds: { min: [1, 0.5, 2], max: [3, 1.5, 4] },
            shape: { type: 'box', size: [2, 1, 2], transform: { position: [2, 1, 3] } },
          },
        },
      ],
    };
  });
  const flyTo = vi.fn();
  const select = vi.fn();
  const receiver = { flyTo, select, options: { onSelect: vi.fn() } };
  const applyCamera = vi.fn(SceneView.prototype.applyCamera.bind(receiver as unknown as SceneView));
  const factory: typeof s.factory = (host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = applyCamera;
    return view;
  };
  const page = render(<UniversePage {...s.props} createView={factory} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  const view = s.views[0]!;
  打开面板('空间导览');
  fireEvent.click(screen.getByRole('button', { name: /街区通道.*→ 演示前厅/ }));
  expect(view.focusAnchor).toHaveBeenLastCalledWith({ spaceId: SPACE_ID, anchorId: 'door-01' });
  打开面板('空间导览');
  const members = within(screen.getByRole('complementary', { name: '成员空间' }));
  expect(view.focusMember).toHaveBeenLastCalledWith(SPACE_ID);
  expect(members.getByRole('button', { name: '全景' })).toBeVisible();
  view.focusMember.mockClear();
  view.focusAnchor.mockClear();
  const member = view.last().members.find((candidate) => candidate.spaceId === FLORIST_ID)!;
  const entity = member.view.entities.find((candidate) => candidate.entityId === 'camera-target')!;
  expect(entity).toBeDefined();
  const command: ViewerCommand = {
    id: 'link-then-camera',
    actions: [
      { type: 'look', styleId: 'voxel-blocks', spaceId: FLORIST_ID },
      { type: 'camera', kind: 'focus', spaceId: FLORIST_ID, entityId: entity.entityId },
    ],
  };
  page.rerender(<UniversePage {...s.props} createView={factory} viewerCommand={command} />);
  await waitFor(() => expect(applyCamera).toHaveBeenCalledOnce());
  expect(members.queryByRole('button', { name: '全景' })).not.toBeInTheDocument();
  打开面板('空间导览');
  expect(members.getAllByRole('button', { name: '聚焦' })).toHaveLength(2);
  expect(view.focusMember).not.toHaveBeenCalled();
  expect(view.focusAnchor).toHaveBeenCalledWith(null);
  expect(view.focusAnchor.mock.calls.every(([ref]) => ref === null)).toBe(true);
  const appliedContent = applyCamera.mock.calls[0]![1];
  const appliedMember = appliedContent.members.find(
    (candidate) => candidate.spaceId === FLORIST_ID,
  )!;
  expect(appliedMember.view).toMatchObject({ styleId: 'voxel-blocks', style: 'blocks' });
  const appliedEntity = appliedMember.view.entities.find(
    (candidate) => candidate.entityId === entity.entityId,
  )!;
  expect(select).toHaveBeenLastCalledWith({ spaceId: FLORIST_ID, entity: appliedEntity });
  const center = appliedEntity.bounds!.min.map(
    (value, axis) => (value + appliedEntity.bounds!.max[axis]!) / 2,
  );
  expect(flyTo.mock.calls[0]![0].toArray()).toEqual(placePoint(appliedMember.placement, center));
  expect(page.container.querySelector('.viewer')).toHaveAttribute(
    'data-camera-command',
    command.id,
  );
  view.focusMember.mockClear();
  const count = view.contents.length;
  fireEvent.click(设置按钮('工程蓝图总览'));
  await waitFor(() => expect(view.contents.length).toBeGreaterThan(count));
  expect(view.focusMember).not.toHaveBeenCalled();
  expect(view.focusAnchor.mock.calls.every(([ref]) => ref === null)).toBe(true);
  expect(applyCamera).toHaveBeenCalledOnce();
  expect(flyTo).toHaveBeenCalledOnce();

  打开面板('空间导览');
  fireEvent.click(screen.getByRole('button', { name: /街区通道.*→ 街角花店/ }));
  view.focusAnchor.mockClear();
  view.focusMember.mockClear();
  const overview: ViewerCommand = {
    id: 'link-then-overview',
    actions: [{ type: 'camera', kind: 'overview' }],
  };
  Object.assign(receiver, { frameContent: view.frameContent });
  page.rerender(<UniversePage {...s.props} createView={factory} viewerCommand={overview} />);
  await waitFor(() => expect(applyCamera).toHaveBeenCalledTimes(2));
  expect(view.focusAnchor).toHaveBeenLastCalledWith(null);
  expect(view.frameContent).toHaveBeenCalledOnce();
  const overviewCount = view.contents.length;
  fireEvent.click(设置按钮('体素方块世界'));
  await waitFor(() => expect(view.contents.length).toBeGreaterThan(overviewCount));
  expect(view.focusMember).not.toHaveBeenCalled();
  expect(view.focusAnchor.mock.calls.every(([ref]) => ref === null)).toBe(true);
});

// 覆盖 `GoalArtifact.normalized_goal[1,2]` 与 `success_criteria[2,3,4]`。
it('`VE-P13-01`：跨空间连接与成员聚焦后执行纯相机聚焦或环绕，切换主题重建不回跳旧成员', async () => {
  const s = universe();
  const applyCamera = vi.fn(() => true);
  const factory: typeof s.factory = (host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = applyCamera;
    return view;
  };
  const page = render(<UniversePage {...s.props} createView={factory} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  const view = s.views[0]!;
  打开面板('空间导览');
  const members = within(screen.getByRole('complementary', { name: '成员空间' }));
  const florist = view.last().members.find((member) => member.spaceId === FLORIST_ID)!;
  const entity = florist.view.entities.find((candidate) => candidate.bounds != null)!;
  expect(entity).toBeDefined();
  打开面板('空间导览');
  fireEvent.click(screen.getByRole('button', { name: /街区通道.*→ 演示前厅/ }));
  expect(view.focusMember).toHaveBeenLastCalledWith(SPACE_ID);
  expect(members.getByRole('button', { name: '全景' })).toBeVisible();
  view.focusMember.mockClear();
  view.focusAnchor.mockClear();
  const focus: ViewerCommand = {
    id: 'pure-camera-focus',
    actions: [{ type: 'camera', kind: 'focus', spaceId: FLORIST_ID, entityId: entity.entityId }],
  };
  page.rerender(<UniversePage {...s.props} createView={factory} viewerCommand={focus} />);
  await waitFor(() => expect(applyCamera).toHaveBeenCalledOnce());
  expect(applyCamera).toHaveBeenLastCalledWith(focus.actions[0], view.last());
  expect(members.queryByRole('button', { name: '全景' })).not.toBeInTheDocument();
  打开面板('空间导览');
  expect(members.getAllByRole('button', { name: '聚焦' })).toHaveLength(2);
  expect(view.focusMember).not.toHaveBeenCalled();
  const focusCount = view.contents.length;
  fireEvent.click(设置按钮('霓虹街区'));
  await waitFor(() => expect(view.contents.length).toBeGreaterThan(focusCount));
  expect(view.focusMember).not.toHaveBeenCalled();
  expect(view.focusAnchor.mock.calls.every(([ref]) => ref === null)).toBe(true);
  打开面板('空间导览');
  expect(members.getAllByRole('button', { name: '聚焦' })).toHaveLength(2);
  expect(applyCamera).toHaveBeenCalledOnce();

  const lobbyRow = members.getByText('演示前厅').closest('.space__info-row')! as HTMLElement;
  打开面板('空间导览');
  fireEvent.click(within(lobbyRow).getByRole('button', { name: '聚焦' }));
  expect(view.focusMember).toHaveBeenLastCalledWith(SPACE_ID);
  expect(within(lobbyRow).getByRole('button', { name: '全景' })).toBeVisible();
  view.focusMember.mockClear();
  view.focusAnchor.mockClear();
  const orbit: ViewerCommand = {
    id: 'pure-camera-orbit',
    actions: [{ type: 'camera', kind: 'orbit', yaw: 25, pitch: -10 }],
  };
  page.rerender(<UniversePage {...s.props} createView={factory} viewerCommand={orbit} />);
  await waitFor(() => expect(applyCamera).toHaveBeenCalledTimes(2));
  expect(applyCamera).toHaveBeenLastCalledWith(orbit.actions[0], view.last());
  expect(members.queryByRole('button', { name: '全景' })).not.toBeInTheDocument();
  打开面板('空间导览');
  expect(members.getAllByRole('button', { name: '聚焦' })).toHaveLength(2);
  expect(view.focusMember).not.toHaveBeenCalled();
  const orbitCount = view.contents.length;
  fireEvent.click(设置按钮('白模沙盘总览'));
  await waitFor(() => expect(view.contents.length).toBeGreaterThan(orbitCount));
  expect(view.focusMember).not.toHaveBeenCalled();
  expect(view.focusAnchor.mock.calls.every(([ref]) => ref === null)).toBe(true);
  打开面板('空间导览');
  expect(members.getAllByRole('button', { name: '聚焦' })).toHaveLength(2);
  expect(applyCamera).toHaveBeenCalledTimes(2);
});

// 覆盖 `GoalArtifact.normalized_goal[2]` 与 `success_criteria[3,4]`。
it('`VE-P13-02`：单空间锚点导览聚焦后执行外部相机指令，切换命名样式重建不重放旧锚点', async () => {
  const s = fakeViewFactory();
  const applyCamera = vi.fn(() => true);
  const factory: typeof s.factory = (host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = applyCamera;
    return view;
  };
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const props = { spaceId: SPACE_ID, client, hasShareToken: true, createView: factory };
  const page = render(<SpacePage {...props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(1));
  const view = s.views[0]!;
  const anchor = view
    .last()
    .members[0]!.view.anchors.find(
      (candidate) => candidate.visibility === 'public' && candidate.position != null,
    )!;
  打开面板('空间导览');
  fireEvent.click(
    within(screen.getByRole('group', { name: '空间锚点导览' })).getByRole('button', {
      name: anchor.label ?? anchor.anchorId,
    }),
  );
  expect(view.focusAnchor).toHaveBeenLastCalledWith({
    spaceId: SPACE_ID,
    anchorId: anchor.anchorId,
  });
  view.focusAnchor.mockClear();
  const command: ViewerCommand = {
    id: 'anchor-then-camera',
    actions: [{ type: 'camera', kind: 'overview' }],
  };
  page.rerender(<SpacePage {...props} viewerCommand={command} />);
  await waitFor(() => expect(applyCamera).toHaveBeenCalledOnce());
  expect(view.focusAnchor).toHaveBeenLastCalledWith(null);
  const count = view.contents.length;
  打开面板('显示设置');
  fireEvent.click(
    within(screen.getByRole('group', { name: '空间样式画廊' })).getByRole('button', {
      name: '工程蓝图',
    }),
  );
  await waitFor(() => expect(view.contents.length).toBeGreaterThan(count));
  expect(view.focusAnchor.mock.calls.every(([ref]) => ref === null)).toBe(true);
  expect(applyCamera).toHaveBeenCalledOnce();
});

it('成员覆盖与其他成员保存的样式相互独立', async () => {
  const s = universe('?memberStyles=demo-lobby:voxel-blocks');
  render(<UniversePage {...s.props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  const members = s.views[0]!.last().members;
  expect(members.find((m) => m.spaceId === SPACE_ID)!.view).toMatchObject({
    styleId: 'voxel-blocks',
    style: 'blocks',
  });
  expect(members.find((m) => m.spaceId === FLORIST_ID)!.view).toMatchObject({
    styleId: 'spring-greenhouse',
    style: 'shapes',
  });
});

function saveUniverseTheme(s: ReturnType<typeof universe>) {
  const original = s.client.universe;
  vi.spyOn(s.client, 'universe').mockImplementation(
    async (...args: Parameters<typeof original>) => {
      const saved = await original(...args);
      return {
        ...saved,
        themeId: 'voxel-world',
        members: saved.members.map((member) =>
          member.spaceId === SPACE_ID ? { ...member, styleId: undefined } : member,
        ),
      };
    },
  );
}

it('保存的成员样式优先于保存的组合主题，其余成员应用保存主题', async () => {
  const s = universe();
  saveUniverseTheme(s);
  render(<UniversePage {...s.props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  const members = s.views[0]!.last().members;
  expect(members.find((m) => m.spaceId === SPACE_ID)!.view.styleId).toBe('voxel-blocks');
  expect(members.find((m) => m.spaceId === FLORIST_ID)!.view.styleId).toBe('spring-greenhouse');
  expect(设置按钮('体素方块世界')).toHaveAttribute('aria-pressed', 'true');
});

it.each([
  [
    '运行时成员样式未知时采用运行时主题',
    '?memberStyles=demo-lobby:removed-look&themeId=voxel-world',
    'blueprint',
    'maquette-sandtable',
    'maquette',
    'arch-realistic',
    'voxel-blocks',
  ],
  [
    '运行时成员样式未知时采用成员保存样式',
    '?memberStyles=demo-lobby:removed-look',
    'blueprint',
    'voxel-world',
    'maquette',
    'arch-realistic',
    'blueprint',
  ],
  [
    '组合保存的空间样式编号直接采用目录定义',
    '',
    'removed-look',
    'maquette',
    'blueprint',
    'arch-realistic',
    'maquette',
  ],
  [
    '成员保存样式过期时采用组合保存主题',
    '',
    'removed-look',
    'voxel-world',
    'maquette',
    'arch-realistic',
    'voxel-blocks',
  ],
  [
    '运行时与保存的成员样式均未知时采用组合保存主题',
    '?memberStyles=demo-lobby:removed-look',
    'removed-look',
    'voxel-world',
    'maquette',
    'arch-realistic',
    'voxel-blocks',
  ],
  [
    '成员保存样式为空串时采用组合保存主题',
    '',
    '',
    'voxel-world',
    'maquette',
    'arch-realistic',
    'voxel-blocks',
  ],
  [
    '运行时主题未知时继续采用组合保存主题',
    '?themeId=removed-theme',
    'removed-look',
    'voxel-world',
    'maquette',
    'arch-realistic',
    'voxel-blocks',
  ],
  [
    '上级样式均未知时采用快照默认样式',
    '?memberStyles=demo-lobby:removed-look',
    'removed-look',
    'removed-theme',
    'maquette',
    'blueprint',
    'maquette',
  ],
  [
    '快照默认样式也未知时采用空间信息默认样式',
    '?memberStyles=demo-lobby:removed-look',
    'removed-look',
    'removed-theme',
    'removed-default',
    'blueprint',
    'blueprint',
  ],
  [
    '所有候选样式均未知时采用内置默认样式',
    '?memberStyles=demo-lobby:removed-look',
    'removed-look',
    'removed-theme',
    'removed-default',
    'removed-info-default',
    'arch-realistic',
  ],
] as const)(
  '级联候选回退：`%s`',
  async (_scenario, search, savedStyleId, themeId, sceneDefault, infoDefault, expected) => {
    const s = universe(search);
    const original = s.client.universe;
    vi.spyOn(s.client, 'universe').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        const saved = await original(...args);
        return {
          ...saved,
          themeId,
          members: saved.members.map((member) =>
            member.spaceId === SPACE_ID ? { ...member, styleId: savedStyleId } : member,
          ),
        };
      },
    );
    const snapshot = s.client.snapshot;
    vi.spyOn(s.client, 'snapshot').mockImplementation(
      async (...args: Parameters<typeof snapshot>) => ({
        ...(await snapshot(...args)),
        defaultStyleId: sceneDefault,
      }),
    );
    const space = s.client.space;
    vi.spyOn(s.client, 'space').mockImplementation(async (...args: Parameters<typeof space>) => ({
      ...(await space(...args)),
      defaultStyleId: infoDefault,
    }));
    render(<UniversePage {...s.props} />);
    await waitFor(() => {
      expect(s.views[0]?.last().members).toHaveLength(2);
      const members = s.views[0]!.last().members;
      expect(members.find((m) => m.spaceId === SPACE_ID)!.view.styleId).toBe(expected);
      expect(members.find((m) => m.spaceId === FLORIST_ID)!.view.styleId).toBe(
        search.includes('themeId=voxel-world') ? 'voxel-blocks' : 'spring-greenhouse',
      );
    });
  },
);

it('运行时动作指定未知成员样式时继续采用组合保存主题', async () => {
  const s = universe();
  saveUniverseTheme(s);
  const camera = vi.fn(() => true);
  const factory: typeof s.factory = (host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = camera;
    return view;
  };
  const page = render(<UniversePage {...s.props} createView={factory} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  page.rerender(
    <UniversePage
      {...s.props}
      createView={factory}
      viewerCommand={{
        id: 'unknown-member-look',
        actions: [
          { type: 'look', styleId: 'removed-look', spaceId: SPACE_ID },
          { type: 'camera', kind: 'overview' },
        ],
      }}
    />,
  );
  await waitFor(() => expect(camera).toHaveBeenCalledOnce());
  expect(s.views[0]!.last().members.find((m) => m.spaceId === SPACE_ID)!.view.styleId).toBe(
    'voxel-blocks',
  );
});

it.each(['query', 'click', 'action'] as const)(
  '运行时组合主题覆盖所有成员保存样式（`%s`）',
  async (source) => {
    const s = universe(source === 'query' ? '?themeId=voxel-world' : '');
    render(
      <UniversePage
        {...s.props}
        viewerCommand={
          source === 'action'
            ? {
                id: 'runtime-theme',
                actions: [{ type: 'look', styleId: 'voxel-world' }],
              }
            : undefined
        }
      />,
    );
    if (source === 'click') fireEvent.click(设置按钮('体素方块世界'));
    await waitFor(() => {
      expect(s.views[0]?.last().members).toHaveLength(2);
      expect(
        s.views[0]!.last().members.every(
          (m) => m.view.styleId === 'voxel-blocks' && m.view.style === 'blocks',
        ),
      ).toBe(true);
    });
    expect(设置按钮('体素方块世界')).toHaveAttribute('aria-pressed', 'true');
  },
);

it.each(['query', 'click', 'action'] as const)(
  '运行时各自独立跳过保存主题，恢复成员保存样式与空间默认样式（`%s`）',
  async (source) => {
    const s = universe(source === 'query' ? '?themeId=independent' : '');
    saveUniverseTheme(s);
    const snapshot = s.client.snapshot;
    vi.spyOn(s.client, 'snapshot').mockImplementation(
      async (...args: Parameters<typeof snapshot>) => ({
        ...(await snapshot(...args)),
        defaultStyleId: 'maquette',
      }),
    );
    const page = render(<UniversePage {...s.props} />);
    await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
    if (source !== 'query') {
      expect(s.views[0]!.last().members.find((m) => m.spaceId === SPACE_ID)!.view.styleId).toBe(
        'voxel-blocks',
      );
      expect(设置按钮('体素方块世界')).toHaveAttribute('aria-pressed', 'true');
    }
    if (source === 'click') fireEvent.click(设置按钮('各自独立'));
    if (source === 'action')
      page.rerender(
        <UniversePage
          {...s.props}
          viewerCommand={{
            id: 'independent-theme',
            actions: [{ type: 'look', styleId: 'independent' }],
          }}
        />,
      );
    await waitFor(() => {
      const members = s.views[0]!.last().members;
      expect(members.find((m) => m.spaceId === SPACE_ID)!.view.styleId).toBe('maquette');
      expect(members.find((m) => m.spaceId === FLORIST_ID)!.view.styleId).toBe('spring-greenhouse');
    });
    expect(设置按钮('各自独立')).toHaveAttribute('aria-pressed', 'true');
  },
);

it.each([
  ['blueprint', 'maquette', 'blueprint'],
  [undefined, 'maquette', 'maquette'],
  [undefined, undefined, 'arch-realistic'],
] as const)(
  '空间默认样式依次取快照、空间信息和内置默认值（`%s`，`%s`）',
  async (sceneDefault, infoDefault, expected) => {
    const s = universe('?themeId=independent');
    saveUniverseTheme(s);
    const snapshot = s.client.snapshot;
    const space = s.client.space;
    vi.spyOn(s.client, 'snapshot').mockImplementation(
      async (...args: Parameters<typeof snapshot>) => ({
        ...(await snapshot(...args)),
        defaultStyleId: sceneDefault,
      }),
    );
    vi.spyOn(s.client, 'space').mockImplementation(async (...args: Parameters<typeof space>) => ({
      ...(await space(...args)),
      defaultStyleId: infoDefault,
    }));
    render(<UniversePage {...s.props} />);
    await waitFor(() => {
      expect(s.views[0]?.last().members).toHaveLength(2);
      expect(s.views[0]!.last().members.find((m) => m.spaceId === SPACE_ID)!.view.styleId).toBe(
        expected,
      );
    });
  },
);

it.each(['query', 'sidebar', 'action'] as const)(
  '运行时成员覆盖优先于运行时主题（`%s`）',
  async (source) => {
    const s = universe(
      '?themeId=voxel-world' + (source === 'query' ? '&memberStyles=demo-lobby:maquette' : ''),
    );
    render(
      <UniversePage
        {...s.props}
        viewerCommand={
          source === 'action'
            ? {
                id: 'member-look',
                actions: [{ type: 'look', styleId: 'maquette', spaceId: SPACE_ID }],
              }
            : undefined
        }
      />,
    );
    await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
    if (source === 'sidebar')
      fireEvent.change(成员控件(`${fixtureStore().spaces.get(SPACE_ID)!.name} 样式`), {
        target: { value: 'maquette' },
      });
    await waitFor(() => {
      const members = s.views[0]!.last().members;
      expect(members.find((m) => m.spaceId === SPACE_ID)!.view.styleId).toBe('maquette');
      expect(members.find((m) => m.spaceId === FLORIST_ID)!.view.styleId).toBe('voxel-blocks');
    });
  },
);

it('加载成员原始扫描时保留其他成员的模式，并遵循旧版覆盖', async () => {
  const s = universe('?memberStyles=demo-lobby:raw-scan');
  const page = render(<UniversePage {...s.props} />);
  await waitFor(() =>
    expect(
      s.views[0]?.last().members.find((m) => m.spaceId === SPACE_ID)?.scan?.byteLength,
    ).toBeGreaterThan(0),
  );
  expect(s.views[0]!.last().mode).toBe('raw');
  expect(s.views[0]!.last().members.find((m) => m.spaceId === FLORIST_ID)!.view.mode).toBe(
    'optimized',
  );
  page.unmount();
  const legacy = universe('?view=extended&style=blocks&themeId=night-district');
  render(<UniversePage {...legacy.props} />);
  await waitFor(() => expect(legacy.views[0]?.last().members).toHaveLength(2));
  expect(
    legacy.views[0]!.last().members.every(
      (m) => m.view.mode === 'extended' && m.view.style === 'blocks',
    ),
  ).toBe(true);
});

it('严格模式下仅消费一次跨路由动作，并在样式就绪后发送成员聚焦', async () => {
  const s = universe();
  const actions: ViewerCommand['actions'] = [
    { type: 'look', styleId: 'voxel-blocks', spaceId: SPACE_ID },
    { type: 'camera', kind: 'focus', spaceId: SPACE_ID, entityId: 'shared-chair' },
  ];
  setPendingViewerCommand({ id: 'cross-route', actions });
  const camera = vi.fn((action: CameraAction, content: SceneContent) => {
    expect(content.members).toHaveLength(2);
    expect(content.members.find((m) => m.spaceId === SPACE_ID)!.view.style).toBe('blocks');
    expect(action).toMatchObject(actions[1]!);
    return true;
  });
  const factory: typeof s.factory = (host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = camera;
    return view;
  };
  render(
    <StrictMode>
      <UniversePage {...s.props} createView={factory} />
    </StrictMode>,
  );
  await waitFor(() => expect(camera).toHaveBeenCalledOnce());
  expect(consumePendingViewerCommand()).toBeUndefined();
});

it('执行镜头前先应用传入动作的模式、样式、剖切与主题', async () => {
  const s = universe();
  const camera = vi.fn((_: CameraAction, content: SceneContent) => {
    expect(content.mode).toBe('extended');
    expect(
      content.members.every((m) => m.view.style === 'blocks' && m.view.styleId === 'night-neon'),
    ).toBe(true);
    return true;
  });
  const factory: typeof s.factory = (host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = camera;
    return view;
  };
  const command: ViewerCommand = {
    id: 'universe-prop',
    actions: [
      { type: 'universe', universeId: UNIVERSE_ID },
      { type: 'look', styleId: 'night-district' },
      { type: 'mode', value: 'extended' },
      { type: 'style', value: 'blocks' },
      { type: 'cutaway', height: 1.2 },
      { type: 'camera', kind: 'overview' },
    ],
  };
  const page = render(<UniversePage {...s.props} createView={factory} viewerCommand={command} />);
  await waitFor(() => expect(camera).toHaveBeenCalledOnce());
  expect(s.views[0]!.cutaway).toBe(1.2);
  page.rerender(
    <UniversePage
      {...s.props}
      createView={factory}
      viewerCommand={{ ...command, actions: [...command.actions] }}
    />,
  );
  expect(camera).toHaveBeenCalledOnce();
});

it('调整横向偏移时保留预设纵向偏移与旋转，并响应重复全景请求', async () => {
  const s = universe();
  render(<UniversePage {...s.props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  fireEvent.click(设置按钮('斜向广场'));
  const name = fixtureStore().spaces.get(SPACE_ID)!.name;
  expect(成员控件(`${name} 旋转`)).toHaveValue('90');
  expect(成员控件(`${name} Z 偏移`)).toHaveValue(-10);
  fireEvent.change(成员控件(`${name} X 偏移`), { target: { value: '-20' } });
  await waitFor(() =>
    expect(s.views[0]!.last().members[0]!.placement).toEqual({
      offset: [-20, 0, -10],
      rotation: 90,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '全景总览' }));
  fireEvent.click(screen.getByRole('button', { name: '全景总览' }));
  expect(s.views[0]!.frameContent).toHaveBeenCalledTimes(2);
});

it('物件编号重复时仅聚焦指定成员', async () => {
  const s = universe();
  render(<UniversePage {...s.props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  const content = s.views[0]!.last();
  const first = content.members[0]!;
  const second = content.members[1]!;
  const entity = first.view.entities.find((e) => e.bounds)!;
  expect(entity).toBeDefined();
  const duplicate = {
    ...entity,
    entityId: 'duplicate',
    bounds: { min: [0, 0, 0], max: [2, 2, 2] } as const,
  };
  const scene = {
    ...content,
    members: [first, second].map((member) => ({
      ...member,
      view: { ...member.view, entities: [duplicate] },
    })),
  };
  const select = vi.fn();
  const flyTo = vi.fn();
  const receiver = { flyTo, select, options: { onSelect: vi.fn() } };
  expect(
    SceneView.prototype.applyCamera.call(
      receiver as unknown as SceneView,
      { kind: 'focus', entityId: 'duplicate', spaceId: second.spaceId },
      scene,
    ),
  ).toBe(true);
  expect(select).toHaveBeenCalledWith({ spaceId: second.spaceId, entity: duplicate });
  expect(flyTo.mock.calls[0]![0].toArray()).toEqual([5, 1, 11]);
  expect(
    SceneView.prototype.applyCamera.call(
      receiver as unknown as SceneView,
      { kind: 'focus', entityId: 'duplicate', spaceId: 'missing' },
      scene,
    ),
  ).toBe(false);
});

it.each(['空间页', '预览页'] as const)(
  '%s 切换命名样式释放地址中的模式与画法覆盖并加载扫描叠加',
  async (pageType) => {
    window.history.replaceState(
      null,
      '',
      `${pageType === '空间页' ? '/s/demo-lobby' : '/preview'}?view=raw&style=blocks#share=保留令牌`,
    );
    const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
    const s = fakeViewFactory();
    render(
      pageType === '空间页' ? (
        <SpacePage spaceId={SPACE_ID} client={client} hasShareToken createView={s.factory} />
      ) : (
        <PreviewPage token={PREVIEW_TOKEN} client={client} createView={s.factory} />
      ),
    );
    await waitFor(() => expect(s.views[0]?.last().members[0]?.view.showScan).toBe(true));
    fireEvent.click(设置按钮('工程蓝图'));
    await waitFor(() =>
      expect(s.views[0]!.last().members[0]!.view).toMatchObject({
        styleId: 'blueprint',
        mode: 'optimized',
        style: 'shapes',
        showScan: false,
      }),
    );
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
    expect(new URLSearchParams(window.location.search).has('style')).toBe(false);
    expect(window.location.hash).toBe('#share=%E4%BF%9D%E7%95%99%E4%BB%A4%E7%89%8C');
    fireEvent.click(设置按钮(/扫描重建叠加/));
    await waitFor(() => {
      const member = s.views[0]!.last().members[0]!;
      expect(member.view).toMatchObject({ mode: 'optimized', showScan: true });
      expect(member.scan?.byteLength).toBeGreaterThan(0);
      expect(member.view.entities.length).toBeGreaterThan(0);
      expect(member.view.entities.every((entity) => entity.layer === 'rebuilt')).toBe(true);
    });
  },
);

it('空间命名样式动作释放历史覆盖，动作序列按顺序恢复后续显式覆盖', async () => {
  window.history.replaceState(null, '', '/s/demo-lobby?view=raw&style=blocks');
  const client = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const s = fakeViewFactory();
  const camera = vi.fn(() => true);
  const factory: typeof s.factory = (host, options) => {
    const view = s.factory(host, options);
    view.applyCamera = camera;
    return view;
  };
  const props = { spaceId: SPACE_ID, client, hasShareToken: true, createView: factory };
  const page = render(<SpacePage {...props} />);
  await waitFor(() => expect(s.views[0]?.last().members[0]?.view.showScan).toBe(true));
  const apply = (id: string, actions: ViewerCommand['actions']) =>
    page.rerender(<SpacePage {...props} viewerCommand={{ id, actions }} />);
  apply('release', [{ type: 'look', styleId: 'blueprint' }]);
  await waitFor(() =>
    expect(s.views[0]!.last().members[0]!.view).toMatchObject({
      mode: 'optimized',
      style: 'shapes',
      styleId: 'blueprint',
    }),
  );
  apply('before', [
    { type: 'mode', value: 'raw' },
    { type: 'style', value: 'blocks' },
    { type: 'look', styleId: 'blueprint' },
    { type: 'camera', kind: 'overview' },
  ]);
  await waitFor(() => expect(camera).toHaveBeenCalledOnce());
  expect(s.views[0]!.last().members[0]!.view).toMatchObject({ mode: 'optimized', style: 'shapes' });
  apply('after', [
    { type: 'look', styleId: 'extension-only' },
    { type: 'mode', value: 'extended' },
    { type: 'style', value: 'blocks' },
  ]);
  await waitFor(() => {
    const view = s.views[0]!.last().members[0]!.view;
    expect(view).toMatchObject({ mode: 'extended', style: 'blocks' });
    expect(view.voxels.chunks.some((chunk) => chunk.layer === 'rebuilt')).toBe(true);
  });
});

it('组合主题和局部样式切换释放历史覆盖，局部操作保持其他成员样式', async () => {
  const s = universe('?view=raw&style=blocks');
  render(<UniversePage {...s.props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  fireEvent.click(设置按钮('工程蓝图总览'));
  await waitFor(() =>
    expect(
      s.views[0]!.last().members.every(
        (member) => member.view.mode === 'optimized' && member.view.style === 'shapes',
      ),
    ).toBe(true),
  );
  expect(new URLSearchParams(window.location.search).get('themeId')).toBe('blueprint-atlas');
  fireEvent.click(
    within(screen.getByRole('group', { name: '视图模式' })).getByRole('button', { name: '原始' }),
  );
  fireEvent.change(成员控件(`${fixtureStore().spaces.get(SPACE_ID)!.name} 样式`), {
    target: { value: 'extension-only' },
  });
  await waitFor(() => {
    const members = s.views[0]!.last().members;
    const local = members.find((member) => member.spaceId === SPACE_ID)!.view;
    expect(local.entities.length).toBeGreaterThan(0);
    expect(local.entities.every((entity) => entity.layer === 'ext')).toBe(true);
    expect(local.voxels.chunks.every((chunk) => chunk.layer === 'ext')).toBe(true);
    expect(members.find((member) => member.spaceId === FLORIST_ID)!.view).toMatchObject({
      styleId: 'blueprint',
      mode: 'optimized',
      style: 'shapes',
    });
  });
});

it('全局命名样式动作可被后续主题和各自独立替换，保留真正的局部覆盖', async () => {
  const s = universe('?view=raw&style=blocks');
  const page = render(<UniversePage {...s.props} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  const apply = (id: string, actions: ViewerCommand['actions']) =>
    page.rerender(<UniversePage {...s.props} viewerCommand={{ id, actions }} />);
  apply('global', [{ type: 'look', styleId: 'blueprint' }]);
  await waitFor(() =>
    expect(
      s.views[0]!.last().members.every(
        (member) =>
          member.view.styleId === 'blueprint' &&
          member.view.mode === 'optimized' &&
          member.view.style === 'shapes',
      ),
    ).toBe(true),
  );
  expect(new URLSearchParams(window.location.search).get('look')).toBe('blueprint');
  expect(new URLSearchParams(window.location.search).has('memberStyles')).toBe(false);
  fireEvent.click(设置按钮('体素方块世界'));
  await waitFor(() =>
    expect(
      s.views[0]!.last().members.every(
        (member) => member.view.styleId === 'voxel-blocks' && member.view.style === 'blocks',
      ),
    ).toBe(true),
  );
  apply('global-again', [{ type: 'look', styleId: 'night-neon' }]);
  await waitFor(() =>
    expect(s.views[0]!.last().members.every((member) => member.view.styleId === 'night-neon')).toBe(
      true,
    ),
  );
  apply('theme', [{ type: 'look', styleId: 'gallery-day' }]);
  await waitFor(() =>
    expect(
      s.views[0]!.last().members.every((member) => member.view.styleId === 'arch-realistic'),
    ).toBe(true),
  );
  apply('local', [
    { type: 'mode', value: 'raw' },
    { type: 'style', value: 'blocks' },
    { type: 'look', styleId: 'extension-only', spaceId: SPACE_ID },
  ]);
  await waitFor(() =>
    expect(
      s.views[0]!.last().members.find((member) => member.spaceId === SPACE_ID)!.view.styleId,
    ).toBe('extension-only'),
  );
  expect(
    s.views[0]!.last().members.find((member) => member.spaceId === FLORIST_ID)!.view,
  ).toMatchObject({ mode: 'optimized', style: 'shapes' });
  fireEvent.click(设置按钮('各自独立'));
  await waitFor(() => {
    const members = s.views[0]!.last().members;
    expect(members.find((member) => member.spaceId === SPACE_ID)!.view.styleId).toBe(
      'extension-only',
    );
    expect(members.find((member) => member.spaceId === FLORIST_ID)!.view.styleId).toBe(
      'spring-greenhouse',
    );
  });
  expect(new URLSearchParams(window.location.search).get('themeId')).toBe('independent');
});

it('组合成员扫描叠加与扩展层样式同场加载', async () => {
  const s = universe('?memberStyles=demo-lobby:scan-rebuilt-overlay,demo-florist:extended-full');
  render(<UniversePage {...s.props} />);
  await waitFor(() => {
    const member = s.views[0]?.last().members.find((candidate) => candidate.spaceId === SPACE_ID);
    expect(member?.view).toMatchObject({ mode: 'optimized', showScan: true });
    expect(member?.scan?.byteLength).toBeGreaterThan(0);
  });
  expect(
    s.views[0]!.last().members.find((member) => member.spaceId === FLORIST_ID)!.view,
  ).toMatchObject({ mode: 'extended', showScan: false });
});

it.each(['仅扫描', '扫描缺失', '空图层'] as const)(
  '命名样式采用非原始模式时按实际图层显示内容提示：%s',
  async (scenario) => {
    window.history.replaceState(null, '', '/s/demo-lobby?look=selected-layers');
    const base = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
    const snapshot = base.snapshot;
    const client = {
      ...base,
      snapshot: vi.fn(async (...args: Parameters<typeof snapshot>) => ({
        ...(await snapshot(...args)),
        ...(scenario === '扫描缺失' ? { scan: null } : {}),
        styles: [
          {
            id: 'selected-layers',
            name: '选择图层',
            mode: 'optimized' as const,
            visibleLayers: scenario === '空图层' ? [] : ['scan' as const],
          },
        ],
      })),
    };
    const s = fakeViewFactory();
    render(<SpacePage spaceId={SPACE_ID} client={client} hasShareToken createView={s.factory} />);
    await waitFor(() =>
      expect(s.views[0]?.last().members[0]?.view.styleId).toBe('selected-layers'),
    );
    if (scenario === '仅扫描') {
      expect(s.views[0]!.last().members[0]!.scan?.byteLength).toBeGreaterThan(0);
      expect(screen.queryByText(/没有优化模型|没有可见内容/)).toBeNull();
    } else if (scenario === '扫描缺失')
      expect(screen.getByText('这个时刻之前还没有导入扫描模型。')).toBeInTheDocument();
    else
      expect(
        screen.getByText('当前样式没有可见内容，可以切换样式或查看模式。'),
      ).toBeInTheDocument();
  },
);

it('普通空间保留自身模型，同时渲染子空间并按实例保存样式覆盖', async () => {
  const root = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const florist = createPublicClient({
    share: fixtureStore().spaces.get(FLORIST_ID)!.shareToken,
    fetch: fixtureFetch,
  });
  const client = {
    ...root,
    space: async (id: string) => ({ ...(await root.space(id)), compositionEnabled: true }),
    scene: vi.fn(async () => ({
      id: SPACE_ID,
      name: '含内容的组合空间',
      seq: 4,
      at: new Date().toISOString(),
      links: [],
      members: [
        {
          spaceId: SPACE_ID,
          sourceSpaceId: SPACE_ID,
          accessPath: null,
          name: '演示前厅',
          seq: 4,
          offset: [0, 0, 0] as const,
          rotation: 0 as const,
        },
        {
          spaceId: `${SPACE_ID}/${FLORIST_ID}`,
          sourceSpaceId: FLORIST_ID,
          accessPath: SPACE_ID,
          name: '街角花店',
          seq: 2,
          offset: [120, 0, 240] as const,
          rotation: 180 as const,
        },
      ],
    })),
    forComposition: (path: string | null) => (path ? florist : root),
  };
  const s = fakeViewFactory();
  render(<SpacePage spaceId={SPACE_ID} client={client} hasShareToken createView={s.factory} />);
  await waitFor(() => expect(s.views[0]?.last().members).toHaveLength(2));
  expect(s.views).toHaveLength(1);
  expect(s.views[0]!.last().members[0]!.view.entities.length).toBeGreaterThan(20);
  expect(s.views[0]!.last().members[1]).toMatchObject({
    spaceId: `${SPACE_ID}/${FLORIST_ID}`,
    placement: { offset: [120, 0, 240], rotation: 180 },
  });
  fireEvent.change(成员控件('街角花店 样式'), { target: { value: 'blueprint' } });
  await waitFor(() => expect(s.views[0]!.last().members[1]!.view.styleId).toBe('blueprint'));
  expect(new URLSearchParams(window.location.search).get('memberStyles')).toBe(
    `${SPACE_ID}/${FLORIST_ID}:blueprint`,
  );
});

it('组合与单空间共用 look 参数和样式画廊，切换后保留旧主题入口', async () => {
  const s = universe('?look=holo-arena&themeId=blueprint-atlas');
  render(<UniversePage {...s.props} />);
  await waitFor(() => {
    const members = s.views[0]?.last().members;
    expect(members).toHaveLength(2);
    expect(members?.every((member) => member.view.styleLook?.hologram === 'detail')).toBe(true);
  });
  expect(设置按钮('全息场')).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(设置按钮('白模沙盘'));
  expect(new URLSearchParams(location.search).get('look')).toBe('maquette');
  expect(new URLSearchParams(location.search).has('themeId')).toBe(false);
  fireEvent.click(设置按钮('各自独立'));
  expect(new URLSearchParams(location.search).has('look')).toBe(false);
});
