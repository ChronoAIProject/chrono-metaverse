import type { Plugin } from 'vite';
import { fixtureReply } from '../src/fixtures/server';

/*
 * `npm run dev:fixtures` —— 开发服务器按 src/fixtures 回答 `/api/public/*`，
 * 不需要接口服务、数据库和真实扫描就能查看页面。照搬 CMA web/build/devFixtures.ts 的结构：
 * 只在 `vite serve --mode fixtures` 下加载；生产构建、单元测试和普通 `npm run dev` 都不会加载。
 *
 * 没有夹具的读请求返回带类型的 404 并记一次日志；写请求一律拒绝。
 * 夹具空间的链接：/s/demo-lobby#share=fixture-share-token-0123456789abcdef
 */
export function devFixtures(): Plugin {
  return {
    name: 'metaverse-dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      const { logger } = server.config;
      const reported = new Set<string>();
      logger.info('  夹具模式：/api/public 由 src/fixtures 回答。');
      logger.info('  打开 /s/demo-lobby#share=fixture-share-token-0123456789abcdef');
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://fixtures.invalid');
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        const reply = fixtureReply(request.method ?? 'GET', url.pathname, url.search, headers);
        if (reply === undefined) return next();
        const key = `${reply.status} ${request.method} ${url.pathname}`;
        if (reply.status >= 400 && !reported.has(key)) {
          reported.add(key);
          logger.warn(`  [夹具] ${key}`);
        }
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body ?? undefined);
      });
    },
  };
}
