/** 使用系统草稿预览页检查室内、扩展层和实际资源加载情况。 */
import { chromium } from '../../../sdk/typescript/node_modules/playwright-core/index.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const drafts = Object.entries(JSON.parse(readFileSync(new URL('out/drafts.json', root), 'utf8')))
  .sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt));
const [draftId, draft] = drafts[0] ?? [];
const previewUrl = process.env.METAVERSE_PREVIEW_URL ?? draft?.preview;
if (!previewUrl) throw new Error('尚未生成系统草稿预览链接');
mkdirSync(new URL('out/system-shots/', root), { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  const failedRequests = [];
  const modelResponses = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => failedRequests.push({ url: request.url().split('#')[0], failure: request.failure()?.errorText }));
  page.on('response', response => {
    if (response.url().includes('/previews/assets/')) {
      if (response.status() >= 400) errors.push(`资源请求 HTTP ${response.status()}：${response.url()}`);
      else modelResponses.add(response.url());
    }
  });
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const states = {};
  for (const mode of ['extended', 'optimized']) {
    await page.locator(`button[data-mode="${mode}"]`).click();
    const viewer = page.locator(`.viewer[data-mode="${mode}"][data-ready="true"]`);
    await viewer.waitFor({ timeout: 180000 });
    // 模型异步加载完成后再验收；不靠固定延时猜测城市资源是否到齐。
    await page.waitForFunction(() => document.querySelector('.viewer')?.dataset.modelsPending === '0', undefined, { timeout: 180000 });
    await page.waitForTimeout(1000);
    states[mode] = await viewer.evaluate(element => ({ ...element.dataset }));
    const frame = states[mode].frame.split(',').map(Number);
    if (frame[3] - frame[0] > 12 || frame[5] - frame[2] > 16) errors.push(`${mode}：默认取景超出办公室`);
    if (states[mode].modelsFailed !== '0') errors.push(`${mode}：模型加载失败`);
    await page.screenshot({ path: new URL(`out/system-shots/${mode}.png`, root).pathname });
    console.log(`系统 ${mode} 视图已就绪：${states[mode].entities} 个物件，${states[mode].triangles} 个三角形`);
  }
  if (states.extended.frame !== states.optimized.frame) errors.push('扩展和优化的办公室取景不一致');
  const report = { draftId, states, assetResponses: modelResponses.size, errors, failedRequests };
  writeFileSync(new URL('out/system-preview-check.json', root), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (errors.length || failedRequests.length) process.exitCode = 1;
} finally { await browser.close(); }
