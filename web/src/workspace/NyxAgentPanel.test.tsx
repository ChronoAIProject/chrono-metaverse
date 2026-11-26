import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { NyxIDConnection } from '@chronoai/nyx-assistant-sdk';
import type { NyxAssistantElement } from '@chronoai/nyx-assistant-sdk/widget';
import { NyxAgentPanel } from './NyxAgentPanel';
import type { Session, SpaceSummary } from './client';

const props = {
  session: { subject: 'owner' } as Session,
  space: { id: 'demo', owner: { kind: 'person', id: 'owner' } } as SpaceSummary,
  viewerContext: { spaces: [{ id: 'demo', name: '工作空间' }] },
  viewerFeedback: {},
  onPreview: vi.fn(),
  onViewerCommand: vi.fn(() => true),
  onRestore: vi.fn(),
  onBusy: vi.fn(),
};

it('使用 SDK 面板注册查看器动作，草稿须经用户确认后发送具体预览', async () => {
  const { container } = render(<NyxAgentPanel {...props} />);
  const widget = container.querySelector('nyx-assistant') as NyxAssistantElement;
  expect(widget.dataset.ownerId).toBe('owner');
  expect(widget.context()).toMatchObject({ spaceId: 'demo' });
  expect(widget.getAttribute('layout')).toBe('embedded');
  const inputs: { input: { type: string; text?: string }; requestId: string }[] = [];
  widget.bind(
    new NyxIDConnection(new URL('https://sdk.example'), async (_url, init) => {
      const turn = JSON.parse(JSON.parse(String(init?.body)).input);
      inputs.push(turn);
      const text =
        inputs.length === 1
          ? '```nyx-host-call\n' +
            JSON.stringify({
              requestId: turn.requestId,
              name: 'set_view',
              arguments: { actions: [{ type: 'mode', value: 'raw' }] },
            }) +
            '\n```'
          : '完成。 /preview#t=draft-one';
      return Response.json({
        id: 'r' + inputs.length,
        conversation: { id: 'c' },
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      });
    }),
  );
  await widget.sendMessage('查看并生成预览');
  await screen.findByText('查看草稿预览');
  expect(props.onViewerCommand).toHaveBeenCalledWith({
    id: expect.any(String),
    actions: [{ type: 'mode', value: 'raw' }],
  });
  fireEvent.click(screen.getByText('发布这个草稿…'));
  fireEvent.click(screen.getByText('暂不发布'));
  expect(inputs).toHaveLength(2);
  fireEvent.click(screen.getByText('发布这个草稿…'));
  fireEvent.click(screen.getByText('确认发布此预览'));
  await waitFor(() =>
    expect(inputs[2]?.input.text).toContain('确认发布这个草稿预览：/preview#t=draft-one'),
  );
});
