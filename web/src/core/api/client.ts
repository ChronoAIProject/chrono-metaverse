import { decompressChunk } from '../chunk';
import type {
  CommitSummary,
  EventDensity,
  Head,
  Page,
  PreviewView,
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
 * - 组合页用组合的分享令牌读成员空间：每个请求另带 `?universe=<组合编号>`，
 *   服务端据此核对该空间是这个组合的成员（设计 8.2）；
 * - 分页接口（提交列表、事件）用 `allTimeline`、`allEvents` 按 `nextAfter` 取完：只以
 *   `nextAfter` 判断有没有下一页，空页也照样往下翻（服务端按原始记录分页后再做公开投影，
 *   一整页都是内部级事件时 `items` 为空但还有下一页）；
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
  /** 组合页：用组合的分享令牌读成员空间时，每个请求都带 `?universe=<组合编号>`。 */
  readonly universe?: string | null;
  readonly fetch?: typeof fetch;
}

/** 下载进度：已收到的字节数和总字节数（服务端没给 Content-Length 时总数为 null）。 */
export type ProgressCallback = (loaded: number, total: number | null) => void;

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
  /** 资源（网页用模型、贴图）的原始字节和 Content-Type。 */
  readonly asset: (hash: string, onProgress?: ProgressCallback) => Promise<ArrayBuffer>;
  readonly assetBlob: (hash: string, onProgress?: ProgressCallback) => Promise<Blob>;
  readonly universe: (universeId: string, at?: Timestamp) => Promise<UniverseView>;
  readonly universeRevision: (universeId: string, seq: number) => Promise<UniverseRevision>;
  /**
   * 草稿预览（设计 5.6、8.2）：预览令牌放在请求头 `Authorization: Preview <令牌>` 里，
   * 不用分享令牌。预览响应不缓存；草稿区块和草稿新上传的资源走预览专用的地址。
   */
  readonly preview: (token: string) => Promise<PreviewView>;
  readonly previewChunk: (token: string, hash: string) => Promise<Uint16Array>;
  readonly previewAsset: (
    token: string,
    hash: string,
    onProgress?: ProgressCallback,
  ) => Promise<ArrayBuffer>;
  readonly previewAssetBlob: (
    token: string,
    hash: string,
    onProgress?: ProgressCallback,
  ) => Promise<Blob>;
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

function fragmentParam(hash: string, name: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get(name);
  return token !== null && token.trim() !== '' ? token.trim() : null;
}

/** 从页面地址的片段（`#share=...`）取分享令牌。 */
export function shareTokenFromHash(hash: string): string | null {
  return fragmentParam(hash, 'share');
}

/** 从页面地址的片段（`#t=...`）取预览令牌。 */
export function previewTokenFromHash(hash: string): string | null {
  return fragmentParam(hash, 't');
}

/**
 * 读完响应体并报告进度。服务端给了 Content-Length 时总数已知；
 * 浏览器不支持流式读取时退回一次性读取。
 */
async function readBody(response: Response, onProgress?: ProgressCallback): Promise<Blob> {
  const type = response.headers.get('content-type') ?? '';
  const lengthHeader = Number(response.headers.get('content-length'));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
  if (onProgress === undefined || response.body === null || response.body === undefined) {
    const blob = await response.blob();
    onProgress?.(blob.size, blob.size);
    return blob.type === '' && type !== '' ? new Blob([blob], { type }) : blob;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  onProgress(loaded, loaded);
  return new Blob(parts as BlobPart[], { type });
}

/** 分页结果每页的上限保护：服务端如果一直给 nextAfter，最多取这么多页。 */
export const MAX_PAGES = 200;

/**
 * 按 `nextAfter` 取完全部页。只在 `nextAfter` 为 null（或没给）时停：某一页的 `items`
 * 可以是空的——服务端先按原始记录分页、再做公开投影，一整页都是内部级事件时就是空页，
 * 后面的页里照样可能有公开事件。`nextAfter` 和本页请求的游标相同（没有前进）时也停下，
 * 防止死循环；最多取 `MAX_PAGES` 页。
 */
async function allPages<T>(
  fetchPage: (after: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(after);
    items.push(...result.items);
    const next = result.nextAfter;
    if (next === null || next === undefined || next === after) break;
    after = next;
  }
  return items;
}

/** 取完提交列表的全部页（每页 ≤ 500）。 */
export async function allTimeline(
  client: Pick<PublicClient, 'timeline'>,
  spaceId: string,
  q: Omit<TimelineQuery, 'after'> = {},
): Promise<CommitSummary[]> {
  const items = await allPages((after) => client.timeline(spaceId, { ...q, after }));
  const bySeq = new Map(items.map((commit) => [commit.seq, commit]));
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 取完一次事件查询的全部页（每页 ≤ 5000；from/to 的跨度由调用方控制在 24 小时内）。 */
export async function allEvents(
  client: Pick<PublicClient, 'events'>,
  spaceId: string,
  q: Omit<EventsQuery, 'after'> = {},
): Promise<SpaceEvent[]> {
  return allPages((after) => client.events(spaceId, { ...q, after }));
}

export function createPublicClient(options: PublicClientOptions = {}): PublicClient {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const universe = options.universe ?? undefined;
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
  /** 组合页的成员请求都带 `universe=`。 */
  const q = (params: Record<string, string | number | readonly string[] | undefined> = {}) =>
    query({ ...params, universe });

  return {
    space: (spaceId) => json<SpaceInfo>(`${space(spaceId)}${q()}`),
    async head(spaceId, etag) {
      const response = await request(
        `${space(spaceId)}/head${q()}`,
        etag ? { 'If-None-Match': etag } : undefined,
      );
      const nextEtag = response.headers.get('ETag') ?? etag ?? null;
      if (response.status === 304) return { notModified: true, etag: nextEtag };
      return { notModified: false, head: (await response.json()) as Head, etag: nextEtag };
    },
    snapshot: (spaceId, s) =>
      json<Snapshot>(`${space(spaceId)}/snapshot${q('seq' in s ? { seq: s.seq } : { at: s.at })}`),
    timeline: (spaceId, t = {}) =>
      json<Page<CommitSummary>>(`${space(spaceId)}/timeline${q({ ...t })}`),
    events: (spaceId, e = {}) => json<Page<SpaceEvent>>(`${space(spaceId)}/events${q({ ...e })}`),
    eventDensity: (spaceId, d) =>
      json<EventDensity>(`${space(spaceId)}/events/density${q({ ...d })}`),
    state: (spaceId, at) => json<StateAt>(`${space(spaceId)}/state${q({ at })}`),
    async chunk(hash) {
      const checked = checkedHash(hash);
      const response = await request(`/chunks/${checked}.bin${q()}`);
      return decompressChunk(new Uint8Array(await response.arrayBuffer()), checked);
    },
    async asset(hash, onProgress) {
      const response = await request(`/assets/${checkedHash(hash)}.bin${q()}`);
      return (await readBody(response, onProgress)).arrayBuffer();
    },
    async assetBlob(hash, onProgress) {
      const response = await request(`/assets/${checkedHash(hash)}.bin${q()}`);
      return readBody(response, onProgress);
    },
    universe: (universeId, at) =>
      json<UniverseView>(`/universes/${segment(universeId)}${query({ at })}`),
    universeRevision: (universeId, seq) =>
      json<UniverseRevision>(`/universes/${segment(universeId)}/revisions/${seq}`),
    async preview(token) {
      return (await (await request('/previews', undefined, token)).json()) as PreviewView;
    },
    async previewChunk(token, hash) {
      const checked = checkedHash(hash);
      const response = await request(`/previews/chunks/${checked}`, undefined, token);
      return decompressChunk(new Uint8Array(await response.arrayBuffer()), checked);
    },
    async previewAsset(token, hash, onProgress) {
      const response = await request(`/previews/assets/${checkedHash(hash)}`, undefined, token);
      return (await readBody(response, onProgress)).arrayBuffer();
    },
    async previewAssetBlob(token, hash, onProgress) {
      const response = await request(`/previews/assets/${checkedHash(hash)}`, undefined, token);
      return readBody(response, onProgress);
    },
  };
}
