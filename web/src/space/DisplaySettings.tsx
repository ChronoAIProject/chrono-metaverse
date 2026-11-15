import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** 同一时刻只展开一个查看面板，键盘关闭后把焦点交还触发按钮。 */
export function ViewerPanel({
  label,
  children,
  className = '',
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const another = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', keyboard);
    document.addEventListener('viewer-panel', another);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('viewer-panel', another);
    };
  }, [open, id]);
  return (
    <div ref={root} className={`viewer-panel ${className}`} data-open={open}>
      <button
        ref={trigger}
        type="button"
        className="viewer-panel__trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (!open) document.dispatchEvent(new CustomEvent('viewer-panel', { detail: id }));
          setOpen(!open);
        }}
      >
        {label}
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      <section hidden={!open} id={id} className="viewer-panel__body" aria-label={label}>
        <div className="viewer-panel__heading">
          <strong>{label}</strong>
          <button
            type="button"
            aria-label={`关闭${label}`}
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function SettingSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="viewer-panel__section">
      <h2>{label}</h2>
      {children}
    </div>
  );
}
