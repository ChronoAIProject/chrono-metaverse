import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployment, deploy } from './deploy.mjs';

const sha = 'a'.repeat(40);
const digests = { api: `sha256:${'b'.repeat(64)}`, web: `sha256:${'c'.repeat(64)}` };
const owner = '52aa284c-b5b2-49bd-9d12-79f24772dbd7';

test('环境不能交叉部署，短期分支和不完整构建被拒绝', () => {
  for (const [ref, env] of [['dev', 'production'], ['main', 'staging'], ['feat/chat', 'staging'], ['refs/tags/main', 'production']]) {
    assert.throws(() => deployment(ref, env, sha, digests), /不匹配/);
  }
  assert.throws(() => deployment('dev', 'staging', sha.slice(0, 7), digests), /完整提交/);
  assert.throws(() => deployment('dev', 'staging', sha, { api: digests.api }), /同时提供/);
  assert.throws(() => deployment('dev', 'staging', sha, { ...digests, web: 'latest' }), /摘要不合法/);
  const prod = deployment('refs/heads/main', 'production', sha, digests);
  assert.equal(prod.app, 'chrono-metaverse-prod');
  assert.deepEqual(Object.keys(prod.services).sort(), ['metaverse-prod-api', 'metaverse-prod-web']);
});

function fixture({ conflict = false, concurrent = false, failed = false } = {}) {
  const calls = [];
  const target = deployment('dev', 'staging', sha, digests);
  let patched = false;
  const current = { name: target.app, owner, generation: 27, revision: 28,
    url: 'https://example.invalid', spec: { services: target.services, addons: { mongodb: {} } } };
  const request = async (url, options) => {
    calls.push({ url, ...options });
    let data;
    let status = 200;
    if (options.method === 'PATCH') {
      if (conflict) status = 409;
      patched = true;
      data = { ...current, generation: 28, revision: 29 };
    } else if (url.includes('/status?')) data = { phase: failed ? 'degraded' : 'ready' };
    else data = { ...current, generation: patched ? (concurrent ? 29 : 28) : 27 };
    return new Response(JSON.stringify(data), { status });
  };
  return { calls, request };
}
const options = { ref: 'refs/heads/dev', environment: 'staging', sha, digests, key: 'test-key' };

test('只按本次构建摘要更新镜像，携带乐观锁并核对部署结果', async () => {
  const mock = fixture();
  const result = await deploy(options, mock);
  assert.equal(result.generation, 28);
  const write = mock.calls.find((call) => call.method === 'PATCH');
  assert.equal(write.headers['If-Match'], '27');
  assert.deepEqual(JSON.parse(write.body), { services: deployment('dev', 'staging', sha, digests).services });
  assert.ok(mock.calls.every((call) => call.url.includes('/chrono-metaverse?') || call.url.includes('/chrono-metaverse/status?')));
});

test('并发修改、应用失败和拒绝写入均让部署失败，不重放写入', async () => {
  for (const config of [{ conflict: true }, { concurrent: true }, { failed: true }]) {
    const mock = fixture(config);
    await assert.rejects(deploy(options, mock));
    assert.equal(mock.calls.filter((call) => call.method === 'PATCH').length, 1);
  }
});
