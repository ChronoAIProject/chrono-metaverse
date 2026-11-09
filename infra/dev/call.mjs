#!/usr/bin/env node
// 本地调用接口服务的小工具：每次从模拟 NyxID 取一对新令牌（身份令牌 60 秒有效、jti 只能用一次），
// 像 NyxID 代理那样带上请求头再转给接口服务。Node 22，无第三方依赖。
//
//   node infra/dev/call.mjs [选项] <方法> <路径> [JSON 或 @文件]
//
// 选项：
//   --as <sub>          调用者（默认 alice）；用组织编号（例如 chronoai）就是"组织本身"的 agent key
//   --org-role <角色>    这次的访问令牌查组织角色时固定返回 admin / member / viewer / none
//   --org <组织编号>      配合 --org-role，只对这个组织生效
//   --no-forward        不带 Authorization: Bearer（模拟没开"转发调用者令牌"）
//   --share <分享令牌>   公开读接口用：Authorization: Share <令牌>
//
// 环境变量：METAVERSE_API_URL（默认 http://127.0.0.1:8080）、MOCK_NYXID_URL（默认 http://127.0.0.1:8090）。
// /api/v1/* 会带上 X-NyxID-Identity-Token 和 Authorization: Bearer <访问令牌>；/api/public/* 不带身份。

import { readFile } from 'node:fs/promises';

const api = (process.env.METAVERSE_API_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const nyx = (process.env.MOCK_NYXID_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '');

function usage(message) {
  if (message) console.error(message);
  console.error('用法：node infra/dev/call.mjs [--as <sub>] [--org-role <角色>] [--org <组织>] [--no-forward] [--share <令牌>] <方法> <路径> [JSON 或 @文件]');
  process.exit(2);
}

const options = { as: 'alice', forward: true };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  const next = () => {
    if (args[i + 1] === undefined) usage(`${arg} 缺少取值`);
    i += 1;
    return args[i];
  };
  if (arg === '--as') options.as = next();
  else if (arg === '--org-role') options.orgRole = next();
  else if (arg === '--org') options.org = next();
  else if (arg === '--share') options.share = next();
  else if (arg === '--no-forward') options.forward = false;
  else if (arg === '-h' || arg === '--help') usage();
  else positional.push(arg);
}
if (positional.length < 2 || positional.length > 3) usage();
const [method, path, rawBody] = positional;
if (!path.startsWith('/')) usage('路径要以 / 开头，例如 /api/v1/spaces/front-hall');

let body;
if (rawBody !== undefined) {
  body = rawBody.startsWith('@') ? await readFile(rawBody.slice(1), 'utf8') : rawBody;
  JSON.parse(body); // 先在本地检查是不是合法 JSON
}

const headers = { accept: 'application/json' };
if (body !== undefined) headers['content-type'] = 'application/json';

if (path.startsWith('/api/v1/')) {
  const tokenRequest = { sub: options.as };
  if (options.orgRole) tokenRequest.orgRole = options.orgRole;
  if (options.org) tokenRequest.org = options.org;
  const tokenResponse = await fetch(`${nyx}/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tokenRequest),
  }).catch((error) => {
    console.error(`连不上模拟 NyxID（${nyx}）：${error.cause?.code ?? error.message}`);
    process.exit(1);
  });
  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok) {
    console.error(`取令牌失败：${tokenResponse.status} ${JSON.stringify(tokens)}`);
    process.exit(1);
  }
  headers['x-nyxid-identity-token'] = tokens.identityToken;
  if (options.forward) headers.authorization = `Bearer ${tokens.accessToken}`;
} else if (options.share) {
  headers.authorization = `Share ${options.share}`;
}

const response = await fetch(`${api}${path}`, { method: method.toUpperCase(), headers, body }).catch((error) => {
  console.error(`连不上接口服务（${api}）：${error.cause?.code ?? error.message}`);
  process.exit(1);
});
const text = await response.text();
console.error(`${response.status} ${response.statusText}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  if (text) console.log(text);
}
process.exit(response.ok ? 0 : 1);
