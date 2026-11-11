// This credential lives only in this browser tab's separate auth storage.
// It must never be copied into a notebook, task, URL or diagnostic.
export type KeyIdentity = {
  ownerId?: string;
  keyId: string;
  name: string;
  credentialId: string;
  credentialExpiresAt: string | null;
  keyExpiresAt: string | null;
};
type SavedKey = { subject: string; credential: string; identity: KeyIdentity };
const STORAGE = 'metaverse-cma-credential:v1';
const storageKey = (subject: string, owner = subject) =>
  owner === subject ? STORAGE : `${STORAGE}:org:${owner}`;
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
    const raw = sessionStorage.getItem(storageKey(subject, owner));
    if (!raw || raw.length > 16_384) return null;
    const v = JSON.parse(raw) as SavedKey;
    if (
      v.subject !== subject ||
      !validCredential(v.credential) ||
      !validIdentity(v.identity) ||
      (v.identity.ownerId !== undefined && v.identity.ownerId !== owner) ||
      (owner !== subject && v.identity.ownerId !== owner)
    )
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
export function saveBrowserKey(
  subject: string,
  credential: string,
  identity: KeyIdentity,
  owner = subject,
) {
  if (
    !validCredential(credential) ||
    !validIdentity(identity) ||
    (identity.ownerId !== undefined && identity.ownerId !== owner) ||
    (owner !== subject && identity.ownerId !== owner)
  )
    throw new Error('无法核对 Agent Key 授权结果，请重新授权。');
  sessionStorage.setItem(
    storageKey(subject, owner),
    JSON.stringify({ subject, credential, identity }),
  );
}
export function readBrowserKeys(subject: string): Array<SavedKey & { owner: string }> {
  const owners = [subject];
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(`${STORAGE}:org:`)) owners.push(key.slice(`${STORAGE}:org:`.length));
  }
  return owners.flatMap((owner) => {
    const saved = readBrowserKey(subject, owner);
    return saved ? [{ ...saved, owner }] : [];
  });
}
export function clearBrowserKey(subject: string, owner?: string) {
  const keys = owner
    ? [storageKey(subject, owner)]
    : Object.keys(sessionStorage).filter((k) => k === STORAGE || k.startsWith(`${STORAGE}:org:`));
  for (const key of keys) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw && (JSON.parse(raw) as SavedKey).subject === subject) sessionStorage.removeItem(key);
    } catch {
      sessionStorage.removeItem(key);
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
