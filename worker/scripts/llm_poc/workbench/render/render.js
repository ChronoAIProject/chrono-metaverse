// 无头渲染：node render.js <任务 JSON 文件>
// 任务 JSON：{ "three": three 包目录, "playwright": playwright 包目录（可省）,
//             "models": { 名字: glb 路径 }, "views": [ { "out": PNG 路径, ...渲染参数 } ] }
// 起一个只读的本地静态服务：/m/<名字> → 对应 glb，/three/* → three 包，其余 → 本目录（index.html）。
// 一个页面加载一次模型，依次渲染所有视图。每张图打印一行耗时；结果信息（比例尺、相机朝向）写到 <任务文件>.out.json。
const http = require('http');
const fs = require('fs');
const path = require('path');

const jobFile = process.argv[2];
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
const { chromium } = require(job.playwright || 'playwright');
const here = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.glb': 'model/gltf-binary' };

function resolve(url) {
  const p = decodeURIComponent(url.split('?')[0]);
  if (p.startsWith('/m/')) return job.models[p.slice(3)] || null;
  const pick = (root, rest) => {
    const full = path.resolve(root, '.' + rest);
    return full.startsWith(path.resolve(root)) ? full : null;
  };
  if (p.startsWith('/three/')) return pick(job.three, p.slice('/three'.length));
  return pick(here, p);
}

const srv = http.createServer((req, res) => {
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
});

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  let browser;
  let failed = false;
  try {
    browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('页面错误:', m.text());
    });
    page.on('pageerror', (e) => console.error('页面异常:', e.message));
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
    const t0 = Date.now();
    await page.evaluate((list) => window.wbLoad(list), Object.keys(job.models).map((k) => [k, `/m/${k}`]));
    console.log('加载模型', Date.now() - t0, 'ms');
    const infos = [];
    for (const v of job.views) {
      const t = Date.now();
      const r = await page.evaluate((p) => window.wbRender(p), v);
      fs.writeFileSync(v.out, Buffer.from(r.png.split(',')[1], 'base64'));
      infos.push({ out: v.out, ...r.info });
      console.log(path.basename(v.out), Date.now() - t, 'ms');
    }
    fs.writeFileSync(jobFile + '.out.json', JSON.stringify(infos, null, 1));
  } catch (e) {
    console.error('渲染失败:', e && e.message ? e.message : e);
    failed = true;
  } finally {
    if (browser) await browser.close();
    srv.close();
    process.exitCode = failed ? 1 : 0;
  }
});
