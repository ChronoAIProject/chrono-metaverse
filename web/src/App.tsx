import { useEffect, useMemo, useState } from 'react';
import { WorkspacePage } from './workspace/WorkspacePage';
import { ConnectPage } from './auth/ConnectPage';
import {
  createPublicClient,
  previewTokenFromHash,
  shareTokenFromHash,
  type PublicClient,
} from './core/api/client';
import { parseRoute, routePath, useAppRouter } from './routing/routes';
import { PreviewPage } from './space/PreviewPage';
import { SpacePage } from './space/SpacePage';
import { UniversePage } from './space/UniversePage';
import type { SceneViewFactory } from './viewer/Viewer';
import './styles/tokens.css';
import './styles/design-platform.css';
import './styles/effects-typography.css';
import './styles/scrollbar.css';
import './styles/base.css';
import './App.css';

/** 夹具里的链接（只在 `npm run dev:fixtures` 时显示在首页）。 */
export const FIXTURE_LINK = '/s/demo-lobby#share=fixture-share-token-0123456789abcdef';
export const FIXTURE_UNIVERSE_LINK =
  '/u/demo-street#share=fixture-universe-token-00112233445566778899';
export const FIXTURE_PREVIEW_LINK =
  '/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899';
export const FIXTURE_MATERIALS_LINK =
  '/s/demo-materials#share=fixture-materials-token-13579bdf2468ace0';

export interface AppProps {
  /**
   * 按令牌建客户端；测试里换成夹具。组合页给出组合编号，
   * 客户端的每个请求都带 `?universe=<编号>`。
   */
  readonly createClient?: (share: string | null, universe?: string) => PublicClient;
  readonly createView?: SceneViewFactory;
  readonly showFixtureLink?: boolean;
}

function useFragment(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash;
}

function Home({ showFixtureLink }: { readonly showFixtureLink: boolean }) {
  return (
    <main className="home">
      <div className="home__card">
        <h1>chrono-metaverse 查看器</h1>
        <p>
          实体空间的数字孪生和虚拟扩展，按一条时间线记录和回放。描述需求，由在线 CMA worker
          建造；凭分享链接查看与回放。
        </p>
        <p className="home__hint">
          空间链接形如 <code>/s/空间编号#share=分享令牌</code>，组合链接形如{' '}
          <code>/u/组合编号#share=分享令牌</code>。
        </p>
        <a className="home__link" href="/workspace">
          打开在线工作台
        </a>
        <a className="home__link home__link--quiet" href="/connect">
          连接 NyxID
        </a>
        {showFixtureLink && (
          <div className="home__links">
            <a className="home__link" href={FIXTURE_LINK}>
              打开夹具空间"演示前厅"
            </a>
            <a className="home__link home__link--quiet" href={FIXTURE_UNIVERSE_LINK}>
              组合"街角"（前厅 + 花店）
            </a>
            <a className="home__link home__link--quiet" href={FIXTURE_PREVIEW_LINK}>
              草稿预览
            </a>
            <a className="home__link home__link--quiet" href={FIXTURE_MATERIALS_LINK}>
              材质样板（平铺、法线、粗糙度）
            </a>
          </div>
        )}
      </div>
    </main>
  );
}

function Message({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <main className="home">
      <div className="home__card" role="alert">
        <h1>{title}</h1>
        <p>{text}</p>
        <a className="home__link" href={routePath({ kind: 'home' })}>
          回到首页
        </a>
      </div>
    </main>
  );
}

export function App({
  createClient = (share, universe) => createPublicClient({ share, universe }),
  createView,
  showFixtureLink = import.meta.env.MODE === 'fixtures',
}: AppProps) {
  const { route } = useAppRouter();
  const fragment = useFragment();
  const share = shareTokenFromHash(fragment);
  const universeId = route.kind === 'universe' ? route.universeId : undefined;
  const client = useMemo(
    () => (route.kind === 'preview' ? createClient(null) : createClient(share, universeId)),
    [createClient, share, universeId, route.kind],
  );

  switch (route.kind) {
    case 'home':
      return <Home showFixtureLink={showFixtureLink} />;
    case 'connect':
      return <ConnectPage />;
    case 'workspace':
      return <WorkspacePage />;
    case 'space':
      return (
        <SpacePage
          key={`${route.spaceId}#${share ?? ''}`}
          spaceId={route.spaceId}
          client={client}
          hasShareToken={share !== null}
          createView={createView}
        />
      );
    case 'universe':
      return (
        <UniversePage
          key={`${route.universeId}#${share ?? ''}`}
          universeId={route.universeId}
          client={client}
          hasShareToken={share !== null}
          createView={createView}
        />
      );
    case 'preview': {
      const token = previewTokenFromHash(fragment);
      return (
        <PreviewPage key={token ?? ''} token={token} client={client} createView={createView} />
      );
    }
    case 'not_found':
      return <Message title="找不到这个页面" text={`地址 ${route.pathname} 不是有效的链接。`} />;
  }
}

export { parseRoute };
