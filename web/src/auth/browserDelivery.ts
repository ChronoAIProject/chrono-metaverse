import { workerRequest, type Session } from '../workspace/client';
import { readBrowserKey, saveBrowserKey, type ChatProvider, type KeyIdentity } from './browserKey';
import { clearEnrollment, matchesEnrollment, type PendingEnrollment } from './browserEnrollment';

type Delivery = { credential: string; identity: KeyIdentity };
// A claimed NyxID credential cannot be polled again. Finish and save a delivery
// even when the chat component is closed or replaced while its response is in flight.
const inFlight = new Map<string, Promise<Delivery>>();

export function receiveBrowserKey(
  session: Session,
  enrollment: PendingEnrollment,
  request: typeof fetch,
  owner: string,
  provider: ChatProvider,
): Promise<Delivery> {
  const subject = session.subject!;
  const pending = () => matchesEnrollment(subject, owner, enrollment.device_code, provider);
  const saved = readBrowserKey(subject, owner, provider);
  if (!pending() && saved) return Promise.resolve(saved);
  const id = JSON.stringify([subject, session.csrfToken, owner, provider, enrollment.device_code]);
  const existing = inFlight.get(id);
  if (existing) return existing;
  const result = workerRequest<Delivery>(
    session,
    'key/poll',
    { deviceCode: enrollment.device_code },
    undefined,
    request,
  )
    .then((delivery) => {
      // An explicit cancellation, logout, or replacement must not restore an old grant.
      if (pending()) {
        saveBrowserKey(subject, delivery.credential, delivery.identity, owner, provider);
        clearEnrollment(subject, owner, provider);
      }
      return delivery;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, result);
  return result;
}
