import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkHash, decompressChunk } from '../core/chunk.js';
import { isSha256Hex } from '../core/hash.js';
import { normalizeEntityBody, type EntityBody } from '../core/record.js';
import type { MetaverseApi, SnapshotView } from '../transport/api.js';
import { paths, writeBase, type ChunkRef, type SpaceFile } from '../workspace/files.js';
import { installSkill, linkSdk } from './init.js';
import {
  CliError,
  flag,
  makeApi,
  num,
  openWorkspace,
  parse,
  printJson,
  type CliContext,
} from './common.js';

export const PULL_HELP = `metaverse pull [--seq <n>]

下载空间的当前状态（或指定 seq 的版本）到工作区：space.json、palette.json、anchors.json、
entities.json、chunks/（区块，按哈希核对），以及网页用模型（assets/，本地查看器的"原始"视图用）。
已有的区块和资源不重复下载。`;

const CONCURRENCY = 6;

async function downloadChunks(
  api: MetaverseApi,
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
      const bytes = await api.getChunk(hash);
      // 解压并核对哈希，坏数据不落盘。
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

export async function runPull(ctx: CliContext, args: readonly string[]): Promise<number> {
  const { values } = parse(args, { seq: { type: 'string' } });
  if (flag(values, 'help')) {
    ctx.out(PULL_HELP);
    return 0;
  }
  const ws = openWorkspace(ctx, values);
  const api = makeApi(ctx, ws, values);
  const json = flag(values, 'json');
  const space = await api.getSpace();
  const seq = num(values, 'seq') ?? space.head.seq;
  if (!Number.isInteger(seq) || seq < 0 || seq > space.head.seq) {
    throw new CliError(`--seq 必须在 0 到 ${space.head.seq} 之间`);
  }
  const p = paths(ws.root);
  mkdirSync(p.chunks, { recursive: true });
  let snapshot: SnapshotView | null = null;
  if (seq > 0) snapshot = await api.getSnapshot(seq);
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
  const chunks: ChunkRef[] = (snapshot?.chunks ?? []).map((c) => ({
    layer: c.layer,
    cx: c.cx,
    cy: c.cy,
    cz: c.cz,
    hash: c.hash,
  }));
  const downloaded = await downloadChunks(api, p.chunks, chunks);
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
  // 网页用模型（默认版本），本地查看器的"原始"视图用；取不到不影响建造。
  const warnings: string[] = [];
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
  for (const warning of warnings) ctx.err(`注意：${warning}`);
  return 0;
}
