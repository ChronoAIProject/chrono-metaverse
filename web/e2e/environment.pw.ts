import { expect, test, type Page } from '@playwright/test';
import { DRAFT_TEXTURE } from '../src/fixtures/assets';
import { encodePng } from '../src/fixtures/png';
import { brightCoverage, decodePng } from './png';

const PREVIEW = '/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899';
const pixels = new Uint8Array(64 * 64 * 3);
for (let i = 0; i < pixels.length; i += 3) {
  pixels[i] = 60;
  pixels[i + 1] = 140 + ((i / 3) % 64);
  pixels[i + 2] = 190;
}
const tile = Buffer.from(encodePng(64, 64, pixels));

async function prepare(page: Page, fallback = false) {
  const sources = [
    {
      urlTemplate: 'https://tiles.example.org/{z}/{x}/{y}',
      attribution: '测试全球地图',
      page: 'https://tiles.example.org/',
      minZoom: 0,
      maxZoom: 16,
    },
  ];
  if (fallback)
    sources.unshift({ ...sources[0]!, urlTemplate: 'https://unavailable.example.org/{z}/{x}/{y}' });
  await page.route('https://tiles.example.org/**', (route) =>
    route.fulfill({
      body: tile,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.route('https://unavailable.example.org/**', (route) =>
    route.fulfill({
      status: 503,
      body: '暂不可用',
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.route('**/api/public/previews', async (route) => {
    const response = await route.fetch();
    const preview = await response.json();
    preview.entities.push({
      id: 'environment-test',
      hash: 'd'.repeat(64),
      body: {
        entityId: 'environment-test',
        kind: 'object',
        layer: 'ext',
        regionId: 'virtual',
        shape: { type: 'box', size: [0.1, 0.1, 0.1] },
        bounds: { min: [0, -10, 0], max: [0.1, -9.9, 0.1] },
        textures: [DRAFT_TEXTURE.hash],
        props: {
          background: true,
          environment: {
            version: 1,
            sky: { texture: DRAFT_TEXTURE.hash },
            map: { latitude: -33.8, longitude: 151.2, heading: 45, origin: [0, -10, 0], sources },
          },
        },
      },
    });
    await route.fulfill({ json: preview });
  });
}

async function ready(page: Page) {
  const viewer = page.locator('.viewer');
  await expect(viewer).toHaveAttribute('data-ready', 'true');
  await expect(viewer).toHaveAttribute('data-sky', 'ready');
  await expect(viewer).toHaveAttribute('data-map-ready', 'true');
  await expect(viewer).toHaveAttribute('data-map-pending', '0');
  return viewer;
}

test('拉远越过旧天空球半径仍有连续地图和天空，刷新复用地图缓存', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await prepare(page);
  let requests = 0;
  page.on('request', (request) => {
    if (request.url().startsWith('https://tiles.example.org/')) requests++;
  });
  await page.goto(PREVIEW);
  const viewer = await ready(page);
  const nearFrame = await viewer.getAttribute('data-frame');
  const initialRequests = requests;
  expect(initialRequests).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (await caches.open('chrono-metaverse-map-tiles-v1')).keys()).length,
      ),
    )
    .toBe(initialRequests);
  await page.reload();
  await ready(page);
  expect(requests).toBe(initialRequests);
  const rect = (await page.locator('.viewer__canvas').boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  for (let i = 0; i < 70; i++) {
    if (Number(await viewer.getAttribute('data-map-distance')) > 20000) break;
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(100);
  }
  await ready(page);
  expect(Number(await viewer.getAttribute('data-map-distance'))).toBeGreaterThan(20000);
  expect(
    brightCoverage(decodePng(await page.locator('.viewer__canvas').screenshot())),
  ).toBeGreaterThan(0.95);
  await page.getByRole('button', { name: '回到全景', exact: true }).click();
  await expect(viewer).toHaveAttribute('data-frame', nearFrame!);
  await page.locator('button[data-mode="optimized"]').click();
  await expect(viewer).not.toHaveAttribute('data-environment');
  await expect(page.getByLabel('地图来源')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('地图源失败和浏览器存储不可用时使用配置的全球影像回退', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'caches', {
      value: { open: () => Promise.reject(new Error('storage disabled')) },
    }),
  );
  await prepare(page, true);
  await page.goto(PREVIEW);
  const viewer = await ready(page);
  await expect(viewer).toHaveAttribute('data-map-failed', '0');
  await expect(page.getByLabel('地图来源')).toContainText('测试全球地图');
  expect(Number(await viewer.getAttribute('data-map-zoom'))).toBeGreaterThanOrEqual(15);
});
