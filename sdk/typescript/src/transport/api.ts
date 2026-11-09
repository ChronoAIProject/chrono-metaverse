import type { GridBox } from '../core/grid.js';
import type { Op, PaletteBlock } from '../core/ops.js';
import type { AnchorBody, EntityBody } from '../core/record.js';
import type { Plot, Region } from '../core/scope.js';
import type { ApiClient } from './client.js';

/**
 * 命令行用到的接口（设计 8.3、8.4）。路径和字段集中写在这里，已与接口服务的实现
 * （`api/crates/metaverse-api/src/routes/`）逐项核对。接口服务的请求体都带
 * `deny_unknown_fields`：只发它定义的字段（小驼峰），多一个字段就 422。响应解析尽量宽松
 * （编号字段同时认 `id` / `xxxId`）。
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

/**
 * 上传文件的格式（名称与 metaverse-core 的 `UploadFormat` 相同）。各用途接受的格式：
 * scan、model 用途 glb / drc / obj / zip（zip = 模型 + 贴图，例如 Scaniverse 导出，默认值，服务端可配置）；
 * texture 用途 png / jpeg / webp；ops 用途 ndjson / gzip；script 用途 text。
 */
export type UploadFormat =
  'glb' | 'drc' | 'obj' | 'zip' | 'png' | 'jpeg' | 'webp' | 'ndjson' | 'gzip' | 'text';

/** `POST {范围}/uploads/{purpose}` 的请求体（接口服务拒绝未知字段）。 */
export interface CreateUploadRequest {
  /** 总字节数。 */
  readonly size: number;
  /** 整体 SHA-256（小写十六进制）。 */
  readonly sha256: string;
  /** 分片大小：256KiB 的整数倍，最大 32MiB。 */
  readonly partSize: number;
  /** 文件格式：服务端按用途核对白名单（不在白名单里 422 `unsupported_format`），收到第 0 片时按它核对文件头。 */
  readonly format: UploadFormat;
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
  /** 绑定的草稿版本。 */
  readonly rev?: number;
  readonly expiresAt?: string;
}

/** 预览链接有效期的范围（秒），与接口服务相同。 */
export const PREVIEW_TTL_MIN = 60;
export const PREVIEW_TTL_MAX = 7 * 24 * 3600;

export interface PublishView {
  readonly seq?: number;
  readonly at?: string;
  readonly commitId?: string;
  readonly id?: string;
}

/** 导入扫描的共同选项（`scans` 和 `scans/{scan_id}/alignment` 都收）。 */
export interface ScanImportOptions {
  /** 现实中拍摄的时间（RFC 3339，只用于显示）。 */
  readonly observedAt?: string;
  /** 导入后做 AI 重建，默认 true。 */
  readonly rebuild?: boolean;
  /** 导入后体素化，默认 false。 */
  readonly voxelize?: boolean;
  /** 给处理服务的提示（JSON 对象，≤ 4KB）。 */
  readonly hints?: unknown;
}

/** ops-from-upload 的请求体：上传编号和资源哈希只能给一个。 */
export type OpsFromUploadRequest =
  | { readonly uploadId: string; readonly assetHash?: never }
  | { readonly assetHash: string; readonly uploadId?: never };

/** 分享令牌：编号和原文（原文只在创建、轮换时返回这一次）。 */
export interface ShareTokenView {
  readonly id: string;
  readonly token: string;
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

  /**
   * `GET {范围}/jobs/{job_id}`。经地块路径只能查到经这个地块路径发起的任务（上传校验、
   * ops_from_upload 等）；地块合作方的 agent key 一般只开放地块路径（设计 9.3），所以地块
   * 范围的任务要经地块路径查。
   */
  getJob(jobId: string, plot?: string | null): Promise<JobView> {
    return this.client.json('GET', `${scopePath(this.spaceId, plot)}/jobs/${seg(jobId)}`);
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

  /**
   * `POST /api/v1/spaces/{space_id}/scans` → 202 任务（scan_import，响应里的 `id` 是任务编号）。
   * 请求体没有 `transform`（接口服务拒绝未知字段）：带变换的导入走 `alignScan`。
   */
  importScan(request: ScanImportOptions & { assetHash: string }): Promise<{
    jobId?: string;
    id?: string;
  }> {
    return this.client.json('POST', `${this.space}/scans`, { json: request });
  }

  /**
   * `POST /api/v1/spaces/{space_id}/scans/{scan_id}/alignment`，请求体 `{ transform, observedAt?,
   * rebuild?, voxelize?, hints? }`：用给定变换导入（首次导入或重新对齐都可以；只要求资源已校验）。
   */
  alignScan(
    scanId: string,
    request: ScanImportOptions & { transform: readonly number[] },
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

  /**
   * `POST {范围}/drafts`，请求体只有 `{ baseSeq }`（接口服务拒绝未知字段）。提交说明在发布时
   * 才给（`publish` 的 `message`）。
   */
  createDraft(request: { baseSeq: number }, plot?: string | null): Promise<DraftView> {
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

  /**
   * `POST {范围}/drafts/{draft_id}/ops-from-upload` → 202 `{ jobId, draftId, status }`（ops_from_upload 任务）。
   * 请求体是 `{ uploadId }` 或 `{ assetHash }` 二者之一（两个都给接口服务返回 422）；优先用上传编号，
   * 服务端能核对它是本空间 ops 用途、已完成校验的上传。
   */
  opsFromUpload(
    draftId: string,
    request: OpsFromUploadRequest,
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

  /**
   * `POST {范围}/drafts/{draft_id}/preview`，请求体 `{ ttlSeconds? }`（60–604800 秒，默认 86400；
   * 接口服务拒绝未知字段）→ 201 `{ token, url, rev, expiresAt }`。
   */
  preview(
    draftId: string,
    request: { ttlSeconds?: number } = {},
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

  /** `POST {范围}/drafts/{draft_id}/publish`，请求体 `{ message?, replay? }`（提交说明 ≤ 2000 字，不给时服务端写"发布草稿"）。 */
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

  /** `POST /api/v1/admin/spaces` → 201 `{ space, shareToken: { id, token } }`。 */
  createSpace(
    request: CreateSpaceRequest,
  ): Promise<{ space?: SpaceView; shareToken?: ShareTokenView }> {
    return this.client.json('POST', '/api/v1/admin/spaces', { json: request });
  }

  private get admin(): string {
    return `/api/v1/admin/spaces/${seg(this.spaceId)}`;
  }

  /**
   * `PATCH /api/v1/admin/spaces/{space_id}`，请求体 `{ name?, description?, visibility?,
   * confirmPublicHistory? }`（接口服务拒绝未知字段）→ 修改后的空间（SpaceView 本身）。
   * 凭链接查看 → 公开时必须带 `confirmPublicHistory: true`，否则 409 `confirmation_required`。
   */
  updateSpace(request: {
    name?: string;
    description?: string;
    visibility?: 'unlisted' | 'public';
    confirmPublicHistory?: boolean;
  }): Promise<SpaceView> {
    return this.client.json('PATCH', this.admin, { json: request });
  }

  /**
   * `POST /api/v1/admin/spaces/{space_id}/share-tokens`（没有请求体）→ 201 `{ id, token }`。
   * 接口服务先吊销全部现有令牌再建新令牌，新令牌原文只返回这一次。
   */
  rotateShareToken(): Promise<Partial<ShareTokenView>> {
    return this.client.json('POST', `${this.admin}/share-tokens`);
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

  /**
   * `POST /api/v1/admin/spaces/{space_id}/events/{event_id}/redact`（没有请求体，接口服务不读）
   * → `{ id, redacted, records }`（records = 一起抹除的记录数，含指向它的更正）。
   */
  redactEvent(eventId: string): Promise<{ id?: string; redacted?: boolean; records?: number }> {
    return this.client.json('POST', `${this.admin}/events/${seg(eventId)}/redact`);
  }
}

/** 管理命令定义区域和地块时用的文件格式。 */
export interface LayoutFile {
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly message?: string;
}

export type { GridBox };
