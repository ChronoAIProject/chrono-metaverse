/** 在原生查看器验证浏览器缓存、拉远后的完整楼体与办公室标记。 */
import { chromium } from '../../../sdk/typescript/node_modules/playwright-core/index.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const placement = read('build/placement.json');
const entities = [...read('entities.json'), ...read('build/onemap-entities.json'),
  ...read('build/ground.json'), ...placement.hostEntities];
const expectedModels = entities.filter(entity => entity.assetHash).length;
const expectedOverview = entities.filter(entity => entity.props?.backgroundView?.minDistance > 0).length;
const landmark = entities.find(entity => entity.props?.landmark)?.props.landmark;
if (!landmark) throw new Error('场景数据没有配置位置标记');
const expectedFrame = [...landmark.focusBounds.min, ...landmark.focusBounds.max];
const drafts = Object.entries(JSON.parse(readFileSync(new URL('out/drafts.json', root), 'utf8')))
  .sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt));
const [draftId, draft] = drafts[0] ?? [];
const previewUrl = process.env.METAVERSE_PREVIEW_URL ?? draft?.preview;
if (!previewUrl) throw new Error('尚未生成系统草稿预览链接');
const isPreview = new URL(previewUrl).pathname === '/preview';
mkdirSync(new URL('out/system-shots/', root), { recursive: true });
const browser = await chromium.launch({
  ...(process.env.METAVERSE_E2E_BROWSER_PATH
    ? { executablePath: process.env.METAVERSE_E2E_BROWSER_PATH }
    : process.platform === 'darwin' ? { channel: 'chrome' } : {}),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  const assets = [];
  let authorizations = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => errors.push(request.failure()?.errorText ?? '请求失败'));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/previews/assets/')) assets.push(path);
    if (path === '/api/public/previews') authorizations++;
  });
  page.on('response', response => {
    if (response.url().includes('/previews/assets/') && response.status() >= 400)
      errors.push(`资源请求失败：${response.status()}`);
  });
  const viewer = page.locator('.viewer');
  async function ready() {
    await page.locator('button[data-mode="extended"]').click();
    await page.waitForFunction(expectedModels => {
      const v = document.querySelector('.viewer');
      return v?.dataset.ready === 'true' && v.dataset.modelsPending === '0' && Number(v.dataset.modelsLoaded) === expectedModels;
    }, expectedModels, { timeout: 240000 });
    if (await viewer.getAttribute('data-models-failed') !== '0') throw new Error('模型加载失败');
  }
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready();
  const near = await viewer.evaluate(v => ({ ...v.dataset }));
  if (near.overviewObjects !== '0') throw new Error('室内距离显示了远景楼体');
  await page.screenshot({ path: new URL('out/system-shots/office-near.png', root).pathname });
  const firstAssets = assets.length;
  let cache = null;
  if (isPreview) {
    cache = await page.evaluate(async () => {
      const stored = await caches.open('chrono-metaverse-models-v1');
      const keys = await stored.keys();
      let bytes = 0;
      for (const key of keys) bytes += Number((await stored.match(key))?.headers.get('x-asset-bytes') ?? 0);
      return { entries: keys.length, bytes };
    });
    if (!cache.entries || !firstAssets) throw new Error('首次下载后没有浏览器资源缓存');
    const initialAuthorizations = authorizations;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    if (assets.length !== firstAssets) throw new Error(`刷新重复下载 ${assets.length - firstAssets} 份资源`);
    if (authorizations <= initialAuthorizations) throw new Error('刷新没有重新验证预览授权');
  }
  const canvas = await page.locator('.viewer__canvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  // 等浏览器逐次处理滚轮，避免软件渲染繁忙时输入事件合并。
  for (let i = 0; i < 22; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(120);
  }
  await page.mouse.move(20, 20);
  const marker = page.getByRole('button', { name: landmark.label, exact: true });
  await marker.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1000);
  const far = await viewer.evaluate(v => ({ ...v.dataset }));
  if (Number(far.overviewObjects) !== expectedOverview) throw new Error('拉远后背景片段没有全部显示');
  await page.screenshot({ path: new URL('out/system-shots/tower-office-marker.png', root).pathname });
  await marker.click();
  await page.waitForFunction(() => document.querySelector('.viewer')?.dataset.overviewObjects === '0');
  await marker.waitFor({ state: 'hidden' });
  const returned = await viewer.evaluate(v => ({ ...v.dataset }));
  const frame = returned.frame.split(',').map(Number);
  if (frame.some((value, index) => Math.abs(value - expectedFrame[index]) > 0.01))
    throw new Error('点击标记未返回场景配置的范围');
  await page.screenshot({ path: new URL('out/system-shots/office-return.png', root).pathname });
  const report = { draftId, near, far, returned, firstAssetRequests: firstAssets,
    reloadAssetRequests: assets.length - firstAssets, authorizations, cache, errors };
  writeFileSync(new URL('out/office-overview-check.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
