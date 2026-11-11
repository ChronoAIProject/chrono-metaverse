import { expect, it } from 'vitest';
import { clearEnrollment, readEnrollment, saveEnrollment } from './browserEnrollment';

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
