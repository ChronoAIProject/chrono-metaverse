import { VIEW_MODES, type ViewMode } from '../core/scene';

/** 三种视图的切换按钮（设计 7.1）。 */
export function ViewModeSwitch({
  mode,
  onChange,
}: {
  readonly mode: ViewMode;
  readonly onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="视图">
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
