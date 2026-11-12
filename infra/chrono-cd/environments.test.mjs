// 防止正式版误连测试版的接口、登录配置或密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkApp } from './check-app.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

test('正式规格复用完整校验，并隔离服务、登录、数据库与 nginx 上游', () => {
  const staging = load('app.json');
  const production = load('app.production.json');
  assert.deepEqual(Object.keys(production.services).sort(), ['metaverse-prod-api', 'metaverse-prod-web']);
  const normalized = structuredClone(production);
  normalized.services = Object.fromEntries(Object.entries(production.services).map(([name, value]) => [name.replace('metaverse-prod-', 'metaverse-'), value]));
  const readme = readFileSync(new URL('README.md', import.meta.url), 'utf8');
  const seed = readFileSync(new URL('demo-seed.json', import.meta.url), 'utf8');
  assert.deepEqual(checkApp(normalized, { readme, seed }), []);
  const prodApi = production.services['metaverse-prod-api'];
  const stageApi = staging.services['metaverse-api'];
  for (const key of ['PUBLIC_BASE_URL', 'NYXID_OAUTH_CLIENT_ID', 'NYXID_JWT_AUDIENCE', 'ALLOWED_NYX_SERVICE_IDS']) {
    assert.notEqual(prodApi.env[key], stageApi.env[key], key);
  }
  assert.deepEqual(production.addons.mongodb, {});
  assert.deepEqual(prodApi.addon_env.mongodb, { uri: 'MONGODB_URI', database: 'MONGODB_DATABASE' });
  assert.equal(prodApi.env.MONGODB_URI, undefined);
  for (const key of prodApi.secret_keys) assert.equal(prodApi.env[key], undefined);
  const nginx = production.services['metaverse-prod-web'].files.find((file) => file.path === '/etc/nginx/conf.d/default.conf');
  assert.ok(nginx);
  assert.match(nginx.content, /proxy_pass http:\/\/metaverse-prod-api:8080;/);
  assert.doesNotMatch(nginx.content, /http:\/\/metaverse-api:/);
});
