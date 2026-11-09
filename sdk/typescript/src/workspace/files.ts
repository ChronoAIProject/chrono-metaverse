import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chunkKeyString,
  compressChunk,
  decompressChunk,
  type ChunkKey,
  type Layer,
} from '../core/chunk.js';
import { isSha256Hex } from '../core/hash.js';
import { WorkingState, type PaletteBlock } from '../core/ops.js';
import { normalizeEntityBody, type AnchorBody, type EntityBody } from '../core/record.js';
import type { Plot, Region } from '../core/scope.js';

/**
 * 工作区的文件布局（设计 10.1）：
 *
 * ```
 * metaverse.json   工作区配置
 * space.json       空间信息、区域、地块、基于哪个 seq
 * palette.json     方块表
 * anchors.json     锚点（含内部级）
 * entities.json    物件
 * chunks/          拉取下来的区块（<哈希>.bin，zlib）和清单 index.json
 * build/           建造脚本（可以用 git 管理）
 * assets/          网页用模型、贴图缓存
 * out/             build 的输出：ops.ndjson、result.json、新区块、截图
 * ```
 */

export interface ChunkRef extends ChunkKey {
  readonly hash: string;
}

export interface ScanInfo {
  readonly assetHash?: string;
  readonly webModelHashes: readonly string[];
  readonly transform?: readonly number[];
  readonly observedAt?: string;
}

/** 拉取下来的空间信息（space.json）。 */
export interface SpaceFile {
  readonly spaceId: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility?: string;
  /** 基础版本的 seq。 */
  readonly seq: number;
  /** 基础版本的提交时间。 */
  readonly at: string;
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly scan?: ScanInfo | null;
  readonly paletteHash?: string;
  readonly pulledAt?: string;
  /**
   * 用分享链接拉取的公开快照（`metaverse pull --share`）：只有公开锚点，不能推送。经 NyxID 的
   * `metaverse pull` 会重写 space.json，去掉这个标记。
   */
  readonly readOnly?: boolean;
}

export interface PaletteFile {
  readonly hash?: string;
  readonly blocks: readonly PaletteBlock[];
}

/** 工作区里拉取的基础状态。 */
export interface BaseState {
  readonly space: SpaceFile;
  readonly palette: PaletteFile;
  readonly anchors: readonly AnchorBody[];
  readonly entities: readonly EntityBody[];
  readonly chunks: readonly ChunkRef[];
  /** 是否真的拉取过（没有 space.json 时是空的基础状态）。 */
  readonly pulled: boolean;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function paths(root: string) {
  return {
    root,
    config: join(root, 'metaverse.json'),
    space: join(root, 'space.json'),
    palette: join(root, 'palette.json'),
    anchors: join(root, 'anchors.json'),
    entities: join(root, 'entities.json'),
    chunks: join(root, 'chunks'),
    chunkIndex: join(root, 'chunks', 'index.json'),
    build: join(root, 'build'),
    assets: join(root, 'assets'),
    out: join(root, 'out'),
    outChunks: join(root, 'out', 'chunks'),
    outOps: join(root, 'out', 'ops.ndjson'),
    outResult: join(root, 'out', 'result.json'),
    shots: join(root, 'out', 'shots'),
    skill: join(root, '.claude', 'skills', 'metaverse-builder', 'SKILL.md'),
  };
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new WorkspaceError(`读不了 ${path}：${(error as Error).message}`);
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function emptySpace(spaceId: string): SpaceFile {
  return { spaceId, name: spaceId, seq: 0, at: new Date(0).toISOString(), regions: [], plots: [] };
}

/** 读工作区的基础状态；还没拉取时返回空的基础状态。 */
export function readBase(root: string, spaceId: string): BaseState {
  const p = paths(root);
  if (!existsSync(p.space)) {
    return {
      space: emptySpace(spaceId),
      palette: { blocks: [] },
      anchors: [],
      entities: [],
      chunks: [],
      pulled: false,
    };
  }
  const space = readJson<SpaceFile>(p.space);
  if (space.spaceId !== spaceId) {
    throw new WorkspaceError(
      `space.json 是空间 ${space.spaceId} 的，和 metaverse.json 的 ${spaceId} 不一致`,
    );
  }
  return {
    space,
    palette: existsSync(p.palette) ? readJson<PaletteFile>(p.palette) : { blocks: [] },
    anchors: existsSync(p.anchors) ? readJson<AnchorBody[]>(p.anchors) : [],
    entities: existsSync(p.entities)
      ? readJson<EntityBody[]>(p.entities).map(normalizeEntityBody)
      : [],
    chunks: existsSync(p.chunkIndex) ? readJson<ChunkRef[]>(p.chunkIndex) : [],
    pulled: true,
  };
}

/** 区块文件路径：先找拉取的，再找本地建造输出的。 */
export function chunkFile(root: string, hash: string): string | null {
  if (!isSha256Hex(hash)) return null;
  const p = paths(root);
  for (const dir of [p.chunks, p.outChunks]) {
    const file = join(dir, `${hash}.bin`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** 读一个区块（核对哈希）。 */
export function readChunk(root: string, hash: string): Uint16Array {
  const file = chunkFile(root, hash);
  if (file === null) throw new WorkspaceError(`工作区里没有区块 ${hash}：先运行 metaverse pull`);
  return decompressChunk(new Uint8Array(readFileSync(file)), hash);
}

/** 写一个区块（zlib），文件名是哈希。 */
export function writeChunk(dir: string, hash: string, cells: Uint16Array): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${hash}.bin`);
  if (!existsSync(file)) writeFileSync(file, compressChunk(cells));
}

/** 基础状态 → 工作状态（区块从 chunks/ 读出并核对哈希）。 */
export function baseWorkingState(root: string, base: BaseState): WorkingState {
  const state = new WorkingState({ palette: [...base.palette.blocks] });
  for (const ref of base.chunks) {
    state.chunks.set(chunkKeyString(ref), readChunk(root, ref.hash));
  }
  for (const entity of base.entities) state.entities.set(entity.entityId, entity);
  for (const anchor of base.anchors) state.anchors.set(anchor.anchorId, anchor);
  return state;
}

/** 写入拉取结果（space.json、palette.json、anchors.json、entities.json、chunks/index.json）。 */
export function writeBase(root: string, base: Omit<BaseState, 'pulled'>): void {
  const p = paths(root);
  mkdirSync(p.chunks, { recursive: true });
  writeJson(p.space, base.space);
  writeJson(p.palette, base.palette);
  writeJson(p.anchors, base.anchors);
  writeJson(p.entities, base.entities);
  writeJson(p.chunkIndex, base.chunks);
}

export function isLayer(value: unknown): value is Layer {
  return value === 'rebuilt' || value === 'ext';
}
