import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, searchWithStyle, styleFromSearch, type AppRoute } from './routes';

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

describe('地址里记住的重建层画法', () => {
  it('?style=blocks 是方块；没有或不认识的值是形状', () => {
    expect(styleFromSearch('?style=blocks')).toBe('blocks');
    expect(styleFromSearch('?a=1&style=blocks')).toBe('blocks');
    expect(styleFromSearch('')).toBe('shapes');
    expect(styleFromSearch('?style=voxel')).toBe('shapes');
  });

  it('只换 style，其他查询参数原样保留；默认的形状不写', () => {
    expect(searchWithStyle('', 'blocks')).toBe('?style=blocks');
    expect(searchWithStyle('?style=blocks', 'shapes')).toBe('');
    expect(searchWithStyle('?a=1&style=blocks', 'shapes')).toBe('?a=1');
    expect(searchWithStyle('?a=1', 'blocks')).toBe('?a=1&style=blocks');
    expect(searchWithStyle('', 'shapes')).toBe('');
  });
});
