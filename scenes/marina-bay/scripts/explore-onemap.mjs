import { chromium } from '../../../sdk/typescript/node_modules/playwright-core/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = new URL('../references/onemap/', import.meta.url);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const requests = [];
  page.on('request', r => { if (!/google-analytics|googletagmanager/.test(r.url())) requests.push({url:r.url(),method:r.method()}); });
  page.on('console', m => { if(m.type()==='error') console.log('网页错误',m.text().slice(0,220)); });
  await page.goto('https://www.onemap.gov.sg/3d', {waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForTimeout(10000);
  console.log('地址',page.url());
  console.log('正文',(await page.locator('body').innerText()).slice(0,12000));
  console.log('链接',JSON.stringify(await page.locator('a').evaluateAll(as=>as.map(a=>({text:a.textContent,href:a.href})))));
  console.log('按钮',JSON.stringify(await page.locator('button').evaluateAll(as=>as.map(a=>({text:a.textContent,title:a.title,aria:a.getAttribute('aria-label')})))));
  await page.screenshot({path:new URL('3d.png',out).pathname});
  writeFileSync(new URL('3d-requests.json',out),JSON.stringify(requests,null,2));
  writeFileSync(new URL('3d.html',out),await page.content());
  console.log('请求',JSON.stringify(requests.filter(r=> /3d|tileset|cesium|config/i.test(r.url))));
} finally { await browser.close(); }
