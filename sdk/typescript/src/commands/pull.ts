import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { chunkHash, decompressChunk } from '../core/chunk.js';
import { isSha256Hex, sha256Hex } from '../core/hash.js';
import { LimitsError, parseUploadLimits } from '../core/limits.js';
import { normalizeEntityBody, type EntityBody } from '../core/record.js';
import type { MetaverseApi, SnapshotView } from '../transport/api.js';
import {
  DEFAULT_SEGMENT_BYTES,
  downloadToPart,
  finishDownload,
  sha256OfFile,
} from '../transport/download.js';
import { parseShareLink, PublicApi, ShareLinkError } from '../transport/public.js';
import { writeLimits } from '../workspace/bundle.js';
import { paths, writeBase, writeJson, type ChunkRef, type SpaceFile } from '../workspace/files.js';
import { installSkill, linkSdk } from './init.js';
import {
  CliError,
  flag,
  formatBytes,
  makeApi,
  num,
  openWorkspace,
  parse,
  printJson,
  str,
  type CliContext,
  type Workspace,
} from './common.js';

export const PULL_HELP = `metaverse pull [--seq <n>] [--scan]
metaverse pull --share <分享链接> [--seq <n>] [--assets]

下载空间的当前状态（或指定 seq 的版本）到工作区：space.json、palette.json、anchors.json、
entities.json、chunks/（区块，按哈希核对），以及网页用模型（assets/，本地查看器的"原始"视图用）。
已有的区块和资源不重复下载。接口服务给出各用途的上传上限时写进 limits.json（本地重建工具和
metaverse bundle check 据此提前检查）。

选项：
  --scan              另外下载这个版本的原始扫描到 scan/（zip 写成 scan/scan.zip），分段下载（每段 64 MiB），
                      中途断了再运行一次接着下；同时写 scan/transform.json（扫描坐标 → 空间坐标）
  --share <分享链接>  不经 NyxID，只读公开快照（https://<网站>/s/<空间编号>#share=<分享令牌>；令牌也可以
                      用环境变量 METAVERSE_SHARE_TOKEN 给）：写 space.json（标记为只读，不能推送）、entities.json、
                      anchors.json（只有公开锚点）、区块和 scan/transform.json。分享令牌只在内存里用，不写进工作区
  --assets            和 --share 一起用：另外下载网页用模型和物件模型到 assets/（按哈希核对）`;

const CONCURRENCY = 6;

/** 区块下载：并发 6 个，解压并核对哈希，坏数据不落盘。 */
async function downloadChunks(
  getChunk: (hash: string) => Promise<Uint8Array>,
  dir: string,
  refs: readonly ChunkRef[],
): Promise<number> {
  const missing = [...new Set(refs.map((r) => r.hash))].filter(
    (hash) => !existsSync(join(dir, `${hash}.bin`)),
  );
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const hash = missing[next]!;
      next += 1;
      if (!isSha256Hex(hash)) throw new CliError(`快照里的区块哈希格式不对：${hash}`);
      const bytes = await getChunk(hash);
      const cells = decompressChunk(bytes, hash);
      if (chunkHash(cells) !== hash) throw new CliError(`区块 ${hash} 的内容与哈希不符`);
      writeFileSync(join(dir, `${hash}.bin`), bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  return missing.length;
}

function entityBodies(snapshot: SnapshotView): EntityBody[] {
  return snapshot.entities.map((item) =>
    normalizeEntityBody(
      'body' in item && typeof item.body === 'object' ? item.body : (item as EntityBody),
    ),
  );
}

function chunkRefs(snapshot: SnapshotView | null): ChunkRef[] {
  return (snapshot?.chunks ?? []).map((c) => ({
    layer: c.layer,
    cx: c.cx,
    cy: c.cy,
    cz: c.cz,
    hash: c.hash,
  }));
}

/** 扫描目录（`metaverse-recon` 的 `--scan`、`--transform` 默认从这里读）。 */
function scanDir(root: string): string {
  return join(root, 'scan');
}

/**
 * `scan/transform.json`：`{transform, source: "pull", seq}`（格式与本地工具 `align` 的输出相同，
 * docs/design/server-slim.md 8.4）。没有变换时不写。
 */
function writeTransform(root: string, snapshot: SnapshotView | null, seq: number): boolean {
  const transform = snapshot?.scan?.transform;
  if (transform === undefined || transform.length !== 16) return false;
  mkdirSync(scanDir(root), { recursive: true });
  writeJson(join(scanDir(root), 'transform.json'), { transform, source: 'pull', seq });
  return true;
}

/** 按文件头给原始扫描起名：zip → scan.zip，glb、drc 照扩展名，其余按 obj。 */
function scanFileName(head: Uint8Array): string {
  const text = Buffer.from(head).toString('latin1');
  if (text.startsWith('PK\x03\x04')) return 'scan.zip';
  if (text.startsWith('glTF')) return 'scan.glb';
  if (text.startsWith('DRACO')) return 'scan.drc';
  return 'scan.obj';
}

const SCAN_NAMES = ['scan.zip', 'scan.glb', 'scan.drc', 'scan.obj'];

interface ScanDownload {
  readonly file: string;
  readonly bytes: number;
  readonly skipped: boolean;
  readonly resumedFrom: number;
}

/**
 * 分段下载原始扫描到 scan/（docs/design/server-slim.md 8.5）。已经有内容相同的文件就不下；
 * `.scan-<哈希>.part` 是下到一半的文件，再运行时接着下。
 */
async function pullScan(
  ctx: CliContext,
  api: MetaverseApi,
  root: string,
  hash: string,
  say: (line: string) => void,
): Promise<ScanDownload> {
  if (!isSha256Hex(hash)) throw new CliError(`快照里的扫描哈希格式不对：${hash}`);
  const dir = scanDir(root);
  mkdirSync(dir, { recursive: true });
  for (const name of SCAN_NAMES) {
    const file = join(dir, name);
    if (existsSync(file) && (await sha256OfFile(file)) === hash) {
      return { file, bytes: statSync(file).size, skipped: true, resumedFrom: 0 };
    }
  }
  const part = join(dir, `.scan-${hash}.part`);
  let last = -1;
  const result = await downloadToPart({
    fetchRange: (start, end) => api.getAssetRange(hash, start, end),
    partFile: part,
    sha256: hash,
    segmentBytes: DEFAULT_SEGMENT_BYTES,
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    onProgress: (done, total) => {
      const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
      if (percent !== last) {
        last = percent;
        say(`  原始扫描 ${formatBytes(done)} / ${formatBytes(total)}（${percent}%）`);
      }
    },
  });
  const head = new Uint8Array(8);
  const fd = openSync(part, 'r');
  try {
    readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  const file = join(dir, scanFileName(head));
  finishDownload(part, file);
  return { file, bytes: result.total, skipped: false, resumedFrom: result.resumedFrom };
}

/** `uploadLimits` → limits.json；接口服务没给（旧版本）或格式不对时不写，返回说明。 */
function saveLimits(root: string, value: unknown): string | null {
  if (value === undefined) {
    return '接口服务没有给出上传上限（uploadLimits），没有写 limits.json；本地检查用默认值';
  }
  try {
    writeLimits(root, parseUploadLimits(value));
    return null;
  } catch (error) {
    if (!(error instanceof LimitsError)) throw error;
    return `接口服务给出的上传上限不认识（${error.message}），没有写 limits.json；本地检查用默认值`;
  }
}

export async function runPull(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, {
    seq: { type: 'string' },
    scan: { type: 'boolean' },
    share: { type: 'string' },
    assets: { type: 'boolean' },
  });
  if (flag(values, 'help')) {
    ctx.out(PULL_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  if (str(values, 'share') !== undefined) return pullShare(ctx, ws, values);
  if (flag(values, 'assets')) {
    throw new CliError('--assets 只和 --share 一起用（经 NyxID 拉取时网页用模型照常下载）');
  }
  const api = makeApi(ctx, ws, values);
  const json = flag(values, 'json');
  const say = (line: string) => {
    if (!json) ctx.out(line);
  };
  const space = await api.getSpace();
  const seq = num(values, 'seq') ?? space.head.seq;
  if (!Number.isInteger(seq) || seq < 0 || seq > space.head.seq) {
    throw new CliError(`--seq 必须在 0 到 ${space.head.seq} 之间`);
  }
  const p = paths(ws.root);
  mkdirSync(p.chunks, { recursive: true });
  let snapshot: SnapshotView | null = null;
  if (seq > 0) snapshot = await api.getSnapshot(seq);
  if (flag(values, 'scan') && snapshot?.scan?.assetHash === undefined) {
    throw new CliError(`seq ${seq} 没有原始扫描，--scan 没有可下载的`);
  }
  const spaceFile: SpaceFile = {
    spaceId: ws.config.spaceId,
    name: space.name,
    ...(space.description !== undefined ? { description: space.description } : {}),
    ...(space.visibility !== undefined ? { visibility: space.visibility } : {}),
    seq,
    at: snapshot?.at ?? space.head.at,
    regions: snapshot?.regions ?? space.regions,
    plots: snapshot?.plots ?? space.plots,
    scan: snapshot?.scan ?? null,
    ...(snapshot?.paletteHash !== undefined ? { paletteHash: snapshot.paletteHash } : {}),
    pulledAt: new Date().toISOString(),
  };
  const chunks = chunkRefs(snapshot);
  const downloaded = await downloadChunks((hash) => api.getChunk(hash), p.chunks, chunks);
  const entities = snapshot ? entityBodies(snapshot) : [];
  const anchors = snapshot?.anchors ?? space.anchors;
  writeBase(ws.root, {
    space: spaceFile,
    palette: {
      ...(snapshot?.palette?.hash !== undefined ? { hash: snapshot.palette.hash } : {}),
      blocks: snapshot?.palette?.blocks ?? [],
    },
    anchors,
    entities,
    chunks,
  });
  const warnings: string[] = [];
  const limitsNote = saveLimits(ws.root, space.uploadLimits);
  if (limitsNote !== null) warnings.push(limitsNote);
  // 网页用模型（默认版本），本地查看器的"原始"视图用；取不到不影响建造。
  const model = spaceFile.scan?.webModelHashes?.[0];
  if (model !== undefined && isSha256Hex(model)) {
    const target = join(p.assets, `${model}.glb`);
    if (!existsSync(target)) {
      const bytes = await api.getAsset(model).catch(() => null);
      if (bytes === null) {
        warnings.push(`没有下载到网页用模型 ${model}（本地查看器的"原始"视图会显示为空）`);
      } else {
        mkdirSync(p.assets, { recursive: true });
        writeFileSync(target, bytes);
      }
    }
  }
  let scan: ScanDownload | null = null;
  let transform = false;
  if (flag(values, 'scan')) {
    scan = await pullScan(ctx, api, ws.root, snapshot!.scan!.assetHash!, say);
    transform = writeTransform(ws.root, snapshot, seq);
    if (!transform) warnings.push('这个版本的扫描没有变换，没有写 scan/transform.json');
    if (!scan.file.endsWith('scan.zip')) {
      warnings.push(
        `原始扫描不是 zip，写成了 ${scan.file}：本地重建工具默认找 scan/scan.zip，运行时用 --scan 指定`,
      );
    }
  }
  installSkill(ctx.sdkRoot, ws.root, true);
  linkSdk(ctx.sdkRoot, ws.root);
  if (json) {
    printJson(ctx, {
      spaceId: ws.config.spaceId,
      seq,
      chunks: chunks.length,
      downloadedChunks: downloaded,
      entities: entities.length,
      anchors: anchors.length,
      regions: spaceFile.regions.length,
      plots: spaceFile.plots.length,
      limits: limitsNote === null,
      ...(scan !== null ? { scan: { ...scan, transform } } : {}),
      warnings,
    });
    return 0;
  }
  ctx.out(
    `已拉取空间 ${ws.config.spaceId} 的 seq ${seq}${seq === space.head.seq ? '（最新）' : `（最新是 ${space.head.seq}）`}`,
  );
  ctx.out(
    `  区块 ${chunks.length}（新下载 ${downloaded}），物件 ${entities.length}，锚点 ${anchors.length}，区域 ${spaceFile.regions.length}，地块 ${spaceFile.plots.length}`,
  );
  for (const plot of spaceFile.plots) {
    ctx.out(`  地块 ${plot.id}：${plot.boxes.map((b) => JSON.stringify(b)).join('、')}（格）`);
  }
  if (limitsNote === null) ctx.out('  上传上限写进了 limits.json');
  if (scan !== null) {
    ctx.out(
      scan.skipped
        ? `  原始扫描已经在 ${scan.file}（内容相同，没有重新下载）`
        : `  原始扫描 ${formatBytes(scan.bytes)} 写进了 ${scan.file}${scan.resumedFrom > 0 ? `（从 ${formatBytes(scan.resumedFrom)} 处接着下）` : ''}`,
    );
    if (transform) ctx.out('  扫描的变换写进了 scan/transform.json');
  }
  for (const warning of warnings) ctx.err(`注意：${warning}`);
  return 0;
}

/** `pull --share`：只读公开快照，不经 NyxID（docs/design/server-slim.md 8.5）。 */
async function pullShare(
  ctx: CliContext,
  ws: Workspace,
  values: Parameters<typeof str>[0],
): Promise<number> {
  if (flag(values, 'scan')) {
    throw new CliError(
      '--scan 不能和 --share 一起用：原始扫描不公开，要经 NyxID 用 metaverse pull --scan 下载',
    );
  }
  let link;
  try {
    link = parseShareLink(str(values, 'share')!, ctx.env.METAVERSE_SHARE_TOKEN);
  } catch (error) {
    if (error instanceof ShareLinkError) throw new CliError(error.message);
    throw error;
  }
  if (link.spaceId !== ws.config.spaceId) {
    throw new CliError(`分享链接是空间 ${link.spaceId} 的，工作区是 ${ws.config.spaceId}`);
  }
  const api = new PublicApi(link, {
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(ctx.sleep ? { retryDelayMs: 0 } : {}),
  });
  const json = flag(values, 'json');
  const space = await api.getSpace();
  const head = space.head?.seq ?? 0;
  const seq = num(values, 'seq') ?? head;
  if (!Number.isInteger(seq) || seq < 1 || seq > head) {
    throw new CliError(head === 0 ? '这个空间还没有发布过版本' : `--seq 必须在 1 到 ${head} 之间`);
  }
  const snapshot = await api.getSnapshot(seq);
  const p = paths(ws.root);
  mkdirSync(p.chunks, { recursive: true });
  const chunks = chunkRefs(snapshot);
  const downloaded = await downloadChunks((hash) => api.getChunk(hash), p.chunks, chunks);
  const entities = entityBodies(snapshot);
  const spaceFile: SpaceFile = {
    spaceId: ws.config.spaceId,
    name: space.name,
    ...(space.description !== undefined ? { description: space.description } : {}),
    ...(space.visibility !== undefined ? { visibility: space.visibility } : {}),
    seq,
    at: snapshot.at,
    regions: snapshot.regions,
    plots: snapshot.plots,
    scan: snapshot.scan ?? null,
    ...(snapshot.paletteHash !== undefined ? { paletteHash: snapshot.paletteHash } : {}),
    pulledAt: new Date().toISOString(),
    readOnly: true,
  };
  writeBase(ws.root, {
    space: spaceFile,
    palette: {
      ...(snapshot.palette?.hash !== undefined ? { hash: snapshot.palette.hash } : {}),
      blocks: snapshot.palette?.blocks ?? [],
    },
    anchors: snapshot.anchors,
    entities,
    chunks,
  });
  const transform = writeTransform(ws.root, snapshot, seq);
  // 网页用模型和物件模型（按哈希核对，坏数据不落盘）。
  const assets: string[] = [];
  if (flag(values, 'assets')) {
    const hashes = new Set<string>(snapshot.scan?.webModelHashes ?? []);
    for (const entity of entities) if (entity.assetHash !== undefined) hashes.add(entity.assetHash);
    mkdirSync(p.assets, { recursive: true });
    for (const hash of [...hashes].sort()) {
      if (!isSha256Hex(hash)) throw new CliError(`快照里的资源哈希格式不对：${hash}`);
      const target = join(p.assets, `${hash}.glb`);
      if (!existsSync(target)) {
        const bytes = await api.getAsset(hash);
        if (sha256Hex(bytes) !== hash) throw new CliError(`资源 ${hash} 的内容与哈希不符`);
        writeFileSync(target, bytes);
      }
      assets.push(target);
    }
  }
  installSkill(ctx.sdkRoot, ws.root, true);
  linkSdk(ctx.sdkRoot, ws.root);
  if (json) {
    printJson(ctx, {
      spaceId: ws.config.spaceId,
      seq,
      readOnly: true,
      chunks: chunks.length,
      downloadedChunks: downloaded,
      entities: entities.length,
      anchors: snapshot.anchors.length,
      transform,
      assets: assets.length,
    });
    return 0;
  }
  ctx.out(
    `已用分享链接拉取空间 ${ws.config.spaceId} 的公开快照 seq ${seq}${seq === head ? '（最新）' : `（最新是 ${head}）`}，工作区标记为只读`,
  );
  ctx.out(
    `  区块 ${chunks.length}（新下载 ${downloaded}），物件 ${entities.length}，公开锚点 ${snapshot.anchors.length}` +
      (transform ? '，扫描的变换写进了 scan/transform.json' : ''),
  );
  if (flag(values, 'assets')) ctx.out(`  网页用模型和物件模型 ${assets.length} 个在 assets/`);
  ctx.out(
    '  这是公开快照：内部锚点、原始扫描都没有，不能 push；要推送先用 metaverse pull 经 NyxID 重新拉取',
  );
  return 0;
}
