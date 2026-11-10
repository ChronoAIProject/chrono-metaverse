import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chunkKeyString, compareChunkKeys, type Layer } from '../core/chunk.js';
import { aabbUnion, boxToMetres, type Aabb, type GridBox, type Vec3 } from '../core/grid.js';
import {
  compareIds,
  OpError,
  parseOps,
  touchedToModel,
  type ChunkChange,
  type Op,
  type PaletteBlock,
  type TouchedSet,
  WorkingState,
} from '../core/ops.js';
import {
  anchorRecordHash,
  entityRecordHash,
  type AnchorBody,
  type EntityBody,
} from '../core/record.js';
import {
  AllowedArea,
  type Footprint,
  type PathScope,
  type Plot,
  type Region,
} from '../core/scope.js';
import type { Shape } from '../core/shape.js';
import * as kit from '../kit/index.js';
import type { WorkspaceConfig } from './config.js';
import {
  baseWorkingState,
  paths,
  readBase,
  writeChunk,
  writeJson,
  type BaseState,
  type ChunkRef,
} from './files.js';

/**
 * 运行建造脚本（`metaverse build`）。
 *
 * 建造脚本是一个 TS/JS 文件，默认导出一个函数：接收拉取的基础状态和工具包，返回操作列表。
 * 每次都从基础状态重新生成，可以反复运行：
 *
 * ```ts
 * export default function build(base, kit) {
 *   const { place, table, chair } = kit;
 *   return [place('table-1', table({ at: [5.6, 0, 1] }), { label: '1 号桌' })];
 * }
 * ```
 */

export type Kit = typeof kit;

/** 建造的目标：实体区或某个地块。 */
export interface BuildTarget {
  readonly scope: PathScope;
  readonly plotId: string | null;
  /** 允许修改的格子盒子（`except` 模式下为空）。 */
  readonly boxes: readonly GridBox[];
  /**
   * 空间没有定义实体区时，实体区路径是"除去"模式（`except`）：不能碰 `excluded` 里的盒子（虚拟区和
   * 地块），其余地方都可以改。
   */
  readonly mode: 'within' | 'except';
  /** `except` 模式下不能碰的盒子。 */
  readonly excluded: readonly GridBox[];
  /** 允许范围在米坐标下的包围盒；没有盒子时为 null。 */
  readonly bounds: Aabb | null;
  /** `bounds.min`：地块的最小角（米），方便按地块内的相对位置摆放。 */
  readonly origin: Vec3 | null;
}

/** 建造脚本收到的基础状态（只读）。 */
export interface BuildBase {
  readonly spaceId: string;
  readonly name: string;
  readonly seq: number;
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly anchors: readonly AnchorBody[];
  readonly entities: readonly EntityBody[];
  readonly palette: readonly PaletteBlock[];
  /** 空间里的模板（`kind: "template"` 的物件），`entity()` 计算实例的包围盒要用。 */
  readonly templates: ReadonlyMap<string, Shape>;
  readonly target: BuildTarget;
  /** 某一格看得到的方块编号（默认）或指定图层的编号。 */
  blockAt(cell: Vec3, layer?: Layer): number;
  /** 按名称查方块表编号；没有就报错。 */
  block(name: string): number;
  plot(id: string): Plot;
  region(id: string): Region;
  entity(id: string): EntityBody | undefined;
  anchor(id: string): AnchorBody | undefined;
}

export type OpLike = Op | readonly OpLike[] | null | undefined | false;
export type BuildOutput = OpLike | { readonly ops: OpLike; readonly message?: string };
export type BuildScript = (base: BuildBase, toolkit: Kit) => BuildOutput | Promise<BuildOutput>;
export type ScriptLoader = (path: string) => Promise<BuildScript>;

export interface IdChange {
  readonly id: string;
  readonly hash: string | null;
}

export interface ScopeViolation {
  readonly index: number;
  readonly op: string;
  readonly cells: readonly GridBox[];
  readonly spaceWide: boolean;
}

export interface BuildResult {
  readonly ops: Op[];
  readonly message: string | null;
  readonly script: string;
  readonly base: BaseState;
  readonly baseState: WorkingState;
  readonly state: WorkingState;
  readonly touched: TouchedSet;
  readonly footprints: Footprint[];
  readonly target: BuildTarget;
  readonly chunkChanges: ChunkChange[];
  readonly entityChanges: IdChange[];
  readonly anchorChanges: IdChange[];
  readonly provisionalBlocks: PaletteBlock[];
  /** 落在目标范围以外的操作（push 前必须为空）。 */
  readonly outside: ScopeViolation[];
}

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

const SCRIPT_CANDIDATES = ['build/main.ts', 'build/main.mjs', 'build/main.js', 'build/index.ts'];

/** 找建造脚本：命令行参数 > metaverse.json 的 buildScript > build/main.ts 等。 */
export function findScript(root: string, config: WorkspaceConfig, explicit?: string): string {
  const given = explicit ?? config.buildScript;
  if (given !== undefined) {
    const path = isAbsolute(given) ? given : resolve(root, given);
    if (!existsSync(path)) throw new BuildError(`找不到建造脚本 ${path}`);
    return path;
  }
  for (const candidate of SCRIPT_CANDIDATES) {
    const path = join(root, candidate);
    if (existsSync(path)) return path;
  }
  throw new BuildError('找不到建造脚本：在 build/main.ts 写一个默认导出函数（见技能说明里的示例）');
}

/** 默认的脚本加载方式：动态导入（node 22.18 起能直接导入 .ts）。每次加时间戳，改了就重新加载。 */
export const defaultLoader: ScriptLoader = async (path) => {
  const module = (await import(`${pathToFileURL(path).href}?v=${Date.now()}`)) as {
    default?: unknown;
  };
  if (typeof module.default !== 'function') {
    throw new BuildError(
      `${path} 必须默认导出一个函数：export default function build(base, kit) { … }`,
    );
  }
  return module.default as BuildScript;
};

/** 建造目标：地块（`plot` 参数或配置）或实体区。 */
export function buildTarget(
  base: BaseState,
  plotId: string | null | undefined,
): { target: BuildTarget; area: AllowedArea } {
  const scope: PathScope = plotId ? `plot:${plotId}` : 'physical';
  let area: AllowedArea;
  try {
    area = AllowedArea.forScope(scope, base.space.regions, base.space.plots);
  } catch (error) {
    throw new BuildError(
      `${(error as Error).message}${base.pulled ? '' : '（工作区还没有拉取，先运行 metaverse pull）'}`,
    );
  }
  const boxes = area.mode === 'within' ? area.boxes : [];
  const bounds = boxes
    .map(boxToMetres)
    .reduce<Aabb | null>((acc, box) => (acc === null ? box : aabbUnion(acc, box)), null);
  return {
    area,
    target: {
      scope,
      plotId: plotId ?? null,
      boxes,
      mode: area.mode,
      excluded: area.mode === 'except' ? area.boxes : [],
      bounds,
      origin: bounds === null ? null : bounds.min,
    },
  };
}

function makeBuildBase(base: BaseState, state: WorkingState, target: BuildTarget): BuildBase {
  // 建造脚本写扩展层：只能引用扩展层的模板。
  const templates = state.templatesOf('ext');
  return {
    spaceId: base.space.spaceId,
    name: base.space.name,
    seq: base.space.seq,
    regions: base.space.regions,
    plots: base.space.plots,
    anchors: base.anchors,
    entities: base.entities,
    palette: base.palette.blocks,
    templates,
    target,
    blockAt: (cell, layer) =>
      layer === undefined ? state.effectiveBlock(cell) : state.blockAt(layer, cell),
    block(name) {
      const found = base.palette.blocks.find((b) => b.name === name);
      if (found === undefined) throw new BuildError(`方块表里没有名为 ${name} 的方块`);
      return found.id;
    },
    plot(id) {
      const found = base.space.plots.find((p) => p.id === id);
      if (found === undefined) throw new BuildError(`地块 ${id} 不存在`);
      return found;
    },
    region(id) {
      const found = base.space.regions.find((r) => r.id === id);
      if (found === undefined) throw new BuildError(`区域 ${id} 不存在`);
      return found;
    },
    entity: (id) => state.entities.get(id),
    anchor: (id) => state.anchors.get(id),
  };
}

/** 把脚本的返回值摊平成操作列表（数组可以嵌套，null / undefined / false 跳过）。 */
export function flattenOps(output: BuildOutput): { ops: unknown[]; message: string | null } {
  let list: OpLike = output as OpLike;
  let message: string | null = null;
  if (output !== null && typeof output === 'object' && !Array.isArray(output) && 'ops' in output) {
    list = output.ops;
    message = typeof output.message === 'string' ? output.message : null;
  }
  const ops: unknown[] = [];
  const walk = (item: OpLike) => {
    if (item === null || item === undefined || item === false) return;
    if (Array.isArray(item)) item.forEach(walk);
    else ops.push(item);
  };
  walk(list);
  return { ops, message };
}

function describeOp(op: Op): string {
  switch (op.op) {
    case 'placeEntity':
      return `placeEntity ${op.entity.entityId}`;
    case 'removeEntity':
      return `removeEntity ${op.entityId}`;
    case 'createAnchor':
      return `createAnchor ${op.anchor.anchorId}`;
    case 'moveAnchor':
    case 'updateAnchor':
    case 'removeAnchor':
      return `${op.op} ${op.anchorId}`;
    case 'addBlock':
      return `addBlock ${op.block.name}`;
    case 'copyRegion':
      return `copyRegion ${JSON.stringify(op.source)} → ${JSON.stringify(op.to)}`;
    case 'setScan':
      return `setScan ${op.scan.assetHash.slice(0, 12)}`;
    case 'clearRebuilt':
      return 'clearRebuilt';
    default:
      return `${op.op} ${JSON.stringify(op.box)}`;
  }
}

export interface RunBuildOptions {
  readonly plot?: string | null;
  readonly script?: string;
  /** 写出 out/ops.ndjson、out/result.json 和新区块（默认 true）。 */
  readonly write?: boolean;
  readonly loader?: ScriptLoader;
}

/** 运行建造脚本，在本地作用全部操作，算出变化。 */
export async function runBuild(
  root: string,
  config: WorkspaceConfig,
  options: RunBuildOptions = {},
): Promise<BuildResult> {
  const base = readBase(root, config.spaceId);
  const baseState = baseWorkingState(root, base);
  const { target, area } = buildTarget(
    base,
    options.plot === undefined ? config.plot : options.plot,
  );
  const script = findScript(root, config, options.script);
  const build = await (options.loader ?? defaultLoader)(script);
  let output: BuildOutput;
  try {
    output = await build(makeBuildBase(base, baseState, target), kit);
  } catch (error) {
    throw new BuildError(`建造脚本出错：${error instanceof Error ? error.message : String(error)}`);
  }
  const flat = flattenOps(output);
  let ops: Op[];
  try {
    ops = parseOps(flat.ops);
  } catch (error) {
    if (error instanceof OpError) {
      throw new BuildError(
        `脚本返回的${error.message}\n  ${JSON.stringify(flat.ops[error.index])}`,
      );
    }
    throw error;
  }
  const state = baseState.clone();
  const footprints: Footprint[] = [];
  let touched: TouchedSet;
  try {
    touched = state.applySequence(ops, null, (_index, footprint) => footprints.push(footprint));
  } catch (error) {
    if (error instanceof OpError) {
      const op = ops[error.index];
      throw new BuildError(`${error.message}${op ? `（${describeOp(op)}）` : ''}`);
    }
    throw error;
  }
  const baseHashes = baseState.chunkHashes();
  const chunkChanges = state.chunkChanges(baseHashes, touched.chunks);
  const spaceId = base.space.spaceId;
  const entityChanges = [...touched.entities].sort(compareIds).flatMap((id) => {
    const now = state.entities.get(id);
    const before = baseState.entities.get(id);
    const hash = now === undefined ? null : entityRecordHash(spaceId, now);
    const old = before === undefined ? null : entityRecordHash(spaceId, before);
    return hash === old ? [] : [{ id, hash }];
  });
  const anchorChanges = [...touched.anchors].sort(compareIds).flatMap((id) => {
    const now = state.anchors.get(id);
    const before = baseState.anchors.get(id);
    const hash = now === undefined ? null : anchorRecordHash(spaceId, now);
    const old = before === undefined ? null : anchorRecordHash(spaceId, before);
    return hash === old ? [] : [{ id, hash }];
  });
  const provisionalBlocks: PaletteBlock[] = [...state.provisionalBlocks.values()]
    .map(({ id, def }) => ({ ...def, id }))
    .sort((a, b) => a.id - b.id);
  const outside: ScopeViolation[] = footprints.flatMap((footprint, index) => {
    const out = area.outside(footprint);
    return out.cells.length > 0 || out.spaceWide
      ? [{ index, op: describeOp(ops[index]!), cells: out.cells, spaceWide: out.spaceWide }]
      : [];
  });
  const result: BuildResult = {
    ops,
    message: flat.message,
    script,
    base,
    baseState,
    state,
    touched,
    footprints,
    target,
    chunkChanges,
    entityChanges,
    anchorChanges,
    provisionalBlocks,
    outside,
  };
  if (options.write !== false) writeBuildOutput(root, result);
  return result;
}

/** 本地建造结果的完整清单（dev 查看器用）。 */
export interface BuildManifest {
  readonly builtAt: string;
  readonly spaceId: string;
  readonly baseSeq: number;
  readonly scope: PathScope;
  readonly script: string;
  readonly message: string | null;
  readonly opCount: number;
  readonly touched: ReturnType<typeof touchedToModel>;
  readonly chunkChanges: ChunkChange[];
  readonly entityChanges: IdChange[];
  readonly anchorChanges: IdChange[];
  readonly provisionalBlocks: PaletteBlock[];
  readonly outside: ScopeViolation[];
  /** 作用后的完整状态。 */
  readonly final: {
    readonly chunks: ChunkRef[];
    readonly entities: EntityBody[];
    readonly anchors: AnchorBody[];
    readonly palette: PaletteBlock[];
  };
}

export function buildManifest(result: BuildResult, builtAt = new Date()): BuildManifest {
  const chunks: ChunkRef[] = [...result.state.chunkHashes()]
    .map(([key, hash]) => {
      const [layer, cx, cy, cz] = key.split(':');
      return { layer: layer as Layer, cx: Number(cx), cy: Number(cy), cz: Number(cz), hash };
    })
    .sort(compareChunkKeys);
  return {
    builtAt: builtAt.toISOString(),
    spaceId: result.base.space.spaceId,
    baseSeq: result.base.space.seq,
    scope: result.target.scope,
    script: result.script,
    message: result.message,
    opCount: result.ops.length,
    touched: touchedToModel(result.touched),
    chunkChanges: result.chunkChanges,
    entityChanges: result.entityChanges,
    anchorChanges: result.anchorChanges,
    provisionalBlocks: result.provisionalBlocks,
    outside: result.outside,
    final: {
      chunks,
      entities: [...result.state.entities.keys()]
        .sort(compareIds)
        .map((id) => result.state.entities.get(id)!),
      anchors: [...result.state.anchors.keys()]
        .sort(compareIds)
        .map((id) => result.state.anchors.get(id)!),
      palette: [...result.base.palette.blocks, ...result.provisionalBlocks],
    },
  };
}

/** 写出 out/ops.ndjson（一行一个操作）、out/result.json 和变化了的区块。 */
export function writeBuildOutput(root: string, result: BuildResult): BuildManifest {
  const p = paths(root);
  rmSync(p.outChunks, { recursive: true, force: true });
  mkdirSync(p.outChunks, { recursive: true });
  writeFileSync(p.outOps, result.ops.map((op) => `${JSON.stringify(op)}\n`).join(''));
  for (const change of result.chunkChanges) {
    if (change.hash === null) continue;
    const cells = result.state.chunks.get(chunkKeyString(change));
    if (cells !== undefined) writeChunk(p.outChunks, change.hash, cells);
  }
  const manifest = buildManifest(result);
  writeJson(p.outResult, manifest);
  return manifest;
}

/** NDJSON 文本（push 上传用）。 */
export function opsToNdjson(ops: readonly Op[]): string {
  return ops.map((op) => `${JSON.stringify(op)}\n`).join('');
}
