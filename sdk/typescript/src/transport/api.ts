import type { GridBox } from '../core/grid.js';
import type { UploadLimits } from '../core/limits.js';
import type { Op, PaletteBlock } from '../core/ops.js';
import type { AnchorBody, EntityBody } from '../core/record.js';
import type { Plot, Region } from '../core/scope.js';
import type { ApiClient } from './client.js';

/**
 * 命令行用到的接口（设计 8.3、8.4；重建路径见 docs/design/server-slim.md 2.3）。路径和字段集中写在
 * 这里，已与接口服务的实现（`api/crates/metaverse-api/src/routes/`）逐项核对。接口服务的请求体都带
 * `deny_unknown_fields`：只发它定义的字段（小驼峰），多一个字段就 422。响应解析尽量宽松
 * （编号字段同时认 `id` / `xxxId`）。
 *
 * 作用范围放在路径里：实体区 `/api/v1/spaces/{space_id}/…`，地块
 * `/api/v1/spaces/{space_id}/plots/{plot_id}/…`，重建 `/api/v1/spaces/{space_id}/rebuild/…`。
 */

/**
 * 上传用途。实体区、地块路径收 `model`、`texture`、`ops`、`script`；重建路径收 `scan`、`webmodel`、
 * `model`、`texture`、`script`、`bundle`（docs/design/server-slim.md 2.9）。
 */
export type UploadPurpose = 'scan' | 'webmodel' | 'model' | 'texture' | 'ops' | 'script' | 'bundle';

/** 重建路径（`/rebuild/…`）。 */
export interface RebuildScope {
  readonly rebuild: true;
}

export const REBUILD: RebuildScope = { rebuild: true };

/**
 * 路径范围：不给或 `null` 是实体区，字符串是地块编号，{@link REBUILD} 是重建路径。草稿、上传会话、
 * 任务都属于创建时的范围，之后的请求要走同一范围的路径。
 */
export type ScopeRef = string | null | undefined | RebuildScope;

export function isRebuild(scope: ScopeRef): scope is RebuildScope {
  return typeof scope === 'object' && scope !== null && scope.rebuild === true;
}

/** 给人看的范围名称。 */
export function scopeName(scope: ScopeRef): string {
  if (isRebuild(scope)) return '重建';
  return typeof scope === 'string' && scope !== '' ? `地块 ${scope}` : '实体区';
}

export interface SpaceView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility?: string;
  readonly head: { readonly seq: number; readonly at: string; readonly commitId?: string };
  readonly regions: readonly Region[];
  readonly plots: readonly Plot[];
  readonly anchors: readonly AnchorBody[];
  /**
   * 各用途当前生效的上传上限（docs/SHAPES.md 第 8 节）；`pull` 写进工作区的 `limits.json`。
   * 旧版接口服务没有这一项。
   */
  readonly uploadLimits?: UploadLimits;
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
    /** 对齐的说明（重建包写的，服务端不解释）。 */
    readonly alignment?: Readonly<Record<string, unknown>>;
  } | null;
}

/**
 * 上传文件的格式（名称与 metaverse-core 的 `UploadFormat` 相同）。各用途接受的格式
 * （docs/SHAPES.md 第 8 节）：scan 用途 glb / drc / obj / zip（zip = 网格 + 贴图，例如 Scaniverse 导出）；
 * webmodel、model 用途 glb；texture 用途 png / jpeg / webp；ops 用途 ndjson / gzip；script 用途 text；
 * bundle 用途（重建包清单）json。
 */
export type UploadFormat =
  'glb' | 'drc' | 'obj' | 'zip' | 'png' | 'jpeg' | 'webp' | 'ndjson' | 'gzip' | 'text' | 'json';

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

/**
 * 创建上传（和查询上传）的响应。本空间已拥有这份内容、核对结果合乎用途时直接给 `assetHash`
 * （`status: "done"`、`reused: true`），不用再传数据。
 */
export interface UploadSession {
  readonly uploadId?: string;
  readonly id?: string;
  readonly status?: string;
  readonly partSize?: number;
  readonly partCount?: number;
  readonly assetHash?: string;
  readonly reused?: boolean;
  readonly jobId?: string;
  /** 服务端的核对记录（docs/SHAPES.md 第 8 节）。 */
  readonly check?: unknown;
}

/** 任务失败的原因：旧版接口服务是字符串，后台执行器写 `{class, message, at}`。 */
export type JobError =
  string | { readonly class?: string; readonly message?: string; readonly at?: string };

/** 任务失败原因的一行文字。 */
export function jobErrorText(error: JobError | null | undefined): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === 'string') return error === '' ? null : error;
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
  return typeof error.class === 'string' ? `${message}（${error.class}）` : message;
}

export interface JobView {
  readonly id?: string;
  readonly jobId?: string;
  readonly kind: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly lastError?: JobError | null;
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

/**
 * 发布结果。重建草稿的内容与最新版本相比没有变化时不写提交，返回 `{unchanged: true, seq: <最新 seq>}`
 * （docs/design/server-slim.md 2.7）。
 */
export interface PublishView {
  readonly seq?: number;
  readonly at?: string;
  readonly commitId?: string;
  readonly id?: string;
  readonly unchanged?: boolean;
}

/** ops-from-upload 和交包（`bundle`）的请求体：上传编号和资源哈希只能给一个。 */
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
export function scopePath(spaceId: string, scope?: ScopeRef): string {
  const base = `/api/v1/spaces/${encodeURIComponent(spaceId)}`;
  if (isRebuild(scope)) return `${base}/rebuild`;
  return scope ? `${base}/plots/${encodeURIComponent(scope)}` : base;
}

/** 分段下载的一段（`Range` 请求的响应）。 */
export interface AssetRange {
  readonly bytes: Uint8Array;
  /** 这一段的起点。 */
  readonly start: number;
  /** 资源的总字节数。 */
  readonly total: number;
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
   * `GET /api/v1/spaces/{space_id}/assets/{hash}`，带 `Range: bytes=start-(end-1)`：资源的一段
   * （原始扫描最大 1 GiB，经 NyxID 代理的单个请求约 100 秒就断，所以分段下载）。服务端回 206 和
   * `Content-Range`；回 200（整份）时返回的是整份内容、`start` 为 0。
   */
  async getAssetRange(hash: string, start: number, end: number): Promise<AssetRange> {
    const response = await this.client.request('GET', `${this.space}/assets/${seg(hash)}`, {
      range: [start, end],
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 206) return { bytes, start: 0, total: bytes.length };
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (match === null) throw new Error('分段下载的响应没有合法的 Content-Range');
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (to - from + 1 !== bytes.length) {
      throw new Error(`分段下载的长度 ${bytes.length} 与 Content-Range（${from}-${to}）不符`);
    }
    return { bytes, start: from, total: Number(match[3]) };
  }

  /**
   * `GET {范围}/jobs/{job_id}`。经地块路径只能查到经这个地块路径发起的任务（上传校验、
   * ops_from_upload 等）；经重建路径只看得到重建范围的任务（上传核对、交包展开、种子导入）。
   * 地块合作方的 agent key 一般只开放地块路径（设计 9.3），所以地块范围的任务要经地块路径查。
   */
  getJob(jobId: string, scope?: ScopeRef): Promise<JobView> {
    return this.client.json('GET', `${scopePath(this.spaceId, scope)}/jobs/${seg(jobId)}`);
  }

  // ---- 上传 -----------------------------------------------------------------

  /** `POST {范围}/uploads/{purpose}` */
  createUpload(
    purpose: UploadPurpose,
    request: CreateUploadRequest,
    scope?: ScopeRef,
  ): Promise<UploadSession> {
    return this.client.json('POST', `${scopePath(this.spaceId, scope)}/uploads/${purpose}`, {
      json: request,
    });
  }

  /** `GET {范围}/uploads/{purpose}/{upload_id}`：状态、`assetHash`、`check`。 */
  getUpload(purpose: UploadPurpose, uploadId: string, scope?: ScopeRef): Promise<UploadSession> {
    return this.client.json(
      'GET',
      `${scopePath(this.spaceId, scope)}/uploads/${purpose}/${seg(uploadId)}`,
    );
  }

  /** `PUT {范围}/uploads/{purpose}/{upload_id}/parts/{n}`（n 从 0 开始），请求体是这一片的原始字节。 */
  putPart(
    purpose: UploadPurpose,
    uploadId: string,
    n: number,
    bytes: Uint8Array,
    scope?: ScopeRef,
  ): Promise<unknown> {
    return this.client.json(
      'PUT',
      `${scopePath(this.spaceId, scope)}/uploads/${purpose}/${seg(uploadId)}/parts/${n}`,
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
    scope?: ScopeRef,
  ): Promise<{ jobId?: string; id?: string; assetHash?: string }> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, scope)}/uploads/${purpose}/${seg(uploadId)}/complete`,
      {
        json: {},
      },
    );
  }

  // ---- 草稿 -----------------------------------------------------------------

  /**
   * `POST {范围}/drafts`，请求体只有 `{ baseSeq }`（接口服务拒绝未知字段）。提交说明在发布时
   * 才给（`publish` 的 `message`）。
   */
  createDraft(request: { baseSeq: number }, scope?: ScopeRef): Promise<DraftView> {
    return this.client.json('POST', `${scopePath(this.spaceId, scope)}/drafts`, { json: request });
  }

  /** `POST {范围}/drafts/{draft_id}/ops`，请求体 `{ ops }`（≤ 200 条、≤ 1MB）。重建路径没有这个接口。 */
  addOps(
    draftId: string,
    ops: readonly Op[],
    scope?: ScopeRef,
  ): Promise<DraftView & Record<string, unknown>> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, scope)}/drafts/${seg(draftId)}/ops`,
      {
        json: { ops },
      },
    );
  }

  /**
   * `POST {范围}/drafts/{draft_id}/ops-from-upload` → 202 `{ jobId, draftId, status }`（ops_from_upload 任务）。
   * 请求体是 `{ uploadId }` 或 `{ assetHash }` 二者之一（两个都给接口服务返回 422）；优先用上传编号，
   * 服务端能核对它是本空间 ops 用途、已完成校验的上传。重建路径没有这个接口。
   */
  opsFromUpload(
    draftId: string,
    request: OpsFromUploadRequest,
    scope?: ScopeRef,
  ): Promise<{ jobId?: string; id?: string } & Record<string, unknown>> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, scope)}/drafts/${seg(draftId)}/ops-from-upload`,
      {
        json: request,
      },
    );
  }

  /**
   * `POST /api/v1/spaces/{space_id}/rebuild/drafts/{draft_id}/bundle`，请求体 `{ uploadId }` 或
   * `{ assetHash }`（用途 `bundle`、核对通过的清单）→ 202 `{ jobId, status: "queued" }`（展开任务）。
   * 一个重建草稿只收一个包，第二个 409 `bundle_already_applied`（docs/design/server-slim.md 2.3、2.6）。
   */
  applyBundle(
    draftId: string,
    request: OpsFromUploadRequest,
  ): Promise<{ jobId?: string; id?: string; status?: string } & Record<string, unknown>> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, REBUILD)}/drafts/${seg(draftId)}/bundle`,
      { json: request },
    );
  }

  /**
   * `POST {范围}/drafts/{draft_id}/preview`，请求体 `{ ttlSeconds? }`（60–604800 秒，默认 86400；
   * 接口服务拒绝未知字段）→ 201 `{ token, url, rev, expiresAt }`。
   */
  preview(
    draftId: string,
    request: { ttlSeconds?: number } = {},
    scope?: ScopeRef,
  ): Promise<PreviewView> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, scope)}/drafts/${seg(draftId)}/preview`,
      {
        json: request,
      },
    );
  }

  /**
   * `POST {范围}/drafts/{draft_id}/publish`，请求体 `{ message?, replay? }`（提交说明 ≤ 2000 字；
   * 不给时实体区草稿写"发布草稿"，重建草稿用清单的 `note`）。
   */
  publish(
    draftId: string,
    request: { message?: string; replay?: boolean } = {},
    scope?: ScopeRef,
  ): Promise<PublishView> {
    return this.client.json(
      'POST',
      `${scopePath(this.spaceId, scope)}/drafts/${seg(draftId)}/publish`,
      {
        json: request,
      },
    );
  }

  /** `DELETE {范围}/drafts/{draft_id}`：丢弃草稿。 */
  async discardDraft(draftId: string, scope?: ScopeRef): Promise<void> {
    const response = await this.client.request(
      'DELETE',
      `${scopePath(this.spaceId, scope)}/drafts/${seg(draftId)}`,
    );
    await response.body?.cancel();
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
