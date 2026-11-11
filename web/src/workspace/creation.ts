import { WorkerError, type Attachment, type Session } from './client';
import { browserKeyHeaders } from '../auth/browserKey';

export const MODEL_SIZE_LIMIT = 20 * 1024 * 1024;
export function scaniverseLink(text: string): string | null {
  const match = text.match(
    /https:\/\/scaniverse\.com\/scan\/[A-Za-z0-9_-]{1,80}(?=[\s?#/，。；]|$)/,
  );
  return match?.[0] ?? null;
}
export async function modelDigest(file: File): Promise<string> {
  if (
    !/\.(glb|zip)$/i.test(file.name) ||
    new TextEncoder().encode(file.name).length > 180 ||
    [...file.name].some(
      (c) =>
        c.charCodeAt(0) < 32 ||
        (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159) ||
        c === '/' ||
        c === '\\',
    ) ||
    file.size < 1 ||
    file.size > MODEL_SIZE_LIMIT
  )
    throw new Error('请选择不超过 20 MiB 的 GLB 或 ZIP 文件；也可以粘贴 Scaniverse 链接。');
  const data = await file.arrayBuffer();
  const magic = [...new Uint8Array(data, 0, Math.min(4, data.byteLength))].join(',');
  if (!['103,108,84,70', '80,75,3,4'].includes(magic))
    throw new Error('文件内容不是 GLB 或 ZIP，请从建模工具重新导出。');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function uploadModel(
  session: Session,
  agentId: string,
  file: File,
  key: string,
  sha: string,
  signal: AbortSignal,
  request = fetch,
): Promise<Attachment> {
  const params = new URLSearchParams({ agentId, name: file.name });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 85_000);
  try {
    const response = await request(`/api/auth/nyxid/worker/attachment?${params}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-csrf-token': session.csrfToken ?? '',
        'Idempotency-Key': key,
        ...browserKeyHeaders(session.subject, session.cmaOwnerId),
      },
      body: file,
    });
    const body = (await response.json()) as Attachment & { code?: string; detail?: string };
    if (!response.ok)
      throw new WorkerError(
        body.code ?? 'model_upload_failed',
        body.detail ?? '模型上传未完成，请重试原文件。',
      );
    if (
      body.agent_id !== agentId ||
      body.name !== file.name ||
      body.size_bytes !== file.size ||
      body.sha256 !== sha ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(body.id) ||
      body.path !== `/home/attachments/${agentId}/${body.id}/${file.name}`
    )
      throw new Error('无法核对模型上传结果，请保留原文件重试。');
    return body;
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError(
      'model_upload_unknown',
      '模型上传结果尚未确认。请保留或重新选择同一文件，重试原请求。',
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
