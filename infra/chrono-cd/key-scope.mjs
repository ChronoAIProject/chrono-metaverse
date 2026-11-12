#!/usr/bin/env node
// 由组织管理员读取线上应用后生成 NyxID 操作范围；不读取或输出 Key 原文。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORG, TARGETS, deploymentSpec } from './deploy.mjs';

// chrono-cd 已登记的稳定操作 ID，权限由 NyxID 按 ID 和方法/路径共同绑定。
const ENDPOINTS = {
  read: '1b6d5e06-6f41-4cbb-8790-ed40192f982f',
  write: '4b998cbc-e192-4f02-970b-dfb450846fed',
  status: '770b8512-024a-4a8d-b162-040f3bef45e9',
};
const exact = (value) => ({ type: 'exact', value });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });

/** 固定所有非镜像配置；闭合的 path/query/body 由 NyxID 在转发前强制核对。 */
export function keyScope(app, environment, expectedRevision) {
  const target = Object.values(TARGETS).find((value) => value.environment === environment);
  if (!target || app.name !== target.app || app.project !== 'metaverse' || app.owner !== ORG) {
    throw new Error('应用与部署环境不匹配');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('权限修订号不合法');
  const spec = deploymentSpec(app.spec, {});
  const names = [`${target.prefix}-api`, `${target.prefix}-web`];
  if (Object.keys(spec.services).sort().join(',') !== names.sort().join(',')) throw new Error('应用必须恰好包含两个目标服务');
  const properties = Object.fromEntries(Object.entries(spec).map(([name, value]) => [name, exact(value)]));
  properties.services = object(Object.fromEntries(Object.entries(spec.services).map(([name, service]) => {
    if (typeof service.image !== 'string' || !service.image) throw new Error('缺少现有镜像');
    return [name, object(Object.fromEntries(Object.entries(service).map(([field, value]) =>
      [field, field === 'image' ? { type: 'string', max_length: 256 } : exact(value)])))];
  })));
  return {
    expected_revision: expectedRevision,
    all_operations: false,
    endpoint_ids: Object.values(ENDPOINTS),
    inputs: Object.fromEntries(Object.values(ENDPOINTS).map((id) => [id, {
      path: { project: exact('metaverse'), app: exact(target.app) },
      query: { org_id: { required: true, rule: exact(ORG) } },
      ...(id === ENDPOINTS.write ? { body: object(properties) } : {}),
    }])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , snapshot, environment, revision] = process.argv;
    if (!snapshot || revision === undefined) throw new Error('用法：node key-scope.mjs <线上应用.json> <staging|production> <当前权限修订号>');
    console.log(JSON.stringify(keyScope(JSON.parse(readFileSync(snapshot, 'utf8')), environment, Number(revision)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
