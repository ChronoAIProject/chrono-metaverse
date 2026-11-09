import { vi } from 'vitest';
import type { ViewContent } from '../core/scene';
import type { SceneViewFactory, SceneViewLike } from '../viewer/Viewer';

/** jsdom 没有 WebGL：测试用的假场景，记录收到的内容和参数。 */
export interface FakeView extends SceneViewLike {
  readonly contents: ViewContent[];
  readonly scans: (ArrayBuffer | null | undefined)[];
  cutaway: number | null;
}

export function fakeViewFactory(): { factory: SceneViewFactory; views: FakeView[] } {
  const views: FakeView[] = [];
  const factory: SceneViewFactory = () => {
    const view: FakeView = {
      contents: [],
      scans: [],
      cutaway: null,
      setContent(content, scan) {
        view.contents.push(content);
        view.scans.push(scan);
      },
      setCutaway(height) {
        view.cutaway = height;
      },
      setAnchorStates: vi.fn(),
      frameContent: vi.fn(),
      getStats() {
        const last = view.contents[view.contents.length - 1];
        return {
          entities: last?.entities.length ?? 0,
          triangles: 0,
          voxelFaces: last?.voxels.size ?? 0,
          hasScan: last?.showScan ?? false,
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
