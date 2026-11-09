import { useMemo } from 'react';
import type { CommitSummary, DensityBucket } from '../core/api/types';
import { toMillis } from '../core/events';
import './TimelineBar.css';

/** 播放速度：每秒走过的现实时间（秒）。 */
export const PLAYBACK_SPEEDS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 60, label: '1 分钟/秒' },
  { value: 3600, label: '1 小时/秒' },
  { value: 86_400, label: '1 天/秒' },
  { value: 604_800, label: '1 周/秒' },
];

const formatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatTime(time: number): string {
  return formatter.format(new Date(time));
}

export interface TimelineBarProps {
  readonly from: number;
  readonly to: number;
  readonly time: number;
  readonly commits: readonly CommitSummary[];
  readonly density: readonly DensityBucket[];
  readonly playing: boolean;
  readonly speed: number;
  /** "现在"模式：跟着最新数据走。 */
  readonly live: boolean;
  readonly onSeek: (time: number) => void;
  readonly onTogglePlay: () => void;
  readonly onSpeedChange: (speed: number) => void;
  readonly onNow: () => void;
  /** 组合页：提交来自多个空间，标记的键和说明由上层给出。 */
  readonly markerKey?: (commit: CommitSummary) => string;
  readonly markerLabel?: (commit: CommitSummary) => string;
}

/**
 * 时间轴（设计 7.2）：标出各次提交，显示事件密度，支持播放、暂停、调速、跳转，有"现在"按钮。
 * 完全由属性驱动：数据从哪里来（接口或夹具）由上层决定。提交说明一律当纯文本显示。
 */
export function TimelineBar({
  from,
  to,
  time,
  commits,
  density,
  playing,
  speed,
  live,
  onSeek,
  onTogglePlay,
  onSpeedChange,
  onNow,
  markerKey = (commit) => String(commit.seq),
  markerLabel = (commit) => `#${commit.seq} ${commit.message}`,
}: TimelineBarProps) {
  const span = Math.max(1, to - from);
  // 相邻提交可能挨得很近（导入扫描和重建只差几分钟），标记会重叠，所以另给"上一个/下一个提交"。
  const times = commits.map((c) => toMillis(c.at)).sort((a, b) => a - b);
  const previous = [...times].reverse().find((t) => t < time - 1000);
  const next = times.find((t) => t > time + 1000);
  const fraction = (t: number) => Math.min(1, Math.max(0, (t - from) / span));
  const maxCount = useMemo(() => Math.max(1, ...density.map((b) => b.count)), [density]);
  const bucketWidth = density.length > 0 ? 100 / density.length : 0;

  return (
    <div className="timeline" role="group" aria-label="时间轴">
      <button
        type="button"
        className="timeline__play"
        onClick={onTogglePlay}
        aria-label={playing ? '暂停' : '播放'}
        title={playing ? '暂停' : '播放'}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="2" width="3.5" height="12" rx="1" />
            <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 2.5v11a.6.6 0 0 0 .9.5l9-5.5a.6.6 0 0 0 0-1l-9-5.5a.6.6 0 0 0-.9.5Z" />
          </svg>
        )}
      </button>

      <div className="timeline__steps">
        <button
          type="button"
          className="timeline__step"
          disabled={previous === undefined}
          onClick={() => previous !== undefined && onSeek(previous)}
          aria-label="上一个提交"
          title="上一个提交"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3h1.6v10H3zM13 3.6v8.8a.5.5 0 0 1-.8.4L6.3 8.4a.5.5 0 0 1 0-.8l5.9-4.4a.5.5 0 0 1 .8.4Z" />
          </svg>
        </button>
        <button
          type="button"
          className="timeline__step"
          disabled={next === undefined}
          onClick={() => next !== undefined && onSeek(next)}
          aria-label="下一个提交"
          title="下一个提交"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.4 3H13v10h-1.6zM3 3.6v8.8a.5.5 0 0 0 .8.4l5.9-4.4a.5.5 0 0 0 0-.8L3.8 3.2a.5.5 0 0 0-.8.4Z" />
          </svg>
        </button>
      </div>

      <label className="timeline__speed">
        <span className="sr-only">播放速度</span>
        <select
          value={speed}
          onChange={(event) => onSpeedChange(Number(event.target.value))}
          aria-label="播放速度"
        >
          {PLAYBACK_SPEEDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="timeline__track">
        <svg
          className="timeline__density"
          viewBox="0 0 100 20"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {density.map((bucket, i) =>
            bucket.count > 0 ? (
              <rect
                key={bucket.start}
                x={i * bucketWidth}
                width={Math.max(bucketWidth * 0.8, 0.2)}
                y={20 - (bucket.count / maxCount) * 18}
                height={(bucket.count / maxCount) * 18}
              />
            ) : null,
          )}
        </svg>
        <ol className="timeline__commits" aria-label="提交">
          {commits.map((commit) => {
            const at = toMillis(commit.at);
            const label = markerLabel(commit);
            return (
              <li key={markerKey(commit)} style={{ left: `${fraction(at) * 100}%` }}>
                <button
                  type="button"
                  className="timeline__commit"
                  title={`${label}\n${formatTime(at)}`}
                  aria-label={`跳到提交 ${label.replace(/^(#\d+) /, '$1：')}`}
                  onClick={() => onSeek(at)}
                />
              </li>
            );
          })}
        </ol>
        <div
          className="timeline__playhead"
          style={{ left: `${fraction(time) * 100}%` }}
          aria-hidden="true"
        />
        <input
          className="timeline__range"
          type="range"
          min={from}
          max={to}
          step={60_000}
          value={Math.min(to, Math.max(from, time))}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="时间"
          aria-valuetext={formatTime(time)}
        />
      </div>

      <time className="timeline__time" dateTime={new Date(time).toISOString()}>
        {formatTime(time)}
      </time>

      <button
        type="button"
        className="timeline__now"
        aria-pressed={live}
        onClick={onNow}
        title="回到现在，并跟随最新的数据"
      >
        <span className="timeline__live-dot" aria-hidden="true" />
        现在
      </button>
    </div>
  );
}
