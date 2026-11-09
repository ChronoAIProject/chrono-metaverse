import type { GridBox } from '../core/grid.js';
import type { Op, PaletteBlock } from '../core/ops.js';
import type { AnchorBody, EntityBody } from '../core/record.js';
import type { Plot, Region } from '../core/scope.js';
import type { ApiClient } from './client.js';

/**
 * 命令行用到的接口（设计 8.3、8.4）。路径和字段集中写在这里，接口服务定稿后只改这一个文件。
 * 请求体字段按 metaverse-core 的 serde 定义（小驼峰）；响应解析尽量宽松（编号字段同时认
 * `id` / `xxxId`）。
 *
 * 作用范围放在路径里：实体区 `/api/v1/spaces/{space_id}/…`，地块
 * `/api/v1/spaces/{space_id}/plots/{plot_id}/…`。
 */

export type UploadPurpose = 'scan' | 'model' | 'texture' | 'ops' | 'script';

export interface SpaceView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility?: string;
  readonly head: { readonly seq: number; readonly at: string; readonly commitId?: string };
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly anchors: readonly AnchorBody[];
}

/** `GET /api/v1/spaces/{id}/snapshot?seq=` 的响应（与公开快照同形，锚点含内部级）。 */
export interface SnapshotView {
  readonly spaceId?: string;
  readonly seq: number;
  readonly at: string;
  readonly paletteHash?: string;
  readonly palette?: { readonly hash?: string; readonly blocks: readonly PaletteBlock[] };
  readonly chunks: readonly {
    readonly layer: 'rebuilt' | 'ext';
    readonly cx: number;
    readonly cy: number;
    readonly cz: number;
    readonly hash: string;
  }[];
  /** 物件记录 `{ id, hash?, body }`（也接受直接给 body）。 */
  readonly entities: readonly (
    { readonly id: string; readonly hash?: string; readonly body: EntityBody } | EntityBody
  )[];
  readonly anchors: readonly AnchorBody[];
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly scan?: {
    readonly assetHash?: string;
    readonly webModelHashes: readonly string[];
    readonly transform?: readonly number[];
    readonly observedAt?: string;
  } | null;
}

export interface CreateUploadRequest {
  /** 总字节数。 */
  readonly size: number;
  /** 整体 SHA-256（小写十六进制）。 */
  readonly sha256: string;
  /** 分片大小：256KiB 的整数倍，最大 32MiB。 */
  readonly partSize: number;
  readonly contentType?: string;
  readonly fileName?: string;
}

/** 创建上传的响应。内容已存在时直接给 `assetHash`（`status: "done"`），不用再传数据。 */
export interface UploadSession {
  readonly uploadId?: string;
  readonly id?: string;
  readonly status?: string;
  readonly partSize?: number;
  readonly partCount?: number;
  readonly assetHash?: string;
  readonly reused?: boolean;
  readonly jobId?: string;
}

export interface JobView {
  readonly id?: string;
  readonly jobId?: string;
  readonly kind: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly lastError?: string | null;
  readonly resultCommitId?: string | null;
  readonly result?: unknown;
  readonly progress?: unknown;
  readonly createdAt?: string;
}

export interface DraftView {
  readonly id?: string;
  readonly draftId?: string;
  readonly scope?: string;
  readonly baseSeq?: number;
  readonly rev?: number;
  readonly expiresAt?: string;
}

export interface PreviewView {
  readonly token?: string;
  readonly url?: string;
  readonly expiresAt?: string;
}

export interface PublishView {
  readonly seq?: number;
  readonly at?: string;
  readonly commitId?: string;
  readonly id?: string;
}

export interface CreateSpaceRequest {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly owner: { readonly kind: 'person' | 'org'; readonly id: string };
  readonly visibility?: 'unlisted' | 'public';
}

export interface EventTypeRequest {
  readonly type: string;
  readonly schema: unknown;
  readonly publicFields?: readonly string[];
  readonly defaultVisibility: 'public' | 'internal';
  readonly state?: unknown;
  readonly maxAgeSec?: number;
  readonly display: unknown;
}

/** 作用范围对应的路径前缀。 */
export function scopePath(spaceId: string, plot?: string | null): string {
  const base = `/api/v1/spaces/${encodeURIComponent(spaceId)}`;
  return plot ? `${base}/plots/${encodeURIComponent(plot)}` : base;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

export function idOf(
  value: { id?: string; uploadId?: string; jobId?: string; draftId?: string },
  key: 'uploadId' | 'jobId' | 'draftId',
): string | undefined {
  return value[key] ?? value.id;
}

export class MetaverseApi {
  constructor(
    readonly client: ApiClient,
    readonly spaceId: string,
  ) {}

  private get space(): string {
    return scopePath(this.spaceId);
  }

  // ---- 查看 -----------------------------------------------------------------

  /** `GET /api/v1/spaces/{space_id}` */
  getSpace(): Promise<SpaceView> {
    return this.client.json('GET', this.space);
  }

  /** `GET /api/v1/spaces/{space_id}/snapshot?seq=` */
  getSnapshot(seq: number): Promise<SnapshotView> {
    return this.client.json('GET', `${this.space}/snapshot`, { query: { seq } });
  }

  /** `GET /api/v1/spaces/{space_id}/chunks/{hash}`：zlib 压缩的区块。 */
  getChunk(hash: string): Promise<Uint8Array> {
    return this.client.bytes(`${this.space}/chunks/${seg(hash)}`);
  }

  /** `GET /api/v1/spaces/{space_id}/assets/{hash}`：资源原始字节；没有时返回 null。 */
  async getAsset(hash: string): Promise<Uint8Array | null> {
    const response = await this.client.request('GET', `${this.space}/assets/${seg(hash)}`, {
      allow: [404],
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /** `GET /api/v1/spaces/{space_id}/jobs/{job_id}` */
  getJob(jobId: string): Promise<JobView> {
    return this.client.json('GET', `${this.space}/jobs/${seg(jobId)}`);
  }

  // ---- 上传 -----------------------------------------------------------------

  /** `POST {范围}/uploads/{purpose}` */
  createUpload(
    purpose: UploadPurpose,
    request: CreateUploadRequest,
    plot?: string | null,
  ): Promise<UploadSession> {
    return this.client.json('POST', `${scopePath(this.spaceId, plot)}/uploads/${purpose}`, {
      json: request,
    });
  }

  /** `PUT {范围}/uploads/{purpose}/{upload_id}/parts/{n}`（n 从 0 开始），请求体是这一片的原始字节。 */
  putPart(
    purpose: UploadPurpose,
    uploadId: string,
    n: number,
    bytes: Uint8Array,
    plot?: string | null,
  ): Promise<unknown> {
    return this.client.json(
      'PUT',
      `${scopePath(this.spaceId, plot)}/uploads/${purpose}/${seg(uploadId)}/parts/${n}`,
      {
        body: bytes,
        contentType: 'application/octet-stream',
      },
    );
  }

  /** `POST {范围}/uploads/{purpose}/{upload_id}/complete` → 202 `{ jobId }`（upload_verify 任务）。 */
  completeUpload(
    purpose: UploadPurpose,
    uploadId: string,
    plot?: string | null,
  ): Promise<{ jobId?: string; id?: string; assetHash?: string }> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, plot)}/uploads/${purpose}/${seg(uploadId)}/complete`,
      {
        json: {},
      },
    );
  }

  // ---- 扫描 -----------------------------------------------------------------

  /** `POST /api/v1/spaces/{space_id}/scans` → 202 `{ jobId }`（scan_import 任务）。 */
  importScan(request: {
    assetHash: string;
    observedAt?: string;
    transform?: readonly number[];
    rebuild?: boolean;
    voxelize?: boolean;
    hints?: unknown;
  }): Promise<{ jobId?: string; id?: string }> {
    return this.client.json('POST', `${this.space}/scans`, { json: request });
  }

  /** `POST /api/v1/spaces/{space_id}/scans/{scan_id}/alignment`，请求体 `{ transform }`：用给定变换重新导入。 */
  alignScan(
    scanId: string,
    request: { transform: readonly number[] },
  ): Promise<{ jobId?: string; id?: string }> {
    return this.client.json('POST', `${this.space}/scans/${seg(scanId)}/alignment`, {
      json: request,
    });
  }

  /** `POST /api/v1/spaces/{space_id}/scans/{scan_id}/voxelize` → 202 `{ jobId }`。 */
  voxelizeScan(
    scanId: string,
    request: { style?: string },
  ): Promise<{ jobId?: string; id?: string }> {
    return this.client.json('POST', `${this.space}/scans/${seg(scanId)}/voxelize`, {
      json: request,
    });
  }

  // ---- 草稿 -----------------------------------------------------------------

  /** `POST {范围}/drafts`，请求体 `{ baseSeq, message? }`。 */
  createDraft(
    request: { baseSeq: number; message?: string },
    plot?: string | null,
  ): Promise<DraftView> {
    return this.client.json('POST', `${scopePath(this.spaceId, plot)}/drafts`, { json: request });
  }

  /** `POST {范围}/drafts/{draft_id}/ops`，请求体 `{ ops }`（≤ 200 条、≤ 1MB）。 */
  addOps(
    draftId: string,
    ops: readonly Op[],
    plot?: string | null,
  ): Promise<DraftView & Record<string, unknown>> {
    return this.client.json('POST', `${scopePath(this.spaceId, plot)}/drafts/${seg(draftId)}/ops`, {
      json: { ops },
    });
  }

  /** `POST {范围}/drafts/{draft_id}/ops-from-upload`，请求体 `{ assetHash }` → 202 `{ jobId }`（ops_from_upload 任务）。 */
  opsFromUpload(
    draftId: string,
    request: { assetHash: string; uploadId?: string },
    plot?: string | null,
  ): Promise<{ jobId?: string; id?: string } & Record<string, unknown>> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, plot)}/drafts/${seg(draftId)}/ops-from-upload`,
      {
        json: request,
      },
    );
  }

  /** `POST {范围}/drafts/{draft_id}/preview` → `{ token, url?, expiresAt }`。 */
  preview(
    draftId: string,
    request: { ttlSec?: number } = {},
    plot?: string | null,
  ): Promise<PreviewView> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, plot)}/drafts/${seg(draftId)}/preview`,
      {
        json: request,
      },
    );
  }

  /** `POST {范围}/drafts/{draft_id}/publish`，请求体 `{ message?, replay? }`。 */
  publish(
    draftId: string,
    request: { message?: string; replay?: boolean } = {},
    plot?: string | null,
  ): Promise<PublishView> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, plot)}/drafts/${seg(draftId)}/publish`,
      {
        json: request,
      },
    );
  }

  // ---- 管理（设计 8.4，不进 AI 工具） ------------------------------------------

  /** `POST /api/v1/admin/spaces` */
  createSpace(
    request: CreateSpaceRequest,
  ): Promise<{ space?: SpaceView; shareToken?: { id: string; token: string } }> {
    return this.client.json('POST', '/api/v1/admin/spaces', { json: request });
  }

  private get admin(): string {
    return `/api/v1/admin/spaces/${seg(this.spaceId)}`;
  }

  /** `PATCH /api/v1/admin/spaces/{space_id}`，请求体 `{ name?, description?, visibility?, confirmPublic? }`。 */
  updateSpace(request: {
    name?: string;
    description?: string;
    visibility?: 'unlisted' | 'public';
    confirmPublic?: boolean;
  }): Promise<{ space?: SpaceView } & Record<string, unknown>> {
    return this.client.json('PATCH', this.admin, { json: request });
  }

  /** `POST /api/v1/admin/spaces/{space_id}/share-tokens`，请求体 `{ revoke?: [编号], revokeAll? }` → `{ shareToken: { id, token } }`。 */
  rotateShareToken(request: { revoke?: readonly string[]; revokeAll?: boolean }): Promise<{
    shareToken?: { id: string; token: string };
  }> {
    return this.client.json('POST', `${this.admin}/share-tokens`, { json: request });
  }

  /** `PUT /api/v1/admin/spaces/{space_id}/layout`，请求体 `{ baseSeq, regions, plots, message? }`（写一次提交）。 */
  setLayout(request: {
    baseSeq: number;
    regions: readonly Region[];
    plots: readonly Plot[];
    message?: string;
  }): Promise<PublishView> {
    return this.client.json('PUT', `${this.admin}/layout`, { json: request });
  }

  /** `POST /api/v1/admin/spaces/{space_id}/event-types`（只追加的版本记录）。 */
  registerEventType(request: EventTypeRequest): Promise<{ type?: string; version?: number }> {
    return this.client.json('POST', `${this.admin}/event-types`, { json: request });
  }

  /** `POST /api/v1/admin/spaces/{space_id}/events/{event_id}/redact`，请求体 `{ reason? }`。 */
  redactEvent(eventId: string, request: { reason?: string } = {}): Promise<unknown> {
    return this.client.json('POST', `${this.admin}/events/${seg(eventId)}/redact`, {
      json: request,
    });
  }
}

/** 管理命令定义区域和地块时用的文件格式。 */
export interface LayoutFile {
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly message?: string;
}

export type { GridBox };
