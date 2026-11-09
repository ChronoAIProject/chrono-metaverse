import { useCallback, useEffect, useState } from 'react';
import type { RebuiltStyle } from '../core/scene';

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
 * 页面的显示选项放在查询参数里（目前只有重建层画法 `?style=blocks`），不碰 `#` 后面的令牌。
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

/** 查询参数里记住的重建层画法的键。 */
export const STYLE_PARAM = 'style';

/** 地址里记住的重建层画法：`?style=blocks` 是方块；没有或不认识的值是默认的形状。 */
export function styleFromSearch(search: string): RebuiltStyle {
  return new URLSearchParams(search).get(STYLE_PARAM) === 'blocks' ? 'blocks' : 'shapes';
}

/** 换掉查询参数里的画法（默认的形状不写），其他参数原样保留。返回 `''` 或 `?…`。 */
export function searchWithStyle(search: string, style: RebuiltStyle): string {
  const params = new URLSearchParams(search);
  if (style === 'blocks') params.set(STYLE_PARAM, 'blocks');
  else params.delete(STYLE_PARAM);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * 重建层画法（形状 / 方块），记在地址的查询参数里：刷新、复制链接都保留。
 * 只换查询参数，路径和 `#share=…` 原样保留；用 replaceState，不新增历史记录。
 */
export function useRebuiltStyle(): readonly [RebuiltStyle, (style: RebuiltStyle) => void] {
  const [style, setStyle] = useState<RebuiltStyle>(() => styleFromSearch(window.location.search));
  const change = useCallback((next: RebuiltStyle) => {
    setStyle(next);
    const { pathname, search, hash } = window.location;
    const nextSearch = searchWithStyle(search, next);
    if (nextSearch !== search) {
      window.history.replaceState(window.history.state, '', `${pathname}${nextSearch}${hash}`);
    }
  }, []);
  return [style, change] as const;
}
