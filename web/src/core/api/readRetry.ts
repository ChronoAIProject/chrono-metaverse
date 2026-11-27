const TRANSIENT_READ_STATUSES = new Set([429, 502, 503, 504]);
const MAX_READ_RETRY_DELAY_MS = 3_000;

function readRetryDelay(response: Response): number {
  const retryAfter = response.headers.get('Retry-After');
  const delay = retryAfter
    ? /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1_000
      : Date.parse(retryAfter) - Date.now()
    : 0;
  return Math.max(1_000, delay || 0);
}

async function waitForReadRetry(delay: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
  signal?.throwIfAborted();
}

export async function retryTransientRead(
  response: Response,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!TRANSIENT_READ_STATUSES.has(response.status)) return false;
  const delay = readRetryDelay(response);
  if (delay > MAX_READ_RETRY_DELAY_MS) return false;
  void response.body?.cancel().catch(() => undefined);
  await waitForReadRetry(delay + Math.random() * 250, signal);
  return true;
}
