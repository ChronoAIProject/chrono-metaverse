import { describe, expect, it } from 'vitest';
import { parseViewerActions, viewerReply } from './viewerActions';

const reply = (actions: unknown[]) =>
  '将调整查看方式。\n```metaverse-view\n' + JSON.stringify({ actions }) + '\n```';
describe('AI 页面动作', () => {
  it('separates visible prose from bounded viewer actions', () => {
    const text = reply([
      { type: 'current' },
      { type: 'mode', value: 'extended' },
      { type: 'camera', kind: 'focus', entityId: 'rb.clutter-09' },
      { type: 'camera', kind: 'zoom', factor: 0.5 },
    ]);
    expect(viewerReply(text)).toBe('将调整查看方式。');
    expect(parseViewerActions(text).actions).toHaveLength(4);
    expect(parseViewerActions(text).invalid).toBe(false);
    expect(viewerReply('准备切换。\n```metaverse-view\n{"actions":[')).toBe('准备切换。');
  });
  it.each([
    [{ type: 'publish' }],
    [{ type: 'clear-cache' }],
    [{ type: 'preview', url: 'https://evil.example/preview#t=x' }],
    [{ type: 'camera', kind: 'zoom', factor: 1000000 }],
    [{ type: 'camera', kind: 'orbit', yaw: 1e300, pitch: 0 }],
    [{ type: 'mode', value: 'raw', script: 'location.reload()' }],
    [
      { type: 'mode', value: 'raw' },
      { type: 'space', spaceId: 'other' },
    ],
  ])('rejects the complete batch containing an unsupported action: %j', (...actions) => {
    expect(parseViewerActions(reply(actions))).toEqual({ actions: [], invalid: true });
  });
  it('does not treat quoted JSON or ordinary assistant prose as an action', () => {
    expect(parseViewerActions('示例：{"actions":[{"type":"current"}]}')).toEqual({
      actions: [],
      invalid: false,
    });
    expect(
      parseViewerActions(reply([{ type: 'current' }]) + '\n' + reply([{ type: 'current' }])),
    ).toEqual({ actions: [], invalid: true });
  });
});
