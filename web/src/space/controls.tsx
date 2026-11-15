import { REBUILT_STYLES, VIEW_MODES, type RebuiltStyle, type ViewMode } from '../core/scene';
import type { SpaceStyle } from '../core/styles';
import type { Anchor } from '../core/api/types';
import {
  APPEARANCE_ORDER,
  appearanceLabel,
  setAppearance,
  useAppearance,
} from '../theme/appearance';

/** 三种视图的切换按钮（设计 7.1）。 */
export function ViewModeSwitch({
  mode,
  onChange,
}: {
  readonly mode: ViewMode;
  readonly onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="视图模式">
      {VIEW_MODES.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={mode === option.id}
          title={option.hint}
          onClick={() => onChange(option.id)}
          data-mode={option.id}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 命名空间样式画廊。 */
export function StyleGallerySwitch({
  styles,
  activeId,
  onChange,
}: {
  readonly styles: readonly SpaceStyle[];
  readonly activeId?: string;
  readonly onChange: (style: SpaceStyle) => void;
}) {
  return (
    <div className="style-gallery" role="group" aria-label="空间样式画廊">
      {styles.map((style) => (
        <button
          key={style.id}
          type="button"
          className="style-gallery__item"
          aria-pressed={activeId === style.id}
          title={style.description}
          onClick={() => onChange(style)}
        >
          <span
            className="style-gallery__swatch"
            style={{ background: style.swatch }}
            aria-hidden="true"
          />
          <span>{style.name}</span>
          {style.category === 'custom' && (
            <small>
              {typeof style.extensions?.badge === 'string' && style.extensions.badge.trim()
                ? style.extensions.badge
                : '专属'}
            </small>
          )}
        </button>
      ))}
    </div>
  );
}

/** 空间锚点快速导览。 */
export function AnchorQuickBar({
  anchors,
  onFocus,
}: {
  readonly anchors: readonly Anchor[];
  readonly onFocus: (anchor: Anchor | null) => void;
}) {
  const visible = anchors.filter((anchor) => anchor.visibility !== 'internal');
  if (visible.length === 0) return null;
  return (
    <div className="anchor-quickbar" role="group" aria-label="空间锚点导览">
      <button type="button" onClick={() => onFocus(null)}>
        全景
      </button>
      {visible.map((anchor) => (
        <button key={anchor.anchorId} type="button" onClick={() => onFocus(anchor)}>
          {anchor.label ?? anchor.anchorId}
        </button>
      ))}
    </div>
  );
}

/**
 * 重建层画法：形状 / 方块。只在重建层既有物件又有区块时出现；
 * 原始视图只画扫描模型，切换不起作用，所以禁用。
 */
export function StyleSwitch({
  style,
  disabled = false,
  onChange,
}: {
  readonly style: RebuiltStyle;
  readonly disabled?: boolean;
  readonly onChange: (style: RebuiltStyle) => void;
}) {
  return (
    <div
      className="segmented"
      role="group"
      aria-label="重建层画法"
      title={disabled ? '原始视图只显示扫描模型' : undefined}
    >
      {REBUILT_STYLES.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={style === option.id}
          title={option.hint}
          disabled={disabled}
          onClick={() => onChange(option.id)}
          data-style={option.id}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 剖切：切掉某个高度以上的内容，用来看室内（所有视图共用）。 */
export function CutawayControl({
  enabled,
  height,
  max,
  onToggle,
  onHeight,
}: {
  readonly enabled: boolean;
  readonly height: number;
  readonly max: number;
  readonly onToggle: (enabled: boolean) => void;
  readonly onHeight: (height: number) => void;
}) {
  return (
    <div className="cutaway">
      <label className="cutaway__toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onToggle(event.target.checked)}
        />
        剖切
      </label>
      <input
        type="range"
        className="cutaway__range"
        min={0.1}
        max={Math.max(0.2, max)}
        step={0.05}
        value={height}
        disabled={!enabled}
        onChange={(event) => onHeight(Number(event.target.value))}
        aria-label="剖切高度"
        aria-valuetext={`${height.toFixed(2)} 米`}
      />
      <output className="cutaway__value">{height.toFixed(2)} 米</output>
    </div>
  );
}

/** 深浅色主题：跟随系统 → 浅色 → 深色，轮流切换（沿用 CMA 的主题模块）。 */
export function ThemeToggle() {
  const appearance = useAppearance();
  const index = APPEARANCE_ORDER.indexOf(appearance);
  const next = APPEARANCE_ORDER[(index + 1) % APPEARANCE_ORDER.length]!;
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setAppearance(next)}
      title={`主题：${appearanceLabel(appearance)}（点击切换为${appearanceLabel(next)}）`}
      aria-label={`主题：${appearanceLabel(appearance)}`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13Zm0 1.4v10.2a5.1 5.1 0 0 1 0-10.2Z" />
        <path d="M8 1.5a6.5 6.5 0 0 1 0 13v-1.4a5.1 5.1 0 0 0 0-10.2Z" />
      </svg>
      <span>{appearanceLabel(appearance)}</span>
    </button>
  );
}

/** 页面级的加载状态（数据还没到）。 */
export function LoadingCard({
  label,
  done,
  total,
}: {
  readonly label: string;
  readonly done?: number;
  readonly total?: number;
}) {
  const known = done !== undefined && total !== undefined && total > 0;
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span>
        {label}
        {known ? ` ${done}/${total}` : '…'}
      </span>
      <progress max={known ? total : undefined} value={known ? done : undefined} />
    </div>
  );
}

/**
 * 错误页：404 一律提示"链接无效，或者空间不存在"，不暴露是哪一种；
 * 其他错误（网络、服务暂时不可用）给出重试。
 */
export function ErrorCard({
  title,
  message,
  notFound,
  hint,
  onRetry,
}: {
  readonly title: string;
  readonly message: string;
  readonly notFound: boolean;
  readonly hint?: string;
  readonly onRetry?: () => void;
}) {
  return (
    <main className="space space--message">
      <div className="space__message" role="alert">
        <h1>{title}</h1>
        <p>{message}</p>
        {hint !== undefined && <p>{hint}</p>}
        <div className="space__message-actions">
          {!notFound && onRetry && (
            <button type="button" className="space__button" onClick={onRetry}>
              重试
            </button>
          )}
          <a className="space__button space__button--quiet" href="/">
            回到首页
          </a>
        </div>
      </div>
    </main>
  );
}
