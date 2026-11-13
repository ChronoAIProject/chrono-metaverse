import { viewerLink } from './client';

export type CameraAction =
  | { kind: 'overview' }
  | { kind: 'focus'; entityId: string }
  | { kind: 'orbit'; yaw: number; pitch: number }
  | { kind: 'zoom'; factor: number };
export type ViewerAction =
  | { type: 'space'; spaceId: string }
  | { type: 'current' }
  | { type: 'preview'; url: string }
  | { type: 'mode'; value: 'raw' | 'optimized' | 'extended' }
  | { type: 'style'; value: 'shapes' | 'blocks' }
  | { type: 'cutaway'; height: number | null }
  | ({ type: 'camera' } & CameraAction);
export type ViewerCommand = { id: string; actions: ViewerAction[] };
export type ViewerContext = {
  spaces: { id: string; name: string }[];
  preview?: string;
};

const block = /```metaverse-view\s*\n([\s\S]*?)```/g;
export function viewerReply(text: string): string {
  return text.replace(/```metaverse-view\b[\s\S]*?(?:```|$)/g, '').trim();
}
function valid(value: unknown): value is ViewerAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const exact = (...keys: string[]) => Object.keys(v).every((k) => keys.includes(k));
  const number = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  switch (v.type) {
    case 'space':
      return (
        exact('type', 'spaceId') &&
        typeof v.spaceId === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,79}$/.test(v.spaceId)
      );
    case 'current':
      return exact('type');
    case 'preview':
      return (
        exact('type', 'url') &&
        typeof v.url === 'string' &&
        v.url.length <= 2048 &&
        viewerLink(v.url)?.startsWith('/preview#t=') === true
      );
    case 'mode':
      return exact('type', 'value') && ['raw', 'optimized', 'extended'].includes(String(v.value));
    case 'style':
      return exact('type', 'value') && ['shapes', 'blocks'].includes(String(v.value));
    case 'cutaway':
      return exact('type', 'height') && (v.height === null || number(v.height, -1000, 10000));
    case 'camera':
      switch (v.kind) {
        case 'overview':
          return exact('type', 'kind');
        case 'focus':
          return (
            exact('type', 'kind', 'entityId') &&
            typeof v.entityId === 'string' &&
            /^[A-Za-z0-9_.:-]{1,256}$/.test(v.entityId)
          );
        case 'orbit':
          return (
            exact('type', 'kind', 'yaw', 'pitch') &&
            number(v.yaw, -360, 360) &&
            number(v.pitch, -90, 90)
          );
        case 'zoom':
          return exact('type', 'kind', 'factor') && number(v.factor, 0.1, 10);
      }
  }
  return false;
}
export function parseViewerActions(text: string): { actions: ViewerAction[]; invalid: boolean } {
  const matches = [...text.matchAll(block)];
  if (matches.length === 0) return { actions: [], invalid: text.includes('```metaverse-view') };
  if (matches.length !== 1 || matches[0]![1]!.length > 16000) return { actions: [], invalid: true };
  try {
    const value = JSON.parse(matches[0]![1]!) as { actions?: unknown };
    if (
      !value ||
      Object.keys(value).some((k) => k !== 'actions') ||
      !Array.isArray(value.actions) ||
      value.actions.length > 8 ||
      !value.actions.every(valid)
    )
      return { actions: [], invalid: true };
    // A space transition must precede all actions targeting its viewer.
    if (value.actions.some((a, i) => a.type === 'space' && i !== 0))
      return { actions: [], invalid: true };
    return { actions: value.actions, invalid: false };
  } catch {
    return { actions: [], invalid: true };
  }
}
