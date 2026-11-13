import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPublicClient } from '../core/api/client';
import type { SceneContent } from '../core/scene';
import { resetFixtureStore, SHARE_TOKEN, SPACE_ID, fixtureStore } from '../fixtures';
import { fixtureFetch } from '../fixtures/server';
import type { SceneViewFactory } from '../viewer/Viewer';
import type { CameraAction } from '../workspace/viewerActions';
import { SpacePage } from './SpacePage';

beforeEach(() => {
  resetFixtureStore();
  window.history.replaceState(null, '', '/workspace');
});
function setup() {
  const baseClient = createPublicClient({ share: SHARE_TOKEN, fetch: fixtureFetch });
  const base = fixtureStore().snapshot(4)!;
  const target = base.entities.find(
    (e) => e.body.bounds && e.body.kind === 'object' && e.body.layer === 'rebuilt',
  )!;
  const client = {
    ...baseClient,
    preview: vi.fn(async (token: string) => {
      if (token === 'expired') throw { status: 404 };
      const delta = token === 'first' ? 0.25 : 0.5;
      const entities = base.entities.map((e) => {
        if (e.id !== target.id || !e.body.bounds) return e;
        const { min, max } = e.body.bounds;
        return {
          ...e,
          body: {
            ...e.body,
            bounds: {
              min: [min[0] + delta, min[1], min[2]] as const,
              max: [max[0] + delta, max[1], max[2]] as const,
            },
          },
        };
      });
      return {
        ...base,
        entities,
        spaceName: '草稿测试',
        preview: {
          draftId: 'draft',
          rev: token === 'first' ? 1 : 2,
          baseSeq: 4,
          scope: 'rebuild',
          expiresAt: '2099-01-01T00:00:00Z',
        },
      };
    }),
    previewChunk: (_token: string, hash: string) => baseClient.chunk(hash),
  };
  const contents: SceneContent[] = [];
  const dispose = vi.fn();
  let cutHeight: number | null = null;
  const cameraCuts: (number | null)[] = [];
  const camera = vi.fn<(action: CameraAction, content: SceneContent) => boolean>(() => {
    cameraCuts.push(cutHeight);
    return true;
  });
  const createView = vi.fn<SceneViewFactory>(() => ({
    setContent: async (content) => {
      contents.push(content);
    },
    setVisuals: vi.fn(),
    setCutaway: (height) => {
      cutHeight = height;
    },
    select: vi.fn(),
    frameContent: vi.fn(),
    setShowAllLabels: vi.fn(),
    dispose,
    applyCamera: camera,
    getStats: () => ({
      entities: 1,
      triangles: 0,
      voxelFaces: 0,
      hasScan: false,
      scanCeiling: null,
      instancedBatches: 0,
      instancedEntities: 0,
      textured: 0,
      threaded: false,
      members: 1,
      warnings: [],
    }),
  }));
  return { client, contents, dispose, createView, camera, cameraCuts };
}
it('keeps one viewer through published → draft → new draft → published, and retains published scene data', async () => {
  const s = setup();
  const view = render(
    <SpacePage
      spaceId={SPACE_ID}
      client={s.client}
      hasShareToken
      createView={s.createView}
      embedded
    />,
  );
  await waitFor(() => expect(s.contents.length).toBeGreaterThan(0));
  const canvasHost = view.container.querySelector('.viewer');
  const published = s.contents.at(-1)!;
  view.rerender(
    <SpacePage
      spaceId={SPACE_ID}
      client={s.client}
      hasShareToken
      createView={s.createView}
      previewToken="first"
      embedded
    />,
  );
  await screen.findByText('基于版本 #4 · 草稿修订 1 · 尚未发布');
  await waitFor(() => expect(s.contents.at(-1)!.members[0]!.name).toBe('草稿测试'));
  const first = s.contents.at(-1)!;
  view.rerender(
    <SpacePage
      spaceId={SPACE_ID}
      client={s.client}
      hasShareToken
      createView={s.createView}
      previewToken="second"
      embedded
    />,
  );
  await screen.findByText('基于版本 #4 · 草稿修订 2 · 尚未发布');
  await waitFor(() => expect(s.contents.at(-1)).not.toBe(first));
  expect(s.contents.at(-1)!.members[0]!.view.entities).not.toEqual(first.members[0]!.view.entities);
  view.rerender(
    <SpacePage
      spaceId={SPACE_ID}
      client={s.client}
      hasShareToken
      createView={s.createView}
      embedded
    />,
  );
  await waitFor(() =>
    expect(s.contents.at(-1)!.members[0]!.view.entities).toEqual(
      published.members[0]!.view.entities,
    ),
  );
  expect(view.container.querySelector('.viewer')).toBe(canvasHost);
  expect(s.createView).toHaveBeenCalledTimes(1);
  expect(s.dispose).not.toHaveBeenCalled();
  expect(s.client.preview).toHaveBeenCalledTimes(2);
});
it('validates a new preview even while the renderer has cached model data', async () => {
  const s = setup();
  const view = render(
    <SpacePage spaceId={SPACE_ID} client={s.client} hasShareToken createView={s.createView} />,
  );
  await waitFor(() => expect(s.contents.length).toBeGreaterThan(0));
  const count = s.contents.length;
  view.rerender(
    <SpacePage
      spaceId={SPACE_ID}
      client={s.client}
      hasShareToken
      createView={s.createView}
      previewToken="expired"
    />,
  );
  await screen.findByRole('heading', { name: '打不开这个预览' });
  expect(s.contents).toHaveLength(count);
  expect(view.container.querySelector('.viewer')).toBeNull();
});

it('revalidates a previously opened preview and rejects it after revocation', async () => {
  const s = setup();
  const props = {
    spaceId: SPACE_ID,
    client: s.client,
    hasShareToken: true,
    createView: s.createView,
  };
  const view = render(<SpacePage {...props} previewToken="first" />);
  await screen.findByText('基于版本 #4 · 草稿修订 1 · 尚未发布');
  view.rerender(<SpacePage {...props} />);
  await waitFor(() => expect(s.contents.at(-1)!.members[0]!.name).not.toBe('草稿测试'));
  const count = s.contents.length;
  s.client.preview.mockRejectedValueOnce({ status: 404 });
  view.rerender(<SpacePage {...props} previewToken="first" />);
  await screen.findByRole('heading', { name: '打不开这个预览' });
  expect(s.contents).toHaveLength(count);
  expect(s.client.preview).toHaveBeenCalledTimes(2);
});

it('applies all camera actions after the requested scene mode is ready, once per response', async () => {
  const s = setup();
  const props = {
    spaceId: SPACE_ID,
    client: s.client,
    hasShareToken: true,
    createView: s.createView,
  };
  const view = render(<SpacePage {...props} />);
  await waitFor(() => expect(s.contents.length).toBeGreaterThan(0));
  const actions = [
    { type: 'mode', value: 'extended' },
    { type: 'camera', kind: 'overview' },
    { type: 'camera', kind: 'zoom', factor: 0.5 },
  ] as const;
  const command = { id: 'resp_camera', actions: [...actions] };
  view.rerender(<SpacePage {...props} viewerCommand={command} />);
  await waitFor(() => expect(s.camera).toHaveBeenCalledTimes(2));
  expect(s.camera.mock.calls.every((call) => call[1].mode === 'extended')).toBe(true);
  view.rerender(
    <SpacePage {...props} viewerCommand={{ ...command, actions: [...command.actions] }} />,
  );
  expect(s.camera).toHaveBeenCalledTimes(2);
});

it('frames the scene using the requested cutaway before moving the camera, including same-scene commands', async () => {
  const s = setup();
  const props = {
    spaceId: SPACE_ID,
    client: s.client,
    hasShareToken: true,
    createView: s.createView,
  };
  const view = render(<SpacePage {...props} />);
  await waitFor(() => expect(s.contents.length).toBeGreaterThan(0));
  for (const [i, height] of [0.5, null].entries()) {
    view.rerender(
      <SpacePage
        {...props}
        viewerCommand={{
          id: `cut_${i}`,
          actions: [
            { type: 'cutaway', height },
            { type: 'camera', kind: 'overview' },
          ],
        }}
      />,
    );
    await waitFor(() => expect(s.cameraCuts).toHaveLength(i + 1));
    expect(s.cameraCuts[i]).toBe(height);
  }
  expect(s.createView).toHaveBeenCalledTimes(1);
});
