import { vi } from 'vitest';
import type { SceneContent } from '../core/scene';
import type { Visual } from '../core/visuals';
import type { SceneViewFactory, SceneViewLike } from '../viewer/Viewer';

/** jsdom 没有 WebGL：测试用的假场景，记录收到的内容和参数。 */
export interface FakeView extends SceneViewLike {
  readonly contents: SceneContent[];
  readonly visuals: (readonly Visual[])[];
  cutaway: number | null;
  /** 最后一次的内容（只看第一个成员的视图）。 */
  last(): SceneContent;
}

export function fakeViewFactory(): { factory: SceneViewFactory; views: FakeView[] } {
  const views: FakeView[] = [];
  const factory: SceneViewFactory = () => {
    const view: FakeView = {
      contents: [],
      visuals: [],
      cutaway: null,
      last() {
        const content = view.contents[view.contents.length - 1];
        if (content === undefined) throw new Error('还没有内容');
        return content;
      },
      async setContent(content) {
        view.contents.push(content);
      },
      setVisuals(visuals) {
        view.visuals.push(visuals);
      },
      setCutaway(height) {
        view.cutaway = height;
      },
      select: vi.fn(),
      frameContent: vi.fn(),
      getStats() {
        const last = view.contents[view.contents.length - 1];
        return {
          entities: last?.members.reduce((n, m) => n + m.view.entities.length, 0) ?? 0,
          triangles: 0,
          voxelFaces: last?.members.reduce((n, m) => n + m.view.voxels.chunks.length, 0) ?? 0,
          hasScan: last?.members.some((m) => m.view.showScan) ?? false,
          instancedBatches: 0,
          instancedEntities: 0,
          textured: 0,
          threaded: false,
          members: last?.members.length ?? 0,
          warnings: [],
        };
      },
      dispose: vi.fn(),
    };
    views.push(view);
    return view;
  };
  return { factory, views };
}
