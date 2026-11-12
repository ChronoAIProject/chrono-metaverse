import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isObjectId, isSpaceId } from '../core/ids.js';
import {
  DEFAULT_SLUG,
  TRUSTED_NYX_BASES,
  isTrustedNyxBase,
  validateConfig,
  writeConfig,
  type WorkspaceConfig,
} from '../workspace/config.js';
import { paths } from '../workspace/files.js';
import {
  CliError,
  displayPath,
  explicitNyxBase,
  flag,
  parse,
  str,
  type CliContext,
} from './common.js';

export const INIT_HELP = `metaverse init <空间编号> [目录]

创建本地工作区（默认目录 ./<空间编号>）：写入 metaverse.json、示例建造脚本 build/main.ts、
技能说明 .claude/skills/metaverse-builder/SKILL.md（建造）和 .claude/skills/metaverse-reconstruct/SKILL.md
（用 AI 重建实体空间），以及让编辑器认识工具包类型的 tsconfig.json。

选项：
  --mode nyxid|direct     调用方式（默认 nyxid：经 NyxID 代理调用线上服务）
  --slug <slug>           服务在 NyxID 里的 slug（默认 ${DEFAULT_SLUG}）
  --profile <名称>        nyxid 命令行的配置名（agent key；字母、数字、_ 和 -）
  --nyx-base <地址>       写进 metaverse.json 的 NyxID 地址，只能是 ${TRUSTED_NYX_BASES.join('、')}
                          （别的地址不能写进工作区，每次运行时用 --nyx-base 或 METAVERSE_NYX_BASE 指定）
  --api <地址>            direct 模式的接口服务地址，例如 http://127.0.0.1:8080
  --dev-token-url <地址>  direct 模式的取令牌地址，例如 http://127.0.0.1:8090/dev/token
  --sub <主体编号>        direct 模式取令牌时用的 sub
  --plot <地块>           默认的目标地块
  --web-url <地址>        网站地址（拼预览链接用）
  --force                 覆盖已有的 metaverse.json 和技能说明（建造脚本不会被覆盖）`;

export const EXAMPLE_SCRIPT = `import type { BuildBase, Kit } from '@chrono-metaverse/sdk';

/**
 * 建造脚本：每次 \`metaverse build\` 都从拉取的基础状态重新生成操作，可以反复运行。
 *
 * - base：拉取的基础状态（区域、地块、锚点、物件、方块表、目标范围 base.target）；
 * - kit：建造工具包（形状、操作、家具、米和格互换），也可以 import 进来用。
 *
 * 形状和位置用米；方块操作的盒子用格（GRID_UNIT = 0.05 米）。
 */
export default function build(base: BuildBase, kit: Kit) {
  const { place, table, chair } = kit;
  // 目标地块的最小角（米）；实体区时是全部实体区盒子的最小角。
  const [x, y, z] = base.target.origin ?? [0, 0, 0];
  return {
    message: '示例：一张桌子和两把椅子',
    ops: [
      place('demo-table', table({ at: [x + 1.0, y, z + 1.0] }), { label: '示例桌' }),
      // 椅子面朝 +z；放在桌子 -z 一侧的椅子不用转，+z 一侧的转 180 度面向桌子。
      place('demo-chair-1', chair({ at: [x + 1.0, y, z + 0.45] })),
      place('demo-chair-2', chair({ at: [x + 1.0, y, z + 1.55], yaw: 180 })),
    ],
  };
}
`;

const WORKSPACE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
  },
  include: ['build/**/*.ts'],
};

/**
 * 工作区里不进版本库的目录：拉取的数据、本地输出，以及**不公开**的原始扫描（`scan/`，`pull --scan`
 * 写的最大 1 GiB）和重建工作目录（`work/`：参考图、下载的贴图、逐件草稿）、网页用模型（`web/`）。
 */
export const WORKSPACE_IGNORED = [
  'out/',
  'chunks/',
  'assets/',
  'scan/',
  'work/',
  'web/',
  'node_modules/',
] as const;

const WORKSPACE_GITIGNORE = `# metaverse 工作区：拉取的数据和本地输出不进版本库，建造脚本（build/）进。
# scan/ 是原始扫描（不公开，不进任何仓库）；work/ 是重建的工作目录；web/ 是本地生成的网页用模型。
${WORKSPACE_IGNORED.join('\n')}
`;

/**
 * 保证工作区的 `.gitignore` 忽略 `WORKSPACE_IGNORED`：没有就写一份；有就把缺的行补在末尾（旧版本 init 写的
 * 没有 `scan/`、`work/`、`web/`）。返回补上的行（写了新文件时返回全部），没改时返回空数组。
 */
export function ensureGitignore(root: string): string[] {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) {
    writeFileSync(file, WORKSPACE_GITIGNORE);
    return [...WORKSPACE_IGNORED];
  }
  const text = readFileSync(file, 'utf8');
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = WORKSPACE_IGNORED.filter(
    (entry) => !lines.has(entry) && !lines.has(`/${entry}`) && !lines.has(entry.slice(0, -1)),
  );
  if (missing.length === 0) return [];
  const prefix = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  writeFileSync(
    file,
    `${text}${prefix}# metaverse 补上的：原始扫描（scan/）不公开，重建工作目录和本地输出不进版本库\n${missing.join('\n')}\n`,
  );
  return missing;
}

/** 随 SDK 分发、写进工作区的技能说明：建造（metaverse-builder）和用 AI 重建实体空间（metaverse-reconstruct）。 */
export const SKILLS = ['metaverse-builder', 'metaverse-reconstruct'] as const;

/** 技能说明的源文件（随 SDK 分发）。 */
export function skillSource(sdkRoot: string, name: string = SKILLS[0]): string {
  return join(sdkRoot, 'skills', name, 'SKILL.md');
}

/** 技能说明在工作区里的位置。 */
export function skillTarget(root: string, name: string): string {
  return join(root, '.claude', 'skills', name, 'SKILL.md');
}

/** 把技能说明写进工作区（init 和 pull 都会调用，保持最新）。返回这次写入的文件。 */
export function installSkill(sdkRoot: string, root: string, force: boolean): string[] {
  const written: string[] = [];
  for (const name of SKILLS) {
    const target = skillTarget(root, name);
    if (existsSync(target) && !force) continue;
    const source = skillSource(sdkRoot, name);
    if (!existsSync(source)) throw new CliError(`找不到技能说明源文件 ${source}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    const references = join(dirname(source), 'references');
    if (existsSync(references))
      cpSync(references, join(dirname(target), 'references'), { recursive: true });
    written.push(target);
  }
  return written;
}

/** 让工作区里的 `@chrono-metaverse/sdk` 指向这份 SDK（脚本里 import 工具包、编辑器的类型提示都靠它）。 */
export function linkSdk(sdkRoot: string, root: string): string | null {
  const link = join(root, 'node_modules', '@chrono-metaverse', 'sdk');
  if (existsSync(link)) return null;
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(sdkRoot, link, 'dir');
    return link;
  } catch {
    return null;
  }
}

export function runInit(ctx: CliContext, args: readonly string[]): number {
  const { values, positionals } = parse(args, {
    plot: { type: 'string' },
    'web-url': { type: 'string' },
    force: { type: 'boolean' },
  });
  if (flag(values, 'help')) {
    ctx.out(INIT_HELP);
    return 0;
  }
  const [spaceId, dir] = positionals;
  if (spaceId === undefined || !isSpaceId(spaceId)) {
    throw new CliError(
      '用法：metaverse init <空间编号> [目录]（空间编号是 3–64 个小写字母、数字和 -）',
    );
  }
  const root = resolve(ctx.cwd, dir ?? spaceId);
  const force = flag(values, 'force');
  const p = paths(root);
  if (existsSync(p.config) && !force) {
    throw new CliError(`${p.config} 已存在（要覆盖就加 --force）`);
  }
  const mode = str(values, 'mode') ?? 'nyxid';
  if (mode !== 'nyxid' && mode !== 'direct') throw new CliError('--mode 只能是 nyxid 或 direct');
  const plot = str(values, 'plot');
  if (plot !== undefined && !isObjectId(plot)) throw new CliError('--plot 不是合法的地块编号');
  // 只把 --nyx-base 写进工作区（环境变量是这台机器自己的设置，不写）；工作区里只能写可信地址。
  const nyxBase = str(values, 'nyx-base') !== undefined ? explicitNyxBase(values, {}) : undefined;
  if (nyxBase !== undefined && !isTrustedNyxBase(nyxBase.value)) {
    throw new CliError(
      `--nyx-base 不能写进 metaverse.json：工作区里只能写 ${TRUSTED_NYX_BASES.join('、')}。` +
        '别的 NyxID 地址请在每次运行时用 --nyx-base 或环境变量 METAVERSE_NYX_BASE 指定',
    );
  }
  const config: WorkspaceConfig = {
    spaceId,
    mode,
    ...(mode === 'nyxid' ? { slug: str(values, 'slug') ?? DEFAULT_SLUG } : {}),
    ...(nyxBase !== undefined ? { nyxBase: nyxBase.value } : {}),
    ...(str(values, 'profile') !== undefined ? { profile: str(values, 'profile') } : {}),
    ...(mode === 'direct'
      ? {
          api: str(values, 'api') ?? ctx.env.METAVERSE_API_URL ?? 'http://127.0.0.1:8080',
          devTokenUrl:
            str(values, 'dev-token-url') ??
            ctx.env.METAVERSE_DEV_TOKEN_URL ??
            'http://127.0.0.1:8090/dev/token',
          ...(str(values, 'sub') !== undefined ? { devSub: str(values, 'sub') } : {}),
        }
      : {}),
    ...(plot !== undefined ? { plot } : {}),
    ...(str(values, 'web-url') !== undefined ? { webUrl: str(values, 'web-url') } : {}),
    buildScript: 'build/main.ts',
  };
  validateConfig(config); // 先检查（slug、profile 等），不合格时不留下半个工作区
  mkdirSync(p.build, { recursive: true });
  writeConfig(root, config);
  const created: string[] = [p.config];
  const script = join(p.build, 'main.ts');
  if (!existsSync(script)) {
    writeFileSync(script, EXAMPLE_SCRIPT);
    created.push(script);
  }
  created.push(...installSkill(ctx.sdkRoot, root, true));
  const tsconfig = join(root, 'tsconfig.json');
  if (!existsSync(tsconfig) || force) {
    writeFileSync(tsconfig, `${JSON.stringify(WORKSPACE_TSCONFIG, null, 2)}\n`);
    created.push(tsconfig);
  }
  const gitignore = join(root, '.gitignore');
  if (ensureGitignore(root).length > 0) created.push(gitignore);
  const link = linkSdk(ctx.sdkRoot, root);
  if (link !== null) created.push(link);
  ctx.out(`已创建工作区 ${root}（空间 ${spaceId}，${mode} 模式）`);
  for (const file of created) ctx.out(`  ${relative(root, file) || file}`);
  ctx.out('');
  ctx.out('下一步：');
  ctx.out(`  cd ${displayPath(ctx, root)}`);
  ctx.out('  metaverse pull            # 下载空间的当前状态');
  ctx.out('  metaverse build && metaverse dev   # 运行建造脚本，打开本地查看器');
  return 0;
}
