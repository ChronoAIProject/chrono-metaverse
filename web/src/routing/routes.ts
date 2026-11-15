import { useCallback, useEffect, useState } from 'react';
import { VIEW_MODES, type RebuiltStyle, type ViewMode } from '../core/scene';
import { isStyleId } from '../core/styles';

/**
 * 页面路由。照搬 CMA web/src/routing/routes.ts 的写法：路径和路由对象一一对应、
 * 可以往返转换，不引入路由库。
 *
 * - `/s/<空间编号>#share=<分享令牌>`：查看一个空间；
 * - `/u/<组合编号>#share=<分享令牌>`：查看组合宇宙；
 * - `/preview#t=<预览令牌>`：草稿预览；
 * - `/connect`：连接 NyxID 授权；
 * - `/`：首页。
 *
 * 令牌在 `#` 后面，不属于路由，也不会发给服务器。
 * 页面的显示选项放在查询参数里（视图 `?view=raw|optimized|extended`、重建层画法 `?style=blocks`），
 * 不碰 `#` 后面的令牌。
 */
export type AppRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'connect' }
  | { readonly kind: 'workspace' }
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
  if (pathname === '/connect') return { kind: 'connect' };
  if (pathname === '/workspace') return { kind: 'workspace' };
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
    case 'connect':
      return '/connect';
    case 'workspace':
      return '/workspace';
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
/** 命名空间样式参数。 */
export const LOOK_PARAM = 'look';
/** 组合成员样式覆盖参数。 */
export const MEMBER_STYLES_PARAM = 'memberStyles';
/** 组合排布预设参数。 */
export const LAYOUT_PARAM = 'layout';

/** 读取命名样式编号；空值和非法编号返回 `null`。 */
export function lookFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(LOOK_PARAM);
  return value !== null && isStyleId(value) ? value : null;
}

/** 写入命名样式编号。 */
export function searchWithLook(search: string, styleId: string | null): string {
  const params = new URLSearchParams(search);
  if (styleId && isStyleId(styleId)) params.set(LOOK_PARAM, styleId);
  else params.delete(LOOK_PARAM);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** 读取组合中的成员样式覆盖；列表格式或编号非法时不应用覆盖。 */
export function memberStylesFromSearch(search: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const value = new URLSearchParams(search).get(MEMBER_STYLES_PARAM);
  if (!value) return map;
  for (const item of value.split(',')) {
    const [spaceId, styleId, extra] = item.split(':');
    if (
      !spaceId ||
      !styleId ||
      extra !== undefined ||
      !/^[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/.test(spaceId) ||
      !isStyleId(styleId)
    )
      return new Map();
    map.set(spaceId, styleId);
  }
  return map;
}

/** 写入组合成员样式覆盖。 */
export function searchWithMemberStyles(
  search: string,
  styles: ReadonlyMap<string, string> | Record<string, string>,
): string {
  const params = new URLSearchParams(search);
  const entries = styles instanceof Map ? [...styles.entries()] : Object.entries(styles);
  const encoded = entries
    .filter(
      ([spaceId, styleId]) =>
        /^[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/.test(spaceId) && isStyleId(styleId),
    )
    .map(([spaceId, styleId]) => `${spaceId}:${styleId}`)
    .join(',');
  if (encoded) params.set(MEMBER_STYLES_PARAM, encoded);
  else params.delete(MEMBER_STYLES_PARAM);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** 读取排布预设编号。 */
export function layoutFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(LAYOUT_PARAM);
  return value !== null && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : null;
}

/** 写入排布预设编号。 */
export function searchWithLayout(search: string, layout: string | null): string {
  const params = new URLSearchParams(search);
  if (layout && /^[a-z0-9][a-z0-9-]{0,79}$/.test(layout)) params.set(LAYOUT_PARAM, layout);
  else params.delete(LAYOUT_PARAM);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

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

/** 查询参数里记住的视图的键。 */
export const VIEW_PARAM = 'view';

/** 地址里指定的视图：`?view=raw|optimized|extended`；没有或不认识的值返回 null（用页面的默认视图）。 */
export function viewFromSearch(search: string): ViewMode | null {
  const value = new URLSearchParams(search).get(VIEW_PARAM);
  return VIEW_MODES.find((mode) => mode.id === value)?.id ?? null;
}

/** 与产品协议命名一致的兼容别名。 */
export const parseViewMode = viewFromSearch;
export const parseExplicitViewMode = viewFromSearch;

export function parseExplicitRebuiltStyle(search: string): RebuiltStyle | null {
  const value = new URLSearchParams(search).get(STYLE_PARAM);
  return value === 'shapes' || value === 'blocks' ? value : null;
}
/** 与产品协议命名一致的兼容别名。 */
export const parseRebuiltStyle = styleFromSearch;

/** 换掉查询参数里的视图（等于页面的默认视图时不写），其他参数原样保留。返回 `''` 或 `?…`。 */
export function searchWithView(search: string, view: ViewMode, fallback: ViewMode): string {
  const params = new URLSearchParams(search);
  if (view === fallback) params.delete(VIEW_PARAM);
  else params.set(VIEW_PARAM, view);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** 写入视图查询参数的协议别名。 */
export const writeViewQuery = searchWithView;

/**
 * 视图（原始 / 优化 / 优化 + 扩展），记在地址的查询参数里：打开 `?view=raw` 的链接直接进原始视图，
 * 切换视图时用 replaceState 更新地址（页面的默认视图不写），路径和 `#share=…` 原样保留。
 */
export function useViewMode(fallback: ViewMode): readonly [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(
    () => viewFromSearch(window.location.search) ?? fallback,
  );
  const change = useCallback(
    (next: ViewMode) => {
      setMode(next);
      const { pathname, search, hash } = window.location;
      const nextSearch = searchWithView(search, next, fallback);
      if (nextSearch !== search) {
        window.history.replaceState(window.history.state, '', `${pathname}${nextSearch}${hash}`);
      }
    },
    [fallback],
  );
  return [mode, change] as const;
}

/** 分别记录页面默认值与地址或控件显式指定的覆盖值。 */
export function useViewOverrides(fallback: ViewMode) {
  const [mode, writeMode] = useViewMode(fallback);
  const [style, writeStyle] = useRebuiltStyle();
  const [explicitMode, setExplicitMode] = useState(() =>
    parseExplicitViewMode(window.location.search),
  );
  const [explicitStyle, setExplicitStyle] = useState(() =>
    parseExplicitRebuiltStyle(window.location.search),
  );
  const setMode = useCallback(
    (value: ViewMode) => {
      setExplicitMode(value);
      writeMode(value);
    },
    [writeMode],
  );
  const setStyle = useCallback(
    (value: RebuiltStyle) => {
      setExplicitStyle(value);
      writeStyle(value);
    },
    [writeStyle],
  );
  const resetOverrides = useCallback(() => {
    setExplicitMode(null);
    setExplicitStyle(null);
    const params = new URLSearchParams(window.location.search);
    params.delete(VIEW_PARAM);
    params.delete(STYLE_PARAM);
    const search = params.size ? `?${params}` : '';
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  }, []);
  return { mode, style, explicitMode, explicitStyle, setMode, setStyle, resetOverrides };
}
