import { describe, expect, it } from 'vitest';
import type { EntityBody } from './api/types';
import type { SceneContent, ViewContent } from './scene';
import {
  attributionCredits,
  isHttpsUrl,
  LICENSE_INFO,
  modelSourceOf,
  sceneSources,
  type ModelSource,
} from './sources';

const source: ModelSource = {
  library: 'objaverse',
  id: '0123abcd',
  page: 'https://example.com/models/0123abcd',
  author: '某作者',
  license: 'CC-BY-4.0',
  title: '布艺沙发',
};

function model(entityId: string, props: Record<string, unknown>, label?: string): EntityBody {
  return {
    entityId,
    layer: 'rebuilt',
    kind: 'object',
    assetHash: 'ab'.repeat(32),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    ...(label !== undefined ? { label } : {}),
    props,
  };
}

function content(...members: EntityBody[][]): SceneContent {
  return {
    mode: 'optimized',
    links: [],
    members: members.map((entities, i) => ({
      spaceId: `space-${i}`,
      placement: { offset: [0, 0, 0], rotation: 0 },
      view: { entities } as unknown as ViewContent,
    })),
  };
}

describe('模型署名', () => {
  it('合法的 props.source 原样取出；旧数据里的字符串 source 不算署名', () => {
    expect(modelSourceOf(model('a', { source }))).toEqual(source);
    expect(modelSourceOf(model('a', { source: 'hint' }))).toBeNull();
    expect(modelSourceOf(model('a', {}))).toBeNull();
    expect(modelSourceOf({ ...model('a', {}), props: undefined })).toBeNull();
    expect(modelSourceOf(model('a', { source: [source] }))).toBeNull();
  });

  it('不合规则的署名不显示：脚本地址、http、空白、不收的许可、多余字段', () => {
    for (const bad of [
      { ...source, page: 'javascript:alert(1)' },
      { ...source, page: 'http://example.com/x' },
      { ...source, page: 'https://example.com/a b' },
      { ...source, license: 'CC-BY-NC-4.0' },
      { ...source, license: 'CC-BY-SA-4.0' },
      { ...source, library: 'thingiverse' },
      { ...source, author: '' },
      { ...source, title: 'x'.repeat(201) },
      { ...source, id: 7 },
      { ...source, extra: 'x' },
    ]) {
      expect(modelSourceOf(model('a', { source: bad })), JSON.stringify(bad)).toBeNull();
    }
    expect(isHttpsUrl('https://')).toBe(false);
    expect(isHttpsUrl(`https://a.b/${'x'.repeat(2000)}`)).toBe(false);
    expect(isHttpsUrl('https://a.b/ ')).toBe(false);
  });

  it('场景里的署名按模型去重，记下用到它的物件，按标题排序', () => {
    const cc0: ModelSource = {
      ...source,
      library: 'polyhaven',
      id: 'chair',
      title: '扶手椅',
      license: 'CC0-1.0',
    };
    const credits = sceneSources(
      content(
        [model('sofa-1', { source }, '沙发'), model('sofa-2', { source }, '沙发')],
        [model('chair-1', { source: cc0 }), model('sofa-3', { source })],
      ),
    );
    expect(credits.map((c) => c.source.title)).toEqual(['布艺沙发', '扶手椅']);
    expect(credits[0]!.usedBy).toEqual(['沙发', 'sofa-3']);
    expect(credits[1]!.usedBy).toEqual(['chair-1']);
    expect(sceneSources(null)).toEqual([]);
    // 底部署名行只看要求署名的（CC BY），顺序不变
    expect(attributionCredits(credits).map((c) => c.source.title)).toEqual(['布艺沙发']);
    expect(attributionCredits([credits[1]!])).toEqual([]);
  });

  it('每种许可都有 https 的许可正文地址（CC BY 署名要附许可链接）', () => {
    for (const info of Object.values(LICENSE_INFO)) {
      expect(isHttpsUrl(info.url)).toBe(true);
      expect(info.url.startsWith('https://creativecommons.org/')).toBe(true);
    }
  });
});
