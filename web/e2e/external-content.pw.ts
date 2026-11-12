import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MODELS } from '../src/fixtures/assets';
import { encodePng } from '../src/fixtures/png';
import { ecef } from '../src/viewer/geography';

const PREVIEW = '/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899';
const cors = {
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=3600',
  date: new Date().toUTCString(),
  'access-control-expose-headers': 'date, age',
};
const logo = Buffer.from(encodePng(2, 2, new Uint8Array(12).fill(200)));

// 自有三角形的压缩分片，包含 Draco 几何；与任何地图提供方无关。
const compressedTile = readFileSync(new URL('./fixtures/triangle-draco.b3dm', import.meta.url));
const original = Buffer.from(MODELS.crate.bytes);
const jsonLength = original.readUInt32LE(12);
const externalGltf = JSON.parse(original.subarray(20, 20 + jsonLength).toString());
const externalBin = original.subarray(28 + jsonLength);
const imageView = externalGltf.bufferViews[externalGltf.images[0].bufferView];
const externalImage = externalBin.subarray(
  imageView.byteOffset ?? 0,
  (imageView.byteOffset ?? 0) + imageView.byteLength,
);
externalGltf.buffers[0].uri = 'geometry.bin';
externalGltf.images[0] = { uri: 'texture.png' };

function source(host: string) {
  return {
    url: `https://${host}/tileset.json`,
    attribution: host,
    page: `https://${host}/`,
    logo: `https://${host}/logo.png`,
    license: { label: '测试数据许可', url: `https://${host}/license` },
  };
}

async function prepare(
  page: Page,
  fallback = false,
  denied = false,
  dependencies = false,
  hierarchy = false,
) {
  const seen: { url: string; authorization?: string; cookie?: string }[] = [];
  for (const host of ['city-a.example.org', 'city-b.example.org', 'denied.example.org']) {
    await page.route(`https://${host}/**`, async (route) => {
      const request = route.request();
      const headers = await request.allHeaders();
      seen.push({
        url: request.url(),
        authorization: headers.authorization,
        cookie: headers.cookie,
      });
      if (host === 'denied.example.org') {
        await route.fulfill({
          status: 403,
          body: 'Direct download is not permitted',
          headers: cors,
        });
      } else if (request.url().endsWith('logo.png')) {
        await route.fulfill({ body: logo, contentType: 'image/png', headers: cors });
      } else if (request.url().endsWith('.b3dm')) {
        await route.fulfill({
          body: compressedTile,
          contentType: 'application/octet-stream',
          headers: cors,
        });
      } else if (request.url().endsWith('model.gltf')) {
        await route.fulfill({ json: externalGltf, headers: cors });
      } else if (request.url().endsWith('geometry.bin')) {
        await route.fulfill({
          body: externalBin,
          contentType: 'application/octet-stream',
          headers: cors,
        });
      } else if (request.url().endsWith('texture.png')) {
        await route.fulfill({ body: externalImage, contentType: 'image/png', headers: cors });
      } else if (request.url().endsWith('model.glb')) {
        await route.fulfill({
          body: Buffer.from(MODELS.crate.bytes),
          contentType: 'model/gltf-binary',
          headers: cors,
        });
      } else {
        const position = ecef(151.2, -33.8);
        const transform = [
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          position.x,
          position.y,
          position.z,
          1,
        ];
        await route.fulfill({
          json: {
            asset: { version: '1.0' },
            geometricError: 0,
            root: {
              boundingVolume: { sphere: [0, 0, 0, hierarchy ? 2000000 : 20] },
              geometricError: hierarchy ? 100000000 : 0,
              refine: 'REPLACE',
              ...(host === 'city-b.example.org' ? { transform } : {}),
              ...(hierarchy
                ? {
                    children: [
                      {
                        boundingVolume: { sphere: [0, 0, 0, 20] },
                        geometricError: 0,
                        content: { uri: 'model.b3dm' },
                      },
                      {
                        boundingVolume: { sphere: [0, -1000000, 0, 20] },
                        geometricError: 0,
                        content: { uri: 'invisible.b3dm' },
                      },
                    ],
                  }
                : {
                    content: {
                      uri:
                        host === 'city-b.example.org'
                          ? 'model.glb'
                          : dependencies
                            ? 'model.gltf'
                            : 'model.b3dm',
                    },
                  }),
            },
          },
          headers: { ...cors, ...(fallback ? { 'cache-control': 'no-store' } : {}) },
        });
      }
    });
  }
  await page.route('**/api/public/previews', async (route) => {
    const response = await route.fetch();
    const preview = await response.json();
    const make = (id: string, sources: ReturnType<typeof source>[], reference?: object) => ({
      id,
      hash: id === 'external-a' ? 'c'.repeat(64) : 'd'.repeat(64),
      body: {
        entityId: id,
        kind: 'object',
        layer: 'ext',
        regionId: 'virtual',
        shape: { type: 'box', size: [0.1, 0.1, 0.1] },
        bounds: { min: [0, 0, 0], max: [0.1, 0.1, 0.1] },
        props: {
          background: true,
          externalContent: {
            version: 1,
            format: '3d-tiles',
            sources,
            ...(reference ? { reference } : {}),
          },
        },
      },
    });
    preview.entities.push(
      make(
        'external-a',
        denied
          ? [source('denied.example.org')]
          : fallback
            ? [source('denied.example.org'), source('city-a.example.org')]
            : [source('city-a.example.org')],
      ),
    );
    if (!fallback && !denied && !dependencies && !hierarchy)
      preview.entities.push(
        make('external-b', [source('city-b.example.org')], {
          latitude: -33.8,
          longitude: 151.2,
          origin: [3, 0, 0],
          heading: 45,
        }),
      );
    await route.fulfill({ json: preview });
  });
  return seen;
}

test('两个提供方及本地、地理坐标共用分片加载，刷新缓存并保持主体取景', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const seen = await prepare(page);
  await page.goto(PREVIEW);
  const credits = page.getByLabel('外部内容来源');
  for (const id of ['external-a', 'external-b']) {
    const credit = credits.locator(`[data-entity-id="${id}"]`);
    await expect(credit).toHaveAttribute('data-state', 'ready');
    await expect(credit).toHaveAttribute('data-visible-tiles', '1');
  }
  await expect(credits.getByRole('link', { name: '测试数据许可' })).toHaveCount(2);
  await expect(credits.locator('img')).toHaveCount(2);
  const frame = await page.locator('.viewer').getAttribute('data-frame');
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await (await caches.open('chrono-metaverse-external-resources-v1')).keys()).length,
      ),
    )
    .toBe(4);
  const loaded = seen.filter((r) => /tileset.json|model\.(glb|b3dm)/.test(r.url)).length;
  expect(loaded).toBe(4);
  await page.reload();
  await expect(credits.locator('[data-entity-id="external-b"]')).toHaveAttribute(
    'data-state',
    'ready',
  );
  expect(seen.filter((r) => /tileset.json|model\.(glb|b3dm)/.test(r.url))).toHaveLength(loaded);
  await expect(page.locator('.viewer')).toHaveAttribute('data-frame', frame!);
  expect(seen.every((r) => !r.authorization && !r.cookie)).toBe(true);
  expect(seen.every((r) => !new URL(r.url).pathname.startsWith('//'))).toBe(true);
  await page.locator('button[data-mode="optimized"]').click();
  await expect(credits).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('索引拒绝访问时只切换配置的备用提供方，no-store 索引刷新后重新读取', async ({ page }) => {
  const seen = await prepare(page, true);
  await page.goto(PREVIEW);
  const credit = page.getByLabel('外部内容来源').locator('[data-entity-id="external-a"]');
  await expect(credit).toHaveAttribute('data-state', 'ready');
  await expect(credit).toHaveAttribute('data-source-index', '1');
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await (await caches.open('chrono-metaverse-external-resources-v1')).keys()).length,
      ),
    )
    .toBe(1);
  await page.reload();
  await expect(credit).toHaveAttribute('data-state', 'ready');
  expect(seen.filter((r) => r.url === 'https://city-a.example.org/tileset.json')).toHaveLength(2);
  expect(seen.filter((r) => /model\.(glb|b3dm)$/.test(r.url))).toHaveLength(1);
});

test('提供方不可访问时显示状态，办公室及其余空间仍正常可用', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const seen = await prepare(page, false, true);
  await page.goto(PREVIEW);
  await expect(page.locator('.viewer')).toHaveAttribute('data-ready', 'true');
  const credit = page.getByLabel('外部内容来源').locator('[data-entity-id="external-a"]');
  await expect(credit).toHaveAttribute('data-state', 'failed');
  await expect(credit).toContainText('来源暂不可用');
  expect(seen.every((r) => new URL(r.url).hostname === 'denied.example.org')).toBe(true);
  expect(errors).toEqual([]);
});

test('glTF 外部缓冲与贴图使用相同的缓存及无凭据请求', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const seen = await prepare(page, false, false, true);
  await page.goto(PREVIEW);
  const credit = page.getByLabel('外部内容来源').locator('[data-entity-id="external-a"]');
  await expect(credit).toHaveAttribute('data-state', 'ready');
  await expect(credit).toHaveAttribute('data-visible-tiles', '1');
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await (await caches.open('chrono-metaverse-external-resources-v1')).keys()).length,
      ),
    )
    .toBe(4);
  expect(seen.filter((r) => r.url.endsWith('geometry.bin'))).toHaveLength(1);
  expect(seen.filter((r) => r.url.endsWith('texture.png'))).toHaveLength(1);
  await page.reload();
  await expect(credit).toHaveAttribute('data-state', 'ready');
  expect(
    seen.filter((r) => /tileset.json|model.gltf|geometry.bin|texture.png/.test(r.url)),
  ).toHaveLength(4);
  expect(seen.every((r) => !r.authorization && !r.cookie)).toBe(true);
  expect(errors).toEqual([]);
});

test('层级数据集只请求当前镜头需要的分片', async ({ page }) => {
  const seen = await prepare(page, false, false, false, true);
  await page.goto(PREVIEW);
  const credit = page.getByLabel('外部内容来源').locator('[data-entity-id="external-a"]');
  await expect(credit).toHaveAttribute('data-state', 'ready');
  await expect(credit).toHaveAttribute('data-visible-tiles', '1');
  expect(seen.some((r) => r.url.endsWith('model.b3dm'))).toBe(true);
  expect(seen.some((r) => r.url.endsWith('invisible.b3dm'))).toBe(false);
});

test('部分分片失败后仍显示成功内容，并持续保留不完整状态', async ({ page }) => {
  await prepare(page, false, false, false, true);
  let finishModel!: () => void;
  const modelAllowed = new Promise<void>((resolve) => {
    finishModel = resolve;
  });
  await page.route('https://city-a.example.org/tileset.json', (route) =>
    route.fulfill({
      json: {
        asset: { version: '1.0' },
        geometricError: 100000000,
        root: {
          boundingVolume: { sphere: [0, 0, 0, 20] },
          geometricError: 100000000,
          refine: 'REPLACE',
          children: ['missing.b3dm', 'model.b3dm'].map((uri) => ({
            boundingVolume: { sphere: [0, 0, 0, 20] },
            geometricError: 0,
            content: { uri },
          })),
        },
      },
      headers: cors,
    }),
  );
  await page.route('https://city-a.example.org/missing.b3dm', (route) =>
    route.fulfill({ status: 403, body: 'unavailable', headers: cors }),
  );
  await page.route('https://city-a.example.org/model.b3dm', async (route) => {
    await modelAllowed;
    await route.fulfill({
      body: compressedTile,
      contentType: 'application/octet-stream',
      headers: cors,
    });
  });
  await page.goto(PREVIEW);
  const credit = page.getByLabel('外部内容来源').locator('[data-entity-id="external-a"]');
  try {
    await expect(credit).toHaveAttribute('data-state', 'failed');
  } finally {
    finishModel();
  }
  await expect(credit).toHaveAttribute('data-visible-tiles', '1');
  await expect(credit).toHaveAttribute('data-state', 'partial');
  await expect(credit).toContainText('来源暂不可用');
});
