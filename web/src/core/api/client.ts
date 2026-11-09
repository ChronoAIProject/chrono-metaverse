import { decompressChunk } from '../chunk';
import type {
  CommitSummary,
  EventDensity,
  Head,
  Page,
  Snapshot,
  SpaceEvent,
  SpaceInfo,
  StateAt,
  Timestamp,
  UniverseRevision,
  UniverseView,
} from './types';

/**
 * 公开读接口（设计 8.2）的客户端。
 *
 * - 凭链接查看的空间：分享令牌从页面地址的 `#share=` 取出，放在请求头
 *   `Authorization: Share <令牌>` 里，不进地址栏以外的任何地方；
 * - 错误按 CMA 的问题文档格式（RFC 9457：`code`、`detail`、`title`）解析；
 * - 区块按内容哈希下载，解压后核对哈希。
 */

export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PublicApiError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface PublicClientOptions {
  /** 接口地址前缀，默认同源。 */
  readonly baseUrl?: string;
  /** 分享令牌；公开空间不需要。 */
  readonly share?: string | null;
  readonly fetch?: typeof fetch;
}

export interface HeadResult {
  /** 304：和上次一样。 */
  readonly notModified: boolean;
  readonly head?: Head;
  readonly etag: string | null;
}

export interface TimelineQuery {
  readonly from?: Timestamp;
  readonly to?: Timestamp;
  readonly after?: string;
}

export interface EventsQuery {
  readonly from?: Timestamp;
  readonly to?: Timestamp;
  /** 按记录时间 recordedAt 的增量游标（"现在"模式）。 */
  readonly since?: Timestamp;
  readonly types?: readonly string[];
  readonly after?: string;
}

export interface DensityQuery {
  readonly from: Timestamp;
  readonly to: Timestamp;
  /** 桶宽（秒）。 */
  readonly bucket: number;
}

export type SnapshotQuery = { readonly seq: number } | { readonly at: Timestamp };

export interface PublicClient {
  readonly space: (spaceId: string) => Promise<SpaceInfo>;
  readonly head: (spaceId: string, etag?: string | null) => Promise<HeadResult>;
  readonly snapshot: (spaceId: string, query: SnapshotQuery) => Promise<Snapshot>;
  readonly timeline: (spaceId: string, query?: TimelineQuery) => Promise<Page<CommitSummary>>;
  readonly events: (spaceId: string, query?: EventsQuery) => Promise<Page<SpaceEvent>>;
  readonly eventDensity: (spaceId: string, query: DensityQuery) => Promise<EventDensity>;
  readonly state: (spaceId: string, at: Timestamp) => Promise<StateAt>;
  /** 区块：下载、解压、核对哈希。 */
  readonly chunk: (hash: string) => Promise<Uint16Array>;
  /** 资源（网页用模型、贴图）的原始字节。 */
  readonly asset: (hash: string) => Promise<ArrayBuffer>;
  readonly universe: (universeId: string, at?: Timestamp) => Promise<UniverseView>;
  readonly universeRevision: (universeId: string, seq: number) => Promise<UniverseRevision>;
  /**
   * 草稿预览（设计 5.6、8.2）：预览令牌放在请求头 `Authorization: Preview <令牌>` 里，
   * 不用分享令牌。预览响应不缓存；草稿区块和草稿新上传的资源走预览专用的地址。
   */
  readonly preview: (token: string) => Promise<Snapshot>;
  readonly previewChunk: (token: string, hash: string) => Promise<Uint16Array>;
  readonly previewAsset: (token: string, hash: string) => Promise<ArrayBuffer>;
}

const HASH = /^[0-9a-f]{64}$/;

function segment(value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new PublicApiError(400, `无效的编号：${JSON.stringify(value)}`, 'invalid_id');
  }
  return encodeURIComponent(value);
}

function checkedHash(hash: string): string {
  const lower = hash.toLowerCase();
  if (!HASH.test(lower)) throw new PublicApiError(400, `无效的内容哈希：${hash}`, 'invalid_hash');
  return lower;
}

function query(params: Record<string, string | number | readonly string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

async function problem(response: Response): Promise<PublicApiError> {
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.detail === 'string' && body.detail !== '') detail = body.detail;
    else if (typeof body.title === 'string' && body.title !== '') detail = body.title;
  } catch {
    // 没有问题文档时只用状态码。
  }
  const fallback =
    response.status === 404
      ? '找不到这个空间，或者分享链接已失效'
      : `请求失败（HTTP ${response.status}）`;
  return new PublicApiError(response.status, detail ?? fallback, code);
}

/** 从页面地址的片段（`#share=...`）取分享令牌。 */
export function shareTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('share');
  return token !== null && token.trim() !== '' ? token.trim() : null;
}

export function createPublicClient(options: PublicClientOptions = {}): PublicClient {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(options.share ? { Authorization: `Share ${options.share}` } : {}),
    ...extra,
  });

  async function request(
    path: string,
    extra?: Record<string, string>,
    preview?: string,
  ): Promise<Response> {
    const response = await fetcher(`${base}/api/public${path}`, {
      method: 'GET',
      headers: preview === undefined ? headers(extra) : { Authorization: `Preview ${preview}` },
      ...(preview === undefined ? {} : { cache: 'no-store' as const }),
      // 链接里的令牌不随 Referer 带出去（设计 7.2）。
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
    if (!response.ok && response.status !== 304) throw await problem(response);
    return response;
  }

  async function json<T>(path: string): Promise<T> {
    return (await (await request(path)).json()) as T;
  }

  const space = (id: string) => `/spaces/${segment(id)}`;

  return {
    space: (spaceId) => json<SpaceInfo>(space(spaceId)),
    async head(spaceId, etag) {
      const response = await request(
        `${space(spaceId)}/head`,
        etag ? { 'If-None-Match': etag } : undefined,
      );
      const nextEtag = response.headers.get('ETag') ?? etag ?? null;
      if (response.status === 304) return { notModified: true, etag: nextEtag };
      return { notModified: false, head: (await response.json()) as Head, etag: nextEtag };
    },
    snapshot: (spaceId, q) =>
      json<Snapshot>(
        `${space(spaceId)}/snapshot${query('seq' in q ? { seq: q.seq } : { at: q.at })}`,
      ),
    timeline: (spaceId, q = {}) =>
      json<Page<CommitSummary>>(`${space(spaceId)}/timeline${query({ ...q })}`),
    events: (spaceId, q = {}) =>
      json<Page<SpaceEvent>>(`${space(spaceId)}/events${query({ ...q })}`),
    eventDensity: (spaceId, q) =>
      json<EventDensity>(`${space(spaceId)}/events/density${query({ ...q })}`),
    state: (spaceId, at) => json<StateAt>(`${space(spaceId)}/state${query({ at })}`),
    async chunk(hash) {
      const checked = checkedHash(hash);
      const response = await request(`/chunks/${checked}.bin`);
      return decompressChunk(new Uint8Array(await response.arrayBuffer()), checked);
    },
    async asset(hash) {
      const response = await request(`/assets/${checkedHash(hash)}.bin`);
      return response.arrayBuffer();
    },
    universe: (universeId, at) =>
      json<UniverseView>(`/universes/${segment(universeId)}${query({ at })}`),
    universeRevision: (universeId, seq) =>
      json<UniverseRevision>(`/universes/${segment(universeId)}/revisions/${seq}`),
    async preview(token) {
      return (await (await request('/previews', undefined, token)).json()) as Snapshot;
    },
    async previewChunk(token, hash) {
      const checked = checkedHash(hash);
      const response = await request(`/previews/chunks/${checked}`, undefined, token);
      return decompressChunk(new Uint8Array(await response.arrayBuffer()), checked);
    },
    async previewAsset(token, hash) {
      const response = await request(`/previews/assets/${checkedHash(hash)}`, undefined, token);
      return response.arrayBuffer();
    },
  };
}
