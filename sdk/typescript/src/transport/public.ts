import { isSpaceId } from '../core/ids.js';
import type { Plot, Region } from '../core/scope.js';
import type { AnchorBody } from '../core/record.js';
import type { SnapshotView } from './api.js';
import { ApiError } from './client.js';

/**
 * 公开读接口（`/api/public`，设计 8.2）的客户端，给 `metaverse pull --share` 用：只读公开快照，不需要
 * NyxID。分享链接形如 `https://<网站>/s/<空间编号>#share=<分享令牌>`；公开空间可以不带令牌。
 *
 * 分享令牌只在内存里用：只发给链接自己的地址（`Authorization: Share <令牌>`），不写进工作区、不打印，
 * 错误说明里也不带。也可以用环境变量 `METAVERSE_SHARE_TOKEN` 给。
 */

export interface ShareLink {
  /** 网站地址（协议、主机、端口）；公开读接口在同一地址的 `/api/public` 下。 */
  readonly origin: string;
  readonly spaceId: string;
  /** 分享令牌；公开空间可以没有。 */
  readonly token: string | null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class ShareLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareLinkError';
  }
}

/**
 * 解析分享链接。地址必须是 https（本机回环地址可以用 http），路径是 `/s/<空间编号>`；令牌取链接里的
 * `#share=`，没有时取 `envToken`（环境变量 `METAVERSE_SHARE_TOKEN`）。说明里不带令牌。
 */
export function parseShareLink(link: string, envToken?: string): ShareLink {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ShareLinkError(
      '分享链接不是合法的地址（形如 https://<网站>/s/<空间编号>#share=<分享令牌>）',
    );
  }
  if (url.username !== '' || url.password !== '')
    throw new ShareLinkError('分享链接不能带账号密码');
  if (!(
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  )) {
    throw new ShareLinkError(
      `分享链接必须是 https（令牌会发到这个地址；只有本机回环地址可以用 http）：${url.protocol}//${url.host}`,
    );
  }
  const match = /^\/s\/([^/]+)$/.exec(url.pathname);
  const spaceId = match === null ? null : decodeURIComponent(match[1]!);
  if (spaceId === null || !isSpaceId(spaceId)) {
    throw new ShareLinkError(`分享链接的路径要是 /s/<空间编号>：${url.origin}${url.pathname}`);
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const fromLink = fragment.get('share');
  const token =
    fromLink !== null && fromLink !== '' ? fromLink : envToken !== '' ? (envToken ?? null) : null;
  return { origin: url.origin, spaceId, token };
}

/** `GET /api/public/spaces/{id}` 的响应（命令行用到的部分）。 */
export interface PublicSpaceView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility?: string;
  readonly regions: readonly Region[];
  readonly plots?: readonly Plot[];
  readonly anchors: readonly AnchorBody[];
  readonly head?: { readonly seq: number; readonly at: string };
}

export interface PublicApiOptions {
  readonly fetch?: typeof fetch;
  /** 失败重试次数（网络错误、5xx、429），默认 3。 */
  readonly retries?: number;
  readonly retryDelayMs?: number;
}

export class PublicApi {
  private readonly fetcher: typeof fetch;

  constructor(
    readonly link: ShareLink,
    readonly options: PublicApiOptions = {},
  ) {
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async request(path: string): Promise<Response> {
    const retries = this.options.retries ?? 3;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.link.token !== null) headers.Authorization = `Share ${this.link.token}`;
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.link.origin}/api/public${path}`, {
          method: 'GET',
          headers,
          redirect: 'error',
        });
      } catch (error) {
        if (attempt <= retries) {
          await new Promise((r) => setTimeout(r, (this.options.retryDelayMs ?? 500) * attempt));
          continue;
        }
        throw new ApiError(0, `网络错误：GET /api/public${path}：${(error as Error).message}`);
      }
      if (response.ok) return response;
      if ((response.status >= 500 || response.status === 429) && attempt <= retries) {
        await response.body?.cancel();
        await new Promise((r) => setTimeout(r, (this.options.retryDelayMs ?? 500) * attempt));
        continue;
      }
      await response.body?.cancel();
      const hint =
        response.status === 404
          ? '（空间或版本不存在、分享令牌无效或已轮换，或这个空间不公开而链接里没有令牌）'
          : '';
      throw new ApiError(
        response.status,
        `GET /api/public${path} 失败（HTTP ${response.status}）${hint}`,
      );
    }
  }

  private get space(): string {
    return `/spaces/${encodeURIComponent(this.link.spaceId)}`;
  }

  /** `GET /api/public/spaces/{id}`：空间信息、公开锚点、最新版本。 */
  async getSpace(): Promise<PublicSpaceView> {
    return (await (await this.request(this.space)).json()) as PublicSpaceView;
  }

  /** `GET /api/public/spaces/{id}/snapshot?seq=`：公开快照（扫描只有网页用模型和变换，锚点只有公开的）。 */
  async getSnapshot(seq: number): Promise<SnapshotView> {
    return (await (await this.request(`${this.space}/snapshot?seq=${seq}`)).json()) as SnapshotView;
  }

  /** `GET /api/public/chunks/{hash}.bin`：zlib 压缩的区块。 */
  async getChunk(hash: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(`/chunks/${hash}.bin`)).arrayBuffer());
  }

  /** `GET /api/public/assets/{hash}.bin`：登记在 assetRefs 里的资源（网页用模型、物件模型、贴图）。 */
  async getAsset(hash: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request(`/assets/${hash}.bin`)).arrayBuffer());
  }
}
