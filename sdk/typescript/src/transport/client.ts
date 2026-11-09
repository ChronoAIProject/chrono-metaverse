import {
  DEFAULT_NYX_BASE,
  DEFAULT_SLUG,
  normalizeNyxBase,
  type TransportMode,
} from '../workspace/config.js';

/**
 * 调用接口服务的两种方式：
 *
 * - `nyxid`（默认，线上）：`https://nyx-api.chrono-ai.fun/api/v1/proxy/s/<slug>/<路径>`，
 *   带 `Authorization: Bearer <令牌>`。NyxID 代理会丢掉自定义请求头，所以这里只发标准头
 *   （Authorization、Content-Type、Accept、If-Match、Idempotency-Key、Range）；基准版本放在
 *   If-Match 或请求体里。NyxID 地址必须是 https（本机回环地址可以用 http），否则构造时就报错，
 *   令牌不会以明文发出。
 * - `direct`（本地开发和测试）：直连 `--api` 地址。每个请求先向模拟 NyxID 的取令牌地址
 *   （`POST <devTokenUrl>`，请求体 `{ sub, orgRole? }`）要一对新令牌（服务端按 jti 防重放，
 *   不能复用），再带上 `X-NyxID-Identity-Token` 和 `Authorization: Bearer <accessToken>`。
 */

export interface TransportConfig {
  readonly mode: TransportMode;
  /** nyxid 模式：NyxID 地址（https；本机回环地址可以用 http）。 */
  readonly nyxBase?: string;
  /** nyxid 模式：服务 slug。 */
  readonly slug?: string;
  /** nyxid 模式：取令牌（每次请求调用一次，可以是缓存的值）。 */
  readonly token?: () => string;
  /** direct 模式：接口服务地址。 */
  readonly api?: string;
  /** direct 模式：取令牌地址。 */
  readonly devTokenUrl?: string;
  readonly devSub?: string;
  readonly devOrgRole?: string;
  readonly fetch?: typeof fetch;
  /** 失败重试次数（只对 GET、PUT 和网络错误、5xx、429 重试），默认 3。 */
  readonly retries?: number;
  /** 重试间隔基数（毫秒），默认 500。 */
  readonly retryDelayMs?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** NyxID 代理会转发的请求头（小写）。其余的一律不发，避免误以为能传过去。 */
export const PROXY_SAFE_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'if-match',
  'if-none-match',
  'idempotency-key',
  'range',
]);

export interface RequestOptions {
  readonly json?: unknown;
  readonly body?: Uint8Array | string;
  readonly contentType?: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly ifMatch?: string;
  readonly idempotencyKey?: string;
  /** 这些状态码不当作错误（例如 404 时自己处理）。 */
  readonly allow?: readonly number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient {
  private readonly fetcher: typeof fetch;
  /** nyxid 模式：检查过的 NyxID 地址（只有协议、主机和端口）；direct 模式不用。 */
  private readonly nyxBase: string = '';

  constructor(readonly config: TransportConfig) {
    this.fetcher = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    if (config.mode === 'nyxid') {
      try {
        this.nyxBase = normalizeNyxBase(config.nyxBase ?? DEFAULT_NYX_BASE, 'NyxID 地址', true);
      } catch (error) {
        throw new ApiError(0, (error as Error).message);
      }
    }
    if (config.mode === 'direct' && !config.api) {
      throw new ApiError(0, 'direct 模式需要接口服务地址（--api 或 metaverse.json 的 api）');
    }
    if (config.mode === 'direct' && !config.devTokenUrl) {
      throw new ApiError(
        0,
        'direct 模式需要取令牌地址（--dev-token-url、环境变量 METAVERSE_DEV_TOKEN_URL 或 metaverse.json 的 devTokenUrl）',
      );
    }
  }

  /** 接口路径（以 `/api/` 开头）→ 完整地址。 */
  url(path: string, query?: RequestOptions['query']): string {
    if (!path.startsWith('/api/')) throw new ApiError(0, `接口路径必须以 /api/ 开头：${path}`);
    let base: string;
    if (this.config.mode === 'nyxid') {
      const slug = encodeURIComponent(this.config.slug ?? DEFAULT_SLUG);
      base = `${this.nyxBase}/api/v1/proxy/s/${slug}`;
    } else {
      base = this.config.api!.replace(/\/+$/, '');
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const text = search.toString();
    return `${base}${path}${text === '' ? '' : `?${text}`}`;
  }

  /** 认证请求头。direct 模式每次都取一对新令牌。 */
  async authHeaders(): Promise<Record<string, string>> {
    if (this.config.mode === 'nyxid') {
      if (this.config.token === undefined) throw new ApiError(0, 'nyxid 模式没有令牌');
      return { Authorization: `Bearer ${this.config.token()}` };
    }
    const response = await this.fetcher(this.config.devTokenUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sub: this.config.devSub ?? 'dev-user',
        ...(this.config.devOrgRole ? { orgRole: this.config.devOrgRole } : {}),
      }),
    });
    if (!response.ok) {
      throw new ApiError(
        response.status,
        `取开发令牌失败（HTTP ${response.status}）：${this.config.devTokenUrl}`,
      );
    }
    const body = (await response.json()) as { identityToken?: unknown; accessToken?: unknown };
    if (typeof body.identityToken !== 'string' || typeof body.accessToken !== 'string') {
      throw new ApiError(0, '取开发令牌的响应里没有 identityToken 和 accessToken');
    }
    return {
      'X-NyxID-Identity-Token': body.identityToken,
      Authorization: `Bearer ${body.accessToken}`,
    };
  }

  /** 发一个请求；不在 `allow` 里的非 2xx 状态抛出 ApiError（按问题文档解析 code 和 detail）。 */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const retries = this.config.retries ?? 3;
    const idempotent = method === 'GET' || method === 'PUT' || method === 'HEAD';
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let response: Response;
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          ...(await this.authHeaders()),
        };
        let body: RequestInit['body'];
        if (options.json !== undefined) {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(options.json);
        } else if (options.body !== undefined) {
          headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
          body =
            typeof options.body === 'string'
              ? options.body
              : (options.body as unknown as RequestInit['body']);
        }
        if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
        if (options.idempotencyKey !== undefined)
          headers['Idempotency-Key'] = options.idempotencyKey;
        if (this.config.mode === 'nyxid') {
          for (const key of Object.keys(headers)) {
            if (!PROXY_SAFE_HEADERS.has(key.toLowerCase())) delete headers[key];
          }
        }
        response = await this.fetcher(this.url(path, options.query), { method, headers, body });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (idempotent && attempt <= retries) {
          await sleep((this.config.retryDelayMs ?? 500) * attempt);
          continue;
        }
        throw new ApiError(0, `网络错误：${method} ${path}：${(error as Error).message}`);
      }
      if (response.ok || options.allow?.includes(response.status)) return response;
      const retryable = response.status >= 500 || response.status === 429;
      if (retryable && idempotent && attempt <= retries) {
        await response.body?.cancel();
        await sleep((this.config.retryDelayMs ?? 500) * attempt);
        continue;
      }
      throw await problem(method, path, response);
    }
  }

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(method, path, options);
    const text = await response.text();
    return (text === '' ? {} : JSON.parse(text)) as T;
  }

  async bytes(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.request('GET', path, options);
    return new Uint8Array(await response.arrayBuffer());
  }
}

async function problem(method: string, path: string, response: Response): Promise<ApiError> {
  let body: unknown;
  let code: string | undefined;
  let detail: string | undefined;
  try {
    body = await response.json();
    const record = body as Record<string, unknown>;
    if (typeof record.code === 'string') code = record.code;
    if (typeof record.detail === 'string' && record.detail !== '') detail = record.detail;
    else if (typeof record.title === 'string' && record.title !== '') detail = record.title;
  } catch {
    // 没有问题文档时只用状态码。
  }
  const hint =
    response.status === 401
      ? '（令牌无效或过期：重新运行 nyxid login，或检查 --token / NYXID_TOKEN）'
      : response.status === 403
        ? '（没有权限：检查 agent key 的操作范围和空间主人）'
        : response.status === 404
          ? '（找不到，或者没有查看权限）'
          : '';
  return new ApiError(
    response.status,
    `${method} ${path} 失败（HTTP ${response.status}${code ? ` ${code}` : ''}）：${detail ?? '没有说明'}${hint}`,
    code,
    body,
  );
}
