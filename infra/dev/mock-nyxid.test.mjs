// 模拟 NyxID 的测试：node --test infra/dev/
// 核对签发的令牌与接口服务的验签要求一致（api/crates/metaverse-api/src/auth/jwt.rs）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockNyxid, AUDIENCE, SERVICE_ID, DEFAULT_ROLES_PATH, loadIdentities, loadRoles } from './mock-nyxid.mjs';

let mock;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mock-nyxid-'));
  const roles = join(dir, 'roles.json');
  await writeFile(
    roles,
    JSON.stringify({
      orgs: { chronoai: { alice: 'admin', bob: 'member', rita: 'admin' } },
      permissions: { rita: ['metaverse:rebuild:write'] },
    }),
  );
  mock = await startMockNyxid({ port: 0, rolesPath: roles });
});

after(async () => {
  await mock?.close();
  await rm(dir, { recursive: true, force: true });
});

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

async function token(body) {
  const response = await fetch(`${mock.url}/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function jwks() {
  const response = await fetch(`${mock.url}/.well-known/jwks.json`);
  return (await response.json()).keys;
}

async function verifySignature(jwt) {
  const [header, claims, signature] = jwt.split('.');
  const { kid } = decode(header);
  const jwk = (await jwks()).find((key) => key.kid === kid);
  assert.ok(jwk, '公钥列表里有这个 kid');
  const publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  return verify('sha256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'));
}

async function authorization(org, accessToken) {
  const response = await fetch(`${mock.url}/api/v1/orgs/${org}/authorization`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

test('OpenID 配置与公钥列表符合接口服务的要求', async () => {
  const config = await (await fetch(`${mock.url}/.well-known/openid-configuration`)).json();
  assert.equal(config.issuer, mock.url);
  assert.match(config.issuer, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(config.jwks_uri, `${mock.url}/.well-known/jwks.json`);
  const keys = await jwks();
  assert.equal(keys.length, 1);
  const [key] = keys;
  assert.equal(key.kty, 'RSA');
  assert.equal(key.alg, 'RS256');
  assert.equal(key.use, 'sig');
  assert.equal(key.key_ops, undefined);
  // 2048 位模数 = 256 字节；接口服务要求 256–1024 字节且首字节不为 0。
  const modulus = Buffer.from(key.n, 'base64url');
  assert.equal(modulus.length, 256);
  assert.notEqual(modulus[0], 0);
});

test('身份令牌：头部和声明与验签要求逐项一致', async () => {
  const { status, body } = await token({ sub: 'alice' });
  assert.equal(status, 200);
  const [header, claims] = body.identityToken.split('.').map((part, i) => (i < 2 ? decode(part) : part));
  assert.deepEqual(Object.keys(header).sort(), ['alg', 'kid', 'typ']);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');
  // 接口服务的 Claims 是 deny_unknown_fields：只能出现这些字段，不能有 token_type。
  const allowed = ['sub', 'iss', 'aud', 'exp', 'iat', 'jti', 'nyx_service_id', 'permissions', 'nbf', 'email', 'name', 'roles', 'groups'];
  for (const name of Object.keys(claims)) assert.ok(allowed.includes(name), `多余字段 ${name}`);
  assert.equal(claims.token_type, undefined);
  assert.equal(claims.sub, 'alice');
  assert.equal(claims.iss, mock.url);
  assert.equal(claims.aud, AUDIENCE);
  assert.equal(typeof claims.aud, 'string');
  assert.equal(claims.nyx_service_id, SERVICE_ID);
  assert.deepEqual(claims.permissions, []);
  assert.ok(claims.exp - claims.iat <= 60 && claims.exp > claims.iat);
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
  assert.ok(await verifySignature(body.identityToken));
});

test('每次签发都是新的 jti；权限字符串原样带上', async () => {
  const first = await token({ sub: 'alice' });
  const second = await token({ sub: 'alice', permissions: ['metaverse:space:create'] });
  const jti = (jwt) => decode(jwt.split('.')[1]).jti;
  assert.notEqual(jti(first.body.identityToken), jti(second.body.identityToken));
  assert.deepEqual(decode(second.body.identityToken.split('.')[1]).permissions, ['metaverse:space:create']);
});

test('不带 permissions 时按角色文件给权限（重建身份 rita），请求里写了就以请求为准', async () => {
  const claims = async (body) => decode((await token(body)).body.identityToken.split('.')[1]);
  assert.deepEqual((await claims({ sub: 'rita' })).permissions, ['metaverse:rebuild:write']);
  assert.deepEqual((await claims({ sub: 'alice' })).permissions, []);
  assert.deepEqual((await claims({ sub: 'rita', permissions: [] })).permissions, []);
  assert.deepEqual((await claims({ sub: 'bob', permissions: ['metaverse:rebuild:write'] })).permissions, [
    'metaverse:rebuild:write',
  ]);
});

test('仓库里的角色文件：rita 是带重建权限的组织 admin，alice 是没有重建权限的组织 admin', async () => {
  const { orgs, permissions } = await loadIdentities(DEFAULT_ROLES_PATH);
  assert.equal(orgs.chronoai.rita, 'admin');
  assert.equal(orgs.chronoai.alice, 'admin');
  assert.deepEqual(permissions.rita, ['metaverse:rebuild:write']);
  assert.equal(permissions.alice, undefined);
  assert.equal(permissions.bob, undefined);
  // README 写的是同一组身份。
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'README.md'), 'utf8');
  assert.match(readme, /rita/);
});

test('访问令牌：同一把密钥、token_type = access、同一个 sub', async () => {
  const { body } = await token({ sub: 'bob' });
  const [header, claims] = body.accessToken.split('.').slice(0, 2).map(decode);
  assert.deepEqual(Object.keys(header).sort(), ['alg', 'kid', 'typ']);
  assert.equal(claims.token_type, 'access');
  assert.equal(claims.sub, 'bob');
  assert.equal(claims.iss, mock.url);
  assert.ok(claims.exp > Date.now() / 1000 + 60);
  assert.ok(await verifySignature(body.accessToken));
});

test('组织授权：按角色文件返回，非成员 404，凭据无效 401', async () => {
  const alice = (await token({ sub: 'alice' })).body.accessToken;
  const bob = (await token({ sub: 'bob' })).body.accessToken;
  const dave = (await token({ sub: 'dave' })).body.accessToken;
  let reply = await authorization('chronoai', alice);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.id, 'chronoai');
  assert.equal(reply.body.your_role, 'admin');
  reply = await authorization('chronoai', bob);
  assert.equal(reply.body.your_role, 'member');
  assert.equal((await authorization('chronoai', dave)).status, 404);
  assert.equal((await authorization('other-org', alice)).status, 404);
  assert.equal((await authorization('chronoai', undefined)).status, 401);
  // 身份令牌不能当访问令牌用。
  const identity = (await token({ sub: 'alice' })).body.identityToken;
  assert.equal((await authorization('chronoai', identity)).status, 401);
  // 篡改过的令牌。
  const [h, , s] = alice.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'dave', token_type: 'access' })).toString('base64url')}.${s}`;
  assert.equal((await authorization('chronoai', forged)).status, 401);
});

test('orgRole 覆盖角色文件，可以只对一个组织生效', async () => {
  const viewer = (await token({ sub: 'dave', orgRole: 'viewer' })).body.accessToken;
  assert.equal((await authorization('chronoai', viewer)).body.your_role, 'viewer');
  assert.equal((await authorization('any-org', viewer)).body.your_role, 'viewer');
  const none = (await token({ sub: 'alice', orgRole: 'none' })).body.accessToken;
  assert.equal((await authorization('chronoai', none)).status, 404);
  const scoped = (await token({ sub: 'dave', orgRole: 'admin', org: 'restaurant-org' })).body.accessToken;
  assert.equal((await authorization('restaurant-org', scoped)).body.your_role, 'admin');
  assert.equal((await authorization('chronoai', scoped)).status, 404);
});

test('非法请求返回 400', async () => {
  for (const body of [{}, { sub: 'a b' }, { sub: 'x', orgRole: 'owner' }, { sub: 'x', permissions: 'all' }, { sub: 'x', org: 'a/b', orgRole: 'admin' }]) {
    assert.equal((await token(body)).status, 400, JSON.stringify(body));
  }
});

test('角色文件格式错误时拒绝加载', async () => {
  const bad = join(dir, 'bad.json');
  await writeFile(bad, JSON.stringify({ orgs: { chronoai: { alice: 'owner' } } }));
  await assert.rejects(loadRoles(bad), /admin、member 或 viewer/);
  await writeFile(bad, JSON.stringify({ chronoai: {} }));
  await assert.rejects(loadRoles(bad), /缺少 orgs/);
  await writeFile(bad, JSON.stringify({ orgs: {}, permissions: ['metaverse:rebuild:write'] }));
  await assert.rejects(loadIdentities(bad), /permissions 必须是对象/);
  await writeFile(bad, JSON.stringify({ orgs: {}, permissions: { rita: 'metaverse:rebuild:write' } }));
  await assert.rejects(loadIdentities(bad), /permissions\.rita 必须是权限字符串数组/);
});
