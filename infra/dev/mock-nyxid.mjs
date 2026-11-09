#!/usr/bin/env node
// 本地开发用的模拟 NyxID（Node 22，无第三方依赖）。只用于本机，绝不能部署或对外监听。
//
// 接口（共同约定第 6 条）：
//   GET  /.well-known/openid-configuration   签发方、公钥列表地址
//   GET  /.well-known/jwks.json              公钥列表（启动时生成的 RSA 密钥，只在内存里）
//   GET  /api/v1/orgs/{id}/authorization     组织角色查询：Authorization: Bearer <accessToken>
//   POST /dev/token                          {sub, orgRole?, org?, permissions?}
//                                            → {identityToken, accessToken, ...}，每次一个新的 jti
//   GET  /healthz                            启动检查用
//
// 身份令牌与接口服务的验签要求一致（api/crates/metaverse-api/src/auth/jwt.rs）：
//   头部只有 {alg: RS256, typ: JWT, kid}；声明只有 sub、iss、aud（字符串）、iat、exp（= iat + 60）、
//   jti、nyx_service_id（固定 dev-service）、permissions、roles、groups，不带 token_type。
// 访问令牌是同一把密钥签的 JWT，带 token_type = access 和同一个 sub，接口服务查组织角色前会
//   验签并核对 sub（auth/organizations.rs），然后原样转给这里的组织授权接口。
//
// 组织角色来自 JSON 文件（默认 infra/dev/org-roles.json，每次查询时重新读取，改了不用重启）：
//   {"orgs": {"chronoai": {"alice": "admin", "bob": "member", "carol": "viewer"}}}
// /dev/token 带 orgRole 时，这个访问令牌查任何组织（或只查 org 指定的那个）都返回该角色，
//   orgRole = "none" 表示不是成员；不带时按文件查。
//
// 用法：node infra/dev/mock-nyxid.mjs [--port 8090] [--host 127.0.0.1] [--roles <文件>]
// 也可用环境变量 MOCK_NYXID_PORT、MOCK_NYXID_HOST、MOCK_NYXID_ROLES。

import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export const SERVICE_ID = 'dev-service';
export const AUDIENCE = 'urn:chrono-metaverse:api';
export const IDENTITY_LIFETIME_SECONDS = 60;
export const ACCESS_LIFETIME_SECONDS = 3600;
const ROLES = new Set(['admin', 'member', 'viewer']);
// 与接口服务的编号规则一致（metaverse-core ids::is_subject_id）。
const SUBJECT_ID = /^[A-Za-z0-9_-]{1,256}$/;
const PERMISSION = /^[^\s\p{Cc}]{1,256}$/u;
const MAX_BODY_BYTES = 16 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROLES_PATH = resolve(here, 'org-roles.json');

const b64url = (value) => Buffer.from(value).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

/** 生成一把只在内存里的 RS256 密钥。kid 每次启动都不同，接口服务遇到未知 kid 会自己刷新公钥列表。 */
function createKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `dev-${randomBytes(6).toString('hex')}`;
  const { n, e } = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, publicKey, jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n, e } };
}

function signJwt(key, claims) {
  const signed = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(signed), key.privateKey);
  return `${signed}.${signature.toString('base64url')}`;
}

/** 校验本模拟服务自己签发的 JWT，返回声明；不合法返回 null。 */
function verifyJwt(key, token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || header.kid !== key.kid) return null;
    const ok = verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key.publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!ok) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 读组织角色文件：{"orgs": {"<组织编号>": {"<sub>": "admin" | "member" | "viewer"}}}。 */
export async function loadRoles(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const orgs = parsed?.orgs;
  if (typeof orgs !== 'object' || orgs === null || Array.isArray(orgs)) {
    throw new Error(`${path}：缺少 orgs 对象`);
  }
  for (const [org, members] of Object.entries(orgs)) {
    if (!SUBJECT_ID.test(org)) throw new Error(`${path}：组织编号 ${org} 不合法`);
    if (typeof members !== 'object' || members === null || Array.isArray(members)) {
      throw new Error(`${path}：orgs.${org} 必须是对象`);
    }
    for (const [sub, role] of Object.entries(members)) {
      if (!SUBJECT_ID.test(sub) || !ROLES.has(role)) {
        throw new Error(`${path}：orgs.${org}.${sub} 必须是 admin、member 或 viewer`);
      }
    }
  }
  return orgs;
}

function send(res, status, body, extraHeaders = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolveBody(text.trim() === '' ? {} : JSON.parse(text));
      } catch {
        reject(new Error('请求体不是 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 启动模拟 NyxID。port = 0 时随机分配端口。返回 {url, issuer, close()}。
 * issuer 就是服务根地址（http://127.0.0.1:<端口>），接口服务只允许本机地址用 http。
 */
export async function startMockNyxid({
  port = 8090,
  host = '127.0.0.1',
  rolesPath = DEFAULT_ROLES_PATH,
  log = () => {},
} = {}) {
  const key = createKey();
  let issuer = '';

  const identityToken = (sub, permissions) => {
    const iat = now();
    return signJwt(key, {
      sub,
      iss: issuer,
      aud: AUDIENCE,
      iat,
      exp: iat + IDENTITY_LIFETIME_SECONDS,
      jti: randomUUID(),
      nyx_service_id: SERVICE_ID,
      permissions,
      roles: [],
      groups: [],
    });
  };

  const accessToken = (sub, override) => {
    const iat = now();
    const claims = {
      sub,
      iss: issuer,
      aud: issuer,
      iat,
      exp: iat + ACCESS_LIFETIME_SECONDS,
      jti: randomUUID(),
      token_type: 'access',
    };
    // 只给这个模拟服务自己看的角色覆盖；接口服务不读访问令牌里的其他字段。
    if (override) claims.dev_org_role = override;
    return signJwt(key, claims);
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', issuer);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      return send(res, 200, { status: 'ok', service: 'mock-nyxid', kid: key.kid });
    }
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      return send(res, 200, {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        id_token_signing_alg_values_supported: ['RS256'],
        subject_types_supported: ['public'],
        response_types_supported: ['code'],
        nyxid_mock: true,
      });
    }
    if (req.method === 'GET' && path === '/.well-known/jwks.json') {
      return send(res, 200, { keys: [key.jwk] });
    }

    const org = /^\/api\/v1\/orgs\/([^/]+)\/authorization$/.exec(path);
    if (req.method === 'GET' && org) {
      const orgId = decodeURIComponent(org[1]);
      const auth = req.headers.authorization ?? '';
      const claims = auth.startsWith('Bearer ') ? verifyJwt(key, auth.slice(7)) : null;
      if (!claims || claims.token_type !== 'access' || claims.iss !== issuer || claims.exp <= now()) {
        log(`组织授权 ${orgId}：凭据无效 → 401`);
        return send(res, 401, { error: 'unauthorized', message: '访问令牌无效或已过期' });
      }
      let role;
      const override = claims.dev_org_role;
      if (override && (override.org === undefined || override.org === orgId)) {
        role = override.role === 'none' ? undefined : override.role;
      } else {
        const orgs = await loadRoles(rolesPath);
        role = orgs[orgId]?.[claims.sub];
      }
      if (!role) {
        log(`组织授权 ${orgId}：${claims.sub} 不是成员 → 404`);
        return send(res, 404, { error: 'not_found', message: '组织不存在或调用者不是成员' });
      }
      log(`组织授权 ${orgId}：${claims.sub} = ${role}`);
      // 形状照 NyxID 的组织授权接口（接口服务只读 id 和 your_role）。
      return send(res, 200, {
        id: orgId,
        your_role: role,
        member_count: 1,
        is_primary: false,
        active_invite_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
    }

    if (req.method === 'POST' && path === '/dev/token') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        return send(res, 400, { error: 'bad_request', message: error.message });
      }
      const { sub, orgRole, org: onlyOrg, permissions = [] } = body ?? {};
      if (typeof sub !== 'string' || !SUBJECT_ID.test(sub)) {
        return send(res, 400, { error: 'bad_request', message: 'sub 必须是 1–256 个字母、数字、- 或 _' });
      }
      if (orgRole !== undefined && !(ROLES.has(orgRole) || orgRole === 'none')) {
        return send(res, 400, { error: 'bad_request', message: 'orgRole 只能是 admin、member、viewer 或 none' });
      }
      if (onlyOrg !== undefined && (typeof onlyOrg !== 'string' || !SUBJECT_ID.test(onlyOrg))) {
        return send(res, 400, { error: 'bad_request', message: 'org 必须是组织编号' });
      }
      if (!Array.isArray(permissions) || permissions.length > 256 || !permissions.every((p) => typeof p === 'string' && PERMISSION.test(p))) {
        return send(res, 400, { error: 'bad_request', message: 'permissions 必须是字符串数组' });
      }
      const override = orgRole === undefined ? undefined : { role: orgRole, ...(onlyOrg ? { org: onlyOrg } : {}) };
      log(`签发令牌：sub=${sub}${override ? ` orgRole=${orgRole}${onlyOrg ? `@${onlyOrg}` : ''}` : ''}`);
      return send(res, 200, {
        identityToken: identityToken(sub, permissions),
        accessToken: accessToken(sub, override),
        identityHeader: 'X-NyxID-Identity-Token',
        expiresIn: IDENTITY_LIFETIME_SECONDS,
        serviceId: SERVICE_ID,
        audience: AUDIENCE,
        issuer,
      });
    }

    return send(res, 404, { error: 'not_found', message: `没有这个接口：${req.method} ${path}` });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`出错：${error.message}`);
      if (!res.headersSent) send(res, 500, { error: 'internal', message: error.message });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const shownHost = host.includes(':') ? `[${host}]` : host;
  issuer = `http://${shownHost}:${address.port}`;
  // 启动时就检查一遍角色文件，写错了直接失败。
  await loadRoles(rolesPath);
  return {
    url: issuer,
    issuer,
    kid: key.kid,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function parseArgs(argv) {
  const options = {
    port: Number(process.env.MOCK_NYXID_PORT ?? 8090),
    host: process.env.MOCK_NYXID_HOST ?? '127.0.0.1',
    rolesPath: process.env.MOCK_NYXID_ROLES ?? DEFAULT_ROLES_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--port' && value !== undefined) {
      options.port = Number(value);
      i += 1;
    } else if (flag === '--host' && value !== undefined) {
      options.host = value;
      i += 1;
    } else if (flag === '--roles' && value !== undefined) {
      options.rolesPath = resolve(value);
      i += 1;
    } else {
      throw new Error(`不认识的参数：${flag}（可用 --port、--host、--roles）`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('端口必须是 0–65535 的整数');
  }
  return options;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!['127.0.0.1', 'localhost', '::1'].includes(options.host)) {
      console.warn(`警告：模拟 NyxID 监听在 ${options.host}，任何能访问它的人都能签发令牌，只能在本机使用。`);
    }
    const mock = await startMockNyxid({
      ...options,
      log: (line) => console.log(`[mock-nyxid] ${new Date().toISOString()} ${line}`),
    });
    console.log(`[mock-nyxid] 已启动：${mock.url}（kid ${mock.kid}，服务编号 ${SERVICE_ID}，受众 ${AUDIENCE}）`);
    console.log(`[mock-nyxid] 组织角色文件：${options.rolesPath}`);
    const stop = () => {
      mock.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    console.error(`[mock-nyxid] 启动失败：${error.message}`);
    process.exit(1);
  }
}
