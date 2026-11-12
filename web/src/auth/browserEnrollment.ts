import type { ChatProvider } from './browserKey';
// 未交付的申请只保存在发起标签页；刷新后沿用同一请求，不重复创建授权。
export type Enrollment = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};
export type PendingEnrollment = Enrollment & { expiresAt: number; nextPollAt: number };
const prefix = (subject: string, provider: ChatProvider = 'cma') =>
  `metaverse-${provider}-enrollment:v1:${encodeURIComponent(subject)}:`;
const storageKey = (subject: string, owner: string, provider: ChatProvider = 'cma') =>
  `${prefix(subject, provider)}${encodeURIComponent(owner)}`;

export function validEnrollment(value: Enrollment): boolean {
  try {
    const url = new URL(value.verification_uri);
    return (
      url.protocol === 'https:' &&
      url.pathname === '/login/agent-key' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^[A-Z0-9-]{4,32}$/.test(value.user_code) &&
      url.searchParams.getAll('user_code').length === 1 &&
      url.searchParams.get('user_code') === value.user_code &&
      typeof value.device_code === 'string' &&
      value.device_code.length > 0 &&
      value.device_code.length <= 4096 &&
      Number.isInteger(value.expires_in) &&
      value.expires_in > 0 &&
      value.expires_in <= 600 &&
      Number.isInteger(value.interval) &&
      value.interval > 0 &&
      value.interval <= 60
    );
  } catch {
    return false;
  }
}
export function saveEnrollment(
  subject: string,
  owner: string,
  value: PendingEnrollment,
  provider: ChatProvider = 'cma',
) {
  try {
    sessionStorage.setItem(storageKey(subject, owner, provider), JSON.stringify(value));
  } catch {
    throw new Error('无法在此标签页保存授权申请，请检查网站存储设置后重试。');
  }
}
export function clearEnrollment(subject: string, owner?: string, provider: ChatProvider = 'cma') {
  try {
    const keys = owner
      ? [storageKey(subject, owner, provider)]
      : Array.from({ length: sessionStorage.length }, (_, index) =>
          sessionStorage.key(index),
        ).filter((key): key is string => key !== null && key.startsWith(prefix(subject, provider)));
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // 浏览器可能已关闭存储访问；不阻止结束等待或清除已交付凭据。
  }
}
// Request expiry prevents another poll; it does not invalidate a credential
// already claimed by a poll whose response is still in flight.
export function matchesEnrollment(
  subject: string,
  owner: string,
  deviceCode: string,
  provider: ChatProvider = 'cma',
): boolean {
  try {
    const raw = sessionStorage.getItem(storageKey(subject, owner, provider));
    return !!raw && raw.length <= 16384 && JSON.parse(raw).device_code === deviceCode;
  } catch {
    return false;
  }
}
export function readEnrollment(
  subject: string,
  owner: string,
  provider: ChatProvider = 'cma',
): PendingEnrollment | null {
  try {
    const raw = sessionStorage.getItem(storageKey(subject, owner, provider));
    if (!raw || raw.length > 16384) return null;
    const value = JSON.parse(raw) as PendingEnrollment;
    if (
      !validEnrollment(value) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 600_000 ||
      !Number.isFinite(value.nextPollAt) ||
      value.nextPollAt > Date.now() + 60_000
    ) {
      clearEnrollment(subject, owner, provider);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
