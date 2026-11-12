import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyScope } from './key-scope.mjs';

const org = '52aa284c-b5b2-49bd-9d12-79f24772dbd7';
const endpoints = {
  read: '1b6d5e06-6f41-4cbb-8790-ed40192f982f',
  write: '4b998cbc-e192-4f02-970b-dfb450846fed',
  status: '770b8512-024a-4a8d-b162-040f3bef45e9',
};
const spec = { addons: { mongodb: {} }, services: {
  'metaverse-api': { image: 'old', image_digest: 'sha256:old', env: { MODE: 'live' }, secret_keys: ['TOKEN'], resources: { limits: { memory: '1Gi' } } },
  'metaverse-web': { image: 'old', routes: ['/'], replicas: 2 },
} };
const app = { name: 'chrono-metaverse', project: 'metaverse', owner: org, spec };

test('只选择三个操作，固定组织、项目和应用，不可用查询参数切换范围', () => {
  const scope = keyScope(app, 'staging', 7);
  assert.equal(scope.expected_revision, 7);
  assert.equal(scope.all_operations, false);
  assert.deepEqual(scope.endpoint_ids.sort(), Object.values(endpoints).sort());
  assert.deepEqual(Object.keys(scope.inputs).sort(), scope.endpoint_ids);
  for (const input of Object.values(scope.inputs)) {
    assert.deepEqual(input.path, { project: { type: 'exact', value: 'metaverse' }, app: { type: 'exact', value: app.name } });
    assert.deepEqual(input.query, { org_id: { required: true, rule: { type: 'exact', value: org } } });
  }
  assert.ok(!Object.hasOwn(scope.inputs[endpoints.read], 'body'));
  assert.ok(!Object.hasOwn(scope.inputs[endpoints.status], 'body'));
});

test('PUT 请求体逐层闭合，所有非镜像配置必须原样提供', () => {
  const body = keyScope(app, 'staging', 0).inputs[endpoints.write].body;
  assert.deepEqual(body.required.sort(), ['addons', 'services']);
  assert.deepEqual(body.properties.addons, { type: 'exact', value: spec.addons });
  const services = body.properties.services;
  assert.equal(services.type, 'object');
  assert.deepEqual(services.required.sort(), Object.keys(spec.services).sort());
  assert.deepEqual(Object.keys(services.properties).sort(), services.required);
  for (const [name, value] of Object.entries(spec.services)) {
    const rule = services.properties[name];
    const fixed = Object.keys(value).filter((key) => !['image', 'image_digest'].includes(key));
    assert.deepEqual(rule.required.sort(), ['image', ...fixed].sort());
    assert.deepEqual(Object.keys(rule.properties).sort(), rule.required);
    assert.deepEqual(rule.properties.image, { type: 'string', max_length: 256 });
    for (const key of fixed) assert.deepEqual(rule.properties[key], { type: 'exact', value: value[key] });
  }
});

test('拒绝给错误的应用、组织或不完整快照生成权限', () => {
  for (const other of [{ ...app, name: 'other' }, { ...app, project: 'other' }, { ...app, owner: 'other' }, { ...app, spec: {} }]) {
    assert.throws(() => keyScope(other, 'staging', 0));
  }
  assert.throws(() => keyScope(app, 'production', 0));
  assert.throws(() => keyScope(app, 'staging', -1));
  assert.throws(() => keyScope(app, 'unknown', 0));
});
