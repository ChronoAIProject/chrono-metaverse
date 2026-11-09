import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, type AppRoute } from './routes';

const ROUTES: readonly AppRoute[] = [
  { kind: 'home' },
  { kind: 'space', spaceId: 'restaurant-xyz' },
  { kind: 'universe', universeId: 'street-1' },
  { kind: 'preview' },
];

describe('路由', () => {
  it.each(ROUTES)('往返转换 $kind', (route) => {
    expect(parseRoute(routePath(route))).toEqual(route);
  });

  it('编号原样编码', () => {
    const route = { kind: 'space', spaceId: '空间 a?#' } as const;
    expect(parseRoute(routePath(route))).toEqual(route);
  });

  it.each([
    's/a',
    '/s',
    '/s/',
    '/preview/x',
    '/preview/',
    '/s/a/b',
    '/s/%',
    '/s/%2F',
    '/s/..',
    '/x/a',
    '/s//',
  ])('拒绝格式不对的路径 %s', (pathname) => {
    expect(parseRoute(pathname).kind).toBe('not_found');
  });
});
