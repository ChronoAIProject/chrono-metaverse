import { expect, test, type Page } from '@playwright/test';
import { vectorTileFixture } from '../src/test/vectorTile';

const PREVIEW = '/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899';
async function prepare(page: Page, server: boolean) {
  const seen: string[] = [],
    direct: string[] = [];
  const bytes = Buffer.from(vectorTileFixture());
  const answer = async (route: import('@playwright/test').Route, url: string) => {
    seen.push(url);
    const headers = {
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
      date: new Date().toUTCString(),
      'access-control-expose-headers': 'date, age',
    };
    if (url.endsWith('/index.json'))
      await route.fulfill({
        json: {
          tilejson: '3.0.0',
          minzoom: 0,
          maxzoom: 14,
          tiles: ['https://vectors.example.org/data/{z}/{x}/{y}.pbf'],
        },
        headers,
      });
    else await route.fulfill({ body: bytes, contentType: 'application/octet-stream', headers });
  };
  await page.route('https://vectors.example.org/**', async (route) => {
    direct.push(route.request().url());
    await answer(route, route.request().url());
  });
  await page.route('**/api/public/previews/external?**', async (route) => {
    expect((await route.request().allHeaders()).authorization).toMatch(/^Preview /);
    await answer(route, new URL(route.request().url()).searchParams.get('url')!);
  });
  await page.route('**/api/public/previews', async (route) => {
    const snapshot = await (await route.fetch()).json();
    snapshot.entities.push({
      id: 'vector-source',
      hash: 'c'.repeat(64),
      body: {
        entityId: 'vector-source',
        kind: 'object',
        layer: 'ext',
        regionId: 'virtual',
        shape: { type: 'box', size: [0.1, 0.1, 0.1] },
        bounds: { min: [0, -20, 0], max: [0.1, -19.9, 0.1] },
        props: {
          background: true,
          externalContent: {
            version: 1,
            format: 'mvt',
            reference: { longitude: 139, latitude: 35, heading: 21, origin: [0, -20, 0] },
            sources: [
              {
                url: 'https://vectors.example.org/index.json',
                ...(server ? { delivery: 'server' } : {}),
                page: 'https://vectors.example.org/',
                attribution: '测试矢量来源',
                resourcePrefixes: ['https://vectors.example.org/data/'],
              },
            ],
            extrusion: {
              layer: 'shapes',
              heightProperty: 'elevation',
              defaultHeight: 8,
              maxHeight: 1000,
              maxDistance: 20000,
              color: '#aabbcc',
            },
          },
        },
      },
    });
    await route.fulfill({ json: snapshot });
  });
  return { seen, direct };
}

test('镜头拉远发现历史范围之外的新瓦片并保留主体取景，刷新复用公开缓存', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { seen } = await prepare(page, false);
  await page.goto(PREVIEW);
  const credit = page.locator('.viewer__external-credit[data-format="mvt"]');
  await expect(credit).toHaveAttribute('data-state', 'ready');
  await expect.poll(async () => Number(await credit.getAttribute('data-loaded'))).toBeGreaterThan(0);
  const viewer = page.locator('.viewer'),
    frame = await viewer.getAttribute('data-frame');
  const first = new Set(seen);
  const rect = (await page.locator('.viewer__canvas').boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  for (let i = 0; i < 50 && !seen.some((url) => !first.has(url)); i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(150);
  }
  await expect.poll(() => seen.some((url) => !first.has(url))).toBe(true);
  await expect(credit).toHaveAttribute('data-state', 'ready');
  expect(Number(await credit.getAttribute('data-visible-tiles'))).toBeGreaterThan(0);
  await page.reload();
  await expect(credit).toHaveAttribute('data-state', 'ready');
  await expect(viewer).toHaveAttribute('data-frame', frame!);
  expect(seen.filter((url) => url.endsWith('/index.json'))).toHaveLength(1);
  await page.locator('button[data-mode="optimized"]').click();
  await expect(credit).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('矢量入口与新瓦片共用服务端预览权限，不向浏览器提供方直连', async ({ page }) => {
  const { seen, direct } = await prepare(page, true);
  await page.goto(PREVIEW);
  const credit = page.locator('.viewer__external-credit[data-format="mvt"]');
  await expect(credit).toHaveAttribute('data-state', 'ready');
  await expect.poll(async () => Number(await credit.getAttribute('data-loaded'))).toBeGreaterThan(0);
  expect(seen.some((url) => url.endsWith('/index.json'))).toBe(true);
  expect(seen.some((url) => url.endsWith('.pbf'))).toBe(true);
  expect(direct).toEqual([]);
});

test('矢量入口拒绝访问只影响该来源，主体正常且不绕回浏览器直连', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { direct } = await prepare(page, true);
  let requests = 0;
  await page.route('**/api/public/previews/external?**', (route) => {
    requests++;
    return route.fulfill({ status: 403, body: 'unavailable' });
  });
  await page.goto(PREVIEW);
  await expect(page.locator('.viewer')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.viewer__external-credit[data-format="mvt"]')).toHaveAttribute(
    'data-state',
    'failed',
  );
  expect(requests).toBe(1);
  expect(direct).toEqual([]);
  expect(errors).toEqual([]);
});
