import { expect, it } from 'vitest';
import {
  clearEnrollment,
  readEnrollment,
  saveEnrollment,
  validEnrollment,
} from './browserEnrollment';

it.each([
  ['https://nyxid.ai', true],
  ['http://localhost:13000', true],
  ['http://127.0.0.1:13000', true],
  ['http://127.23.4.5:13000', true],
  ['http://[::1]:13000', true],
  ['http://nyxid.ai', false],
  ['http://192.168.1.2', false],
  ['http://localhost.evil.test', false],
  ['http://[::2]', false],
  ['http://user@localhost', false],
  ['ftp://localhost', false],
])('授权地址只允许 HTTPS 或 HTTP 回环地址：%s', (origin, accepted) => {
  expect(
    validEnrollment({
      device_code: 'private-request',
      user_code: 'ABCD-1234',
      verification_uri: `${origin}/login/agent-key?user_code=ABCD-1234`,
      expires_in: 300,
      interval: 5,
    }),
  ).toBe(accepted);
});

it('待确认申请只按账号及归属恢复，不延长原有效期或绕过原轮询间隔', () => {
  const pending = {
    device_code: 'private-request',
    user_code: 'ABCD-1234',
    verification_uri: 'https://nyxid.ai/login/agent-key?user_code=ABCD-1234',
    expires_in: 300,
    interval: 10,
    expiresAt: Date.now() + 300_000,
    nextPollAt: Date.now() + 10_000,
  };
  saveEnrollment('alice', 'org-one', pending);
  expect(readEnrollment('alice', 'org-one')).toEqual(pending);
  expect(readEnrollment('bob', 'org-one')).toBeNull();
  expect(readEnrollment('alice', 'alice')).toBeNull();
  saveEnrollment('bob', 'org-one', pending);
  clearEnrollment('alice');
  expect(readEnrollment('alice', 'org-one')).toBeNull();
  expect(readEnrollment('bob', 'org-one')).toEqual(pending);
  saveEnrollment('alice', 'org-one', pending);
  saveEnrollment('alice', 'org-one', { ...pending, expiresAt: Date.now() - 1 });
  expect(readEnrollment('alice', 'org-one')).toBeNull();
});
