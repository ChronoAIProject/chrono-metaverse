import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CommitSummary } from '../core/api/types';
import { TimelineBar, type TimelineBarProps } from './TimelineBar';

const from = Date.parse('2026-10-01T00:00:00Z');
const to = Date.parse('2026-10-31T00:00:00Z');
const commits: CommitSummary[] = [
  { seq: 1, at: '2026-10-05T00:00:00Z', message: '导入扫描', actor: { kind: 'person' } },
  { seq: 2, at: '2026-10-20T00:00:00Z', message: '重建 <b>粗体</b>', actor: { kind: 'job' } },
];

function setup(overrides: Partial<TimelineBarProps> = {}) {
  const props: TimelineBarProps = {
    from,
    to,
    time: Date.parse('2026-10-10T00:00:00Z'),
    commits,
    density: [
      { start: '2026-10-01T00:00:00Z', count: 3 },
      { start: '2026-10-16T00:00:00Z', count: 0 },
    ],
    playing: false,
    speed: 3600,
    live: false,
    onSeek: vi.fn(),
    onTogglePlay: vi.fn(),
    onSpeedChange: vi.fn(),
    onNow: vi.fn(),
    ...overrides,
  };
  render(<TimelineBar {...props} />);
  return props;
}

describe('时间轴', () => {
  it('标出每次提交，点击跳到提交时刻；提交说明按纯文本显示', async () => {
    const props = setup();
    const markers = screen.getAllByRole('button', { name: /跳到提交/ });
    expect(markers).toHaveLength(2);
    expect(markers[1]).toHaveAccessibleName('跳到提交 #2：重建 <b>粗体</b>');
    await userEvent.click(markers[1]!);
    expect(props.onSeek).toHaveBeenCalledWith(Date.parse('2026-10-20T00:00:00Z'));
  });

  it('播放、暂停、调速、现在', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: '播放' }));
    expect(props.onTogglePlay).toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '播放速度' }), '86400');
    expect(props.onSpeedChange).toHaveBeenCalledWith(86_400);
    const now = screen.getByRole('button', { name: '现在' });
    expect(now).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(now);
    expect(props.onNow).toHaveBeenCalled();
  });

  it('播放中显示暂停按钮，现在模式按钮是按下状态', () => {
    setup({ playing: true, live: true });
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '现在' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('拖动时间条跳转', () => {
    const props = setup();
    fireEvent.change(screen.getByRole('slider', { name: '时间' }), {
      target: { value: String(Date.parse('2026-10-15T00:00:00Z')) },
    });
    expect(props.onSeek).toHaveBeenCalledWith(Date.parse('2026-10-15T00:00:00Z'));
  });

  it('上一个 / 下一个提交', async () => {
    const props = setup();
    await userEvent.click(screen.getByRole('button', { name: '上一个提交' }));
    expect(props.onSeek).toHaveBeenLastCalledWith(Date.parse('2026-10-05T00:00:00Z'));
    await userEvent.click(screen.getByRole('button', { name: '下一个提交' }));
    expect(props.onSeek).toHaveBeenLastCalledWith(Date.parse('2026-10-20T00:00:00Z'));
  });

  it('第一个提交之前没有"上一个提交"', () => {
    setup({ time: from });
    expect(screen.getByRole('button', { name: '上一个提交' })).toBeDisabled();
  });

  it('显示中文时间', () => {
    setup();
    expect(screen.getByText(/2026年10月10日/)).toBeInTheDocument();
  });
});
