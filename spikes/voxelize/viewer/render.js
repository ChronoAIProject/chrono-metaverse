const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], outDir = process.argv[3], jobs = JSON.parse(process.argv[4]);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const srv = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
}).listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('console', m => { if (m.type() === 'error') console.error('page:', m.text()); });
  for (const [name, qs] of jobs) {
    const t = Date.now();
    await page.goto(`http://127.0.0.1:${port}/index.html?${qs}`);
    await page.waitForFunction('window.__done === true', null, { timeout: 180000 });
    await page.locator('canvas').screenshot({ path: path.join(outDir, name + '.png') });
    console.log(name, Date.now() - t, 'ms');
  }
  await browser.close(); srv.close();
});
