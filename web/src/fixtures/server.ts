import { densityBuckets, effectiveEvents, stateAt, toMillis } from '../core/events';
import { fixtureStore } from './index';

/**
 * 夹具模式的公开读接口（设计 8.2）：给一个 GET 请求，返回状态码、响应头和响应体。
 * 与 CMA web/build/devFixtures.ts 的做法相同——开发服务器和测试都用它，不需要后端。
 *
 * 和真实接口一样：凭链接查看的空间不带或带错分享令牌返回 404；写请求一律拒绝。
 */

export interface FixtureResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | null;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private',
};

function json(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): FixtureResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(value) };
}

function problem(status: number, code: string, detail: string): FixtureResponse {
  return {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    body: JSON.stringify({ type: 'about:blank', title: code, status, code, detail }),
  };
}

function binary(bytes: Uint8Array, type: string): FixtureResponse {
  return {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
    body: bytes,
  };
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** 处理一个请求；不是 `/api/public/` 下的路径返回 undefined，交给开发服务器。 */
export function fixtureReply(
  method: string,
  path: string,
  search: string,
  headers: Readonly<Record<string, string | undefined>>,
): FixtureResponse | undefined {
  if (!path.startsWith('/api/')) return undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    return problem(501, 'fixture_read_only', `夹具模式只读，不接受 ${method} ${path}`);
  }
  if (!path.startsWith('/api/public/')) {
    return problem(404, 'fixture_missing', `夹具模式没有 ${path}`);
  }
  const store = fixtureStore();
  const params = new URLSearchParams(search);
  const authorized = header(headers, 'authorization') === `Share ${store.shareToken}`;

  const chunk = /^\/api\/public\/chunks\/([0-9a-f]{64})\.bin$/.exec(path);
  const asset = /^\/api\/public\/assets\/([0-9a-f]{64})\.bin$/.exec(path);
  if (chunk || asset) {
    if (!authorized) return problem(404, 'not_found', '找不到这个资源');
    const bytes = chunk ? store.chunk(chunk[1]!) : store.asset(asset![1]!);
    if (bytes === undefined) return problem(404, 'not_found', '找不到这个资源');
    return binary(bytes, chunk ? 'application/octet-stream' : 'model/gltf-binary');
  }

  const match = /^\/api\/public\/spaces\/([^/]+)(\/.*)?$/.exec(path);
  if (match === null) return problem(404, 'not_found', `没有这个接口：${path}`);
  const spaceId = decodeURIComponent(match[1]!);
  const rest = match[2] ?? '';
  // 凭链接查看：没带令牌或令牌无效一律 404，不暴露空间是否存在。
  if (spaceId !== store.spaceId || !authorized) {
    return problem(404, 'not_found', '找不到这个空间，或者分享链接已失效');
  }

  switch (rest) {
    case '':
      return json(200, store.space);
    case '/head': {
      const head = store.space.head!;
      const etag = `"${head.seq}-${head.recordedAt ?? ''}"`;
      if (header(headers, 'if-none-match') === etag) {
        return { status: 304, headers: { etag, 'cache-control': 'private' }, body: null };
      }
      return json(200, head, { etag });
    }
    case '/snapshot': {
      let seq = Number(params.get('seq'));
      if (params.has('at')) {
        const at = toMillis(params.get('at')!);
        const found = store.commits.filter((c) => toMillis(c.at) <= at).at(-1);
        if (found === undefined) return problem(404, 'no_commit', '这个时刻之前还没有任何提交');
        seq = found.seq;
      }
      const snapshot = store.snapshot(seq);
      return snapshot ? json(200, snapshot) : problem(404, 'not_found', `没有 seq ${seq}`);
    }
    case '/timeline': {
      const from = params.has('from') ? toMillis(params.get('from')!) : -Infinity;
      const to = params.has('to') ? toMillis(params.get('to')!) : Infinity;
      const items = store.commits.filter((c) => toMillis(c.at) >= from && toMillis(c.at) <= to);
      return json(200, { items, nextAfter: null });
    }
    case '/events': {
      const from = params.has('from') ? toMillis(params.get('from')!) : -Infinity;
      const to = params.has('to') ? toMillis(params.get('to')!) : Infinity;
      const since = params.has('since') ? toMillis(params.get('since')!) : -Infinity;
      const types = params.get('types')?.split(',').filter(Boolean);
      const items = store.events.filter((e) => {
        const at = toMillis(e.at);
        return (
          at >= from &&
          at <= to &&
          toMillis(e.recordedAt) >= since &&
          (types === undefined || types.includes(e.type))
        );
      });
      return json(200, { items, nextAfter: null });
    }
    case '/events/density': {
      const from = params.get('from');
      const to = params.get('to');
      const bucket = Number(params.get('bucket'));
      if (from === null || to === null || !(bucket > 0)) {
        return problem(400, 'invalid_query', '需要 from、to 和 bucket（秒）');
      }
      const events = effectiveEvents(store.events, { publicOnly: true, types: store.eventTypes });
      return json(200, {
        from,
        to,
        bucketSec: bucket,
        buckets: densityBuckets(events, from, to, bucket * 1000),
      });
    }
    case '/state': {
      const at = params.get('at') ?? new Date().toISOString();
      const events = effectiveEvents(store.events, { publicOnly: true, types: store.eventTypes });
      const states = [...stateAt(events, store.eventTypes, at).values()].flatMap((m) => [
        ...m.values(),
      ]);
      return json(200, { at, states });
    }
    default:
      return problem(404, 'not_found', `没有这个接口：${path}`);
  }
}

/** 测试用：把 fixtureReply 包成 fetch。 */
export const fixtureFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    'http://fixtures.invalid',
  );
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const reply = fixtureReply(init?.method ?? 'GET', url.pathname, url.search, headers);
  if (reply === undefined) return new Response('not found', { status: 404 });
  const body =
    reply.body === null
      ? null
      : typeof reply.body === 'string'
        ? reply.body
        : reply.body.slice().buffer;
  return new Response(body, { status: reply.status, headers: reply.headers });
};
