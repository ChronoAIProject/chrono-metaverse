import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, writeJson } from './files.js';

/**
 * 工作区里推送过的草稿（`out/drafts.json`）：`metaverse publish <草稿编号>` 据此找到草稿所属的路径范围
 * 和发布时用的提交说明。草稿属于创建时的范围（实体区、地块、重建），发布也要走同一范围的路径。
 */
export interface DraftRecord {
  /** 地块草稿的地块编号；实体区和重建草稿是 null。 */
  readonly plot: string | null;
  /** 重建草稿（`metaverse bundle push` 建的）写 `rebuild`；旧记录没有这一项。 */
  readonly scope?: 'rebuild';
  readonly baseSeq: number;
  /** 实体区、地块草稿的操作条数。 */
  readonly opCount?: number;
  /** 重建草稿交的包（清单的 sha256）。 */
  readonly bundle?: string;
  readonly createdAt: string;
  /** 提交说明：发布时没给 --message 就用它。 */
  readonly message?: string;
  readonly preview?: string;
  /** 用户预览绑定的草稿修订，发布时防止误发后续修改。 */
  readonly previewRev?: number;
}

function draftsFile(root: string): string {
  return join(paths(root).out, 'drafts.json');
}

export function readDrafts(root: string): Record<string, DraftRecord> {
  const file = draftsFile(root);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, DraftRecord>;
  } catch {
    return {};
  }
}

export function saveDraft(root: string, draftId: string, record: DraftRecord): void {
  mkdirSync(paths(root).out, { recursive: true });
  writeJson(draftsFile(root), { ...readDrafts(root), [draftId]: record });
}
