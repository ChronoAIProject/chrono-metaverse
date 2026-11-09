// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 网站镜像的 nginx 配置（web/nginx.conf）和接口服务的路由要对得上：
 * 接口服务只在 `/api/` 下提供接口（包括 `/api/openapi.json`、`/api/healthz`），
 * 根路径下没有任何接口，所以只有 `/api/` 一处转发，并且原样转发路径。
 */

const conf = readFileSync(fileURLToPath(new URL('../nginx.conf', import.meta.url)), 'utf8');

interface LocationBlock {
  readonly match: string;
  readonly body: string;
}

/** 取出全部 location 块（本配置里的 location 没有嵌套的花括号）。去掉注释后再解析。 */
function locations(text: string): LocationBlock[] {
  const code = text
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
  return [...code.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)].map((m) => ({
    match: m[1]!.trim(),
    body: m[2]!,
  }));
}

describe('nginx 配置', () => {
  const blocks = locations(conf);

  it('只有 /api/ 一处转发给接口服务，并且不改写路径（/api/openapi.json 原样到达）', () => {
    const proxied = blocks.filter((block) => /\bproxy_pass\b/.test(block.body));
    expect(proxied.map((block) => block.match)).toEqual(['/api/']);
    const target = /proxy_pass\s+([^;\s]+)\s*;/.exec(proxied[0]!.body)![1]!;
    // 只有主机和端口、不带路径：nginx 才会把 /api/openapi.json 原样转给接口服务。
    expect(target).toBe('http://metaverse-api:8080');
  });

  it('不再单独转发根路径的 /openapi.json（接口服务没有这个地址，只会得到 404）', () => {
    expect(blocks.some((block) => block.match.includes('/openapi.json'))).toBe(false);
    expect(conf).not.toMatch(/location\s*=\s*\/openapi\.json/);
  });

  it('网站自己的健康检查和单页应用兜底还在', () => {
    const health = blocks.find((block) => block.match === '= /healthz');
    expect(health?.body).toMatch(/return\s+200/);
    const fallback = blocks.find((block) => block.match === '/');
    expect(fallback?.body).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/);
  });

  it('解析器能认出被删掉的那种写法（防止上面的断言空转）', () => {
    const old = 'location = /openapi.json {\n  proxy_pass http://metaverse-api:8080;\n}\n';
    expect(locations(old)).toEqual([
      { match: '= /openapi.json', body: '\n  proxy_pass http://metaverse-api:8080;\n' },
    ]);
  });
});
