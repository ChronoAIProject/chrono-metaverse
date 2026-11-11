// Migrate away from browser-held CMA credentials without copying them elsewhere.
export function clearLegacyCmaCredentials() {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[name];
      const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
      for (const key of keys) {
        if (
          key?.startsWith('metaverse-cma-credential:') ||
          key?.startsWith('metaverse-cma-enrollment:')
        )
          storage.removeItem(key);
      }
    } catch {
      // Cookie-based OAuth does not require web storage.
    }
  }
}
export function cmaOwnerHeaders(subject?: string, owner = subject): Record<string, string> {
  return owner && owner !== subject ? { 'x-metaverse-cma-owner': owner } : {};
}
