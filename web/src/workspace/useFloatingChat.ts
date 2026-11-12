import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export function useFloatingChat(open: boolean) {
  const stage = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const drag = useRef<{ x: number; y: number; left: number; top: number }>(null);

  function clamp(left: number, top: number) {
    const bounds = stage.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (!bounds || !box) return;
    setPosition({
      left: Math.max(8, Math.min(left, bounds.width - box.width - 8)),
      top: Math.max(8, Math.min(top, bounds.height - box.height - 8)),
    });
  }
  useEffect(() => {
    if (!open || !stage.current || !panel.current) return;
    const observer = new ResizeObserver(() => {
      const bounds = stage.current!.getBoundingClientRect();
      const box = panel.current!.getBoundingClientRect();
      clamp(box.left - bounds.left, box.top - bounds.top);
    });
    observer.observe(stage.current);
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [open]);

  function onPointerDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    const bounds = stage.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (!bounds || !box) return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      left: box.left - bounds.left,
      top: box.top - bounds.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    if (start) clamp(start.left + e.clientX - start.x, start.top + e.clientY - start.y);
  }
  function onPointerUp() {
    drag.current = null;
  }
  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const offset = {
      ArrowLeft: [-24, 0],
      ArrowRight: [24, 0],
      ArrowUp: [0, -24],
      ArrowDown: [0, 24],
    }[e.key];
    if (!offset) return;
    const bounds = stage.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (!bounds || !box) return;
    e.preventDefault();
    clamp(box.left - bounds.left + offset[0]!, box.top - bounds.top + offset[1]!);
  }
  return {
    stage,
    panel,
    style: position ? { ...position, bottom: 'auto' } : undefined,
    handle: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onLostPointerCapture: onPointerUp,
      onKeyDown,
    },
  };
}
