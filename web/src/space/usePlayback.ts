import { useCallback, useEffect, useRef, useState } from 'react';
import { PLAYBACK_SPEEDS } from '../timeline/TimelineBar';

/** 播放时每一帧推进的间隔（毫秒）。 */
const TICK_MS = 100;
/** "现在"模式下时刻跟着当前时间走的间隔。 */
const LIVE_TICK_MS = 1000;
/** 暂停回放时，瞬时事件的可见窗口。 */
const PAUSED_WINDOW_MS = 15 * 60_000;

export interface Playback {
  readonly time: number;
  readonly live: boolean;
  readonly playing: boolean;
  readonly speed: number;
  /** 瞬时事件的可见窗口（毫秒）：播放时随速度放大，"现在"模式按事件自己的时长。 */
  readonly windowMs: number;
  readonly seek: (time: number) => void;
  readonly togglePlay: (from: number) => void;
  readonly setSpeed: (speed: number) => void;
  readonly goNow: () => void;
}

/**
 * 时间轴的时钟：时刻、"现在"模式、播放 / 暂停 / 调速 / 跳转（设计 5.5、7.2）。
 * 播放追上现在就自动切回"现在"模式。
 */
export function usePlayback(now: () => number = Date.now): Playback {
  const [live, setLive] = useState(true);
  const [time, setTime] = useState(() => now());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(PLAYBACK_SPEEDS[2]!.value);
  const timeRef = useRef(time);

  useEffect(() => {
    timeRef.current = time;
  }, [time]);

  // "现在"模式下时刻跟着当前时间走。
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTime(now()), LIVE_TICK_MS);
    return () => clearInterval(timer);
  }, [live, now]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = timeRef.current + TICK_MS * speed;
      if (next >= now()) {
        setPlaying(false);
        setLive(true);
        setTime(now());
      } else {
        setTime(next);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, now]);

  const seek = useCallback((t: number) => {
    setLive(false);
    setTime(t);
  }, []);

  const togglePlay = useCallback(
    (from: number) => {
      if (playing) {
        setPlaying(false);
        return;
      }
      // 在"现在"模式下按播放：从时间轴起点开始回放。
      if (live || timeRef.current >= now() - 1000) setTime(from);
      setLive(false);
      setPlaying(true);
    },
    [playing, live, now],
  );

  const goNow = useCallback(() => {
    setPlaying(false);
    setLive(true);
    setTime(now());
  }, [now]);

  const windowMs = live ? 0 : playing ? speed * TICK_MS * 15 : PAUSED_WINDOW_MS;
  return { time, live, playing, speed, windowMs, seek, togglePlay, setSpeed, goNow };
}
