type KeyIdentity = {
  ownerId?: string;
  credentialVersion?: string;
  keyId: string;
  name: string;
  credentialId: string;
  credentialExpiresAt: string | null;
  keyExpiresAt: string | null;
};
type SavedKey = { subject: string; credential: string; identity: KeyIdentity };
const validCredential = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:nyx_|nyxid_ag_)[!-~]{12,4090}$/.test(v);
function validIdentity(v: unknown): v is KeyIdentity {
  if (!v || typeof v !== 'object') return false;
  const x = v as KeyIdentity;
  return (
    [x.keyId, x.name, x.credentialId].every((s) => typeof s === 'string' && s.length > 0) &&
    [x.credentialExpiresAt, x.keyExpiresAt].every(
      (s) => s === null || (typeof s === 'string' && Number.isFinite(Date.parse(s))),
    )
  );
}
// SDK 验证并加密迁移完成后，才移除本次读取的旧凭据。
export function legacyNyxGrant(subject: string) {
  const id = encodeURIComponent(subject);
  const key = `metaverse-nyxagent-credential:v2:${id}:${id}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 16384) return;
    const value = JSON.parse(raw) as SavedKey;
    if (
      value.subject !== subject ||
      !validCredential(value.credential) ||
      !validIdentity(value.identity)
    )
      return;
    const identity = value.identity;
    if (identity.ownerId !== undefined && identity.ownerId !== subject) return;
    if (
      [identity.credentialExpiresAt, identity.keyExpiresAt].some(
        (time) => time !== null && Date.parse(time) <= Date.now(),
      )
    )
      return;
    return {
      credential: value.credential,
      forget() {
        if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
      },
    };
  } catch {
    return;
  }
}

export function forgetLegacyGrants(subject: string) {
  const id = encodeURIComponent(subject);
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[name];
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (key === null) continue;
        if (
          ['cma', 'nyxagent'].some(
            (provider) =>
              key.startsWith(`metaverse-${provider}-credential:v2:${id}:`) ||
              key.startsWith(`metaverse-${provider}-enrollment:v1:${id}:`),
          )
        ) {
          storage.removeItem(key);
        } else if (
          key === 'metaverse-cma-credential:v1' ||
          key.startsWith('metaverse-cma-credential:v1:org:')
        ) {
          try {
            if (JSON.parse(storage.getItem(key) ?? 'null')?.subject === subject)
              storage.removeItem(key);
          } catch {
            /* 无法确定所属账号。 */
          }
        }
      }
    } catch {
      /* 禁用存储的浏览器仍可断开账号。 */
    }
  }
}
