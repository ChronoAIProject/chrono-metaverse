import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/*
 * 夹具模式的端到端测试（照 CMA web/e2e/*.config.ts 的写法）：
 * 用 `npm run dev:fixtures` 起本地开发服务器，接口由 src/fixtures 回答，不需要后端。
 *
 * 浏览器：优先用环境变量 METAVERSE_E2E_BROWSER_PATH；没有时如果本机有预装的
 * /opt/pw-browsers/chromium 就用它（固定版本的 Playwright 不一定能找到自己的浏览器）。
 * 截图写到 e2e/screenshots/（不进版本库）。
 */
const port = Number(process.env.METAVERSE_E2E_PORT ?? '4390');
const baseURL = `http://127.0.0.1:${port}`;
const preinstalled = '/opt/pw-browsers/chromium';
const executablePath =
  process.env.METAVERSE_E2E_BROWSER_PATH ?? (existsSync(preinstalled) ? preinstalled : undefined);

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: 'list',
  outputDir: mkdtempSync(join(tmpdir(), 'metaverse-e2e-')),
  webServer: {
    command: `npm run dev:fixtures -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    serviceWorkers: 'block',
    launchOptions: {
      executablePath,
      // 无头环境没有显卡，用 SwiftShader 软件渲染 WebGL。
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
});
