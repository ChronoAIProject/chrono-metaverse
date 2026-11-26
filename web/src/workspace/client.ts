export type Session = {
  enabled: boolean;
  connected: boolean;
  subject?: string;
  csrfToken?: string;
};
/** 只允许嵌入本站查看路由，输出时编码 HTML 元字符。 */
export function viewerLink(value: string, origin = window.location.origin): string | null {
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin || u.username || u.password || u.search) return null;
    if (u.pathname === '/preview' && /^#t=[A-Za-z0-9_-]{1,256}$/.test(u.hash))
      return encodeURI(u.pathname + u.hash);
    if (
      /^\/(s|u)\/[a-z0-9][a-z0-9-]{0,79}$/.test(u.pathname) &&
      (u.hash === '' || /^#share=[A-Za-z0-9_-]{1,256}$/.test(u.hash))
    )
      return encodeURI(u.pathname + u.hash);
    return null;
  } catch {
    return null;
  }
}
export function resultLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(
    /https?:\/\/[^\s<>"'`\])}，。；]+|\/(?:preview#t=|[su]\/)[A-Za-z0-9_/#=-]+/g,
  )) {
    const url = viewerLink(match[0]);
    if (url) links.add(url);
  }
  return [...links].slice(-20).reverse();
}
export type SpaceSummary = {
  id: string;
  name: string;
  description: string;
  owner: { kind: 'person' | 'org'; id: string };
  visibility: string;
  updatedAt: string;
  access: 'read' | 'manage';
};
export type Catalog = {
  items: SpaceSummary[];
  next: string | null;
  organizations: { id: string; name: string; role: string }[];
};
export async function readCatalog(
  session: Session,
  after?: string,
  signal?: AbortSignal,
  request = fetch,
): Promise<Catalog> {
  const r = await request('/api/auth/nyxid/spaces', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken ?? '' },
    body: JSON.stringify(after ? { after } : {}),
  });
  if (!r.ok) {
    const v = (await r.json()) as { code?: string; detail?: string };
    throw new Error(v.detail ?? '暂时无法读取空间列表。');
  }
  return (await r.json()) as Catalog;
}

export async function requestSpaceShare(
  spaceId: string,
  csrfToken: string,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<string | null> {
  const response = await request(`/api/auth/nyxid/spaces/${encodeURIComponent(spaceId)}/share`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'x-csrf-token': csrfToken },
  });
  const result = (await response.json().catch(() => null)) as {
    token?: unknown;
    detail?: unknown;
  } | null;
  if (!response.ok && typeof result?.detail === 'string') throw new Error(result.detail);
  if (response.ok) {
    if (result?.token === null) return null;
    if (typeof result?.token === 'string' && /^[A-Za-z0-9_-]{22,256}$/.test(result.token)) {
      return result.token;
    }
  }
  throw new Error('暂时无法获取分享链接，请重试。');
}
