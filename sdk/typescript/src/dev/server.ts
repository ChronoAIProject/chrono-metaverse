import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSha256Hex } from '../core/hash.js';
import { entityRecordHash, type AnchorBody } from '../core/record.js';
import type { BuildManifest } from '../workspace/build.js';
import { chunkFile, paths, readBase, type BaseState } from '../workspace/files.js';

/**
 * 本地查看器（`metaverse dev`）：起一个本地 HTTP 服务，按公开读接口的路径和 JSON 形状
 * （web/src/core/api/types.ts）提供"拉取的基础状态 + 本地建造结果"，同时托管网站的构建产物
 * （web/dist）。页面就是线上网站的同一套代码。
 *
 * - 时间线上有两次提交：拉取的基础版本（seq = 基础 seq）和本地建造结果（seq 每次重建加 1，
 *   查看器按 seq 缓存场景，换 seq 才会重新加载）；
 * - 网站的"现在"模式每 5 秒查一次 /head，脚本改了自动重建，页面随后刷新；
 * - 事件接口返回空列表；锚点只给公开级（和预览一致）。
 */

export interface DevServerOptions {
  readonly root: string;
  readonly spaceId: string;
  /** 网站构建产物目录；null 时只提供接口，页面显示一段说明。 */
  readonly webDist: string | null;
  readonly host?: string;
  readonly port?: number;
  /** 重建：运行建造脚本并返回清单（失败时抛出异常，保留上一次的结果）。 */
  readonly rebuild: () => Promise<BuildManifest>;
  /** 监视建造脚本和基础状态，改了自动重建。 */
  readonly watch?: boolean;
  /** 锚点也显示内部级。 */
  readonly includeInternal?: boolean;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

export interface DevServer {
  readonly url: string;
  readonly port: number;
  /** 当前版本号（每次成功重建加 1）。 */
  version(): number;
  lastError(): string | null;
  rebuild(): Promise<void>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

/** 在仓库里找网站构建产物：从 SDK 所在位置往上找 web/dist/index.html。 */
export function findWebDist(
  start: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'web', 'dist');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface ViewState {
  base: BaseState;
  manifest: BuildManifest | null;
  version: number;
  builtAt: number;
  error: string | null;
}

function publicAnchors(anchors: readonly AnchorBody[], includeInternal: boolean): AnchorBody[] {
  return anchors.filter((a) => includeInternal || a.visibility === 'public');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const includeInternal = options.includeInternal ?? false;
  const view: ViewState = {
    base: readBase(options.root, options.spaceId),
    manifest: null,
    version: 0,
    builtAt: now(),
    error: null,
  };

  let running: Promise<void> | null = null;
  let queued = false;
  async function doRebuild(): Promise<void> {
    try {
      view.base = readBase(options.root, options.spaceId);
      const manifest = await options.rebuild();
      view.manifest = manifest;
      view.version += 1;
      view.builtAt = now();
      view.error = null;
      log(
        `已重建（版本 ${view.version}）：${manifest.opCount} 条操作，变化区块 ${manifest.chunkChanges.length}，物件 ${manifest.entityChanges.length}，锚点 ${manifest.anchorChanges.length}` +
          (manifest.outside.length > 0
            ? `；注意有 ${manifest.outside.length} 条超出 ${manifest.scope}`
            : ''),
      );
    } catch (error) {
      view.error = error instanceof Error ? error.message : String(error);
      log(`重建失败（页面保留上一次的结果）：${view.error}`);
    }
  }
  function rebuild(): Promise<void> {
    if (running !== null) {
      queued = true;
      return running;
    }
    running = doRebuild().finally(() => {
      running = null;
      if (queued) {
        queued = false;
        void rebuild();
      }
    });
    return running;
  }
  await rebuild();

  const baseSeq = () => view.base.space.seq;
  const localSeq = () => baseSeq() + Math.max(view.version, 1);
  const localAt = () => view.builtAt;
  const baseAt = () => Math.min(Date.parse(view.base.space.at) || 0, localAt() - 1000);

  function spaceInfo() {
    const space = view.base.space;
    const anchors = view.manifest?.final.anchors ?? view.base.anchors;
    return {
      id: space.spaceId,
      name: `${space.name}（本地预览）`,
      description: space.description ?? '',
      visibility: space.visibility ?? 'unlisted',
      regions: space.regions,
      plots: space.plots,
      anchors: publicAnchors(anchors, includeInternal),
      head: { seq: localSeq(), at: iso(localAt()), recordedAt: null },
      eventTypes: [],
    };
  }

  function commits() {
    const items = [];
    if (baseSeq() > 0) {
      items.push({
        seq: baseSeq(),
        at: iso(baseAt()),
        message: `拉取的基础版本（seq ${baseSeq()}）`,
        actor: { kind: 'physical' },
      });
    }
    items.push({
      seq: localSeq(),
      at: iso(localAt()),
      message: view.manifest?.message ?? '本地建造结果（未推送）',
      actor: { kind: view.manifest?.scope.startsWith('plot:') ? 'plot' : 'physical' },
      changedChunks: view.manifest?.chunkChanges ?? [],
      changedEntities: view.manifest?.entityChanges ?? [],
      changedAnchors: view.manifest?.anchorChanges ?? [],
    });
    return items;
  }

  function snapshot(seq: number) {
    const base = view.base;
    const space = base.space;
    const local = seq !== baseSeq() || baseSeq() === 0;
    const manifest = local ? view.manifest : null;
    const entities = manifest?.final.entities ?? base.entities;
    return {
      spaceId: space.spaceId,
      seq: local ? localSeq() : baseSeq(),
      at: iso(local ? localAt() : baseAt()),
      ...(space.paletteHash !== undefined ? { paletteHash: space.paletteHash } : {}),
      palette: { blocks: manifest?.final.palette ?? base.palette.blocks },
      chunks: manifest?.final.chunks ?? base.chunks,
      entities: entities.map((body) => ({
        id: body.entityId,
        hash: entityRecordHash(space.spaceId, body),
        body,
      })),
      anchors: publicAnchors(manifest?.final.anchors ?? base.anchors, includeInternal),
      regions: space.regions,
      plots: space.plots,
      scan: space.scan ?? null,
    };
  }

  function send(
    response: ServerResponse,
    status: number,
    body: string | Uint8Array,
    headers: Record<string, string>,
  ) {
    response.writeHead(status, { 'cache-control': 'no-store', ...headers });
    response.end(body);
  }

  function json(
    response: ServerResponse,
    status: number,
    value: unknown,
    headers: Record<string, string> = {},
  ) {
    send(response, status, JSON.stringify(value), {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    });
  }

  function problem(response: ServerResponse, status: number, code: string, detail: string) {
    json(
      response,
      status,
      { type: 'about:blank', title: code, status, code, detail },
      {
        'content-type': 'application/problem+json',
      },
    );
  }

  function file(response: ServerResponse, path: string, type?: string) {
    send(response, 200, readFileSync(path), {
      'content-type': type ?? MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    });
  }

  function assetFile(hash: string): string | null {
    if (!isSha256Hex(hash)) return null;
    const dir = paths(options.root).assets;
    for (const name of [`${hash}.bin`, `${hash}.glb`, `${hash}.jpg`, `${hash}.png`, hash]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  function serveApi(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const path = url.pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      problem(response, 405, 'read_only', '本地查看器只读');
      return;
    }
    const chunk = /^\/api\/public\/(?:previews\/)?chunks\/([0-9a-f]{64})(?:\.bin)?$/.exec(path);
    if (chunk) {
      const found = chunkFile(options.root, chunk[1]!);
      if (found === null) problem(response, 404, 'not_found', '工作区里没有这个区块');
      else file(response, found, 'application/octet-stream');
      return;
    }
    const asset = /^\/api\/public\/(?:previews\/)?assets\/([0-9a-f]{64})(?:\.bin)?$/.exec(path);
    if (asset) {
      const found = assetFile(asset[1]!);
      if (found === null)
        problem(response, 404, 'not_found', '工作区 assets/ 里没有这个资源（pull 时没有下载到）');
      else file(response, found, 'model/gltf-binary');
      return;
    }
    if (path === '/api/public/previews') {
      json(response, 200, snapshot(localSeq()));
      return;
    }
    const match = /^\/api\/public\/spaces\/([^/]+)(\/.*)?$/.exec(path);
    if (match === null || decodeURIComponent(match[1]!) !== options.spaceId) {
      problem(response, 404, 'not_found', `本地查看器只提供空间 ${options.spaceId}`);
      return;
    }
    const rest = match[2] ?? '';
    switch (rest) {
      case '':
        json(response, 200, spaceInfo());
        return;
      case '/head': {
        const etag = `"${localSeq()}"`;
        if (request.headers['if-none-match'] === etag) {
          send(response, 304, '', { etag });
          return;
        }
        json(response, 200, { seq: localSeq(), at: iso(localAt()), recordedAt: null }, { etag });
        return;
      }
      case '/timeline':
        json(response, 200, { items: commits(), nextAfter: null });
        return;
      case '/snapshot': {
        let seq = Number(url.searchParams.get('seq') ?? localSeq());
        const at = url.searchParams.get('at');
        if (at !== null) {
          const t = Date.parse(at);
          if (t < baseAt() && baseSeq() === 0) {
            problem(response, 404, 'no_commit', '这个时刻之前还没有任何提交');
            return;
          }
          seq = t >= localAt() ? localSeq() : baseSeq();
        }
        json(response, 200, snapshot(seq));
        return;
      }
      case '/events':
        json(response, 200, { items: [], nextAfter: null });
        return;
      case '/events/density':
        json(response, 200, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          bucketSec: Number(url.searchParams.get('bucket') ?? 60),
          buckets: [],
        });
        return;
      case '/state':
        json(response, 200, { at: url.searchParams.get('at') ?? iso(now()), states: [] });
        return;
      default:
        problem(response, 404, 'not_found', `没有这个接口：${path}`);
    }
  }

  const NO_WEB = `<!doctype html><meta charset="utf-8"><title>metaverse dev</title>
<body style="font-family:sans-serif;max-width:40em;margin:4em auto;line-height:1.6">
<h1>找不到网站的构建产物</h1>
<p>本地查看器需要网站（web/）的构建产物。在平台仓库里运行：</p>
<pre>cd web &amp;&amp; npm ci &amp;&amp; npm run build</pre>
<p>然后用 <code>metaverse dev --web-dist &lt;仓库&gt;/web/dist</code> 重新启动，或在 metaverse.json 里写 <code>"webDist"</code>。</p>
<p>接口已经可以用：<a href="/api/public/spaces/${options.spaceId}">/api/public/spaces/${options.spaceId}</a></p>
</body>`;

  function serveStatic(response: ServerResponse, url: URL): void {
    if (options.webDist === null) {
      send(response, 200, NO_WEB, { 'content-type': 'text/html; charset=utf-8' });
      return;
    }
    const root = resolve(options.webDist);
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      decoded = '/';
    }
    const candidate = normalize(join(root, decoded));
    if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile()) {
      file(response, candidate);
      return;
    }
    // 页面路由（/s/<空间编号> 等）一律回到 index.html。
    file(response, join(root, 'index.html'));
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/__metaverse/status') {
        json(response, 200, {
          spaceId: options.spaceId,
          version: view.version,
          seq: localSeq(),
          builtAt: iso(view.builtAt),
          error: view.error,
          outside: view.manifest?.outside.length ?? 0,
        });
      } else if (url.pathname.startsWith('/api/')) {
        serveApi(request, response, url);
      } else {
        serveStatic(response, url);
      }
    } catch (error) {
      problem(response, 500, 'internal', (error as Error).message);
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;

  const watchers: FSWatcher[] = [];
  if (options.watch) {
    let timer: NodeJS.Timeout | null = null;
    const trigger = (reason: string) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        log(`检测到改动（${reason}），重新建造……`);
        void rebuild();
      }, 200);
    };
    const p = paths(options.root);
    if (existsSync(p.build)) {
      watchers.push(
        watch(p.build, { recursive: true }, (_event, name) => trigger(`build/${name ?? ''}`)),
      );
    }
    watchers.push(
      watch(options.root, (_event, name) => {
        if (
          name &&
          ['space.json', 'palette.json', 'anchors.json', 'entities.json'].includes(name)
        ) {
          trigger(name);
        }
      }),
    );
  }

  return {
    url,
    port: address.port,
    version: () => view.version,
    lastError: () => view.error,
    rebuild,
    async close() {
      watchers.forEach((w) => w.close());
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}
