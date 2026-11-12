// 凭据仅保存在浏览器独立的授权存储中，不进入任务、聊天记录、URL 或诊断。
export type KeyIdentity = {
  ownerId?: string;
  credentialVersion?: string;
  keyId: string;
  name: string;
  credentialId: string;
  credentialExpiresAt: string | null;
  keyExpiresAt: string | null;
};
type SavedKey = { subject: string; credential: string; identity: KeyIdentity };
const LEGACY = 'metaverse-cma-credential:v1';
const prefix = (subject: string) => `metaverse-cma-credential:v2:${encodeURIComponent(subject)}:`;
export const browserKeyStorageKey = (subject: string) =>
  `${prefix(subject)}${encodeURIComponent(subject)}`;
const legacyKey = (subject: string, owner = subject) =>
  owner === subject ? LEGACY : `${LEGACY}:org:${owner}`;
const storageKeys = (storage: Storage) =>
  Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => key !== null,
  );
export const validCredential = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:nyx_|nyxid_ag_)[!-~]{12,4090}$/.test(v);
export function validIdentity(v: unknown): v is KeyIdentity {
  if (!v || typeof v !== 'object') return false;
  const x = v as KeyIdentity;
  return (
    [x.keyId, x.name, x.credentialId].every((s) => typeof s === 'string' && s.length > 0) &&
    [x.credentialExpiresAt, x.keyExpiresAt].every(
      (s) => s === null || (typeof s === 'string' && Number.isFinite(Date.parse(s))),
    )
  );
}
export function readBrowserKey(subject?: string, owner = subject): SavedKey | null {
  if (!subject) return null;
  try {
    const key = browserKeyStorageKey(subject);
    const persistent = localStorage.getItem(key);
    const raw = persistent ?? sessionStorage.getItem(legacyKey(subject, owner));
    if (!raw || raw.length > 16_384) return null;
    const v = JSON.parse(raw) as SavedKey;
    if (
      v.subject !== subject ||
      !validCredential(v.credential) ||
      !validIdentity(v.identity) ||
      (v.identity.ownerId !== undefined && v.identity.ownerId !== subject)
    )
      return null;
    if (
      [v.identity.credentialExpiresAt, v.identity.keyExpiresAt].some(
        (s) => s !== null && Date.parse(s) <= Date.now(),
      )
    )
      return null;
    if (persistent === null) saveBrowserKey(subject, v.credential, v.identity, owner);
    return v;
  } catch {
    return null;
  }
}
export function saveBrowserKey(
  subject: string,
  credential: string,
  identity: KeyIdentity,
  owner = subject,
) {
  if (
    !validCredential(credential) ||
    !validIdentity(identity) ||
    (identity.ownerId !== undefined && identity.ownerId !== subject)
  )
    throw new Error('无法核对 Agent Key 授权结果，请重新授权。');
  try {
    localStorage.setItem(
      browserKeyStorageKey(subject),
      JSON.stringify({ subject, credential, identity }),
    );
  } catch {
    throw new Error('无法在此浏览器保存 CMA 授权，请检查网站存储设置后重试。');
  }
  try {
    const previous = sessionStorage.getItem(legacyKey(subject, owner));
    if (previous && (JSON.parse(previous) as SavedKey).subject === subject)
      sessionStorage.removeItem(legacyKey(subject, owner));
  } catch {
    // 新凭据已经保存；旧标签页存储不可用时不误报保存失败。
  }
}
export function readBrowserKeys(subject: string): Array<SavedKey & { owner: string }> {
  const saved = readBrowserKey(subject);
  return saved ? [{ ...saved, owner: subject }] : [];
}
export function clearBrowserKey(subject: string, owner?: string) {
  for (const storage of [localStorage, sessionStorage]) {
    const keys = owner
      ? [browserKeyStorageKey(subject), legacyKey(subject, owner)]
      : storageKeys(storage).filter(
          (k) => k.startsWith(prefix(subject)) || k === LEGACY || k.startsWith(`${LEGACY}:org:`),
        );
    for (const key of keys) {
      try {
        const raw = storage.getItem(key);
        if (raw && (JSON.parse(raw) as SavedKey).subject === subject) storage.removeItem(key);
      } catch {
        storage.removeItem(key);
      }
    }
  }
}
export function browserKeyHeaders(subject?: string, owner = subject): Record<string, string> {
  const value = readBrowserKey(subject, owner);
  return {
    ...(value ? { Authorization: `Bearer ${value.credential}` } : {}),
    ...(owner && owner !== subject ? { 'x-metaverse-cma-owner': owner } : {}),
  };
}
