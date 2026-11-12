import { readBrowserKey } from './browserKey';
export type CmaAuthMethod = 'oauth' | 'agent_key';
export function cmaOwnerHeaders(subject?: string, owner = subject): Record<string, string> {
  return owner && owner !== subject ? { 'x-metaverse-cma-owner': owner } : {};
}
export function cmaAuthHeaders(session: {
  subject?: string;
  cmaOwnerId?: string;
  cmaAuthMethod?: CmaAuthMethod;
}): Record<string, string> {
  const method = session.cmaAuthMethod ?? 'oauth';
  const saved = method === 'agent_key' ? readBrowserKey(session.subject, session.cmaOwnerId) : null;
  return {
    ...cmaOwnerHeaders(session.subject, session.cmaOwnerId),
    'x-metaverse-cma-auth': method,
    ...(saved ? { Authorization: `Bearer ${saved.credential}` } : {}),
  };
}
const modeKey = (subject: string) => `metaverse-cma-auth-method:v1:${encodeURIComponent(subject)}`;
export function readAuthMethod(subject?: string): CmaAuthMethod {
  try {
    return subject && localStorage.getItem(modeKey(subject)) === 'agent_key'
      ? 'agent_key'
      : 'oauth';
  } catch {
    return 'oauth';
  }
}
export function saveAuthMethod(subject: string, method: CmaAuthMethod) {
  try {
    localStorage.setItem(modeKey(subject), method);
  } catch {
    /* 当前标签页仍可切换。 */
  }
}
