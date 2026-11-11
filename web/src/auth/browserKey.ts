// This credential lives only in this browser tab's separate auth storage.
// It must never be copied into a notebook, task, URL or diagnostic.
export type KeyIdentity = {
  keyId: string;
  name: string;
  credentialId: string;
  credentialExpiresAt: string | null;
  keyExpiresAt: string | null;
};
type SavedKey = { subject: string; credential: string; identity: KeyIdentity };
const STORAGE = 'metaverse-cma-credential:v1';
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
export function readBrowserKey(subject?: string): SavedKey | null {
  if (!subject) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE);
    if (!raw || raw.length > 16_384) return null;
    const v = JSON.parse(raw) as SavedKey;
    if (v.subject !== subject || !validCredential(v.credential) || !validIdentity(v.identity))
      return null;
    if (
      [v.identity.credentialExpiresAt, v.identity.keyExpiresAt].some(
        (s) => s !== null && Date.parse(s) <= Date.now(),
      )
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
export function saveBrowserKey(subject: string, credential: string, identity: KeyIdentity) {
  if (!validCredential(credential) || !validIdentity(identity))
    throw new Error('无法核对 Agent Key 授权结果，请重新授权。');
  sessionStorage.setItem(STORAGE, JSON.stringify({ subject, credential, identity }));
}
export function clearBrowserKey(subject: string) {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    if (raw && (JSON.parse(raw) as SavedKey).subject === subject)
      sessionStorage.removeItem(STORAGE);
  } catch {
    sessionStorage.removeItem(STORAGE);
  }
}
export function browserKeyHeaders(subject?: string): Record<string, string> {
  const value = readBrowserKey(subject);
  return value ? { Authorization: `Bearer ${value.credential}` } : {};
}
