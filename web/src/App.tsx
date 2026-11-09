import { useEffect, useMemo, useState } from 'react';
import { createPublicClient, shareTokenFromHash, type PublicClient } from './core/api/client';
import { parseRoute, routePath, useAppRouter } from './routing/routes';
import { SpacePage } from './space/SpacePage';
import type { SceneViewFactory } from './viewer/Viewer';
import './styles/tokens.css';
import './styles/design-platform.css';
import './styles/effects-typography.css';
import './styles/scrollbar.css';
import './styles/base.css';
import './App.css';

/** 夹具空间的链接（只在 `npm run dev:fixtures` 时显示在首页）。 */
export const FIXTURE_LINK = '/s/demo-lobby#share=fixture-share-token-0123456789abcdef';

export interface AppProps {
  /** 按分享令牌建客户端；测试里换成夹具。 */
  readonly createClient?: (share: string | null) => PublicClient;
  readonly createView?: SceneViewFactory;
  readonly showFixtureLink?: boolean;
}

function useShareToken(): string | null {
  const [token, setToken] = useState(() => shareTokenFromHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setToken(shareTokenFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return token;
}

function Home({ showFixtureLink }: { readonly showFixtureLink: boolean }) {
  return (
    <main className="home">
      <div className="home__card">
        <h1>chrono-metaverse 查看器</h1>
        <p>实体空间的数字孪生和虚拟扩展，按一条时间线记录和回放。网站只读，凭分享链接打开空间。</p>
        <p className="home__hint">
          空间链接形如 <code>/s/空间编号#share=分享令牌</code>。
        </p>
        {showFixtureLink && (
          <a className="home__link" href={FIXTURE_LINK}>
            打开夹具空间"演示前厅"
          </a>
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
  createClient = (share) => createPublicClient({ share }),
  createView,
  showFixtureLink = import.meta.env.MODE === 'fixtures',
}: AppProps) {
  const { route } = useAppRouter();
  const share = useShareToken();
  const client = useMemo(() => createClient(share), [createClient, share]);

  switch (route.kind) {
    case 'home':
      return <Home showFixtureLink={showFixtureLink} />;
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
        <Message
          title="组合视图还没有上线"
          text="第一版只支持查看单个空间，组合宇宙的查看会在后续版本提供。"
        />
      );
    case 'not_found':
      return <Message title="找不到这个页面" text={`地址 ${route.pathname} 不是有效的链接。`} />;
  }
}

export { parseRoute };
