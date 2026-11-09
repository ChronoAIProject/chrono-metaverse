import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundleText, type BundleFile, type CheckedBundle } from '../core/bundle.js';
import {
  checkAsset,
  CheckError,
  describeCheck,
  fileSource,
  fits,
  modelFitsBounds,
  PURPOSE_ROLE,
  type AssetCheck,
} from '../core/check/index.js';
import {
  DEFAULT_UPLOAD_LIMITS,
  LimitsError,
  parseUploadLimits,
  type UploadLimits,
} from '../core/limits.js';
import type { EntityBody } from '../core/record.js';
import type { Shape } from '../core/shape.js';
import { paths, readBase, WorkspaceError, writeJson } from './files.js';

/**
 * 命令行这一侧的重建包检查（docs/design/server-slim.md 6.5、docs/SHAPES.md 第 7、8 节）：
 *
 * 1. 清单本身：大小、JSON、第 7 节的全部规则（`core/bundle.ts`，与 Rust 相同；不展开成操作）；
 * 2. 清单列出、本地也有的文件：大小、sha256、按用途的文件检查（`core/check/`），核对记录合乎这个用途的角色；
 *    本地没有的文件记成"依赖空间里已有"，`bundle push` 时用创建上传的复用探测确认；
 * 3. 只有模型、没有形状的物件（含模板）：模型的实测包围盒与物件 `bounds` 一致；
 * 4. `seed` 时：内部锚点、建模记录给出警告（种子包里的一切都会公开，6.8）。
 *
 * 上限取工作区的 `limits.json`（`metaverse pull` 写的服务端当前上限），没有就用默认值。
 */

export const MANIFEST_FILE = 'manifest.json';
export const LIMITS_FILE = 'limits.json';

/** 清单里一个文件的检查结果。 */
export interface BundleFileReport extends BundleFile {
  /** 本地有没有这个文件（没有就依赖空间里已有）。 */
  readonly local: boolean;
  /** 本地文件的核对记录。 */
  readonly check?: AssetCheck;
}

export interface BundleReport {
  readonly dir: string;
  readonly manifestPath: string;
  /** 清单的 sha256（上传后就是它的资源哈希）。 */
  readonly manifestHash: string;
  readonly manifestBytes: number;
  readonly bundle: CheckedBundle;
  readonly files: readonly BundleFileReport[];
  readonly warnings: readonly string[];
  /** 上限从哪里来（`limits.json` 的路径，或"默认值"）。 */
  readonly limitsSource: string;
}

/** 本地文件不合规（清单本身不合规时抛出 BundleError）。`problems` 每项一行。 */
export class BundleFilesError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `重建包里有 ${problems.length} 处问题：\n${problems.map((line) => `  - ${line}`).join('\n')}`,
    );
    this.name = 'BundleFilesError';
  }
}

export interface BundleDirOptions {
  readonly limits?: UploadLimits;
  readonly limitsSource?: string;
  /** 目标空间重建层已有的模板（`merge` 模式可以引用）。 */
  readonly spaceTemplates?: ReadonlyMap<string, Shape> | null;
  /** 工作区的空间编号：与清单的 `base.spaceId` 不同时给出警告。 */
  readonly spaceId?: string;
  /** 种子用的包（6.8）。 */
  readonly seed?: boolean;
}

/** 读工作区的 `limits.json`；没有时返回 null。格式不对时抛出 WorkspaceError。 */
export function readLimits(root: string): UploadLimits | null {
  const file = join(root, LIMITS_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseUploadLimits(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    const reason = error instanceof LimitsError ? error.message : (error as Error).message;
    throw new WorkspaceError(
      `${file} 不合法（${reason}）：重新运行 metaverse pull，或删掉它用默认值`,
    );
  }
}

export function writeLimits(root: string, limits: UploadLimits): void {
  writeJson(join(root, LIMITS_FILE), limits);
}

/** 工作区拉取的状态里重建层的模板（`merge` 模式的包可以引用它们）。 */
export function workspaceRebuiltTemplates(root: string, spaceId: string): Map<string, Shape> {
  const base = readBase(root, spaceId);
  const templates = new Map<string, Shape>();
  for (const entity of base.entities) {
    if (entity.layer === 'rebuilt' && entity.kind === 'template' && entity.shape !== undefined) {
      templates.set(entity.entityId, entity.shape);
    }
  }
  return templates;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 默认的包目录：工作区的 `out/bundle/`。 */
export function defaultBundleDir(root: string): string {
  return join(paths(root).out, 'bundle');
}

function modelOnly(entities: readonly EntityBody[]): EntityBody[] {
  return entities.filter((entity) => entity.assetHash !== undefined && entity.shape === undefined);
}

/** 检查一个重建包目录。清单不合规抛出 BundleError，文件不合规抛出 BundleFilesError。 */
export async function checkBundleDir(
  dir: string,
  options: BundleDirOptions = {},
): Promise<BundleReport> {
  const limits = options.limits ?? DEFAULT_UPLOAD_LIMITS;
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new WorkspaceError(
      `${dir} 里没有 ${MANIFEST_FILE}（本地重建工具 metaverse-recon bundle 的输出）`,
    );
  }
  const manifestBytes = readFileSync(manifestPath);
  const bundle = checkBundleText(manifestBytes.toString('utf8'), {
    limits,
    spaceTemplates: options.spaceTemplates ?? null,
  });
  const problems: string[] = [];
  const warnings: string[] = [];
  const files: BundleFileReport[] = [];
  for (const file of bundle.files) {
    const local = join(dir, file.path);
    if (!existsSync(local)) {
      files.push({ ...file, local: false });
      continue;
    }
    const size = statSync(local).size;
    if (size !== file.size) {
      problems.push(`${file.path}：大小 ${size} 字节，清单写的是 ${file.size}`);
      files.push({ ...file, local: true });
      continue;
    }
    const sha256 = await sha256File(local);
    if (sha256 !== file.sha256) {
      problems.push(`${file.path}：sha256 是 ${sha256}，清单写的是 ${file.sha256}`);
      files.push({ ...file, local: true });
      continue;
    }
    const source = await fileSource(local);
    try {
      const check = await checkAsset(file.purpose, source, limits);
      const misfit = fits(PURPOSE_ROLE[file.purpose], check, limits);
      if (misfit !== null) problems.push(`${file.path}：${misfit}`);
      files.push({ ...file, local: true, check });
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      problems.push(`${file.path}：${error.message}（${error.code}）`);
      files.push({ ...file, local: true });
    } finally {
      await source.close();
    }
  }

  // 只有模型的物件：模型的实测包围盒与 bounds 一致。
  const byHash = new Map(files.map((file) => [file.sha256, file]));
  const records = [...(bundle.rebuilt?.templates ?? []), ...(bundle.rebuilt?.entities ?? [])];
  for (const entity of modelOnly(records)) {
    const model = byHash.get(entity.assetHash!);
    if (model?.check?.format !== 'glb' || model.check.bounds === null) continue;
    const mismatch = modelFitsBounds(model.check.bounds, entity.bounds);
    if (mismatch !== null) problems.push(`物件 ${entity.entityId}（${model.path}）：${mismatch}`);
  }
  if (problems.length > 0) throw new BundleFilesError(problems);

  if (
    options.spaceId !== undefined &&
    bundle.base !== null &&
    bundle.base.spaceId !== options.spaceId
  ) {
    warnings.push(
      `清单的 base.spaceId 是 ${bundle.base.spaceId}，工作区是 ${options.spaceId}：bundle push 会拒绝`,
    );
  }
  if (options.seed) {
    const internal = bundle.anchors.filter((anchor) => anchor.visibility === 'internal');
    if (internal.length > 0) {
      warnings.push(
        `种子包里的一切都会公开，但有 ${internal.length} 个内部级锚点：${internal
          .map((anchor) => anchor.anchorId)
          .join('、')}（用 metaverse-recon bundle --seed 重新打包会去掉它们）`,
      );
    }
    if (bundle.notes !== null) {
      warnings.push('种子包里的一切都会公开，但带了建模记录（notes）：用 --seed 重新打包会去掉它');
    }
  }
  return {
    dir,
    manifestPath,
    manifestHash: createHash('sha256').update(manifestBytes).digest('hex'),
    manifestBytes: manifestBytes.length,
    bundle,
    files,
    warnings,
    limitsSource: options.limitsSource ?? '默认值',
  };
}

/** 给人看的检查结果（多行）。 */
export function describeBundleReport(
  report: BundleReport,
  formatBytes: (n: number) => string,
): string[] {
  const { bundle } = report;
  const lines: string[] = [];
  lines.push(
    `清单 ${report.manifestPath}（${formatBytes(report.manifestBytes)}，sha256 ${report.manifestHash}）`,
  );
  lines.push(`  说明：${bundle.note}`);
  lines.push(
    `  工具：${bundle.tool.name} ${bundle.tool.version}${bundle.tool.source ? `（${bundle.tool.source}）` : ''}，生成于 ${bundle.createdAt}`,
  );
  lines.push(
    bundle.base === null
      ? '  基础版本：没有写（推送时要加 --base latest）'
      : `  基础版本：空间 ${bundle.base.spaceId} 的第 ${bundle.base.seq} 版`,
  );
  if (bundle.scan !== null) {
    lines.push(
      `  扫描：${bundle.scan.assetHash.slice(0, 12)}…，网页用模型 ${bundle.scan.webModelHashes.length} 档` +
        (bundle.scan.observedAt !== undefined ? `，拍摄于 ${bundle.scan.observedAt}` : ''),
    );
  }
  if (bundle.rebuilt !== null) {
    const { mode, templates, entities, remove } = bundle.rebuilt;
    lines.push(
      `  重建层：${mode === 'replace' ? '整体替换' : '合并'}，模板 ${templates.length} 个、物件 ${entities.length} 件` +
        (mode === 'merge' ? `、删除 ${remove.length} 个编号` : ''),
    );
  }
  if (bundle.anchors.length > 0)
    lines.push(`  锚点：${bundle.anchors.length} 个（已有的编号不会覆盖）`);
  lines.push(`  上限：${report.limitsSource}`);
  lines.push(`  文件 ${report.files.length} 个：`);
  for (const file of report.files) {
    const what = file.check !== undefined ? describeCheck(file.check) : '本地没有，依赖空间里已有';
    lines.push(`    ${file.path}（${file.purpose}，${formatBytes(file.size)}）：${what}`);
  }
  return lines;
}
