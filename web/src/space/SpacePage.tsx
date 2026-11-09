import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicClient } from '../core/api/client';
import { sceneHeightRange, selectView, type ViewMode } from '../core/scene';
import { PLAYBACK_SPEEDS, TimelineBar, formatTime } from '../timeline/TimelineBar';
import { Viewer, type SceneViewFactory } from '../viewer/Viewer';
import { CutawayControl, ViewModeSwitch } from './controls';
import { HEAD_POLL_MS, useSpace } from './useSpace';
import './SpacePage.css';

/** 播放时每一帧推进的间隔（毫秒）。 */
const TICK_MS = 100;

export interface SpacePageProps {
  readonly spaceId: string;
  readonly client: PublicClient;
  /** 有分享令牌时为 true；没有时提示链接可能不完整。 */
  readonly hasShareToken: boolean;
  readonly createView?: SceneViewFactory;
  readonly now?: () => number;
  /** 初始视图（测试和截图用）。 */
  readonly initialMode?: ViewMode;
}

/** 查看一个空间：三维视图、三种视图切换、剖切、时间轴（设计第 7 节）。 */
export function SpacePage({
  spaceId,
  client,
  hasShareToken,
  createView,
  now = Date.now,
  initialMode = 'optimized',
}: SpacePageProps) {
  const [mode, setMode] = useState<ViewMode>(initialMode);
  const [live, setLive] = useState(true);
  const [time, setTime] = useState(() => now());
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(PLAYBACK_SPEEDS[2]!.value);
  const [cutEnabled, setCutEnabled] = useState(true);
  const [cutHeight, setCutHeight] = useState(2.2);
  // 下载好的扫描模型，连同它的哈希：换了扫描时旧的自动失效。
  const [loadedScan, setLoadedScan] = useState<{ hash: string; bytes: ArrayBuffer } | null>(null);
  const timeRef = useRef(time);

  const data = useSpace(client, spaceId, time, live, now);
  const { scene, space, load, loadScan } = data;

  useEffect(() => {
    timeRef.current = time;
  }, [time]);

  // "现在"模式下时刻跟着当前时间走（进入"现在"模式的地方已经把时刻设成了当前时间）。
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTime(now()), HEAD_POLL_MS);
    return () => clearInterval(timer);
  }, [live, now]);

  // 播放：按速度推进；追上现在就切回"现在"模式。
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

  useEffect(() => {
    if (space) document.title = `${space.name} · chrono-metaverse`;
  }, [space]);

  const content = useMemo(() => (scene ? selectView(scene, mode) : null), [scene, mode]);
  const heights = useMemo(() => (scene ? sceneHeightRange(scene) : { min: 0, max: 3 }), [scene]);
  const scanHash = mode === 'raw' ? scene?.scan?.webModelHashes[0] : undefined;

  useEffect(() => {
    if (scanHash === undefined) return;
    let cancelled = false;
    loadScan(scanHash)
      .then((bytes) => {
        if (!cancelled) setLoadedScan({ hash: scanHash, bytes });
      })
      .catch(() => {
        // 扫描下载失败时原始视图保持空白。
      });
    return () => {
      cancelled = true;
    };
  }, [scanHash, loadScan]);
  const scan = loadedScan !== null && loadedScan.hash === scanHash ? loadedScan.bytes : null;

  // 原始视图要等扫描下载完再交给查看器，避免先画一个空场景。
  const viewerContent = content && content.showScan && scan === null ? null : content;

  if (load.status === 'error') {
    return (
      <main className="space space--message">
        <div className="space__message" role="alert">
          <h1>打不开这个空间</h1>
          <p>{load.message}</p>
          {!hasShareToken && load.notFound && <p>链接里没有分享令牌（# 后面的 share=…）。</p>}
        </div>
      </main>
    );
  }

  const commit = data.commit;
  return (
    <main className="space" data-space-id={spaceId}>
      <header className="space__bar">
        <div className="space__title">
          <h1>{space?.name ?? '正在加载…'}</h1>
          <p className="space__version">
            {commit
              ? `版本 #${commit.seq} · ${commit.message}`
              : load.status === 'loading'
                ? '正在读取时间线'
                : '这个时刻还没有任何提交'}
          </p>
        </div>
        <ViewModeSwitch mode={mode} onChange={setMode} />
        <CutawayControl
          enabled={cutEnabled}
          height={Math.min(cutHeight, heights.max)}
          max={heights.max}
          onToggle={setCutEnabled}
          onHeight={setCutHeight}
        />
      </header>

      <section className="space__stage" aria-label="三维视图" aria-busy={data.sceneLoading}>
        <Viewer
          content={viewerContent}
          scan={mode === 'raw' ? scan : null}
          scanTransform={scene?.scan?.transform}
          cutaway={cutEnabled ? cutHeight : null}
          states={data.states}
          createView={createView}
        />
        {mode === 'extended' && (
          <div className="space__legend" aria-hidden="true">
            <span className="space__legend-swatch" /> 虚拟区
          </div>
        )}
        {commit && (
          <aside className="space__info" aria-label="当前版本">
            <dl>
              <dt>版本</dt>
              <dd>#{commit.seq}</dd>
              <dt>发布时间</dt>
              <dd>
                <time dateTime={commit.at}>{formatTime(Date.parse(commit.at))}</time>
              </dd>
              {commit.observedAt && (
                <>
                  <dt>拍摄时间</dt>
                  <dd>
                    <time dateTime={commit.observedAt}>
                      {formatTime(Date.parse(commit.observedAt))}
                    </time>
                  </dd>
                </>
              )}
            </dl>
          </aside>
        )}
      </section>

      <TimelineBar
        from={data.range.from}
        to={data.range.to}
        time={time}
        commits={data.commits}
        density={data.density}
        playing={playing}
        speed={speed}
        live={live}
        onSeek={(t) => {
          setLive(false);
          setTime(t);
        }}
        onTogglePlay={() => {
          if (playing) {
            setPlaying(false);
            return;
          }
          // 在"现在"模式下按播放：从时间轴起点开始回放。
          if (live || time >= now() - 1000) setTime(data.range.from);
          setLive(false);
          setPlaying(true);
        }}
        onSpeedChange={setSpeed}
        onNow={() => {
          setPlaying(false);
          setLive(true);
          setTime(now());
        }}
      />
    </main>
  );
}
