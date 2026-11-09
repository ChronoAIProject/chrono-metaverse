import { useCallback, useEffect, useState } from 'react';

/**
 * 页面路由。照搬 CMA web/src/routing/routes.ts 的写法：路径和路由对象一一对应、
 * 可以往返转换，不引入路由库。
 *
 * - `/s/<空间编号>#share=<分享令牌>`：查看一个空间；
 * - `/u/<组合编号>#share=<分享令牌>`：查看组合宇宙；
 * - `/preview#t=<预览令牌>`：草稿预览；
 * - `/`：首页。
 *
 * 令牌在 `#` 后面，不属于路由，也不会发给服务器。
 */
export type AppRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'space'; readonly spaceId: string }
  | { readonly kind: 'universe'; readonly universeId: string }
  | { readonly kind: 'preview' }
  | { readonly kind: 'not_found'; readonly pathname: string };

function decodeSegment(value: string): string | null {
  if (value === '') return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded !== '' && decoded !== '.' && decoded !== '..' && !decoded.includes('/')
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '') return { kind: 'home' };
  if (pathname === '/preview') return { kind: 'preview' };
  if (!pathname.startsWith('/') || pathname.endsWith('/')) return { kind: 'not_found', pathname };
  const segments = pathname.slice(1).split('/').map(decodeSegment);
  if (segments.some((s) => s === null)) return { kind: 'not_found', pathname };
  const [resource, id, ...rest] = segments as string[];
  if (rest.length === 0 && id !== undefined) {
    if (resource === 's') return { kind: 'space', spaceId: id };
    if (resource === 'u') return { kind: 'universe', universeId: id };
  }
  return { kind: 'not_found', pathname };
}

export function routePath(route: AppRoute): string {
  switch (route.kind) {
    case 'home':
      return '/';
    case 'space':
      return `/s/${encodeURIComponent(route.spaceId)}`;
    case 'universe':
      return `/u/${encodeURIComponent(route.universeId)}`;
    case 'preview':
      return '/preview';
    case 'not_found':
      return route.pathname;
  }
}

export interface AppRouter {
  readonly route: AppRoute;
  readonly navigate: (
    route: AppRoute,
    options?: { readonly hash?: string; readonly replace?: boolean },
  ) => void;
}

export function useAppRouter(): AppRouter {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = useCallback<AppRouter['navigate']>((next, options) => {
    const url = routePath(next) + (options?.hash ?? '');
    if (options?.replace === true) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    setRoute(parseRoute(routePath(next)));
  }, []);
  return { route, navigate };
}
