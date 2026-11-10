import { chunkKeyString } from '../core/chunk.js';
import type { BuildResult } from './build.js';

/** `metaverse diff` 和 `metaverse check` 的统计与说明。 */

export interface ChangeCounts {
  added: number;
  modified: number;
  removed: number;
}

export interface DiffSummary {
  readonly baseSeq: number;
  readonly scope: string;
  readonly opCount: number;
  readonly opsByType: Record<string, number>;
  readonly chunks: { readonly rebuilt: ChangeCounts; readonly ext: ChangeCounts };
  readonly entities: ChangeCounts & {
    readonly ids: { added: string[]; modified: string[]; removed: string[] };
  };
  readonly anchors: ChangeCounts & {
    readonly ids: { added: string[]; modified: string[]; removed: string[] };
  };
  readonly newBlocks: readonly string[];
}

function counts(): ChangeCounts {
  return { added: 0, modified: 0, removed: 0 };
}

export function diffSummary(result: BuildResult): DiffSummary {
  const opsByType: Record<string, number> = {};
  for (const op of result.ops) opsByType[op.op] = (opsByType[op.op] ?? 0) + 1;
  const baseHashes = result.baseState.chunkHashes();
  const chunks = { rebuilt: counts(), ext: counts() };
  for (const change of result.chunkChanges) {
    const bucket = chunks[change.layer];
    const existed = baseHashes.has(chunkKeyString(change));
    if (change.hash === null) bucket.removed += 1;
    else if (existed) bucket.modified += 1;
    else bucket.added += 1;
  }
  const idChanges = (
    changes: readonly { id: string; hash: string | null }[],
    existed: (id: string) => boolean,
  ) => {
    const ids = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
    for (const change of changes) {
      if (change.hash === null) ids.removed.push(change.id);
      else if (existed(change.id)) ids.modified.push(change.id);
      else ids.added.push(change.id);
    }
    return {
      added: ids.added.length,
      modified: ids.modified.length,
      removed: ids.removed.length,
      ids,
    };
  };
  return {
    baseSeq: result.base.space.seq,
    scope: result.target.scope,
    opCount: result.ops.length,
    opsByType,
    chunks,
    entities: idChanges(result.entityChanges, (id) => result.baseState.entities.has(id)),
    anchors: idChanges(result.anchorChanges, (id) => result.baseState.anchors.has(id)),
    newBlocks: result.provisionalBlocks.map((b) => `${b.name}（临时编号 ${b.id}）`),
  };
}

function line(label: string, c: ChangeCounts): string {
  return `${label}：新增 ${c.added}，修改 ${c.modified}，删除 ${c.removed}`;
}

function preview(ids: readonly string[], max = 12): string {
  if (ids.length === 0) return '';
  const shown = ids.slice(0, max).join('、');
  return ids.length > max ? `${shown} 等 ${ids.length} 个` : shown;
}

export function formatDiff(summary: DiffSummary): string {
  const out = [
    `基于 seq ${summary.baseSeq}，目标 ${summary.scope}，共 ${summary.opCount} 条操作` +
      (summary.opCount > 0
        ? `（${Object.entries(summary.opsByType)
            .map(([name, n]) => `${name} ${n}`)
            .join('，')}）`
        : ''),
    line('扩展层区块', summary.chunks.ext),
  ];
  if (
    summary.chunks.rebuilt.added +
      summary.chunks.rebuilt.modified +
      summary.chunks.rebuilt.removed >
    0
  ) {
    out.push(line('重建层区块', summary.chunks.rebuilt));
  }
  out.push(line('物件', summary.entities));
  for (const [label, ids] of [
    ['  新增', summary.entities.ids.added],
    ['  修改', summary.entities.ids.modified],
    ['  删除', summary.entities.ids.removed],
  ] as const) {
    if (ids.length > 0) out.push(`${label}：${preview(ids)}`);
  }
  out.push(line('锚点', summary.anchors));
  for (const [label, ids] of [
    ['  新增', summary.anchors.ids.added],
    ['  修改', summary.anchors.ids.modified],
    ['  删除', summary.anchors.ids.removed],
  ] as const) {
    if (ids.length > 0) out.push(`${label}：${preview(ids)}`);
  }
  if (summary.newBlocks.length > 0) out.push(`新增方块：${summary.newBlocks.join('、')}`);
  return out.join('\n');
}

export interface CheckReport {
  readonly ok: boolean;
  readonly text: string;
}

/** 检查每条操作的影响范围是否都落在目标地块或实体区内。 */
export function checkReport(result: BuildResult): CheckReport {
  const target = result.target;
  const where = target.plotId ? `地块 ${target.plotId} ` : '实体区';
  if (target.mode === 'within' && target.boxes.length === 0 && result.ops.length > 0) {
    return {
      ok: false,
      text: `${where}没有任何盒子（还没有定义区域或地块，或者工作区没有拉取）：所有改动都会被服务端拒绝`,
    };
  }
  if (result.outside.length === 0) {
    return {
      ok: true,
      text: `全部 ${result.ops.length} 条操作都落在${where}内（${target.scope}）`,
    };
  }
  const lines = [`有 ${result.outside.length} 条操作超出了${where}范围（${target.scope}）：`];
  for (const violation of result.outside.slice(0, 20)) {
    const parts = violation.cells.map((cells) => JSON.stringify(cells));
    if (violation.spaceWide) parts.push('整个空间（_space 锚点只能经实体区路径修改）');
    lines.push(`  第 ${violation.index} 条 ${violation.op}：${parts.join('、')}`);
  }
  if (result.outside.length > 20) lines.push(`  …… 还有 ${result.outside.length - 20} 条`);
  if (target.mode === 'except') {
    lines.push(
      `空间没有定义实体区：除了虚拟区和地块都可以改；不能碰的盒子（格）：${target.excluded.map((b) => JSON.stringify(b)).join('、')}`,
    );
  } else {
    lines.push(`允许的盒子（格）：${target.boxes.map((b) => JSON.stringify(b)).join('、')}`);
  }
  return { ok: false, text: lines.join('\n') };
}
