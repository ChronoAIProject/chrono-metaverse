import { describe, expect, it } from 'vitest';
import {
  parseRoute,
  routePath,
  searchWithStyle,
  searchWithView,
  styleFromSearch,
  viewFromSearch,
  type AppRoute,
  lookFromSearch,
  searchWithLook,
  memberStylesFromSearch,
  searchWithMemberStyles,
  layoutFromSearch,
  searchWithLayout,
} from './routes';

const ROUTES: readonly AppRoute[] = [
  { kind: 'home' },
  { kind: 'connect' },
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

describe('地址里指定的视图', () => {
  it('?view=raw|optimized|extended；没有或不认识的值返回 null（用页面的默认视图）', () => {
    expect(viewFromSearch('?view=raw')).toBe('raw');
    expect(viewFromSearch('?style=blocks&view=extended')).toBe('extended');
    expect(viewFromSearch('?view=optimized')).toBe('optimized');
    expect(viewFromSearch('')).toBeNull();
    expect(viewFromSearch('?view=RAW')).toBeNull();
    expect(viewFromSearch('?view=')).toBeNull();
  });

  it('只换 view，其他查询参数原样保留；等于页面默认视图时不写', () => {
    expect(searchWithView('', 'raw', 'optimized')).toBe('?view=raw');
    expect(searchWithView('?view=raw', 'optimized', 'optimized')).toBe('');
    expect(searchWithView('?style=blocks', 'extended', 'optimized')).toBe(
      '?style=blocks&view=extended',
    );
    expect(searchWithView('?style=blocks&view=raw', 'optimized', 'optimized')).toBe(
      '?style=blocks',
    );
    // 预览页默认是优化 + 扩展：切到优化要写出来。
    expect(searchWithView('', 'optimized', 'extended')).toBe('?view=optimized');
    expect(searchWithView('?view=optimized', 'extended', 'extended')).toBe('');
  });
});

describe('地址里的命名样式与组合参数', () => {
  it.each(['A', '_', '-', '0', 'Studio_01.v2', 'A'.repeat(128)])(
    '后端合法样式编号可无损往返：`%s`',
    (styleId) => {
      const search = searchWithLook('?keep=1', styleId);
      expect(lookFromSearch(search)).toBe(styleId);
      expect(new URLSearchParams(search).get('keep')).toBe('1');
      const members = new Map([['demo-lobby', styleId]]);
      expect(memberStylesFromSearch(searchWithMemberStyles('?keep=1', members))).toEqual(members);
      expect(memberStylesFromSearch(searchWithMemberStyles('', { 'demo-lobby': styleId }))).toEqual(
        members,
      );
    },
  );

  it.each([
    '',
    '.',
    '.hidden',
    'A'.repeat(129),
    'a:b',
    'a b',
    'a\n',
    'a\r',
    '中文',
    'a/b',
    'a,b',
    'a%20',
  ])('拒绝非法样式编号：`%j`', (styleId) => {
    expect(lookFromSearch(`?${new URLSearchParams({ look: styleId })}`)).toBeNull();
    expect(searchWithLook('?look=old&keep=1', styleId)).toBe('?keep=1');
    expect(
      memberStylesFromSearch(`?${new URLSearchParams({ memberStyles: `demo-lobby:${styleId}` })}`),
    ).toEqual(new Map());
    expect(
      searchWithMemberStyles('?memberStyles=old&keep=1', new Map([['demo-lobby', styleId]])),
    ).toBe('?keep=1');
  });

  it.each(['Studio_01.v2', '-bad', '_bad', '.bad', 'a'.repeat(81), 'a b', 'a\n'])(
    '成员空间编号继续遵循原有规则：`%j`',
    (spaceId) => {
      expect(
        memberStylesFromSearch(
          `?${new URLSearchParams({ memberStyles: `${spaceId}:Studio_01.v2` })}`,
        ),
      ).toEqual(new Map());
      expect(searchWithMemberStyles('', new Map([[spaceId, 'Studio_01.v2']]))).toBe('');
    },
  );

  it('可往返读取命名样式、成员覆盖和排布预设', () => {
    expect(lookFromSearch('?look=night-neon')).toBe('night-neon');
    expect(searchWithLook('', 'blueprint')).toBe('?look=blueprint');
    const styles = memberStylesFromSearch(
      '?memberStyles=demo-lobby:maquette,demo-florist:spring-greenhouse',
    );
    expect(styles.get('demo-lobby')).toBe('maquette');
    expect(searchWithMemberStyles('', styles)).toBe(
      '?memberStyles=demo-lobby%3Amaquette%2Cdemo-florist%3Aspring-greenhouse',
    );
    expect(layoutFromSearch('?layout=courtyard')).toBe('courtyard');
    expect(searchWithLayout('', 'courtyard')).toBe('?layout=courtyard');
  });
});
