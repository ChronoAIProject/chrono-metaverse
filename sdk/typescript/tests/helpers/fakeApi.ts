import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 测试用的假接口服务：按接口服务的实际路径和字段（api/crates/metaverse-api/src/routes/）回答，
 * 记录每个请求，检查分片上传的分片大小、格式、文件头和整体哈希。也带一个模拟 NyxID 的 /dev/token。
 *
 * 接口服务的请求体都带 `deny_unknown_fields`：这里同样对未知字段和缺少的必填字段返回 422
 * `invalid_request`，免得命令行按假设的字段测试通过、对真服务却一律 422。
 */

/** 各用途接受的格式（docs/SHAPES.md 第 8 节）。 */
export const UPLOAD_FORMATS: Readonly<Record<string, readonly string[]>> = {
  scan: ['glb', 'drc', 'obj', 'zip'],
  webmodel: ['glb'],
  model: ['glb'],
  texture: ['png', 'jpeg', 'webp'],
  ops: ['ndjson', 'gzip'],
  script: ['text'],
  bundle: ['json'],
};

/** 各路径范围收的上传用途（docs/design/server-slim.md 2.9）。 */
export const SCOPE_PURPOSES = {
  physical: ['model', 'texture', 'ops', 'script'],
  rebuild: ['scan', 'webmodel', 'model', 'texture', 'script', 'bundle'],
} as const;

/** 有未知字段或缺必填字段时返回说明（与 serde 的 `deny_unknown_fields` 相同的效果）。 */
export function fieldError(
  body: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
): string | null {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return `未知字段 ${unknown.join('、')}`;
  const missing = required.filter((key) => body[key] === undefined || body[key] === null);
  if (missing.length > 0) return `缺少字段 ${missing.join('、')}`;
  return null;
}

const OBJ_KEYWORDS = new Set([
  'v',
  'vt',
  'vn',
  'vp',
  'f',
  'l',
  'p',
  'o',
  'g',
  's',
  'mtllib',
  'usemtl',
]);

/** 第 0 片的文件头与声明的格式不符时返回 true（规则同接口服务 `ingest/formats.rs`，图片只看魔数）。 */
export function headerMismatch(format: string, head: Buffer, totalSize: number): boolean {
  switch (format) {
    case 'glb':
      return (
        head.length < 12 ||
        head.toString('latin1', 0, 4) !== 'glTF' ||
        head.readUInt32LE(4) !== 2 ||
        head.readUInt32LE(8) !== totalSize
      );
    case 'drc':
      return head.toString('latin1', 0, 5) !== 'DRACO';
    case 'zip':
      return !head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    case 'gzip':
      return !head.subarray(0, 3).equals(Buffer.from([0x1f, 0x8b, 0x08]));
    case 'png':
      return !head.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));
    case 'jpeg':
      return !head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    case 'webp':
      return head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP';
    case 'ndjson':
      return head.includes(0) || head.toString('utf8').trimStart()[0] !== '{';
    case 'text':
      return head.includes(0);
    case 'json':
      return head.includes(0) || head.toString('utf8').trimStart()[0] !== '{';
    case 'obj': {
      if (head.includes(0)) return true;
      for (const line of head.toString('utf8').split('\n')) {
        const text = line.trim();
        if (text === '' || text.startsWith('#')) continue;
        return !OBJ_KEYWORDS.has(text.split(/\s+/)[0]!);
      }
      return false;
    }
    default:
      return true;
  }
}

/** 文件头合法的假 glb（总长度写在头里）。 */
export function fakeGlb(size: number, fill = 7): Buffer {
  const bytes = Buffer.alloc(size, fill);
  bytes.write('glTF', 0, 'latin1');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(size, 8);
  return bytes;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

interface Upload {
  id: string;
  purpose: string;
  format: string;
  size: number;
  sha256: string;
  partSize: number;
  parts: Map<number, Buffer>;
  scopePath: string;
  status: 'open' | 'done';
  reused: boolean;
}

interface Job {
  id: string;
  kind: string;
  /** 发起任务的路径范围（经地块路径只能查到本地块的任务）。 */
  scopePath?: string;
  polls: number;
  /** 前几次查询返回 running，之后 done（或 failed）。 */
  runningPolls: number;
  fail?: string;
  result?: unknown;
  resultCommitId?: string;
}

export interface FakeState {
  space: Record<string, unknown>;
  snapshot: Record<string, unknown> | null;
  chunks: Map<string, Buffer>;
  assets: Map<string, Buffer>;
  uploads: Map<string, Upload>;
  jobs: Map<string, Job>;
  drafts: Map<
    string,
    { scopePath: string; baseSeq: number; ops: unknown[]; bundle?: string; published?: boolean }
  >;
  devTokens: number;
  publishConflict: boolean;
  /** 和 publishConflict 一起用：带 replay 时在最新版本上重放成功。 */
  replayResolves?: boolean;
  /** 重建草稿发布过的包（清单哈希）：同一个包再发布返回 unchanged。 */
  publishedBundles: Set<string>;
  /** 是否有目标空间的管理权（默认有）；只读成员写重建路径返回 403。 */
  canManageSpace: boolean;
  /** 公开读用的分享令牌。 */
  shareToken: string;
  /** 资源下载时每段最多给这么多字节（模拟服务端按 Range 分段）；0 表示不支持 Range、整份返回。 */
  rangeChunk?: number;
  /** 接下来这么多个资源请求直接断开连接（模拟代理断开）。 */
  dropAssetRequests: number;
  /** 交包任务的结果（不给就按清单算）。 */
  bundleResult?: unknown;
  /** 给了就让发布返回这个问题文档（例如 409 `broken_template_ref`）。 */
  publishProblem?: {
    status: number;
    code: string;
    detail: string;
    extra?: Record<string, unknown>;
  };
  /** 给了就让发布返回 409 `asset_gone`（与接口服务相同：`assets` 列出已被定期清理的资源）。 */
  publishAssetsGone?: readonly string[];
  failNextPart: boolean;
  shareTokenRotations: number;
  /**
   * 模拟 NyxID 的操作范围：给了就只放行以这些前缀开头的接口路径，其余 403（NyxID 在转发前拦下）。
   */
  allowedPrefixes?: readonly string[];
  /** 轮换分享令牌时改用这个响应（测试响应缺字段的情况）。 */
  shareTokenResponse?: unknown;
}

export interface FakeApi {
  readonly url: string;
  readonly devTokenUrl: string;
  readonly requests: RecordedRequest[];
  readonly state: FakeState;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export async function startFakeApi(init: Partial<FakeState> = {}): Promise<FakeApi> {
  const state: FakeState = {
    space: init.space ?? {
      id: 'demo-space',
      name: '演示空间',
      head: { seq: 0, at: '2026-11-01T00:00:00.000Z' },
      regions: [],
      plots: [],
      anchors: [],
    },
    snapshot: init.snapshot ?? null,
    chunks: init.chunks ?? new Map(),
    assets: init.assets ?? new Map(),
    uploads: new Map(),
    jobs: new Map(),
    drafts: new Map(),
    devTokens: 0,
    publishConflict: init.publishConflict ?? false,
    ...(init.replayResolves !== undefined ? { replayResolves: init.replayResolves } : {}),
    publishedBundles: init.publishedBundles ?? new Set(),
    canManageSpace: init.canManageSpace ?? true,
    shareToken: init.shareToken ?? 'share-secret-1',
    ...(init.rangeChunk !== undefined ? { rangeChunk: init.rangeChunk } : {}),
    dropAssetRequests: init.dropAssetRequests ?? 0,
    ...(init.bundleResult !== undefined ? { bundleResult: init.bundleResult } : {}),
    ...(init.publishProblem !== undefined ? { publishProblem: init.publishProblem } : {}),
    ...(init.publishAssetsGone !== undefined ? { publishAssetsGone: init.publishAssetsGone } : {}),
    failNextPart: init.failNextPart ?? false,
    shareTokenRotations: 0,
    shareTokenResponse: init.shareTokenResponse,
    ...(init.allowedPrefixes !== undefined ? { allowedPrefixes: init.allowedPrefixes } : {}),
  };
  const requests: RecordedRequest[] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const newJob = (kind: string, extra: Partial<Job> = {}): Job => {
    const job: Job = { id: nextId('job'), kind, polls: 0, runningPolls: 1, ...extra };
    state.jobs.set(job.id, job);
    return job;
  };

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const body = await readBody(request);
    requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body,
    });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const problem = (
      status: number,
      code: string,
      detail: string,
      extra: Record<string, unknown> = {},
    ) => {
      response.writeHead(status, { 'content-type': 'application/problem+json' });
      response.end(
        JSON.stringify({ type: 'about:blank', title: code, status, code, detail, ...extra }),
      );
    };
    const parsed = () =>
      body.length === 0 ? {} : (JSON.parse(body.toString('utf8')) as Record<string, unknown>);
    /** 请求体字段不合法时回 422 并返回 true（调用处直接 return）。 */
    const invalidFields = (
      req: Record<string, unknown>,
      allowed: readonly string[],
      required: readonly string[] = [],
    ): boolean => {
      const error = fieldError(req, allowed, required);
      if (error !== null) problem(422, 'invalid_request', `请求体不合法：${error}`);
      return error !== null;
    };
    const path = url.pathname;

    if (path === '/dev/token' && request.method === 'POST') {
      state.devTokens += 1;
      json(200, {
        identityToken: `identity-${state.devTokens}`,
        accessToken: `access-${state.devTokens}`,
      });
      return;
    }
    // 公开读（/api/public）：不要 NyxID 令牌；凭链接查看的空间要 `Authorization: Share <分享令牌>`。
    if (path.startsWith('/api/public/')) {
      const publicSpace = state.space.visibility === 'public';
      const shared = request.headers.authorization === `Share ${state.shareToken}`;
      const id = String(state.space.id);
      if (path === `/api/public/spaces/${id}`) {
        if (!publicSpace && !shared) return problem(404, 'not_found', '空间不存在');
        const rest = { ...state.space };
        delete rest.uploadLimits;
        return json(200, {
          ...rest,
          anchors: ((state.space.anchors ?? []) as { visibility?: string }[]).filter(
            (a) => a.visibility !== 'internal',
          ),
        });
      }
      if (path === `/api/public/spaces/${id}/snapshot`) {
        if (!publicSpace && !shared) return problem(404, 'not_found', '空间不存在');
        if (state.snapshot === null) return problem(404, 'not_found', '没有快照');
        const scan = state.snapshot.scan as Record<string, unknown> | null | undefined;
        return json(200, {
          ...state.snapshot,
          seq: Number(url.searchParams.get('seq')),
          anchors: ((state.snapshot.anchors ?? []) as { visibility?: string }[]).filter(
            (a) => a.visibility !== 'internal',
          ),
          scan:
            scan === null || scan === undefined
              ? null
              : { webModelHashes: scan.webModelHashes, transform: scan.transform },
        });
      }
      const blob = /^\/api\/public\/(chunks|assets)\/([0-9a-f]{64})\.bin$/.exec(path);
      if (blob !== null) {
        const bytes = (blob[1] === 'chunks' ? state.chunks : state.assets).get(blob[2]!);
        if (bytes === undefined) return problem(404, 'not_found', '没有');
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(bytes);
        return;
      }
      return problem(404, 'not_found', `假服务器没有 ${path}`);
    }
    // 去掉 NyxID 代理前缀，剩下的就是接口路径。
    const apiPath = path.replace(/^\/api\/v1\/proxy\/s\/[^/]+/, '');
    const auth = request.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      problem(401, 'unauthenticated', '没有令牌');
      return;
    }
    if (
      state.allowedPrefixes !== undefined &&
      !state.allowedPrefixes.some((prefix) => apiPath.startsWith(prefix))
    ) {
      problem(
        403,
        'operation_scope_denied',
        `agent key 的操作范围不含 ${request.method} ${apiPath}`,
      );
      return;
    }
    let m: RegExpExecArray | null;
    // 重建路径写操作沿用目标空间的管理权。
    if (apiPath.includes('/rebuild/') && request.method !== 'GET' && !state.canManageSpace) {
      return problem(403, 'forbidden', '没有目标空间管理权');
    }
    const spaceId = String(state.space.id);
    const space = `/api/v1/spaces/${spaceId}`;
    if (apiPath === space && request.method === 'GET') return json(200, state.space);
    if (apiPath === `${space}/snapshot` && request.method === 'GET') {
      if (state.snapshot === null) return problem(404, 'not_found', '没有快照');
      return json(200, state.snapshot);
    }
    if ((m = /^\/api\/v1\/spaces\/[^/]+\/chunks\/([0-9a-f]{64})$/.exec(apiPath))) {
      const bytes = state.chunks.get(m[1]!);
      if (bytes === undefined) return problem(404, 'not_found', '没有区块');
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(bytes);
      return;
    }
    if ((m = /^\/api\/v1\/spaces\/[^/]+\/assets\/([0-9a-f]{64})$/.exec(apiPath))) {
      if (state.dropAssetRequests > 0) {
        state.dropAssetRequests -= 1;
        request.socket.destroy();
        return;
      }
      const bytes = state.assets.get(m[1]!);
      if (bytes === undefined) return problem(404, 'not_found', '没有资源');
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''));
      if (range !== null && state.rangeChunk !== 0) {
        const start = Number(range[1]);
        if (start >= bytes.length) {
          response.writeHead(416, { 'content-range': `bytes */${bytes.length}` });
          response.end();
          return;
        }
        // 与接口服务相同：结尾超出时截到文件末尾；另外按 rangeChunk 模拟每段更小。
        let end = Math.min(Number(range[2]) + 1, bytes.length);
        if (state.rangeChunk !== undefined) end = Math.min(end, start + state.rangeChunk);
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${end - 1}/${bytes.length}`,
        });
        response.end(bytes.subarray(start, end));
        return;
      }
      response.writeHead(200, { 'content-type': 'model/gltf-binary' });
      response.end(bytes);
      return;
    }
    if (
      (m = /^(\/api\/v1\/spaces\/[^/]+(?:\/plots\/[^/]+|\/rebuild)?)\/jobs\/([^/]+)$/.exec(apiPath))
    ) {
      const job = state.jobs.get(m[2]!);
      if (job === undefined) return problem(404, 'not_found', '没有任务');
      // 与接口服务相同：经地块、重建路径只能查到经同一路径发起的任务；实体区路径都能查。
      if ((m[1]!.includes('/plots/') || m[1]!.endsWith('/rebuild')) && job.scopePath !== m[1])
        return problem(404, 'not_found', '任务不存在或不属于这个范围');
      job.polls += 1;
      const status = job.polls <= job.runningPolls ? 'running' : job.fail ? 'failed' : 'done';
      return json(200, {
        id: job.id,
        kind: job.kind,
        status,
        attempt: 1,
        maxAttempts: 3,
        ...(status === 'failed' ? { lastError: job.fail } : {}),
        ...(status === 'done' && job.result !== undefined ? { result: job.result } : {}),
        ...(status === 'done' && job.resultCommitId ? { resultCommitId: job.resultCommitId } : {}),
      });
    }
    // 上传：{范围}/uploads/{purpose}[/{id}[/parts/{n} | /complete]]
    if (
      (m =
        /^(\/api\/v1\/spaces\/[^/]+(?:\/plots\/[^/]+|\/rebuild)?)\/uploads\/([a-z]+)(?:\/([^/]+)(\/parts\/(\d+)|\/complete)?)?$/.exec(
          apiPath,
        ))
    ) {
      const [, scopePath, purpose, uploadId, tail, n] = m;
      const allowed: readonly string[] = scopePath!.endsWith('/rebuild')
        ? SCOPE_PURPOSES.rebuild
        : SCOPE_PURPOSES.physical;
      if (!allowed.includes(purpose!))
        return problem(422, 'purpose_not_allowed', `这条路径不收 ${purpose} 用途的上传`);
      if (uploadId !== undefined && tail === undefined && request.method === 'GET') {
        const upload = state.uploads.get(uploadId);
        if (upload === undefined) return problem(404, 'not_found', '没有上传');
        return json(200, { uploadId: upload.id, status: upload.status, assetHash: upload.sha256 });
      }
      if (uploadId === undefined && request.method === 'POST') {
        const req = parsed();
        if (
          invalidFields(
            req,
            ['size', 'sha256', 'partSize', 'format'],
            ['size', 'sha256', 'partSize', 'format'],
          )
        )
          return;
        const size = Number(req.size);
        const partSize = Number(req.partSize);
        const format = String(req.format);
        if (!(UPLOAD_FORMATS[purpose!] ?? []).includes(format))
          return problem(422, 'unsupported_format', `${purpose} 用途不接受格式 ${format}`);
        if (partSize % (256 * 1024) !== 0 || partSize > 32 * 1024 * 1024)
          return problem(422, 'invalid_part_size', '分片大小不对');
        const reused = state.assets.has(String(req.sha256));
        const upload: Upload = {
          id: nextId('up'),
          purpose: purpose!,
          format,
          size,
          sha256: String(req.sha256),
          partSize,
          parts: new Map(),
          scopePath: scopePath!,
          status: reused ? 'done' : 'open',
          reused,
        };
        state.uploads.set(upload.id, upload);
        const view = {
          uploadId: upload.id,
          purpose: upload.purpose,
          declaredFormat: format,
          status: upload.status,
          size,
          sha256: upload.sha256,
          partSize,
          partCount: Math.ceil(size / partSize),
          reused,
          ...(reused ? { assetHash: upload.sha256 } : {}),
        };
        // 与接口服务相同：复用（本空间已有这份内容）和新建都是 201，只靠 reused / status 区分，
        // 不让状态码透露别处有没有某个文件。
        return json(201, view);
      }
      const upload = state.uploads.get(uploadId ?? '');
      if (upload === undefined) return problem(404, 'not_found', '没有上传');
      if (tail?.startsWith('/parts/') && request.method === 'PUT') {
        if (state.failNextPart) {
          state.failNextPart = false;
          return problem(503, 'unavailable', '暂时不可用');
        }
        const index = Number(n);
        const expected = Math.min(upload.partSize, upload.size - index * upload.partSize);
        if (body.length !== expected)
          return problem(422, 'invalid', `第 ${index} 片大小 ${body.length}，应为 ${expected}`);
        if (index === 0 && headerMismatch(upload.format, body, upload.size))
          return problem(422, 'format_mismatch', `文件头与声明的格式 ${upload.format} 不符`);
        upload.parts.set(index, body);
        return json(200, {
          n: index,
          size: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        });
      }
      if (tail === '/complete' && request.method === 'POST') {
        const count = Math.ceil(upload.size / upload.partSize);
        const all = Buffer.concat(
          Array.from({ length: count }, (_, i) => upload.parts.get(i) ?? Buffer.alloc(0)),
        );
        const sha = createHash('sha256').update(all).digest('hex');
        const job = newJob('upload_verify', {
          scopePath: upload.scopePath,
          ...(sha === upload.sha256 ? {} : { fail: '整体哈希不一致' }),
        });
        if (sha === upload.sha256) {
          state.assets.set(sha, all);
          upload.status = 'done';
        }
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ uploadId: upload.id, status: 'complete', jobId: job.id }));
        return;
      }
    }
    // 草稿：{范围}/drafts[/{id}[/(ops|ops-from-upload|bundle|preview|publish)]]
    if (
      (m =
        /^(\/api\/v1\/spaces\/[^/]+(?:\/plots\/[^/]+|\/rebuild)?)\/drafts(?:\/([^/]+)(?:\/(ops|ops-from-upload|bundle|preview|publish))?)?$/.exec(
          apiPath,
        ))
    ) {
      const [, scopePath, draftId, action] = m;
      const rebuild = scopePath!.endsWith('/rebuild');
      // 重建路径没有内联操作和操作文件；交包只在重建路径。
      if (
        (rebuild && (action === 'ops' || action === 'ops-from-upload')) ||
        (!rebuild && action === 'bundle')
      )
        return problem(404, 'not_found', `假服务器没有 ${request.method} ${apiPath}`);
      if (draftId !== undefined && action === undefined) {
        const found = state.drafts.get(draftId);
        if (found === undefined || found.scopePath !== scopePath)
          return problem(404, 'not_found', '没有草稿');
        if (request.method === 'DELETE') {
          state.drafts.delete(draftId);
          response.writeHead(204);
          response.end();
          return;
        }
        return json(200, { id: draftId, baseSeq: found.baseSeq });
      }
      if (draftId === undefined && request.method === 'POST') {
        const req = parsed();
        // CreateDraftRequest 只有 baseSeq（提交说明在发布时给）。
        if (invalidFields(req, ['baseSeq'])) return;
        const id = nextId('draft');
        state.drafts.set(id, { scopePath: scopePath!, baseSeq: Number(req.baseSeq), ops: [] });
        return json(201, {
          id,
          scope: rebuild ? 'rebuild' : scopePath!.includes('/plots/') ? 'plot' : 'physical',
          baseSeq: req.baseSeq,
          rev: 0,
        });
      }
      const draft = state.drafts.get(draftId ?? '');
      if (draft === undefined) return problem(404, 'not_found', '没有草稿');
      if (draft.scopePath !== scopePath) return problem(403, 'forbidden', '草稿不属于这个路径范围');
      const req = parsed();
      switch (action) {
        case 'ops':
          draft.ops.push(...(req.ops as unknown[]));
          return json(200, { rev: draft.ops.length });
        case 'ops-from-upload': {
          if (invalidFields(req, ['uploadId', 'assetHash'])) return;
          // 与接口服务相同：{uploadId} 或 {assetHash} 二选一，两个都给或都不给 422。
          if ((req.uploadId === undefined) === (req.assetHash === undefined))
            return problem(
              422,
              'invalid_request',
              '请求体必须是 {uploadId} 或 {assetHash}（64 位小写十六进制）之一',
            );
          const source = [...state.uploads.values()].find(
            (u) =>
              u.purpose === 'ops' &&
              u.status === 'done' &&
              (req.uploadId !== undefined ? u.id === req.uploadId : u.sha256 === req.assetHash),
          );
          const bytes = source === undefined ? undefined : state.assets.get(source.sha256);
          if (bytes === undefined)
            return problem(404, 'not_found', '没有找到本空间已完成校验的 ops 上传');
          const ops = bytes
            .toString('utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as unknown);
          draft.ops.push(...ops);
          // 任务记下草稿的路径范围（接口服务 insert_ops_job 写 scope 之后的行为）。
          const job = newJob('ops_from_upload', {
            scopePath: draft.scopePath,
            result: { applied: ops.length, rev: 1 },
          });
          return json(202, { jobId: job.id });
        }
        case 'bundle': {
          if (invalidFields(req, ['uploadId', 'assetHash'])) return;
          if ((req.uploadId === undefined) === (req.assetHash === undefined))
            return problem(422, 'invalid_request', '请求体必须是 {uploadId} 或 {assetHash} 之一');
          if (draft.bundle !== undefined)
            return problem(409, 'bundle_already_applied', '这个重建草稿已经交过包');
          const source = [...state.uploads.values()].find(
            (u) =>
              u.purpose === 'bundle' &&
              u.status === 'done' &&
              u.scopePath === scopePath &&
              (req.uploadId !== undefined ? u.id === req.uploadId : u.sha256 === req.assetHash),
          );
          const bytes = source === undefined ? undefined : state.assets.get(source.sha256);
          if (bytes === undefined)
            return problem(404, 'not_found', '没有找到本空间重建范围、核对通过的清单');
          const manifest = JSON.parse(bytes.toString('utf8')) as {
            rebuilt?: { templates?: unknown[]; entities?: unknown[]; remove?: unknown[] };
            anchors?: { anchorId: string }[];
          };
          draft.bundle = source!.sha256;
          const job = newJob('ops_from_upload', {
            scopePath: draft.scopePath,
            result: state.bundleResult ?? {
              applied: 1,
              entities: {
                placed:
                  (manifest.rebuilt?.templates?.length ?? 0) +
                  (manifest.rebuilt?.entities?.length ?? 0),
                removed: manifest.rebuilt?.remove?.length ?? 0,
              },
              anchors: {
                created: (manifest.anchors ?? []).map((a) => a.anchorId),
                skipped: [],
              },
              anchorDrift: [],
            },
          });
          return json(202, { jobId: job.id, status: 'queued' });
        }
        case 'preview': {
          if (invalidFields(req, ['ttlSeconds'])) return;
          const ttl = req.ttlSeconds === undefined ? 86400 : Number(req.ttlSeconds);
          if (!Number.isInteger(ttl) || ttl < 60 || ttl > 604800)
            return problem(422, 'invalid_request', 'ttlSeconds 必须在 60 到 604800 之间');
          return json(201, {
            token: 'preview-token-abc',
            rev: draft.ops.length,
            expiresAt: '2026-11-10T00:00:00.000Z',
          });
        }
        case 'publish':
          if (invalidFields(req, ['message', 'replay', 'rev', 'observedAt', 'scriptRef'])) return;
          if (req.rev !== undefined && req.rev !== draft.ops.length)
            return problem(409, 'draft_rev_changed', '草稿已变化，请重新预览并确认当前修订');
          if (state.publishProblem !== undefined) {
            const { status, code, detail, extra } = state.publishProblem;
            return problem(status, code, detail, extra ?? {});
          }
          if (state.publishConflict && !(state.replayResolves === true && req.replay === true)) {
            return problem(409, 'draft_conflict', '时间线已前进，与草稿冲突', {
              conflicts: { entities: ['table-1'] },
            });
          }
          if (state.publishAssetsGone !== undefined) {
            return problem(
              409,
              'asset_gone',
              `草稿引用的 ${state.publishAssetsGone.length} 个资源已经被清理，没有发布；请重新上传 assets 里列出的资源后再发布`,
              { assets: state.publishAssetsGone },
            );
          }
          if (rebuild && draft.bundle !== undefined && state.publishedBundles.has(draft.bundle)) {
            // 内容没有变化：不写提交（docs/design/server-slim.md 2.7）。
            draft.published = true;
            return json(200, {
              unchanged: true,
              seq: Number((state.space.head as { seq: number }).seq),
            });
          }
          if (rebuild && draft.bundle !== undefined) state.publishedBundles.add(draft.bundle);
          draft.published = true;
          return json(200, {
            seq: Number((state.space.head as { seq: number }).seq) + 1,
            at: '2026-11-09T01:00:00.000Z',
            commitId: 'commit-10',
          });
      }
    }
    if (apiPath === '/api/v1/admin/spaces' && request.method === 'POST') {
      const req = parsed();
      return json(201, {
        space: { id: req.id, name: req.name },
        shareToken: { id: 'st_1', token: 'share-secret-1' },
      });
    }
    if (
      (m =
        /^\/api\/v1\/admin\/spaces\/[^/]+(\/share-tokens|\/layout|\/event-types|\/events\/[^/]+\/redact)?$/.exec(
          apiPath,
        ))
    ) {
      const tail = m[1] ?? '';
      if (tail === '' && request.method === 'PATCH') {
        const req = parsed();
        if (invalidFields(req, ['name', 'description', 'visibility', 'confirmPublicHistory']))
          return;
        if (
          state.space.visibility !== 'public' &&
          req.visibility === 'public' &&
          req.confirmPublicHistory !== true
        )
          return problem(
            409,
            'confirmation_required',
            '改成公开后全部历史都会公开；确认后请带 confirmPublicHistory: true 重试',
          );
        const changes = { ...req };
        delete changes.confirmPublicHistory;
        state.space = { ...state.space, ...changes };
        // 接口服务直接返回修改后的 SpaceView（不是 { space }）。
        return json(200, state.space);
      }
      if (tail === '/share-tokens' && request.method === 'POST') {
        // 接口服务不读请求体，吊销全部现有令牌后返回顶层的 { id, token }。
        state.shareTokenRotations += 1;
        if (state.shareTokenResponse !== undefined) return json(201, state.shareTokenResponse);
        const n = state.shareTokenRotations + 1;
        return json(201, { id: `st_${n}`, token: `share-secret-${n}` });
      }
      if (tail === '/layout' && request.method === 'PUT') return json(200, { seq: 7 });
      if (tail === '/event-types') return json(201, { type: parsed().type, version: 1 });
      if (tail.endsWith('/redact'))
        return json(200, { id: tail.split('/')[2], redacted: true, records: 2 });
    }
    problem(404, 'not_found', `假服务器没有 ${request.method} ${apiPath}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    devTokenUrl: `${url}/dev/token`,
    requests,
    state,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
