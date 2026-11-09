import type { Plugin } from 'vite';
import { fixtureReply } from '../src/fixtures/server';

/*
 * `npm run dev:fixtures` —— 开发服务器按 src/fixtures 回答 `/api/public/*`，
 * 不需要接口服务、数据库和真实扫描就能查看页面。照搬 CMA web/build/devFixtures.ts 的结构：
 * 只在 `vite serve --mode fixtures` 下加载；生产构建、单元测试和普通 `npm run dev` 都不会加载。
 *
 * 没有夹具的读请求返回带类型的 404 并记一次日志；写请求一律拒绝。
 * `POST /__fixtures/emit?kind=event|commit|delivery` 模拟"现在"发生的事（端到端测试用），
 * `POST /__fixtures/reset` 重新生成夹具。
 *
 * 夹具链接：
 * - 空间：/s/demo-lobby#share=fixture-share-token-0123456789abcdef
 * - 组合：/u/demo-street#share=fixture-universe-token-00112233445566778899
 * - 预览：/preview#t=fixture-preview-token-aabbccddeeff00112233445566778899
 */
export function devFixtures(): Plugin {
  return {
    name: 'metaverse-dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      const { logger } = server.config;
      const reported = new Set<string>();
      logger.info('  夹具模式：/api/public 由 src/fixtures 回答。');
      logger.info('  空间 /s/demo-lobby#share=fixture-share-token-0123456789abcdef');
      logger.info('  组合 /u/demo-street#share=fixture-universe-token-00112233445566778899');
      logger.info('  预览 /preview#t=fixture-preview-token-aabbccddeeff00112233445566778899');
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
