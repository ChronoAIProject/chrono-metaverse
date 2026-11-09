// 无头渲染：node render.js <查看页目录> <模型目录> <three 包目录> <输出目录> '<[[名字, 查询串], ...]>' [playwright 路径]
// 起一个只读的本地静态服务：/models/* → 模型目录，/three/* → three 包，其余 → 查看页目录。
const http = require('http');
const fs = require('fs');
const path = require('path');

const [viewer, models, three, outDir, jobsJson, pw] = process.argv.slice(2);
const { chromium } = require(pw || 'playwright');
const jobs = JSON.parse(jobsJson);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };

function resolve(url) {
  const p = decodeURIComponent(url.split('?')[0]);
  const pick = (root, rest) => {
    const full = path.resolve(root, '.' + rest);
    return full.startsWith(path.resolve(root)) ? full : null;
  };
  if (p.startsWith('/models/')) return pick(models, p.slice('/models'.length));
  if (p.startsWith('/three/')) return pick(three, p.slice('/three'.length));
  return pick(viewer, p);
}

const srv = http
  .createServer((req, res) => {
    const file = resolve(req.url);
    if (!file) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(0, '127.0.0.1', async () => {
    const port = srv.address().port;
    const browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('page:', m.text());
    });
    for (const [name, qs] of jobs) {
      const t = Date.now();
      await page.goto(`http://127.0.0.1:${port}/index.html?${qs}`);
      await page.waitForFunction('window.__done === true', null, { timeout: 300000 });
      await page.locator('canvas').screenshot({ path: path.join(outDir, name + '.png') });
      console.log(name, Date.now() - t, 'ms');
    }
    await browser.close();
    srv.close();
  });
