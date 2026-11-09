import type { SpaceEvent } from '../core/api/types';
import { densityBuckets, effectiveEvents, stateAt, toMillis } from '../core/events';
import {
  emitFixture,
  fixtureStore,
  resetFixtureStore,
  spaceInfo,
  universeAt,
  type EmitKind,
  type FixtureSpace,
  type FixtureStore,
} from './index';

/**
 * 夹具模式的公开读接口（设计 8.2）：给一个 GET 请求，返回状态码、响应头和响应体。
 * 与 CMA web/build/devFixtures.ts 的做法相同——开发服务器和测试都用它，不需要后端。
 *
 * 和真实接口一样：
 * - 凭链接查看：不带或带错分享令牌一律 404，不暴露空间是否存在；
 * - 组合的分享令牌能读成员空间（请求带 `?universe=<组合编号>`）；
 * - 预览令牌放在 `Authorization: Preview <令牌>` 里，预览响应不缓存；
 * - 分页：提交每页 3 条、事件每页 400 条（故意比真实接口小，测试能走到翻页）；
 * - 写请求一律拒绝。另有 `/__fixtures/emit`、`/__fixtures/reset` 两个控制地址（不在 /api 下），
 *   供"现在"模式的端到端测试模拟新事件和新提交。
 */

export interface FixtureResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | null;
}

const TIMELINE_PAGE = 3;
const EVENTS_PAGE = 400;

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

const notFound = () => problem(404, 'not_found', '链接无效，或者空间不存在');

function binary(bytes: Uint8Array, type: string, cache: string): FixtureResponse {
  return {
    status: 200,
    headers: {
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'cache-control': cache,
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

function credential(headers: Readonly<Record<string, string | undefined>>, scheme: string) {
  const value = header(headers, 'authorization');
  if (value === undefined) return undefined;
  const space = value.indexOf(' ');
  if (space < 0 || value.slice(0, space).toLowerCase() !== scheme) return undefined;
  return value.slice(space + 1).trim();
}

/** 按页返回：after 是上一页最后一条的序号（字符串）。 */
function page<T>(items: readonly T[], size: number, after: string | null) {
  const start = after === null ? 0 : Number(after);
  const slice = items.slice(start, start + size);
  const next = start + size < items.length ? String(start + size) : null;
  return { items: slice, nextAfter: next };
}

/** 按点分路径取值。 */
function valueAt(data: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 只留登记的公开字段（点分路径还原成嵌套对象；没登记任何字段时是空对象）。 */
function projectFields(
  data: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const value = valueAt(data, path);
    if (value === undefined) continue;
    const parts = path.split('.');
    let target = out;
    for (const part of parts.slice(0, -1)) {
      const child = target[part];
      if (child === null || typeof child !== 'object') target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = value;
  }
  return out;
}

/**
 * 公开投影（与接口服务 `public_items` 相同）：先应用更正，再按生效的可见级别过滤
 * （事件自己写的优先，否则取 (type, typeVersion) 那个版本的默认级别），只留公开锚点上的事件，
 * data 只留公开字段。输出和真实接口一样不带 visibility、corrects、sourceEventId。
 */
function publicProjection(space: FixtureSpace, records: readonly SpaceEvent[]): SpaceEvent[] {
  const anchors = new Set(
    space.anchors.filter((a) => a.visibility === 'public').map((a) => a.anchorId),
  );
  anchors.add('_space');
  const redacted = new Set(records.filter((e) => e.redacted).map((e) => e.corrects ?? e.id));
  return effectiveEvents(records, { publicOnly: true, types: space.eventTypes })
    .filter((e) => anchors.has(e.anchorId))
    .map((e) => {
      const def = space.eventTypes.find((t) => t.type === e.type && t.version === e.typeVersion);
      const isRedacted = redacted.has(e.id);
      const data =
        isRedacted || e.data === undefined
          ? undefined
          : projectFields(e.data, def?.publicFields ?? []);
      return {
        id: e.id,
        spaceId: space.id,
        at: e.at,
        recordedAt: e.recordedAt,
        source: e.source,
        type: e.type,
        typeVersion: e.typeVersion,
        anchorId: e.anchorId,
        ...(data === undefined ? {} : { data }),
        ...(e.correlationId === undefined ? {} : { correlationId: e.correlationId }),
        ...(isRedacted ? { redacted: true } : {}),
      };
    });
}

/** 空间的全部公开事件（已应用更正）。 */
function publicEvents(space: FixtureSpace): SpaceEvent[] {
  return publicProjection(space, space.events);
}

function spaceAuthorized(
  fixtures: FixtureStore,
  space: FixtureSpace,
  share: string | undefined,
  universe: string | null,
): boolean {
  if (share === space.shareToken) return true;
  if (universe !== fixtures.universe.id || share !== fixtures.universe.shareToken) return false;
  return fixtures.universe.revisions.some((r) => r.members.some((m) => m.spaceId === space.id));
}

function anyShareToken(fixtures: FixtureStore, share: string | undefined): boolean {
  if (share === undefined) return false;
  if (share === fixtures.universe.shareToken) return true;
  return [...fixtures.spaces.values()].some((space) => space.shareToken === share);
}

/** 控制地址：模拟新事件、新提交，或者重置夹具。不是 /__fixtures/ 下的地址返回 undefined。 */
export function fixtureControl(method: string, path: string, search: string) {
  if (!path.startsWith('/__fixtures/')) return undefined;
  if (method !== 'POST') return problem(405, 'method_not_allowed', '控制地址只接受 POST');
  const params = new URLSearchParams(search);
  if (path === '/__fixtures/reset') {
    resetFixtureStore();
    return json(200, { ok: true });
  }
  if (path === '/__fixtures/emit') {
    const kind = (params.get('kind') ?? 'event') as EmitKind;
    if (!['event', 'commit', 'delivery'].includes(kind)) {
      return problem(400, 'invalid_kind', 'kind 只能是 event、commit、delivery');
    }
    return json(200, emitFixture(kind));
  }
  return problem(404, 'not_found', `没有这个控制地址：${path}`);
}

/** 处理一个请求；不是 `/api/` 或 `/__fixtures/` 下的路径返回 undefined，交给开发服务器。 */
export function fixtureReply(
  method: string,
  path: string,
  search: string,
  headers: Readonly<Record<string, string | undefined>>,
): FixtureResponse | undefined {
  const control = fixtureControl(method, path, search);
  if (control !== undefined) return control;
  if (!path.startsWith('/api/')) return undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    return problem(501, 'fixture_read_only', `夹具模式只读，不接受 ${method} ${path}`);
  }
  if (!path.startsWith('/api/public/')) {
    return problem(404, 'fixture_missing', `夹具模式没有 ${path}`);
  }
  const fixtures = fixtureStore();
  const params = new URLSearchParams(search);
  const share = credential(headers, 'share');

  // 草稿预览：只认预览令牌，响应不缓存。
  if (path === '/api/public/previews' || path.startsWith('/api/public/previews/')) {
    if (credential(headers, 'preview') !== fixtures.preview.token) return notFound();
    if (path === '/api/public/previews') {
      return json(200, fixtures.preview.view, { 'cache-control': 'no-store' });
    }
    const draftChunk = /^\/api\/public\/previews\/chunks\/([0-9a-f]{64})$/.exec(path);
    const draftAsset = /^\/api\/public\/previews\/assets\/([0-9a-f]{64})$/.exec(path);
    const view = fixtures.preview.view;
    if (draftChunk) {
      const hash = draftChunk[1]!;
      // 只返回属于这个草稿结果的区块（已发布的和草稿新生成的）。
      if (!view.chunks.some((c) => c.hash === hash)) return notFound();
      const bytes = fixtures.draftChunks.get(hash) ?? fixtures.chunks.get(hash);
      return bytes ? binary(bytes, 'application/octet-stream', 'no-store') : notFound();
    }
    if (draftAsset) {
      const hash = draftAsset[1]!;
      const asset = fixtures.draftAssets.get(hash) ?? fixtures.assets.get(hash);
      return asset ? binary(asset.bytes, asset.type, 'no-store') : notFound();
    }
    return notFound();
  }

  const chunk = /^\/api\/public\/chunks\/([0-9a-f]{64})\.bin$/.exec(path);
  const asset = /^\/api\/public\/assets\/([0-9a-f]{64})\.bin$/.exec(path);
  if (chunk || asset) {
    if (!anyShareToken(fixtures, share)) return notFound();
    if (chunk) {
      const bytes = fixtures.chunks.get(chunk[1]!);
      return bytes
        ? binary(bytes, 'application/octet-stream', 'private, max-age=31536000, immutable')
        : notFound();
    }
    const found = fixtures.assets.get(asset![1]!);
    return found
      ? binary(found.bytes, found.type, 'private, max-age=31536000, immutable')
      : notFound();
  }

  const universe = /^\/api\/public\/universes\/([^/]+)(?:\/revisions\/(\d+))?$/.exec(path);
  if (universe) {
    const id = decodeURIComponent(universe[1]!);
    if (id !== fixtures.universe.id || share !== fixtures.universe.shareToken) return notFound();
    if (universe[2] !== undefined) {
      const revision = fixtures.universe.revisions.find((r) => r.seq === Number(universe[2]));
      if (revision === undefined) return notFound();
      return json(200, {
        universeId: id,
        seq: revision.seq,
        at: revision.at,
        message: revision.message,
        state: { members: revision.members, links: revision.links },
      });
    }
    const at = params.has('at') ? toMillis(params.get('at')!) : Date.now();
    const found = universeAt(fixtures, at);
    if (found === undefined) return problem(404, 'no_revision', '这个时刻之前组合还不存在');
    return json(
      200,
      {
        id,
        name: fixtures.universe.name,
        seq: found.revision.seq,
        at: found.revision.at,
        members: found.members,
        links: found.revision.links,
      },
      { 'cache-control': 'no-store' },
    );
  }

  const match = /^\/api\/public\/spaces\/([^/]+)(\/.*)?$/.exec(path);
  if (match === null) return problem(404, 'not_found', `没有这个接口：${path}`);
  const space = fixtures.spaces.get(decodeURIComponent(match[1]!));
  const rest = match[2] ?? '';
  // 凭链接查看：没带令牌或令牌无效一律 404，不暴露空间是否存在。
  if (space === undefined || !spaceAuthorized(fixtures, space, share, params.get('universe'))) {
    return notFound();
  }

  switch (rest) {
    case '':
      return json(200, spaceInfo(space));
    case '/head': {
      const head = spaceInfo(space).head!;
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
        const found = space.commits.filter((c) => toMillis(c.at) <= at).at(-1);
        if (found === undefined) return problem(404, 'no_commit', '这个时刻之前还没有任何提交');
        seq = found.seq;
      }
      const snapshot = space.snapshots.get(seq);
      return snapshot ? json(200, snapshot) : problem(404, 'not_found', `没有 seq ${seq}`);
    }
    case '/timeline': {
      const from = params.has('from') ? toMillis(params.get('from')!) : -Infinity;
      const to = params.has('to') ? toMillis(params.get('to')!) : Infinity;
      const items = space.commits.filter((c) => toMillis(c.at) >= from && toMillis(c.at) <= to);
      return json(200, page(items, TIMELINE_PAGE, params.get('after')));
    }
    case '/events': {
      const from = params.has('from') ? toMillis(params.get('from')!) : -Infinity;
      const to = params.has('to') ? toMillis(params.get('to')!) : Infinity;
      const since = params.has('since') ? toMillis(params.get('since')!) : -Infinity;
      // from/to 每次最多 24 小时；只按 since 增量取时不限。
      if ((params.has('from') || params.has('to')) && to - from > 24 * 3_600_000 + 1) {
        return problem(400, 'range_too_long', '每次最多查 24 小时');
      }
      const types = params.get('types')?.split(',').filter(Boolean);
      const items = publicEvents(space).filter((e) => {
        const at = toMillis(e.at);
        return (
          at >= from &&
          at <= to &&
          toMillis(e.recordedAt) >= since &&
          (types === undefined || types.includes(e.type))
        );
      });
      return json(200, page(items, EVENTS_PAGE, params.get('after')));
    }
    case '/events/density': {
      const from = params.get('from');
      const to = params.get('to');
      const bucket = Number(params.get('bucket'));
      if (from === null || to === null || !(bucket > 0)) {
        return problem(400, 'invalid_query', '需要 from、to 和 bucket（秒）');
      }
      if (toMillis(to) - toMillis(from) > 90 * 86_400_000 + 1) {
        return problem(400, 'range_too_long', '最长 90 天');
      }
      const events = publicEvents(space);
      return json(200, {
        from,
        to,
        bucketSec: bucket,
        buckets: densityBuckets(events, from, to, bucket * 1000),
      });
    }
    case '/state': {
      const at = params.get('at') ?? new Date().toISOString();
      const events = publicEvents(space);
      const byId = new Map(events.map((e) => [e.id, e]));
      const states = [...stateAt(events, space.eventTypes, at).values()].flatMap((m) =>
        [...m.values()].map((state) => {
          const event = byId.get(state.eventId);
          return { ...state, typeVersion: event?.typeVersion, data: event?.data };
        }),
      );
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
