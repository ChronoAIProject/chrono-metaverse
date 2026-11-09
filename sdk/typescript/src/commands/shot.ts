import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { paths } from '../workspace/files.js';
import { CliError, flag, num, parse, printJson, str, type CliContext } from './common.js';
import { DEV_OPTIONS, startDev } from './dev.js';

export const SHOT_HELP = `metaverse shot [选项]

用无头浏览器（Playwright + Chromium，软件渲染，不需要显卡）给本地查看器截图：先运行一次
建造脚本，再按视图和角度各截一张 PNG，打印文件路径。给 AI 看图自查用。

选项：
  --views <列表>      视图：optimized（优化）、extended（优化 + 扩展）、raw（原始），默认 extended,optimized
  --angles <列表>     角度：front（默认全景）、left、right、back、top，默认 front,left,top
  --width <像素>      默认 1280
  --height <像素>     默认 800
  --no-cutaway        不剖切（默认剖切，能看到室内）
  --out <目录>        默认 out/shots
  --browser <路径>    Chromium 可执行文件（默认环境变量 METAVERSE_BROWSER_PATH，或 /opt/pw-browsers/chromium）
  以及 dev 的 --web-dist、--plot、--internal`;

const VIEW_IDS = ['optimized', 'extended', 'raw'] as const;
const ANGLES = ['front', 'left', 'right', 'back', 'top'] as const;
type View = (typeof VIEW_IDS)[number];
type Angle = (typeof ANGLES)[number];

function list<T extends string>(
  text: string | undefined,
  allowed: readonly T[],
  fallback: T[],
  what: string,
): T[] {
  if (text === undefined) return fallback;
  const items = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of items) {
    if (!allowed.includes(item as T))
      throw new CliError(`不认识的${what} ${item}（可选：${allowed.join('、')}）`);
  }
  return items as T[];
}

export function browserPath(ctx: CliContext, given: string | undefined): string | undefined {
  const candidate = given ?? ctx.env.METAVERSE_BROWSER_PATH;
  if (candidate !== undefined) {
    if (!existsSync(candidate)) throw new CliError(`找不到浏览器 ${candidate}`);
    return candidate;
  }
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

export async function runShot(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    ...DEV_OPTIONS,
    views: { type: 'string' },
    angles: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    'no-cutaway': { type: 'boolean' },
    out: { type: 'string' },
    browser: { type: 'string' },
  });
  if (flag(values, 'help')) {
    ctx.out(SHOT_HELP);
    return 0;
  }
  const views = list<View>(str(values, 'views'), VIEW_IDS, ['extended', 'optimized'], '视图');
  const angles = list<Angle>(str(values, 'angles'), ANGLES, ['front', 'left', 'top'], '角度');
  const width = num(values, 'width') ?? 1280;
  const height = num(values, 'height') ?? 800;
  const executablePath = browserPath(ctx, str(values, 'browser'));
  let playwright: typeof import('playwright-core');
  try {
    playwright = await import('playwright-core');
  } catch {
    throw new CliError('没有安装 playwright-core：在 sdk/typescript 里运行 npm ci');
  }
  const { server, ws } = await startDev(
    ctx,
    { ...values, port: str(values, 'port') ?? '0' },
    false,
  );
  const outDir = resolve(ctx.cwd, str(values, 'out') ?? paths(ws.root).shots);
  mkdirSync(outDir, { recursive: true });
  if (server.lastError() !== null) {
    await server.close();
    throw new CliError(`建造失败，没有截图：${server.lastError()}`);
  }
  const browser = await playwright.chromium.launch({
    ...(executablePath !== undefined ? { executablePath } : {}),
    headless: true,
    // 无头环境没有显卡，用 SwiftShader 软件渲染 WebGL（同 web/e2e 的配置）。
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const shots: { view: View; angle: Angle; path: string }[] = [];
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${server.url}/s/${ws.config.spaceId}`);
    const viewer = page.locator('.viewer');
    await viewer.waitFor({ state: 'attached', timeout: 60_000 });
    if (flag(values, 'no-cutaway')) {
      const cutaway = page.getByRole('checkbox', { name: '剖切' });
      if (await cutaway.isChecked()) await cutaway.uncheck();
    }
    for (const view of views) {
      await page.locator(`button[data-mode="${view}"]`).click();
      await page
        .locator(`.viewer[data-mode="${view}"][data-ready="true"]`)
        .waitFor({ state: 'attached', timeout: 60_000 });
      await page.waitForTimeout(800);
      for (const angle of angles) {
        const reset = page.locator('.viewer__frame');
        if ((await reset.count()) > 0) await reset.click();
        await page.waitForTimeout(600);
        const box = await page.locator('.viewer canvas').first().boundingBox();
        if (box !== null && angle !== 'front') {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          // OrbitControls：横向拖动 clientHeight/4 约转 90°，纵向拖动半屏到顶视。
          const quarter = box.height / 4;
          const [dx, dy] =
            angle === 'left'
              ? [quarter, 0]
              : angle === 'right'
                ? [-quarter, 0]
                : angle === 'back'
                  ? [2 * quarter, 0]
                  : [0, box.height * 0.45];
          await page.mouse.move(cx, cy);
          await page.mouse.down();
          await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
          await page.mouse.up();
          await page.waitForTimeout(1200);
        }
        const path = join(outDir, `${view}-${angle}.png`);
        await page.screenshot({ path });
        shots.push({ view, angle, path });
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (flag(values, 'json')) {
    printJson(ctx, { shots, errors });
  } else {
    for (const shot of shots) ctx.out(relative(ctx.cwd, shot.path) || shot.path);
    for (const error of errors) ctx.err(`页面错误：${error}`);
  }
  return 0;
}
