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

/** 各用途默认接受的格式（接口服务 `ingest/mod.rs` 的默认值）。 */
export const UPLOAD_FORMATS: Readonly<Record<string, readonly string[]>> = {
  scan: ['glb', 'drc', 'obj', 'zip'],
  model: ['glb', 'drc', 'obj', 'zip'],
  texture: ['png', 'jpeg', 'webp'],
  ops: ['ndjson', 'gzip'],
  script: ['text'],
};

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
  drafts: Map<string, { scopePath: string; baseSeq: number; ops: unknown[] }>;
  devTokens: number;
  publishConflict: boolean;
  scanResult?: unknown;
  failNextPart: boolean;
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
    scanResult: init.scanResult,
    failNextPart: init.failNextPart ?? false,
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
    // 去掉 NyxID 代理前缀，剩下的就是接口路径。
    const apiPath = path.replace(/^\/api\/v1\/proxy\/s\/[^/]+/, '');
    const auth = request.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      problem(401, 'unauthenticated', '没有令牌');
      return;
    }
    let m: RegExpExecArray | null;
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
      const bytes = state.assets.get(m[1]!);
      if (bytes === undefined) return problem(404, 'not_found', '没有资源');
      response.writeHead(200, { 'content-type': 'model/gltf-binary' });
      response.end(bytes);
      return;
    }
    if ((m = /^\/api\/v1\/spaces\/[^/]+\/jobs\/([^/]+)$/.exec(apiPath))) {
      const job = state.jobs.get(m[1]!);
      if (job === undefined) return problem(404, 'not_found', '没有任务');
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
    // 上传：{范围}/uploads/{purpose}[/{id}/parts/{n} | /{id}/complete]
    if (
      (m =
        /^(\/api\/v1\/spaces\/[^/]+(?:\/plots\/[^/]+)?)\/uploads\/([a-z]+)(?:\/([^/]+)(\/parts\/(\d+)|\/complete))?$/.exec(
          apiPath,
        ))
    ) {
      const [, scopePath, purpose, uploadId, tail, n] = m;
      if (scopePath!.includes('/plots/') && purpose === 'scan')
        return problem(403, 'forbidden', '地块路径下不能上传扫描');
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
        return json(reused ? 200 : 201, view);
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
        const job = newJob(
          'upload_verify',
          sha === upload.sha256 ? {} : { fail: '整体哈希不一致' },
        );
        if (sha === upload.sha256) {
          state.assets.set(sha, all);
          upload.status = 'done';
        }
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ uploadId: upload.id, status: 'complete', jobId: job.id }));
        return;
      }
    }
    if (apiPath === `${space}/scans` && request.method === 'POST') {
      const req = parsed();
      // ImportScanRequest 没有 transform（带变换的导入走 alignment）。
      if (
        invalidFields(
          req,
          ['assetHash', 'observedAt', 'rebuild', 'voxelize', 'hints'],
          ['assetHash'],
        )
      )
        return;
      if (!state.assets.has(String(req.assetHash)))
        return problem(404, 'not_found', '没有这个资源');
      const job = newJob('scan_import', {
        result: state.scanResult ?? {},
        resultCommitId: 'commit-9',
        runningPolls: 2,
      });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jobId: job.id }));
      return;
    }
    if (
      (m = /^\/api\/v1\/spaces\/[^/]+\/scans\/([0-9a-f]{64})\/(voxelize|alignment)$/.exec(apiPath))
    ) {
      const req = parsed();
      if (m[2] === 'voxelize') {
        if (invalidFields(req, ['style'])) return;
        return json(202, { jobId: newJob('voxelize').id });
      }
      if (
        invalidFields(
          req,
          ['transform', 'observedAt', 'rebuild', 'voxelize', 'hints'],
          ['transform'],
        )
      )
        return;
      if (!Array.isArray(req.transform) || req.transform.length !== 16)
        return problem(422, 'invalid_transform', 'transform 必须是 16 个数');
      // 只要求资源已校验（不要求扫描已经提交过）。
      if (!state.assets.has(m[1]!)) return problem(422, 'asset_not_found', '没有这个资源');
      const job = newJob('scan_import', {
        result: state.scanResult ?? {},
        resultCommitId: 'commit-9',
      });
      return json(202, { id: job.id, kind: job.kind, status: 'queued' });
    }
    // 草稿：{范围}/drafts[/{id}/(ops|ops-from-upload|preview|publish)]
    if (
      (m =
        /^(\/api\/v1\/spaces\/[^/]+(?:\/plots\/[^/]+)?)\/drafts(?:\/([^/]+)\/(ops|ops-from-upload|preview|publish))?$/.exec(
          apiPath,
        ))
    ) {
      const [, scopePath, draftId, action] = m;
      if (draftId === undefined && request.method === 'POST') {
        const req = parsed();
        // CreateDraftRequest 只有 baseSeq（提交说明在发布时给）。
        if (invalidFields(req, ['baseSeq'])) return;
        const id = nextId('draft');
        state.drafts.set(id, { scopePath: scopePath!, baseSeq: Number(req.baseSeq), ops: [] });
        return json(201, {
          id,
          scope: scopePath!.includes('/plots/') ? 'plot' : 'physical',
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
          const job = newJob('ops_from_upload', { result: { applied: ops.length, rev: 1 } });
          return json(202, { jobId: job.id });
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
          if (state.publishConflict) {
            return problem(409, 'draft_conflict', '时间线已前进，与草稿冲突', {
              conflicts: { entities: ['table-1'] },
            });
          }
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
      if (tail === '/share-tokens')
        return json(201, { shareToken: { id: 'st_2', token: 'share-secret-2' } });
      if (tail === '/layout' && request.method === 'PUT') return json(200, { seq: 7 });
      if (tail === '/event-types') return json(201, { type: parsed().type, version: 1 });
      if (tail.endsWith('/redact')) return json(200, { redacted: true });
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
